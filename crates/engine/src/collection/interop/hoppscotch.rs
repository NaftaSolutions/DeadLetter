//! Hoppscotch collection exports (JSON). Variables use `<<name>>`, converted to `{{name}}`.

use serde_json::Value;

use crate::collection::model::{RequestFile, RequestHeader};

use super::util::{append_query, basic, bearer, default_header, form_body, header, name_from_url, FORM_CONTENT_TYPE};
use super::{ImportResult, ImportedRequest};

type Res<T> = Result<T, String>;

fn is_collection(v: &Value) -> bool {
    v.is_object() && v.get("name").is_some() && (v.get("requests").is_some_and(Value::is_array) || v.get("folders").is_some_and(Value::is_array))
}

pub fn detect(v: &Value) -> bool {
    match v {
        Value::Array(a) => !a.is_empty() && a.iter().all(is_collection),
        other => is_collection(other),
    }
}

fn s(v: &Value) -> String {
    v.as_str().unwrap_or("").to_string()
}

fn vars(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("<<") {
        let Some(end) = rest[start..].find(">>") else { break };
        out.push_str(&rest[..start]);
        out.push_str(&format!("{{{{{}}}}}", rest[start + 2..start + end].trim()));
        rest = &rest[start + end + 2..];
    }
    out.push_str(rest);
    out
}

fn active(v: &Value) -> bool {
    v.get("active").and_then(Value::as_bool).unwrap_or(true)
}

fn pairs(v: &Value) -> Vec<(String, String)> {
    v.as_array()
        .map(|a| a.iter().filter(|e| active(e) && !s(&e["key"]).is_empty()).map(|e| (vars(&s(&e["key"])), vars(&s(&e["value"])))).collect())
        .unwrap_or_default()
}

fn request_of(r: &Value, inherited: &Value, warnings: &mut Vec<String>) -> RequestFile {
    let mut req = RequestFile {
        name: s(&r["name"]),
        method: r.get("method").and_then(Value::as_str).unwrap_or("GET").to_ascii_uppercase(),
        url: vars(&s(&r["endpoint"])),
        headers: Vec::new(),
        body: None,
    };
    if let Some(hs) = r["headers"].as_array() {
        for h in hs.iter().filter(|h| !s(&h["key"]).trim().is_empty()) {
            req.headers.push(RequestHeader { name: vars(&s(&h["key"])), value: vars(&s(&h["value"])), enabled: active(h) });
        }
    }
    req.url = append_query(&req.url, &pairs(&r["params"]));

    let auth = if s(&r["auth"]["authType"]) == "inherit" || r.get("auth").is_none() { inherited } else { &r["auth"] };
    if auth.get("authActive").and_then(Value::as_bool).unwrap_or(true) {
        match s(&auth["authType"]).as_str() {
            "bearer" => req.headers.insert(0, header("Authorization", &bearer(&vars(&s(&auth["token"]))))),
            "basic" => req.headers.insert(0, header("Authorization", &basic(&vars(&s(&auth["username"])), &vars(&s(&auth["password"]))))),
            "api-key" => {
                let (k, val) = (vars(&s(&auth["key"])), vars(&s(&auth["value"])));
                if s(&auth["addTo"]).to_ascii_uppercase().contains("QUERY") {
                    req.url = append_query(&req.url, &[(k, val)]);
                } else {
                    req.headers.insert(0, header(&k, &val));
                }
            }
            "" | "none" | "inherit" => {}
            other => warnings.push(format!("Auth type \"{other}\" on \"{}\" was not imported", req.name)),
        }
    }

    let body = &r["body"];
    let ctype = s(&body["contentType"]);
    match (ctype.as_str(), &body["body"]) {
        ("", _) | (_, Value::Null) => {}
        (c, Value::String(text)) if c == FORM_CONTENT_TYPE => {
            // Hoppscotch stores form bodies as `key: value` lines, `#` marking disabled ones.
            let fields: Vec<(String, String)> = text
                .lines()
                .filter(|l| !l.trim().is_empty() && !l.trim_start().starts_with('#'))
                .map(|l| match l.split_once(':') {
                    Some((k, v)) => (vars(k.trim()), vars(v.trim())),
                    None => (vars(l.trim()), String::new()),
                })
                .collect();
            req.body = Some(form_body(&fields)).filter(|b| !b.is_empty());
            default_header(&mut req, "Content-Type", FORM_CONTENT_TYPE);
        }
        (c, Value::String(text)) if !text.is_empty() => {
            req.body = Some(vars(text));
            default_header(&mut req, "Content-Type", c);
        }
        (c, _) if c.starts_with("multipart/") => {
            warnings.push(format!("\"{}\": multipart bodies are not supported; the body was left empty", req.name));
        }
        _ => {}
    }
    if req.name.trim().is_empty() {
        req.name = name_from_url(&req.url);
    }
    req
}

fn walk(c: &Value, folder: &str, inherited: &Value, warnings: &mut Vec<String>, out: &mut Vec<ImportedRequest>) {
    let own = c.get("auth").filter(|a| s(&a["authType"]) != "inherit").unwrap_or(inherited);
    for r in c["requests"].as_array().into_iter().flatten() {
        out.push(ImportedRequest { folder: folder.to_string(), request: request_of(r, own, warnings) });
    }
    for f in c["folders"].as_array().into_iter().flatten() {
        let name = s(&f["name"]);
        let sub = if folder.is_empty() { name } else { format!("{folder}/{name}") };
        walk(f, &sub, own, warnings, out);
    }
}

pub fn import(v: &Value) -> Res<ImportResult> {
    let collections: Vec<&Value> = match v {
        Value::Array(a) => a.iter().collect(),
        other => vec![other],
    };
    let mut warnings = Vec::new();
    let mut requests = Vec::new();
    // Several collections in one export keep their own top-level folder.
    let many = collections.len() > 1;
    for c in &collections {
        let folder = if many { s(&c["name"]) } else { String::new() };
        walk(c, &folder, &Value::Null, &mut warnings, &mut requests);
    }
    let name = if many { "Hoppscotch".to_string() } else { s(&collections[0]["name"]) };
    Ok(ImportResult { source: "hoppscotch".into(), name, requests, variables: Vec::new(), environments: Vec::new(), warnings })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn imports_folders_auth_inheritance_and_bodies() {
        let v: Value = serde_json::from_str(
            r#"{ "v": 2, "name": "Shop", "auth": { "authType": "bearer", "authActive": true, "token": "<<token>>" },
              "folders": [{ "name": "Users", "auth": { "authType": "inherit" }, "folders": [], "requests": [
                { "name": "List", "method": "GET", "endpoint": "<<base>>/users", "params": [{ "key": "page", "value": "1", "active": true }, { "key": "off", "value": "x", "active": false }],
                  "headers": [{ "key": "X-A", "value": "1", "active": false }], "auth": { "authType": "inherit" }, "body": { "contentType": null, "body": null } } ] }],
              "requests": [
                { "name": "Login", "method": "POST", "endpoint": "<<base>>/login", "auth": { "authType": "basic", "authActive": true, "username": "ada", "password": "pw" },
                  "body": { "contentType": "application/x-www-form-urlencoded", "body": "q: a b\n#off: 1" } },
                { "name": "Raw", "method": "POST", "endpoint": "http://x", "auth": { "authType": "none" }, "body": { "contentType": "application/json", "body": "{\"a\":\"<<v>>\"}" } },
                { "name": "Up", "method": "POST", "endpoint": "http://x/up", "body": { "contentType": "multipart/form-data", "body": [] } } ] }"#,
        )
        .unwrap();
        assert!(detect(&v));
        let r = import(&v).unwrap();
        assert_eq!(r.name, "Shop");
        assert_eq!(r.requests.len(), 4);
        let list = r.requests.iter().find(|x| x.request.name == "List").unwrap();
        assert_eq!(list.folder, "Users");
        assert_eq!(list.request.url, "{{base}}/users?page=1");
        assert_eq!(list.request.headers[0].value, "Bearer {{token}}", "folder inherits collection auth");
        assert!(!list.request.headers[1].enabled);
        let login = r.requests.iter().find(|x| x.request.name == "Login").unwrap();
        assert_eq!(login.request.headers[0].value, "Basic ada:pw");
        assert_eq!(login.request.body.as_deref(), Some("q=a%20b"));
        let raw = r.requests.iter().find(|x| x.request.name == "Raw").unwrap();
        assert_eq!(raw.request.body.as_deref(), Some("{\"a\":\"{{v}}\"}"));
        assert!(raw.request.headers.iter().all(|h| h.name != "Authorization"));
        assert!(r.warnings.iter().any(|w| w.contains("multipart")));
    }
}

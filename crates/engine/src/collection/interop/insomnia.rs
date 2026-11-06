//! Insomnia export format v4 (JSON). The newer YAML (v5) export is not supported.

use std::collections::HashMap;

use serde_json::Value;

use crate::collection::environment::{EnvVariable, Environment};
use crate::collection::model::{RequestFile, RequestHeader};

use super::util::{append_query, basic, bearer, default_header, form_body, header, name_from_url, FORM_CONTENT_TYPE};
use super::{ImportResult, ImportedRequest};

type Res<T> = Result<T, String>;

pub fn detect(v: &Value) -> bool {
    v.get("_type").and_then(Value::as_str) == Some("export") && v.get("resources").is_some_and(Value::is_array)
}

fn s(v: &Value) -> String {
    v.as_str().unwrap_or("").to_string()
}

/// Insomnia templates variables as `{{ _.name }}`; DeadLetter uses `{{name}}`.
fn convert_vars(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("{{") {
        let Some(end) = rest[start..].find("}}") else { break };
        let inner = rest[start + 2..start + end].trim();
        out.push_str(&rest[..start]);
        out.push_str(&format!("{{{{{}}}}}", inner.strip_prefix("_.").unwrap_or(inner)));
        rest = &rest[start + end + 2..];
    }
    out.push_str(rest);
    out
}

fn enabled(v: &Value) -> bool {
    !v.get("disabled").and_then(Value::as_bool).unwrap_or(false)
}

fn pairs(v: &Value, key: &str) -> Vec<(String, String)> {
    v.get(key)
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter(|e| enabled(e) && !s(&e["name"]).is_empty())
                .map(|e| (convert_vars(&s(&e["name"])), convert_vars(&s(&e["value"]))))
                .collect()
        })
        .unwrap_or_default()
}

fn request_of(r: &Value, warnings: &mut Vec<String>) -> RequestFile {
    let mut req = RequestFile {
        name: s(&r["name"]),
        method: r.get("method").and_then(Value::as_str).unwrap_or("GET").to_ascii_uppercase(),
        url: convert_vars(&s(&r["url"])),
        headers: Vec::new(),
        body: None,
    };
    if let Some(hs) = r.get("headers").and_then(Value::as_array) {
        for h in hs.iter().filter(|h| !s(&h["name"]).trim().is_empty()) {
            req.headers.push(RequestHeader {
                name: convert_vars(&s(&h["name"])),
                value: convert_vars(&s(&h["value"])),
                enabled: enabled(h),
            });
        }
    }
    req.url = append_query(&req.url, &pairs(r, "parameters"));

    let auth = &r["authentication"];
    if enabled(auth) {
        match auth.get("type").and_then(Value::as_str).unwrap_or("") {
            "bearer" => req.headers.insert(0, header("Authorization", &bearer(&convert_vars(&s(&auth["token"]))))),
            "basic" => req.headers.insert(
                0,
                header("Authorization", &basic(&convert_vars(&s(&auth["username"])), &convert_vars(&s(&auth["password"])))),
            ),
            "" | "none" => {}
            other => warnings.push(format!("Auth type \"{other}\" on \"{}\" was not imported", req.name)),
        }
    }

    let body = &r["body"];
    let mime = s(&body["mimeType"]);
    if mime == FORM_CONTENT_TYPE {
        let fields = pairs(body, "params");
        if !fields.is_empty() {
            req.body = Some(form_body(&fields));
            default_header(&mut req, "Content-Type", FORM_CONTENT_TYPE);
        }
    } else if mime == "application/graphql" {
        // Insomnia keeps the whole `{ query, variables }` envelope as text already.
        req.body = Some(convert_vars(&s(&body["text"]))).filter(|t| !t.is_empty());
        default_header(&mut req, "Content-Type", "application/json");
    } else if mime.starts_with("multipart/") {
        warnings.push(format!("\"{}\": multipart bodies are not supported; the body was left empty", req.name));
    } else if let Some(text) = body.get("text").and_then(Value::as_str).filter(|t| !t.is_empty()) {
        req.body = Some(convert_vars(text));
        if !mime.is_empty() {
            default_header(&mut req, "Content-Type", &mime);
        }
    }
    if req.name.trim().is_empty() {
        req.name = name_from_url(&req.url);
    }
    req
}

pub fn import(v: &Value) -> Res<ImportResult> {
    let resources = v.get("resources").and_then(Value::as_array).ok_or("Not an Insomnia export")?;
    let by_id: HashMap<String, &Value> = resources.iter().map(|r| (s(&r["_id"]), r)).collect();

    // Folder path of a request: walk parentId through request_group resources.
    let folder_of = |r: &Value| -> String {
        let mut parts = Vec::new();
        let mut parent = s(&r["parentId"]);
        let mut guard = 0;
        while let Some(p) = by_id.get(&parent) {
            if s(&p["_type"]) != "request_group" || guard > 32 {
                break;
            }
            parts.push(s(&p["name"]));
            parent = s(&p["parentId"]);
            guard += 1;
        }
        parts.reverse();
        parts.join("/")
    };

    let mut warnings = Vec::new();
    let requests: Vec<ImportedRequest> = resources
        .iter()
        .filter(|r| r.get("_type").and_then(Value::as_str) == Some("request"))
        .map(|r| ImportedRequest { folder: folder_of(r), request: request_of(r, &mut warnings) })
        .collect();

    // The base environment (a direct child of the workspace) becomes the variables.
    let workspace = resources.iter().find(|r| s(&r["_type"]) == "workspace");
    let workspace_id = workspace.map(|w| s(&w["_id"]));
    let variables = resources
        .iter()
        .find(|r| s(&r["_type"]) == "environment" && Some(s(&r["parentId"])) == workspace_id)
        .and_then(|e| e.get("data").and_then(Value::as_object))
        .map(|data| {
            data.iter()
                .filter_map(|(k, val)| match val {
                    Value::String(t) => Some((k, t.clone())),
                    Value::Number(n) => Some((k, n.to_string())),
                    Value::Bool(b) => Some((k, b.to_string())),
                    _ => None,
                })
                .map(|(k, value)| EnvVariable { name: k.clone(), value, enabled: true, secret: false })
                .collect()
        })
        .unwrap_or_default();

    Ok(ImportResult {
        source: "insomnia".into(),
        name: workspace.map(|w| s(&w["name"])).unwrap_or_default(),
        requests,
        variables,
        environments: Vec::new(),
        warnings,
    })
}

// --- v5 (YAML) ---------------------------------------------------------------------------

pub fn detect_v5(v: &Value) -> bool {
    v.get("type").and_then(Value::as_str).is_some_and(|t| t.starts_with("collection.insomnia.rest/") || t.starts_with("environment.insomnia.rest/"))
}

fn env_variables(data: &Value) -> Vec<EnvVariable> {
    data.as_object()
        .map(|o| {
            o.iter()
                .filter_map(|(k, val)| match val {
                    Value::String(t) => Some((k, convert_vars(t))),
                    Value::Number(n) => Some((k, n.to_string())),
                    Value::Bool(b) => Some((k, b.to_string())),
                    _ => None,
                })
                .map(|(k, value)| EnvVariable { name: k.clone(), value, enabled: true, secret: false })
                .collect()
        })
        .unwrap_or_default()
}

fn walk_v5(items: &[Value], folder: &str, warnings: &mut Vec<String>, out: &mut Vec<ImportedRequest>) {
    for item in items {
        if let Some(children) = item.get("children").and_then(Value::as_array) {
            let name = s(&item["name"]);
            let sub = if folder.is_empty() { name } else { format!("{folder}/{name}") };
            walk_v5(children, &sub, warnings, out);
        } else if item.get("url").is_some() || item.get("method").is_some() {
            out.push(ImportedRequest { folder: folder.to_string(), request: request_of(item, warnings) });
        }
    }
}

/// Insomnia v5 collections and environments (YAML, already converted to JSON values).
pub fn import_v5(v: &Value) -> Res<ImportResult> {
    let name = s(&v["name"]);
    let mut warnings = Vec::new();
    let mut requests = Vec::new();
    let mut variables = Vec::new();
    let mut environments = Vec::new();

    if s(&v["type"]).starts_with("environment.") {
        let env_name = if name.trim().is_empty() { "Insomnia environment".to_string() } else { name.clone() };
        environments.push(Environment { name: env_name, variables: env_variables(&v["data"]) });
    } else {
        let items = v.get("collection").and_then(Value::as_array).ok_or("Not an Insomnia collection: no \"collection\" list")?;
        walk_v5(items, "", &mut warnings, &mut requests);
        variables = env_variables(&v["environments"]["data"]);
        if let Some(subs) = v["environments"]["subEnvironments"].as_array() {
            for sub in subs {
                let n = s(&sub["name"]);
                if !n.trim().is_empty() {
                    environments.push(Environment { name: format!("{} - {n}", if name.is_empty() { "Insomnia" } else { &name }), variables: env_variables(&sub["data"]) });
                }
            }
        }
    }
    Ok(ImportResult { source: "insomnia".into(), name, requests, variables, environments, warnings })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn imports_groups_auth_bodies_and_environment() {
        let doc: Value = serde_json::from_str(
            r#"{ "_type": "export", "__export_format": 4, "resources": [
              { "_id": "wrk_1", "_type": "workspace", "name": "Shop" },
              { "_id": "env_1", "_type": "environment", "parentId": "wrk_1", "data": { "base": "https://shop.test", "n": 3, "nested": { "a": 1 } } },
              { "_id": "fld_1", "_type": "request_group", "parentId": "wrk_1", "name": "Users" },
              { "_id": "fld_2", "_type": "request_group", "parentId": "fld_1", "name": "Admin" },
              { "_id": "req_1", "_type": "request", "parentId": "fld_2", "name": "List", "method": "GET",
                "url": "{{ _.base }}/users", "parameters": [{ "name": "page", "value": "1" }, { "name": "off", "value": "x", "disabled": true }],
                "headers": [{ "name": "X-A", "value": "{{_.n}}" }],
                "authentication": { "type": "bearer", "token": "{{ _.token }}" } },
              { "_id": "req_2", "_type": "request", "parentId": "wrk_1", "name": "Login", "method": "post", "url": "{{ _.base }}/login",
                "body": { "mimeType": "application/x-www-form-urlencoded", "params": [{ "name": "q", "value": "a b" }] },
                "authentication": { "type": "oauth2" } },
              { "_id": "req_3", "_type": "request", "parentId": "wrk_1", "name": "Raw", "method": "POST", "url": "http://x",
                "body": { "mimeType": "application/json", "text": "{\"a\":\"{{ _.base }}\"}" } }
            ] }"#,
        )
        .unwrap();
        assert!(detect(&doc));
        let r = import(&doc).unwrap();
        assert_eq!(r.name, "Shop");
        assert_eq!(r.requests.len(), 3);
        assert_eq!(r.requests[0].folder, "Users/Admin");
        assert_eq!(r.requests[0].request.url, "{{base}}/users?page=1");
        assert_eq!(r.requests[0].request.headers[0].value, "Bearer {{token}}");
        assert_eq!(r.requests[0].request.headers[1].value, "{{n}}");
        assert_eq!(r.requests[1].request.method, "POST");
        assert_eq!(r.requests[1].request.body.as_deref(), Some("q=a%20b"));
        assert_eq!(r.requests[2].request.body.as_deref(), Some("{\"a\":\"{{base}}\"}"));
        assert_eq!(r.requests[2].request.headers[0].value, "application/json");
        assert!(r.warnings.iter().any(|w| w.contains("oauth2")));
        let names: Vec<_> = r.variables.iter().map(|v| v.name.as_str()).collect();
        assert!(names.contains(&"base") && names.contains(&"n") && !names.contains(&"nested"));
    }

    #[test]
    fn imports_v5_yaml_collection() {
        let doc: Value = serde_norway::from_str(
            "type: collection.insomnia.rest/5.0
name: Shop
collection:
  - name: Users
    children:
      - url: '{{ _.base }}/users'
        name: List
        method: GET
        authentication: {type: bearer, token: abc}
  - url: http://x/ping
    name: Ping
    method: GET
environments:
  name: Base
  data: {base: 'https://shop.test'}
  subEnvironments:
    - name: Prod
      data: {base: 'https://p.test'}
",
        )
        .unwrap();
        assert!(detect_v5(&doc));
        let r = import_v5(&doc).unwrap();
        assert_eq!(r.requests.len(), 2);
        assert_eq!(r.requests[0].folder, "Users");
        assert_eq!(r.requests[0].request.url, "{{base}}/users");
        assert_eq!(r.requests[0].request.headers[0].value, "Bearer abc");
        assert_eq!(r.variables[0].value, "https://shop.test");
        assert_eq!(r.environments[0].name, "Shop - Prod");
    }
}

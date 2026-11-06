//! Postman Collection v2.0/v2.1: import into requests and export of a workspace.

use serde_json::{json, Map, Value};

use crate::collection::model::{RequestFile, RequestHeader};
use crate::http::encode_basic_auth;
use crate::collection::environment::EnvVariable;

use super::util::{
    decode_field, append_query, basic, bearer, content_type, default_header, form_body, header, name_from_url, FORM_CONTENT_TYPE,
    JSON_CONTENT_TYPE,
};
use super::{ImportResult, ImportedRequest};

type Res<T> = Result<T, String>;

pub fn detect(v: &Value) -> bool {
    v.get("info").is_some_and(|i| i.get("schema").and_then(Value::as_str).is_some_and(|s| s.contains("postman")))
        || (v.get("info").is_some_and(|i| i.get("name").is_some()) && v.get("item").is_some_and(Value::is_array))
}

fn s(v: &Value) -> String {
    v.as_str().unwrap_or("").to_string()
}

/// Postman stores auth as `{ "type": "bearer", "bearer": [{ "key": "token", "value": "..." }] }`.
fn auth_field(auth: &Value, kind: &str, key: &str) -> String {
    auth.get(kind)
        .and_then(Value::as_array)
        .and_then(|a| a.iter().find(|e| e.get("key").and_then(Value::as_str) == Some(key)))
        .and_then(|e| e.get("value"))
        .map(s)
        .unwrap_or_default()
}

struct Ctx {
    warnings: Vec<String>,
    scripts: usize,
}

fn apply_auth(auth: &Value, req: &mut RequestFile, ctx: &mut Ctx) {
    let kind = auth.get("type").and_then(Value::as_str).unwrap_or("");
    match kind {
        "bearer" => req.headers.insert(0, header("Authorization", &bearer(&auth_field(auth, "bearer", "token")))),
        "basic" => req.headers.insert(
            0,
            header("Authorization", &basic(&auth_field(auth, "basic", "username"), &auth_field(auth, "basic", "password"))),
        ),
        "apikey" => {
            let key = auth_field(auth, "apikey", "key");
            let value = auth_field(auth, "apikey", "value");
            if auth_field(auth, "apikey", "in") == "query" {
                req.url = append_query(&req.url, &[(key, value)]);
            } else {
                req.headers.insert(0, header(&key, &value));
            }
        }
        "" | "noauth" => {}
        other => ctx.warnings.push(format!("Auth type \"{other}\" on \"{}\" was not imported", req.name)),
    }
}

fn url_of(url: &Value) -> String {
    if let Some(raw) = url.as_str() {
        return raw.to_string();
    }
    if let Some(raw) = url.get("raw").and_then(Value::as_str) {
        return raw.to_string();
    }
    let join = |k: &str, sep: &str| {
        match url.get(k) {
            Some(Value::Array(a)) => a.iter().map(s).collect::<Vec<_>>().join(sep),
            Some(v) => s(v),
            None => String::new(),
        }
    };
    let (host, path) = (join("host", "."), join("path", "/"));
    let proto = url.get("protocol").and_then(Value::as_str).map(|p| format!("{p}://")).unwrap_or_default();
    format!("{proto}{host}/{path}")
}

fn body_of(body: &Value, req: &mut RequestFile, ctx: &mut Ctx) {
    match body.get("mode").and_then(Value::as_str).unwrap_or("") {
        "raw" => {
            let raw = s(&body["raw"]);
            if !raw.is_empty() {
                req.body = Some(raw);
                let lang = body.pointer("/options/raw/language").and_then(Value::as_str).unwrap_or("");
                if lang == "json" {
                    default_header(req, "Content-Type", JSON_CONTENT_TYPE);
                }
            }
        }
        "urlencoded" => {
            let fields: Vec<(String, String)> = body
                .get("urlencoded")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter(|f| !f.get("disabled").and_then(Value::as_bool).unwrap_or(false))
                        .map(|f| (s(&f["key"]), s(&f["value"])))
                        .collect()
                })
                .unwrap_or_default();
            if !fields.is_empty() {
                req.body = Some(form_body(&fields));
                default_header(req, "Content-Type", FORM_CONTENT_TYPE);
            }
        }
        "graphql" => {
            let g = &body["graphql"];
            let mut env = Map::new();
            env.insert("query".into(), Value::String(s(&g["query"])));
            if let Some(vars) = g.get("variables").and_then(Value::as_str).filter(|v| !v.trim().is_empty()) {
                if let Ok(Value::Object(o)) = serde_json::from_str::<Value>(vars) {
                    env.insert("variables".into(), Value::Object(o));
                }
            }
            req.body = serde_json::to_string_pretty(&Value::Object(env)).ok();
            default_header(req, "Content-Type", JSON_CONTENT_TYPE);
        }
        "formdata" | "file" | "binary" => {
            let kind = match body["mode"].as_str() {
                Some("file") | Some("binary") => "file",
                _ => "form-data",
            };
            ctx.warnings.push(format!("\"{}\": {kind} bodies are not supported; the body was left empty", req.name));
        }
        _ => {}
    }
}

fn request_of(name: &str, item: &Value, inherited: &Value, ctx: &mut Ctx) -> Option<RequestFile> {
    let r = item.get("request")?;
    let mut req = RequestFile {
        name: name.to_string(),
        method: "GET".into(),
        url: String::new(),
        headers: Vec::new(),
        body: None,
    };
    if let Some(url) = r.as_str() {
        req.url = url.to_string();
    } else {
        req.method = r.get("method").and_then(Value::as_str).unwrap_or("GET").to_ascii_uppercase();
        req.url = r.get("url").map(url_of).unwrap_or_default();
        if let Some(hs) = r.get("header").and_then(Value::as_array) {
            for h in hs {
                let key = s(&h["key"]);
                if key.trim().is_empty() {
                    continue;
                }
                req.headers.push(RequestHeader {
                    name: key,
                    value: s(&h["value"]),
                    enabled: !h.get("disabled").and_then(Value::as_bool).unwrap_or(false),
                });
            }
        }
        if let Some(b) = r.get("body") {
            body_of(b, &mut req, ctx);
        }
        let auth = r.get("auth").unwrap_or(inherited);
        apply_auth(auth, &mut req, ctx);
    }
    if item.get("event").and_then(Value::as_array).is_some_and(|e| !e.is_empty()) {
        ctx.scripts += 1;
    }
    if req.name.trim().is_empty() {
        req.name = name_from_url(&req.url);
    }
    Some(req)
}

fn walk(items: &[Value], folder: &str, inherited: &Value, ctx: &mut Ctx, out: &mut Vec<ImportedRequest>) {
    for item in items {
        let name = s(&item["name"]);
        if let Some(children) = item.get("item").and_then(Value::as_array) {
            let sub = if folder.is_empty() { name.clone() } else { format!("{folder}/{name}") };
            let auth = item.get("auth").unwrap_or(inherited);
            walk(children, &sub, auth, ctx, out);
        } else if let Some(request) = request_of(&name, item, inherited, ctx) {
            out.push(ImportedRequest { folder: folder.to_string(), request });
        }
    }
}

pub fn import(v: &Value) -> Res<ImportResult> {
    let mut ctx = Ctx { warnings: Vec::new(), scripts: 0 };
    let mut requests = Vec::new();
    let items = v.get("item").and_then(Value::as_array).ok_or("Not a Postman collection: no \"item\" list")?;
    walk(items, "", v.get("auth").unwrap_or(&Value::Null), &mut ctx, &mut requests);

    if ctx.scripts > 0 {
        ctx.warnings.push(format!("{} request(s) had pre-request/test scripts, which are not imported", ctx.scripts));
    }
    let variables = v
        .get("variable")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter(|e| !s(&e["key"]).is_empty())
                .map(|e| EnvVariable { name: s(&e["key"]), value: s(&e["value"]), enabled: true, secret: false })
                .collect()
        })
        .unwrap_or_default();
    Ok(ImportResult {
        source: "postman".into(),
        name: s(&v["info"]["name"]),
        requests,
        variables,
        warnings: ctx.warnings,
    })
}

// --- export ------------------------------------------------------------------------------

fn query_pairs(url: &str) -> Vec<Value> {
    let Some((_, q)) = url.split_once('?') else { return Vec::new() };
    q.split('#')
        .next()
        .unwrap_or("")
        .split('&')
        .filter(|p| !p.is_empty())
        .map(|p| {
            let (k, v) = p.split_once('=').unwrap_or((p, ""));
            json!({ "key": k, "value": v })
        })
        .collect()
}

pub fn request_to_postman(req: &RequestFile) -> Value {
    let headers: Vec<Value> = req
        .headers
        .iter()
        .filter(|h| !h.name.trim().is_empty())
        .map(|h| {
            let value = if h.name.trim().eq_ignore_ascii_case("authorization") { encode_basic_auth(&h.value) } else { h.value.clone() };
            let mut o = json!({ "key": h.name, "value": value });
            if !h.enabled {
                o["disabled"] = json!(true);
            }
            o
        })
        .collect();

    let mut request = json!({
        "method": req.method.to_ascii_uppercase(),
        "header": headers,
        "url": { "raw": req.url, "query": query_pairs(&req.url) },
    });
    if let Some(body) = req.body.as_deref().filter(|b| !b.is_empty()) {
        let ct = content_type(req).unwrap_or_default();
        request["body"] = if ct.starts_with(FORM_CONTENT_TYPE) {
            let fields: Vec<Value> = body
                .split('&')
                .filter(|p| !p.is_empty())
                .map(|p| {
                    let (k, v) = p.split_once('=').unwrap_or((p, ""));
                    json!({ "key": decode_field(k), "value": decode_field(v) })
                })
                .collect();
            json!({ "mode": "urlencoded", "urlencoded": fields })
        } else {
            let lang = if ct.contains("json") { "json" } else { "text" };
            json!({ "mode": "raw", "raw": body, "options": { "raw": { "language": lang } } })
        };
    }
    json!({ "name": req.name, "request": request })
}

pub fn collection(name: &str, items: Vec<Value>) -> Value {
    json!({
        "info": {
            "name": name,
            "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
        },
        "item": items,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"{
      "info": { "name": "Shop", "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
      "auth": { "type": "bearer", "bearer": [{ "key": "token", "value": "{{token}}" }] },
      "variable": [{ "key": "baseUrl", "value": "https://shop.test" }],
      "item": [
        { "name": "Users", "item": [
          { "name": "List", "event": [{ "listen": "test" }],
            "request": { "method": "GET", "header": [{ "key": "X-Off", "value": "1", "disabled": true }],
                         "url": { "raw": "{{baseUrl}}/users?page=1" } } },
          { "name": "Create", "request": { "method": "POST", "auth": { "type": "noauth" },
              "body": { "mode": "raw", "raw": "{\"a\":1}", "options": { "raw": { "language": "json" } } },
              "url": "{{baseUrl}}/users" } },
          { "name": "Login", "request": { "method": "POST", "auth": { "type": "basic", "basic": [{ "key": "username", "value": "ada" }, { "key": "password", "value": "pw" }] },
              "body": { "mode": "urlencoded", "urlencoded": [{ "key": "q", "value": "a b" }, { "key": "x", "value": "1", "disabled": true }] },
              "url": { "raw": "{{baseUrl}}/login" } } },
          { "name": "Upload", "request": { "method": "POST", "body": { "mode": "formdata", "formdata": [] }, "url": "{{baseUrl}}/up" } }
        ] },
        { "name": "Ping", "request": { "method": "GET", "auth": { "type": "apikey", "apikey": [{ "key": "key", "value": "k" }, { "key": "value", "value": "{{k}}" }, { "key": "in", "value": "query" }] },
            "url": { "raw": "{{baseUrl}}/ping" } } }
      ]
    }"#;

    #[test]
    fn imports_folders_auth_bodies_and_variables() {
        let r = import(&serde_json::from_str(SAMPLE).unwrap()).unwrap();
        assert_eq!(r.name, "Shop");
        assert_eq!(r.requests.len(), 5);
        assert_eq!((r.variables[0].name.as_str(), r.variables[0].value.as_str()), ("baseUrl", "https://shop.test"));

        let list = &r.requests[0];
        assert_eq!(list.folder, "Users");
        assert_eq!(list.request.url, "{{baseUrl}}/users?page=1");
        // Inherited bearer on top, then the disabled header kept disabled.
        assert_eq!(list.request.headers[0].value, "Bearer {{token}}");
        assert!(!list.request.headers[1].enabled);

        let create = &r.requests[1].request;
        assert!(create.headers.iter().all(|h| h.name != "Authorization"), "noauth overrides inheritance");
        assert_eq!(create.headers[0].value, JSON_CONTENT_TYPE);

        let login = &r.requests[2].request;
        assert_eq!(login.headers[0].value, "Basic ada:pw");
        assert_eq!(login.body.as_deref(), Some("q=a%20b"));

        assert_eq!(r.requests[4].folder, "");
        assert_eq!(r.requests[4].request.url, "{{baseUrl}}/ping?k={{k}}");

        assert!(r.warnings.iter().any(|w| w.contains("form-data bodies")));
        assert!(r.warnings.iter().any(|w| w.contains("scripts")));
    }

    #[test]
    fn export_round_trips_through_import() {
        let req = RequestFile {
            name: "Login".into(),
            method: "POST".into(),
            url: "https://x.test/login?a=1".into(),
            headers: vec![
                header("Content-Type", FORM_CONTENT_TYPE),
                header("Authorization", "Basic ada:pw"),
                RequestHeader { name: "X-Off".into(), value: "1".into(), enabled: false },
            ],
            body: Some("q=a%20b&z=1".into()),
        };
        let doc = collection("Shop", vec![json!({ "name": "Auth", "item": [request_to_postman(&req)] })]);
        let back = import(&doc).unwrap();
        let got = &back.requests[0];
        assert_eq!(got.folder, "Auth");
        assert_eq!(got.request.url, req.url);
        assert_eq!(got.request.body.as_deref(), Some("q=a%20b&z=1"));
        assert_eq!(got.request.headers[1].value, "Basic YWRhOnB3");
        assert!(!got.request.headers[2].enabled);
    }
}

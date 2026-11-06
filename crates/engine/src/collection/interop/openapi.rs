//! OpenAPI 3.x and Swagger 2.0 (JSON) -> one request per operation, grouped by tag.
//! Path parameters become `{{variables}}` so a request is ready once an environment defines them.

use serde_json::{Map, Value};

use crate::collection::environment::EnvVariable;
use crate::collection::model::RequestFile;

use super::util::{append_query, basic, bearer, default_header, form_body, header, FORM_CONTENT_TYPE, JSON_CONTENT_TYPE};
use super::{ImportResult, ImportedRequest};

type Res<T> = Result<T, String>;

const METHODS: [&str; 7] = ["get", "put", "post", "delete", "options", "head", "patch"];
const MAX_DEPTH: usize = 5;

pub fn detect(v: &Value) -> bool {
    v.get("openapi").is_some() || v.get("swagger").is_some()
}

fn s(v: &Value) -> String {
    v.as_str().unwrap_or("").to_string()
}

/// Follows a local `$ref` such as `#/components/schemas/User`.
fn deref<'a>(root: &'a Value, v: &'a Value) -> &'a Value {
    let mut cur = v;
    for _ in 0..MAX_DEPTH {
        match cur.get("$ref").and_then(Value::as_str).and_then(|r| r.strip_prefix('#')) {
            Some(pointer) => match root.pointer(pointer) {
                Some(next) => cur = next,
                None => return cur,
            },
            None => return cur,
        }
    }
    cur
}

/// A small example value for a schema: its own example/default/enum, else a typed placeholder.
fn sample(root: &Value, schema: &Value, depth: usize) -> Value {
    let schema = deref(root, schema);
    for key in ["example", "default"] {
        if let Some(v) = schema.get(key) {
            return v.clone();
        }
    }
    if let Some(first) = schema.get("enum").and_then(Value::as_array).and_then(|e| e.first()) {
        return first.clone();
    }
    if depth >= MAX_DEPTH {
        return Value::Null;
    }
    for key in ["oneOf", "anyOf"] {
        if let Some(first) = schema.get(key).and_then(Value::as_array).and_then(|a| a.first()) {
            return sample(root, first, depth + 1);
        }
    }
    if let Some(parts) = schema.get("allOf").and_then(Value::as_array) {
        let mut merged = Map::new();
        for p in parts {
            if let Value::Object(o) = sample(root, p, depth + 1) {
                merged.extend(o);
            }
        }
        return Value::Object(merged);
    }
    let kind = schema.get("type").and_then(Value::as_str).unwrap_or_else(|| {
        if schema.get("properties").is_some() { "object" } else { "" }
    });
    match kind {
        "object" => {
            let mut o = Map::new();
            if let Some(props) = schema.get("properties").and_then(Value::as_object) {
                for (k, p) in props {
                    o.insert(k.clone(), sample(root, p, depth + 1));
                }
            }
            Value::Object(o)
        }
        "array" => Value::Array(schema.get("items").map(|i| vec![sample(root, i, depth + 1)]).unwrap_or_default()),
        "integer" | "number" => Value::from(0),
        "boolean" => Value::Bool(false),
        "string" => Value::String(match schema.get("format").and_then(Value::as_str) {
            Some("date-time") => "2024-01-01T00:00:00Z".into(),
            Some("date") => "2024-01-01".into(),
            Some("email") => "user@example.com".into(),
            Some("uuid") => "00000000-0000-0000-0000-000000000000".into(),
            _ => "string".into(),
        }),
        _ => Value::Null,
    }
}

struct Vars(Vec<EnvVariable>);

impl Vars {
    /// First definition wins; a path parameter shared by several operations is defined once.
    fn add(&mut self, name: &str, value: &str, secret: bool) {
        if !name.is_empty() && !self.0.iter().any(|v| v.name == name) {
            self.0.push(EnvVariable { name: name.to_string(), value: value.to_string(), enabled: true, secret });
        }
    }
}

fn param_example(root: &Value, p: &Value) -> Option<String> {
    let from = |v: &Value| match v {
        Value::String(t) => Some(t.clone()),
        Value::Null => None,
        other => Some(other.to_string()),
    };
    p.get("example")
        .and_then(from)
        .or_else(|| p.get("schema").map(|sch| sample(root, sch, 0)).and_then(|v| from(&v)).filter(|t| t != "string" && t != "0"))
}

fn base_url(root: &Value) -> String {
    if let Some(server) = root.pointer("/servers/0") {
        let mut url = s(&server["url"]);
        if let Some(vars) = server.get("variables").and_then(Value::as_object) {
            for (k, v) in vars {
                url = url.replace(&format!("{{{k}}}"), &s(&v["default"]));
            }
        }
        return url;
    }
    let host = s(&root["host"]);
    if host.is_empty() {
        return String::new();
    }
    let scheme = root.pointer("/schemes/0").and_then(Value::as_str).unwrap_or("https");
    format!("{scheme}://{host}{}", s(&root["basePath"]))
}

struct Scheme {
    kind: &'static str, // "bearer" | "basic" | "header" | "query"
    name: String,
}

fn schemes(root: &Value) -> Vec<(String, Scheme)> {
    let defs = root.pointer("/components/securitySchemes").or_else(|| root.get("securityDefinitions"));
    let Some(defs) = defs.and_then(Value::as_object) else { return Vec::new() };
    defs.iter()
        .filter_map(|(id, d)| {
            let d = deref(root, d);
            let scheme = match (s(&d["type"]).as_str(), s(&d["scheme"]).to_ascii_lowercase().as_str()) {
                ("http", "bearer") => Scheme { kind: "bearer", name: String::new() },
                ("http", "basic") | ("basic", _) => Scheme { kind: "basic", name: String::new() },
                ("apiKey", _) => Scheme {
                    kind: if s(&d["in"]) == "query" { "query" } else { "header" },
                    name: s(&d["name"]),
                },
                _ => return None,
            };
            Some((id.clone(), scheme))
        })
        .collect()
}

fn operation(root: &Value, path: &str, method: &str, op: &Value, common: &[Value], vars: &mut Vars, schemes: &[(String, Scheme)]) -> ImportedRequest {
    let tag = op.pointer("/tags/0").and_then(Value::as_str).map(str::to_string);
    let first_segment = path.split('/').find(|p| !p.is_empty() && !p.starts_with('{')).unwrap_or("");
    let folder = tag.unwrap_or_else(|| if first_segment.is_empty() { "General".to_string() } else { first_segment.to_string() });

    let mut name = s(&op["summary"]);
    if name.trim().is_empty() {
        name = s(&op["operationId"]);
    }
    if name.trim().is_empty() {
        name = format!("{} {path}", method.to_ascii_uppercase());
    }

    let mut req = RequestFile {
        name,
        method: method.to_ascii_uppercase(),
        url: String::new(),
        headers: Vec::new(),
        body: None,
    };

    // Path: `{id}` -> `{{id}}`.
    let mut url_path = String::new();
    let mut rest = path;
    while let Some(i) = rest.find('{') {
        let Some(j) = rest[i..].find('}') else { break };
        url_path.push_str(&rest[..i]);
        let name = &rest[i + 1..i + j];
        url_path.push_str(&format!("{{{{{name}}}}}"));
        rest = &rest[i + j + 1..];
    }
    url_path.push_str(rest);
    req.url = format!("{{{{baseUrl}}}}{url_path}");

    // Operation parameters override path-level ones with the same name and location.
    let mut params: Vec<Value> = Vec::new();
    let own: Vec<Value> = op.get("parameters").and_then(Value::as_array).cloned().unwrap_or_default();
    for p in own.iter().chain(common.iter()) {
        let p = deref(root, p).clone();
        let key = (s(&p["name"]), s(&p["in"]));
        if !params.iter().any(|q| (s(&q["name"]), s(&q["in"])) == key) {
            params.push(p);
        }
    }
    let mut query = Vec::new();
    for p in &params {
        let (pname, loc) = (s(&p["name"]), s(&p["in"]));
        let required = p.get("required").and_then(Value::as_bool).unwrap_or(false);
        let example = param_example(root, p);
        match loc.as_str() {
            "path" => vars.add(&pname, example.as_deref().unwrap_or(""), false),
            "query" if required => {
                vars.add(&pname, example.as_deref().unwrap_or(""), false);
                query.push((pname.clone(), format!("{{{{{pname}}}}}")));
            }
            "header" if required => {
                vars.add(&pname, example.as_deref().unwrap_or(""), false);
                req.headers.push(header(&pname, &format!("{{{{{pname}}}}}")));
            }
            _ => {}
        }
    }
    req.url = append_query(&req.url, &query);

    // Body (3.x requestBody, 2.0 `in: body` / `formData` parameters).
    if let Some(rb) = op.get("requestBody").map(|b| deref(root, b)) {
        let content = rb.get("content").and_then(Value::as_object);
        let pick = content.and_then(|c| {
            c.iter().find(|(k, _)| k.contains("json")).or_else(|| c.iter().find(|(k, _)| k.as_str() == FORM_CONTENT_TYPE))
        });
        if let Some((mime, media)) = pick {
            if mime.as_str() == FORM_CONTENT_TYPE {
                let schema = media.get("schema").map(|sch| sample(root, sch, 0)).unwrap_or(Value::Null);
                if let Value::Object(o) = schema {
                    let fields: Vec<(String, String)> = o
                        .iter()
                        .map(|(k, v)| (k.clone(), match v { Value::String(t) => t.clone(), other => other.to_string() }))
                        .collect();
                    req.body = Some(form_body(&fields));
                }
                default_header(&mut req, "Content-Type", FORM_CONTENT_TYPE);
            } else {
                let example = media
                    .get("example")
                    .cloned()
                    .or_else(|| media.pointer("/examples").and_then(Value::as_object).and_then(|e| e.values().next()).and_then(|e| e.get("value").cloned()))
                    .or_else(|| media.get("schema").map(|sch| sample(root, sch, 0)));
                req.body = example.and_then(|e| serde_json::to_string_pretty(&e).ok());
                default_header(&mut req, "Content-Type", JSON_CONTENT_TYPE);
            }
        }
    } else if let Some(bp) = params.iter().find(|p| s(&p["in"]) == "body") {
        let v = bp.get("schema").map(|sch| sample(root, sch, 0));
        req.body = v.and_then(|e| serde_json::to_string_pretty(&e).ok());
        default_header(&mut req, "Content-Type", JSON_CONTENT_TYPE);
    }

    // Security: the operation's own requirement list, else the global one. First scheme wins.
    let requirement = op.get("security").or_else(|| root.get("security")).and_then(Value::as_array);
    let used = requirement
        .and_then(|r| r.iter().find_map(|req| req.as_object().and_then(|o| o.keys().next())))
        .and_then(|id| schemes.iter().find(|(sid, _)| sid == id));
    if let Some((_, scheme)) = used {
        match scheme.kind {
            "bearer" => {
                vars.add("token", "", true);
                req.headers.insert(0, header("Authorization", &bearer("{{token}}")));
            }
            "basic" => {
                vars.add("username", "", false);
                vars.add("password", "", true);
                req.headers.insert(0, header("Authorization", &basic("{{username}}", "{{password}}")));
            }
            "query" => {
                vars.add("apiKey", "", true);
                req.url = append_query(&req.url, &[(scheme.name.clone(), "{{apiKey}}".to_string())]);
            }
            _ => {
                vars.add("apiKey", "", true);
                req.headers.insert(0, header(&scheme.name, "{{apiKey}}"));
            }
        }
    }

    ImportedRequest { folder, request: req }
}

pub fn import(v: &Value) -> Res<ImportResult> {
    let paths = v.get("paths").and_then(Value::as_object).ok_or("This OpenAPI document has no \"paths\"")?;
    let mut vars = Vars(Vec::new());
    vars.add("baseUrl", &base_url(v), false);
    let schemes = schemes(v);

    let mut requests = Vec::new();
    for (path, item) in paths {
        let item = deref(v, item);
        let common: Vec<Value> = item.get("parameters").and_then(Value::as_array).cloned().unwrap_or_default();
        for method in METHODS {
            if let Some(op) = item.get(method) {
                requests.push(operation(v, path, method, op, &common, &mut vars, &schemes));
            }
        }
    }
    if requests.is_empty() {
        return Err("The OpenAPI document defines no operations".into());
    }
    Ok(ImportResult {
        source: "openapi".into(),
        name: s(&v["info"]["title"]),
        requests,
        variables: vars.0,
        warnings: Vec::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const SPEC: &str = r##"{
      "openapi": "3.0.3", "info": { "title": "Pets" },
      "servers": [{ "url": "https://{env}.pets.test/v1", "variables": { "env": { "default": "api" } } }],
      "security": [{ "bearer": [] }],
      "components": {
        "securitySchemes": { "bearer": { "type": "http", "scheme": "bearer" }, "key": { "type": "apiKey", "in": "header", "name": "X-Key" } },
        "schemas": { "Pet": { "type": "object", "properties": {
            "name": { "type": "string", "example": "Rex" }, "age": { "type": "integer" },
            "tags": { "type": "array", "items": { "type": "string" } }, "owner": { "$ref": "#/components/schemas/Owner" } } },
          "Owner": { "type": "object", "properties": { "pet": { "$ref": "#/components/schemas/Pet" }, "id": { "type": "integer" } } } }
      },
      "paths": {
        "/pets/{petId}": {
          "parameters": [{ "name": "petId", "in": "path", "required": true, "schema": { "type": "integer" }, "example": 7 }],
          "get": { "tags": ["pets"], "summary": "Get a pet", "parameters": [{ "name": "verbose", "in": "query", "required": true, "schema": { "type": "boolean" } }, { "name": "skip", "in": "query", "schema": { "type": "string" } }] },
          "put": { "tags": ["pets"], "operationId": "updatePet", "security": [{ "key": [] }],
                   "requestBody": { "content": { "application/json": { "schema": { "$ref": "#/components/schemas/Pet" } } } } }
        },
        "/login": { "post": { "security": [],
          "requestBody": { "content": { "application/x-www-form-urlencoded": { "schema": { "type": "object", "properties": { "user": { "type": "string", "example": "a b" } } } } } } } }
      }
    }"##;

    #[test]
    fn imports_operations_params_bodies_and_security() {
        let r = import(&serde_json::from_str(SPEC).unwrap()).unwrap();
        assert_eq!(r.name, "Pets");
        assert_eq!(r.requests.len(), 3);
        assert_eq!(r.variables[0].name, "baseUrl");
        assert_eq!(r.variables[0].value, "https://api.pets.test/v1");

        let get = &r.requests[0];
        assert_eq!(get.folder, "pets");
        assert_eq!(get.request.name, "Get a pet");
        assert_eq!(get.request.url, "{{baseUrl}}/pets/{{petId}}?verbose={{verbose}}");
        assert_eq!(get.request.headers[0].value, "Bearer {{token}}");
        assert!(r.variables.iter().any(|v| v.name == "petId" && v.value == "7"));
        assert!(r.variables.iter().any(|v| v.name == "token" && v.secret));

        let put = &r.requests[1].request;
        assert_eq!(put.name, "updatePet");
        assert_eq!(put.headers[0].name, "X-Key");
        let body: Value = serde_json::from_str(put.body.as_deref().unwrap()).unwrap();
        assert_eq!(body["name"], "Rex");
        assert_eq!(body["tags"], serde_json::json!(["string"]));
        assert!(body["owner"].is_object(), "recursive $ref must terminate");

        let login = &r.requests[2];
        assert_eq!(login.folder, "login");
        assert_eq!(login.request.name, "POST /login");
        assert_eq!(login.request.body.as_deref(), Some("user=a%20b"));
        assert!(login.request.headers.iter().all(|h| h.name != "Authorization"), "security: [] disables auth");
    }

    #[test]
    fn swagger_two_uses_host_and_body_parameter() {
        let r = import(
            &serde_json::from_str(
                r#"{ "swagger": "2.0", "host": "h.test", "basePath": "/api", "schemes": ["http"], "info": { "title": "S" },
                  "paths": { "/x": { "post": { "parameters": [{ "in": "body", "name": "b", "schema": { "type": "object", "properties": { "n": { "type": "integer" } } } }] } } } }"#,
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(r.variables[0].value, "http://h.test/api");
        assert_eq!(r.requests[0].request.body.as_deref(), Some("{\n  \"n\": 0\n}"));
    }
}

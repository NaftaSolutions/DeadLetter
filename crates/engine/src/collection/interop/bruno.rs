//! Bruno collections: a folder of `.bru` files (plus `bruno.json`, `collection.bru`,
//! `environments/*.bru`). The format is block based:
//!
//! ```text
//! get {
//!   url: {{baseUrl}}/users
//!   body: none
//!   auth: bearer
//! }
//! headers {
//!   Accept: application/json
//!   ~X-Disabled: 1
//! }
//! ```

use std::fs;
use std::path::Path;

use serde_json::{Map, Value};

use crate::collection::environment::{EnvVariable, Environment};
use crate::collection::model::{RequestFile, RequestHeader};

use super::util::{
    append_query, basic, bearer, default_header, form_body, header, name_from_url, set_multipart, FORM_CONTENT_TYPE,
    JSON_CONTENT_TYPE,
};
use super::{ImportResult, ImportedRequest};

type Res<T> = Result<T, String>;

const MAX_DEPTH: usize = 12;
const MAX_FILES: usize = 5000;
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
const METHODS: [&str; 9] = ["get", "post", "put", "delete", "patch", "options", "head", "connect", "trace"];

struct Block {
    name: String,
    lines: Vec<String>,
}

/// Splits a .bru file into its top-level blocks; content lines lose their two-space indent.
fn parse_blocks(text: &str) -> Vec<Block> {
    let mut blocks = Vec::new();
    let mut current: Option<Block> = None;
    for raw in text.trim_start_matches('\u{feff}').lines() {
        let line = raw.trim_end_matches('\r');
        match current.as_mut() {
            Some(block) => {
                if line == "}" || line == "]" {
                    blocks.extend(current.take());
                } else {
                    block.lines.push(line.strip_prefix("  ").unwrap_or(line).to_string());
                }
            }
            None => {
                let t = line.trim_end();
                if !line.starts_with(char::is_whitespace) && (t.ends_with('{') || t.ends_with('[')) {
                    let name = t[..t.len() - 1].trim().to_string();
                    if !name.is_empty() {
                        current = Some(Block { name, lines: Vec::new() });
                    }
                }
            }
        }
    }
    blocks
}

/// `key: value` entries; a leading `~` marks a disabled entry. Returns (key, value, enabled).
fn entries(block: &Block) -> Vec<(String, String, bool)> {
    block
        .lines
        .iter()
        .filter_map(|l| {
            let l = l.trim();
            if l.is_empty() {
                return None;
            }
            let (enabled, l) = match l.strip_prefix('~') {
                Some(rest) => (false, rest.trim_start()),
                None => (true, l),
            };
            let (k, v) = l.split_once(':').map_or((l, ""), |(k, v)| (k, v));
            Some((k.trim().to_string(), v.trim().to_string(), enabled))
        })
        .collect()
}

fn text_of(block: &Block) -> String {
    block.lines.join("\n").trim_matches('\n').to_string()
}

fn find<'a>(blocks: &'a [Block], name: &str) -> Option<&'a Block> {
    blocks.iter().find(|b| b.name == name)
}

fn value_in(blocks: &[Block], block: &str, key: &str) -> String {
    find(blocks, block)
        .map(entries)
        .and_then(|e| e.into_iter().find(|(k, _, on)| k == key && *on).map(|(_, v, _)| v))
        .unwrap_or_default()
}

fn apply_auth(blocks: &[Block], mode: &str, req: &mut RequestFile, warnings: &mut Vec<String>) {
    match mode {
        "bearer" => req.headers.insert(0, header("Authorization", &bearer(&value_in(blocks, "auth:bearer", "token")))),
        "basic" => req.headers.insert(
            0,
            header("Authorization", &basic(&value_in(blocks, "auth:basic", "username"), &value_in(blocks, "auth:basic", "password"))),
        ),
        "apikey" => {
            let (key, value) = (value_in(blocks, "auth:apikey", "key"), value_in(blocks, "auth:apikey", "value"));
            if value_in(blocks, "auth:apikey", "placement").contains("query") {
                req.url = append_query(&req.url, &[(key, value)]);
            } else {
                req.headers.insert(0, header(&key, &value));
            }
        }
        "" | "none" | "inherit" => {}
        other => warnings.push(format!("Auth mode \"{other}\" on \"{}\" was not imported", req.name)),
    }
}

struct Parsed {
    request: RequestFile,
    seq: i64,
    scripts: bool,
}

fn parse_request(text: &str, collection: &[Block], warnings: &mut Vec<String>) -> Res<Parsed> {
    let blocks = parse_blocks(text);
    let (method, http) = blocks
        .iter()
        .find_map(|b| METHODS.contains(&b.name.as_str()).then(|| (b.name.clone(), b)))
        .ok_or("No request block (get/post/...) found")?;
    let http = entries(http);
    let get = |k: &str| http.iter().find(|(key, _, _)| key == k).map(|(_, v, _)| v.clone()).unwrap_or_default();

    let meta = find(&blocks, "meta").map(entries).unwrap_or_default();
    let meta_of = |k: &str| meta.iter().find(|(key, _, _)| key == k).map(|(_, v, _)| v.clone()).unwrap_or_default();

    let mut req = RequestFile { name: meta_of("name"), method: method.to_ascii_uppercase(), url: get("url"), headers: Vec::new(), body: None };

    // Path parameters (`/users/:id`) take their value when one is set.
    if let Some(params) = find(&blocks, "params:path") {
        for (k, v, _) in entries(params).into_iter().filter(|(_, v, _)| !v.is_empty()) {
            req.url = req.url.replace(&format!(":{k}"), &v);
        }
    }
    // Bruno repeats the URL's query string in `params:query`; only add what the URL lacks.
    if !req.url.contains('?') {
        let pairs: Vec<(String, String)> = find(&blocks, "params:query")
            .map(entries)
            .unwrap_or_default()
            .into_iter()
            .filter(|(_, _, on)| *on)
            .map(|(k, v, _)| (k, v))
            .collect();
        req.url = append_query(&req.url, &pairs);
    }

    // Collection-level headers apply to every request.
    for source in [collection, &blocks[..]] {
        if let Some(h) = find(source, "headers") {
            for (k, v, on) in entries(h) {
                req.headers.push(RequestHeader { name: k, value: v, enabled: on });
            }
        }
    }

    let auth_mode = get("auth");
    if auth_mode == "inherit" {
        let mode = value_in(collection, "auth", "mode");
        apply_auth(collection, &mode, &mut req, warnings);
    } else {
        apply_auth(&blocks, &auth_mode, &mut req, warnings);
    }

    match get("body").as_str() {
        "json" => {
            req.body = find(&blocks, "body:json").map(text_of).filter(|t| !t.is_empty());
            default_header(&mut req, "Content-Type", JSON_CONTENT_TYPE);
        }
        "text" => {
            req.body = find(&blocks, "body:text").map(text_of).filter(|t| !t.is_empty());
            default_header(&mut req, "Content-Type", "text/plain");
        }
        "xml" => {
            req.body = find(&blocks, "body:xml").map(text_of).filter(|t| !t.is_empty());
            default_header(&mut req, "Content-Type", "application/xml");
        }
        "formUrlEncoded" => {
            let fields: Vec<(String, String)> =
                find(&blocks, "body:form-urlencoded").map(entries).unwrap_or_default().into_iter().filter(|e| e.2).map(|(k, v, _)| (k, v)).collect();
            req.body = Some(form_body(&fields)).filter(|b| !b.is_empty());
            default_header(&mut req, "Content-Type", FORM_CONTENT_TYPE);
        }
        "multipartForm" => {
            let all: Vec<(String, String, bool)> = find(&blocks, "body:multipart-form").map(entries).unwrap_or_default();
            let live: Vec<&(String, String, bool)> = all.iter().filter(|e| e.2).collect();
            let files = live.iter().filter(|e| e.1.starts_with("@file(")).count();
            let fields: Vec<(String, String)> = live.iter().filter(|e| !e.1.starts_with("@file(")).map(|e| (e.0.clone(), e.1.clone())).collect();
            if files > 0 {
                warnings.push(format!("\"{}\": {files} file field(s) were skipped (file uploads are not supported)", req.name));
            }
            if !fields.is_empty() {
                set_multipart(&mut req, &fields);
            }
        }
        "graphql" => {
            let mut env = Map::new();
            env.insert("query".into(), Value::String(find(&blocks, "body:graphql").map(text_of).unwrap_or_default()));
            if let Some(Ok(Value::Object(vars))) = find(&blocks, "body:graphql:vars").map(|b| serde_json::from_str::<Value>(&text_of(b))) {
                env.insert("variables".into(), Value::Object(vars));
            }
            req.body = serde_json::to_string_pretty(&Value::Object(env)).ok();
            default_header(&mut req, "Content-Type", JSON_CONTENT_TYPE);
        }
        _ => {}
    }

    if req.name.trim().is_empty() {
        req.name = name_from_url(&req.url);
    }
    let scripts = blocks.iter().any(|b| matches!(b.name.as_str(), "script:pre-request" | "script:post-response" | "tests" | "assert" | "vars:pre-request" | "vars:post-response"));
    Ok(Parsed { request: req, seq: meta_of("seq").parse().unwrap_or(i64::MAX), scripts })
}

fn parse_environment(name: &str, text: &str) -> Environment {
    let blocks = parse_blocks(text);
    let mut variables: Vec<EnvVariable> = find(&blocks, "vars")
        .map(entries)
        .unwrap_or_default()
        .into_iter()
        .map(|(k, v, on)| EnvVariable { name: k, value: v, enabled: on, secret: false })
        .collect();
    // Secret values are never stored in the file; only their names are.
    if let Some(secret) = find(&blocks, "vars:secret") {
        for n in secret.lines.iter().map(|l| l.trim().trim_end_matches(',').to_string()).filter(|n| !n.is_empty()) {
            variables.push(EnvVariable { name: n, value: String::new(), enabled: true, secret: true });
        }
    }
    Environment { name: name.to_string(), variables }
}

fn read_text(path: &Path) -> Option<String> {
    let meta = fs::metadata(path).ok()?;
    (meta.is_file() && meta.len() <= MAX_FILE_BYTES).then(|| fs::read_to_string(path).ok()).flatten()
}

struct Walk<'a> {
    collection: &'a [Block],
    requests: Vec<(Vec<String>, i64, ImportedRequest)>,
    warnings: Vec<String>,
    scripts: usize,
    files: usize,
}

fn walk(dir: &Path, folder: &[String], depth: usize, w: &mut Walk) {
    if depth > MAX_DEPTH {
        return;
    }
    let Ok(read) = fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = read.flatten().collect();
    entries.sort_by_key(|e| e.file_name().to_string_lossy().to_lowercase());
    for entry in entries {
        let name = entry.file_name().to_string_lossy().into_owned();
        // `file_type` does not follow symlinks, so links can neither loop nor escape the folder.
        let Ok(kind) = entry.file_type() else { continue };
        let path = entry.path();
        if kind.is_dir() {
            if depth == 0 && name == "environments" || name == "node_modules" || name.starts_with('.') {
                continue;
            }
            let mut next = folder.to_vec();
            next.push(name);
            walk(&path, &next, depth + 1, w);
        } else if kind.is_file() && name.ends_with(".bru") && name != "collection.bru" && name != "folder.bru" {
            if w.files >= MAX_FILES {
                return;
            }
            w.files += 1;
            let Some(text) = read_text(&path) else { continue };
            match parse_request(&text, w.collection, &mut w.warnings) {
                Ok(p) => {
                    if p.scripts {
                        w.scripts += 1;
                    }
                    w.requests.push((folder.to_vec(), p.seq, ImportedRequest { folder: folder.join("/"), request: p.request }));
                }
                Err(e) => w.warnings.push(format!("{name} was skipped: {e}")),
            }
        }
    }
}

pub fn is_collection_dir(dir: &Path) -> bool {
    dir.join("bruno.json").is_file()
}

/// Reads a Bruno collection folder.
pub fn import_dir(dir: &Path) -> Res<ImportResult> {
    if !is_collection_dir(dir) {
        return Err("That folder is not a Bruno collection (no bruno.json found)".into());
    }
    let name = read_text(&dir.join("bruno.json"))
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v.get("name").and_then(Value::as_str).map(str::to_string))
        .or_else(|| dir.file_name().map(|n| n.to_string_lossy().into_owned()))
        .unwrap_or_else(|| "Bruno".into());

    let collection = read_text(&dir.join("collection.bru")).map(|t| parse_blocks(&t)).unwrap_or_default();
    let mut w = Walk { collection: &collection, requests: Vec::new(), warnings: Vec::new(), scripts: 0, files: 0 };
    walk(dir, &[], 0, &mut w);
    // Bruno orders requests by `seq` within a folder; keep that order.
    w.requests.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));

    let mut warnings = w.warnings;
    if w.scripts > 0 {
        warnings.push(format!("{} request(s) had scripts, tests, assertions or variable hooks, which are not imported", w.scripts));
    }
    if w.files >= MAX_FILES {
        warnings.push(format!("Only the first {MAX_FILES} requests were imported"));
    }

    let mut environments = Vec::new();
    if let Ok(read) = fs::read_dir(dir.join("environments")) {
        let mut files: Vec<_> = read.flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "bru")).collect();
        files.sort();
        for p in files {
            let stem = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
            if let Some(text) = read_text(&p) {
                environments.push(parse_environment(&format!("{name} - {stem}"), &text));
            }
        }
    }

    let requests: Vec<ImportedRequest> = w.requests.into_iter().map(|(_, _, r)| r).collect();
    if requests.is_empty() && environments.is_empty() {
        return Err("The Bruno collection contains no requests".into());
    }
    Ok(ImportResult { source: "bruno".into(), name, requests, variables: Vec::new(), environments, warnings })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("deadletter-bruno-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn put(dir: &Path, rel: &str, text: &str) {
        let p = dir.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, text).unwrap();
    }

    #[test]
    fn imports_a_collection_folder() {
        let dir = tmp("collection");
        put(&dir, "bruno.json", r#"{ "version": "1", "name": "Shop", "type": "collection" }"#);
        put(&dir, "collection.bru", "headers {\n  X-App: shop\n}\nauth {\n  mode: bearer\n}\nauth:bearer {\n  token: {{token}}\n}\n");
        put(&dir, "Users/list.bru", "meta {\n  name: List users\n  type: http\n  seq: 2\n}\n\nget {\n  url: {{baseUrl}}/users/:id\n  body: none\n  auth: inherit\n}\n\nparams:path {\n  id: 7\n}\n\nparams:query {\n  page: 1\n  ~off: x\n}\n\nheaders {\n  Accept: application/json\n  ~X-Off: 1\n}\n\ntests {\n  test(\"x\", () => {});\n}\n");
        put(&dir, "Users/create.bru", "meta {\n  name: Create\n  seq: 1\n}\n\npost {\n  url: {{baseUrl}}/users\n  body: json\n  auth: basic\n}\n\nauth:basic {\n  username: ada\n  password: pw\n}\n\nbody:json {\n  {\n    \"name\": \"ada\"\n  }\n}\n");
        put(&dir, "form.bru", "meta {\n  name: Form\n}\n\npost {\n  url: http://x/f\n  body: formUrlEncoded\n  auth: none\n}\n\nbody:form-urlencoded {\n  q: a b\n  ~off: 1\n}\n");
        put(&dir, "up.bru", "meta {\n  name: Up\n}\n\npost {\n  url: http://x/up\n  body: multipartForm\n  auth: none\n}\n\nbody:multipart-form {\n  title: hi\n  file: @file(a.png)\n}\n");
        put(&dir, "gql.bru", "meta {\n  name: Gql\n}\n\npost {\n  url: http://x/g\n  body: graphql\n  auth: none\n}\n\nbody:graphql {\n  { me { id } }\n}\n\nbody:graphql:vars {\n  { \"id\": 1 }\n}\n");
        put(&dir, "environments/Prod.bru", "vars {\n  baseUrl: https://shop.test\n  ~off: 1\n}\nvars:secret [\n  token,\n  apiKey\n]\n");
        put(&dir, "node_modules/x.bru", "get {\n  url: http://evil\n}\n");

        let r = import_dir(&dir).unwrap();
        assert_eq!(r.name, "Shop");
        assert_eq!(r.requests.len(), 5);

        // Root requests come before folders; within Users, `seq` decides.
        let names: Vec<&str> = r.requests.iter().map(|x| x.request.name.as_str()).collect();
        assert_eq!(&names[3..], ["Create", "List users"]);

        let list = r.requests.iter().find(|x| x.request.name == "List users").unwrap();
        assert_eq!(list.folder, "Users");
        assert_eq!(list.request.url, "{{baseUrl}}/users/7?page=1");
        let h: Vec<_> = list.request.headers.iter().map(|h| (h.name.as_str(), h.value.as_str(), h.enabled)).collect();
        assert_eq!(h[0], ("Authorization", "Bearer {{token}}", true), "inherited collection auth");
        assert!(h.contains(&("X-App", "shop", true)) && h.contains(&("X-Off", "1", false)));

        let create = &r.requests.iter().find(|x| x.request.name == "Create").unwrap().request;
        assert_eq!(create.headers[0].value, "Basic ada:pw");
        assert_eq!(create.body.as_deref(), Some("{\n  \"name\": \"ada\"\n}"));

        let form = &r.requests.iter().find(|x| x.request.name == "Form").unwrap().request;
        assert_eq!(form.body.as_deref(), Some("q=a%20b"));
        let up = &r.requests.iter().find(|x| x.request.name == "Up").unwrap().request;
        assert!(up.body.as_deref().unwrap().contains("name=\"title\"\n\nhi\n"));
        let gql = &r.requests.iter().find(|x| x.request.name == "Gql").unwrap().request;
        let env: Value = serde_json::from_str(gql.body.as_deref().unwrap()).unwrap();
        assert_eq!(env["variables"]["id"], 1);

        assert!(r.warnings.iter().any(|w| w.contains("file field")));
        assert!(r.warnings.iter().any(|w| w.contains("scripts")));
        let e = &r.environments[0];
        assert_eq!(e.name, "Shop - Prod");
        assert_eq!(e.variables.len(), 4);
        assert!(!e.variables[1].enabled);
        assert!(e.variables[2].secret && e.variables[2].value.is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_other_folders() {
        let dir = tmp("other");
        assert!(import_dir(&dir).unwrap_err().contains("bruno.json"));
        put(&dir, "bruno.json", "{}");
        assert!(import_dir(&dir).unwrap_err().contains("no requests"));
        let _ = fs::remove_dir_all(&dir);
    }
}

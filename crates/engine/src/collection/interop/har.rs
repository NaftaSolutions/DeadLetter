//! HTTP Archive (HAR) exports from browser dev tools: one request per recorded entry.

use serde_json::Value;

use crate::collection::model::{RequestFile, RequestHeader};

use super::util::{default_header, form_body};
use super::{ImportResult, ImportedRequest};

type Res<T> = Result<T, String>;

const MAX_ENTRIES: usize = 5000;
/// Set by the transport or implied by the URL; saving them only causes conflicts when replaying.
const SKIPPED_HEADERS: [&str; 5] = ["host", "content-length", "connection", "accept-encoding", "keep-alive"];

pub fn detect(v: &Value) -> bool {
    v.pointer("/log/entries").is_some_and(Value::is_array)
}

fn s(v: &Value) -> String {
    v.as_str().unwrap_or("").to_string()
}

fn host_and_path(url: &str) -> (String, String) {
    let rest = url.split_once("://").map_or(url, |(_, r)| r);
    let rest = rest.split(['?', '#']).next().unwrap_or("");
    match rest.split_once('/') {
        Some((host, path)) => (host.to_string(), format!("/{path}")),
        None => (rest.to_string(), "/".to_string()),
    }
}

pub fn import(v: &Value) -> Res<ImportResult> {
    let entries = v.pointer("/log/entries").and_then(Value::as_array).ok_or("Not a HAR file")?;
    let mut requests = Vec::new();
    let (mut preflight, mut skipped) = (0usize, 0usize);

    for entry in entries.iter().take(MAX_ENTRIES) {
        let r = &entry["request"];
        let url = s(&r["url"]);
        let method = s(&r["method"]).to_ascii_uppercase();
        if !(url.starts_with("http://") || url.starts_with("https://")) || method.is_empty() {
            skipped += 1;
            continue;
        }
        let is_preflight = method == "OPTIONS"
            && r["headers"].as_array().is_some_and(|hs| hs.iter().any(|h| s(&h["name"]).eq_ignore_ascii_case("access-control-request-method")));
        if is_preflight {
            preflight += 1;
            continue;
        }

        let headers: Vec<RequestHeader> = r["headers"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter(|h| {
                        let n = s(&h["name"]);
                        !n.is_empty() && !n.starts_with(':') && !SKIPPED_HEADERS.contains(&n.to_ascii_lowercase().as_str())
                    })
                    .map(|h| RequestHeader { name: s(&h["name"]), value: s(&h["value"]), enabled: true })
                    .collect()
            })
            .unwrap_or_default();

        let (host, path) = host_and_path(&url);
        let mut req = RequestFile { name: format!("{method} {path}"), method, url, headers, body: None, ..Default::default() };

        let post = &r["postData"];
        let mime = s(&post["mimeType"]).to_ascii_lowercase();
        if let Some(text) = post["text"].as_str().filter(|t| !t.is_empty()) {
            req.body = Some(text.to_string());
        } else if let Some(params) = post["params"].as_array().filter(|p| !p.is_empty()) {
            if mime.starts_with("application/x-www-form-urlencoded") {
                let fields: Vec<(String, String)> = params.iter().map(|p| (s(&p["name"]), s(&p["value"]))).collect();
                req.body = Some(form_body(&fields));
            }
        }
        if req.body.is_some() && !mime.is_empty() {
            default_header(&mut req, "Content-Type", &mime);
        }
        requests.push(ImportedRequest { folder: host, request: req });
    }

    let mut warnings = Vec::new();
    if preflight > 0 {
        warnings.push(format!("{preflight} CORS preflight (OPTIONS) request(s) were skipped"));
    }
    if skipped > 0 {
        warnings.push(format!("{skipped} non-HTTP entr(ies) were skipped"));
    }
    if entries.len() > MAX_ENTRIES {
        warnings.push(format!("Only the first {MAX_ENTRIES} of {} entries were imported", entries.len()));
    }
    if requests.is_empty() {
        return Err("The HAR file contains no HTTP requests".into());
    }
    Ok(ImportResult {
        source: "har".into(),
        name: "HAR import".into(),
        requests,
        variables: Vec::new(),
        environments: Vec::new(),
        warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn imports_entries_without_transport_noise() {
        let v: Value = serde_json::from_str(
            r#"{ "log": { "entries": [
              { "request": { "method": "POST", "url": "https://api.test/v1/login?x=1",
                "headers": [{ "name": ":authority", "value": "api.test" }, { "name": "Host", "value": "api.test" },
                            { "name": "content-length", "value": "9" }, { "name": "Accept", "value": "*/*" }],
                "postData": { "mimeType": "application/json", "text": "{\"a\":1}" } } },
              { "request": { "method": "OPTIONS", "url": "https://api.test/v1/login", "headers": [{ "name": "Access-Control-Request-Method", "value": "POST" }] } },
              { "request": { "method": "POST", "url": "https://api.test/form", "headers": [],
                "postData": { "mimeType": "application/x-www-form-urlencoded", "params": [{ "name": "q", "value": "a b" }] } } },
              { "request": { "method": "GET", "url": "data:text/plain,hi", "headers": [] } }
            ] } }"#,
        )
        .unwrap();
        assert!(detect(&v));
        let r = import(&v).unwrap();
        assert_eq!(r.requests.len(), 2);
        let login = &r.requests[0];
        assert_eq!((login.folder.as_str(), login.request.name.as_str()), ("api.test", "POST /v1/login"));
        assert_eq!(login.request.headers.iter().map(|h| h.name.as_str()).collect::<Vec<_>>(), vec!["Accept", "Content-Type"]);
        assert_eq!(login.request.body.as_deref(), Some("{\"a\":1}"));
        assert_eq!(r.requests[1].request.body.as_deref(), Some("q=a%20b"));
        assert_eq!(r.warnings.len(), 2);
    }
}

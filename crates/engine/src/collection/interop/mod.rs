//! Import and export: cURL, Postman, Insomnia and OpenAPI in; cURL and Postman out.
//! Everything is plain data in, plain data out; the app decides what to write where.

mod bruno;
mod curl;
mod har;
mod hoppscotch;
mod http_file;
mod insomnia;
mod openapi;
mod postman;
mod shell;
mod util;
mod write;

use std::collections::HashMap;

use napi::{Error, Result, Status};
use napi_derive::napi;
use serde_json::Value;

use super::environment::{EnvVariable, Environment};
use super::model::RequestFile;
use crate::http::HeaderEntry;

/// One request found in an import, with the folder it lived in (`/`-separated, may be empty).
#[napi(object)]
#[derive(Debug)]
pub struct ImportedRequest {
    pub folder: String,
    pub request: RequestFile,
}

#[napi(object)]
#[derive(Debug)]
pub struct ImportResult {
    /// `"postman"`, `"insomnia"`, `"openapi"`, `"hoppscotch"`, `"har"`, `"http"` or `"bruno"`.
    pub source: String,
    /// Collection title; used as the name of the folder the requests are written to.
    pub name: String,
    pub requests: Vec<ImportedRequest>,
    /// Collection-level variables, to be saved as one environment named after the collection.
    pub variables: Vec<EnvVariable>,
    /// Named environments found in the source (Postman/Bruno/Insomnia environments).
    pub environments: Vec<Environment>,
    /// Things that could not be imported (scripts, multipart bodies, ...).
    pub warnings: Vec<String>,
}

#[napi(object)]
pub struct ImportSummary {
    /// Workspace-relative folder the requests were written to.
    pub folder: String,
    pub written: u32,
}

fn fail<T>(r: std::result::Result<T, String>) -> Result<T> {
    r.map_err(|msg| Error::new(Status::GenericFailure, msg))
}

const UNRECOGNIZED: &str =
    "Unrecognized file: expected a Postman, Insomnia, OpenAPI/Swagger, Hoppscotch or HAR export, or an .http file";

/// JSON directly, otherwise YAML (OpenAPI specs and Insomnia v5 are usually YAML).
fn document_value(text: &str) -> std::result::Result<Value, String> {
    if text.starts_with('{') || text.starts_with('[') {
        return serde_json::from_str(text).map_err(|e| format!("Invalid JSON: {e}"));
    }
    match serde_norway::from_str::<Value>(text) {
        Ok(v @ Value::Object(_)) => Ok(v),
        Ok(_) => Err(UNRECOGNIZED.into()),
        Err(e) => Err(format!("Invalid YAML: {e}")),
    }
}

/// Recognizes the format of an exported file and parses it.
pub fn parse_document(text: &str) -> std::result::Result<ImportResult, String> {
    let trimmed = text.trim_start_matches('\u{feff}').trim();
    if trimmed.is_empty() {
        return Err("The file is empty".into());
    }
    if !trimmed.starts_with('{') && !trimmed.starts_with('[') {
        if trimmed.starts_with("curl ") || trimmed.starts_with("curl.exe ") {
            return Err("That is a cURL command; paste it into Import from cURL instead.".into());
        }
        if http_file::detect(trimmed) {
            return http_file::import(trimmed);
        }
    }
    let v = document_value(trimmed)?;
    if postman::detect_environment(&v) {
        postman::import_environment(&v)
    } else if postman::detect(&v) {
        postman::import(&v)
    } else if insomnia::detect(&v) {
        insomnia::import(&v)
    } else if insomnia::detect_v5(&v) {
        insomnia::import_v5(&v)
    } else if har::detect(&v) {
        har::import(&v)
    } else if hoppscotch::detect(&v) {
        hoppscotch::import(&v)
    } else if openapi::detect(&v) {
        openapi::import(&v)
    } else {
        Err(UNRECOGNIZED.into())
    }
}

/// Parses a Postman, Insomnia, OpenAPI/Swagger, Hoppscotch or HAR export, or a multi-request .http file.
#[napi]
pub fn parse_import(text: String) -> Result<ImportResult> {
    fail(parse_document(&text))
}

/// Reads a Bruno collection folder (`bruno.json` + `.bru` files + environments).
#[napi]
pub fn parse_bruno(dir: String) -> Result<ImportResult> {
    fail(bruno::import_dir(std::path::Path::new(&dir)))
}

/// Parses a cURL command line into a request.
#[napi]
pub fn parse_curl(command: String) -> Result<RequestFile> {
    fail(curl::parse(&command))
}

/// Renders a request as a cURL command, substituting `variables` where they are known.
#[napi]
pub fn request_to_curl(request: RequestFile, variables: Option<Vec<HeaderEntry>>) -> String {
    let vars: HashMap<String, String> = variables.unwrap_or_default().into_iter().map(|v| (v.name, v.value)).collect();
    curl::to_curl(&request, &vars)
}

/// Writes an import below `dir` of the workspace, in a new folder named after the collection.
/// `format` is `"json"` or `"http"`.
#[napi]
pub fn write_import(root: String, dir: String, result: ImportResult, format: String) -> Result<ImportSummary> {
    fail(write::write_import(&root, &dir, &result, &format))
}

/// The whole workspace as one Postman v2.1 collection (JSON text).
#[napi]
pub fn export_postman(root: String) -> Result<String> {
    fail(write::export_postman(&root))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn openapi_yaml_is_detected_and_imported() {
        let r = parse_document(
            "openapi: 3.0.0\ninfo:\n  title: Pets\nservers:\n  - url: https://pets.test\npaths:\n  /pets/{id}:\n    get:\n      summary: Get\n      parameters:\n        - {name: id, in: path, required: true, schema: {type: integer}}\n",
        )
        .unwrap();
        assert_eq!((r.source.as_str(), r.name.as_str()), ("openapi", "Pets"));
        assert_eq!(r.requests[0].request.url, "{{baseUrl}}/pets/{{id}}");
        assert_eq!(r.variables[0].value, "https://pets.test");
    }

    #[test]
    fn postman_environment_has_no_requests_and_keeps_secrets() {
        let r = parse_document(
            r#"{ "name": "Prod", "_postman_variable_scope": "environment",
                 "values": [{ "key": "host", "value": "h", "enabled": true }, { "key": "token", "value": "t", "type": "secret", "enabled": false }] }"#,
        )
        .unwrap();
        assert!(r.requests.is_empty());
        let env = &r.environments[0];
        assert_eq!(env.name, "Prod");
        assert!(!env.variables[0].secret && env.variables[1].secret && !env.variables[1].enabled);
    }

    #[test]
    fn each_format_is_recognized() {
        let cases: [(&str, &str); 5] = [
            (r#"{"info":{"name":"c","schema":"x/postman"},"item":[]}"#, "postman"),
            (r#"{"_type":"export","resources":[]}"#, "insomnia"),
            ("type: collection.insomnia.rest/5.0\nname: C\ncollection: []\n", "insomnia"),
            (r#"{"log":{"entries":[{"request":{"method":"GET","url":"http://x/","headers":[]}}]}}"#, "har"),
            (r#"[{"name":"c","requests":[{"name":"r","endpoint":"http://x","method":"GET"}],"folders":[]}]"#, "hoppscotch"),
        ];
        for (text, source) in cases {
            assert_eq!(parse_document(text).unwrap().source, source, "{text}");
        }
        assert_eq!(parse_document("GET http://x/a\n\n###\nGET http://x/b\n").unwrap().source, "http");
    }
}

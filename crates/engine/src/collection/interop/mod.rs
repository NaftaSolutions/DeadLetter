//! Import and export: cURL, Postman, Insomnia and OpenAPI in; cURL and Postman out.
//! Everything is plain data in, plain data out; the app decides what to write where.

mod curl;
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

use super::environment::EnvVariable;
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
    /// `"postman"`, `"insomnia"` or `"openapi"`.
    pub source: String,
    /// Collection title; used as the name of the folder the requests are written to.
    pub name: String,
    pub requests: Vec<ImportedRequest>,
    /// Collection/environment variables, to be saved as an environment.
    pub variables: Vec<EnvVariable>,
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

/// Recognizes the format of an exported file and parses it.
pub fn parse_document(text: &str) -> std::result::Result<ImportResult, String> {
    let trimmed = text.trim_start_matches('\u{feff}').trim();
    if !trimmed.starts_with('{') {
        let looks_like_spec = trimmed.contains("openapi:") || trimmed.contains("swagger:");
        return Err(if looks_like_spec {
            "YAML specs are not supported yet. Convert it to JSON first.".into()
        } else if trimmed.starts_with("curl") {
            "That is a cURL command; paste it into Import from cURL instead.".into()
        } else {
            "Unrecognized file: expected a Postman, Insomnia or OpenAPI/Swagger JSON export".into()
        });
    }
    let v: Value = serde_json::from_str(trimmed).map_err(|e| format!("Invalid JSON: {e}"))?;
    if postman::detect(&v) {
        postman::import(&v)
    } else if insomnia::detect(&v) {
        insomnia::import(&v)
    } else if openapi::detect(&v) {
        openapi::import(&v)
    } else {
        Err("Unrecognized file: expected a Postman, Insomnia or OpenAPI/Swagger JSON export".into())
    }
}

/// Parses a Postman v2.x, Insomnia v4 or OpenAPI/Swagger JSON document.
#[napi]
pub fn parse_import(text: String) -> Result<ImportResult> {
    fail(parse_document(&text))
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

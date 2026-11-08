use napi_derive::napi;
use serde::{Deserialize, Serialize};

fn enabled_by_default() -> bool {
    true
}

#[napi(object)]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RequestHeader {
    pub name: String,
    pub value: String,
    #[serde(default = "enabled_by_default")]
    pub enabled: bool,
}

/// A request as stored on disk, independent of the file format it is stored in.
#[napi(object)]
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct RequestFile {
    #[serde(default)]
    pub name: String,
    pub method: String,
    pub url: String,
    #[serde(default)]
    pub headers: Vec<RequestHeader>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    /// Response checks, one per entry, e.g. `status == 200` (see `assert.rs`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub assertions: Vec<String>,
}

/// One entry of the collection tree. The list is flat; `path` is relative to the
/// workspace root and always uses `/` separators.
#[napi(object)]
pub struct TreeNode {
    pub path: String,
    pub name: String,
    /// `"folder"` or `"request"`.
    pub kind: String,
    /// `"json"` or `"http"` for requests.
    pub format: Option<String>,
    pub method: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Format {
    Json,
    Http,
}

impl Format {
    pub fn ext(self) -> &'static str {
        match self {
            Format::Json => "json",
            Format::Http => "http",
        }
    }

    pub fn from_ext(ext: &str) -> Option<Format> {
        match ext.to_ascii_lowercase().as_str() {
            "json" => Some(Format::Json),
            "http" => Some(Format::Http),
            _ => None,
        }
    }

    pub fn from_path(path: &std::path::Path) -> Option<Format> {
        path.extension().and_then(|e| e.to_str()).and_then(Format::from_ext)
    }

    pub fn parse(&self, text: &str) -> Result<RequestFile, String> {
        match self {
            Format::Json => super::json_format::parse(text),
            Format::Http => super::http_format::parse(text),
        }
    }

    pub fn serialize(&self, req: &RequestFile) -> String {
        match self {
            Format::Json => super::json_format::serialize(req),
            Format::Http => super::http_format::serialize(req),
        }
    }
}

mod collection;
mod format;
mod http;
mod multipart;
mod stream;
mod vars;

use napi_derive::napi;

/// Smoke-test binding: proves the Rust -> Node-API -> Electron pipeline works.
#[napi]
pub fn ping() -> String {
    "pong from rust".to_string()
}
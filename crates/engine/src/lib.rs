mod collection;
mod http;
mod vars;

use napi_derive::napi;

/// Smoke-test binding: proves the Rust -> Node-API -> Electron pipeline works.
#[napi]
pub fn ping() -> String {
    "pong from rust".to_string()
}
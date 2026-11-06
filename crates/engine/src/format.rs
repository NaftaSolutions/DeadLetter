//! Payload formatting that would stall the UI thread on large bodies.

use napi::bindgen_prelude::AsyncTask;
use napi::{Env, Task};
use napi_derive::napi;

/// Pretty-prints `text` as JSON (2-space indent). Key order and number
/// representation are kept exactly as received. `None` when it is not valid JSON.
pub fn pretty_json(text: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    serde_json::to_string_pretty(&value).ok()
}

pub struct FormatJson(String);

impl Task for FormatJson {
    type Output = Option<String>;
    type JsValue = Option<String>;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        Ok(pretty_json(&self.0))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

/// Formats JSON on a worker thread; resolves to `null` for invalid JSON.
#[napi(ts_return_type = "Promise<string | null>")]
pub fn format_json(text: String) -> AsyncTask<FormatJson> {
    AsyncTask::new(FormatJson(text))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_key_order_and_big_numbers() {
        let out = pretty_json(r#"{"z":1,"a":12345678901234567890123,"f":1.10}"#).unwrap();
        assert_eq!(out, "{\n  \"z\": 1,\n  \"a\": 12345678901234567890123,\n  \"f\": 1.10\n}");
    }

    #[test]
    fn rejects_non_json() {
        assert!(pretty_json("<html>").is_none());
        assert!(pretty_json("").is_none());
        assert!(pretty_json("{\"a\":").is_none());
    }
}

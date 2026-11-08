//! JSON-RPC 2.0 handling for the subset of MCP this server speaks: lifecycle, `ping`, tools.
//! It is transport-agnostic (one message in, at most one message out) so it can be tested
//! without sockets.

use serde_json::{json, Value};

use super::tools::{self, Context};

const LATEST_VERSION: &str = "2025-06-18";
const SUPPORTED_VERSIONS: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];

const INVALID_REQUEST: i64 = -32600;
const METHOD_NOT_FOUND: i64 = -32601;
const INVALID_PARAMS: i64 = -32602;

pub struct Handler {
    ctx: Context,
}

fn error(id: Value, code: i64, message: impl Into<String>) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message.into() } })
}

fn result(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

impl Handler {
    pub fn new(ctx: Context) -> Handler {
        Handler { ctx }
    }

    /// Handles one JSON-RPC message. Notifications and stray responses produce no reply.
    pub async fn handle(&self, msg: Value) -> Option<Value> {
        let Some(obj) = msg.as_object() else {
            return Some(error(Value::Null, INVALID_REQUEST, "Expected a JSON-RPC request object."));
        };
        let method = obj.get("method").and_then(Value::as_str)?; // no method: a response to nothing we sent
        let id = obj.get("id").cloned()?; // no id: a notification such as notifications/initialized
        let params = obj.get("params").cloned().unwrap_or(Value::Null);

        Some(match method {
            "initialize" => result(id, self.initialize(&params)),
            "ping" => result(id, json!({})),
            "tools/list" => result(id, json!({ "tools": tools::definitions(&self.ctx) })),
            "tools/call" => self.call_tool(id, &params).await,
            other => error(id, METHOD_NOT_FOUND, format!("Method not found: {other}")),
        })
    }

    fn initialize(&self, params: &Value) -> Value {
        let requested = params.get("protocolVersion").and_then(Value::as_str).unwrap_or("");
        let version = SUPPORTED_VERSIONS.iter().find(|v| **v == requested).copied().unwrap_or(LATEST_VERSION);
        json!({
            "protocolVersion": version,
            "capabilities": { "tools": { "listChanged": false } },
            "serverInfo": { "name": "deadletter", "version": env!("CARGO_PKG_VERSION") },
            "instructions": "DeadLetter is a local API client. Use list_requests to find saved requests, \
                get_request to inspect one, and send_request to run it. The user may be asked to approve each send."
        })
    }

    async fn call_tool(&self, id: Value, params: &Value) -> Value {
        let Some(name) = params.get("name").and_then(Value::as_str) else {
            return error(id, INVALID_PARAMS, "tools/call needs a tool `name`.");
        };
        let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
        if !args.is_object() {
            return error(id, INVALID_PARAMS, "`arguments` must be an object.");
        }
        let (text, is_error) = match tools::call(&self.ctx, name, &args).await {
            Ok(value) => (serde_json::to_string_pretty(&value).unwrap_or_default(), false),
            Err(message) => (message, true),
        };
        result(id, json!({ "content": [{ "type": "text", "text": text }], "isError": is_error }))
    }
}

#[cfg(test)]
mod tests {
    use std::future::Future;
    use std::pin::Pin;
    use std::sync::Arc;

    use super::super::tools::Approver;
    use super::*;

    struct Answer(bool);
    impl Approver for Answer {
        fn approve<'a>(&'a self, _: &'a str, _: &'a str) -> Pin<Box<dyn Future<Output = bool> + Send + 'a>> {
            let yes = self.0;
            Box::pin(async move { yes })
        }
    }

    fn handler(root: &str, allow_send: bool, approve: bool) -> Handler {
        Handler::new(Context { root: root.into(), environment: None, approver: Arc::new(Answer(approve)), allow_send })
    }

    fn rpc(id: i64, method: &str, params: Value) -> Value {
        json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
    }

    #[tokio::test]
    async fn initialize_negotiates_a_supported_version() {
        let h = handler(".", true, true);
        let res = h.handle(rpc(1, "initialize", json!({ "protocolVersion": "2025-03-26" }))).await.unwrap();
        assert_eq!(res["result"]["protocolVersion"], "2025-03-26");
        let res = h.handle(rpc(2, "initialize", json!({ "protocolVersion": "1999-01-01" }))).await.unwrap();
        assert_eq!(res["result"]["protocolVersion"], LATEST_VERSION);
        assert_eq!(res["result"]["serverInfo"]["name"], "deadletter");
    }

    #[tokio::test]
    async fn notifications_get_no_reply() {
        let h = handler(".", true, true);
        assert!(h.handle(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).await.is_none());
    }

    #[tokio::test]
    async fn unknown_method_is_a_protocol_error() {
        let res = handler(".", true, true).handle(rpc(7, "resources/list", Value::Null)).await.unwrap();
        assert_eq!(res["id"], 7);
        assert_eq!(res["error"]["code"], METHOD_NOT_FOUND);
    }

    #[tokio::test]
    async fn read_only_mode_hides_send_request() {
        let names = |res: Value| -> Vec<String> {
            res["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap().to_string()).collect()
        };
        let with = names(handler(".", true, true).handle(rpc(1, "tools/list", Value::Null)).await.unwrap());
        let without = names(handler(".", false, true).handle(rpc(1, "tools/list", Value::Null)).await.unwrap());
        assert!(with.contains(&"send_request".to_string()));
        assert!(!without.contains(&"send_request".to_string()));
        let call = rpc(2, "tools/call", json!({ "name": "send_request", "arguments": { "path": "a.http" } }));
        let res = handler(".", false, true).handle(call).await.unwrap();
        assert_eq!(res["result"]["isError"], true);
    }

    #[tokio::test]
    async fn tool_failures_are_tool_errors_not_protocol_errors() {
        let call = rpc(3, "tools/call", json!({ "name": "get_request", "arguments": {} }));
        let res = handler(".", true, true).handle(call).await.unwrap();
        assert!(res.get("error").is_none());
        assert_eq!(res["result"]["isError"], true);
        assert!(res["result"]["content"][0]["text"].as_str().unwrap().contains("path"));
    }

    #[tokio::test]
    async fn rejects_non_object_arguments() {
        let call = rpc(4, "tools/call", json!({ "name": "list_requests", "arguments": [] }));
        let res = handler(".", true, true).handle(call).await.unwrap();
        assert_eq!(res["error"]["code"], INVALID_PARAMS);
    }
}

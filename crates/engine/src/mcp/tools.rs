//! The tools exposed to agents. Deliberately few and task-shaped: browse, inspect, send.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde_json::{json, Value};

use super::redact::{scrub, truncate};
use crate::collection::{environment, store};
use crate::http::{execute_request, HeaderEntry, RequestPayload, ResponsePayload};

const DEFAULT_BODY_CHARS: usize = 8_000;
const MAX_BODY_CHARS: usize = 50_000;
const MAX_LISTED: usize = 500;

/// Asks the user whether an agent may do something with side effects (network traffic).
pub trait Approver: Send + Sync {
    fn approve<'a>(&'a self, tool: &'a str, detail: &'a str) -> Pin<Box<dyn Future<Output = bool> + Send + 'a>>;
}

/// What a tool call may touch. Built by the host from the user's current workspace and settings.
#[derive(Clone)]
pub struct Context {
    pub root: String,
    /// Environment used when a call does not name one.
    pub environment: Option<String>,
    pub approver: Arc<dyn Approver>,
    /// When false, `send_request` is not offered at all (read-only mode).
    pub allow_send: bool,
}

pub fn definitions(ctx: &Context) -> Vec<Value> {
    let mut tools = vec![
        json!({
            "name": "list_requests",
            "description": "List the saved requests and folders in the user's DeadLetter workspace. Returns relative paths (use them with get_request / send_request), names and HTTP methods.",
            "inputSchema": {
                "type": "object",
                "properties": { "folder": { "type": "string", "description": "Only list entries below this folder path. Omit for the whole workspace." } }
            },
            "annotations": { "readOnlyHint": true, "openWorldHint": false }
        }),
        json!({
            "name": "get_request",
            "description": "Read one saved request: method, URL, headers, body and its assertions. {{variables}} are shown unresolved.",
            "inputSchema": {
                "type": "object",
                "properties": { "path": { "type": "string", "description": "Relative path from list_requests." } },
                "required": ["path"]
            },
            "annotations": { "readOnlyHint": true, "openWorldHint": false }
        }),
        json!({
            "name": "list_environments",
            "description": "List environments and their variable names. Values of secret variables are never shown.",
            "inputSchema": { "type": "object", "properties": {} },
            "annotations": { "readOnlyHint": true, "openWorldHint": false }
        }),
    ];
    if ctx.allow_send {
        tools.push(json!({
            "name": "send_request",
            "description": "Send a saved request over the network and return the status, timing, headers, a truncated body and the results of its assertions. The user may be asked to approve the call. Secret values are removed from the output.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Relative path from list_requests." },
                    "environment": { "type": "string", "description": "Environment name from list_environments. Defaults to the one active in the app." },
                    "max_body_chars": { "type": "integer", "minimum": 0, "maximum": MAX_BODY_CHARS, "description": format!("Longest response body to return (default {DEFAULT_BODY_CHARS}).") }
                },
                "required": ["path"]
            },
            "annotations": { "readOnlyHint": false, "destructiveHint": false, "openWorldHint": true }
        }));
    }
    tools
}

/// Runs a tool. `Err` is a message for the agent (reported as a tool error, not a protocol error).
pub async fn call(ctx: &Context, name: &str, args: &Value) -> Result<Value, String> {
    match name {
        "list_requests" => list_requests(ctx, args),
        "get_request" => get_request(ctx, args),
        "list_environments" => list_environments(ctx),
        "send_request" if ctx.allow_send => send_request(ctx, args).await,
        _ => Err(format!("Unknown tool: {name}")),
    }
}

fn str_arg<'a>(args: &'a Value, key: &str) -> Result<&'a str, String> {
    args.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| format!("Missing required string argument `{key}`."))
}

fn list_requests(ctx: &Context, args: &Value) -> Result<Value, String> {
    let folder = args.get("folder").and_then(Value::as_str).map(|f| f.trim_matches('/')).unwrap_or("");
    let nodes = store::list(&ctx.root)?;
    let matching: Vec<_> = nodes
        .into_iter()
        .filter(|n| folder.is_empty() || n.path == folder || n.path.starts_with(&format!("{folder}/")))
        .collect();
    let total = matching.len();
    let entries: Vec<Value> = matching
        .into_iter()
        .take(MAX_LISTED)
        .map(|n| json!({ "path": n.path, "name": n.name, "kind": n.kind, "method": n.method }))
        .collect();
    Ok(json!({ "total": total, "truncated": total > MAX_LISTED, "entries": entries }))
}

fn get_request(ctx: &Context, args: &Value) -> Result<Value, String> {
    let req = store::read_request(&ctx.root, str_arg(args, "path")?)?;
    let headers: Vec<Value> =
        req.headers.iter().map(|h| json!({ "name": h.name, "value": h.value, "enabled": h.enabled })).collect();
    Ok(json!({
        "name": req.name, "method": req.method, "url": req.url,
        "headers": headers, "body": req.body, "assertions": req.assertions,
    }))
}

fn list_environments(ctx: &Context) -> Result<Value, String> {
    let mut out = Vec::new();
    for name in environment::list(&ctx.root)? {
        let Ok(env) = environment::read(&ctx.root, &name) else { continue };
        let vars: Vec<Value> = env
            .variables
            .iter()
            .map(|v| {
                if v.secret {
                    json!({ "name": v.name, "secret": true })
                } else {
                    json!({ "name": v.name, "secret": false, "value": v.value })
                }
            })
            .collect();
        out.push(json!({ "name": env.name, "variables": vars, "active": ctx.environment.as_deref() == Some(env.name.as_str()) }));
    }
    Ok(json!({ "environments": out }))
}

fn copy_response(r: &ResponsePayload) -> ResponsePayload {
    ResponsePayload {
        status: r.status,
        status_text: r.status_text.clone(),
        latency_ms: r.latency_ms,
        headers: r.headers.iter().map(|h| HeaderEntry { name: h.name.clone(), value: h.value.clone() }).collect(),
        body: r.body.clone(),
        size_bytes: r.size_bytes,
    }
}

async fn send_request(ctx: &Context, args: &Value) -> Result<Value, String> {
    let path = str_arg(args, "path")?;
    let max_chars = args
        .get("max_body_chars")
        .and_then(Value::as_u64)
        .map_or(DEFAULT_BODY_CHARS, |n| (n as usize).min(MAX_BODY_CHARS));
    let req = store::read_request(&ctx.root, path)?;

    let env_name = args.get("environment").and_then(Value::as_str).map(str::to_string).or_else(|| ctx.environment.clone());
    let mut variables = Vec::new();
    let mut secrets = Vec::new();
    if let Some(name) = &env_name {
        let env = environment::read(&ctx.root, name)?;
        for v in env.variables.into_iter().filter(|v| v.enabled) {
            if v.secret {
                secrets.push((v.name.clone(), v.value.clone()));
            }
            variables.push(HeaderEntry { name: v.name, value: v.value });
        }
    }

    let detail = format!("{} {}  ({path})", req.method, req.url);
    if !ctx.approver.approve("send_request", &detail).await {
        return Err("The user declined this request. Do not retry it unless they ask you to.".into());
    }

    let payload = RequestPayload {
        method: req.method.clone(),
        url: req.url.clone(),
        headers: req
            .headers
            .iter()
            .filter(|h| h.enabled && !h.name.trim().is_empty())
            .map(|h| HeaderEntry { name: h.name.clone(), value: h.value.clone() })
            .collect(),
        body: req.body.clone(),
    };
    let vars_for_assertions: Vec<HeaderEntry> =
        variables.iter().map(|v| HeaderEntry { name: v.name.clone(), value: v.value.clone() }).collect();
    let res = execute_request(payload, Some(variables), Some(ctx.root.clone()))
        .await
        .map_err(|e| scrub(&e.reason, &secrets))?;

    let results = crate::assert::run_assertions(req.assertions.clone(), copy_response(&res), Some(vars_for_assertions));
    let assertions: Vec<Value> = results
        .iter()
        .map(|a| json!({ "assertion": a.assertion, "passed": a.passed, "message": scrub(&a.message, &secrets) }))
        .collect();

    let headers: Vec<Value> = res
        .headers
        .iter()
        .map(|h| {
            let value = if h.name.eq_ignore_ascii_case("set-cookie") { "[omitted]".to_string() } else { scrub(&h.value, &secrets) };
            json!({ "name": h.name, "value": value })
        })
        .collect();
    let (body, truncated) = truncate(&scrub(&res.body, &secrets), max_chars);

    Ok(json!({
        "status": res.status, "statusText": res.status_text,
        "timeMs": res.latency_ms.round(), "sizeBytes": res.size_bytes,
        "headers": headers, "body": body, "bodyTruncated": truncated,
        "assertions": assertions,
        "assertionsPassed": results.iter().all(|a| a.passed),
    }))
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    use super::*;

    struct Answer(bool);
    impl Approver for Answer {
        fn approve<'a>(&'a self, _: &'a str, _: &'a str) -> Pin<Box<dyn Future<Output = bool> + Send + 'a>> {
            let yes = self.0;
            Box::pin(async move { yes })
        }
    }

    fn ctx(root: &std::path::Path, approve: bool) -> Context {
        Context {
            root: root.to_string_lossy().into_owned(),
            environment: Some("dev".into()),
            approver: Arc::new(Answer(approve)),
            allow_send: true,
        }
    }

    /// Serves one canned response that echoes a secret, then exits.
    async fn echo_server(body: &'static str) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 4096];
            let _ = sock.read(&mut buf).await;
            let reply = format!(
                "HTTP/1.1 200 OK\r\ncontent-length: {}\r\nset-cookie: sid=abc\r\nx-echo: {body}\r\n\r\n{body}",
                body.len()
            );
            let _ = sock.write_all(reply.as_bytes()).await;
        });
        port
    }

    fn workspace(port: u16) -> tempdir::Guard {
        let dir = tempdir::Guard::new();
        fs::write(
            dir.path().join("ping.http"),
            format!("### Ping\nGET http://127.0.0.1:{port}/?k={{{{apiKey}}}}\nAuthorization: Bearer {{{{apiKey}}}}\n"),
        )
        .unwrap();
        let envs = dir.path().join(".deadletter/environments");
        fs::create_dir_all(&envs).unwrap();
        fs::write(
            envs.join("dev.json"),
            r#"{"name":"dev","variables":[{"name":"apiKey","value":"","enabled":true,"secret":true},{"name":"host","value":"example.test","enabled":true,"secret":false}]}"#,
        )
        .unwrap();
        fs::write(envs.join("dev.secrets.json"), r#"{"apiKey":"s3cr3t-value"}"#).unwrap();
        dir
    }

    /// Minimal scoped temp dir so the tests need no extra crate.
    mod tempdir {
        pub struct Guard(std::path::PathBuf);
        impl Guard {
            pub fn new() -> Guard {
                static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
                let n = N.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let p = std::env::temp_dir().join(format!("deadletter-mcp-{}-{n}", std::process::id()));
                std::fs::create_dir_all(&p).unwrap();
                Guard(p)
            }
            pub fn path(&self) -> &std::path::Path {
                &self.0
            }
        }
        impl Drop for Guard {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
    }

    #[tokio::test]
    async fn lists_and_reads_requests() {
        let dir = workspace(1);
        let c = ctx(dir.path(), true);
        let list = call(&c, "list_requests", &json!({})).await.unwrap();
        assert_eq!(list["entries"][0]["path"], "ping.http");
        let req = call(&c, "get_request", &json!({ "path": "ping.http" })).await.unwrap();
        assert_eq!(req["method"], "GET");
        assert!(req["url"].as_str().unwrap().contains("{{apiKey}}"));
    }

    #[tokio::test]
    async fn get_request_cannot_escape_the_workspace() {
        let dir = workspace(1);
        let err = call(&ctx(dir.path(), true), "get_request", &json!({ "path": "../../etc/passwd" })).await.unwrap_err();
        assert!(!err.is_empty());
    }

    #[tokio::test]
    async fn environment_listing_hides_secret_values() {
        let dir = workspace(1);
        let out = call(&ctx(dir.path(), true), "list_environments", &json!({})).await.unwrap().to_string();
        assert!(out.contains("apiKey") && out.contains("example.test"));
        assert!(!out.contains("s3cr3t-value"));
    }

    #[tokio::test]
    async fn send_request_scrubs_secrets_from_the_response() {
        let port = echo_server("key=s3cr3t-value").await;
        let dir = workspace(port);
        let out = call(&ctx(dir.path(), true), "send_request", &json!({ "path": "ping.http" })).await.unwrap();
        let text = out.to_string();
        assert_eq!(out["status"], 200);
        assert!(!text.contains("s3cr3t-value"), "secret leaked: {text}");
        assert_eq!(out["body"], "key=[secret:apiKey]");
        assert!(text.contains("[omitted]"), "set-cookie should be omitted");
    }

    #[tokio::test]
    async fn declined_sends_never_touch_the_network() {
        // Nothing is listening on port 1; a declined call must fail with the decline message, not a connect error.
        let dir = workspace(1);
        let err = call(&ctx(dir.path(), false), "send_request", &json!({ "path": "ping.http" })).await.unwrap_err();
        assert!(err.contains("declined"), "{err}");
    }

    #[tokio::test]
    async fn long_bodies_are_truncated() {
        let port = echo_server("0123456789").await;
        let dir = workspace(port);
        let out = call(&ctx(dir.path(), true), "send_request", &json!({ "path": "ping.http", "max_body_chars": 4 })).await.unwrap();
        assert_eq!(out["body"], "0123");
        assert_eq!(out["bodyTruncated"], true);
    }
}

//! Streamable-HTTP transport for the MCP handler, bound to the loopback interface only.
//!
//! Every request must pass, in order: a `Host` check (blocks DNS rebinding), an `Origin` check
//! (browsers always send one, native MCP clients never do, so any `Origin` is refused) and a
//! bearer token. Only `POST /mcp` is served; there are no sessions and no server-initiated streams.

use std::collections::HashMap;
use std::convert::Infallible;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use http_body_util::{BodyExt, Full, Limited};
use hyper::body::{Bytes, Incoming};
use hyper::{header, Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio::sync::{oneshot, watch};

use super::protocol::Handler;
use super::tools::{Approver, Context};

const MAX_BODY: usize = 1024 * 1024;
const APPROVAL_TIMEOUT: Duration = Duration::from_secs(120);
const DETAIL_CHARS: usize = 200;

/// What the user has allowed agents to do.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// `send_request` needs the user's approval (the default).
    Ask,
    /// `send_request` runs without asking.
    Always,
    /// `send_request` is not offered.
    ReadOnly,
}

impl Mode {
    pub fn parse(s: &str) -> Mode {
        match s {
            "always" => Mode::Always,
            "readonly" => Mode::ReadOnly,
            _ => Mode::Ask,
        }
    }
}

/// Settings that can change while the server runs.
#[derive(Clone)]
pub struct Live {
    pub root: String,
    pub environment: Option<String>,
    pub mode: Mode,
}

/// Something the UI should show. `kind` is `call` (a finished tool call, for the activity log),
/// `approval` (needs an answer), or `approval-expired` (stop asking about `id`).
pub struct Event {
    pub kind: &'static str,
    pub id: Option<u32>,
    pub tool: Option<String>,
    pub detail: Option<String>,
    /// For `call`: `ok` or `error`.
    pub outcome: Option<&'static str>,
    pub ms: Option<f64>,
    /// Unix time in milliseconds.
    pub at: f64,
}

impl Event {
    fn new(kind: &'static str) -> Event {
        let at = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0.0, |d| d.as_secs_f64() * 1000.0);
        Event { kind, id: None, tool: None, detail: None, outcome: None, ms: None, at }
    }
}

pub struct State {
    token: String,
    port: u16,
    live: Mutex<Live>,
    pending: Mutex<HashMap<u32, oneshot::Sender<bool>>>,
    session_allowed: AtomicBool,
    next_id: AtomicU32,
    emit: Box<dyn Fn(Event) + Send + Sync>,
}

impl State {
    pub fn new(token: String, port: u16, live: Live, emit: Box<dyn Fn(Event) + Send + Sync>) -> Arc<State> {
        Arc::new(State {
            token,
            port,
            live: Mutex::new(live),
            pending: Mutex::new(HashMap::new()),
            session_allowed: AtomicBool::new(false),
            next_id: AtomicU32::new(0),
            emit,
        })
    }

    pub fn update(&self, live: Live) {
        *self.live.lock().unwrap_or_else(|p| p.into_inner()) = live;
    }

    fn live(&self) -> Live {
        self.live.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    fn pending<R>(&self, f: impl FnOnce(&mut HashMap<u32, oneshot::Sender<bool>>) -> R) -> R {
        f(&mut self.pending.lock().unwrap_or_else(|p| p.into_inner()))
    }

    /// The user's answer to an `approval` event. `remember` allows every later send until the
    /// server is stopped.
    pub fn answer(&self, id: u32, allow: bool, remember: bool) {
        if let Some(tx) = self.pending(|p| p.remove(&id)) {
            if allow && remember {
                self.session_allowed.store(true, Ordering::SeqCst);
            }
            let _ = tx.send(allow);
        }
    }

    /// Declines everything still waiting (the server is stopping).
    pub fn cancel_pending(&self) {
        let ids: Vec<u32> = self.pending(|p| p.drain().map(|(id, _)| id).collect());
        for id in ids {
            let mut e = Event::new("approval-expired");
            e.id = Some(id);
            (self.emit)(e);
        }
    }
}

struct AskUser(Arc<State>);

/// Tells the UI to drop a prompt that nobody can answer any more (timeout, client hung up).
struct ExpireGuard<'a> {
    state: &'a State,
    id: u32,
}

impl Drop for ExpireGuard<'_> {
    fn drop(&mut self) {
        if self.state.pending(|p| p.remove(&self.id)).is_some() {
            let mut e = Event::new("approval-expired");
            e.id = Some(self.id);
            (self.state.emit)(e);
        }
    }
}

impl Approver for AskUser {
    fn approve<'a>(&'a self, tool: &'a str, detail: &'a str) -> Pin<Box<dyn Future<Output = bool> + Send + 'a>> {
        Box::pin(async move {
            let state = &*self.0;
            if state.live().mode == Mode::Always || state.session_allowed.load(Ordering::SeqCst) {
                return true;
            }
            let id = state.next_id.fetch_add(1, Ordering::SeqCst) + 1;
            let (tx, rx) = oneshot::channel();
            state.pending(|p| p.insert(id, tx));
            let _guard = ExpireGuard { state, id };
            let mut e = Event::new("approval");
            e.id = Some(id);
            e.tool = Some(tool.to_string());
            e.detail = Some(detail.to_string());
            (state.emit)(e);
            matches!(tokio::time::timeout(APPROVAL_TIMEOUT, rx).await, Ok(Ok(true)))
        })
    }
}

fn reply(status: StatusCode, body: impl Into<Bytes>) -> Response<Full<Bytes>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Full::new(body.into()))
        .expect("static response parts are valid")
}

fn rpc_error(status: StatusCode, code: i64, message: &str) -> Response<Full<Bytes>> {
    reply(status, json!({ "jsonrpc": "2.0", "id": null, "error": { "code": code, "message": message } }).to_string())
}

fn plain(status: StatusCode, message: &str) -> Response<Full<Bytes>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain")
        .body(Full::new(Bytes::from(message.to_string())))
        .expect("static response parts are valid")
}

/// Compares in time independent of where the first difference is.
fn tokens_match(given: &str, expected: &str) -> bool {
    let (a, b) = (given.as_bytes(), expected.as_bytes());
    let mut diff = a.len() ^ b.len();
    for i in 0..a.len().max(b.len()) {
        diff |= (a.get(i).copied().unwrap_or(0) ^ b.get(i).copied().unwrap_or(0)) as usize;
    }
    diff == 0
}

fn short(text: &str) -> String {
    super::redact::truncate(text, DETAIL_CHARS).0
}

/// Checks the headers; `Some` is the refusal to send back.
fn refuse(state: &State, req: &Request<Incoming>) -> Option<Response<Full<Bytes>>> {
    let host = req.headers().get(header::HOST).and_then(|h| h.to_str().ok()).unwrap_or("").to_ascii_lowercase();
    if host != format!("127.0.0.1:{}", state.port) && host != format!("localhost:{}", state.port) {
        return Some(plain(StatusCode::FORBIDDEN, "Unexpected Host header."));
    }
    if req.headers().contains_key(header::ORIGIN) {
        return Some(plain(StatusCode::FORBIDDEN, "Browser requests are not accepted."));
    }
    let bearer = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "))
        .unwrap_or("");
    if !tokens_match(bearer, &state.token) {
        let mut res = plain(StatusCode::UNAUTHORIZED, "Missing or wrong bearer token.");
        res.headers_mut().insert(header::WWW_AUTHENTICATE, header::HeaderValue::from_static("Bearer"));
        return Some(res);
    }
    None
}

async fn route(state: Arc<State>, req: Request<Incoming>) -> Response<Full<Bytes>> {
    if let Some(refusal) = refuse(&state, &req) {
        return refusal;
    }
    if req.uri().path() != "/mcp" {
        return plain(StatusCode::NOT_FOUND, "Not found. The MCP endpoint is /mcp.");
    }
    if req.method() != Method::POST {
        let mut res = plain(StatusCode::METHOD_NOT_ALLOWED, "Only POST is supported.");
        res.headers_mut().insert(header::ALLOW, header::HeaderValue::from_static("POST"));
        return res;
    }

    let Ok(collected) = Limited::new(req.into_body(), MAX_BODY).collect().await else {
        return rpc_error(StatusCode::PAYLOAD_TOO_LARGE, -32600, "Request body too large.");
    };
    let Ok(msg) = serde_json::from_slice::<Value>(&collected.to_bytes()) else {
        return rpc_error(StatusCode::BAD_REQUEST, -32700, "Parse error: body is not valid JSON.");
    };
    if msg.is_array() {
        return rpc_error(StatusCode::BAD_REQUEST, -32600, "JSON-RPC batches are not supported.");
    }

    let live = state.live();
    let call = (msg.get("method").and_then(Value::as_str) == Some("tools/call")).then(|| {
        let params = msg.get("params");
        let tool = params.and_then(|p| p.get("name")).and_then(Value::as_str).unwrap_or("?").to_string();
        let args = params.and_then(|p| p.get("arguments")).map(Value::to_string).unwrap_or_default();
        (tool, short(&args))
    });
    let started = Instant::now();

    let handler = Handler::new(Context {
        root: live.root,
        environment: live.environment,
        approver: Arc::new(AskUser(state.clone())),
        allow_send: live.mode != Mode::ReadOnly,
    });
    let response = handler.handle(msg).await;

    if let (Some((tool, args)), Some(res)) = (call, &response) {
        let failed = res.get("error").is_some() || res["result"]["isError"] == true;
        let mut e = Event::new("call");
        e.tool = Some(tool);
        e.detail = Some(args);
        e.outcome = Some(if failed { "error" } else { "ok" });
        e.ms = Some(started.elapsed().as_secs_f64() * 1000.0);
        (state.emit)(e);
    }

    match response {
        Some(res) => reply(StatusCode::OK, res.to_string()),
        None => Response::builder().status(StatusCode::ACCEPTED).body(Full::new(Bytes::new())).expect("static response"),
    }
}

/// Accepts connections until `stop` flips. Open connections are dropped at the same time.
pub async fn serve(listener: TcpListener, state: Arc<State>, mut stop: watch::Receiver<bool>) {
    loop {
        tokio::select! {
            _ = stop.changed() => break,
            accepted = listener.accept() => {
                let Ok((stream, _)) = accepted else { continue };
                let state = state.clone();
                let mut stop = stop.clone();
                tokio::spawn(async move {
                    let service = hyper::service::service_fn(move |req| {
                        let state = state.clone();
                        async move { Ok::<_, Infallible>(route(state, req).await) }
                    });
                    let conn = hyper::server::conn::http1::Builder::new().serve_connection(TokioIo::new(stream), service);
                    tokio::pin!(conn);
                    tokio::select! {
                        _ = conn.as_mut() => {}
                        _ = stop.changed() => {}
                    }
                });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex as StdMutex;

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;

    use super::*;

    const TOKEN: &str = "test-token-0123456789";

    struct Server {
        port: u16,
        state: Arc<State>,
        events: Arc<StdMutex<Vec<Event>>>,
        _stop: watch::Sender<bool>,
    }

    async fn start(mode: Mode) -> Server {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let events = Arc::new(StdMutex::new(Vec::new()));
        let sink = events.clone();
        let live = Live { root: ".".into(), environment: None, mode };
        let state = State::new(TOKEN.into(), port, live, Box::new(move |e| sink.lock().unwrap().push(e)));
        let (stop, rx) = watch::channel(false);
        tokio::spawn(serve(listener, state.clone(), rx));
        Server { port, state, events, _stop: stop }
    }

    /// Sends a raw HTTP/1.1 request and returns (status, body).
    async fn http(port: u16, method: &str, path: &str, headers: &[(&str, String)], body: &str) -> (u16, String) {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let mut req = format!("{method} {path} HTTP/1.1\r\nconnection: close\r\ncontent-length: {}\r\n", body.len());
        for (k, v) in headers {
            req.push_str(&format!("{k}: {v}\r\n"));
        }
        req.push_str("\r\n");
        req.push_str(body);
        stream.write_all(req.as_bytes()).await.unwrap();
        let mut raw = String::new();
        stream.read_to_string(&mut raw).await.unwrap();
        let status = raw.split_whitespace().nth(1).unwrap().parse().unwrap();
        (status, raw.split_once("\r\n\r\n").map(|(_, b)| b.to_string()).unwrap_or_default())
    }

    fn good(port: u16) -> Vec<(&'static str, String)> {
        vec![("host", format!("127.0.0.1:{port}")), ("authorization", format!("Bearer {TOKEN}"))]
    }

    const INIT: &str = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}"#;

    #[tokio::test]
    async fn serves_authenticated_requests() {
        let s = start(Mode::Ask).await;
        let (status, body) = http(s.port, "POST", "/mcp", &good(s.port), INIT).await;
        assert_eq!(status, 200);
        assert!(body.contains("deadletter"), "{body}");
    }

    #[tokio::test]
    async fn rejects_missing_or_wrong_tokens() {
        let s = start(Mode::Ask).await;
        let host = ("host", format!("127.0.0.1:{}", s.port));
        let (status, _) = http(s.port, "POST", "/mcp", &[host.clone()], INIT).await;
        assert_eq!(status, 401);
        let wrong = ("authorization", "Bearer nope".to_string());
        let (status, _) = http(s.port, "POST", "/mcp", &[host, wrong], INIT).await;
        assert_eq!(status, 401);
    }

    #[tokio::test]
    async fn rejects_foreign_hosts_and_browser_origins() {
        let s = start(Mode::Ask).await;
        let mut rebinding = good(s.port);
        rebinding[0] = ("host", format!("evil.example:{}", s.port));
        assert_eq!(http(s.port, "POST", "/mcp", &rebinding, INIT).await.0, 403);
        let mut browser = good(s.port);
        browser.push(("origin", "https://evil.example".into()));
        assert_eq!(http(s.port, "POST", "/mcp", &browser, INIT).await.0, 403);
    }

    #[tokio::test]
    async fn only_post_to_the_mcp_path() {
        let s = start(Mode::Ask).await;
        assert_eq!(http(s.port, "GET", "/mcp", &good(s.port), "").await.0, 405);
        assert_eq!(http(s.port, "POST", "/other", &good(s.port), INIT).await.0, 404);
    }

    #[tokio::test]
    async fn bad_bodies_get_json_rpc_errors_and_notifications_get_202() {
        let s = start(Mode::Ask).await;
        let (status, body) = http(s.port, "POST", "/mcp", &good(s.port), "{nope").await;
        assert_eq!(status, 400);
        assert!(body.contains("-32700"));
        assert_eq!(http(s.port, "POST", "/mcp", &good(s.port), "[]").await.0, 400);
        let note = r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#;
        assert_eq!(http(s.port, "POST", "/mcp", &good(s.port), note).await.0, 202);
    }

    #[tokio::test]
    async fn tool_calls_are_logged() {
        let s = start(Mode::Ask).await;
        let call = r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_requests","arguments":{}}}"#;
        assert_eq!(http(s.port, "POST", "/mcp", &good(s.port), call).await.0, 200);
        {
            let events = s.events.lock().unwrap();
            let e = events.iter().find(|e| e.kind == "call").expect("a call event");
            assert_eq!(e.tool.as_deref(), Some("list_requests"));
        }

    }

    #[tokio::test]
    async fn answering_an_approval_releases_the_waiting_call() {
        let s = start(Mode::Ask).await;
        let approver = AskUser(s.state.clone());
        let waiting = tokio::spawn(async move { approver.approve("send_request", "GET http://x").await });
        let id = loop {
            if let Some(id) = s.events.lock().unwrap().iter().find(|e| e.kind == "approval").and_then(|e| e.id) {
                break id;
            }
            tokio::task::yield_now().await;
        };
        s.state.answer(id, true, true);
        assert!(waiting.await.unwrap());
        // "Allow for this session" means the next send is not asked about.
        assert!(AskUser(s.state.clone()).approve("send_request", "again").await);
    }

    #[tokio::test]
    async fn declined_and_cancelled_approvals_are_refused() {
        let s = start(Mode::Ask).await;
        let approver = Arc::new(AskUser(s.state.clone()));
        let a = approver.clone();
        let waiting = tokio::spawn(async move { a.approve("send_request", "GET http://x").await });
        let id = loop {
            if let Some(id) = s.events.lock().unwrap().iter().find(|e| e.kind == "approval").and_then(|e| e.id) {
                break id;
            }
            tokio::task::yield_now().await;
        };
        s.state.answer(id, false, false);
        assert!(!waiting.await.unwrap());

        let a = approver.clone();
        let cancelled = tokio::spawn(async move { a.approve("send_request", "GET http://y").await });
        while s.events.lock().unwrap().iter().filter(|e| e.kind == "approval").count() < 2 {
            tokio::task::yield_now().await;
        }
        s.state.cancel_pending();
        assert!(!cancelled.await.unwrap());
        assert!(s.events.lock().unwrap().iter().any(|e| e.kind == "approval-expired"));
    }

    #[test]
    fn token_comparison_checks_length_and_content() {
        assert!(tokens_match("abc", "abc"));
        assert!(!tokens_match("abc", "abd"));
        assert!(!tokens_match("abc", "abcd"));
        assert!(!tokens_match("", "abc"));
    }
}

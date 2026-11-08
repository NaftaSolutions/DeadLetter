//! Embedded MCP (Model Context Protocol) server: lets an AI agent the user has explicitly
//! enabled browse the workspace and run saved requests. Everything here is opt-in; nothing
//! is started unless the user turns the server on.
//!
//! * `protocol` - transport-agnostic JSON-RPC handling (`initialize`, `tools/list`, `tools/call`)
//! * `tools`    - the tools an agent can call
//! * `redact`   - keeps secret environment values and oversized bodies out of tool output
//! * `server`   - loopback HTTP transport with token, Host and Origin checks, and approvals

mod protocol;
mod redact;
mod server;
mod tools;

use std::sync::{Arc, Mutex};

use napi::bindgen_prelude::{spawn, Function};
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::{Error, Result, Status};
use napi_derive::napi;
use tokio::net::TcpListener;
use tokio::sync::watch;

use server::{Event, Live, Mode, State};

#[napi(object)]
pub struct McpOptions {
    /// Loopback port to listen on; `0` picks a free one.
    pub port: u32,
    /// Bearer token clients must send. Generated and persisted by the host.
    pub token: String,
    pub root: String,
    pub environment: Option<String>,
    /// `"ask"` (default), `"always"` or `"readonly"`.
    pub approval: String,
}

#[napi(object)]
pub struct McpEvent {
    /// `call`, `approval` or `approval-expired`.
    pub kind: String,
    pub id: Option<u32>,
    pub tool: Option<String>,
    pub detail: Option<String>,
    /// For `call`: `ok` or `error`.
    pub outcome: Option<String>,
    pub ms: Option<f64>,
    /// Unix time in milliseconds.
    pub at: f64,
}

type Sink = ThreadsafeFunction<McpEvent, (), McpEvent, Status, false, true>;

struct Running {
    state: Arc<State>,
    stop: watch::Sender<bool>,
}

static RUNNING: Mutex<Option<Running>> = Mutex::new(None);

fn running<R>(f: impl FnOnce(&mut Option<Running>) -> R) -> R {
    f(&mut RUNNING.lock().unwrap_or_else(|p| p.into_inner()))
}

fn live(options: &McpOptions) -> Live {
    Live {
        root: options.root.clone(),
        environment: options.environment.clone().filter(|e| !e.is_empty()),
        mode: Mode::parse(&options.approval),
    }
}

fn shut_down(r: Running) {
    r.state.cancel_pending();
    let _ = r.stop.send(true);
}

/// Starts the server (restarting it if it already runs) and returns the port it listens on.
/// Events (finished calls, approval requests) arrive through `on_event`.
#[napi]
pub fn mcp_start(options: McpOptions, on_event: Function<'_, McpEvent, ()>) -> Result<u32> {
    if options.token.len() < 16 {
        return Err(Error::new(Status::InvalidArg, "The MCP token must be at least 16 characters."));
    }
    let port = u16::try_from(options.port).map_err(|_| Error::new(Status::InvalidArg, "Invalid port."))?;
    if let Some(previous) = running(Option::take) {
        shut_down(previous);
    }

    let std_listener = std::net::TcpListener::bind(("127.0.0.1", port)).map_err(|e| {
        Error::new(Status::GenericFailure, format!("Could not listen on 127.0.0.1:{port}: {e}. Pick another port."))
    })?;
    std_listener.set_nonblocking(true).map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?;
    let bound = std_listener.local_addr().map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?.port();

    let sink: Sink = on_event.build_threadsafe_function::<McpEvent>().callee_handled::<false>().weak::<true>().build()?;
    let emit = Box::new(move |e: Event| {
        sink.call(
            McpEvent {
                kind: e.kind.to_string(),
                id: e.id,
                tool: e.tool,
                detail: e.detail,
                outcome: e.outcome.map(str::to_string),
                ms: e.ms,
                at: e.at,
            },
            ThreadsafeFunctionCallMode::NonBlocking,
        );
    });

    let state = State::new(options.token.clone(), bound, live(&options), emit);
    let (stop, stop_rx) = watch::channel(false);
    let serving = state.clone();
    spawn(async move {
        if let Ok(listener) = TcpListener::from_std(std_listener) {
            server::serve(listener, serving, stop_rx).await;
        }
    });
    running(|r| *r = Some(Running { state, stop }));
    Ok(bound as u32)
}

/// Stops the server; a no-op when it is not running.
#[napi]
pub fn mcp_stop() {
    if let Some(r) = running(Option::take) {
        shut_down(r);
    }
}

/// Applies a new workspace, environment or approval mode to the running server. The port and
/// token only change through a restart (`mcp_start`).
#[napi]
pub fn mcp_update(options: McpOptions) {
    running(|r| {
        if let Some(r) = r {
            r.state.update(live(&options));
        }
    });
}

/// Answers an `approval` event. `remember` also allows later sends until the server stops.
#[napi]
pub fn mcp_answer_approval(id: u32, allow: bool, remember: bool) {
    if let Some(state) = running(|r| r.as_ref().map(|r| r.state.clone())) {
        state.answer(id, allow, remember);
    }
}

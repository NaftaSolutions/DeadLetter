//! Long-lived connections (Server-Sent Events and WebSocket). The engine owns the socket and pushes
//! `StreamEvent`s to JavaScript; the UI sends messages and closes by the session id it chose.

mod sse;
mod ws;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use napi::bindgen_prelude::{spawn, Function};
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::{Error, Result, Status};
use napi_derive::napi;
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};

use crate::http::{invalid, resolve, HeaderEntry, RequestPayload};

#[napi(object)]
pub struct StreamEvent {
    /// Session id chosen by the caller.
    pub id: u32,
    /// `open`, `message`, `sent`, `error` or `close`. `error` is always followed by `close`.
    pub kind: String,
    /// Milliseconds since the session was opened.
    pub at_ms: f64,
    pub status: Option<u16>,
    pub status_text: Option<String>,
    pub headers: Option<Vec<HeaderEntry>>,
    /// SSE event name (`message` when the server did not set one).
    pub event: Option<String>,
    /// SSE `id:` field.
    pub event_id: Option<String>,
    /// Message text, error description or close reason.
    pub data: Option<String>,
    pub binary: Option<bool>,
}

type Sink = ThreadsafeFunction<StreamEvent, (), StreamEvent, Status, false, true>;

/// What a running session can be told to do.
pub(crate) enum Command {
    Send(String),
    Close,
}

pub(crate) type Commands = tokio::sync::mpsc::UnboundedReceiver<Command>;

type Registry = HashMap<u32, UnboundedSender<Command>>;

static SESSIONS: Mutex<Option<Registry>> = Mutex::new(None);

fn sessions<R>(f: impl FnOnce(&mut Registry) -> R) -> R {
    let mut guard = SESSIONS.lock().unwrap_or_else(|p| p.into_inner());
    f(guard.get_or_insert_with(HashMap::new))
}

/// Resolves when the caller asked to close, or dropped its handle. Used while connecting, when
/// there is nothing to send to yet.
pub(crate) async fn wait_closed(cmds: &mut Commands) {
    loop {
        match cmds.recv().await {
            Some(Command::Close) | None => return,
            Some(Command::Send(_)) => {}
        }
    }
}

#[derive(Clone)]
pub(crate) struct Emitter {
    id: u32,
    started: Instant,
    sink: Arc<Sink>,
}

impl Emitter {
    fn event(&self, kind: &str) -> StreamEvent {
        StreamEvent {
            id: self.id,
            kind: kind.to_string(),
            at_ms: self.started.elapsed().as_secs_f64() * 1000.0,
            status: None,
            status_text: None,
            headers: None,
            event: None,
            event_id: None,
            data: None,
            binary: None,
        }
    }

    fn emit(&self, event: StreamEvent) {
        self.sink.call(event, ThreadsafeFunctionCallMode::NonBlocking);
    }

    pub(crate) fn open(&self, status: u16, status_text: &str, headers: Vec<HeaderEntry>) {
        let mut e = self.event("open");
        e.status = Some(status);
        e.status_text = Some(status_text.to_string());
        e.headers = Some(headers);
        self.emit(e);
    }

    pub(crate) fn message(
        &self,
        kind: &str,
        data: String,
        event: Option<String>,
        event_id: Option<String>,
        binary: bool,
    ) {
        let mut e = self.event(kind);
        e.data = Some(data);
        e.event = event;
        e.event_id = event_id;
        e.binary = binary.then_some(true);
        self.emit(e);
    }

    pub(crate) fn error(&self, message: String) {
        let mut e = self.event("error");
        e.data = Some(message);
        self.emit(e);
    }

    fn close(&self, reason: String) {
        let mut e = self.event("close");
        e.data = Some(reason);
        self.emit(e);
    }
}

/// Opens a session and returns right away; progress arrives through `on_event`.
/// `kind` is `"sse"` or `"ws"`. Unresolved `{{variables}}` reject here; connection failures are
/// reported as `error` + `close` events.
#[napi]
pub fn open_stream(
    id: u32,
    kind: String,
    req: RequestPayload,
    variables: Option<Vec<HeaderEntry>>,
    on_event: Function<'_, StreamEvent, ()>,
) -> Result<()> {
    if kind != "sse" && kind != "ws" {
        return Err(invalid(format!("Unknown stream kind: {kind}")));
    }
    let variables = variables.unwrap_or_default();
    let vars: HashMap<String, String> = variables.iter().map(|v| (v.name.clone(), v.value.clone())).collect();
    let req = resolve(req, variables)?;
    let sink = on_event.build_threadsafe_function::<StreamEvent>().callee_handled::<false>().weak::<true>().build()?;
    let em = Emitter { id, started: Instant::now(), sink: Arc::new(sink) };

    let (tx, rx) = unbounded_channel();
    if let Some(previous) = sessions(|s| s.insert(id, tx)) {
        let _ = previous.send(Command::Close);
    }

    spawn(async move {
        let outcome = if kind == "sse" { sse::run(&em, req, rx).await } else { ws::run(&em, req, vars, rx).await };
        match outcome {
            Ok(reason) => em.close(reason),
            Err(message) => {
                em.error(message);
                em.close("Connection failed".to_string());
            }
        }
        sessions(|s| s.remove(&id));
    });
    Ok(())
}

/// Sends a text message on an open WebSocket. `{{variables}}` are filled in from the values the
/// session was opened with.
#[napi]
pub fn send_stream_message(id: u32, text: String) -> Result<()> {
    let closed = || Error::new(Status::GenericFailure, "The connection is closed");
    let tx = sessions(|s| s.get(&id).cloned()).ok_or_else(closed)?;
    tx.send(Command::Send(text)).map_err(|_| closed())
}

/// Closes a session; a no-op when it already ended.
#[napi]
pub fn close_stream(id: u32) {
    if let Some(tx) = sessions(|s| s.get(&id).cloned()) {
        let _ = tx.send(Command::Close);
    }
}

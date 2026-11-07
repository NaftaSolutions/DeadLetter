use std::collections::HashMap;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::select;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::{HeaderName, HeaderValue};
use tokio_tungstenite::tungstenite::Message;

use super::{wait_closed, Command, Commands, Emitter};
use crate::http::{HeaderEntry, RequestPayload};
use crate::vars::substitute;

/// Managed by the WebSocket handshake itself; user values would break it.
const RESERVED: [&str; 6] =
    ["host", "upgrade", "connection", "sec-websocket-key", "sec-websocket-version", "content-length"];

pub(crate) async fn run(
    em: &Emitter,
    req: RequestPayload,
    vars: HashMap<String, String>,
    mut cmds: Commands,
) -> Result<String, String> {
    let url = req.url.trim();
    if !url.starts_with("ws://") && !url.starts_with("wss://") {
        return Err(format!("A WebSocket URL must start with ws:// or wss://, got {url}"));
    }
    let mut request = url.into_client_request().map_err(|e| format!("Invalid WebSocket URL: {e}"))?;
    for h in &req.headers {
        let name = h.name.trim();
        if name.is_empty() || RESERVED.contains(&name.to_ascii_lowercase().as_str()) {
            continue;
        }
        let name = HeaderName::from_bytes(name.as_bytes()).map_err(|_| format!("Invalid header name: {name}"))?;
        let value = HeaderValue::from_str(h.value.trim()).map_err(|_| format!("Invalid value for header {name}"))?;
        request.headers_mut().append(name, value);
    }

    let connect = tokio::time::timeout(Duration::from_secs(15), connect_async(request));
    let (mut socket, response) = select! {
        res = connect => res.map_err(|_| "Connection timed out".to_string())?.map_err(|e| format!("Connection failed: {e}"))?,
        _ = wait_closed(&mut cmds) => return Ok("Disconnected".into()),
    };

    let status = response.status();
    let headers = response
        .headers()
        .iter()
        .map(|(k, v)| HeaderEntry { name: k.to_string(), value: String::from_utf8_lossy(v.as_bytes()).into_owned() })
        .collect();
    em.open(status.as_u16(), status.canonical_reason().unwrap_or(""), headers);

    loop {
        select! {
            incoming = socket.next() => match incoming {
                Some(Ok(Message::Text(text))) => em.message("message", text.to_string(), None, None, false),
                Some(Ok(Message::Binary(bytes))) => {
                    em.message("message", format!("<binary, {} bytes>", bytes.len()), None, None, true)
                }
                Some(Ok(Message::Close(frame))) => {
                    return Ok(match frame {
                        Some(f) if !f.reason.is_empty() => {
                            format!("Closed by the server ({}): {}", u16::from(f.code), f.reason)
                        }
                        Some(f) => format!("Closed by the server ({})", u16::from(f.code)),
                        None => "Closed by the server".into(),
                    });
                }
                Some(Ok(_)) => {} // ping/pong are answered by the library
                Some(Err(e)) => return Err(e.to_string()),
                None => return Ok("Connection closed".into()),
            },
            cmd = cmds.recv() => match cmd {
                Some(Command::Send(text)) => {
                    let (text, missing) = substitute(&text, &vars, false);
                    if !missing.is_empty() {
                        let list = missing.iter().map(|m| format!("{{{{{m}}}}}")).collect::<Vec<_>>().join(", ");
                        em.error(format!("Undefined variable: {list}"));
                        continue;
                    }
                    match socket.send(Message::text(text.clone())).await {
                        Ok(()) => em.message("sent", text, None, None, false),
                        Err(e) => return Err(e.to_string()),
                    }
                }
                Some(Command::Close) | None => {
                    let _ = socket.close(None).await;
                    return Ok("Disconnected".into());
                }
            },
        }
    }
}

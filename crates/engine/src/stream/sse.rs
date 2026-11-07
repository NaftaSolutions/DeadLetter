use std::sync::OnceLock;
use std::time::Duration;

use reqwest::Client;
use tokio::select;

use super::{wait_closed, Commands, Emitter};
use crate::http::{build_request, describe, HeaderEntry, RequestPayload};

/// One dispatched Server-Sent Event.
#[derive(Debug, PartialEq)]
pub(crate) struct SseMessage {
    pub event: Option<String>,
    pub id: Option<String>,
    pub data: String,
}

/// Incremental parser for the `text/event-stream` format; chunks may split lines (and UTF-8 sequences).
#[derive(Default)]
pub(crate) struct SseParser {
    buf: Vec<u8>,
    started: bool,
    data: Option<String>,
    event: String,
    id: Option<String>,
}

impl SseParser {
    pub fn push(&mut self, bytes: &[u8]) -> Vec<SseMessage> {
        self.buf.extend_from_slice(bytes);
        if !self.started && self.buf.len() >= 3 {
            self.started = true;
            if self.buf.starts_with(&[0xEF, 0xBB, 0xBF]) {
                self.buf.drain(..3);
            }
        }
        let mut out = Vec::new();
        while let Some(pos) = self.buf.iter().position(|b| *b == b'\n' || *b == b'\r') {
            let mut end = pos + 1;
            if self.buf[pos] == b'\r' {
                // A lone CR at the very end may be the first half of CRLF; wait for more bytes.
                if end == self.buf.len() {
                    break;
                }
                if self.buf[end] == b'\n' {
                    end += 1;
                }
            }
            let line = String::from_utf8_lossy(&self.buf[..pos]).into_owned();
            self.buf.drain(..end);
            if let Some(message) = self.line(&line) {
                out.push(message);
            }
        }
        out
    }

    fn line(&mut self, line: &str) -> Option<SseMessage> {
        if line.is_empty() {
            let data = self.data.take();
            let event = std::mem::take(&mut self.event);
            let id = self.id.take();
            return data.map(|mut data| {
                data.pop(); // trailing newline added after each data line
                SseMessage { event: (!event.is_empty()).then_some(event), id, data }
            });
        }
        if line.starts_with(':') {
            return None;
        }
        let (field, value) = line.split_once(':').unwrap_or((line, ""));
        let value = value.strip_prefix(' ').unwrap_or(value);
        match field {
            "data" => {
                let data = self.data.get_or_insert_with(String::new);
                data.push_str(value);
                data.push('\n');
            }
            "event" => self.event = value.to_string(),
            "id" if !value.contains('\0') => self.id = Some(value.to_string()),
            _ => {}
        }
        None
    }
}

/// Streams must outlive the 60 s request timeout, and compression would make servers buffer events.
fn client() -> Result<&'static Client, String> {
    static CLIENT: OnceLock<Result<Client, String>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            Client::builder()
                .connect_timeout(Duration::from_secs(15))
                .user_agent(concat!("DeadLetter/", env!("CARGO_PKG_VERSION")))
                .no_gzip()
                .no_brotli()
                .no_deflate()
                .build()
                .map_err(|e| e.to_string())
        })
        .as_ref()
        .map_err(Clone::clone)
}

pub(crate) async fn run(em: &Emitter, req: RequestPayload, mut cmds: Commands) -> Result<String, String> {
    let builder = build_request(client()?, req).map_err(|e| e.reason)?;
    let mut res = select! {
        res = builder.send() => res.map_err(|e| describe(e).reason)?,
        _ = wait_closed(&mut cmds) => return Ok("Disconnected".into()),
    };

    let status = res.status();
    let headers: Vec<HeaderEntry> = res
        .headers()
        .iter()
        .map(|(k, v)| HeaderEntry { name: k.to_string(), value: String::from_utf8_lossy(v.as_bytes()).into_owned() })
        .collect();
    let is_sse = headers.iter().any(|h| {
        h.name.eq_ignore_ascii_case("content-type") && h.value.to_ascii_lowercase().contains("text/event-stream")
    });
    em.open(status.as_u16(), status.canonical_reason().unwrap_or(""), headers);

    let mut parser = SseParser::default();
    loop {
        select! {
            chunk = res.chunk() => match chunk.map_err(|e| describe(e).reason)? {
                Some(bytes) if is_sse => {
                    for m in parser.push(&bytes) {
                        em.message("message", m.data, Some(m.event.unwrap_or_else(|| "message".into())), m.id, false);
                    }
                }
                // Not an event stream after all: show the raw chunks instead of hiding them.
                Some(bytes) => {
                    em.message("message", String::from_utf8_lossy(&bytes).into_owned(), Some("chunk".into()), None, false)
                }
                None => return Ok("Stream ended by the server".into()),
            },
            _ = wait_closed(&mut cmds) => return Ok("Disconnected".into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(event: Option<&str>, id: Option<&str>, data: &str) -> SseMessage {
        SseMessage { event: event.map(Into::into), id: id.map(Into::into), data: data.into() }
    }

    #[test]
    fn parses_fields_comments_and_multiline_data() {
        let mut p = SseParser::default();
        let out = p.push(b": hi\nevent: tick\nid: 7\ndata: a\ndata: b\n\ndata:x\n\n");
        assert_eq!(out, vec![msg(Some("tick"), Some("7"), "a\nb"), msg(None, None, "x")]);
    }

    #[test]
    fn handles_lines_split_across_chunks_and_crlf() {
        let mut p = SseParser::default();
        assert!(p.push(b"data: hel").is_empty());
        assert!(p.push(b"lo\r").is_empty());
        assert_eq!(p.push(b"\n\r\n"), vec![msg(None, None, "hello")]);
        // multi-byte character split between chunks
        let bytes = "data: é\n\n".as_bytes();
        assert!(p.push(&bytes[..7]).is_empty());
        assert_eq!(p.push(&bytes[7..]), vec![msg(None, None, "é")]);
    }

    #[test]
    fn skips_bom_and_events_without_data() {
        let mut p = SseParser::default();
        let out = p.push(b"\xEF\xBB\xBFevent: ping\n\ndata\n\n");
        assert_eq!(out, vec![msg(None, None, "")]);
    }
}

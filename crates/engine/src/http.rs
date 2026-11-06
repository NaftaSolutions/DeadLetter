use std::sync::OnceLock;
use std::time::{Duration, Instant};

use napi::{Error, Result, Status};
use napi_derive::napi;
use reqwest::{header::{HeaderName, HeaderValue}, Client, Method};

#[napi(object)]
pub struct HeaderEntry {
    pub name: String,
    pub value: String,
}

#[napi(object)]
pub struct RequestPayload {
    pub method: String,
    pub url: String,
    pub headers: Vec<HeaderEntry>,
    pub body: Option<String>,
}

#[napi(object)]
pub struct ResponsePayload {
    pub status: u16,
    pub status_text: String,
    /// Wall-clock time from send until the full body was received.
    pub latency_ms: f64,
    pub headers: Vec<HeaderEntry>,
    pub body: String,
    pub size_bytes: u32,
}

fn client() -> Result<&'static Client> {
    static CLIENT: OnceLock<std::result::Result<Client, String>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            Client::builder()
                .timeout(Duration::from_secs(60))
                .user_agent(concat!("DeadLetter/", env!("CARGO_PKG_VERSION")))
                .build()
                .map_err(|e| e.to_string())
        })
        .as_ref()
        .map_err(|e| Error::new(Status::GenericFailure, e.clone()))
}

fn invalid(msg: String) -> Error {
    Error::new(Status::InvalidArg, msg)
}

/// Executes an HTTP request on the Rust side; the returned Promise rejects with a
/// readable message on invalid input or network failure (non-2xx is NOT an error).
#[napi]
pub async fn execute_request(req: RequestPayload) -> Result<ResponsePayload> {
    let method = Method::from_bytes(req.method.trim().to_uppercase().as_bytes())
        .map_err(|_| invalid(format!("Invalid HTTP method: {}", req.method)))?;

    let mut builder = client()?.request(method, req.url.trim());
    for h in &req.headers {
        let name = h.name.trim();
        if name.is_empty() {
            continue;
        }
        let name = HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| invalid(format!("Invalid header name: {name}")))?;
        let value = HeaderValue::from_str(h.value.trim())
            .map_err(|_| invalid(format!("Invalid value for header {name}")))?;
        builder = builder.header(name, value);
    }
    if let Some(body) = req.body.filter(|b| !b.is_empty()) {
        builder = builder.body(body);
    }

    let started = Instant::now();
    let res = builder.send().await.map_err(describe)?;

    let status = res.status();
    let headers = res
        .headers()
        .iter()
        .map(|(k, v)| HeaderEntry {
            name: k.to_string(),
            value: String::from_utf8_lossy(v.as_bytes()).into_owned(),
        })
        .collect();
    let bytes = res.bytes().await.map_err(describe)?;
    let latency_ms = started.elapsed().as_secs_f64() * 1000.0;

    Ok(ResponsePayload {
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or("").to_string(),
        latency_ms,
        headers,
        size_bytes: bytes.len() as u32,
        body: String::from_utf8_lossy(&bytes).into_owned(),
    })
}

fn describe(e: reqwest::Error) -> Error {
    let kind = if e.is_timeout() {
        "Request timed out"
    } else if e.is_connect() {
        "Connection failed"
    } else if e.is_builder() {
        "Invalid request"
    } else {
        "Request failed"
    };
    // Walk the source chain so the user sees the root cause (DNS, TLS, refused...).
    let mut msg = format!("{kind}: {e}");
    let mut src = std::error::Error::source(&e);
    while let Some(s) = src {
        msg.push_str(&format!(" — {s}"));
        src = s.source();
    }
    Error::new(Status::GenericFailure, msg)
}
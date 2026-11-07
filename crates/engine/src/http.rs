use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use napi::{Error, Result, Status};
use napi_derive::napi;
use crate::vars::substitute;

const BASE64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn base64(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = chunk.iter().enumerate().fold(0u32, |n, (i, b)| n | (*b as u32) << (16 - 8 * i));
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(BASE64[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// `Authorization: Basic user:pass` (or `user pass`) is encoded to base64 at send time, the way
/// the VS Code REST Client and JetBrains HTTP Client do; an already-encoded value is untouched.
pub(crate) fn encode_basic_auth(value: &str) -> String {
    let Some(rest) = value.trim().strip_prefix("Basic ").map(str::trim) else { return value.to_string() };
    if !rest.contains(':') && !rest.contains(char::is_whitespace) {
        return value.to_string();
    }
    let credentials = match rest.split_once(':') {
        Some((user, pass)) => format!("{user}:{pass}"),
        None => rest.split_once(char::is_whitespace).map(|(u, p)| format!("{u}:{}", p.trim())).unwrap_or_default(),
    };
    format!("Basic {}", base64(credentials.as_bytes()))
}

fn has_content_type(headers: &[HeaderEntry], prefix: &str) -> bool {
    headers.iter().any(|h| {
        h.name.trim().eq_ignore_ascii_case("content-type") && h.value.trim().to_ascii_lowercase().starts_with(prefix)
    })
}
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

pub(crate) fn invalid(msg: String) -> Error {
    Error::new(Status::InvalidArg, msg)
}

/// A bare host such as `localhost:3000/api` (typed or produced by a variable) gets `http://`.
pub(crate) fn with_scheme(url: String) -> String {
    let url = url.trim().to_string();
    let has_scheme = url.split_once("://").is_some_and(|(scheme, _)| {
        !scheme.is_empty() && scheme.chars().all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c))
    });
    if has_scheme || url.contains("{{") {
        url
    } else {
        format!("http://{url}")
    }
}

/// Applies `{{name}}` substitution to the URL, header names/values and body, failing
/// with the list of variables that have no value.
pub(crate) fn resolve(req: RequestPayload, variables: Vec<HeaderEntry>) -> Result<RequestPayload> {
    let vars: HashMap<String, String> = variables.into_iter().map(|v| (v.name, v.value)).collect();
    let mut missing: Vec<String> = Vec::new();
    let mut apply = |text: &str, encode: bool| {
        let (out, m) = substitute(text, &vars, encode);
        for name in m {
            if !missing.contains(&name) {
                missing.push(name);
            }
        }
        out
    };
    let url = with_scheme(apply(&req.url, false));
    let headers: Vec<HeaderEntry> = req
        .headers
        .iter()
        .map(|h| {
            let name = apply(&h.name, false);
            let value = apply(&h.value, false);
            let value = if name.trim().eq_ignore_ascii_case("authorization") { encode_basic_auth(&value) } else { value };
            HeaderEntry { name, value }
        })
        .collect();
    // Variable values in a form body must not break out of their field.
    let encode_body = has_content_type(&headers, "application/x-www-form-urlencoded");
    let mut body = req.body.as_deref().map(|b| apply(b, encode_body));
    // Request files keep plain line feeds; multipart on the wire requires CRLF.
    if has_content_type(&headers, "multipart/") {
        body = body.map(|b| b.replace("\r\n", "\n").replace('\n', "\r\n"));
    }
    let resolved = RequestPayload { method: req.method, url, headers, body };
    if missing.is_empty() {
        return Ok(resolved);
    }
    missing.sort();
    let list = missing.iter().map(|m| format!("{{{{{m}}}}}")).collect::<Vec<_>>().join(", ");
    let noun = if missing.len() == 1 { "variable" } else { "variables" };
    Err(invalid(format!("Undefined {noun}: {list}. Define {} in the active environment.", if missing.len() == 1 { "it" } else { "them" })))
}

/// Turns a resolved request into a reqwest builder (method, headers, body).
pub(crate) fn build_request(client: &Client, req: RequestPayload) -> Result<reqwest::RequestBuilder> {
    let method = Method::from_bytes(req.method.trim().to_uppercase().as_bytes())
        .map_err(|_| invalid(format!("Invalid HTTP method: {}", req.method)))?;

    let mut builder = client.request(method, req.url.trim());
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
    Ok(builder)
}

/// Executes an HTTP request on the Rust side; the returned Promise rejects with a
/// readable message on invalid input or network failure (non-2xx is NOT an error).
#[napi]
pub async fn execute_request(req: RequestPayload, variables: Option<Vec<HeaderEntry>>) -> Result<ResponsePayload> {
    let req = resolve(req, variables.unwrap_or_default())?;
    let builder = build_request(client()?, req)?;

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

pub(crate) fn describe(e: reqwest::Error) -> Error {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_basic_auth_like_rest_clients() {
        // base64("user:pass") = dXNlcjpwYXNz, base64("a:") = YTo=, base64("ab:c") = YWI6Yw==
        assert_eq!(encode_basic_auth("Basic user:pass"), "Basic dXNlcjpwYXNz");
        assert_eq!(encode_basic_auth("Basic user pass"), "Basic dXNlcjpwYXNz");
        assert_eq!(encode_basic_auth("Basic a:"), "Basic YTo=");
        assert_eq!(encode_basic_auth("Basic ab:c"), "Basic YWI6Yw==");
        assert_eq!(encode_basic_auth("Basic dXNlcjpwYXNz"), "Basic dXNlcjpwYXNz");
        assert_eq!(encode_basic_auth("Bearer a:b"), "Bearer a:b");
    }

    #[test]
    fn multipart_bodies_are_sent_with_crlf() {
        let req = RequestPayload {
            method: "POST".into(),
            url: "x".into(),
            headers: vec![HeaderEntry { name: "content-type".into(), value: "multipart/form-data; boundary=b".into() }],
            body: Some("--b\nContent-Disposition: form-data; name=\"a\"\n\n{{v}}\n--b--\n".into()),
        };
        let vars = vec![HeaderEntry { name: "v".into(), value: "x y".into() }];
        let body = resolve(req, vars).unwrap().body.unwrap();
        assert_eq!(body, "--b\r\nContent-Disposition: form-data; name=\"a\"\r\n\r\nx y\r\n--b--\r\n");
    }

    #[test]
    fn form_bodies_encode_substituted_values_only() {
        let req = RequestPayload {
            method: "POST".into(),
            url: "x".into(),
            headers: vec![HeaderEntry { name: "Content-Type".into(), value: "application/x-www-form-urlencoded".into() }],
            body: Some("a=1&b={{v}}".into()),
        };
        let vars = vec![HeaderEntry { name: "v".into(), value: "x y&z".into() }];
        assert_eq!(resolve(req, vars).unwrap().body.as_deref(), Some("a=1&b=x%20y%26z"));
    }

    #[test]
    fn adds_scheme_only_when_missing() {
        assert_eq!(with_scheme("localhost:3000/a".into()), "http://localhost:3000/a");
        assert_eq!(with_scheme("https://x.test".into()), "https://x.test");
        assert_eq!(with_scheme(" ftp://x ".into()), "ftp://x");
    }
}

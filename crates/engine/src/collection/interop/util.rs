//! Helpers shared by the importers and exporters. Imported requests follow the same
//! conventions as the UI's Auth and Body editors, so they open there unchanged.

use crate::collection::model::{RequestFile, RequestHeader};
use crate::vars::percent_encode;

pub const FORM_CONTENT_TYPE: &str = "application/x-www-form-urlencoded";
pub const JSON_CONTENT_TYPE: &str = "application/json";
pub const MULTIPART_BOUNDARY: &str = "----DeadLetterFormBoundary";
/// `Content-Type` value written for text-field multipart bodies.
pub const MULTIPART_CONTENT_TYPE: &str = "multipart/form-data; boundary=----DeadLetterFormBoundary";

pub fn header(name: &str, value: &str) -> RequestHeader {
    RequestHeader { name: name.to_string(), value: value.to_string(), enabled: true }
}

pub fn has_header(req: &RequestFile, name: &str) -> bool {
    req.headers.iter().any(|h| h.name.trim().eq_ignore_ascii_case(name))
}

pub fn content_type(req: &RequestFile) -> Option<String> {
    req.headers
        .iter()
        .find(|h| h.enabled && h.name.trim().eq_ignore_ascii_case("content-type"))
        .map(|h| h.value.trim().to_ascii_lowercase())
}

/// Adds the header unless the request already has one with that name.
pub fn default_header(req: &mut RequestFile, name: &str, value: &str) {
    if !has_header(req, name) {
        req.headers.push(header(name, value));
    }
}

/// The text fields of a multipart/form-data request, or `None` if it is not one (or holds files).
pub fn multipart_fields(req: &RequestFile) -> Option<Vec<(String, String)>> {
    let ct = req.headers.iter().find(|h| h.enabled && h.name.trim().eq_ignore_ascii_case("content-type"))?;
    if !ct.value.trim().to_ascii_lowercase().starts_with("multipart/form-data") {
        return None;
    }
    parse_multipart(req.body.as_deref()?, &boundary_of(&ct.value)?)
}

/// Sets (or replaces) a header value, keeping its position.
pub fn set_header(req: &mut RequestFile, name: &str, value: &str) {
    match req.headers.iter_mut().find(|h| h.name.trim().eq_ignore_ascii_case(name)) {
        Some(h) => {
            h.value = value.to_string();
            h.enabled = true;
        }
        None => req.headers.push(header(name, value)),
    }
}

/// Makes the request a text-field multipart/form-data post. An existing `Content-Type` is
/// replaced because it cannot carry our boundary.
pub fn set_multipart(req: &mut RequestFile, fields: &[(String, String)]) {
    req.body = Some(multipart_body(fields));
    set_header(req, "Content-Type", MULTIPART_CONTENT_TYPE);
}

/// Percent-encodes a form field but leaves `{{variable}}` placeholders readable.
pub fn encode_field(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(start) = rest.find("{{") {
        match rest[start..].find("}}") {
            Some(end) => {
                out.push_str(&percent_encode(&rest[..start]));
                out.push_str(&rest[start..start + end + 2]);
                rest = &rest[start + end + 2..];
            }
            None => break,
        }
    }
    out.push_str(&percent_encode(rest));
    out
}

/// Reverses [`encode_field`] for tools that store plain values (`a%20b` -> `a b`).
pub fn decode_field(s: &str) -> String {
    let mut out: Vec<u8> = Vec::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let hex = |b: u8| (b as char).to_digit(16);
        if bytes[i] == b'%' && i + 2 < bytes.len() && hex(bytes[i + 1]).is_some() && hex(bytes[i + 2]).is_some() {
            out.push((hex(bytes[i + 1]).unwrap_or(0) * 16 + hex(bytes[i + 2]).unwrap_or(0)) as u8);
            i += 3;
        } else {
            out.push(if bytes[i] == b'+' { b' ' } else { bytes[i] });
            i += 1;
        }
    }
    String::from_utf8(out).unwrap_or_else(|_| s.to_string())
}

pub fn form_body(fields: &[(String, String)]) -> String {
    fields
        .iter()
        .filter(|(k, v)| !k.trim().is_empty() || !v.trim().is_empty())
        .map(|(k, v)| format!("{}={}", encode_field(k), encode_field(v)))
        .collect::<Vec<_>>()
        .join("&")
}

/// A multipart/form-data body of text fields, laid out the way .http clients write them
/// (plain line feeds; the engine converts them to CRLF when sending).
pub fn multipart_body(fields: &[(String, String)]) -> String {
    let mut out = String::new();
    for (name, value) in fields.iter().filter(|(k, _)| !k.trim().is_empty()) {
        out.push_str(&format!(
            "--{MULTIPART_BOUNDARY}\nContent-Disposition: form-data; name=\"{}\"\n\n{value}\n",
            name.replace('"', "%22")
        ));
    }
    out.push_str(&format!("--{MULTIPART_BOUNDARY}--\n"));
    out
}

/// The boundary of a `Content-Type: multipart/...; boundary=...` value.
pub fn boundary_of(content_type: &str) -> Option<String> {
    let rest = content_type.split(';').skip(1).find_map(|p| p.trim().strip_prefix("boundary="))?;
    let b = rest.trim().trim_matches('"');
    (!b.is_empty()).then(|| b.to_string())
}

/// Reads text fields back out of a multipart body. `None` if any part is a file or the
/// body is not shaped like one, so callers fall back to treating it as opaque text.
pub fn parse_multipart(body: &str, boundary: &str) -> Option<Vec<(String, String)>> {
    let text = body.replace("\r\n", "\n");
    let delimiter = format!("--{boundary}");
    let mut fields = Vec::new();
    let mut closed = false;
    for chunk in text.split(&delimiter).skip(1) {
        if chunk.starts_with("--") {
            closed = true;
            break;
        }
        let chunk = chunk.strip_prefix('\n')?;
        let (head, value) = chunk.split_once("\n\n")?;
        let disposition = head.lines().find(|l| l.to_ascii_lowercase().starts_with("content-disposition:"))?;
        if disposition.contains("filename=") {
            return None;
        }
        let name = disposition.split("name=\"").nth(1)?.split('"').next()?;
        fields.push((name.replace("%22", "\""), value.strip_suffix('\n').unwrap_or(value).to_string()));
    }
    closed.then_some(fields)
}

/// Appends `name=value` query pairs to a URL, respecting an existing `?` and `#fragment`.
pub fn append_query(url: &str, pairs: &[(String, String)]) -> String {
    if pairs.is_empty() {
        return url.to_string();
    }
    let (base, fragment) = match url.split_once('#') {
        Some((b, f)) => (b, Some(f)),
        None => (url, None),
    };
    let query = pairs
        .iter()
        .map(|(k, v)| format!("{}={}", encode_field(k), encode_field(v)))
        .collect::<Vec<_>>()
        .join("&");
    let sep = if !base.contains('?') {
        "?"
    } else if base.ends_with('?') || base.ends_with('&') {
        ""
    } else {
        "&"
    };
    let mut out = format!("{base}{sep}{query}");
    if let Some(f) = fragment {
        out.push('#');
        out.push_str(f);
    }
    out
}

/// `Authorization` values in the same shorthand the Auth tab writes.
pub fn bearer(token: &str) -> String {
    format!("Bearer {token}")
}

pub fn basic(user: &str, pass: &str) -> String {
    format!("Basic {user}:{pass}")
}

/// A short display name for a request that has none, e.g. `users` for `https://x.test/api/users`.
pub fn name_from_url(url: &str) -> String {
    let no_scheme = url.split_once("://").map_or(url, |(_, r)| r);
    let no_query = no_scheme.split(['?', '#']).next().unwrap_or("");
    let (host, path) = no_query.split_once('/').unwrap_or((no_query, ""));
    let last = path.rsplit('/').find(|s| !s.is_empty());
    last.unwrap_or(host).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_keeps_placeholders() {
        assert_eq!(encode_field("a b {{c d}} é"), "a%20b%20{{c d}}%20%C3%A9");
        assert_eq!(encode_field("x{{"), "x%7B%7B");
    }

    #[test]
    fn decode_reverses_encode() {
        for plain in ["a b&c=d", "é{{x y}}z", "100%", "+"] {
            let decoded = decode_field(&encode_field(plain));
            assert_eq!(decoded, plain.replace('+', "+"));
        }
        assert_eq!(decode_field("a+b%2"), "a b%2");
    }

    #[test]
    fn multipart_round_trips_text_fields() {
        let fields = vec![("a".to_string(), "1".to_string()), ("note".to_string(), "line1\nline2 {{x}}".to_string())];
        let body = multipart_body(&fields);
        assert_eq!(boundary_of(MULTIPART_CONTENT_TYPE).as_deref(), Some(MULTIPART_BOUNDARY));
        assert_eq!(parse_multipart(&body, MULTIPART_BOUNDARY), Some(fields));
        assert_eq!(parse_multipart(&body.replace('\n', "\r\n"), MULTIPART_BOUNDARY).map(|f| f.len()), Some(2));
        // Files and malformed bodies are left alone.
        let file = "--b\nContent-Disposition: form-data; name=\"f\"; filename=\"x.png\"\n\nBIN\n--b--\n";
        assert_eq!(parse_multipart(file, "b"), None);
        assert_eq!(parse_multipart("nope", "b"), None);
        assert_eq!(parse_multipart("--b\nContent-Disposition: form-data; name=\"a\"\n\n1\n", "b"), None, "unterminated");
    }

    #[test]
    fn query_appends_cleanly() {
        let p = vec![("a".to_string(), "1 2".to_string())];
        assert_eq!(append_query("http://x/p", &p), "http://x/p?a=1%202");
        assert_eq!(append_query("http://x/p?z=1#top", &p), "http://x/p?z=1&a=1%202#top");
        assert_eq!(append_query("http://x/p?", &p), "http://x/p?a=1%202");
        assert_eq!(append_query("http://x/p", &[]), "http://x/p");
    }

    #[test]
    fn names_come_from_the_url() {
        assert_eq!(name_from_url("https://api.test/v1/users/?a=1"), "users");
        assert_eq!(name_from_url("https://api.test"), "api.test");
        assert_eq!(name_from_url("{{base}}/me"), "me");
    }
}

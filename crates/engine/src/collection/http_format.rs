//! `.http` files in the common REST-client style (VS Code REST Client / JetBrains):
//!
//! ```text
//! ### Request name
//! POST https://api.example.com/users
//! Content-Type: application/json
//! # X-Disabled: 1
//!
//! {"name": "ada"}
//! ```
//!
//! Response checks are `# @assert <check>` comment lines above the request line, so other
//! tools ignore them. One request per file. A disabled header is written as a `#` comment so other
//! tools simply ignore it. A file holding several `###`-separated requests is
//! rejected rather than silently truncated on the next save.

use super::model::{RequestFile, RequestHeader};

const METHODS: [&str; 9] = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "TRACE", "CONNECT"];

fn one_line(s: &str) -> String {
    s.replace(['\r', '\n'], " ").trim().to_string()
}

pub fn serialize(req: &RequestFile) -> String {
    let mut out = String::new();
    let name = one_line(&req.name);
    if !name.is_empty() {
        out.push_str(&format!("### {name}\n"));
    }
    for check in req.assertions.iter().map(|a| one_line(a)).filter(|a| !a.is_empty()) {
        out.push_str(&format!("# @assert {check}\n"));
    }
    out.push_str(&format!("{} {}\n", req.method.trim().to_uppercase(), one_line(&req.url)));
    for h in &req.headers {
        let name = one_line(&h.name);
        if name.is_empty() {
            continue;
        }
        let prefix = if h.enabled { "" } else { "# " };
        out.push_str(&format!("{prefix}{name}: {}\n", one_line(&h.value)));
    }
    if let Some(body) = req.body.as_deref().filter(|b| !b.is_empty()) {
        out.push('\n');
        out.push_str(body.trim_end_matches(['\r', '\n']));
        out.push('\n');
    }
    out
}

fn is_comment(line: &str) -> bool {
    let t = line.trim_start();
    t.starts_with('#') || t.starts_with("//")
}

fn strip_comment_marker(line: &str) -> &str {
    let t = line.trim_start();
    t.trim_start_matches(['#', '/']).trim_start()
}

fn is_header_name(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "!#$%&'*+-.^_`|~".contains(c))
}

/// `Name: value` -> (name, value), if `Name` is a valid HTTP token.
fn split_header(line: &str) -> Option<(&str, &str)> {
    let (name, value) = line.split_once(':')?;
    let name = name.trim();
    is_header_name(name).then(|| (name, value.trim()))
}

fn parse_request_line(line: &str) -> Result<(String, String), String> {
    let mut parts: Vec<&str> = line.split_whitespace().collect();
    // Optional trailing protocol version, e.g. `HTTP/1.1`.
    if parts.len() > 1 && parts.last().is_some_and(|p| p.to_ascii_uppercase().starts_with("HTTP/")) {
        parts.pop();
    }
    match parts.as_slice() {
        [] => Err("Missing request line".into()),
        [url] => Ok(("GET".into(), (*url).to_string())),
        [method, url @ ..] => {
            let m = method.to_ascii_uppercase();
            if !METHODS.contains(&m.as_str()) {
                return Err(format!("Unknown HTTP method: {method}"));
            }
            Ok((m, url.join(" ")))
        }
    }
}

pub fn parse(text: &str) -> Result<RequestFile, String> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut lines = text.lines().peekable();

    // Preamble: title (`### name`), comments and blank lines up to the request line.
    let mut name = String::new();
    let mut assertions = Vec::new();
    let request_line = loop {
        let Some(line) = lines.next() else {
            return Err("Missing request line".into());
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Some(title) = trimmed.strip_prefix("###") {
            if name.is_empty() {
                name = title.trim().to_string();
            }
            continue;
        }
        if is_comment(trimmed) {
            if let Some(check) = strip_comment_marker(trimmed).strip_prefix("@assert ") {
                assertions.push(check.trim().to_string());
            }
            continue;
        }
        break trimmed;
    };
    let (method, url) = parse_request_line(request_line)?;

    // Headers until the first blank line.
    let mut headers = Vec::new();
    for line in lines.by_ref() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            break;
        }
        if trimmed.starts_with("###") {
            return Err(multi_request_error());
        }
        if is_comment(trimmed) {
            if let Some((n, v)) = split_header(strip_comment_marker(trimmed)) {
                headers.push(RequestHeader { name: n.into(), value: v.into(), enabled: false });
            }
            continue;
        }
        let (n, v) = split_header(trimmed).ok_or_else(|| format!("Invalid header line: {trimmed}"))?;
        headers.push(RequestHeader { name: n.into(), value: v.into(), enabled: true });
    }

    let rest: Vec<&str> = lines.collect();
    if rest.iter().any(|l| l.trim_start().starts_with("###")) {
        return Err(multi_request_error());
    }
    let body = rest.join("\n");
    let body = body.trim_end_matches(['\r', '\n']);
    let body = (!body.trim().is_empty()).then(|| body.to_string());

    Ok(RequestFile { name, method, url, headers, body, assertions })
}

fn multi_request_error() -> String {
    "This .http file contains several requests; only one request per file is supported".into()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> RequestFile {
        RequestFile {
            name: "Create user".into(),
            method: "POST".into(),
            url: "https://api.example.com/users?a=1&b=2".into(),
            headers: vec![
                RequestHeader { name: "Content-Type".into(), value: "application/json".into(), enabled: true },
                RequestHeader { name: "X-Debug".into(), value: "1".into(), enabled: false },
            ],
            body: Some("{\n  \"name\": \"ada\"\n}\n\n{\"second\": true}".into()),
            ..Default::default()
        }
    }

    #[test]
    fn round_trips() {
        let req = sample();
        let text = serialize(&req);
        assert_eq!(parse(&text).unwrap(), req);
    }

    #[test]
    fn assertions_are_comment_lines_above_the_request() {
        let mut req = sample();
        req.assertions = vec!["status == 200".into(), "json $.id exists".into()];
        let text = serialize(&req);
        assert!(text.starts_with("### Create user\n# @assert status == 200\n# @assert json $.id exists\nPOST "));
        assert_eq!(parse(&text).unwrap(), req);
    }

    #[test]
    fn serialized_shape() {
        let text = serialize(&sample());
        assert!(text.starts_with("### Create user\nPOST https://api.example.com/users?a=1&b=2\n"));
        assert!(text.contains("\n# X-Debug: 1\n\n{"));
    }

    #[test]
    fn no_body_no_name() {
        let req = RequestFile {
            name: String::new(),
            method: "GET".into(),
            url: "http://x".into(),
            headers: vec![],
            body: None,
            ..Default::default()
        };
        assert_eq!(serialize(&req), "GET http://x\n");
        assert_eq!(parse("GET http://x\n").unwrap(), req);
    }

    #[test]
    fn handles_crlf_version_suffix_and_comments() {
        let text = "// leading comment\r\n### Hi\r\nget http://x/y HTTP/1.1\r\nAccept: */*\r\n# just a note\r\n\r\nbody\r\n";
        let req = parse(text).unwrap();
        assert_eq!(req.name, "Hi");
        assert_eq!(req.method, "GET");
        assert_eq!(req.url, "http://x/y");
        assert_eq!(req.headers.len(), 1);
        assert_eq!(req.body.as_deref(), Some("body"));
    }

    #[test]
    fn bare_url_means_get() {
        let req = parse("https://example.com\n").unwrap();
        assert_eq!((req.method.as_str(), req.url.as_str()), ("GET", "https://example.com"));
    }

    #[test]
    fn rejects_multiple_requests() {
        assert!(parse("### a\nGET http://x\n\n### b\nGET http://y\n").is_err());
    }

    #[test]
    fn rejects_unknown_method_and_garbage_header() {
        assert!(parse("FETCH http://x\n").is_err());
        assert!(parse("GET http://x\nnot a header\n").is_err());
    }
}

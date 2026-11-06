//! `.http` files holding several `###`-separated requests, as written for the VS Code
//! REST Client and the JetBrains HTTP Client. DeadLetter stores one request per file, so
//! these are split on import. File-level `@name = value` lines become variables.

use crate::collection::environment::EnvVariable;
use crate::collection::http_format;

use super::{ImportResult, ImportedRequest};

const METHODS: [&str; 9] = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "TRACE", "CONNECT"];

fn is_request_line(line: &str) -> bool {
    let mut parts = line.split_whitespace();
    let Some(first) = parts.next() else { return false };
    let first = first.to_ascii_uppercase();
    (METHODS.contains(&first.as_str()) && parts.next().is_some())
        || first.starts_with("HTTP://")
        || first.starts_with("HTTPS://")
        || first.starts_with("{{")
}

fn name_ok(n: &str) -> bool {
    !n.is_empty() && n.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '-' || c == '.')
}

/// `@name = value` file-level variable definitions.
fn is_variable_line(line: &str) -> bool {
    line.trim().strip_prefix('@').and_then(|r| r.split_once('=')).is_some_and(|(n, _)| name_ok(n.trim()))
}

/// True when the text looks like an `.http` file rather than JSON/YAML/cURL: its first
/// meaningful line is a request line or a variable definition.
pub fn detect(text: &str) -> bool {
    for line in text.trim_start_matches('\u{feff}').lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') || t.starts_with("//") {
            continue;
        }
        return is_variable_line(t) || is_request_line(t);
    }
    false
}

pub fn import(text: &str) -> Result<ImportResult, String> {
    let mut variables: Vec<EnvVariable> = Vec::new();
    let mut segments: Vec<Vec<&str>> = vec![Vec::new()];
    for line in text.trim_start_matches('\u{feff}').lines() {
        if line.trim_start().starts_with("###") {
            segments.push(vec![line]);
        } else if is_variable_line(line) {
            let (name, value) = line.trim()[1..].split_once('=').unwrap_or(("", ""));
            if !variables.iter().any(|v| v.name == name.trim()) {
                variables.push(EnvVariable { name: name.trim().to_string(), value: value.trim().to_string(), enabled: true, secret: false });
            }
        } else if let Some(last) = segments.last_mut() {
            last.push(line);
        }
    }

    let mut requests = Vec::new();
    let mut warnings = Vec::new();
    let mut scripts = 0;
    let mut file_refs = 0;
    for (i, seg) in segments.iter().enumerate() {
        let body = seg.join("\n");
        if body.trim().is_empty() || body.lines().all(|l| l.trim().is_empty() || l.trim_start().starts_with('#')) {
            continue;
        }
        if body.contains("{%") {
            scripts += 1;
        }
        // Drop response handlers / pre-request scripts; they cannot run here.
        let cleaned = strip_scripts(&body);
        match http_format::parse(&cleaned) {
            Ok(mut req) => {
                if req.body.as_deref().is_some_and(|b| b.lines().any(|l| l.trim_start().starts_with("< "))) {
                    file_refs += 1;
                }
                if req.name.trim().is_empty() {
                    req.name = super::util::name_from_url(&req.url);
                }
                requests.push(ImportedRequest { folder: String::new(), request: req });
            }
            Err(e) => warnings.push(format!("Request #{} was skipped: {e}", i)),
        }
    }
    if scripts > 0 {
        warnings.push(format!("{scripts} request(s) had scripts ({{% ... %}}), which are not imported"));
    }
    if file_refs > 0 {
        warnings.push(format!("{file_refs} request(s) reference body files (< path), which are not loaded"));
    }
    if requests.is_empty() {
        return Err("No requests found in that .http file".into());
    }
    Ok(ImportResult {
        source: "http".into(),
        name: "Imported .http".into(),
        requests,
        variables,
        environments: Vec::new(),
        warnings,
    })
}

/// Removes `> {% ... %}` / `< {% ... %}` script blocks (single or multi-line).
fn strip_scripts(text: &str) -> String {
    let mut out = Vec::new();
    let mut in_script = false;
    for line in text.lines() {
        let t = line.trim_start();
        if in_script {
            if t.contains("%}") {
                in_script = false;
            }
            continue;
        }
        if (t.starts_with("> {%") || t.starts_with("< {%")) && !t.contains("%}") {
            in_script = true;
            continue;
        }
        if t.starts_with("> {%") || t.starts_with("< {%") {
            continue;
        }
        out.push(line);
    }
    out.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    const FILE: &str = "@host = https://api.test\n@token=abc\n\n### List users\nGET {{host}}/users\nAuthorization: Bearer {{token}}\n\n> {%\n  client.test('x', () => {});\n%}\n\n###\n\n### Create\nPOST {{host}}/users\nContent-Type: application/json\n\n{\"name\": \"ada\"}\n\n### Broken\nFETCH nope\n";

    #[test]
    fn splits_requests_and_collects_variables() {
        assert!(detect(FILE));
        let r = import(FILE).unwrap();
        assert_eq!(r.requests.len(), 2);
        assert_eq!(r.requests[0].request.name, "List users");
        assert_eq!(r.requests[0].request.url, "{{host}}/users");
        assert!(r.requests[0].request.body.is_none(), "script block must not leak into the body");
        assert_eq!(r.requests[1].request.body.as_deref(), Some("{\"name\": \"ada\"}"));
        let vars: Vec<_> = r.variables.iter().map(|v| (v.name.as_str(), v.value.as_str())).collect();
        assert_eq!(vars, vec![("host", "https://api.test"), ("token", "abc")]);
        assert!(r.warnings.iter().any(|w| w.contains("scripts")));
        assert!(r.warnings.iter().any(|w| w.contains("skipped")));
    }

    #[test]
    fn detection_ignores_other_formats() {
        assert!(detect("# comment\nGET http://x\n"));
        assert!(detect("https://example.com\n"));
        assert!(!detect("openapi: 3.0.0\ninfo:\n  title: x\n"));
        assert!(!detect("curl http://x"));
        assert!(!detect(""));
    }
}

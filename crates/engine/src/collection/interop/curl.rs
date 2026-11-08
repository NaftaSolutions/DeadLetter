//! cURL command lines <-> requests. Handles what browsers' "Copy as cURL" (bash and cmd)
//! and API docs produce: quoting, `$'...'`, line continuations, combined short flags.

use crate::collection::model::{RequestFile, RequestHeader};
use crate::http::{encode_basic_auth, with_scheme};
use crate::vars::{percent_encode, substitute};

use super::shell::tokenize;
use super::util::{basic, multipart_body, multipart_fields, MULTIPART_CONTENT_TYPE, content_type, default_header, header, name_from_url, FORM_CONTENT_TYPE};

type Res<T> = Result<T, String>;

// --- parser ------------------------------------------------------------------------------

/// Options that consume a value, as (short, long). Handled ones are matched by name below.
const WITH_VALUE: &[(&str, &str)] = &[
    ("X", "request"),
    ("H", "header"),
    ("d", "data"),
    ("", "data-raw"),
    ("", "data-binary"),
    ("", "data-ascii"),
    ("", "data-urlencode"),
    ("", "json"),
    ("u", "user"),
    ("A", "user-agent"),
    ("e", "referer"),
    ("b", "cookie"),
    ("", "url"),
    ("F", "form"),
    ("", "form-string"),
    ("T", "upload-file"),
    // Valid but irrelevant to the request itself: consumed and ignored.
    ("o", "output"),
    ("m", "max-time"),
    ("", "connect-timeout"),
    ("x", "proxy"),
    ("U", "proxy-user"),
    ("w", "write-out"),
    ("", "cacert"),
    ("E", "cert"),
    ("", "key"),
    ("c", "cookie-jar"),
    ("", "retry"),
    ("", "max-redirs"),
    ("", "resolve"),
    ("", "interface"),
    ("", "limit-rate"),
    ("K", "config"),
    ("", "http-version"),
];

fn canonical(name: &str, long: bool) -> Option<&'static str> {
    WITH_VALUE.iter().find(|(s, l)| if long { *l == name } else { !s.is_empty() && *s == name }).map(|(_, l)| *l)
}

#[derive(Default)]
struct Parsed {
    method: Option<String>,
    url: Option<String>,
    headers: Vec<RequestHeader>,
    data: Vec<String>,
    /// `-F name=value` text fields.
    fields: Vec<(String, String)>,
    user: Option<String>,
    cookie: Option<String>,
    head: bool,
    get: bool,
    json: bool,
}

fn apply_option(p: &mut Parsed, opt: &str, value: String) -> Res<()> {
    match opt {
        "request" => p.method = Some(value.trim().to_ascii_uppercase()),
        "header" => {
            // `-H 'Name;'` (send empty) and `-H 'Name:'` (remove) have no use in a saved request.
            if let Some((n, v)) = value.split_once(':') {
                if !n.trim().is_empty() && !v.trim().is_empty() {
                    p.headers.push(header(n.trim(), v.trim()));
                }
            }
        }
        "data" | "data-raw" | "data-binary" | "data-ascii" => {
            if opt != "data-raw" && value.starts_with('@') {
                return Err("Reading data from a file (@file) is not supported".into());
            }
            p.data.push(value);
        }
        "data-urlencode" => {
            if value.starts_with('@') || value.contains("=@") {
                return Err("Reading data from a file (@file) is not supported".into());
            }
            p.data.push(match value.split_once('=') {
                Some((n, v)) if !n.is_empty() => format!("{n}={}", percent_encode(v)),
                Some((_, v)) => percent_encode(v),
                None => percent_encode(&value),
            });
        }
        "json" => {
            p.json = true;
            p.data.push(value);
        }
        "user" => p.user = Some(value),
        "user-agent" => p.headers.push(header("User-Agent", &value)),
        "referer" => p.headers.push(header("Referer", &value)),
        "cookie" => {
            if value.contains('=') {
                p.cookie = Some(value);
            }
        }
        "url" => p.url = Some(value),
        "form" | "form-string" => {
            let (name, content) = value.split_once('=').ok_or("A -F field needs the form name=value")?;
            if opt == "form" && (content.starts_with('@') || content.starts_with('<')) {
                return Err("File uploads (-F name=@file) are not supported".into());
            }
            // `;type=...` / `;filename=...` modifiers only matter for files.
            let content = if opt == "form" { content.split(";type=").next().unwrap_or(content) } else { content };
            p.fields.push((name.to_string(), content.to_string()));
        }
        "upload-file" => return Err("File uploads (-T) are not supported".into()),
        _ => {}
    }
    Ok(())
}

fn parse_args(tokens: Vec<String>) -> Res<Parsed> {
    let mut p = Parsed::default();
    let mut it = tokens.into_iter().peekable();
    let mut only_positional = false;
    while let Some(tok) = it.next() {
        if only_positional || !tok.starts_with('-') || tok == "-" {
            if p.url.is_none() {
                p.url = Some(tok);
            }
            continue;
        }
        if tok == "--" {
            only_positional = true;
        } else if let Some(long) = tok.strip_prefix("--") {
            let (name, inline) = match long.split_once('=') {
                Some((n, v)) => (n, Some(v.to_string())),
                None => (long, None),
            };
            if let Some(opt) = canonical(name, true) {
                let value = match inline {
                    Some(v) => v,
                    None => it.next().ok_or_else(|| format!("Option --{name} needs a value"))?,
                };
                apply_option(&mut p, opt, value)?;
            } else {
                match name {
                    "head" => p.head = true,
                    "get" => p.get = true,
                    _ => {} // --compressed, --insecure, --location, --silent, ...
                }
            }
        } else {
            // Short options, possibly combined (`-sSL`) or with an attached value (`-XPOST`).
            let chars: Vec<char> = tok[1..].chars().collect();
            let mut i = 0;
            while i < chars.len() {
                let c = chars[i].to_string();
                if let Some(opt) = canonical(&c, false) {
                    let attached: String = chars[i + 1..].iter().collect();
                    let value = if attached.is_empty() {
                        it.next().ok_or_else(|| format!("Option -{c} needs a value"))?
                    } else {
                        attached
                    };
                    apply_option(&mut p, opt, value)?;
                    break;
                }
                match chars[i] {
                    'I' => p.head = true,
                    'G' => p.get = true,
                    _ => {}
                }
                i += 1;
            }
        }
    }
    Ok(p)
}

/// Parses one cURL command into a request. Variables like `$TOKEN` are left as typed.
pub fn parse(command: &str) -> Res<RequestFile> {
    let mut tokens = tokenize(command.trim())?;
    if tokens.first().is_some_and(|t| t == "curl" || t.eq_ignore_ascii_case("curl.exe")) {
        tokens.remove(0);
    } else {
        return Err("Not a cURL command: it should start with `curl`".into());
    }
    let p = parse_args(tokens)?;
    let mut url = p.url.ok_or("The cURL command has no URL")?;

    let mut req = RequestFile {
        name: String::new(),
        method: "GET".into(),
        url: String::new(),
        headers: p.headers,
        body: None,
        ..Default::default()
    };
    let body = if !p.fields.is_empty() {
        Some(multipart_body(&p.fields))
    } else {
        (!p.data.is_empty()).then(|| p.data.join("&"))
    };

    if p.get {
        // `-G` turns the data into a query string (it is already encoded).
        if let Some(b) = &body {
            let sep = if url.contains('?') { "&" } else { "?" };
            url = format!("{url}{sep}{b}");
        }
    } else if let Some(b) = body {
        req.body = Some(b);
    }
    req.url = url;

    req.method = match (&p.method, p.head, req.body.is_some()) {
        (Some(m), _, _) => m.clone(),
        (None, true, _) => "HEAD".into(),
        (None, false, true) => "POST".into(),
        _ => "GET".into(),
    };

    if let Some(user) = p.user {
        let (u, pw) = user.split_once(':').unwrap_or((&user, ""));
        req.headers.insert(0, header("Authorization", &basic(u, pw)));
    }
    if let Some(cookie) = p.cookie {
        default_header(&mut req, "Cookie", &cookie);
    }
    if p.json {
        default_header(&mut req, "Content-Type", "application/json");
        default_header(&mut req, "Accept", "application/json");
    } else if !p.fields.is_empty() {
        default_header(&mut req, "Content-Type", MULTIPART_CONTENT_TYPE);
    } else if req.body.is_some() {
        // curl's own default for -d.
        default_header(&mut req, "Content-Type", FORM_CONTENT_TYPE);
    }

    req.name = name_from_url(&req.url);
    Ok(req)
}

// --- export ------------------------------------------------------------------------------

fn quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Renders a request as a runnable cURL command. `variables` are substituted; unknown
/// `{{placeholders}}` stay as they are. Disabled headers are left out.
pub fn to_curl(req: &RequestFile, variables: &std::collections::HashMap<String, String>) -> String {
    let sub = |s: &str| substitute(s, variables, false).0;
    let url = with_scheme(sub(&req.url));
    let method = req.method.trim().to_ascii_uppercase();

    let mut parts = vec!["curl".to_string()];
    match method.as_str() {
        "GET" => {}
        "HEAD" => parts.push("-I".into()),
        m => parts.push(format!("-X {m}")),
    }
    parts.push(quote(&url));
    // Multipart text fields are exported as -F so curl builds the boundaries itself.
    let multipart_fields = multipart_fields(req);
    for h in req.headers.iter().filter(|h| h.enabled && !h.name.trim().is_empty()) {
        if multipart_fields.is_some() && h.name.trim().eq_ignore_ascii_case("content-type") {
            continue;
        }
        let value = sub(&h.value);
        let value = if h.name.trim().eq_ignore_ascii_case("authorization") { encode_basic_auth(&value) } else { value };
        parts.push(format!("-H {}", quote(&format!("{}: {}", sub(h.name.trim()), value.trim()))));
    }
    if let Some(fields) = &multipart_fields {
        for (k, v) in fields {
            parts.push(format!("--form-string {}", quote(&format!("{}={}", sub(k), sub(v)))));
        }
    } else if let Some(body) = req.body.as_deref().filter(|b| !b.is_empty()) {
        let form = content_type(req).is_some_and(|t| t.starts_with(FORM_CONTENT_TYPE));
        let text = if form { substitute(body, variables, true).0 } else { sub(body) };
        parts.push(format!("--data-raw {}", quote(&text)));
    }
    parts.join(" \\\n  ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn parses_a_typical_command() {
        let req = parse(
            "curl -X POST 'https://api.test/users?x=1' \\\n  -H 'Content-Type: application/json' \\\n  -H \"Authorization: Bearer abc\" \\\n  --data-raw '{\"name\":\"ada\"}' --compressed",
        )
        .unwrap();
        assert_eq!(req.method, "POST");
        assert_eq!(req.url, "https://api.test/users?x=1");
        assert_eq!(req.headers.len(), 2);
        assert_eq!(req.headers[1].value, "Bearer abc");
        assert_eq!(req.body.as_deref(), Some("{\"name\":\"ada\"}"));
        assert_eq!(req.name, "users");
    }

    #[test]
    fn infers_method_and_content_type_like_curl() {
        let req = parse("curl https://x.test -d a=1 -d b=2").unwrap();
        assert_eq!(req.method, "POST");
        assert_eq!(req.body.as_deref(), Some("a=1&b=2"));
        assert_eq!(req.headers[0].value, FORM_CONTENT_TYPE);
        assert_eq!(parse("curl -I https://x.test").unwrap().method, "HEAD");
        assert_eq!(parse("curl https://x.test").unwrap().method, "GET");
    }

    #[test]
    fn combined_and_attached_short_flags() {
        let req = parse("curl -sSLXPUT -H'X-A: 1' https://x.test -k").unwrap();
        assert_eq!(req.method, "PUT");
        assert_eq!(req.headers.len(), 1);
        assert_eq!(req.url, "https://x.test");
    }

    #[test]
    fn user_becomes_basic_shorthand_and_get_flag_builds_a_query() {
        let req = parse("curl -u ada:p@ss -G https://x.test/s --data-urlencode 'q=a b' -d page=2").unwrap();
        assert_eq!(req.method, "GET");
        assert_eq!(req.url, "https://x.test/s?q=a%20b&page=2");
        assert_eq!(req.body, None);
        assert_eq!(req.headers[0].name, "Authorization");
        assert_eq!(req.headers[0].value, "Basic ada:p@ss");
    }

    #[test]
    fn ansi_c_strings_from_browsers() {
        let req = parse("curl 'https://x.test' --data-raw $'{\"a\":\"line1\\nline2 \\u00e9 \\'q\\'\"}'").unwrap();
        assert_eq!(req.body.as_deref(), Some("{\"a\":\"line1\nline2 é 'q'\"}"));
    }

    #[test]
    fn windows_cmd_escaping() {
        let cmd = "curl \"https://x.test/a\" ^\r\n  -H \"accept: */*\" ^\r\n  --data-raw \"^{^\\^\"a^\\^\":1^}\"";
        let req = parse(cmd).unwrap();
        assert_eq!(req.url, "https://x.test/a");
        assert_eq!(req.body.as_deref(), Some("{\"a\":1}"));
    }

    #[test]
    fn rejects_what_it_cannot_represent() {
        assert!(parse("curl -F a=@x.png https://x.test").unwrap_err().contains("File uploads"));
        assert!(parse("curl -d @body.json https://x.test").unwrap_err().contains("file"));
        assert!(parse("wget https://x.test").is_err());
        assert!(parse("curl -X POST").is_err());
        assert!(parse("curl 'https://x.test").is_err());
    }

    #[test]
    fn form_fields_become_multipart_and_export_back_as_form_strings() {
        let req = parse("curl https://x.test/up -F a=1 -F 'note=hi there;type=text/plain' --form-string 'raw=@not-a-file'").unwrap();
        assert_eq!(req.method, "POST");
        assert_eq!(req.headers[0].value, MULTIPART_CONTENT_TYPE);
        let fields = multipart_fields(&req).unwrap();
        assert_eq!(fields, vec![("a".into(), "1".into()), ("note".into(), "hi there".into()), ("raw".into(), "@not-a-file".into())]);

        let out = to_curl(&req, &HashMap::new());
        assert!(out.contains("--form-string 'a=1'") && out.contains("--form-string 'raw=@not-a-file'"), "{out}");
        assert!(!out.contains("Content-Type") && !out.contains("--data-raw"), "{out}");
    }

    #[test]
    fn exports_with_variables_and_basic_encoding() {
        let mut req = parse("curl -u ada:pw -X POST 'https://{{host}}/it' -H 'X-Q: it'\\''s' -d '{\"a\":\"{{v}}\"}'").unwrap();
        req.headers.retain(|h| !h.name.eq_ignore_ascii_case("content-type"));
        let vars: HashMap<String, String> = [("host", "api.test"), ("v", "1")]
            .into_iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        let out = to_curl(&req, &vars);
        assert!(out.starts_with("curl"));
        assert!(out.contains("-X POST") && out.contains("'https://api.test/it'"), "{out}");
        assert!(out.contains("-H 'Authorization: Basic YWRhOnB3'"));
        assert!(out.contains("-H 'X-Q: it'\\''s'"));
        assert!(out.contains("--data-raw '{\"a\":\"1\"}'"));
        // Unknown placeholders survive, and a parsed export round-trips.
        let again = parse(&to_curl(&req, &HashMap::new())).unwrap();
        assert_eq!(again.url, "https://{{host}}/it");
    }
}

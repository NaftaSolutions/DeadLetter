//! `{{name}}` placeholder substitution for requests.

use std::collections::HashMap;

/// Percent-encodes everything except RFC 3986 unreserved characters.
pub fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// Replaces every `{{ name }}` with its value (percent-encoded when `encode` is set, for
/// `application/x-www-form-urlencoded` bodies). Text without a closing `}}` is left
/// untouched. Returns the sorted, de-duplicated names that have no value.
pub fn substitute(text: &str, vars: &HashMap<String, String>, encode: bool) -> (String, Vec<String>) {
    let mut out = String::with_capacity(text.len());
    let mut missing: Vec<String> = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find("{{") {
        let after = &rest[start + 2..];
        let Some(end) = after.find("}}") else { break };
        let name = after[..end].trim();
        out.push_str(&rest[..start]);
        match vars.get(name) {
            Some(v) if !name.is_empty() => {
                if encode {
                    out.push_str(&percent_encode(v));
                } else {
                    out.push_str(v);
                }
            }
            _ => {
                // Keep the placeholder so the caller can still show it.
                out.push_str(&rest[start..start + 2 + end + 2]);
                if !name.is_empty() && !missing.iter().any(|m| m == name) {
                    missing.push(name.to_string());
                }
            }
        }
        rest = &after[end + 2..];
    }
    out.push_str(rest);
    missing.sort();
    (out, missing)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vars() -> HashMap<String, String> {
        [("host", "api.test"), ("token", "s3cret")]
            .into_iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn replaces_known_variables() {
        let (out, missing) = substitute("https://{{host}}/x?t={{ token }}", &vars(), false);
        assert_eq!(out, "https://api.test/x?t=s3cret");
        assert!(missing.is_empty());
    }

    #[test]
    fn reports_missing_once_and_keeps_placeholder() {
        let (out, missing) = substitute("{{a}} {{b}} {{a}}", &vars(), false);
        assert_eq!(out, "{{a}} {{b}} {{a}}");
        assert_eq!(missing, vec!["a", "b"]);
    }

    #[test]
    fn leaves_unclosed_and_empty_braces_alone() {
        let (out, missing) = substitute("{ \"a\": {{host}} {{", &vars(), false);
        assert_eq!(out, "{ \"a\": api.test {{");
        assert!(missing.is_empty());
        assert_eq!(substitute("{{}}", &vars(), false).0, "{{}}");
    }

    #[test]
    fn encodes_values_for_form_bodies() {
        let mut v = vars();
        v.insert("q".into(), "a b&c=d/é".into());
        assert_eq!(substitute("k={{q}}&x=1", &v, true).0, "k=a%20b%26c%3Dd%2F%C3%A9&x=1");
    }

    #[test]
    fn values_are_not_rescanned() {
        let mut v = vars();
        v.insert("host".into(), "{{token}}".into());
        assert_eq!(substitute("{{host}}", &v, false).0, "{{token}}");
    }
}

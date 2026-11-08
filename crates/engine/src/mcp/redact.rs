//! Output hygiene for tool results: secret values never leave the engine, and large
//! bodies are cut down to something that fits an agent's context window.

/// Secrets shorter than this are not scrubbed: replacing a one- or two-character value would
/// mangle ordinary text far more often than it would hide anything.
const MIN_SECRET_LEN: usize = 3;

/// Replaces every occurrence of a secret value with `[secret:<name>]`. Longer secrets go first so
/// that a secret containing another one is replaced whole.
pub fn scrub(text: &str, secrets: &[(String, String)]) -> String {
    let mut ordered: Vec<&(String, String)> = secrets.iter().filter(|(_, v)| v.len() >= MIN_SECRET_LEN).collect();
    ordered.sort_by_key(|(_, v)| std::cmp::Reverse(v.len()));
    let mut out = text.to_string();
    for (name, value) in ordered {
        if out.contains(value.as_str()) {
            out = out.replace(value.as_str(), &format!("[secret:{name}]"));
        }
    }
    out
}

/// Cuts `text` to at most `max_chars` characters. Returns the text and whether it was cut.
pub fn truncate(text: &str, max_chars: usize) -> (String, bool) {
    match text.char_indices().nth(max_chars) {
        Some((byte, _)) => (text[..byte].to_string(), true),
        None => (text.to_string(), false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(name: &str, value: &str) -> (String, String) {
        (name.to_string(), value.to_string())
    }

    #[test]
    fn scrubs_secret_values_by_name() {
        let out = scrub(r#"{"token":"abc123xyz"}"#, &[s("apiKey", "abc123xyz")]);
        assert_eq!(out, r#"{"token":"[secret:apiKey]"}"#);
    }

    #[test]
    fn longer_secret_wins_over_the_one_it_contains() {
        let out = scrub("pass-word-1", &[s("short", "pass"), s("long", "pass-word-1")]);
        assert_eq!(out, "[secret:long]");
    }

    #[test]
    fn leaves_tiny_and_empty_secrets_alone() {
        assert_eq!(scrub("a b 1", &[s("x", ""), s("y", "1")]), "a b 1");
    }

    #[test]
    fn truncates_on_char_boundaries() {
        assert_eq!(truncate("héllo", 2), ("hé".to_string(), true));
        assert_eq!(truncate("héllo", 5), ("héllo".to_string(), false));
        assert_eq!(truncate("", 0), (String::new(), false));
    }
}

use super::model::RequestFile;

pub fn parse(text: &str) -> Result<RequestFile, String> {
    serde_json::from_str(text).map_err(|e| format!("Invalid request JSON: {e}"))
}

pub fn serialize(req: &RequestFile) -> String {
    // Serializing plain strings/bools cannot fail.
    let mut out = serde_json::to_string_pretty(req).unwrap_or_default();
    out.push('\n');
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::collection::model::RequestHeader;

    fn sample() -> RequestFile {
        RequestFile {
            name: "Create user".into(),
            method: "POST".into(),
            url: "https://api.example.com/users".into(),
            headers: vec![
                RequestHeader { name: "Accept".into(), value: "application/json".into(), enabled: true },
                RequestHeader { name: "X-Debug".into(), value: "1".into(), enabled: false },
            ],
            body: Some("{\n  \"a\": 1\n}".into()),
        }
    }

    #[test]
    fn round_trips() {
        let req = sample();
        assert_eq!(parse(&serialize(&req)).unwrap(), req);
    }

    #[test]
    fn missing_optional_fields_use_defaults() {
        let req = parse(r#"{"method":"GET","url":"http://x"}"#).unwrap();
        assert!(req.headers.is_empty());
        assert_eq!(req.body, None);
        assert_eq!(req.name, "");
    }

    #[test]
    fn unrelated_json_is_rejected() {
        assert!(parse(r#"{"name":"my-package","version":"1.0.0"}"#).is_err());
    }
}

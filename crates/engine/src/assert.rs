//! Response assertions: one plain-text check per line, stored with the request.
//!
//! ```text
//! status == 200
//! time < 500
//! header content-type contains json
//! body contains "ok"
//! json $.data.items[0].id exists
//! json $.data.items.length > 0
//! ```
//!
//! Subjects: `status`, `time` (ms), `size` (bytes), `body`, `header <name>`, `json <path>`.
//! Operators: `==` `!=` `<` `<=` `>` `>=` `contains` `!contains` `exists` `!exists`.
//! Expected values may use `{{variables}}` and are read as JSON when they parse as JSON
//! (`200`, `true`, `"text"`), otherwise as bare text.

use std::collections::HashMap;

use napi_derive::napi;
use serde_json::Value;

use crate::http::{HeaderEntry, ResponsePayload};
use crate::vars::substitute;

#[napi(object)]
pub struct AssertionResult {
    pub assertion: String,
    pub passed: bool,
    /// Why it passed or failed, in words.
    pub message: String,
}

#[derive(Clone, Copy, PartialEq)]
enum Op {
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
    Contains,
    NotContains,
    Exists,
    NotExists,
}

impl Op {
    fn parse(s: &str) -> Option<Op> {
        Some(match s {
            "==" | "=" => Op::Eq,
            "!=" => Op::Ne,
            "<" => Op::Lt,
            "<=" => Op::Le,
            ">" => Op::Gt,
            ">=" => Op::Ge,
            "contains" => Op::Contains,
            "!contains" => Op::NotContains,
            "exists" => Op::Exists,
            "!exists" => Op::NotExists,
            _ => return None,
        })
    }

    fn symbol(self) -> &'static str {
        match self {
            Op::Eq => "==",
            Op::Ne => "!=",
            Op::Lt => "<",
            Op::Le => "<=",
            Op::Gt => ">",
            Op::Ge => ">=",
            Op::Contains => "contains",
            Op::NotContains => "!contains",
            Op::Exists => "exists",
            Op::NotExists => "!exists",
        }
    }
}

enum Subject {
    Status,
    Time,
    Size,
    Body,
    Header(String),
    Json(String),
}

struct Parsed {
    subject: Subject,
    op: Op,
    expected: String,
}

fn parse(line: &str) -> Result<Parsed, String> {
    let line = line.trim();
    let (word, rest) = line.split_once(char::is_whitespace).unwrap_or((line, ""));
    let rest = rest.trim_start();
    let (subject, rest) = match word.to_ascii_lowercase().as_str() {
        "status" => (Subject::Status, rest),
        "time" => (Subject::Time, rest),
        "size" => (Subject::Size, rest),
        "body" => (Subject::Body, rest),
        w @ ("header" | "json") => {
            let (arg, after) = rest.split_once(char::is_whitespace).unwrap_or((rest, ""));
            if arg.is_empty() {
                return Err(format!("`{w}` needs a {}", if w == "header" { "header name" } else { "path like $.id" }));
            }
            (if w == "header" { Subject::Header(arg.to_string()) } else { Subject::Json(arg.to_string()) }, after.trim_start())
        }
        _ => return Err("Start with status, time, size, body, header <name> or json <path>".into()),
    };
    let (op_word, expected) = rest.split_once(char::is_whitespace).unwrap_or((rest, ""));
    let op = Op::parse(op_word).ok_or_else(|| format!("Unknown operator `{op_word}`"))?;
    let expected = expected.trim().to_string();
    if !matches!(op, Op::Exists | Op::NotExists) && expected.is_empty() {
        return Err(format!("`{}` needs a value to compare with", op.symbol()));
    }
    Ok(Parsed { subject, op, expected })
}

#[derive(Debug, PartialEq)]
enum Step {
    Key(String),
    Index(usize),
}

/// `$.a.b[0]['c d']` -> steps. Only what response checks need; no filters or wildcards.
fn parse_path(path: &str) -> Result<Vec<Step>, String> {
    let rest = path.strip_prefix('$').ok_or("JSON paths start with $")?;
    let mut steps = Vec::new();
    let mut chars = rest.char_indices().peekable();
    while let Some((i, c)) = chars.next() {
        match c {
            '.' => {
                let start = i + 1;
                let mut end = rest.len();
                while let Some(&(j, n)) = chars.peek() {
                    if n == '.' || n == '[' {
                        end = j;
                        break;
                    }
                    chars.next();
                }
                let key = &rest[start..end];
                if key.is_empty() {
                    return Err(format!("Empty key in path {path}"));
                }
                steps.push(Step::Key(key.to_string()));
            }
            '[' => {
                let close = rest[i..].find(']').ok_or_else(|| format!("Missing ] in path {path}"))? + i;
                let inner = rest[i + 1..close].trim();
                if let Ok(n) = inner.parse::<usize>() {
                    steps.push(Step::Index(n));
                } else if let Some(key) = inner
                    .strip_prefix('\'')
                    .and_then(|s| s.strip_suffix('\''))
                    .or_else(|| inner.strip_prefix('"').and_then(|s| s.strip_suffix('"')))
                {
                    steps.push(Step::Key(key.to_string()));
                } else {
                    return Err(format!("Unsupported index [{inner}] in path {path}"));
                }
                while chars.peek().is_some_and(|&(j, _)| j <= close) {
                    chars.next();
                }
            }
            _ => return Err(format!("Unexpected `{c}` in path {path}")),
        }
    }
    Ok(steps)
}

fn walk(root: &Value, steps: &[Step]) -> Option<Value> {
    let mut cur = root.clone();
    for step in steps {
        cur = match (step, &cur) {
            (Step::Key(k), Value::Object(o)) => o.get(k)?.clone(),
            (Step::Key(k), Value::Array(a)) if k == "length" => Value::from(a.len()),
            (Step::Key(k), Value::String(s)) if k == "length" => Value::from(s.chars().count()),
            (Step::Index(i), Value::Array(a)) => a.get(*i)?.clone(),
            _ => return None,
        };
    }
    Some(cur)
}

fn number(v: &Value, loose: bool) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) if loose => s.trim().parse().ok(),
        _ => None,
    }
}

fn show(v: &Value) -> String {
    match v {
        Value::String(s) => format!("\"{s}\""),
        other => other.to_string(),
    }
}

fn as_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

fn equal(actual: &Value, expected: &Value, loose: bool) -> bool {
    match (number(actual, loose), number(expected, loose)) {
        (Some(a), Some(b)) => a == b,
        _ => actual == expected || (loose && as_text(actual) == as_text(expected)),
    }
}

fn contains(actual: &Value, expected: &Value) -> bool {
    match actual {
        Value::String(s) => s.contains(&as_text(expected)),
        Value::Array(items) => items.iter().any(|i| equal(i, expected, false)),
        Value::Object(o) => o.contains_key(&as_text(expected)),
        other => other.to_string().contains(&as_text(expected)),
    }
}

/// `Ok(true)` when it holds; `Err` carries a message for a check that cannot be evaluated.
fn compare(op: Op, actual: &Value, expected: &Value, loose: bool) -> Result<bool, String> {
    Ok(match op {
        Op::Eq => equal(actual, expected, loose),
        Op::Ne => !equal(actual, expected, loose),
        Op::Contains => contains(actual, expected),
        Op::NotContains => !contains(actual, expected),
        Op::Lt | Op::Le | Op::Gt | Op::Ge => {
            let (Some(a), Some(b)) = (number(actual, loose), number(expected, loose)) else {
                return Err(format!("{} is not a number comparison with {}", show(actual), show(expected)));
            };
            match op {
                Op::Lt => a < b,
                Op::Le => a <= b,
                Op::Gt => a > b,
                _ => a >= b,
            }
        }
        Op::Exists | Op::NotExists => unreachable!("handled before comparing"),
    })
}

fn literal(text: &str) -> Value {
    serde_json::from_str(text).unwrap_or_else(|_| Value::String(text.to_string()))
}

fn evaluate_one(line: &str, res: &ResponsePayload, vars: &HashMap<String, String>) -> Result<(bool, String), String> {
    let p = parse(line)?;
    let (expected_text, missing) = substitute(&p.expected, vars, false);
    if !missing.is_empty() {
        let list = missing.iter().map(|m| format!("{{{{{m}}}}}")).collect::<Vec<_>>().join(", ");
        return Err(format!("Undefined variable: {list}"));
    }
    let expected = literal(&expected_text);

    // (label, actual value if there is one, whether strings may stand in for numbers)
    let (label, actual, loose) = match &p.subject {
        Subject::Status => ("status".to_string(), Some(Value::from(res.status)), false),
        Subject::Time => ("time".to_string(), Value::from_f64_lossy(res.latency_ms), false),
        Subject::Size => ("size".to_string(), Some(Value::from(res.size_bytes)), false),
        Subject::Body => ("body".to_string(), Some(Value::String(res.body.clone())), true),
        Subject::Header(name) => {
            let found = res.headers.iter().find(|h| h.name.eq_ignore_ascii_case(name));
            (format!("header {name}"), found.map(|h| Value::String(h.value.clone())), true)
        }
        Subject::Json(path) => {
            let steps = parse_path(path)?;
            let doc: Value = serde_json::from_str(&res.body).map_err(|_| "The response body is not JSON".to_string())?;
            (format!("json {path}"), walk(&doc, &steps), false)
        }
    };

    if matches!(p.op, Op::Exists | Op::NotExists) {
        let want = p.op == Op::Exists;
        let ok = actual.is_some() == want;
        let state = if actual.is_some() { "exists" } else { "does not exist" };
        return Ok((ok, if ok { format!("{label} {state}") } else { format!("{label} {state}, expected it to {}", if want { "exist" } else { "be absent" }) }));
    }
    let Some(actual) = actual else {
        return Ok((false, format!("{label} does not exist")));
    };
    let ok = compare(p.op, &actual, &expected, loose)?;
    let shown = if label == "body" && matches!(&actual, Value::String(s) if s.len() > 80) { "(long body)".to_string() } else { show(&actual) };
    Ok((ok, if ok { format!("{label} {} {}", p.op.symbol(), show(&expected)) } else { format!("{label}: expected {} {}, got {shown}", p.op.symbol(), show(&expected)) }))
}

trait FromF64 {
    fn from_f64_lossy(n: f64) -> Option<Value>;
}

impl FromF64 for Value {
    fn from_f64_lossy(n: f64) -> Option<Value> {
        serde_json::Number::from_f64(n).map(Value::Number)
    }
}

/// Runs every non-empty assertion against a response. A check that is malformed or cannot be
/// evaluated fails with the reason instead of throwing, so one bad line never hides the others.
#[napi]
pub fn run_assertions(
    assertions: Vec<String>,
    response: ResponsePayload,
    variables: Option<Vec<HeaderEntry>>,
) -> Vec<AssertionResult> {
    let vars: HashMap<String, String> = variables.unwrap_or_default().into_iter().map(|v| (v.name, v.value)).collect();
    assertions
        .into_iter()
        .filter(|a| !a.trim().is_empty())
        .map(|assertion| {
            let (passed, message) = match evaluate_one(&assertion, &response, &vars) {
                Ok(outcome) => outcome,
                Err(why) => (false, why),
            };
            AssertionResult { assertion, passed, message }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn response() -> ResponsePayload {
        ResponsePayload {
            status: 201,
            status_text: "Created".into(),
            latency_ms: 120.5,
            headers: vec![HeaderEntry { name: "Content-Type".into(), value: "application/json; charset=utf-8".into() }],
            body: r#"{"id": 7, "name": "ada", "tags": ["a", "b"], "nested": {"ok": true, "none": null}, "items": [{"id": 1}]}"#.into(),
            size_bytes: 99,
        }
    }

    fn check(line: &str) -> (bool, String) {
        let r = run_assertions(vec![line.to_string()], response(), Some(vec![HeaderEntry { name: "who".into(), value: "ada".into() }]));
        (r[0].passed, r[0].message.clone())
    }

    #[test]
    fn built_in_subjects() {
        assert!(check("status == 201").0);
        assert!(!check("status == 200").0);
        assert!(check("status >= 200").0);
        assert!(check("time < 500").0);
        assert!(check("size == 99").0);
        assert!(check("header content-type contains json").0);
        assert!(check("header x-missing !exists").0);
        assert!(check("header content-type exists").0);
        assert!(check("body contains \"ada\"").0);
        assert!(check("body contains ada").0);
    }

    #[test]
    fn json_paths() {
        assert!(check("json $.id == 7").0);
        assert!(check("json $.name == \"ada\"").0);
        assert!(check("json $.name == ada").0);
        assert!(check("json $.name == {{who}}").0);
        assert!(check("json $.tags[1] == b").0);
        assert!(check("json $.tags contains a").0);
        assert!(check("json $.tags.length == 2").0);
        assert!(check("json $['nested'].ok == true").0);
        assert!(check("json $.nested.none exists").0);
        assert!(check("json $.items[0].id == 1").0);
        assert!(check("json $.missing !exists").0);
        assert!(check("json $.nested contains ok").0);
        assert!(!check("json $.id == \"7\"").0, "a JSON number is not a string");
    }

    #[test]
    fn failures_explain_themselves() {
        assert_eq!(check("status == 200").1, "status: expected == 200, got 201");
        assert_eq!(check("json $.missing exists").1, "json $.missing does not exist, expected it to exist");
    }

    #[test]
    fn bad_lines_fail_without_throwing() {
        assert!(check("whatever").1.starts_with("Start with"));
        assert!(check("status ~= 1").1.contains("Unknown operator"));
        assert!(check("status ==").1.contains("needs a value"));
        assert!(check("json id == 1").1.contains("start with $"));
        assert!(check("status < big").1.contains("not a number"));
        assert!(check("json $.id == {{nope}}").1.contains("Undefined variable"));
    }

    #[test]
    fn non_json_body_is_a_failed_json_check() {
        let mut res = response();
        res.body = "<html>".into();
        let r = run_assertions(vec!["json $.id exists".into(), "".into()], res, None);
        assert_eq!(r.len(), 1);
        assert!(!r[0].passed && r[0].message.contains("not JSON"));
    }

    #[test]
    fn paths_parse() {
        assert_eq!(parse_path("$").unwrap(), vec![]);
        assert_eq!(
            parse_path("$.a[0]['b c'].d").unwrap(),
            vec![Step::Key("a".into()), Step::Index(0), Step::Key("b c".into()), Step::Key("d".into())]
        );
        assert!(parse_path("$.").is_err());
        assert!(parse_path("$[").is_err());
    }
}

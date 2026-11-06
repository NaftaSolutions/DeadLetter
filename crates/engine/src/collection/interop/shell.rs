//! Minimal POSIX-style shell word splitting for pasted cURL commands: quotes, `$'...'`,
//! backslash line continuations and Chrome's cmd.exe `^` escaping.

type Res<T> = Result<T, String>;

/// Chrome's "Copy as cURL (cmd)" escapes with `^`; undo that before tokenizing.
fn unescape_cmd(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '^' {
            out.push(c);
            continue;
        }
        match chars.next() {
            // `^` + newline is a line continuation.
            Some('\r') => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
            }
            Some('\n') | None => {}
            Some(next) => out.push(next),
        }
    }
    out
}

fn ansi_c_escape(chars: &mut std::iter::Peekable<std::str::Chars<'_>>, out: &mut String) {
    let Some(c) = chars.next() else { return };
    match c {
        'n' => out.push('\n'),
        'r' => out.push('\r'),
        't' => out.push('\t'),
        '\\' | '\'' | '"' => out.push(c),
        'x' | 'u' | 'U' => {
            let max = match c {
                'x' => 2,
                'u' => 4,
                _ => 8,
            };
            let mut hex = String::new();
            while hex.len() < max && chars.peek().is_some_and(|d| d.is_ascii_hexdigit()) {
                hex.extend(chars.next());
            }
            match u32::from_str_radix(&hex, 16).ok().and_then(char::from_u32) {
                Some(ch) => out.push(ch),
                None => {
                    out.push('\\');
                    out.push(c);
                    out.push_str(&hex);
                }
            }
        }
        other => {
            out.push('\\');
            out.push(other);
        }
    }
}

pub fn tokenize(input: &str) -> Res<Vec<String>> {
    let text = if input.contains("^\"") || input.contains("^\n") || input.contains("^\r\n") {
        unescape_cmd(input)
    } else {
        input.to_string()
    };
    let mut tokens = Vec::new();
    let mut cur = String::new();
    let mut in_token = false;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            c if c.is_whitespace() => {
                if in_token {
                    tokens.push(std::mem::take(&mut cur));
                    in_token = false;
                }
            }
            '\\' => match chars.next() {
                Some('\n') => {}
                Some('\r') => {
                    if chars.peek() == Some(&'\n') {
                        chars.next();
                    }
                }
                Some(n) => {
                    cur.push(n);
                    in_token = true;
                }
                None => {}
            },
            '\'' => {
                in_token = true;
                loop {
                    match chars.next() {
                        Some('\'') => break,
                        Some(n) => cur.push(n),
                        None => return Err("Unterminated single quote".into()),
                    }
                }
            }
            '"' => {
                in_token = true;
                loop {
                    match chars.next() {
                        Some('"') => break,
                        Some('\\') => match chars.next() {
                            Some(n @ ('"' | '\\' | '$' | '`')) => cur.push(n),
                            Some('\n') => {}
                            Some(n) => {
                                cur.push('\\');
                                cur.push(n);
                            }
                            None => return Err("Unterminated double quote".into()),
                        },
                        Some(n) => cur.push(n),
                        None => return Err("Unterminated double quote".into()),
                    }
                }
            }
            '$' if chars.peek() == Some(&'\'') => {
                chars.next();
                in_token = true;
                loop {
                    match chars.next() {
                        Some('\'') => break,
                        Some('\\') => ansi_c_escape(&mut chars, &mut cur),
                        Some(n) => cur.push(n),
                        None => return Err("Unterminated $'...' string".into()),
                    }
                }
            }
            c => {
                cur.push(c);
                in_token = true;
            }
        }
    }
    if in_token {
        tokens.push(cur);
    }
    Ok(tokens)
}

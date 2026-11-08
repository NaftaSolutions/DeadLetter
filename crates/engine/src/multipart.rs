//! File parts of a multipart body. In a request file a file field is written the way `.http`
//! clients do it: a part whose `Content-Disposition` has a `filename` and whose content is a single
//! `< /absolute/path` line. At send time the line is replaced by the file's bytes.

use std::path::{Component, Path, PathBuf};

use napi::Result;

use crate::http::invalid;

/// The `boundary=` of a multipart Content-Type value.
pub(crate) fn boundary_of(content_type: &str) -> Option<String> {
    let rest = &content_type[content_type.to_ascii_lowercase().find("boundary=")? + "boundary=".len()..];
    let rest = rest.trim_start_matches('"');
    let end = rest.find(['"', ';']).unwrap_or(rest.len());
    let boundary = rest[..end].trim();
    (!boundary.is_empty()).then(|| boundary.to_string())
}

fn mime_for(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref() {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        Some("pdf") => "application/pdf",
        Some("json") => "application/json",
        Some("txt" | "log") => "text/plain",
        Some("csv") => "text/csv",
        Some("html") => "text/html",
        Some("xml") => "application/xml",
        Some("zip") => "application/zip",
        _ => "application/octet-stream",
    }
}

/// Absolute paths are used as written. A relative path is resolved against the workspace `root`
/// and may not climb out of it, so a shared collection cannot read arbitrary files by `..`.
fn locate(reference: &str, root: Option<&Path>) -> Result<PathBuf> {
    let path = Path::new(reference.trim());
    if path.is_absolute() {
        return Ok(path.to_path_buf());
    }
    let Some(root) = root else {
        return Err(invalid(format!("Cannot resolve relative file path without a workspace: {}", path.display())));
    };
    if path.components().any(|c| matches!(c, Component::ParentDir | Component::Prefix(_) | Component::RootDir)) {
        return Err(invalid(format!("File path must stay inside the workspace: {}", path.display())));
    }
    Ok(root.join(path))
}

/// Replaces every `< path` file part of a CRLF multipart `body` with the file's contents.
/// Bodies without file parts come back byte-for-byte.
pub(crate) fn expand_files(body: &str, boundary: &str, root: Option<&Path>) -> Result<Vec<u8>> {
    let delimiter = format!("--{boundary}");
    let mut chunks = body.split(delimiter.as_str());
    let mut out = chunks.next().unwrap_or_default().as_bytes().to_vec();
    for chunk in chunks {
        out.extend_from_slice(delimiter.as_bytes());
        if chunk.starts_with("--") {
            out.extend_from_slice(chunk.as_bytes());
            continue;
        }
        let Some((head, content)) = chunk.split_once("\r\n\r\n") else {
            out.extend_from_slice(chunk.as_bytes());
            continue;
        };
        let has_filename = head.to_ascii_lowercase().contains("filename=");
        let reference = content.strip_suffix("\r\n").unwrap_or(content).strip_prefix("< ").filter(|r| !r.contains('\n'));
        let (true, Some(reference)) = (has_filename, reference) else {
            out.extend_from_slice(chunk.as_bytes());
            continue;
        };
        let path = locate(reference, root)?;
        let bytes = std::fs::read(&path).map_err(|e| invalid(format!("Cannot read {}: {e}", path.display())))?;
        out.extend_from_slice(head.as_bytes());
        if !head.to_ascii_lowercase().contains("\r\ncontent-type:") {
            out.extend_from_slice(format!("\r\nContent-Type: {}", mime_for(&path)).as_bytes());
        }
        out.extend_from_slice(b"\r\n\r\n");
        out.extend_from_slice(&bytes);
        out.extend_from_slice(b"\r\n");
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_boundary() {
        assert_eq!(boundary_of("multipart/form-data; boundary=abc").as_deref(), Some("abc"));
        assert_eq!(boundary_of("multipart/form-data; boundary=\"a b\"; x=1").as_deref(), Some("a b"));
        assert_eq!(boundary_of("multipart/form-data"), None);
    }

    #[test]
    fn inlines_a_referenced_file_and_leaves_text_fields() {
        let dir = std::env::temp_dir().join("deadletter-multipart-test");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a.png");
        std::fs::write(&file, [0u8, 159, 255]).unwrap();
        let body = format!(
            "--b\r\nContent-Disposition: form-data; name=\"t\"\r\n\r\nhi\r\n--b\r\nContent-Disposition: form-data; name=\"f\"; filename=\"a.png\"\r\n\r\n< {}\r\n--b--\r\n",
            file.display()
        );
        let out = expand_files(&body, "b", None).unwrap();
        let expected_tail: Vec<u8> = [&b"Content-Type: image/png\r\n\r\n"[..], &[0, 159, 255], b"\r\n--b--\r\n"].concat();
        assert!(out.windows(expected_tail.len()).any(|w| w == expected_tail.as_slice()));
        assert!(out.starts_with(b"--b\r\nContent-Disposition: form-data; name=\"t\"\r\n\r\nhi\r\n"));
    }

    #[test]
    fn rejects_relative_and_missing_files() {
        let rel = "--b\r\nContent-Disposition: form-data; name=\"f\"; filename=\"a\"\r\n\r\n< a.png\r\n--b--\r\n";
        assert!(expand_files(rel, "b", None).is_err());
    }

    #[test]
    fn relative_paths_resolve_inside_the_workspace_only() {
        let dir = std::env::temp_dir().join("deadletter-multipart-rel");
        std::fs::create_dir_all(dir.join("up")).unwrap();
        std::fs::write(dir.join("up").join("a.txt"), b"hello").unwrap();
        let part = |p: &str| format!("--b\r\nContent-Disposition: form-data; name=\"f\"; filename=\"a\"\r\n\r\n< {p}\r\n--b--\r\n");
        let out = expand_files(&part("./up/a.txt"), "b", Some(&dir)).unwrap();
        assert!(out.windows(5).any(|w| w == b"hello"), "{:?}", String::from_utf8_lossy(&out));
        assert!(expand_files(&part("../x.txt"), "b", Some(&dir)).is_err());
        assert!(expand_files(&part("./up/../../x.txt"), "b", Some(&dir)).is_err());
        assert!(expand_files(&part("./up/a.txt"), "b", None).is_err());
    }

    #[test]
    fn a_text_field_that_looks_like_a_reference_is_not_read() {
        let body = "--b\r\nContent-Disposition: form-data; name=\"t\"\r\n\r\n< /etc/passwd\r\n--b--\r\n";
        assert_eq!(expand_files(body, "b", None).unwrap(), body.as_bytes());
    }
}

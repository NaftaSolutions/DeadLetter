//! Moving whole collections between the workspace and other tools.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use serde_json::Value;

use super::postman::{collection, request_to_postman};
use super::{ImportResult, ImportSummary};
use crate::collection::model::Format;
use crate::collection::store::{
    canonical_root, folder_name, list, read_file, resolve, slug, unique_path, write_file,
};

type Res<T> = Result<T, String>;

/// Folder segments that are empty or unusable on the filesystem fall back to this.
const FALLBACK_FOLDER: &str = "Imported";

fn safe_folder(name: &str) -> String {
    folder_name(name).unwrap_or_else(|_| FALLBACK_FOLDER.to_string())
}

pub fn write_import(root: &str, dir: &str, result: &ImportResult, format: &str) -> Res<ImportSummary> {
    let format = Format::from_ext(format).ok_or_else(|| format!("Unknown format: {format}"))?;
    let root = canonical_root(root)?;
    let parent = resolve(&root, dir)?;
    if !parent.is_dir() {
        return Err("Target folder does not exist".into());
    }

    // Environment-only imports (e.g. a Postman environment file) create no folder.
    if result.requests.is_empty() {
        return Ok(ImportSummary { folder: String::new(), written: 0 });
    }

    let title = if result.name.trim().is_empty() { FALLBACK_FOLDER } else { result.name.trim() };
    let base = unique_path(&parent, &safe_folder(title), None);
    fs::create_dir(&base).map_err(|e| format!("Cannot create folder: {e}"))?;

    let mut written = 0u32;
    for item in &result.requests {
        let mut target = base.clone();
        for segment in item.folder.split('/').filter(|s| !s.trim().is_empty()) {
            target.push(safe_folder(segment));
        }
        fs::create_dir_all(&target).map_err(|e| format!("Cannot create folder: {e}"))?;
        let name = if item.request.name.trim().is_empty() { "request" } else { item.request.name.as_str() };
        let path = unique_path(&target, &slug(name), Some(format.ext()));
        write_file(&path, &item.request)?;
        written += 1;
    }

    let rel = base.strip_prefix(&root).unwrap_or(&base);
    let folder = rel.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect::<Vec<_>>().join("/");
    Ok(ImportSummary { folder, written })
}

#[derive(Default)]
struct Node {
    requests: Vec<Value>,
    folders: BTreeMap<String, Node>,
}

impl Node {
    fn into_items(self) -> Vec<Value> {
        let mut items: Vec<Value> = self
            .folders
            .into_iter()
            .map(|(name, node)| serde_json::json!({ "name": name, "item": node.into_items() }))
            .collect();
        items.extend(self.requests);
        items
    }
}

pub fn export_postman(root: &str) -> Res<String> {
    let root_path = canonical_root(root)?;
    let mut tree = Node::default();
    for node in list(root)?.into_iter().filter(|n| n.kind == "request") {
        let path = resolve(&root_path, &node.path)?;
        let Ok(req) = read_file(&path) else { continue };
        let mut at = &mut tree;
        let mut segments: Vec<&str> = node.path.split('/').collect();
        segments.pop();
        for seg in segments {
            at = at.folders.entry(seg.to_string()).or_default();
        }
        at.requests.push(request_to_postman(&req));
    }
    let name = Path::new(&root_path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "DeadLetter".into());
    serde_json::to_string_pretty(&collection(&name, tree.into_items())).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::collection::interop::parse_document;
    use crate::collection::model::{RequestFile, RequestHeader};

    fn tmp(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("deadletter-interop-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    const POSTMAN: &str = r#"{ "info": { "name": "Shop: v1", "schema": "postman" }, "item": [
        { "name": "Users", "item": [
            { "name": "List", "request": { "method": "GET", "url": "http://x/users" } },
            { "name": "List", "request": { "method": "GET", "url": "http://x/users2" } } ] },
        { "name": "Ping", "request": { "method": "GET", "url": "http://x/ping" } } ] }"#;

    #[test]
    fn writes_a_nested_collection_with_unique_names() {
        let dir = tmp("write");
        let root = dir.to_str().unwrap();
        let result = parse_document(POSTMAN).unwrap();
        let summary = write_import(root, "", &result, "http").unwrap();
        assert_eq!(summary.written, 3);
        assert_eq!(summary.folder, "Shop v1");
        assert!(dir.join("Shop v1/Users/List.http").is_file());
        assert!(dir.join("Shop v1/Users/List-2.http").is_file());
        assert!(dir.join("Shop v1/Ping.http").is_file());

        // A second import never overwrites the first.
        let again = write_import(root, "", &result, "json").unwrap();
        assert_eq!(again.folder, "Shop v1-2");
        assert!(dir.join("Shop v1-2/Users/List.json").is_file());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn hostile_folder_names_cannot_escape() {
        let dir = tmp("escape");
        let mut result = parse_document(POSTMAN).unwrap();
        for r in &mut result.requests {
            r.folder = "../../evil/..\\x/CON".into();
        }
        write_import(dir.to_str().unwrap(), "", &result, "http").unwrap();
        let outside = dir.parent().unwrap().join("evil");
        assert!(!outside.exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn exports_the_workspace_as_postman() {
        let dir = tmp("export");
        let root = dir.to_str().unwrap();
        let result = parse_document(POSTMAN).unwrap();
        write_import(root, "", &result, "http").unwrap();
        fs::write(
            dir.join("top.json"),
            serde_json::to_string(&RequestFile {
                name: "Top".into(),
                method: "POST".into(),
                url: "http://x/top".into(),
                headers: vec![RequestHeader { name: "A".into(), value: "1".into(), enabled: true }],
                body: Some("{}".into()),
            })
            .unwrap(),
        )
        .unwrap();

        let text = export_postman(root).unwrap();
        let back = parse_document(&text).unwrap();
        assert_eq!(back.requests.len(), 4);
        assert!(back.requests.iter().any(|r| r.folder == "Shop v1/Users" && r.request.url == "http://x/users2"));
        assert!(back.requests.iter().any(|r| r.folder.is_empty() && r.request.name == "Top"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_unknown_documents_with_a_helpful_message() {
        assert!(parse_document("just: some\nother: yaml").unwrap_err().contains("Unrecognized"));
        assert!(parse_document("[1,2]").unwrap_err().contains("Unrecognized"));
        assert!(parse_document("  ").unwrap_err().contains("empty"));
        assert!(parse_document("curl http://x").unwrap_err().contains("cURL"));
        assert!(parse_document("{\"a\":1}").unwrap_err().contains("Unrecognized"));
        assert!(parse_document("{nope").unwrap_err().contains("Invalid JSON"));
    }
}

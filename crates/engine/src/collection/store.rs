//! Filesystem operations for a workspace folder. Every public function takes the
//! workspace root plus a root-relative `/`-separated path and refuses anything that
//! could resolve outside the root.

use std::fs;
use std::path::{Component, Path, PathBuf};

use super::model::{Format, RequestFile, TreeNode};

const MAX_DEPTH: usize = 16;
const SKIPPED_DIRS: [&str; 3] = ["node_modules", "target", "dist"];
const RESERVED: [&str; 8] = ["con", "prn", "aux", "nul", "com1", "com2", "lpt1", "lpt2"];

type Res<T> = Result<T, String>;

pub(super) fn canonical_root(root: &str) -> Res<PathBuf> {
    fs::canonicalize(root).map_err(|e| format!("Workspace folder is not accessible: {e}"))
}

/// Joins `rel` onto `root`, rejecting absolute paths, `..`, drive prefixes and
/// anything that would escape the root through a symlink.
pub fn resolve(root: &Path, rel: &str) -> Res<PathBuf> {
    let mut out = root.to_path_buf();
    for comp in Path::new(rel).components() {
        match comp {
            Component::Normal(part) => {
                if part.to_string_lossy().contains(':') {
                    return Err(format!("Invalid path: {rel}"));
                }
                out.push(part);
            }
            Component::CurDir => {}
            _ => return Err(format!("Invalid path: {rel}")),
        }
    }
    let probe = if out.exists() { Some(out.as_path()) } else { out.parent() };
    let inside = probe
        .and_then(|p| fs::canonicalize(p).ok())
        .is_some_and(|p| p.starts_with(root));
    if inside {
        Ok(out)
    } else {
        Err(format!("Path is outside the workspace: {rel}"))
    }
}

fn resolve_entry(root: &Path, rel: &str) -> Res<PathBuf> {
    if rel.trim_matches('/').is_empty() {
        return Err("Refusing to operate on the workspace root".into());
    }
    resolve(root, rel)
}

pub(super) fn rel_string(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

/// File-name friendly version of a request name: `Create user!` -> `Create-user`.
pub fn slug(name: &str) -> String {
    let mut out = String::new();
    for c in name.trim().chars() {
        if c.is_alphanumeric() || c == '_' {
            out.push(c);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let mut out: String = out.trim_matches('-').chars().take(64).collect();
    if out.is_empty() || RESERVED.contains(&out.to_lowercase().as_str()) {
        out.push_str("request");
    }
    out
}

/// Folder names keep spaces but lose characters that are illegal on common filesystems.
pub(super) fn folder_name(name: &str) -> Res<String> {
    let cleaned: String = name
        .chars()
        .filter(|c| !c.is_control() && !"<>:\"/\\|?*".contains(*c))
        .collect();
    let cleaned = cleaned.trim().trim_end_matches('.').to_string();
    if cleaned.is_empty() || cleaned.starts_with('.') || RESERVED.contains(&cleaned.to_lowercase().as_str()) {
        return Err(format!("Invalid folder name: {name}"));
    }
    Ok(cleaned)
}

pub(super) fn unique_path(dir: &Path, stem: &str, ext: Option<&str>) -> PathBuf {
    let file = |s: &str| match ext {
        Some(e) => format!("{s}.{e}"),
        None => s.to_string(),
    };
    let mut candidate = dir.join(file(stem));
    let mut n = 2;
    while candidate.exists() {
        candidate = dir.join(file(&format!("{stem}-{n}")));
        n += 1;
    }
    candidate
}

pub(super) fn read_file(path: &Path) -> Res<RequestFile> {
    let format = Format::from_path(path).ok_or("Unsupported file type (expected .json or .http)")?;
    let text = fs::read_to_string(path).map_err(|e| format!("Cannot read file: {e}"))?;
    let mut req = format.parse(&text)?;
    if req.name.trim().is_empty() {
        req.name = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    }
    Ok(req)
}

/// Write-then-rename so a crash or a watching tool never sees a half-written file.
pub(super) fn write_atomic(path: &Path, contents: &str) -> Res<()> {
    let file_name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let tmp = path.with_file_name(format!(".{file_name}.tmp"));
    fs::write(&tmp, contents).map_err(|e| format!("Cannot write file: {e}"))?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("Cannot write file: {e}")
    })
}

pub(super) fn write_file(path: &Path, req: &RequestFile) -> Res<()> {
    let format = Format::from_path(path).ok_or("Unsupported file type (expected .json or .http)")?;
    write_atomic(path, &format.serialize(req))
}

pub fn list(root: &str) -> Res<Vec<TreeNode>> {
    let root = canonical_root(root)?;
    let mut nodes = Vec::new();
    walk(&root, &root, 0, &mut nodes);
    Ok(nodes)
}

fn walk(root: &Path, dir: &Path, depth: usize, out: &mut Vec<TreeNode>) {
    if depth > MAX_DEPTH {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|e| e.file_name().to_string_lossy().to_lowercase());

    let mut subdirs = Vec::new();
    for entry in entries {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        // `file_type` does not follow symlinks, so links are skipped and cannot loop or escape.
        let Ok(kind) = entry.file_type() else { continue };
        let path = entry.path();
        if kind.is_dir() {
            if !SKIPPED_DIRS.contains(&name.as_str()) {
                subdirs.push(path);
            }
        } else if kind.is_file() {
            if let Some(node) = request_node(root, &path) {
                out.push(node);
            }
        }
    }
    // Emit folders after the files of their parent; the UI orders them as it likes.
    for sub in subdirs {
        out.push(TreeNode {
            path: rel_string(root, &sub),
            name: sub.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
            kind: "folder".into(),
            format: None,
            method: None,
        });
        walk(root, &sub, depth + 1, out);
    }
}

fn request_node(root: &Path, path: &Path) -> Option<TreeNode> {
    let format = Format::from_path(path)?;
    let stem = path.file_stem()?.to_string_lossy().into_owned();
    let parsed = read_file(path);
    let (name, method) = match parsed {
        Ok(req) => (req.name, Some(req.method.to_uppercase())),
        // Stray .json files (package.json...) are not requests: hide them.
        // A broken .http file stays visible so the user can open it and see why.
        Err(_) if format == Format::Json => return None,
        Err(_) => (stem, None),
    };
    Some(TreeNode {
        path: rel_string(root, path),
        name,
        kind: "request".into(),
        format: Some(format.ext().into()),
        method,
    })
}

pub fn read_request(root: &str, rel: &str) -> Res<RequestFile> {
    let root = canonical_root(root)?;
    read_file(&resolve_entry(&root, rel)?)
}

pub fn write_request(root: &str, rel: &str, req: &RequestFile) -> Res<()> {
    let root = canonical_root(root)?;
    write_file(&resolve_entry(&root, rel)?, req)
}

pub fn create_request(root: &str, dir: &str, name: &str, format: &str) -> Res<String> {
    let root = canonical_root(root)?;
    let format = Format::from_ext(format).ok_or_else(|| format!("Unknown format: {format}"))?;
    let dir = resolve(&root, dir)?;
    if !dir.is_dir() {
        return Err("Target folder does not exist".into());
    }
    let path = unique_path(&dir, &slug(name), Some(format.ext()));
    let req = RequestFile {
        name: name.trim().to_string(),
        method: "GET".into(),
        url: String::new(),
        headers: vec![],
        body: None,
        ..Default::default()
    };
    write_file(&path, &req)?;
    Ok(rel_string(&root, &path))
}

pub fn create_folder(root: &str, dir: &str, name: &str) -> Res<String> {
    let root = canonical_root(root)?;
    let dir = resolve(&root, dir)?;
    if !dir.is_dir() {
        return Err("Target folder does not exist".into());
    }
    let path = unique_path(&dir, &folder_name(name)?, None);
    fs::create_dir(&path).map_err(|e| format!("Cannot create folder: {e}"))?;
    Ok(rel_string(&root, &path))
}

pub fn rename_entry(root: &str, rel: &str, new_name: &str) -> Res<String> {
    let root = canonical_root(root)?;
    let path = resolve_entry(&root, rel)?;
    let parent = path.parent().ok_or("Invalid path")?.to_path_buf();

    if path.is_dir() {
        let target = parent.join(folder_name(new_name)?);
        if target != path {
            if target.exists() {
                return Err("A folder with that name already exists".into());
            }
            fs::rename(&path, &target).map_err(|e| format!("Cannot rename folder: {e}"))?;
        }
        return Ok(rel_string(&root, &target));
    }

    let ext = path.extension().map(|e| e.to_string_lossy().into_owned());
    let mut req = read_file(&path)?;
    req.name = new_name.trim().to_string();
    let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let wanted = slug(new_name);
    // Keep the current file (and its `-2` style suffix) when the slug is unchanged.
    let target = if stem == wanted || stem.strip_prefix(&format!("{wanted}-")).is_some_and(|n| n.parse::<u32>().is_ok()) {
        path.clone()
    } else {
        unique_path(&parent, &wanted, ext.as_deref())
    };
    write_file(&target, &req)?;
    if target != path {
        fs::remove_file(&path).map_err(|e| format!("Cannot remove old file: {e}"))?;
    }
    Ok(rel_string(&root, &target))
}

pub fn delete_entry(root: &str, rel: &str) -> Res<()> {
    let root = canonical_root(root)?;
    let path = resolve_entry(&root, rel)?;
    if path.is_dir() {
        fs::remove_dir_all(&path).map_err(|e| format!("Cannot delete folder: {e}"))
    } else {
        fs::remove_file(&path).map_err(|e| format!("Cannot delete file: {e}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Tmp(PathBuf);
    impl Tmp {
        fn new(tag: &str) -> Tmp {
            let dir = std::env::temp_dir().join(format!("deadletter-test-{tag}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            Tmp(dir)
        }
        fn root(&self) -> &str {
            self.0.to_str().unwrap()
        }
    }
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn slug_is_filesystem_safe() {
        assert_eq!(slug("Create user!"), "Create-user");
        assert_eq!(slug("  "), "request");
        assert_eq!(slug("CON"), "CONrequest");
        assert_eq!(slug("a/b\\c"), "a-b-c");
    }

    #[test]
    fn resolve_rejects_escapes() {
        let t = Tmp::new("resolve");
        let root = fs::canonicalize(t.root()).unwrap();
        assert!(resolve(&root, "../x").is_err());
        assert!(resolve(&root, "/etc/passwd").is_err());
        assert!(resolve(&root, "a/../../x").is_err());
        assert!(resolve(&root, "C:/x").is_err());
        fs::create_dir(root.join("a")).unwrap();
        assert!(resolve(&root, "a/b.http").is_ok());
        assert!(resolve_entry(&root, "").is_err());
    }

    #[test]
    fn create_list_read_write_rename_delete_both_formats() {
        let t = Tmp::new("crud");
        for fmt in ["json", "http"] {
            let p = create_request(t.root(), "", "Get users", fmt).unwrap();
            assert_eq!(p, format!("Get-users.{fmt}"));

            let mut req = read_request(t.root(), &p).unwrap();
            req.url = "http://x/users".into();
            req.body = Some("{}".into());
            write_request(t.root(), &p, &req).unwrap();
            assert_eq!(read_request(t.root(), &p).unwrap(), req);

            let renamed = rename_entry(t.root(), &p, "List users").unwrap();
            assert_eq!(renamed, format!("List-users.{fmt}"));
            assert_eq!(read_request(t.root(), &renamed).unwrap().name, "List users");
            assert!(read_request(t.root(), &p).is_err());

            delete_entry(t.root(), &renamed).unwrap();
        }
        assert!(list(t.root()).unwrap().is_empty());
    }

    #[test]
    fn names_are_made_unique() {
        let t = Tmp::new("unique");
        let a = create_request(t.root(), "", "Same", "http").unwrap();
        let b = create_request(t.root(), "", "Same", "http").unwrap();
        assert_eq!((a.as_str(), b.as_str()), ("Same.http", "Same-2.http"));
    }

    #[test]
    fn list_nests_hides_noise_and_keeps_broken_http() {
        let t = Tmp::new("list");
        let folder = create_folder(t.root(), "", "Auth service").unwrap();
        create_request(t.root(), &folder, "Login", "json").unwrap();
        fs::write(t.0.join("package.json"), r#"{"name":"x"}"#).unwrap();
        fs::write(t.0.join("broken.http"), "FETCH nope").unwrap();
        fs::create_dir(t.0.join(".git")).unwrap();
        fs::create_dir(t.0.join("node_modules")).unwrap();

        let nodes = list(t.root()).unwrap();
        let paths: Vec<_> = nodes.iter().map(|n| n.path.as_str()).collect();
        assert!(paths.contains(&"Auth service"));
        assert!(paths.contains(&"Auth service/Login.json"));
        assert!(paths.contains(&"broken.http"));
        assert!(!paths.contains(&"package.json"));
        assert!(!paths.iter().any(|p| p.contains(".git") || p.contains("node_modules")));
    }

    #[test]
    fn rename_folder_and_delete_folder() {
        let t = Tmp::new("folder");
        let f = create_folder(t.root(), "", "Old").unwrap();
        let g = rename_entry(t.root(), &f, "New name").unwrap();
        assert_eq!(g, "New name");
        delete_entry(t.root(), &g).unwrap();
        assert!(list(t.root()).unwrap().is_empty());
    }
}

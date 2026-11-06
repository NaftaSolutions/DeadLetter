//! Environments: named sets of variables stored under `<workspace>/.deadletter/environments/`.
//!
//! `<slug>.json` is meant for git. Values of variables marked `secret` are kept out of it
//! and live in `<slug>.secrets.json`, which a generated `.gitignore` excludes.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use napi_derive::napi;
use serde::{Deserialize, Serialize};

use super::store::{canonical_root, slug, write_atomic};

type Res<T> = Result<T, String>;

const DIR: &str = ".deadletter/environments";

fn enabled_by_default() -> bool {
    true
}

#[napi(object)]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EnvVariable {
    pub name: String,
    pub value: String,
    #[serde(default = "enabled_by_default")]
    pub enabled: bool,
    #[serde(default)]
    pub secret: bool,
}

#[napi(object)]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Environment {
    pub name: String,
    #[serde(default)]
    pub variables: Vec<EnvVariable>,
}

/// On-disk shape of the shared file: secret values are never written here.
#[derive(Serialize, Deserialize)]
struct SharedVariable {
    name: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    value: String,
    #[serde(default = "enabled_by_default")]
    enabled: bool,
    #[serde(default)]
    secret: bool,
}

#[derive(Serialize, Deserialize)]
struct SharedFile {
    #[serde(default)]
    name: String,
    #[serde(default)]
    variables: Vec<SharedVariable>,
}

fn env_dir(root: &Path) -> PathBuf {
    root.join(DIR)
}

fn paths(root: &Path, name: &str) -> Res<(PathBuf, PathBuf)> {
    if name.trim().is_empty() {
        return Err("Environment name cannot be empty".into());
    }
    let s = slug(name);
    let dir = env_dir(root);
    Ok((dir.join(format!("{s}.json")), dir.join(format!("{s}.secrets.json"))))
}

fn is_secrets_file(p: &Path) -> bool {
    p.file_name().is_some_and(|n| n.to_string_lossy().ends_with(".secrets.json"))
}

pub fn list(root: &str) -> Res<Vec<String>> {
    let root = canonical_root(root)?;
    let Ok(entries) = fs::read_dir(env_dir(&root)) else { return Ok(Vec::new()) };
    let mut names: Vec<String> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e == "json") && !is_secrets_file(p))
        .filter_map(|p| {
            let text = fs::read_to_string(&p).ok()?;
            let file: SharedFile = serde_json::from_str(&text).ok()?;
            let stem = p.file_stem()?.to_string_lossy().into_owned();
            Some(if file.name.trim().is_empty() { stem } else { file.name })
        })
        .collect();
    names.sort_by_key(|n| n.to_lowercase());
    Ok(names)
}

pub fn read(root: &str, name: &str) -> Res<Environment> {
    let root = canonical_root(root)?;
    let (shared_path, secrets_path) = paths(&root, name)?;
    let text = fs::read_to_string(&shared_path).map_err(|_| format!("Environment not found: {name}"))?;
    let shared: SharedFile = serde_json::from_str(&text).map_err(|e| format!("Invalid environment file: {e}"))?;
    // A missing or corrupt secrets file just means the secrets are not set on this machine.
    let secrets: BTreeMap<String, String> = fs::read_to_string(&secrets_path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default();
    let variables = shared
        .variables
        .into_iter()
        .map(|v| EnvVariable {
            value: if v.secret { secrets.get(&v.name).cloned().unwrap_or_default() } else { v.value },
            name: v.name,
            enabled: v.enabled,
            secret: v.secret,
        })
        .collect();
    let name = if shared.name.trim().is_empty() { name.to_string() } else { shared.name };
    Ok(Environment { name, variables })
}

pub fn write(root: &str, env: &Environment) -> Res<()> {
    let root = canonical_root(root)?;
    let (shared_path, secrets_path) = paths(&root, &env.name)?;
    let dir = env_dir(&root);
    fs::create_dir_all(&dir).map_err(|e| format!("Cannot create environments folder: {e}"))?;

    let ignore = dir.join(".gitignore");
    if !ignore.exists() {
        write_atomic(&ignore, "# Local secret values, never commit these.\n*.secrets.json\n")?;
    }

    let mut secrets = BTreeMap::new();
    let mut variables = Vec::new();
    for v in env.variables.iter().filter(|v| !v.name.trim().is_empty()) {
        let name = v.name.trim().to_string();
        if v.secret {
            secrets.insert(name.clone(), v.value.clone());
        }
        variables.push(SharedVariable {
            value: if v.secret { String::new() } else { v.value.clone() },
            name,
            enabled: v.enabled,
            secret: v.secret,
        });
    }

    let shared = SharedFile { name: env.name.trim().to_string(), variables };
    let json = |r: serde_json::Result<String>| r.map_err(|e| e.to_string());
    write_atomic(&shared_path, &(json(serde_json::to_string_pretty(&shared))? + "\n"))?;
    if secrets.is_empty() {
        let _ = fs::remove_file(&secrets_path);
    } else {
        write_atomic(&secrets_path, &(json(serde_json::to_string_pretty(&secrets))? + "\n"))?;
    }
    Ok(())
}

pub fn delete(root: &str, name: &str) -> Res<()> {
    let root = canonical_root(root)?;
    let (shared_path, secrets_path) = paths(&root, name)?;
    fs::remove_file(&shared_path).map_err(|e| format!("Cannot delete environment: {e}"))?;
    let _ = fs::remove_file(&secrets_path);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("deadletter-env-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn var(name: &str, value: &str, secret: bool) -> EnvVariable {
        EnvVariable { name: name.into(), value: value.into(), enabled: true, secret }
    }

    #[test]
    fn secrets_stay_out_of_the_shared_file() {
        let dir = tmp("secrets");
        let root = dir.to_str().unwrap();
        let env = Environment {
            name: "Staging".into(),
            variables: vec![var("host", "staging.test", false), var("token", "hunter2", true)],
        };
        write(root, &env).unwrap();

        let shared = fs::read_to_string(dir.join(".deadletter/environments/Staging.json")).unwrap();
        assert!(shared.contains("staging.test"));
        assert!(!shared.contains("hunter2"));
        let ignore = fs::read_to_string(dir.join(".deadletter/environments/.gitignore")).unwrap();
        assert!(ignore.contains("*.secrets.json"));

        assert_eq!(read(root, "Staging").unwrap(), env);
        assert_eq!(list(root).unwrap(), vec!["Staging"]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_secrets_file_yields_empty_values_and_delete_cleans_up() {
        let dir = tmp("missing");
        let root = dir.to_str().unwrap();
        write(root, &Environment { name: "Dev".into(), variables: vec![var("k", "v", true)] }).unwrap();
        fs::remove_file(dir.join(".deadletter/environments/Dev.secrets.json")).unwrap();
        assert_eq!(read(root, "Dev").unwrap().variables[0].value, "");

        delete(root, "Dev").unwrap();
        assert!(list(root).unwrap().is_empty());
        assert!(read(root, "Dev").is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_empty_names() {
        let dir = tmp("empty");
        assert!(write(dir.to_str().unwrap(), &Environment { name: " ".into(), variables: vec![] }).is_err());
        let _ = fs::remove_dir_all(&dir);
    }
}

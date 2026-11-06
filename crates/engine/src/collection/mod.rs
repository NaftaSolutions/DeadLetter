//! Collections: requests stored as human-readable `.json` / `.http` files in a
//! user-chosen workspace folder.

mod environment;
mod http_format;
mod json_format;
mod model;
mod store;
mod watcher;


use napi::{Error, Result, Status};
use environment::Environment;
use model::{RequestFile, TreeNode};
use napi_derive::napi;

fn fail<T>(r: std::result::Result<T, String>) -> Result<T> {
    r.map_err(|msg| Error::new(Status::GenericFailure, msg))
}

/// Flat listing of every folder and request below `root` (relative `/` paths).
#[napi]
pub fn list_collection(root: String) -> Result<Vec<TreeNode>> {
    fail(store::list(&root))
}

#[napi]
pub fn read_request(root: String, path: String) -> Result<RequestFile> {
    fail(store::read_request(&root, &path))
}

/// Saves in the format implied by the file extension of `path`.
#[napi]
pub fn write_request(root: String, path: String, request: RequestFile) -> Result<()> {
    fail(store::write_request(&root, &path, &request))
}

/// Creates an empty request; `format` is `"json"` or `"http"`. Returns its relative path.
#[napi]
pub fn create_request(root: String, dir: String, name: String, format: String) -> Result<String> {
    fail(store::create_request(&root, &dir, &name, &format))
}

#[napi]
pub fn create_folder(root: String, dir: String, name: String) -> Result<String> {
    fail(store::create_folder(&root, &dir, &name))
}

/// Renames a request (file name and display name) or a folder. Returns the new path.
#[napi]
pub fn rename_entry(root: String, path: String, new_name: String) -> Result<String> {
    fail(store::rename_entry(&root, &path, &new_name))
}

#[napi]
pub fn delete_entry(root: String, path: String) -> Result<()> {
    fail(store::delete_entry(&root, &path))
}

/// Names of the environments defined in the workspace.
#[napi]
pub fn list_environments(root: String) -> Result<Vec<String>> {
    fail(environment::list(&root))
}

/// Reads an environment with its secret values merged in.
#[napi]
pub fn read_environment(root: String, name: String) -> Result<Environment> {
    fail(environment::read(&root, &name))
}

/// Saves an environment; secret values go to a git-ignored sidecar file.
#[napi]
pub fn write_environment(root: String, environment: Environment) -> Result<()> {
    fail(environment::write(&root, &environment))
}

#[napi]
pub fn delete_environment(root: String, name: String) -> Result<()> {
    fail(environment::delete(&root, &name))
}

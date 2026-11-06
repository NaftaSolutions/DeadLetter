use std::path::Path;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use napi::bindgen_prelude::Function;
use napi::threadsafe_function::ThreadsafeFunctionCallMode;
use napi::{Error, Result, Status};
use napi_derive::napi;
use notify::{recommended_watcher, Event, RecursiveMode, Watcher};

/// Events are coalesced: a burst (editor save, git checkout) triggers a single callback.
const DEBOUNCE: Duration = Duration::from_millis(200);

static ACTIVE: Mutex<Option<notify::RecommendedWatcher>> = Mutex::new(None);

/// Hidden paths (`.git`, our own `.x.tmp` atomic-write files) are noise.
fn is_relevant(event: &Event, root: &Path) -> bool {
    event.paths.iter().any(|p| {
        p.strip_prefix(root)
            .unwrap_or(p)
            .components()
            .all(|c| !c.as_os_str().to_string_lossy().starts_with('.'))
    })
}

/// Starts watching `root` recursively, replacing any previous watch. `on_change`
/// takes no arguments: the UI simply re-lists the collection.
#[napi]
pub fn watch_collection(root: String, on_change: Function<'_, (), ()>) -> Result<()> {
    let tsfn = on_change
        .build_threadsafe_function::<()>()
        .callee_handled::<false>()
        .weak::<true>()
        .build()?;

    let root_path = std::fs::canonicalize(&root)
        .map_err(|e| Error::new(Status::GenericFailure, format!("Workspace folder is not accessible: {e}")))?;
    let (tx, rx) = mpsc::channel::<()>();

    let filter_root = root_path.clone();
    let mut watcher = recommended_watcher(move |res: notify::Result<Event>| {
        if let Ok(event) = res {
            if is_relevant(&event, &filter_root) {
                let _ = tx.send(());
            }
        }
    })
    .map_err(|e| Error::new(Status::GenericFailure, format!("Cannot watch folder: {e}")))?;
    watcher
        .watch(&root_path, RecursiveMode::Recursive)
        .map_err(|e| Error::new(Status::GenericFailure, format!("Cannot watch folder: {e}")))?;

    // The thread ends when the watcher (and with it `tx`) is dropped by the next
    // `watch_collection` / `unwatch_collection` call.
    thread::spawn(move || loop {
        match rx.recv() {
            Ok(()) => {
                // Swallow the rest of the burst.
                loop {
                    match rx.recv_timeout(DEBOUNCE) {
                        Ok(()) => continue,
                        Err(RecvTimeoutError::Timeout) => break,
                        Err(RecvTimeoutError::Disconnected) => return,
                    }
                }
                tsfn.call((), ThreadsafeFunctionCallMode::NonBlocking);
            }
            Err(_) => return,
        }
    });

    *ACTIVE.lock().unwrap_or_else(|e| e.into_inner()) = Some(watcher);
    Ok(())
}

#[napi]
pub fn unwatch_collection() {
    *ACTIVE.lock().unwrap_or_else(|e| e.into_inner()) = None;
}

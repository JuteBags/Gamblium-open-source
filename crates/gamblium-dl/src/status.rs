//! A small file that always holds the download's latest state, so the
//! browser's helper can show progress without holding this program's output.

use serde_json::{json, Map, Value};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

static FILE: OnceLock<PathBuf> = OnceLock::new();
static STATE: Mutex<Option<Map<String, Value>>> = Mutex::new(None);

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

pub fn init(path: PathBuf) {
    let mut m = Map::new();
    m.insert("state".into(), json!("starting"));
    m.insert("pid".into(), json!(std::process::id()));
    *STATE.lock().unwrap() = Some(m);
    let _ = FILE.set(path);
    write();
}

/// Folds one progress event into the state and rewrites the file.
pub fn event(v: &Value) {
    if FILE.get().is_none() {
        return;
    }
    {
        let mut guard = STATE.lock().unwrap();
        let Some(m) = guard.as_mut() else { return };
        let mut set = |k: &str, val: &Value| {
            if !val.is_null() {
                m.insert(k.into(), val.clone());
            }
        };
        match v["event"].as_str().unwrap_or("") {
            "start" => {
                set("state", &json!("running"));
                set("path", &v["path"]);
                set("total", &v["size"]);
                set("sources", &v["sources"]);
                set("kind", &v["kind"]);
            }
            "progress" => {
                set("state", &json!("running"));
                for k in ["done", "total", "speed", "connections", "peers", "up", "uploaded"] {
                    set(k, &v[k]);
                }
            }
            "resume" => set("done", &v["have"]),
            "done" => {
                set("state", &json!("done"));
                set("path", &v["path"]);
                set("done", &v["bytes"]);
                set("total", &v["bytes"]);
                set("seconds", &v["seconds"]);
                set("speed", &v["speed"]);
                set("connections", &v["connections"]);
            }
            "details" => {
                set("peerList", &v["peerList"]);
                set("files", &v["files"]);
            }
            "seeding" => {
                set("state", &json!("seeding"));
                set("speed", &json!(0));
                for k in ["uploaded", "ratio", "peers", "up"] {
                    set(k, &v[k]);
                }
            }
            "error" => {
                set("state", &json!("error"));
                set("error", &v["error"]);
                set("speed", &json!(0));
            }
            _ => {}
        }
    }
    write();
}

fn write() {
    let Some(file) = FILE.get() else { return };
    let mut guard = STATE.lock().unwrap();
    let Some(m) = guard.as_mut() else { return };
    m.insert("updated".into(), json!(now()));
    // Written beside and renamed, so a reader never sees half a file.
    let mut tmp = file.as_os_str().to_owned();
    tmp.push(".tmp");
    if std::fs::write(&tmp, Value::Object(m.clone()).to_string()).is_ok() {
        let _ = std::fs::rename(&tmp, file);
    }
}

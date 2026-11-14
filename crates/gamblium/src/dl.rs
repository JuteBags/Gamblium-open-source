//! Downloads handed over by the browser to `gamblium-dl`.
//!
//! Each download is its own detached program, so it outlives the helper and
//! the extension's worker. Two small files per download in the `downloads`
//! folder under Gamblium's data folder: `<id>.args.json` (what was asked for,
//! enough to start it again) and `<id>.json` (the latest state, written by
//! the downloader itself).

use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// A running download rewrites its state every second; silent for this long
/// means the program is gone.
const GONE_AFTER_SECS: u64 = 20;

pub fn dir() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join("Gamblium").join("downloads"))
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

pub fn valid_id(id: &str) -> bool {
    id.len() == 16 && id.bytes().all(|b| b.is_ascii_hexdigit())
}

fn new_id() -> Result<String, String> {
    let mut b = [0u8; 8];
    getrandom::getrandom(&mut b).map_err(|e| e.to_string())?;
    Ok(b.iter().map(|x| format!("{x:02x}")).collect())
}

/// The file name alone, or nothing if it tries to be a path.
pub fn plain_name(name: &str) -> Option<&str> {
    let ok = !name.is_empty() && name.len() <= 200 && name != "." && name != ".." && !name.chars().any(|c| c.is_control() || "<>:\"|?*/\\".contains(c));
    ok.then_some(name)
}

/// The downloader's arguments for a request from the extension:
/// `{ urls | url, dir, name?, referer?, cookie?, maxConnections? }`.
pub fn args_for(req: &Value) -> Result<Vec<String>, String> {
    let mut urls: Vec<String> = req["urls"].as_array().map(|a| a.iter().filter_map(|u| u.as_str().map(str::to_owned)).collect()).unwrap_or_default();
    if let Some(u) = req["url"].as_str() {
        urls.push(u.to_owned());
    }
    if urls.is_empty() {
        return Err("no address given".into());
    }
    let torrent = urls.iter().any(|u| is_torrent(u));
    if torrent && urls.len() > 1 {
        return Err("one torrent or magnet link at a time".into());
    }
    for u in &urls {
        let web = url::Url::parse(u).map(|p| matches!(p.scheme(), "http" | "https")).unwrap_or(false);
        let magnet = u.starts_with("magnet:?") && !u.contains(char::is_whitespace);
        // A .torrent file the browser has just saved.
        let file = torrent && Path::new(u).is_absolute() && Path::new(u).is_file();
        if !(web || magnet || file) {
            return Err(format!("'{u}' is not a web address, a magnet link or a saved .torrent file"));
        }
    }
    // No folder given (an address pasted into the Downloads page): the user's Downloads.
    let home_downloads = std::env::var_os("USERPROFILE").map(|h| PathBuf::from(h).join("Downloads").to_string_lossy().into_owned());
    let dir = req["dir"].as_str().map(str::to_owned).or(home_downloads).ok_or("'dir' (the folder to save into) is missing")?;
    let dir = dir.as_str();
    if !Path::new(dir).is_absolute() {
        return Err(format!("'{dir}' is not a full folder path"));
    }
    let mut args = urls;
    args.push("--dir".into());
    args.push(dir.to_owned());
    if let Some(name) = req["name"].as_str() {
        args.push("--out".into());
        args.push(plain_name(name).ok_or_else(|| format!("'{name}' is not a plain file name"))?.to_owned());
    }
    // The cookie is not among them: it travels another way (see `spawn`).
    for (key, header) in [("referer", "Referer"), ("userAgent", "User-Agent")] {
        if let Some(v) = req[key].as_str().filter(|v| !v.is_empty()) {
            if v.chars().any(|c| c == '\r' || c == '\n') {
                return Err(format!("'{key}' must be one line"));
            }
            args.push("--header".into());
            args.push(format!("{header}: {v}"));
        }
    }
    if let Some(n) = req["seedMinutes"].as_u64().filter(|_| torrent) {
        args.push("--seed-minutes".into());
        args.push(n.min(24 * 60).to_string());
    }
    if let Some(n) = req["startConnections"].as_u64().filter(|_| !torrent) {
        args.push("--start-connections".into());
        args.push(n.clamp(1, 16).to_string());
    }
    if let Some(n) = req["maxConnections"].as_u64() {
        args.push("--max-connections".into());
        args.push(n.clamp(1, 32).to_string());
    }
    Ok(args)
}

/// Magnet links and .torrent files go to the torrent engine.
pub fn is_torrent(address: &str) -> bool {
    let lower = address.to_ascii_lowercase();
    lower.starts_with("magnet:") || lower.split(['?', '#']).next().unwrap_or("").ends_with(".torrent")
}

fn files(id: &str) -> Result<(PathBuf, PathBuf), String> {
    if !valid_id(id) {
        return Err("that is not a download id".into());
    }
    let d = dir().ok_or("LOCALAPPDATA is not set")?;
    Ok((d.join(format!("{id}.args.json")), d.join(format!("{id}.json"))))
}

/// The login cookie of a request, if it carries one.
pub fn cookie_of(req: &Value) -> Result<Option<&str>, String> {
    match req["cookie"].as_str().filter(|v| !v.is_empty()) {
        Some(v) if v.chars().any(|c| c == '\r' || c == '\n') => Err("'cookie' must be one line".into()),
        other => Ok(other),
    }
}

/// The site a download comes from, as the stored login is bound to it.
pub fn site_of(address: &str) -> String {
    url::Url::parse(address).ok().and_then(|u| u.host_str().map(str::to_owned)).unwrap_or_default()
}

fn spawn(id: &str, args: &[String], cookie: Option<&str>) -> Result<(), String> {
    let (_, state) = files(id)?;
    let me = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe = me.with_file_name(if cfg!(windows) { "gamblium-dl.exe" } else { "gamblium-dl" });
    if !exe.is_file() {
        return Err(format!("{} is missing; run `gamblium install` from a current build", exe.display()));
    }
    let mut all = args.to_vec();
    all.extend(["--quiet".into(), "--status-file".into(), state.to_string_lossy().into_owned()]);
    if cookie.is_some() {
        // The downloader deletes the stored login the moment the file is whole.
        all.extend(["--forget-file".into(), crate::vault::file(state.parent().unwrap(), id).to_string_lossy().into_owned()]);
    }
    // Through the environment of the new program only: not on its command
    // line, where other programs could read it.
    if let Some(c) = cookie {
        std::env::set_var("GAMBLIUM_DL_COOKIE", c);
    }
    let started = crate::launch::spawn_detached(&exe, &all).map_err(|e| format!("could not start the downloader: {e}"));
    std::env::remove_var("GAMBLIUM_DL_COOKIE");
    started
}

/// Which profile a download belongs to: its folder, lower case, `\` only.
/// A profile sees, stops and removes its own downloads only (review B-1: a
/// fresh profile listed a test profile's file). Downloads recorded before
/// this have no profile and are shown to none.
pub fn profile_key(dir: &Path) -> String {
    dir.to_string_lossy().to_ascii_lowercase().replace('/', "\\").trim_end_matches('\\').to_owned()
}

/// The folder a profile saves downloads to: `download.default_directory` in its Preferences.
pub fn profile_download_dir(user_data: &Path) -> Option<PathBuf> {
    let text = fs::read_to_string(user_data.join("Default").join("Preferences")).ok()?;
    let prefs: Value = serde_json::from_str(&text).ok()?;
    let dir = PathBuf::from(prefs["download"]["default_directory"].as_str()?);
    dir.is_absolute().then_some(dir)
}

/// For a named session or the agent profile: `Downloads\Gamblium agents\<session>` (or
/// `...\agent`). None for any other profile.
pub fn agent_download_folder(user_data: &Path) -> Option<PathBuf> {
    let lower = user_data.to_string_lossy().to_ascii_lowercase().replace('/', "\\");
    let name = user_data.file_name()?.to_string_lossy().into_owned();
    let who = if lower.contains("\\gamblium\\sessions\\") {
        name
    } else if lower.trim_end_matches('\\').ends_with("agent-profile") {
        "agent".to_owned()
    } else {
        return None;
    };
    let home = PathBuf::from(std::env::var_os("USERPROFILE")?);
    Some(home.join("Downloads").join("Gamblium agents").join(plain_name(&who)?))
}

/// A routing rule's folder: one or more plain names ("Videos", "Work/Reports"), never "..", a
/// drive or an absolute path.
pub fn plain_folder(folder: &str) -> Option<PathBuf> {
    let parts: Vec<&str> = folder.split(['/', '\\']).filter(|p| !p.is_empty()).collect();
    if parts.is_empty() || parts.len() > 4 {
        return None;
    }
    let mut out = PathBuf::new();
    for p in parts {
        out.push(plain_name(p)?);
    }
    Some(out)
}

fn belongs(asked: &Value, profile: &str) -> bool {
    asked["profile"].as_str() == Some(profile)
}

pub fn start(req: &Value, profile: &str) -> Result<Value, String> {
    let args = args_for(req)?;
    let id = new_id()?;
    let (args_file, state_file) = files(&id)?;
    fs::create_dir_all(args_file.parent().unwrap()).map_err(|e| e.to_string())?;
    let cookie = cookie_of(req)?;
    let address = req["url"].as_str().or(req["urls"][0].as_str()).unwrap_or("");
    // The login is kept sealed (vault.rs) for as long as the cookie itself
    // lives, a day at most, so a stopped download can be continued. If it
    // cannot be sealed the download still runs; it just cannot be continued.
    let cookie_until = cookie.and_then(|c| crate::vault::store(args_file.parent().unwrap(), &id, &site_of(address), c, now(), req["cookieExpires"].as_u64()).ok());
    fs::write(&args_file, json!({ "id": id, "args": args, "cookie": cookie.is_some(), "cookieUntil": cookie_until, "started": now(), "url": address, "profile": profile }).to_string()).map_err(|e| e.to_string())?;
    fs::write(&state_file, json!({ "state": "starting", "updated": now() }).to_string()).map_err(|e| e.to_string())?;
    spawn(&id, &args, cookie)?;
    // "id" in a reply belongs to the helper's own message numbering.
    Ok(json!({ "download": id }))
}

/// One download's row: what was asked plus the latest state. A download that
/// says it is running but has gone quiet is reported as stopped.
pub fn describe(asked: &Value, state: &Value, now: u64) -> Value {
    let mut row = state.as_object().cloned().unwrap_or_default();
    // A state file being replaced at that instant can fail to read (Windows): then the start
    // time counts, so a download that just began is not shown as stopped.
    let last = state["updated"].as_u64().or(asked["started"].as_u64()).unwrap_or(0);
    let quiet = now.saturating_sub(last) > GONE_AFTER_SECS;
    if matches!(state["state"].as_str(), Some("running" | "starting" | "seeding") | None) && quiet {
        // A torrent that was sharing and is gone had already finished.
        let was_seeding = state["state"].as_str() == Some("seeding");
        row.insert("state".into(), json!(if was_seeding { "done" } else { "stopped" }));
        row.insert("speed".into(), json!(0));
    }
    row.insert("id".into(), asked["id"].clone());
    row.insert("url".into(), asked["url"].clone());
    row.insert("started".into(), asked["started"].clone());
    // With a login: only while the sealed cookie is still valid.
    let login_ok = asked["cookie"].as_bool() != Some(true) || asked["cookieUntil"].as_u64().map(|u| now < u).unwrap_or(false);
    row.insert("canResume".into(), json!(login_ok));
    row.insert("loginUntil".into(), asked["cookieUntil"].clone());
    Value::Object(row)
}

fn read(path: &Path) -> Value {
    fs::read_to_string(path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null)
}

/// Deletes every stored login whose time is up or whose download is finished.
/// Run when the helper starts and whenever the list is read, so an expired
/// login does not wait on disk for someone to look.
pub fn sweep() {
    let Some(d) = dir() else { return };
    for entry in fs::read_dir(&d).into_iter().flatten().flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(id) = name.strip_suffix(".cookie").filter(|id| valid_id(id)) else { continue };
        let asked = read(&d.join(format!("{id}.args.json")));
        let state = read(&d.join(format!("{id}.json")));
        // No record of the download, past its time, or finished: gone.
        let expired = asked["cookieUntil"].as_u64().map(|u| now() >= u).unwrap_or(true);
        if expired || state["state"].as_str() == Some("done") {
            crate::vault::remove(&d, id);
        }
    }
}

pub fn list(profile: &str) -> Result<Value, String> {
    sweep();
    let d = dir().ok_or("LOCALAPPDATA is not set")?;
    let mut rows = Vec::new();
    for entry in fs::read_dir(&d).into_iter().flatten().flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(id) = name.strip_suffix(".args.json").filter(|id| valid_id(id)) else { continue };
        let (asked, state) = (read(&entry.path()), read(&d.join(format!("{id}.json"))));
        // A stored login goes when its time is up or its download is finished.
        let expired = asked["cookieUntil"].as_u64().map(|u| now() >= u).unwrap_or(true);
        if expired || state["state"].as_str() == Some("done") {
            crate::vault::remove(&d, id);
        }
        if belongs(&asked, profile) {
            rows.push(describe(&asked, &state, now()));
        }
    }
    rows.sort_by_key(|r| std::cmp::Reverse(r["started"].as_u64().unwrap_or(0)));
    let jobs: Vec<Value> = rows.iter().map(job).collect();
    Ok(json!({ "downloads": rows, "jobs": jobs }))
}

/// The row as the Downloads page wants it (`dlView` in extension/ui/pages-logic.js).
pub fn job(row: &Value) -> Value {
    let state = match row["state"].as_str().unwrap_or("") {
        "running" => "downloading",
        "stopped" => "paused",
        "done" => "done",
        "seeding" => "seeding",
        "error" => "error",
        _ => "starting",
    };
    let name = row["path"].as_str().and_then(|p| p.rsplit(['\\', '/']).next()).map(str::to_owned);
    json!({
        "id": row["id"], "url": row["url"], "kind": row["kind"].as_str().unwrap_or("http"), "state": state,
        "peers": row["peers"], "up": row["up"], "uploaded": row["uploaded"], "ratio": row["ratio"],
        // For the torrent's own view: who we are connected to and what is in it.
        "peerList": row["peerList"], "files": row["files"],
        "done": row["done"].as_u64().unwrap_or(0), "size": row["total"], "speed": row["speed"].as_f64().unwrap_or(0.0),
        "connections": row["connections"].as_u64().unwrap_or(0), "sources": row["sources"].as_u64().unwrap_or(1),
        "path": row["path"], "name": name, "error": row["error"], "seconds": row["seconds"], "canResume": row["canResume"], "loginUntil": row["loginUntil"],
    })
}

/// One button of the Downloads page: pause, resume, retry, cancel, remove, open, show.
pub fn action(id: &str, what: &str, profile: &str) -> Result<Value, String> {
    mine(id, profile)?;
    match what {
        "pause" | "stop" => cancel(id),
        "resume" | "retry" => resume(id),
        // Cancel: stop it, take it off the list and remove the half-finished file.
        "cancel" => {
            cancel(id)?;
            let (_, state, _, _) = one(id)?;
            if let Some(path) = state["path"].as_str() {
                for suffix in [".part", ".part.state"] {
                    let _ = fs::remove_file(format!("{path}{suffix}"));
                }
            }
            forget(id)
        }
        "remove" => forget(id),
        // Delete: stop it, remove the file (finished or not) and take it off the list.
        "delete" => {
            let _ = cancel(id);
            let (_, state, _, _) = one(id)?;
            if let Some(path) = state["path"].as_str() {
                for suffix in ["", ".part", ".part.state"] {
                    let _ = fs::remove_file(format!("{path}{suffix}"));
                }
            }
            forget(id)
        }
        "open" | "show" => {
            let (_, state, _, _) = one(id)?;
            // While it is still arriving, "show" points at the half-finished file.
            let part = state["path"].as_str().map(|p| format!("{p}.part"));
            let path = state["path"].as_str().map(str::to_owned).filter(|p| Path::new(p).is_file())
                .or(part.filter(|p| what == "show" && Path::new(p).is_file()))
                .ok_or("the file is not there any more")?;
            let path = path.as_str();
            let mut cmd = std::process::Command::new("explorer.exe");
            if what == "show" {
                cmd.arg(format!("/select,{path}"));
            } else {
                cmd.arg(path);
            }
            cmd.spawn().map_err(|e| e.to_string())?;
            Ok(json!({ "download": id, what: true }))
        }
        other => Err(format!("'{other}' is not something a download can do yet")),
    }
}

/// Refuses a download of another profile, as if it were not there.
pub fn mine(id: &str, profile: &str) -> Result<(), String> {
    let (asked, ..) = one(id)?;
    if belongs(&asked, profile) { Ok(()) } else { Err("no such download".into()) }
}

fn one(id: &str) -> Result<(Value, Value, PathBuf, PathBuf), String> {
    let (args_file, state_file) = files(id)?;
    let asked = read(&args_file);
    if asked.is_null() {
        return Err("no such download".into());
    }
    Ok((asked, read(&state_file), args_file, state_file))
}

fn running(asked: &Value, state: &Value) -> bool {
    matches!(describe(asked, state, now())["state"].as_str(), Some("running" | "starting" | "seeding"))
}

pub fn cancel(id: &str) -> Result<Value, String> {
    let (asked, state, _, state_file) = one(id)?;
    if !running(&asked, &state) {
        return Ok(json!({ "id": id, "skipped": "not running" }));
    }
    let pid = state["pid"].as_u64().ok_or("the download has not said which program it is yet; try again in a second")?;
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // No console window flashes up.
        let _ = std::process::Command::new("taskkill").args(["/PID", &pid.to_string(), "/F"]).creation_flags(0x0800_0000).output();
    }
    #[cfg(not(windows))]
    {
        let _ = std::process::Command::new("kill").arg(pid.to_string()).output();
    }
    let mut m = state.as_object().cloned().unwrap_or_default();
    // Stopping a torrent that was only sharing leaves a finished download.
    let finished = state["state"].as_str() == Some("seeding");
    m.insert("state".into(), json!(if finished { "done" } else { "stopped" }));
    m.insert("speed".into(), json!(0));
    fs::write(&state_file, Value::Object(m).to_string()).map_err(|e| e.to_string())?;
    Ok(json!({ "id": id, "stopped": true }))
}

pub fn resume(id: &str) -> Result<Value, String> {
    let (asked, state, _, _) = one(id)?;
    if running(&asked, &state) {
        return Ok(json!({ "id": id, "skipped": "already running" }));
    }
    if state["state"].as_str() == Some("done") {
        return Ok(json!({ "id": id, "skipped": "already finished" }));
    }
    let args: Vec<String> = asked["args"].as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect()).unwrap_or_default();
    let cookie = if asked["cookie"].as_bool() == Some(true) {
        let until = asked["cookieUntil"].as_u64().ok_or("the login for this download was not stored; start it again from the page")?;
        let dir = dir().ok_or("LOCALAPPDATA is not set")?;
        match crate::vault::load(&dir, id, &site_of(asked["url"].as_str().unwrap_or("")), until, now()) {
            Ok(cookie) => Some(cookie),
            Err(e) => {
                // A sealed login that does not open is of no use to anyone.
                crate::vault::remove(&dir, id);
                return Err(e);
            }
        }
    } else {
        None
    };
    spawn(id, &args, cookie.as_deref())?;
    Ok(json!({ "id": id, "resumed": true }))
}

/// Takes a download off the list. The file itself is not touched.
pub fn forget(id: &str) -> Result<Value, String> {
    let (asked, state, args_file, state_file) = one(id)?;
    if running(&asked, &state) {
        return Err("stop the download first".into());
    }
    if let Some(d) = args_file.parent() {
        crate::vault::remove(d, id);
    }
    let _ = fs::remove_file(args_file);
    let _ = fs::remove_file(state_file);
    Ok(json!({ "id": id, "forgotten": true }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_web_addresses_and_plain_names_reach_the_downloader() {
        let ok = args_for(&json!({ "url": "https://x.org/a.iso", "dir": r"C:\Users\me\Downloads", "name": "a.iso", "referer": "https://x.org/", "cookie": "s=1" })).unwrap();
        // The cookie is never among the arguments.
        assert_eq!(ok, ["https://x.org/a.iso", "--dir", r"C:\Users\me\Downloads", "--out", "a.iso", "--header", "Referer: https://x.org/"]);
        assert_eq!(cookie_of(&json!({ "cookie": "s=1" })).unwrap(), Some("s=1"));
        assert_eq!(cookie_of(&json!({ "cookie": "" })).unwrap(), None);
        assert!(cookie_of(&json!({ "cookie": "a\r\nX: 1" })).is_err());
        assert_eq!(site_of("https://drive.example.com/file?id=1"), "drive.example.com");
        assert!(args_for(&json!({ "url": "file:///C:/secret.txt", "dir": r"C:\d" })).is_err());
        assert!(args_for(&json!({ "url": "--config=evil", "dir": r"C:\d" })).is_err());
        assert!(args_for(&json!({ "url": "https://x.org/a", "dir": "Downloads" })).is_err());
        assert!(args_for(&json!({ "url": "https://x.org/a", "dir": r"C:\d", "name": r"..\..\evil.exe" })).is_err());
        assert!(args_for(&json!({ "url": "https://x.org/a", "dir": r"C:\d", "referer": "a\r\nX-Evil: 1" })).is_err());
        assert!(args_for(&json!({ "dir": r"C:\d" })).is_err());
        let magnet = args_for(&json!({ "url": "magnet:?xt=urn:btih:cab507494d02ebb1178b38f2e9d7be299c86b862", "dir": r"C:\d", "seedMinutes": 30 })).unwrap();
        assert_eq!(magnet, ["magnet:?xt=urn:btih:cab507494d02ebb1178b38f2e9d7be299c86b862", "--dir", r"C:\d", "--seed-minutes", "30"]);
        assert!(args_for(&json!({ "url": "https://x.org/a.iso.torrent", "dir": r"C:\d" })).is_ok());
        assert!(args_for(&json!({ "urls": ["magnet:?xt=urn:btih:aa", "https://x.org/a"], "dir": r"C:\d" })).is_err());
        assert!(args_for(&json!({ "url": "magnet:?xt=urn:btih:aa --config=x", "dir": r"C:\d" })).is_err());
        assert!(args_for(&json!({ "url": r"C:\nowhere\missing.torrent", "dir": r"C:\d" })).is_err());
        assert!(args_for(&json!({ "url": "https://x.org/a", "dir": r"C:\d", "seedMinutes": 30 })).unwrap().iter().all(|a| a != "--seed-minutes"));
        let home = PathBuf::from(std::env::var_os("USERPROFILE").unwrap()).join("Downloads").join("Gamblium agents");
        assert_eq!(agent_download_folder(Path::new(r"C:\Users\me\AppData\Local\Gamblium\sessions\shop")), Some(home.join("shop")));
        assert_eq!(agent_download_folder(Path::new(r"C:\Users\me\AppData\Local\Gamblium\agent-profile")), Some(home.join("agent")));
        assert_eq!(agent_download_folder(Path::new(r"C:\Users\me\AppData\Local\Gamblium\User Data")), None);
        assert_eq!(plain_folder("Videos"), Some(PathBuf::from("Videos")));
        assert_eq!(plain_folder("Work/Reports"), Some(PathBuf::from("Work").join("Reports")));
        assert_eq!(plain_folder(".."), None);
        assert_eq!(plain_folder("a/../../b"), None);
        assert_eq!(plain_folder("C:"), None);
        assert_eq!(plain_folder(""), None);
        // An unreadable state right after the start is not "stopped".
        let row = describe(&json!({ "id": "a", "started": 1000 }), &Value::Null, 1002);
        assert_eq!(row["state"], Value::Null);
        let row = describe(&json!({ "id": "a", "started": 1000 }), &Value::Null, 1000 + GONE_AFTER_SECS + 5);
        assert_eq!(row["state"], json!("stopped"));
        let pasted = args_for(&json!({ "url": "https://x.org/a" })).unwrap();
        assert_eq!(pasted[1], "--dir");
        assert!(pasted[2].ends_with("Downloads"));
        let many = args_for(&json!({ "urls": ["https://a/x", "http://b/x"], "dir": r"C:\d", "maxConnections": 99 })).unwrap();
        assert_eq!(many, ["https://a/x", "http://b/x", "--dir", r"C:\d", "--max-connections", "32"]);
    }

    #[test]
    fn a_download_that_went_quiet_is_shown_as_stopped() {
        let asked = json!({ "id": "00112233445566ff", "url": "https://x.org/a", "started": 100, "cookie": false });
        let live = describe(&asked, &json!({ "state": "running", "updated": 1000, "speed": 5 }), 1005);
        assert_eq!(live["state"], "running");
        assert_eq!(live["canResume"], true);
        // With a login: resumable only while the stored cookie is valid.
        let with_login = json!({ "id": "00112233445566ff", "url": "https://x.org/a", "started": 100, "cookie": true, "cookieUntil": 2000 });
        assert_eq!(describe(&with_login, &json!({ "state": "running", "updated": 1000 }), 1100)["canResume"], true);
        assert_eq!(describe(&with_login, &json!({ "state": "running", "updated": 1000 }), 2000)["canResume"], false);
        let not_stored = json!({ "id": "00112233445566ff", "url": "https://x.org/a", "started": 100, "cookie": true, "cookieUntil": null });
        assert_eq!(describe(&not_stored, &json!({ "state": "running", "updated": 1000 }), 1100)["canResume"], false);
        let gone = describe(&asked, &json!({ "state": "running", "updated": 1000, "speed": 5 }), 1100);
        assert_eq!(gone["state"], "stopped");
        assert_eq!(gone["speed"], 0);
        let done = describe(&asked, &json!({ "state": "done", "updated": 1000 }), 9999);
        assert_eq!(done["state"], "done");
        let j = job(&gone);
        assert_eq!(j["state"], "paused");
        assert_eq!(j["kind"], "http");
        let j = job(&json!({ "id": "x", "state": "running", "path": r"C:\d\a.iso", "total": 10, "done": 4 }));
        assert_eq!((j["state"].as_str(), j["name"].as_str(), j["size"].as_u64()), (Some("downloading"), Some("a.iso"), Some(10)));
        assert!(action("00112233445566ff", "explode", "p").is_err());
        // A download is its profile's alone; one recorded before profiles were kept is nobody's.
        let key = profile_key(Path::new(r"C:\Users\X\AppData\Local\Gamblium\User Data\"));
        assert_eq!(key, r"c:\users\x\appdata\local\gamblium\user data");
        assert_eq!(profile_key(Path::new("C:/Temp/Test")), r"c:\temp\test");
        assert!(belongs(&json!({ "profile": key }), &key));
        assert!(!belongs(&json!({ "profile": r"c:\temp\test" }), &key));
        assert!(!belongs(&json!({ "url": "https://x/" }), &key));
        assert!(valid_id("00112233445566ff"));
        assert!(!valid_id("../../etc"));
        assert!(!valid_id("0011"));
    }
}

//! Gamblium updates itself, as other browsers do (owner, Nov 14 2026): it checks for a newer
//! release, downloads and verifies it in the background, says "Restart to update", and the next
//! start runs the new version.
//!
//! - Releases come from the public repository's GitHub releases (prereleases included while
//!   Gamblium is a beta). Only `Gamblium-Setup-<version>.exe` and its `SHA256SUMS.txt` are used.
//! - The download goes to `Gamblium\updates\<version>\`; the installer's SHA-256 must match
//!   the release's checksum file, or it is deleted and nothing is offered.
//! - `state.json` in `Gamblium\updates` says where things stand, for the extension to show.
//! - Applying: the installer replaces the programs, which cannot happen while they run. So a
//!   copy of this program outside the app folder waits until the browser has closed, runs the
//!   installer silently, and starts Gamblium again.

use serde_json::{json, Value};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

pub const RELEASES: &str = "https://api.github.com/repos/JuteBags/Gamblium-open-source/releases?per_page=15";

pub fn dir() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join("Gamblium").join("updates"))
}

/// (major, minor, patch, is_release, prerelease number): "1.0.0-beta.2" < "1.0.0" < "1.0.1".
pub fn version_key(v: &str) -> Option<(u64, u64, u64, bool, u64)> {
    let v = v.trim().trim_start_matches('v');
    let (main, pre) = match v.split_once('-') {
        Some((m, p)) => (m, Some(p)),
        None => (v, None),
    };
    let mut parts = main.split('.').map(|p| p.parse::<u64>().ok());
    let (a, b, c) = (parts.next()??, parts.next()??, parts.next()??);
    let pre_n = pre.and_then(|p| p.rsplit('.').next()).and_then(|n| n.parse().ok()).unwrap_or(0);
    Some((a, b, c, pre.is_none(), pre_n))
}

pub fn newer(candidate: &str, current: &str) -> bool {
    matches!((version_key(candidate), version_key(current)), (Some(a), Some(b)) if a > b)
}

/// The newest release newer than `current` that carries an installer: (version, installer url, sums url).
pub fn pick(releases: &Value, current: &str) -> Option<(String, String, String)> {
    let mut best: Option<(String, String, String)> = None;
    for r in releases.as_array()? {
        if r["draft"] == true {
            continue;
        }
        let version = r["tag_name"].as_str()?.trim_start_matches('v').to_owned();
        if !newer(&version, current) || best.as_ref().is_some_and(|b| !newer(&version, &b.0)) {
            continue;
        }
        let asset = |want: &dyn Fn(&str) -> bool| {
            r["assets"].as_array().and_then(|a| a.iter().find(|x| x["name"].as_str().is_some_and(want))).and_then(|x| x["browser_download_url"].as_str()).map(str::to_owned)
        };
        let setup = asset(&|n: &str| n.starts_with("Gamblium-Setup-") && n.ends_with(".exe"));
        let sums = asset(&|n: &str| n == "SHA256SUMS.txt");
        if let (Some(setup), Some(sums)) = (setup, sums) {
            best = Some((version, setup, sums));
        }
    }
    best
}

/// A download that is not newer than this program (it was installed meanwhile, or a test asked as
/// an older version) is forgotten: its folder goes and the state says up to date. Run before any
/// status is shown and by every check (tester, Nov 14 2026: a 185 MB leftover stayed "ready").
pub fn forget_stale(current: &str) {
    let Some(d) = dir() else { return };
    for e in fs::read_dir(&d).into_iter().flatten().flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if e.path().is_dir() && version_key(&name).is_some() && !newer(&name, current) {
            let _ = fs::remove_dir_all(e.path());
        }
    }
    let s = state();
    if s["state"] == "ready" && !s["version"].as_str().is_some_and(|v| newer(v, current)) {
        set_state(json!({ "state": "up-to-date", "current": current, "at": s["at"] }));
    }
}

pub fn state() -> Value {
    dir().and_then(|d| fs::read_to_string(d.join("state.json")).ok()).and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(json!({ "state": "idle" }))
}

fn set_state(v: Value) {
    if let Some(d) = dir() {
        let _ = fs::create_dir_all(&d);
        let tmp = d.join("state.json.tmp");
        if fs::write(&tmp, v.to_string()).is_ok() {
            let _ = fs::rename(tmp, d.join("state.json"));
        }
    }
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new().timeout_connect(std::time::Duration::from_secs(15)).timeout_read(std::time::Duration::from_secs(60)).user_agent("gamblium-updater").build()
}

fn sha256_hex(path: &Path) -> std::io::Result<String> {
    use sha2::{Digest, Sha256};
    let mut f = fs::File::open(path)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// Checks, and downloads a newer release if there is one. Meant to run in its own process
/// (`gamblium update --download`); one at a time.
pub fn check_and_download(current: &str) -> Result<Value, String> {
    let d = dir().ok_or("LOCALAPPDATA is not set")?;
    fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    let lock = d.join("busy");
    if lock.exists() && lock.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|a| a.as_secs() < 1800) {
        return Ok(json!({ "state": "busy" }));
    }
    let _ = fs::write(&lock, "");
    let result = (|| {
        set_state(json!({ "state": "checking", "current": current, "at": now() }));
        let text = agent().get(RELEASES).call().map_err(|e| e.to_string())?.into_string().map_err(|e| e.to_string())?;
        let releases: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
        let Some((version, setup_url, sums_url)) = pick(&releases, current) else {
            forget_stale(current);
            let v = json!({ "state": "up-to-date", "current": current, "at": now() });
            set_state(v.clone());
            return Ok(v);
        };
        let target = d.join(&version);
        fs::create_dir_all(&target).map_err(|e| e.to_string())?;
        let name = setup_url.rsplit('/').next().unwrap_or("Gamblium-Setup.exe").to_owned();
        let setup = target.join(&name);
        let sums = agent().get(&sums_url).call().map_err(|e| e.to_string())?.into_string().map_err(|e| e.to_string())?;
        let want = sums.lines().find(|l| l.trim_end().ends_with(&name)).and_then(|l| l.split_whitespace().next()).map(str::to_ascii_lowercase).ok_or("the release's checksum file does not list its installer")?;
        if !(setup.is_file() && sha256_hex(&setup).ok().as_deref() == Some(want.as_str())) {
            set_state(json!({ "state": "downloading", "version": version, "current": current, "at": now() }));
            let part = target.join(format!("{name}.part"));
            let mut body = agent().get(&setup_url).call().map_err(|e| e.to_string())?.into_reader();
            let mut out = fs::File::create(&part).map_err(|e| e.to_string())?;
            std::io::copy(&mut body, &mut out).map_err(|e| e.to_string())?;
            drop(out);
            let got = sha256_hex(&part).map_err(|e| e.to_string())?;
            if got != want {
                let _ = fs::remove_file(&part);
                return Err(format!("the download does not match the release's checksum ({got} against {want}); not offered"));
            }
            fs::rename(&part, &setup).map_err(|e| e.to_string())?;
        }
        // Older downloads are not needed any more.
        for e in fs::read_dir(&d).into_iter().flatten().flatten() {
            if e.path().is_dir() && e.file_name() != std::ffi::OsStr::new(&version) {
                let _ = fs::remove_dir_all(e.path());
            }
        }
        let v = json!({ "state": "ready", "version": version, "current": current, "installer": setup, "at": now() });
        set_state(v.clone());
        Ok(v)
    })();
    let _ = fs::remove_file(&lock);
    if let Err(e) = &result {
        set_state(json!({ "state": "error", "error": e, "current": current, "at": now() }));
    }
    result
}

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// The installer that is ready, if its version is still newer than this program.
pub fn ready_installer(current: &str) -> Option<PathBuf> {
    let s = state();
    if s["state"] != "ready" || !s["version"].as_str().is_some_and(|v| newer(v, current)) {
        return None;
    }
    s["installer"].as_str().map(PathBuf::from).filter(|p| p.is_file())
}

/// Starts the applier: a copy of this program outside the app folder, which waits until no
/// browser of Gamblium's own profile runs, installs silently and starts Gamblium. Returns at once.
pub fn start_apply(installer: &Path, start_after: bool) -> Result<(), String> {
    let d = dir().ok_or("LOCALAPPDATA is not set")?;
    let me = std::env::current_exe().map_err(|e| e.to_string())?;
    let copy = d.join("gamblium-updater.exe");
    fs::copy(&me, &copy).map_err(|e| format!("could not copy the updater: {e}"))?;
    let mut args = vec!["update".to_owned(), "--apply".to_owned(), installer.to_string_lossy().into_owned()];
    if start_after {
        args.push("--start".into());
    }
    crate::launch::spawn_detached(&copy, &args).map_err(|e| e.to_string())
}

/// Every other browser started from Gamblium's browser folder: named sessions are closed their
/// own way (tabs noted, they come back), anything else (the agent profile, test windows) ends.
/// Is any browser started from Gamblium's browser folder running (a session's included)?
pub fn any_gamblium_browser() -> bool {
    let Some(folder) = crate::rebrand::copy_dir() else { return false };
    let folder = folder.to_string_lossy().to_ascii_lowercase();
    crate::procs::browsers("brave.exe").into_iter().any(|(pid, _)| crate::procs::exe_of(pid).is_some_and(|e| e.to_string_lossy().to_ascii_lowercase().starts_with(&folder)))
}

fn stop_other_browsers() {
    let Some(folder) = crate::rebrand::copy_dir() else { return };
    let folder = folder.to_string_lossy().to_ascii_lowercase();
    let ours = || -> Vec<(u32, Option<String>)> {
        crate::procs::browsers("brave.exe")
            .into_iter()
            .filter(|(pid, _)| crate::procs::exe_of(*pid).is_some_and(|e| e.to_string_lossy().to_ascii_lowercase().starts_with(&folder)))
            .collect()
    };
    // All closed at once, each with its own polite wait (review 5, C10: 30 s per window, one after
    // another).
    let mut closing = Vec::new();
    for (_, dir) in ours() {
        let name = dir.as_deref().and_then(|d| {
            let lower = d.to_ascii_lowercase().replace('/', "\\");
            lower.contains("\\gamblium\\sessions\\").then(|| d.trim_end_matches(['\\', '/']).rsplit(['\\', '/']).next().unwrap_or("").to_owned())
        });
        if let Some(name) = name.filter(|n| !n.is_empty()) {
            // Sessions shown in a window come back in one after the update (reopen_sessions).
            if dir.as_deref().is_some_and(|d| crate::sessions::restart_kind(std::path::Path::new(d)) == "window") {
                note_reopen(&name);
            }
            closing.push(std::thread::spawn(move || {
                let _ = crate::sessions::command(&["close".to_owned(), name, "--keep-unpacked".to_owned()]);
            }));
        }
    }
    for t in closing {
        let _ = t.join();
    }
    for _ in 0..20 {
        let left = ours();
        if left.is_empty() {
            return;
        }
        for (pid, _) in left {
            crate::procs::kill_tree(pid);
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
}

/// Run by the copy: waits for the browser of Gamblium's own profile to end (up to 10 minutes),
/// runs the installer silently, then starts Gamblium if asked.
pub fn apply(installer: &Path, start_after: bool) -> Result<(), String> {
    let profile = crate::install::profile_dir().ok_or("LOCALAPPDATA is not set")?;
    // The owner's own Gamblium comes back only if it was open or asked for the update; otherwise
    // the start mode (a No session window, or the last session), and only when nothing else comes
    // back (review 3, A15: every update opened the owner's whole old profile).
    let asked_by_main = asked_by_file().and_then(|f| fs::read_to_string(f).ok()).is_some_and(|t| t.trim() == "main");
    let owner_back = asked_by_main || crate::procs::browser_running("brave.exe", Some(&profile));
    if let Some(f) = asked_by_file() {
        let _ = fs::remove_file(f);
    }
    for _ in 0..1200 {
        if !crate::procs::browser_running("brave.exe", Some(&profile)) {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
    if crate::procs::browser_running("brave.exe", Some(&profile)) {
        // A session that asked has closed itself: it comes back even though nothing was installed
        // (review 3, A7).
        reopen_sessions();
        set_state(json!({ "state": "error", "error": "your own Gamblium stayed open: close it, then Restart to update again", "at": now() }));
        return Err("Gamblium is still open".into());
    }
    // Browsers nobody sees keep the browser's files open and the installer cannot replace them
    // (owner, Nov 14 2026: "could not be set up (code 1)" with a hidden test session running).
    // Packers waiting to start leave (they look every second), then those at work are stopped.
    crate::pack::set_updating(true);
    std::thread::sleep(std::time::Duration::from_secs(2));
    stop_other_browsers();
    // A pack at work holds gamblium.exe open and the installer could not replace it (review 4,
    // B12): each is asked to stop, which leaves its folder as it was.
    for d in crate::sessions::all_profile_dirs() {
        crate::pack::stop_pack(&d, 60);
    }
    set_state(json!({ "state": "installing", "at": now() }));
    let ran = std::process::Command::new(installer).args(["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/SP-"]).status();
    // An installer that could not start (quarantined, locked) still brings the browsers back
    // (review 3, A1: every browser stayed closed and the state stuck at "installing").
    let status = match ran {
        Ok(s) => s,
        Err(e) => {
            crate::pack::set_updating(false);
            set_state(json!({ "state": "error", "error": format!("the installer could not start: {e}"), "at": now() }));
            if start_after {
                start_again(owner_back);
            }
            return Err(format!("the installer could not start: {e}"));
        }
    };
    crate::pack::set_updating(false);
    let ok = status.success();
    if ok {
        set_state(json!({ "state": "installed", "at": now() }));
    } else {
        // The browsers come back on the version that was there (review 2, P0 1.2).
        set_state(json!({ "state": "error", "error": format!("the installer ended with {status}"), "at": now() }));
    }
    if start_after {
        start_again(owner_back);
    } else {
        reopen_sessions();
    }
    if ok {
        Ok(())
    } else {
        Err(format!("the installer ended with {status}"))
    }
}

fn asked_by_file() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join("Gamblium").join("update-asked-by.txt"))
}

/// "Restart to update" was clicked in this browser: "main" (the owner's own Gamblium) or a
/// session's id (noted to open again; review 3, A7: the clicking session closed itself before the
/// updater looked, and stayed closed).
pub fn note_asked_by(who: Option<&str>) {
    let Some(f) = asked_by_file() else { return };
    match who {
        Some("main") => {
            let _ = fs::write(&f, "main");
        }
        Some(id) => {
            let _ = fs::remove_file(&f);
            note_reopen(id);
        }
        None => {
            let _ = fs::remove_file(&f);
        }
    }
}

fn reopen_file() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join("Gamblium").join("reopen-after-update.txt"))
}
/// Takes a session back off the list to reopen (the updater did not start: review 10, H10).
pub fn forget_reopen(id: &str) {
    if let Some(f) = reopen_file() {
        let Ok(list) = std::fs::read_to_string(&f) else { return };
        let kept: String = list.lines().filter(|l| l.split('#').next() != Some(id)).map(|l| format!("{l}\n")).collect();
        let _ = if kept.trim().is_empty() { std::fs::remove_file(&f) } else { std::fs::write(&f, kept) };
    }
}
fn note_reopen(id: &str) {
    if let Some(f) = reopen_file() {
        let mut list = std::fs::read_to_string(&f).unwrap_or_default();
        if !list.lines().any(|l| l.split('#').next() == Some(id)) {
            list.push_str(id);
            list.push('\n');
            let _ = std::fs::write(&f, list);
        }
    }
}
/// After the install: the owner's own Gamblium if it was open or asked (--main: with no
/// arguments the starter opens the start mode instead), the sessions that were in a window, and
/// with neither, what the desktop icon opens (the start mode).
fn start_again(owner_back: bool) {
    let app = std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join("Gamblium").join("app").join("gamblium-app.exe"));
    let sessions_back = reopen_file().is_some_and(|f| fs::read_to_string(f).is_ok_and(|t| t.lines().any(|l| !l.trim().is_empty())));
    if let Some(app) = &app {
        if owner_back {
            let _ = crate::launch::spawn_detached(app, &["--main".to_owned()]);
        } else if !sessions_back {
            let _ = crate::launch::spawn_detached(app, &[]);
        }
    }
    reopen_sessions();
}

/// Sessions that were in a window before the update open in one again.
fn reopen_sessions() {
    let Some(f) = reopen_file() else { return };
    let Ok(list) = std::fs::read_to_string(&f) else { return };
    let Some(cli) = std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join("Gamblium").join("app").join("gamblium.exe")) else { return };
    let mut left = String::new();
    for line in list.lines().filter(|l| !l.is_empty()) {
        // "id" or "id#tries" (an id that did not open at an earlier update).
        let (id, tries) = line.split_once('#').map(|(b, t)| (b, t.parse::<u32>().unwrap_or(0))).unwrap_or((line, 0));
        let bare = id;
        // The installed program, not this copy in the updates folder: from there the extension
        // and presets are not found and a session would not start (review 2, P0 1.1).
        let ok = std::process::Command::new(&cli)
            .args(["cli", "open", id])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|s| s.success());
        crate::launch::relaunch_log(&format!("update: session {id} {}", if ok { "opened again" } else { "did NOT open again (kept in the list)" }));
        // Kept for the next update, at most three times (review 3, A22: replayed for ever).
        if !ok && tries < 2 {
            left.push_str(&format!("{bare}#{}\n", tries + 1));
        }
    }
    if left.is_empty() {
        let _ = std::fs::remove_file(&f);
    } else {
        let _ = std::fs::write(&f, left);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_order_as_releases_do() {
        assert!(newer("1.0.0", "1.0.0-beta.1"));
        assert!(newer("1.0.0-beta.2", "1.0.0-beta.1"));
        assert!(newer("1.0.1", "1.0.0"));
        assert!(newer("v1.1.0", "1.0.9"));
        assert!(!newer("0.8.1", "1.0.0-beta.1"));
        assert!(!newer("1.0.0-beta.1", "1.0.0-beta.1"));
        assert!(!newer("garbage", "1.0.0"));
    }

    #[test]
    fn the_newest_release_with_an_installer_is_picked() {
        let asset = |n: &str| json!({ "name": n, "browser_download_url": format!("https://x/{n}") });
        let releases = json!([
            { "tag_name": "v1.0.1", "draft": true, "assets": [asset("Gamblium-Setup-1.0.1.exe"), asset("SHA256SUMS.txt")] },
            { "tag_name": "v1.0.0", "draft": false, "assets": [asset("Gamblium-Setup-1.0.0.exe"), asset("SHA256SUMS.txt")] },
            { "tag_name": "v1.0.0-beta.2", "draft": false, "assets": [asset("Gamblium-Setup-1.0.0-beta.2.exe"), asset("SHA256SUMS.txt")] },
            { "tag_name": "v0.9.0", "draft": false, "assets": [asset("notes.txt")] },
        ]);
        let (v, setup, sums) = pick(&releases, "1.0.0-beta.1").unwrap();
        assert_eq!(v, "1.0.0");
        assert!(setup.ends_with("Gamblium-Setup-1.0.0.exe") && sums.ends_with("SHA256SUMS.txt"));
        assert!(pick(&releases, "1.0.0").is_none(), "nothing newer");
    }
}

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

/// Run by the copy: waits for the browser of Gamblium's own profile to end (up to 10 minutes),
/// runs the installer silently, then starts Gamblium if asked.
pub fn apply(installer: &Path, start_after: bool) -> Result<(), String> {
    let profile = crate::install::profile_dir().ok_or("LOCALAPPDATA is not set")?;
    for _ in 0..1200 {
        if !crate::procs::browser_running("brave.exe", Some(&profile)) {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
    if crate::procs::browser_running("brave.exe", Some(&profile)) {
        return Err("Gamblium is still open".into());
    }
    set_state(json!({ "state": "installing", "at": now() }));
    let status = std::process::Command::new(installer)
        .args(["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/SP-"])
        .status()
        .map_err(|e| e.to_string())?;
    if !status.success() {
        set_state(json!({ "state": "error", "error": format!("the installer ended with {status}"), "at": now() }));
        return Err(format!("the installer ended with {status}"));
    }
    set_state(json!({ "state": "installed", "at": now() }));
    if start_after {
        if let Some(app) = std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join("Gamblium").join("app").join("gamblium-app.exe")) {
            let _ = crate::launch::spawn_detached(&app, &[]);
        }
    }
    Ok(())
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

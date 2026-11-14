//! "Allow in Private" for the Gamblium extension, switched on without a click.
//!
//! The owner wants Gamblium to work in private and Tor windows too (Nov 12
//! 2026). That switch lives in the protected settings file, so it cannot be
//! written from outside, and no policy sets it. So, once per profile and
//! before the real start, the browser is started with no window, its own
//! extensions page is asked to flip the switch for our extension (the same
//! call the page's own toggle makes), and it is closed again. The browser
//! writes the setting itself, so it is kept.

use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// Written into the profile folder once the switch is on, with the extension's id.
const MARKER: &str = "gamblium-private-access";
/// Written when the attempt failed, so the next starts do not pay for it again (tester, Nov 14
/// 2026: every start of such a profile waited 20 s). The hidden browser's own output is kept in
/// LOG beside it. Deleting the file tries once more.
const FAILED: &str = "gamblium-private-access.failed";
const LOG: &str = "gamblium-private-access.log";

pub fn already_done(profile: &Path, extension_id: &str) -> bool {
    fs::read_to_string(profile.join(MARKER)).map(|t| t.trim() == extension_id).unwrap_or(false)
}

/// Tried before and failed: not tried again until the file is deleted.
pub fn failed_before(profile: &Path, extension_id: &str) -> bool {
    // A failure from the two-pages bug (exit code 13, fixed) is tried again.
    fs::read_to_string(profile.join(FAILED)).map(|t| t.lines().next().map(str::trim) == Some(extension_id) && !t.contains("exit code: 13")).unwrap_or(false)
}

/// The script the extensions page runs: switch private access on, then say
/// whether it is on.
pub fn script(extension_id: &str) -> String {
    format!(
        "new Promise((done) => chrome.developerPrivate.updateExtensionConfiguration({{ extensionId: '{id}', incognitoAccess: true }}, () => \
         chrome.developerPrivate.getExtensionInfo('{id}', (info) => done(JSON.stringify({{ error: chrome.runtime.lastError ? chrome.runtime.lastError.message : null, on: !!(info && info.incognitoAccess && info.incognitoAccess.isActive) }})))))",
        id = extension_id
    )
}

/// The port the hidden browser wrote, or why there is none: it ended (with its exit code), or
/// the wait ran out.
fn read_port(profile: &Path, wait: Duration, child: &mut std::process::Child) -> Result<(u16, String), String> {
    let file = profile.join("DevToolsActivePort");
    let until = Instant::now() + wait;
    while Instant::now() < until {
        // Exit 0 is not a failure: started from an elevated program, the browser starts itself
        // again without elevation and the first process ends cleanly (tester, Nov 14 2026). The
        // port then comes from the second one.
        if let Ok(Some(status)) = child.try_wait() {
            if !status.success() {
                return Err(format!("the hidden browser ended at once ({status}); its output is in {}", profile.join(LOG).display()));
            }
        }
        if let Ok(text) = fs::read_to_string(&file) {
            let mut lines = text.lines();
            if let (Some(port), Some(path)) = (lines.next().and_then(|p| p.trim().parse().ok()), lines.next()) {
                return Ok((port, path.trim().to_owned()));
            }
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Err(format!("the hidden browser did not come up within {} s", wait.as_secs()))
}

type Socket = tungstenite::WebSocket<tungstenite::stream::MaybeTlsStream<std::net::TcpStream>>;

/// Sends one command and waits for its answer, skipping events.
fn call(ws: &mut Socket, id: u64, method: &str, params: Value, session: Option<&str>) -> Result<Value, String> {
    let mut msg = json!({ "id": id, "method": method, "params": params });
    if let Some(s) = session {
        msg["sessionId"] = json!(s);
    }
    ws.send(tungstenite::Message::Text(msg.to_string().into())).map_err(|e| e.to_string())?;
    let until = Instant::now() + Duration::from_secs(15);
    while Instant::now() < until {
        let text = match ws.read().map_err(|e| e.to_string())? {
            tungstenite::Message::Text(t) => t.to_string(),
            _ => continue,
        };
        let v: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
        if v["id"].as_u64() == Some(id) {
            if !v["error"].is_null() {
                return Err(format!("{method}: {}", v["error"]["message"].as_str().unwrap_or("failed")));
            }
            return Ok(v["result"].clone());
        }
    }
    Err(format!("{method}: no answer"))
}

/// Starts the browser hidden on this profile, flips the switch, closes it.
/// `args` are the switches the real start will use (extension, profile folder).
pub fn allow(browser: &Path, profile: &Path, args: &[String], extension_id: &str) -> Result<(), String> {
    let _ = fs::remove_file(profile.join("DevToolsActivePort"));
    // Switches only: a page the real start opens (`-- <url>`, a link from another program) would
    // make two with the about:blank below, and a headless browser refuses more than one ("Multiple
    // targets are not supported in headless mode", exit 13; tester, Nov 14 2026).
    let mut all: Vec<String> = args.iter().filter(|a| a.starts_with("--") && !a.starts_with("--remote-debugging-port")).cloned().collect();
    // Port 0: the browser picks a free one and writes it into the profile folder.
    all.extend(["--headless=new".into(), "--remote-debugging-port=0".into(), "--no-first-run".into(), "about:blank".into()]);
    // A profile that never ran has no tabs to remember. The two this unseen
    // start opens (a blank one and the extensions page) must not come back as
    // "your last tabs" at the real start (package check: they did).
    let sessions = profile.join("Default").join("Sessions");
    let had_tabs = sessions.is_dir();
    let _ = fs::create_dir_all(profile);
    let log = fs::File::create(profile.join(LOG)).map(std::process::Stdio::from).unwrap_or_else(|_| std::process::Stdio::null());
    let mut child = std::process::Command::new(browser)
        .args(&all)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(log)
        .spawn()
        .map_err(|e| format!("could not start the browser: {e}"))?;
    let result = (|| {
        // A healthy start writes its port in about half a second.
        let (port, path) = read_port(profile, Duration::from_secs(8), &mut child)?;
        let (mut ws, _) = tungstenite::connect(format!("ws://127.0.0.1:{port}{path}")).map_err(|e| e.to_string())?;
        let target = call(&mut ws, 1, "Target.createTarget", json!({ "url": "chrome://extensions/" }), None)?;
        let target_id = target["targetId"].as_str().ok_or("no page")?.to_owned();
        let attached = call(&mut ws, 2, "Target.attachToTarget", json!({ "targetId": target_id, "flatten": true }), None)?;
        let session = attached["sessionId"].as_str().ok_or("no session")?.to_owned();
        // The page and the extension need a moment; ask until the extension is known.
        let mut last = String::new();
        for attempt in 0..12u64 {
            std::thread::sleep(Duration::from_millis(700));
            let r = call(&mut ws, 10 + attempt, "Runtime.evaluate", json!({ "expression": script(extension_id), "awaitPromise": true, "returnByValue": true }), Some(&session));
            match r {
                Ok(v) => {
                    let answer: Value = serde_json::from_str(v["result"]["value"].as_str().unwrap_or("{}")).unwrap_or_default();
                    if answer["on"].as_bool() == Some(true) {
                        let _ = call(&mut ws, 99, "Browser.close", json!({}), None);
                        return Ok(());
                    }
                    last = answer.to_string();
                }
                Err(e) => last = e,
            }
        }
        let _ = call(&mut ws, 99, "Browser.close", json!({}), None);
        Err(format!("the switch did not turn on ({last})"))
    })();
    // Give it a moment to write its settings and leave; then make sure it is gone.
    let until = Instant::now() + Duration::from_secs(8);
    while Instant::now() < until && matches!(child.try_wait(), Ok(None)) {
        std::thread::sleep(Duration::from_millis(200));
    }
    let _ = child.kill();
    let _ = child.wait();
    let _ = fs::remove_file(profile.join("DevToolsActivePort"));
    if !had_tabs {
        let _ = fs::remove_dir_all(&sessions);
    }
    // It was stopped, not closed: without this the real start offers to restore.
    let _ = crate::launch::mark_clean_exit(profile);
    match &result {
        Ok(()) => {
            let _ = fs::write(profile.join(MARKER), extension_id);
            let _ = fs::remove_file(profile.join(FAILED));
            let _ = fs::remove_file(profile.join(LOG));
        }
        Err(e) => {
            let _ = fs::write(profile.join(FAILED), format!("{extension_id}\n{e}\n"));
        }
    }
    result
}

#[allow(dead_code)]
pub fn marker_path(profile: &Path) -> PathBuf {
    profile.join(MARKER)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_marker_is_per_extension() {
        let dir = std::env::temp_dir().join(format!("gamblium-private-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        assert!(!already_done(&dir, "abc"));
        fs::write(dir.join(MARKER), "abc\n").unwrap();
        assert!(already_done(&dir, "abc"));
        assert!(!already_done(&dir, "other"));
        assert!(!failed_before(&dir, "abc"));
        fs::write(dir.join(FAILED), "abc\nthe hidden browser ended at once\n").unwrap();
        assert!(failed_before(&dir, "abc") && !failed_before(&dir, "other"));
        fs::write(dir.join(FAILED), "abc
the hidden browser ended at once (exit code: 13)
").unwrap();
        assert!(!failed_before(&dir, "abc"), "the fixed two-pages failure is tried again");
        fs::remove_dir_all(&dir).unwrap();
        let s = script("pbgbdlkcienglhbfadbjolphinilbpia");
        assert!(s.contains("incognitoAccess: true") && s.contains("'pbgbdlkcienglhbfadbjolphinilbpia'"));
    }
}

//! Native-messaging host: lets the Gamblium extension use the Rust tools.
//!
//! The browser starts this program and talks to it over stdin/stdout. Each
//! message is a 4-byte little-endian length followed by that many bytes of
//! JSON. Requests carry a "type" and an optional "id" that is echoed back.
//!
//! Every security command goes through the same scope rule as the command
//! line: this machine and network are allowed, anything else must be in the
//! scope file. The extension can add an entry to the scope file, but only as
//! an explicit request ("scope-add"), which the page sends when the user
//! confirms they own or are authorised to test that host.

use crate::{audit, procs, scan};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

/// Name the extension uses with chrome.runtime.connectNative / sendNativeMessage.
pub const HOST_NAME: &str = "com.gamblium.host";
/// Id of the Gamblium extension. It is fixed by the "key" in its manifest.
pub const EXTENSION_ID: &str = "pbgbdlkcienglhbfadbjolphinilbpia";

/// Where browsers look for native hosts. Brave 1.99 on Windows reads Chrome's
/// key (found by test: with only the Brave key it reports "host not found").
/// Both are written; the host only accepts the Gamblium extension's id anyway.
const REG_KEYS: [&str; 2] = [
    r"HKCU\Software\Google\Chrome\NativeMessagingHosts\com.gamblium.host",
    r"HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.gamblium.host",
];

/// Writes the host manifest next to the Gamblium data and points Brave at it
/// (current user only, no admin rights). With `remove`, undoes both.
pub fn install(extension_id: &str, remove: bool) -> Result<String, String> {
    use std::process::Command;
    let dir = std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join("Gamblium")).ok_or("LOCALAPPDATA is not set")?;
    let manifest = dir.join("native-host.json");
    if remove {
        for key in REG_KEYS {
            let _ = Command::new("reg").args(["delete", key, "/f"]).output();
        }
        let _ = std::fs::remove_file(&manifest);
        return Ok("native host registration removed".into());
    }
    if extension_id.len() != 32 || !extension_id.chars().all(|c| ('a'..='p').contains(&c)) {
        return Err(format!("'{extension_id}' is not an extension id (32 letters a-p)"));
    }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    // Brave runs the "path" with no arguments of ours, so a small launcher file
    // passes the sub-command.
    let launcher = dir.join("native-host.bat");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(&launcher, format!("@echo off\r\n\"{}\" native-host %*\r\n", exe.display())).map_err(|e| e.to_string())?;
    let json = json!({
        "name": HOST_NAME,
        "description": "Gamblium companion: process stats and security tools for the Gamblium extension",
        "path": launcher,
        "type": "stdio",
        "allowed_origins": [format!("chrome-extension://{extension_id}/")],
    });
    std::fs::write(&manifest, serde_json::to_string_pretty(&json).unwrap()).map_err(|e| e.to_string())?;
    for key in REG_KEYS {
        let out = Command::new("reg")
            .args(["add", key, "/ve", "/t", "REG_SZ", "/d", &manifest.to_string_lossy(), "/f"])
            .output()
            .map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).into_owned());
        }
    }
    Ok(format!("native host registered for extension {extension_id}\n  manifest: {}\n  program:  {}", manifest.display(), exe.display()))
}

/// Left in Gamblium's own profile folder by `gamblium install --new` (a new install, not an
/// update): the extension shows the welcome page once more, then asks for it to be removed.
pub const WELCOME_AGAIN: &str = "gamblium-welcome-again";

/// Browsers refuse messages from a host above 1 MB.
const MAX_REPLY: usize = 1024 * 1024;
/// And they never send more than 4 GB; we accept far less, but enough for a whole-page picture:
/// up to 100000 px in slices of a busy page is tens of MB in base64. At 8 MB a real 54000 px
/// article ended the helper, and with it the session's commands (tester, Nov 14 2026).
const MAX_REQUEST: usize = 192 * 1024 * 1024;

pub fn read_message(input: &mut impl Read) -> io::Result<Option<Value>> {
    let mut len = [0u8; 4];
    match input.read_exact(&mut len) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None), // browser closed the pipe
        Err(e) => return Err(e),
    }
    let len = u32::from_le_bytes(len) as usize;
    if len > MAX_REQUEST {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "request too large"));
    }
    let mut buf = vec![0u8; len];
    input.read_exact(&mut buf)?;
    serde_json::from_slice(&buf).map(Some).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
}

pub fn write_message(output: &mut impl Write, value: &Value) -> io::Result<()> {
    let mut bytes = serde_json::to_vec(value).unwrap();
    if bytes.len() > MAX_REPLY {
        bytes = serde_json::to_vec(&json!({
            "id": value["id"], "ok": false, "error": "the answer was too large to send to the browser"
        }))
        .unwrap();
    }
    output.write_all(&(bytes.len() as u32).to_le_bytes())?;
    output.write_all(&bytes)?;
    output.flush()
}

pub fn scope_file() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join("Gamblium").join("scope.txt"))
}

/// A line the user may add to the scope file: a host name, *.domain, an IP
/// address or an IPv4 CIDR. One entry, no spaces, no comment characters.
pub fn valid_scope_entry(entry: &str) -> bool {
    let e = entry.trim();
    !e.is_empty()
        && e.len() <= 253
        && e != "*"
        && !e.starts_with("*.") == !e.contains('*') // a star is only allowed as the "*." prefix
        && e.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':' | '/' | '*'))
        && scan::parse_scope(e).len() == 1
        // "*.com" or "0.0.0.0/0" would put most of the internet in scope.
        && !matches!(scan::parse_scope(e)[0], scan::ScopeEntry::Wildcard(ref d) if !d.contains('.'))
        && !matches!(scan::parse_scope(e)[0], scan::ScopeEntry::Cidr(_, mask) if mask.count_ones() < 16)
}

fn read_scope() -> (String, Vec<scan::ScopeEntry>) {
    let text = scope_file().and_then(|f| std::fs::read_to_string(f).ok()).unwrap_or_default();
    let entries = scan::parse_scope(&text);
    (text, entries)
}

fn scope_lines(text: &str) -> Vec<String> {
    text.lines().map(|l| l.split('#').next().unwrap_or("").trim().to_owned()).filter(|l| !l.is_empty()).collect()
}

fn text<'a>(req: &'a Value, key: &str) -> Result<&'a str, String> {
    req[key].as_str().filter(|s| !s.is_empty()).ok_or(format!("'{key}' is missing"))
}

/// Handles one request. `browser_pid` is the browser that started us, if known.
pub fn handle(req: &Value, browser_pid: Option<u32>) -> Result<Value, String> {
    match req["type"].as_str().unwrap_or("") {
        "ping" => {
            // The profile folder of the browser we belong to; null means Brave's default one.
            let dir = browser_pid
                .and_then(|pid| procs::browsers("brave.exe").into_iter().find(|(p, _)| *p == pid))
                .and_then(|(_, dir)| dir);
            // The theme this profile was last started with, so our pages can match it.
            let folder = dir.as_ref().map(std::path::PathBuf::from).or_else(crate::launch::default_user_data_dir);
            let theme = folder.as_ref().and_then(|d| crate::launch::read_launch_theme(d));
            // True when the launcher handed freezing to the extension for this start.
            let freeze = folder.as_ref().map(|d| crate::launch::read_launch_freeze(d)).unwrap_or(false);
            // True when light-only websites are darkened this start (their links get a readable colour).
            let force_dark = folder.as_ref().map(|d| crate::launch::read_launch_force_dark(d)).unwrap_or(false);
            // False for test, agent and pen-test starts: no welcome page.
            let welcome = folder.as_ref().map(|d| crate::launch::read_launch_welcome(d)).unwrap_or(true);
            // The pen-test profile (`launch --pentest`): its pages put developer tools first.
            let pentest = match (folder.as_ref(), crate::launch::pentest_user_data_dir()) {
                (Some(f), Some(p)) => crate::dl::profile_key(f) == crate::dl::profile_key(&p),
                _ => false,
            };
            // Brave's own version, from the "Last Version" file the browser keeps in
            // the profile folder ("157.1.99.57" -> "1.99.57"), for Settings' version line.
            let brave_version = folder.as_ref().and_then(|d| std::fs::read_to_string(d.join("Last Version")).ok()).and_then(|t| brave_version_of(&t));
            // Installed anew (not updated): the welcome page shows again, once (owner, Nov 14 2026).
            let new_install = folder.as_ref().is_some_and(|d| d.join(WELCOME_AGAIN).is_file());
            Ok(json!({ "version": env!("CARGO_PKG_VERSION"), "browserPid": browser_pid, "userDataDir": dir, "theme": theme, "freeze": freeze, "welcome": welcome, "pentest": pentest, "braveVersion": brave_version, "newInstall": new_install, "forceDark": force_dark }))
        }
        // The welcome page was opened for a new install: forget the request.
        "welcome-done" => {
            if let Some(folder) = profile_of(browser_pid).map(std::path::PathBuf::from) {
                let _ = std::fs::remove_file(folder.join(WELCOME_AGAIN));
            }
            Ok(json!({ "done": true }))
        }
        // Shows this browser's own profile folder in Explorer. Only that folder:
        // a page cannot pass a path.
        "open-folder" => {
            let folder = profile_of(browser_pid).map(std::path::PathBuf::from).or_else(crate::launch::default_user_data_dir).ok_or("the profile folder is not known")?;
            if !folder.is_dir() {
                return Err("the profile folder is not there".into());
            }
            std::process::Command::new("explorer.exe").arg(&folder).spawn().map_err(|e| e.to_string())?;
            Ok(json!({ "opened": true }))
        }

        // Opens a web address in a Tor window of this same browser. Extensions cannot open Tor
        // windows (their worker does not even see them); the browser's own --tor switch does,
        // handed to the running browser of this profile.
        // Updates (update.rs). "update-check" starts a check-and-download in its own process (the
        // extension asks once per browser start, with force) and answers with where things stand.
        "update-status" => Ok({
            crate::update::forget_stale(env!("CARGO_PKG_VERSION"));
            json!({ "current": env!("CARGO_PKG_VERSION"), "update": crate::update::state(), "ready": crate::update::ready_installer(env!("CARGO_PKG_VERSION")).is_some() })
        }),
        "update-check" => {
            crate::update::forget_stale(env!("CARGO_PKG_VERSION"));
            let st = crate::update::state();
            let age = st["at"].as_u64().map(|t| std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0).saturating_sub(t)).unwrap_or(u64::MAX);
            let force = req.get("force").and_then(Value::as_bool).unwrap_or(false);
            if force || age > 6 * 3600 || st["state"] == "error" && age > 600 {
                let me = std::env::current_exe().map_err(|e| e.to_string())?;
                crate::launch::spawn_detached(&me, &["update".into(), "--download".into()]).map_err(|e| e.to_string())?;
            }
            Ok(json!({ "current": env!("CARGO_PKG_VERSION"), "update": st, "ready": crate::update::ready_installer(env!("CARGO_PKG_VERSION")).is_some() }))
        }
        // "Restart to update": the updater's copy waits for this browser to close, installs and
        // starts Gamblium again. The extension then closes the windows.
        "update-restart" => {
            let installer = crate::update::ready_installer(env!("CARGO_PKG_VERSION")).ok_or("no update is ready")?;
            crate::update::start_apply(&installer, true)?;
            Ok(json!({ "applying": true }))
        }
        "open-tor" => {
            // No address: an empty Tor window (the menu's "New Tor window").
            let url = req.get("url").and_then(Value::as_str).unwrap_or("");
            if !url.is_empty() && !is_web_address(url) {
                return Err("not a web address".into());
            }
            let pid = browser_pid.ok_or("the browser is not known")?;
            let exe = procs::exe_of(pid).ok_or("the browser's program is not known")?;
            let mut args = Vec::new();
            if let Some(dir) = profile_of(Some(pid)) {
                args.push(format!("--user-data-dir={dir}"));
            }
            args.push("--tor".into());
            if !url.is_empty() {
                args.push(url.to_owned());
            }
            crate::launch::spawn_detached(&exe, &args).map_err(|e| e.to_string())?;
            Ok(json!({ "opened": true }))
        }

        // A picture of what this browser's window shows, taken by Windows (any page, the
        // browser's own included). The PNG is fetched in pieces with "capture-piece".
        "capture-window" => {
            let pid = browser_pid.ok_or("the browser is not known")?;
            let n = |k: &str| req.get(k).and_then(Value::as_f64).map(|v| v.round() as i32);
            let want = match (n("left"), n("top"), n("width"), n("height")) {
                (Some(left), Some(top), Some(width), Some(height)) => Some(crate::capture::Want { left, top, width, height }),
                _ => None,
            };
            let (id, width, height, bytes) = crate::capture::capture(pid, want)?;
            Ok(json!({ "picture": id, "width": width, "height": height, "bytes": bytes, "pieceSize": CAPTURE_PIECE }))
        }
        "capture-piece" => {
            // Not "id": that field is the helper's own message number.
            let id = req.get("picture").and_then(Value::as_str).unwrap_or("");
            let index = req.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
            let (data, total) = crate::capture::piece(id, index, CAPTURE_PIECE)?;
            Ok(json!({ "data": data, "total": total }))
        }

        // Which look the browser wears: Gamblium's rebranded copy or Brave's own.
        "brand-get" => {
            let official = std::path::Path::new(crate::launch::DEFAULT_BRAVE);
            // The themes on offer are the theme presets that ship with Gamblium.
            let mut themes: Vec<String> = crate::launch::find_home()
                .and_then(|h| std::fs::read_dir(h.join("presets")).ok())
                .map(|d| {
                    d.filter_map(|e| e.ok())
                        .filter_map(|e| e.file_name().to_string_lossy().strip_prefix("theme-").and_then(|n| n.strip_suffix(".json")).map(str::to_owned))
                        .collect()
                })
                .unwrap_or_default();
            themes.sort();
            Ok(json!({
                "copy": crate::rebrand::describe(official), "official": crate::rebrand::wants_official(),
                "darkPages": crate::rebrand::wants_dark_pages(), "theme": crate::rebrand::chosen_theme(), "themes": themes,
            }))
        }
        "brand-set" => {
            // Any of: theme, darkPages, official, colours. All that are given are applied.
            let mut done = serde_json::Map::new();
            if let Some(theme) = req["theme"].as_str() {
                crate::rebrand::set_chosen_theme(theme)?;
                done.insert("theme".into(), json!(theme));
            }
            if let Some(dark) = req["darkPages"].as_bool() {
                crate::rebrand::set_dark_pages(dark)?;
                done.insert("darkPages".into(), json!(dark));
            }
            if let Some(official) = req["official"].as_bool() {
                crate::rebrand::set_official(official)?;
                done.insert("official".into(), json!(official));
            }
            if req.get("colours").is_some() {
                crate::rebrand::set_own_colours(&req["colours"])?;
                done.insert("colours".into(), req["colours"].clone());
            }
            if done.is_empty() {
                return Err("give theme, darkPages, official or colours".into());
            }
            Ok(Value::Object(done))
        }
        // Saved sessions: the extension has the typed text and page state of a
        // checkpoint sealed before it stores them, and opened when it restores.
        // Only the sessions key is ever used here; the key for download logins
        // cannot be reached through these requests.
        // Agents changing settings need the user's permission (permit.rs).
        // `permit-check` is what a settings command asks before it acts; with
        // no permission in force the question is written down and shown in
        // the user's own Gamblium, if that is open.
        // Logins agents may use (logins.rs): kept, listed and removed only from the owner's own
        // browser; handed to the extension for one page, only with the owner's yes.
        "login-list" | "login-save" | "login-remove" => {
            if profile_of(browser_pid).is_some_and(|d| std::path::Path::new(&d).join(crate::launch::AGENT_MARKER).is_file()) {
                return Err("logins for agents are kept in the owner's own Gamblium, not from an agent's browser".into());
            }
            let s = |k: &str| req[k].as_str().unwrap_or("").to_owned();
            match req["type"].as_str().unwrap_or("") {
                "login-list" => crate::logins::list(),
                "login-save" => crate::logins::save(&s("site"), &s("username"), &s("password")),
                _ => crate::logins::remove(&s("site"), &s("username")),
            }
        }
        "login-fill" => {
            let host = req["host"].as_str().ok_or("'host' (the page's) is missing")?;
            let now = crate::permit::now();
            let mut state = crate::permit::load();
            if !crate::permit::allowed(&state, "logins", now) {
                let profile = profile_of(browser_pid).map(|d| profile_label(&d)).unwrap_or_else(|| "an agent".into());
                let show = crate::permit::ask(&mut state, "logins", &format!("login {host}"), &profile, now)?;
                crate::permit::save(&state)?;
                let open = users_gamblium_is_open();
                if show && open {
                    show_in_users_gamblium("ui/permit.html?what=logins");
                }
                return Ok(json!({ "allowed": false, "asked": open }));
            }
            match crate::logins::get(host, req["username"].as_str())? {
                Some((site, username, password)) => Ok(json!({ "allowed": true, "site": site, "username": username, "password": password })),
                None => Ok(json!({ "allowed": true, "none": true })),
            }
        }
        "permit-check" => {
            let what = req["what"].as_str().unwrap_or("settings");
            let now = crate::permit::now();
            let mut state = crate::permit::load();
            if crate::permit::allowed(&state, what, now) {
                return Ok(json!({ "allowed": true }));
            }
            let command = req["command"].as_str().unwrap_or("a settings command");
            let profile = profile_of(browser_pid).map(|d| profile_label(&d)).unwrap_or_else(|| "an agent".into());
            let show = crate::permit::ask(&mut state, what, command, &profile, now)?;
            crate::permit::save(&state)?;
            let open = users_gamblium_is_open();
            if show && open {
                show_in_users_gamblium("ui/permit.html");
            }
            Ok(json!({ "allowed": false, "asked": open }))
        }
        "permit-get" => {
            let what = req["what"].as_str().unwrap_or("settings");
            Ok(crate::permit::view(&crate::permit::load(), what, crate::permit::now()))
        }
        "permit-set" => {
            // Only a browser the user sits in may answer.
            if profile_of(browser_pid).is_some_and(|d| std::path::Path::new(&d).join(crate::launch::AGENT_MARKER).is_file()) {
                return Err("an agent's browser cannot give this permission; it is given in the user's own Gamblium".into());
            }
            let what = req["what"].as_str().unwrap_or("settings");
            let minutes = req["minutes"].as_i64().ok_or("'minutes' is missing")?;
            let now = crate::permit::now();
            let mut state = crate::permit::load();
            crate::permit::grant(&mut state, what, minutes, now)?;
            crate::permit::save(&state)?;
            Ok(crate::permit::view(&state, what, now))
        }
        // Named sessions (gamblium-cli) for the Sessions page: list them, make,
        // show, hide, stop or delete one, and set what one applies. Commands
        // inside a session are not reachable from here: those are an agent's.
        "named-sessions" => {
            let mut args: Vec<String> = req["args"].as_array().into_iter().flatten().filter_map(|a| a.as_str().map(str::to_owned)).collect();
            if args.is_empty() {
                args.push("list".into());
            }
            if !["list", "create", "open", "hide", "close", "delete", "set", "open-url"].contains(&args[0].as_str()) {
                return Err(format!("'{}' is not something the Sessions page may ask", args[0]));
            }
            let answer = crate::sessions::command(&args)?;
            if args[0] == "create" {
                if let Some(name) = args.get(1) {
                    crate::sessions::mark_by(name, "page");
                }
            }
            Ok(answer)
        }
        "seal" => {
            let label = req["label"].as_str().filter(|l| !l.is_empty() && l.len() <= 200).ok_or("'label' (what the text belongs to) is missing")?;
            let text = req["text"].as_str().ok_or("'text' is missing")?;
            let key = crate::vault::key_for(crate::vault::Purpose::Sessions)?;
            let blob = crate::vault::seal_text(&key, crate::vault::Purpose::Sessions, label, text)?;
            Ok(json!({ "sealed": encode_base64(&blob) }))
        }
        "open" => {
            let label = req["label"].as_str().ok_or("'label' is missing")?;
            let blob = req["sealed"].as_str().and_then(decode_base64).ok_or("'sealed' is missing or not base64")?;
            let key = crate::vault::key_for(crate::vault::Purpose::Sessions)?;
            Ok(json!({ "text": crate::vault::open_text(&key, crate::vault::Purpose::Sessions, label, &blob)? }))
        }
        // Downloads handed to our own downloader (see dl.rs).
        "dl-start" => {
            // Taken before the browser chose a folder (no visible hand-over): the profile's own
            // download folder, plus the folder of a routing rule.
            let mut req = req.clone();
            if req["dir"].as_str().unwrap_or("").is_empty() {
                let profile = profile_of(browser_pid).map(std::path::PathBuf::from).or_else(crate::launch::default_user_data_dir);
                // Agents' sessions save into a folder of their own, not loose in the owner's
                // Downloads (tester, Nov 14 2026).
                let agent_dir = profile.as_deref().and_then(crate::dl::agent_download_folder);
                let base = agent_dir
                    .or_else(|| profile.and_then(|p| crate::dl::profile_download_dir(&p)))
                    .or_else(|| std::env::var_os("USERPROFILE").map(|h| std::path::PathBuf::from(h).join("Downloads")));
                let dir = match (base, req["folder"].as_str().and_then(crate::dl::plain_folder)) {
                    (Some(b), Some(f)) => Some(b.join(f)),
                    (b, _) => b,
                };
                if let Some(d) = dir {
                    req["dir"] = json!(d.to_string_lossy());
                }
            }
            crate::dl::start(&req, &download_profile(browser_pid))
        }
        "dl-list" => crate::dl::list(&download_profile(browser_pid)),
        // Accounts and saved-login sites of the other browsers on this computer (never a password).
        "bring-scan" => Ok(crate::bring::scan()),
        "dl-cancel" | "dl-resume" | "dl-forget" => {
            let id = req["id"].as_str().unwrap_or("");
            crate::dl::mine(id, &download_profile(browser_pid))?;
            match req["type"].as_str().unwrap_or("") {
                "dl-cancel" => crate::dl::cancel(id),
                "dl-resume" => crate::dl::resume(id),
                _ => crate::dl::forget(id),
            }
        }
        "dl-action" => crate::dl::action(req["id"].as_str().unwrap_or(""), req["action"].as_str().unwrap_or(""), &download_profile(browser_pid)),
        // Close this browser and start it again on the same profile, so a new
        // theme shows. A separate program does it, because we die with the browser.
        "restart" => {
            let pid = browser_pid.ok_or("the browser that started the helper is not known")?;
            let dir = procs::browsers("brave.exe").into_iter().find(|(p, _)| *p == pid).and_then(|(_, d)| d).ok_or("the main Brave profile is not restarted from here")?;
            let me = std::env::current_exe().map_err(|e| e.to_string())?;
            crate::launch::spawn_detached(&me, &["relaunch".into(), "--pid".into(), pid.to_string(), "--user-data-dir".into(), dir])
                .map_err(|e| format!("could not start the restart: {e}"))?;
            Ok(json!({ "restarting": true }))
        }

        // Per-process numbers for the browser we belong to. The page works out
        // rates from two readings and maps page processes to tabs by clientId.
        "stats" => {
            let mut sampler = procs::Sampler::new("brave.exe", None);
            sampler.root = browser_pid;
            let procs = sampler.sample();
            Ok(json!({
                "at_ms": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0),
                "system_available_mb": procs::system_available() / (1024 * 1024),
                "processes": procs,
            }))
        }

        "freeze" | "thaw" | "trim" => {
            let kind = req["type"].as_str().unwrap();
            let mut sampler = procs::Sampler::new("brave.exe", None);
            sampler.root = browser_pid;
            // Only page processes of our own browser: freezing anything else hangs it.
            let allowed: Vec<u32> = sampler.sample().iter().filter(|p| p.kind == "renderer").map(|p| p.pid).collect();
            let mut done = Vec::new();
            // Asked for but not done: gone, not a page process of this browser, or refused by Windows.
            let mut skipped = Vec::new();
            for pid in req["pids"].as_array().map(|a| a.as_slice()).unwrap_or(&[]).iter().filter_map(|v| v.as_u64()) {
                let pid = pid as u32;
                if !allowed.contains(&pid) {
                    skipped.push(pid);
                    continue;
                }
                let r = match kind {
                    "freeze" => procs::freeze(pid),
                    "thaw" => procs::thaw(pid),
                    _ => procs::trim(pid),
                };
                if r.is_ok() {
                    done.push(pid);
                } else {
                    skipped.push(pid);
                }
            }
            Ok(json!({ "pids": done, "skipped": skipped }))
        }

        // The extension processes of our own browser get normal priority and
        // no power throttling (see procs::lift). Only extension processes, and
        // only this browser's.
        "lift-extension" => {
            let mut sampler = procs::Sampler::new("brave.exe", None);
            sampler.root = browser_pid;
            let mut done = Vec::new();
            let mut skipped = Vec::new();
            for p in sampler.sample().iter().filter(|p| p.kind == "extension") {
                if procs::lift(p.pid).is_ok() { done.push(p.pid) } else { skipped.push(p.pid) }
            }
            Ok(json!({ "pids": done, "skipped": skipped }))
        }

        "scope-list" => Ok(json!({ "entries": scope_lines(&read_scope().0), "file": scope_file() })),

        "scope-add" => {
            let entry = text(req, "entry")?.trim().to_ascii_lowercase();
            if !valid_scope_entry(&entry) {
                return Err(format!("'{entry}' is not a host, *.domain, IP address or network I can add"));
            }
            let file = scope_file().ok_or("LOCALAPPDATA is not set")?;
            let (text, _) = read_scope();
            let mut lines = scope_lines(&text);
            if !lines.contains(&entry) {
                if let Some(dir) = file.parent() {
                    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
                }
                let mut out = text;
                if !out.is_empty() && !out.ends_with('\n') {
                    out.push('\n');
                }
                if out.is_empty() {
                    out.push_str("# Gamblium scope: hosts and networks you own or are authorised to test.\n");
                }
                out.push_str(&entry);
                out.push('\n');
                std::fs::write(&file, out).map_err(|e| e.to_string())?;
                lines.push(entry);
            }
            Ok(json!({ "entries": lines }))
        }

        // Is this host allowed, and why. Never contacts the target (only DNS).
        "scope-check" => {
            let host = text(req, "host")?;
            let (_, scope) = read_scope();
            let ip = scan::resolve(host)?;
            let local = scan::is_local(ip);
            Ok(json!({ "host": host, "ip": ip.to_string(), "local": local, "inScope": local || scan::in_scope(host, ip, &scope) }))
        }

        "audit" => {
            let (_, scope) = read_scope();
            let report = crate::audit_report(text(req, "url")?, &scope, req["cve"].as_bool().unwrap_or(false))?;
            serde_json::to_value(report).map_err(|e| e.to_string())
        }

        "scan" => {
            let (_, scope) = read_scope();
            let targets = vec![text(req, "target")?.to_owned()];
            let results = crate::scan_targets(&targets, req["ports"].as_str(), &scope, 500, 100)?;
            serde_json::to_value(&results[0]).map_err(|e| e.to_string())
        }

        "cve" => {
            let mut cves = crate::lookup_cves(text(req, "product")?, text(req, "version")?)?;
            cves.truncate(50);
            Ok(json!({ "cves": cves }))
        }

        "detect-software" => Ok(json!({ "software": audit::detect_software(text(req, "text")?) })),

        other => Err(format!("unknown request type '{other}'")),
    }
}

// ---- Agent bridge ---------------------------------------------------------------
// Lets a command-line program (an AI agent, a script) control the running
// browser through the extension, without a debugger attached.
//
//   gamblium ctl ...  --TCP on 127.0.0.1 + token-->  this host  --native port-->  extension
//
// The extension asks for the bridge ("bridge-start"); we then listen on a
// loopback port and write a small file with the port and a random token that
// only this Windows user can read. Each command from a client is forwarded to
// the extension as {"type":"ctl","id":n,"cmd":{...}} and answered when the
// extension sends {"type":"ctl-reply","id":n,"result":{...}}.

type Pending = Arc<Mutex<HashMap<u64, mpsc::Sender<Value>>>>;
type Out = Arc<Mutex<io::Stdout>>;

pub fn bridges_dir() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join("Gamblium").join("bridges"))
}

fn new_token() -> io::Result<String> {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).map_err(|e| io::Error::other(e.to_string()))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// Compares without stopping at the first difference, so timing says nothing.
pub fn same_token(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn send(out: &Out, value: &Value) -> io::Result<()> {
    write_message(&mut *out.lock().unwrap(), value)
}

/// One command from a client: a single line of JSON in, a single line out.
fn serve_client(stream: TcpStream, token: &str, out: &Out, pending: &Pending, next_id: &AtomicU64, who: &str) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let mut line = String::new();
    let reply = match BufReader::new(&stream).take(MAX_REPLY as u64).read_line(&mut line) {
        Ok(n) if n > 0 => match serde_json::from_str::<Value>(&line) {
            Ok(req) if same_token(req["token"].as_str().unwrap_or(""), token) => {
                let id = next_id.fetch_add(1, Ordering::Relaxed);
                let (tx, rx) = mpsc::channel();
                pending.lock().unwrap().insert(id, tx);
                let wait = Duration::from_millis(req["timeout_ms"].as_u64().unwrap_or(30_000).min(120_000));
                let began = std::time::Instant::now();
                let answer = match send(out, &json!({ "type": "ctl", "id": id, "cmd": req["cmd"] })) {
                    Ok(()) => rx.recv_timeout(wait).unwrap_or_else(|_| json!({ "ok": false, "error": "the browser did not answer in time" })),
                    Err(e) => json!({ "ok": false, "error": format!("the browser is gone: {e}") }),
                };
                pending.lock().unwrap().remove(&id);
                // What the agent did, for the owner to read (agentlog.rs).
                crate::agentlog::write(who, &req["cmd"], &answer, began.elapsed().as_millis());
                answer
            }
            Ok(_) => json!({ "ok": false, "error": "wrong token" }),
            Err(e) => json!({ "ok": false, "error": format!("not JSON: {e}") }),
        },
        _ => json!({ "ok": false, "error": "empty request" }),
    };
    let mut stream = stream;
    let _ = stream.write_all(serde_json::to_string(&reply).unwrap().as_bytes());
    let _ = stream.write_all(b"\n");
}

/// "157.1.99.57" (Chromium major + Brave version) -> "1.99.57".
fn brave_version_of(text: &str) -> Option<String> {
    let t = text.trim();
    let parts: Vec<&str> = t.split('.').collect();
    if parts.len() == 4 && parts.iter().all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit())) {
        Some(parts[1..].join("."))
    } else {
        None
    }
}

/// Bytes of a picture per native message: base64 of 600 KB stays under the 1 MB limit.
const CAPTURE_PIECE: usize = 600 * 1024;

/// http or https, with a host, and nothing that a command line could take as a switch.
fn is_web_address(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    let rest = lower.strip_prefix("https://").or_else(|| lower.strip_prefix("http://"));
    rest.is_some_and(|r| !r.is_empty() && !r.starts_with('/')) && url.len() <= 8192 && !url.chars().any(|c| c.is_whitespace() || c == '"' || c.is_control())
}

/// The profile whose downloads this helper may see and touch.
fn download_profile(browser_pid: Option<u32>) -> String {
    let dir = profile_of(browser_pid).map(std::path::PathBuf::from).or_else(crate::launch::default_user_data_dir).unwrap_or_default();
    crate::dl::profile_key(&dir)
}

/// The profile folder of the browser a helper belongs to; None is Brave's default one.
fn profile_of(browser_pid: Option<u32>) -> Option<String> {
    browser_pid.and_then(|pid| procs::browsers("brave.exe").into_iter().find(|(p, _)| *p == pid)).and_then(|(_, d)| d)
}

/// A short name for a profile folder: the session's name, or what kind it is.
pub fn profile_label(dir: &str) -> String {
    let lower = dir.to_ascii_lowercase().replace('/', "\\");
    let last = dir.trim_end_matches(['\\', '/']).rsplit(['\\', '/']).next().unwrap_or(dir);
    if lower.contains("\\gamblium\\sessions\\") {
        format!("the session '{last}'")
    } else if lower.trim_end_matches('\\').ends_with("agent-profile") {
        "the agent profile".into()
    } else {
        format!("the profile {last}")
    }
}

fn users_gamblium_is_open() -> bool {
    crate::install::profile_dir().is_some_and(|p| procs::browser_running("brave.exe", Some(&p)))
}

/// Opens one of our pages as a tab in the user's own running Gamblium.
fn show_in_users_gamblium(page: &str) {
    let (Some(profile), Some(browser)) = (crate::install::profile_dir(), crate::rebrand::copy_dir().map(|d| d.join("brave.exe")).filter(|p| p.is_file())) else { return };
    let address = format!("chrome-extension://{EXTENSION_ID}/{page}");
    let _ = crate::launch::spawn_detached(&browser, &[format!("--user-data-dir={}", profile.display()), address]);
}

/// Starts the listener and writes the bridge file. Returns the port.
fn start_bridge(browser_pid: Option<u32>, out: &Out, pending: &Pending) -> Result<u16, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let token = new_token().map_err(|e| e.to_string())?;
    let dir = bridges_dir().ok_or("LOCALAPPDATA is not set")?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let user_data_dir = browser_pid
        .and_then(|pid| procs::browsers("brave.exe").into_iter().find(|(p, _)| *p == pid))
        .and_then(|(_, d)| d);
    let file = dir.join(format!("{}.json", browser_pid.unwrap_or(std::process::id())));
    let info = json!({
        "port": port, "token": token, "browserPid": browser_pid, "hostPid": std::process::id(),
        "userDataDir": user_data_dir,
        "startedAt": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0),
    });
    std::fs::write(&file, serde_json::to_string(&info).unwrap()).map_err(|e| e.to_string())?;
    let (out, pending) = (out.clone(), pending.clone());
    let who = user_data_dir.as_deref().map(profile_label).unwrap_or_else(|| "the main profile".into());
    std::thread::spawn(move || {
        let next_id = Arc::new(AtomicU64::new(1));
        for stream in listener.incoming().flatten() {
            let (token, out, pending, next_id, who) = (token.clone(), out.clone(), pending.clone(), next_id.clone(), who.clone());
            std::thread::spawn(move || serve_client(stream, &token, &out, &pending, &next_id, &who));
        }
    });
    Ok(port)
}

/// Reads requests until the browser closes the pipe.
pub fn run() -> io::Result<()> {
    // Stored logins of downloads whose time is up are deleted first thing.
    crate::dl::sweep();
    let browser_pid = procs::browser_ancestor("brave.exe");
    // The look chosen in this browser's Settings belongs to its own profile.
    let profile = browser_pid.and_then(|pid| procs::browsers("brave.exe").into_iter().find(|(p, _)| *p == pid)).and_then(|(_, d)| d);
    crate::rebrand::look_belongs_to(profile.as_deref().map(std::path::Path::new));
    let out: Out = Arc::new(Mutex::new(io::stdout()));
    let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
    let mut bridge_file: Option<PathBuf> = None;
    let stdin = io::stdin();
    let mut input = stdin.lock();
    while let Some(req) = read_message(&mut input)? {
        match req["type"].as_str().unwrap_or("") {
            // The extension answering a command we forwarded for a client.
            "ctl-reply" => {
                if let Some(tx) = req["id"].as_u64().and_then(|id| pending.lock().unwrap().remove(&id)) {
                    let _ = tx.send(req["result"].clone());
                }
                continue;
            }
            "bridge-start" => {
                let reply = match start_bridge(browser_pid, &out, &pending) {
                    Ok(port) => {
                        bridge_file = bridges_dir().map(|d| d.join(format!("{}.json", browser_pid.unwrap_or(std::process::id()))));
                        json!({ "type": "bridge-started", "ok": true, "port": port, "id": req["id"] })
                    }
                    Err(e) => json!({ "type": "bridge-started", "ok": false, "error": e, "id": req["id"] }),
                };
                send(&out, &reply)?;
                continue;
            }
            _ => {}
        }
        let mut reply = match handle(&req, browser_pid) {
            Ok(Value::Object(map)) => Value::Object(map),
            Ok(other) => json!({ "result": other }),
            Err(e) => json!({ "ok": false, "error": e }),
        };
        if reply.get("ok").is_none() {
            reply["ok"] = json!(true);
        }
        reply["id"] = req["id"].clone();
        send(&out, &reply)?;
    }
    if let Some(f) = bridge_file {
        let _ = std::fs::remove_file(f);
    }
    Ok(())
}

// ---- The client side: `gamblium ctl` -----------------------------------------------

#[derive(Debug, serde::Deserialize)]
pub struct BridgeInfo {
    pub port: u16,
    pub token: String,
    #[serde(rename = "browserPid")]
    pub browser_pid: Option<u32>,
    #[serde(rename = "hostPid")]
    pub host_pid: u32,
    #[serde(rename = "userDataDir")]
    pub user_data_dir: Option<String>,
}

/// Bridges of browsers that are still running. Files left by dead ones are removed.
pub fn live_bridges() -> Vec<BridgeInfo> {
    let Some(dir) = bridges_dir() else { return vec![] };
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let path = entry.path();
        let Ok(text) = std::fs::read_to_string(&path) else { continue };
        match serde_json::from_str::<BridgeInfo>(&text) {
            Ok(info) if procs::is_running(info.host_pid) => out.push(info),
            _ => {
                let _ = std::fs::remove_file(&path);
            }
        }
    }
    out
}

/// Picks the bridge to talk to. `which`: "agent", "main", a browser pid, or
/// part of a profile folder path. With none given there must be exactly one.
pub fn pick_bridge(mut bridges: Vec<BridgeInfo>, which: Option<&str>) -> Result<BridgeInfo, String> {
    if bridges.is_empty() {
        return Err("no Gamblium is accepting commands. Start one with: gamblium launch --agent".into());
    }
    if let Some(w) = which {
        let w = w.to_ascii_lowercase();
        bridges.retain(|b| {
            let dir = b.user_data_dir.as_deref().unwrap_or("").to_ascii_lowercase();
            match w.as_str() {
                "main" => b.user_data_dir.is_none(),
                "agent" => dir.ends_with("agent-profile"),
                _ => b.browser_pid.map(|p| p.to_string()) == Some(w.clone()) || (!dir.is_empty() && dir.contains(&w)),
            }
        });
        if bridges.is_empty() {
            return Err(format!("no running Gamblium matches '{w}'"));
        }
    }
    if bridges.len() > 1 {
        let names: Vec<String> = bridges
            .iter()
            .map(|b| format!("{} ({})", b.browser_pid.unwrap_or(0), b.user_data_dir.as_deref().unwrap_or("main profile")))
            .collect();
        return Err(format!("more than one Gamblium is running; pick one with --profile: {}", names.join(", ")));
    }
    Ok(bridges.remove(0))
}

/// Sends one command and returns the extension's answer.
pub fn ctl(bridge: &BridgeInfo, cmd: &Value, timeout_ms: u64) -> Result<Value, String> {
    let mut stream = TcpStream::connect(("127.0.0.1", bridge.port)).map_err(|e| format!("cannot reach the browser: {e}"))?;
    let _ = stream.set_read_timeout(Some(Duration::from_millis(timeout_ms + 5_000)));
    let req = json!({ "token": bridge.token, "cmd": cmd, "timeout_ms": timeout_ms });
    stream.write_all(serde_json::to_string(&req).unwrap().as_bytes()).map_err(|e| e.to_string())?;
    stream.write_all(b"\n").map_err(|e| e.to_string())?;
    let mut line = String::new();
    BufReader::new(stream).read_line(&mut line).map_err(|e| format!("no answer: {e}"))?;
    serde_json::from_str(&line).map_err(|e| format!("bad answer: {e}"))
}

/// Standard base64 (with or without padding). None if the text is not base64.
pub fn encode_base64(bytes: &[u8]) -> String {
    const ABC: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (chunk[0] as u32) << 16 | (*chunk.get(1).unwrap_or(&0) as u32) << 8 | *chunk.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(ABC[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

pub fn decode_base64(text: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0u8);
    for c in text.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' | b'\n' | b'\r' => continue,
            _ => return None,
        };
        acc = (acc << 6) | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Some(out)
}

/// Arguments that are whole numbers, and those that are true/false. Everything
/// else is text, whatever it looks like (a search for "42" stays a search).
const NUMBER_KEYS: &[&str] = &[
    "tab", "window", "index", "max", "limit", "ms", "x", "y", "by", "left", "top", "width", "height", "port", "delaySec",
    "lowMemoryDelaySec", "lowMemoryMb", "status", "scrollx", "quality", "delay",
];
const FLAG_KEYS: &[&str] = &[
    "wait", "background", "on", "submit", "gone", "cve", "errors", "closeAfter", "withPages", "withSettings", "enabled",
    "routingEnabled", "secure", "httpOnly", "real", "full", "mobile",
];

/// "tab=12 url=https://x wait=true" -> {"tab":12,"url":"https://x","wait":true}
pub fn parse_ctl_args(op: &str, pairs: &[String]) -> Result<Value, String> {
    // (x, y, real and full are tested in ctl_points_and_flags_are_typed.)
    let mut cmd = serde_json::Map::new();
    cmd.insert("op".into(), json!(op));
    for pair in pairs {
        let (k, v) = pair.split_once('=').ok_or(format!("'{pair}' is not key=value"))?;
        if k.is_empty() || k == "op" {
            return Err(format!("'{pair}' is not key=value"));
        }
        let value = if NUMBER_KEYS.contains(&k) {
            json!(v.parse::<i64>().map_err(|_| format!("{k} must be a whole number, not '{v}'"))?)
        } else if FLAG_KEYS.contains(&k) {
            match v {
                "true" => json!(true),
                "false" => json!(false),
                _ => return Err(format!("{k} must be true or false, not '{v}'")),
            }
        } else if k == "id" {
            // A download id is Gamblium's own (16 hex characters, kept as text) or, for what only
            // the browser can fetch (blob:, data:), the browser's number. A recorded request's id
            // is text that looks like one.
            if op.starts_with("download") {
                if v.len() == 16 && v.chars().all(|c| c.is_ascii_hexdigit()) {
                    json!(v.to_ascii_lowercase())
                } else {
                    json!(v.parse::<i64>().map_err(|_| format!("id must be a download's id, not '{v}'"))?)
                }
            } else {
                json!(v)
            }
        } else {
            json!(v)
        };
        cmd.insert(k.to_owned(), value);
    }
    Ok(Value::Object(cmd))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn messages_survive_a_round_trip_and_end_of_input_is_clean() {
        let mut wire = Vec::new();
        write_message(&mut wire, &json!({ "type": "ping", "id": 7 })).unwrap();
        write_message(&mut wire, &json!({ "type": "stats" })).unwrap();
        let mut input = &wire[..];
        assert_eq!(read_message(&mut input).unwrap().unwrap()["id"], 7);
        assert_eq!(read_message(&mut input).unwrap().unwrap()["type"], "stats");
        assert!(read_message(&mut input).unwrap().is_none());
    }

    #[test]
    fn the_length_prefix_is_little_endian() {
        let mut wire = Vec::new();
        write_message(&mut wire, &json!({})).unwrap();
        assert_eq!(wire, vec![2, 0, 0, 0, b'{', b'}']);
    }

    #[test]
    fn an_oversized_request_is_refused() {
        let wire = (MAX_REQUEST as u32 + 1).to_le_bytes();
        assert!(read_message(&mut &wire[..]).is_err());
    }

    #[test]
    fn an_oversized_reply_becomes_an_error_the_browser_can_read() {
        let mut wire = Vec::new();
        write_message(&mut wire, &json!({ "id": 3, "blob": "x".repeat(MAX_REPLY) })).unwrap();
        let reply = read_message(&mut &wire[..]).unwrap().unwrap();
        assert_eq!(reply["ok"], false);
        assert_eq!(reply["id"], 3);
    }

    #[test]
    fn scope_entries_must_be_narrow_and_well_formed() {
        for good in ["example.com", "*.example.com", "203.0.113.7", "203.0.113.0/24", "10.0.0.0/16", "staging.my-app.io"] {
            assert!(valid_scope_entry(good), "{good}");
        }
        for bad in ["", "*", "*.com", "*.*", "exa mple.com", "example.com # mine", "0.0.0.0/0", "10.0.0.0/8", "a*b.com", "http://x.com", "x.com\ny.com"] {
            assert!(!valid_scope_entry(bad), "{bad:?}");
        }
    }

    #[test]
    fn base64_decodes_and_rejects_rubbish() {
        assert_eq!(decode_base64("aGVsbG8=").unwrap(), b"hello");
        assert_eq!(decode_base64("aGVsbG8").unwrap(), b"hello");
        assert_eq!(decode_base64("AAEC/w==").unwrap(), vec![0, 1, 2, 255]);
        assert_eq!(decode_base64("").unwrap(), Vec::<u8>::new());
        assert!(decode_base64("not base64!").is_none());
    }

    #[test]
    fn ctl_points_and_flags_are_typed() {
        let cmd = parse_ctl_args("mouse", &["x=100".into(), "y=60".into(), "action=double".into()]).unwrap();
        assert_eq!(cmd, json!({ "op": "mouse", "x": 100, "y": 60, "action": "double" }));
        let cmd = parse_ctl_args("click", &["selector=#b".into(), "real=true".into()]).unwrap();
        assert_eq!(cmd, json!({ "op": "click", "selector": "#b", "real": true }));
        assert_eq!(parse_ctl_args("screenshot", &["full=true".into()]).unwrap()["full"], true);
        assert!(parse_ctl_args("mouse", &["x=left".into()]).is_err());
    }

    #[test]
    fn ctl_arguments_become_a_command() {
        let cmd = parse_ctl_args("open", &["url=https://example.com/?a=1".into(), "wait=true".into(), "tab=12".into()]).unwrap();
        assert_eq!(cmd, json!({ "op": "open", "url": "https://example.com/?a=1", "wait": true, "tab": 12 }));
        // Text that looks like a number or a flag stays text where text is expected.
        let cmd = parse_ctl_args("type", &["text=true".into(), "selector=#q".into(), "name=42".into()]).unwrap();
        assert_eq!(cmd, json!({ "op": "type", "text": "true", "selector": "#q", "name": "42" }));
        assert!(parse_ctl_args("open", &["nonsense".into()]).is_err());
        assert!(parse_ctl_args("open", &["op=close".into()]).is_err());
        assert_eq!(parse_ctl_args("download-pause", &["id=7".into()]).unwrap()["id"], 7);
        assert_eq!(parse_ctl_args("capture-get", &["id=7".into()]).unwrap()["id"], "7");
        assert_eq!(parse_ctl_args("close", &["tabs=1,2,3".into()]).unwrap()["tabs"], "1,2,3");
        assert_eq!(parse_ctl_args("zoom", &["factor=1.25".into()]).unwrap()["factor"], "1.25");
        assert!(parse_ctl_args("text", &["tab=first".into()]).is_err());
        assert!(parse_ctl_args("open", &["wait=yes".into()]).is_err());
    }

    #[test]
    fn the_right_bridge_is_picked() {
        let b = |pid: u32, dir: Option<&str>| BridgeInfo { port: 1, token: "t".into(), browser_pid: Some(pid), host_pid: 1, user_data_dir: dir.map(str::to_owned) };
        let all = || vec![b(10, None), b(20, Some(r"C:\\Users\\x\\AppData\\Local\\Gamblium\\agent-profile")), b(30, Some(r"C:\\tmp\\work"))];
        assert_eq!(pick_bridge(all(), Some("agent")).unwrap().browser_pid, Some(20));
        assert_eq!(pick_bridge(all(), Some("main")).unwrap().browser_pid, Some(10));
        assert_eq!(pick_bridge(all(), Some("30")).unwrap().browser_pid, Some(30));
        assert_eq!(pick_bridge(all(), Some("WORK")).unwrap().browser_pid, Some(30));
        assert!(pick_bridge(all(), None).unwrap_err().contains("more than one"));
        assert!(pick_bridge(all(), Some("nope")).is_err());
        assert!(pick_bridge(vec![], None).unwrap_err().contains("gamblium launch --agent"));
        assert_eq!(pick_bridge(vec![b(10, None)], None).unwrap().browser_pid, Some(10));
    }

    #[test]
    fn tokens_are_long_random_and_compared_safely() {
        let (a, b) = (new_token().unwrap(), new_token().unwrap());
        assert_eq!(a.len(), 64);
        assert_ne!(a, b);
        assert!(same_token(&a, &a.clone()));
        assert!(!same_token(&a, &b));
        assert!(!same_token(&a, &a[..63]));
        assert!(!same_token("", &a));
    }

    #[test]
    fn unknown_and_incomplete_requests_are_errors_not_panics() {
        assert!(handle(&json!({ "type": "nope" }), None).is_err());
        assert!(handle(&json!({}), None).is_err());
        assert!(handle(&json!({ "type": "audit" }), None).unwrap_err().contains("'url' is missing"));
        assert!(handle(&json!({ "type": "scope-add", "entry": "*" }), None).is_err());
        assert_eq!(handle(&json!({ "type": "ping" }), Some(42)).unwrap()["browserPid"], 42);
        let sw = handle(&json!({ "type": "detect-software", "text": "nginx/1.18.0" }), None).unwrap();
        assert_eq!(sw["software"][0][0], "nginx");
    }

    #[test]
    fn a_public_host_is_refused_by_audit_without_a_scope_entry() {
        // 93.184.216.34 is a public address; no DNS and no connection are needed to refuse it.
        let err = crate::audit_report("http://93.184.216.34/", &[], false).unwrap_err();
        assert!(err.contains("not in a scope file"), "{err}");
    }

    #[test]
    fn brave_version_from_the_last_version_file() {
        assert_eq!(brave_version_of("157.1.99.57\n").as_deref(), Some("1.99.57"));
        assert_eq!(brave_version_of("garbage"), None);
        assert_eq!(brave_version_of("157.1.99"), None);
    }

    #[test]
    fn only_web_addresses_go_to_tor() {
        assert!(super::is_web_address("https://example.org/a?b=c"));
        assert!(super::is_web_address("http://example.org"));
        for bad in ["file:///c:/x", "https://", "https:///x", "--tor", "javascript:alert(1)", "https://a.example/ --remote-debugging-port=1", "chrome://settings"] {
            assert!(!super::is_web_address(bad), "{bad}");
        }
    }
}

//! `gamblium-cli`: named browser sessions that work with nothing on screen.
//!
//! A session is a profile folder of its own under `Gamblium\sessions\<name>`,
//! started as an agent profile with no window. Every command of
//! `gamblium ctl` works in it by name, and `open` puts the same session in a
//! window when there is something to look at (`hide` takes the window away
//! again). Logins stay in the folder; the open tabs are written down when a
//! session stops and opened again when it starts.
//!
//! A running browser cannot be given or lose its window, so `open` and `hide`
//! stop it and start it again: a page loses what it held in memory.

use crate::host::{self, BridgeInfo};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

/// Words that are commands, so no session may be called by them.
const RESERVED: [&str; 14] =
    ["create", "new", "open", "show", "hide", "close", "stop", "list", "ls", "delete", "set", "help", "version", "open-url"];
const NOTE: &str = "gamblium-session.json";
// Web fonts off at the start; pictures are switched off by the extension
// (`lean`), so that `full-reload` can bring them back for one page.
const LEAN_PAGE_SWITCHES: [&str; 1] = ["--disable-remote-fonts"];
const BROWSER_EXE: &str = "brave.exe";

pub const USAGE: &str = "\
gamblium-cli: named browser sessions that work with no window

  gamblium-cli create <name> [--window] [proxy=<address>]
                                          a new session; it starts hidden
  gamblium-cli list                       every session and whether it runs
  gamblium-cli <name> <command> [key=value ...] [--timeout <seconds>]
                                          any browser command, for example:
      gamblium-cli work open url=https://example.com wait=true
      gamblium-cli work text
      gamblium-cli work screenshot out=page.png
      gamblium-cli work help              all commands
  gamblium-cli open <name>                show the session in a window
  gamblium-cli hide <name>                take the window away, keep working
  gamblium-cli set <name> proxy=<address>|none
                                          the proxy this session always uses,
                                          e.g. socks5://127.0.0.1:9050
  gamblium-cli set <name> images=on|off   pictures and web fonts while hidden
                                          (off unless switched on)
  gamblium-cli set <name> window=on|off   on: the session runs as an ordinary
                                          browser window, minimised (for sites
                                          whose automatic check refuses hidden
                                          browsers); off: hidden (the default)
  gamblium-cli set <name> keep-tabs=on|off
                                          on: tabs stay awake when the next
                                          page is opened (off: they sleep)
  gamblium-cli close <name>               stop it; logins and tabs are kept
  gamblium-cli delete <name>              stop it and delete its folder

A stopped session starts by itself, hidden, when a command is sent to it.
Its tabs come back asleep; a command for a tab wakes that tab only.
Work hidden whenever you can: a window is for a person to look or to solve
a CAPTCHA, not for the work itself.
A session keeps its own logins, extensions (install them in its window) and
proxy, and they apply every time it is used.
Answers are JSON. A name is letters, digits, - and _ (40 at most).";

pub fn root() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join("Gamblium").join("sessions"))
}

pub fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 40
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        && !name.starts_with('-')
        && !RESERVED.contains(&name.to_ascii_lowercase().as_str())
}

fn norm(dir: &str) -> String {
    dir.to_ascii_lowercase().replace('/', "\\").trim_end_matches('\\').to_owned()
}

fn same(a: &str, b: &Path) -> bool {
    norm(a) == norm(&b.to_string_lossy())
}

fn dir_of(name: &str) -> Result<PathBuf, String> {
    if !valid_name(name) {
        return Err(format!("'{name}' cannot be a session name: letters, digits, - and _ (40 at most), and not a command word"));
    }
    Ok(root().ok_or("LOCALAPPDATA is not set")?.join(name))
}

/// The folder of a session that exists.
fn existing(name: &str) -> Result<PathBuf, String> {
    let dir = dir_of(name)?;
    if !dir.is_dir() {
        return Err(format!("there is no session '{name}'. Make it with: gamblium-cli create {name}"));
    }
    Ok(dir)
}

fn pid_of(dir: &Path) -> Option<u32> {
    crate::procs::browsers(BROWSER_EXE).into_iter().find(|(_, d)| d.as_deref().is_some_and(|d| same(d, dir))).map(|(pid, _)| pid)
}

fn bridge_of(dir: &Path) -> Option<BridgeInfo> {
    host::live_bridges().into_iter().find(|b| b.user_data_dir.as_deref().is_some_and(|d| same(d, dir)))
}

fn note(dir: &Path) -> Value {
    fs::read_to_string(dir.join(NOTE)).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_else(|| json!({}))
}

fn write_note(dir: &Path, note: &Value) {
    let _ = fs::write(dir.join(NOTE), serde_json::to_string_pretty(note).unwrap());
}

/// "stopped", "hidden" or "window".
fn state_of(dir: &Path) -> &'static str {
    match pid_of(dir) {
        None => "stopped",
        Some(_) if note(dir)["hidden"] == false => "window",
        Some(_) => "hidden",
    }
}

/// Web addresses among a `tabs` answer, in order. Only those a session may
/// open again (http and https).
pub fn web_addresses(tabs: &Value) -> Vec<String> {
    tabs["tabs"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|t| t["url"].as_str())
        .filter(|u| u.starts_with("http://") || u.starts_with("https://"))
        .map(str::to_owned)
        .collect()
}

/// What of `wanted` is not open yet. Each open tab accounts for one wanted
/// address, so two tabs on the same page are both kept.
/// Web tabs of a `tabs` answer as (id, address), in order.
pub fn web_tabs(tabs: &Value) -> Vec<(u64, String)> {
    tabs["tabs"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|t| Some((t["id"].as_u64()?, t["url"].as_str()?.to_owned())))
        .filter(|(_, u)| u.starts_with("http://") || u.starts_with("https://"))
        .collect()
}

/// After a restart: which tab now is which tab before, matched by address
/// in order. (old id, id now) for each tab that is open again.
pub fn adopt_pairs(before: &[(u64, String)], now: &Value) -> Vec<(u64, u64)> {
    let mut free = web_tabs(now);
    let mut out = Vec::new();
    for (old, url) in before {
        if let Some(i) = free.iter().position(|(_, u)| u == url) {
            let (id, _) = free.remove(i);
            if id != *old {
                out.push((*old, id));
            }
        }
    }
    out
}

pub fn missing(wanted: &[String], open: &[String]) -> Vec<String> {
    let mut open = open.to_vec();
    let mut out = Vec::new();
    for w in wanted {
        match open.iter().position(|o| o == w) {
            Some(i) => {
                open.swap_remove(i);
            }
            None => out.push(w.clone()),
        }
    }
    out
}

/// A proxy address as the browser takes it: `scheme://host:port`. A name
/// and password cannot be given this way, so they are refused, not dropped.
pub fn valid_proxy(text: &str) -> Result<String, String> {
    let u = url::Url::parse(text.trim()).map_err(|_| format!("'{text}' is not a proxy address; write it like socks5://127.0.0.1:9050"))?;
    if !["http", "https", "socks4", "socks5"].contains(&u.scheme()) {
        return Err(format!("a proxy is http, https, socks4 or socks5, not {}", u.scheme()));
    }
    if !u.username().is_empty() || u.password().is_some() {
        return Err("a proxy with a name and password cannot be set this way: the browser asks for them when the proxy does".into());
    }
    let host = u.host_str().filter(|h| !h.is_empty()).ok_or("the proxy address has no host")?;
    let port = u.port_or_known_default().or(if u.scheme().starts_with("socks") { Some(1080) } else { None }).ok_or("the proxy address has no port")?;
    Ok(format!("{}://{host}:{port}", u.scheme()))
}

/// `proxy=<address>` or `proxy=none` among the arguments: Some(None) clears it.
fn proxy_among(args: &[String]) -> Result<Option<Option<String>>, String> {
    let Some(value) = args.iter().find_map(|a| a.strip_prefix("proxy=")) else { return Ok(None) };
    if value.is_empty() || value == "none" || value == "off" {
        return Ok(Some(None));
    }
    valid_proxy(value).map(|p| Some(Some(p)))
}

/// Says who made a session ("cli" or "page").
pub fn mark_by(name: &str, by: &str) {
    if let Ok(dir) = existing(name) {
        let mut n = note(&dir);
        n["by"] = json!(by);
        write_note(&dir, &n);
    }
}

/// Names of the extensions installed in a session's own profile (from the
/// store, in its window). Gamblium's own is loaded from outside and not listed.
pub fn installed_extensions(dir: &Path) -> Vec<String> {
    let mut names = Vec::new();
    let root = dir.join("Default").join("Extensions");
    for ext in fs::read_dir(&root).into_iter().flatten().flatten() {
        // One folder per version; the last is the one in use.
        let mut versions: Vec<PathBuf> = fs::read_dir(ext.path()).into_iter().flatten().flatten().map(|v| v.path()).filter(|v| v.is_dir()).collect();
        versions.sort();
        let Some(version) = versions.pop() else { continue };
        let Some(manifest) = fs::read_to_string(version.join("manifest.json")).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) else { continue };
        let mut name = manifest["name"].as_str().unwrap_or("").to_owned();
        // "__MSG_appName__": the real name is in the default language's messages.
        if let Some(key) = name.strip_prefix("__MSG_").and_then(|k| k.strip_suffix("__")).map(str::to_owned) {
            let locale = manifest["default_locale"].as_str().unwrap_or("en");
            let messages = fs::read_to_string(version.join("_locales").join(locale).join("messages.json")).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok());
            name = messages
                .as_ref()
                .and_then(|m| m.as_object())
                .and_then(|m| m.iter().find(|(k, _)| k.eq_ignore_ascii_case(&key)))
                .and_then(|(_, v)| v["message"].as_str())
                .unwrap_or("")
                .to_owned();
        }
        if !name.is_empty() {
            names.push(name);
        }
    }
    names.sort();
    names
}

/// `name=on` or `name=off` among the arguments.
fn switch_among(args: &[String], name: &str) -> Result<Option<bool>, String> {
    let Some(value) = args.iter().find_map(|a| a.strip_prefix(name).and_then(|r| r.strip_prefix('='))) else { return Ok(None) };
    match value {
        "on" | "true" | "yes" => Ok(Some(true)),
        "off" | "false" | "no" => Ok(Some(false)),
        other => Err(format!("{name} is on or off, not '{other}'")),
    }
}

/// Ids of the pages that are showing (the front tab of each window): web
/// pages, and the New Tab page a session starts on. That page draws a clock
/// and a background all the time; left awake behind the agent's tabs it
/// cost an idle session 1.4% of one core in its own process and 1.4% in the
/// graphics process (measured: 3.3% with it awake, 0.2% with it asleep).
pub fn showing_web_tabs(tabs: &Value) -> Vec<u64> {
    tabs["tabs"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|t| t["active"] == true && t["url"].as_str().is_some_and(|u| u.starts_with("http://") || u.starts_with("https://") || u.starts_with("chrome://newtab")))
        .filter_map(|t| t["id"].as_u64())
        .collect()
}

fn ask(bridge: &BridgeInfo, cmd: Value) -> Option<Value> {
    host::ctl(bridge, &cmd, 8_000).ok()
}

/// Starts the session's browser and waits until it takes commands.
fn start(dir: &Path, hidden: bool) -> Result<BridgeInfo, String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let me = std::env::current_exe().map_err(|e| e.to_string())?;
    // Or the browser inherits the terminal's pipe and whoever called us waits for it.
    crate::launch::keep_our_output_to_ourselves();
    let mut cmd = Command::new(me);
    cmd.args(["launch", "--agent", "--user-data-dir"]).arg(dir);
    // The session's own proxy, every time it starts.
    if let Some(proxy) = note(dir)["proxy"].as_str() {
        cmd.args(["--proxy", proxy]);
    }
    if hidden {
        // Without a size a hidden page is 762 x 490, which many sites lay out as a phone.
        cmd.args(["--hidden", "--", "--window-size=1280,800"]);
        // Nobody is looking: pictures and web fonts are not fetched or decoded
        // unless the session asks for them (`set NAME images=on`). Scripts and
        // the page's structure, which an agent works with, are untouched.
        // Tester, same 8-site job: 121% of one core and 1379 MB with them,
        // 98% and 1301 MB without. In a window they are always on.
        if note(dir)["images"] != true {
            cmd.args(LEAN_PAGE_SWITCHES);
        }
    }
    let out = cmd.output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        let said = String::from_utf8_lossy(&out.stderr);
        return Err(said.trim().trim_start_matches("error: ").to_owned());
    }
    let mut n = note(dir);
    n["hidden"] = json!(hidden);
    write_note(dir, &n);

    let deadline = Instant::now() + Duration::from_secs(45);
    let bridge = loop {
        if let Some(b) = bridge_of(dir) {
            // The bridge file is there a moment before the extension answers.
            if ask(&b, json!({ "op": "info" })).is_some_and(|a| a["ok"] == true) {
                break b;
            }
        }
        if Instant::now() > deadline {
            return Err("the browser started but does not take commands (45 s). Is Gamblium installed? Run: gamblium install".into());
        }
        std::thread::sleep(Duration::from_millis(250));
    };
    // Hidden: pictures off for every page. In a window, or asked for: the browser's own rule.
    ask(&bridge, json!({ "op": "lean", "on": hidden && n["images"] != true }));
    // The tabs the session had when it stopped.
    let wanted: Vec<String> = n["tabs"].as_array().into_iter().flatten().filter_map(|t| t.as_str().map(str::to_owned)).collect();
    if !wanted.is_empty() {
        let open = ask(&bridge, json!({ "op": "tabs" })).map(|t| web_addresses(&t)).unwrap_or_default();
        for url in missing(&wanted, &open) {
            ask(&bridge, json!({ "op": "open", "url": url, "background": true }));
        }
        // Each answers to the id it had before the restart: an agent's ids
        // hold through `open`, `hide` and stops (owner: one id for life).
        let ids: Vec<u64> = n["tabIds"].as_array().into_iter().flatten().filter_map(Value::as_u64).collect();
        if ids.len() == wanted.len() {
            let before: Vec<(u64, String)> = ids.into_iter().zip(wanted.iter().cloned()).collect();
            if let Some(now) = ask(&bridge, json!({ "op": "tabs" })) {
                let pairs = adopt_pairs(&before, &now);
                if !pairs.is_empty() {
                    let text: Vec<String> = pairs.iter().map(|(a, b)| format!("{a}:{b}")).collect();
                    ask(&bridge, json!({ "op": "tab-ids-adopt", "pairs": text.join(",") }));
                }
            }
        }
        // They come back asleep: no page is loaded, no memory or CPU is used,
        // until a command is sent to one of them, which wakes that tab alone.
        ask(&bridge, json!({ "op": "sleep-others" }));
    }
    Ok(bridge)
}

/// Minimises every window of a session that runs as a window for an agent:
/// a real browser, out of the person's way.
fn minimise(bridge: &BridgeInfo) {
    if let Some(w) = ask(bridge, json!({ "op": "windows" })) {
        for id in w["windows"].as_array().into_iter().flatten().filter_map(|w| w["id"].as_u64()) {
            ask(bridge, json!({ "op": "window-set", "window": id, "state": "minimized" }));
        }
    }
}

/// Starts the session the way it runs for an agent: hidden, or with
/// `window=on` as an ordinary window, minimised.
fn start_for_agent(dir: &Path) -> Result<BridgeInfo, String> {
    let windowed = note(dir)["window"] == true;
    let bridge = start(dir, !windowed)?;
    if windowed {
        minimise(&bridge);
    }
    Ok(bridge)
}

/// The session's browser, started for an agent if it is not running.
fn ready(dir: &Path) -> Result<BridgeInfo, String> {
    if pid_of(dir).is_none() {
        return start_for_agent(dir);
    }
    // Running: it may still be starting, so give its bridge a moment.
    for _ in 0..80 {
        if let Some(b) = bridge_of(dir) {
            return Ok(b);
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    Err("the session's browser is running but does not take commands. Stop it with: gamblium-cli close <name>".into())
}

/// Writes the open tabs down and stops the browser. True if one was running.
fn stop(dir: &Path) -> bool {
    let Some(pid) = pid_of(dir) else { return false };
    if let Some(bridge) = bridge_of(dir) {
        if let Some(tabs) = ask(&bridge, json!({ "op": "tabs" })) {
            let mut n = note(dir);
            let web = web_tabs(&tabs);
            n["tabs"] = json!(web.iter().map(|(_, u)| u.clone()).collect::<Vec<_>>());
            n["tabIds"] = json!(web.iter().map(|(id, _)| *id).collect::<Vec<_>>());
            write_note(dir, &n);
        }
    }
    let taskkill = |args: &[&str]| {
        let _ = Command::new("taskkill").args(args).output();
    };
    let id = pid.to_string();
    if note(dir)["hidden"] == false {
        // A window can be asked to close, as a click on its close button would.
        taskkill(&["/PID", &id]);
        for _ in 0..12 {
            if !crate::procs::is_running(pid) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(250));
        }
    }
    // A hidden browser has no window to ask (and closing its last tab does
    // not end it: tried), so it is stopped, and the exit marked as clean.
    taskkill(&["/T", "/F", "/PID", &id]);
    for _ in 0..20 {
        if !crate::procs::is_running(pid) {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let _ = crate::launch::mark_clean_exit(dir);
    true
}

fn names() -> Vec<String> {
    let mut out: Vec<String> = root()
        .and_then(|r| fs::read_dir(r).ok())
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.path().is_dir())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| valid_name(n))
        .collect();
    out.sort();
    out
}

fn row(name: &str, dir: &Path) -> Value {
    // `applies`: what the session brings with it every time it is used.
    // `by`: "cli" (made from the command line, by an agent or a person) or
    // "page" (made on the Sessions page).
    let n = note(dir);
    json!({
        "name": name, "state": state_of(dir), "folder": dir, "by": n["by"].as_str().unwrap_or("cli"),
        "applies": { "proxy": n["proxy"], "extensions": installed_extensions(dir), "always": true },
        // Hidden: pictures and web fonts off unless asked for. One tab at work:
        // opening the next page puts the one before to sleep.
        "images": n["images"] == true, "keepTabs": n["keepTabs"] == true,
    })
}

pub fn command(args: &[String]) -> Result<Value, String> {
    let name_at = |i: usize| args.get(i).map(String::as_str).ok_or("which session? Give its name");
    match args[0].as_str() {
        "create" | "new" => {
            let name = name_at(1)?;
            let dir = dir_of(name)?;
            if dir.is_dir() {
                return Err(format!("the session '{name}' is already there ({}). Send it commands: gamblium-cli {name} tabs", state_of(&dir)));
            }
            let window = args.iter().skip(2).any(|a| a == "--window");
            if let Some(Some(proxy)) = proxy_among(&args[2..])? {
                fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
                write_note(&dir, &json!({ "proxy": proxy }));
            }
            if let Err(e) = start(&dir, !window) {
                // Nothing of a session that never started is left behind.
                if pid_of(&dir).is_none() {
                    let _ = fs::remove_dir_all(&dir);
                }
                return Err(e);
            }
            Ok(json!({ "ok": true, "session": row(name, &dir), "next": format!("gamblium-cli {name} open url=https://example.com wait=true") }))
        }
        "list" | "ls" => {
            let list: Vec<Value> = names().iter().filter_map(|n| dir_of(n).ok().map(|d| row(n, &d))).collect();
            Ok(json!({ "ok": true, "sessions": list }))
        }
        op @ ("open" | "show" | "hide") => {
            let name = name_at(1)?;
            let dir = existing(name)?;
            let hidden = op == "hide";
            let want = if hidden { "hidden" } else { "window" };
            if state_of(&dir) != want {
                stop(&dir);
                start(&dir, hidden)?;
            }
            Ok(json!({ "ok": true, "session": row(name, &dir) }))
        }
        "set" => {
            let name = name_at(1)?;
            let dir = existing(name)?;
            let proxy = proxy_among(&args[2..])?;
            let images = switch_among(&args[2..], "images")?;
            let keep = switch_among(&args[2..], "keep-tabs")?;
            let window = switch_among(&args[2..], "window")?;
            if proxy.is_none() && images.is_none() && keep.is_none() && window.is_none() {
                return Err("say what to set: proxy=<address>|none, images=on|off, keep-tabs=on|off, window=on|off".into());
            }
            let mut n = note(&dir);
            if let Some(p) = &proxy {
                n["proxy"] = json!(p);
            }
            if let Some(on) = images {
                n["images"] = json!(on);
            }
            if let Some(on) = keep {
                n["keepTabs"] = json!(on);
            }
            if let Some(on) = window {
                n["window"] = json!(on);
            }
            write_note(&dir, &n);
            let was = state_of(&dir);
            // Hidden <-> window: a running browser cannot change, so it starts again.
            if let Some(on) = window {
                if (on && was == "hidden") || (!on && was == "window") {
                    stop(&dir);
                    start_for_agent(&dir)?;
                    return Ok(json!({ "ok": true, "session": row(name, &dir) }));
                }
            }
            // Only the proxy and pictures need a new start.
            if proxy.is_none() && images.is_none() {
                return Ok(json!({ "ok": true, "session": row(name, &dir) }));
            }
            // A running browser keeps the proxy it started with: start it again.
            if was != "stopped" {
                stop(&dir);
                start(&dir, was == "hidden")?;
            }
            Ok(json!({ "ok": true, "session": row(name, &dir) }))
        }
        // A link sent to a session from the browser's own menus: the address
        // opens in front there. A stopped session starts in a window, since
        // a person asked for it.
        "open-url" => {
            let name = name_at(1)?;
            let dir = existing(name)?;
            let address = args.get(2).map(String::as_str).unwrap_or("");
            if !(address.starts_with("http://") || address.starts_with("https://")) {
                return Err("only web addresses (http, https) can be opened in a session".into());
            }
            let bridge = if pid_of(&dir).is_none() { start(&dir, false)? } else { ready(&dir)? };
            let answer = ask(&bridge, json!({ "op": "open", "url": address })).ok_or("the session did not answer")?;
            if answer["ok"] != true {
                return Err(answer["error"].as_str().unwrap_or("the session could not open that address").to_owned());
            }
            Ok(json!({ "ok": true, "session": row(name, &dir), "tab": answer["tab"]["id"] }))
        }
        "close" | "stop" => {
            let name = name_at(1)?;
            let dir = existing(name)?;
            let was_running = stop(&dir);
            Ok(json!({ "ok": true, "session": row(name, &dir), "wasRunning": was_running }))
        }
        "delete" => {
            let name = name_at(1)?;
            let dir = existing(name)?;
            stop(&dir);
            // The browser lets go of its files a moment after it ends.
            let mut last = String::new();
            for _ in 0..20 {
                match fs::remove_dir_all(&dir) {
                    Ok(()) => return Ok(json!({ "ok": true, "deleted": name })),
                    Err(e) => last = e.to_string(),
                }
                std::thread::sleep(Duration::from_millis(250));
            }
            Err(format!("could not delete {}: {last}", dir.display()))
        }
        name => {
            let dir = existing(name)?;
            let mut rest: Vec<String> = args[1..].to_vec();
            // A page that waits may first wait out a site's automatic check (up to 30 s).
            let mut timeout = if args.iter().any(|a| a == "wait=true") { 75u64 } else { 30u64 };
            if let Some(i) = rest.iter().position(|a| a == "--timeout") {
                let secs = rest.get(i + 1).and_then(|s| s.parse().ok()).ok_or("--timeout needs a number of seconds")?;
                timeout = secs;
                rest.drain(i..=i + 1);
            }
            let Some(op) = rest.first().cloned() else {
                return Ok(json!({ "ok": true, "session": row(name, &dir) }));
            };
            let bridge = ready(&dir)?;
            // One tab at work: when the next page is opened in front, the tab
            // that was showing is put to sleep. It keeps its place and wakes
            // on the next command for it. (Tester: one working tab instead of
            // eight took the same job from 121% of one core and 1379 MB to
            // 35% and 717 MB.) `keep=true` on the command, or `set NAME
            // keep-tabs=on`, leaves it awake.
            let asked_to_keep = rest[1..].iter().any(|a| a == "keep=true");
            let in_front = !rest[1..].iter().any(|a| a == "background=true");
            let before: Vec<u64> = if op == "open" && in_front && !asked_to_keep && note(&dir)["keepTabs"] != true {
                ask(&bridge, json!({ "op": "tabs" })).map(|t| showing_web_tabs(&t)).unwrap_or_default()
            } else {
                Vec::new()
            };
            let pass: Vec<String> = rest[1..].iter().filter(|a| *a != "keep=true").cloned().collect();
            let mut answer = crate::ctl_with(&bridge, &op, &pass, timeout)?;
            // Hints name the session as <name>: say which one.
            if let Some(h) = answer["hint"].as_str() {
                answer["hint"] = json!(h.replace("<name>", name));
            }
            if answer["ok"] == true && !before.is_empty() {
                let ids: Vec<String> = before.iter().map(u64::to_string).collect();
                ask(&bridge, json!({ "op": "sleep", "tabs": ids.join(",") }));
            }
            Ok(answer)
        }
    }
}

/// Runs one `gamblium-cli` command line and returns the exit code.
pub fn run(args: &[String]) -> i32 {
    match args.first().map(String::as_str) {
        None | Some("help" | "--help" | "-h") => {
            println!("{USAGE}");
            0
        }
        Some("version" | "--version" | "-V") => {
            println!("gamblium-cli {}", env!("CARGO_PKG_VERSION"));
            0
        }
        Some(_) => match command(args) {
            Ok(answer) => {
                println!("{}", serde_json::to_string_pretty(&answer).unwrap());
                if answer["ok"] == false { 1 } else { 0 }
            }
            Err(e) => {
                println!("{}", json!({ "ok": false, "error": e }));
                1
            }
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_plain_words_and_never_a_command() {
        for good in ["work", "bank-2", "a_b", "X"] {
            assert!(valid_name(good), "{good}");
        }
        for bad in ["", "create", "List", "open", "help", "a b", "..", "a/b", r"a\b", "-x", "a.b", &"x".repeat(41)] {
            assert!(!valid_name(bad), "{bad}");
        }
    }

    #[test]
    fn a_proxy_is_scheme_host_and_port_and_never_carries_a_password() {
        assert_eq!(valid_proxy("socks5://127.0.0.1:9050").unwrap(), "socks5://127.0.0.1:9050");
        assert_eq!(valid_proxy(" http://proxy.example:8080/ ").unwrap(), "http://proxy.example:8080");
        assert_eq!(valid_proxy("socks5://localhost").unwrap(), "socks5://localhost:1080");
        assert_eq!(valid_proxy("http://proxy.example").unwrap(), "http://proxy.example:80");
        for bad in ["127.0.0.1:9050", "ftp://x:1", "http://me:secret@proxy.example:8080", "socks5://", "nonsense"] {
            assert!(valid_proxy(bad).is_err(), "{bad}");
        }
        let args = |list: &[&str]| list.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        assert_eq!(proxy_among(&args(&["--window"])).unwrap(), None);
        assert_eq!(proxy_among(&args(&["proxy=none"])).unwrap(), Some(None));
        assert_eq!(proxy_among(&args(&["--window", "proxy=socks5://127.0.0.1:9050"])).unwrap(), Some(Some("socks5://127.0.0.1:9050".into())));
        assert!(proxy_among(&args(&["proxy=bogus"])).is_err());
    }

    #[test]
    fn installed_extensions_are_named_from_the_profile_in_their_default_language() {
        let dir = std::env::temp_dir().join(format!("gamblium-ext-names-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let exts = dir.join("Default").join("Extensions");
        let plain = exts.join("aaaa").join("1.0_0");
        fs::create_dir_all(&plain).unwrap();
        fs::write(plain.join("manifest.json"), r#"{"name":"Plain One"}"#).unwrap();
        // Two versions: the later one counts. Its name is in the messages file.
        let old = exts.join("bbbb").join("1.0_0");
        fs::create_dir_all(&old).unwrap();
        fs::write(old.join("manifest.json"), r#"{"name":"Old Name"}"#).unwrap();
        let new = exts.join("bbbb").join("2.0_0");
        fs::create_dir_all(new.join("_locales").join("en_US")).unwrap();
        fs::write(new.join("manifest.json"), r#"{"name":"__MSG_appName__","default_locale":"en_US"}"#).unwrap();
        fs::write(new.join("_locales").join("en_US").join("messages.json"), r#"{"appname":{"message":"Translated Two"}}"#).unwrap();
        assert_eq!(installed_extensions(&dir), ["Plain One", "Translated Two"]);
        assert!(installed_extensions(&dir.join("nothing")).is_empty());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn switches_are_on_or_off_and_only_showing_web_pages_are_put_to_sleep() {
        let args = |list: &[&str]| list.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        assert_eq!(switch_among(&args(&["images=on"]), "images").unwrap(), Some(true));
        assert_eq!(switch_among(&args(&["window=on"]), "window").unwrap(), Some(true));
        assert_eq!(switch_among(&args(&["proxy=none", "keep-tabs=off"]), "keep-tabs").unwrap(), Some(false));
        assert_eq!(switch_among(&args(&["imagesize=on"]), "images").unwrap(), None);
        assert!(switch_among(&args(&["images=maybe"]), "images").is_err());
        let tabs = json!({ "tabs": [
            { "id": 1, "active": true, "url": "https://a.example/" }, { "id": 2, "active": false, "url": "https://b.example/" },
            { "id": 3, "active": true, "url": "chrome://newtab/" }, { "id": 4, "active": true, "url": "http://c.example/" },
        ] });
        assert_eq!(showing_web_tabs(&tabs), [1, 3, 4]);
        let other = json!({ "tabs": [{ "id": 9, "active": true, "url": "chrome://settings/" }, { "id": 8, "active": false, "url": "chrome://newtab/" }] });
        assert!(showing_web_tabs(&other).is_empty());
    }

    #[test]
    fn only_web_addresses_are_written_down() {
        let tabs = json!({ "tabs": [
            { "url": "https://a.example/x" }, { "url": "chrome://newtab/" }, { "url": "http://b.example/" },
            { "url": "chrome-extension://abc/page.html" }, { "url": "file:///C:/secret.txt" }, { "url": "" },
        ] });
        assert_eq!(web_addresses(&tabs), ["https://a.example/x", "http://b.example/"]);
        assert!(web_addresses(&json!({ "ok": false })).is_empty());
    }

    #[test]
    fn a_tab_already_open_is_not_opened_twice_but_two_of_the_same_are_kept() {
        let s = |list: &[&str]| list.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        assert_eq!(missing(&s(&["a", "b"]), &s(&[])), s(&["a", "b"]));
        assert_eq!(missing(&s(&["a", "b"]), &s(&["b", "x"])), s(&["a"]));
        assert_eq!(missing(&s(&["a", "a"]), &s(&["a"])), s(&["a"]));
        assert!(missing(&s(&["a"]), &s(&["a", "a"])).is_empty());
    }

    #[test]
    fn folders_compare_without_case_slash_direction_or_a_trailing_slash() {
        assert!(same("C:/Users/X/AppData/Local/Gamblium/sessions/Work/", Path::new(r"c:\users\x\appdata\local\gamblium\sessions\work")));
        assert!(!same(r"c:\gamblium\sessions\work2", Path::new(r"c:\gamblium\sessions\work")));
    }

    #[test]
    fn reopened_tabs_take_over_their_old_ids_by_address_in_order() {
        let before = vec![(10, "https://a/".to_owned()), (11, "https://b/".to_owned()), (12, "https://a/".to_owned()), (13, "https://gone/".to_owned())];
        let now = json!({ "tabs": [
            { "id": 500, "url": "https://a/" }, { "id": 501, "url": "chrome://newtab/" },
            { "id": 502, "url": "https://b/" }, { "id": 503, "url": "https://a/" }
        ] });
        assert_eq!(adopt_pairs(&before, &now), vec![(10, 500), (11, 502), (12, 503)]);
        assert_eq!(web_tabs(&now).len(), 3);
    }
}

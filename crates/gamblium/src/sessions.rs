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
const RESERVED: [&str; 25] = [
    "create", "new", "open", "show", "hide", "close", "stop", "list", "ls", "delete", "set", "help", "version", "open-url", "fork", "clone", "prepare-spare", "warm-up",
    "rename", "main", "default", "open-set", "focus", "begin", "start-mode",
];
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
  gamblium-cli fork <new> [from=<session>] [--window]
                                          a new session with the sign-ins of
                                          <session> (default: your own
                                          Gamblium, which asks you first) and
                                          none of its tabs
  gamblium-cli clone <session> <new> [--window]
                                          the same sign-ins AND tabs; a clone
                                          of a main session is a main session,
                                          of a child a child of the same parent
  gamblium-cli rename <session> <new>     a new name; the id stays
  gamblium-cli open-set <#set|name|open> in=<session>
                                          a tab set saved in your own Gamblium
                                          (or `open`: the tabs open there now)
                                          opened, asleep, in a named session
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
Answers are JSON. A session is named by its name (up to 40 characters; spaces
and capitals do not make a new one: \"My Work\" and \"my  work\" are the same) or
exactly by its id, shown in `list`: gamblium-cli #k3f9qa text. Names with
spaces go in quotes. A rename changes only the name; the id stays.";

pub fn root() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join("Gamblium").join("sessions"))
}

/// A name as people mean it: spaces at the ends dropped, runs of spaces made one.
pub fn tidy_name(name: &str) -> String {
    name.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Two names are the same session when they differ only in spaces or capitals (owner,
/// Nov 15 2026: no two sessions may share a name).
pub fn name_key(name: &str) -> String {
    tidy_name(name).to_lowercase()
}

/// A session's name is a label: up to 40 characters, spaces allowed, not a command word, not
/// starting with - (an option) or # (an id).
pub fn valid_name(name: &str) -> bool {
    let t = tidy_name(name);
    !t.is_empty()
        && t.chars().count() <= 40
        && !t.chars().any(|c| c.is_control() || "<>:\"|?*/\\".contains(c))
        && !t.starts_with('-')
        && !t.starts_with('#')
        && !RESERVED.contains(&t.to_lowercase().as_str())
}

/// A session's id: 6 letters and digits that cannot be misread (no l, o, 0, 1), made once and
/// never changed. Its folder is called by it, so a rename is only a new label, and an agent or
/// a person can name a session exactly with `#id`.
const ID_CHARS: &[u8] = b"abcdefghijkmnpqrstuvwxyz23456789";
fn new_id(taken: &[String]) -> String {
    loop {
        let mut b = [0u8; 6];
        let _ = getrandom::getrandom(&mut b);
        let id: String = b.iter().map(|x| ID_CHARS[(*x as usize) % ID_CHARS.len()] as char).collect();
        if !taken.contains(&id) {
            return id;
        }
    }
}

/// One session: its id, its name and its folder.
#[derive(Clone)]
struct Entry {
    id: String,
    name: String,
    dir: PathBuf,
}

/// Every session. A folder from before ids (named by its name) is given an id and keeps its
/// name as the label.
fn entries() -> Vec<Entry> {
    let dirs: Vec<PathBuf> = root().and_then(|r| fs::read_dir(r).ok()).into_iter().flatten().flatten().map(|e| e.path())
        // `.components` (pack.rs, the browser parts sessions share) and any other dot-folder is not a session.
        .filter(|p| p.is_dir() && !p.file_name().is_some_and(|n| n.to_string_lossy().starts_with('.')))
        .collect();
    // Ids and names both: a legacy folder's new id never equals a session's name (review 7, E5).
    let mut taken: Vec<String> = dirs.iter().flat_map(|d| { let n = note(d); [n["id"].as_str().map(str::to_owned), n["name"].as_str().map(name_key)] }).flatten().collect();
    let mut out = Vec::new();
    for dir in dirs {
        let folder = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let mut n = note(&dir);
        let folder_is_id = folder.len() == 6 && folder.bytes().all(|b| ID_CHARS.contains(&b));
        let unreadable = dir.join(NOTE).is_file() && n.as_object().is_none_or(|o| o.is_empty());
        let id = match n["id"].as_str() {
            Some(i) => i.to_owned(),
            // A session made since ids exist: its folder is its id, always.
            None if folder_is_id => folder.clone(),
            // A note being written by another program right now: leave it alone this time.
            None if unreadable => continue,
            None => {
                let i = new_id(&taken);
                taken.push(i.clone());
                n["id"] = json!(i);
                if n["name"].is_null() {
                    n["name"] = json!(folder);
                }
                write_note(&dir, &n);
                i
            }
        };
        let name = n["name"].as_str().map(str::to_owned).unwrap_or(folder);
        out.push(Entry { id, name, dir });
    }
    out.sort_by_key(|e| name_key(&e.name));
    out
}

/// Whether a session's browser ever showed a website or a file: its own history, read without
/// touching it. Anything that cannot be read counts as used (kept).
pub fn visited_anything(dir: &Path) -> bool {
    // A closed session is packed (pack.rs): its history is inside the pack, so it counts as used.
    // (Nov 16 2026: read as "no history", a used, packed window was removed.)
    if dir.join("profile.tar.zst").exists() {
        return true;
    }
    let history = dir.join("Default").join("History");
    if !history.is_file() {
        // No history file: never started, or something unexpected. Only a folder with no
        // profile in it at all counts as never used.
        return dir.join("Default").exists();
    }
    let url = format!("file:{}?immutable=1", history.to_string_lossy().replace('\\', "/"));
    let flags = rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI;
    let Ok(db) = rusqlite::Connection::open_with_flags(&url, flags) else { return true };
    db.query_row("SELECT COUNT(*) FROM urls WHERE url LIKE 'http%' OR url LIKE 'file:%'", [], |r| r.get::<_, i64>(0)).map(|n| n > 0).unwrap_or(true)
}

/// A window made by the menu with a made-up name ("Window 16 Nov 03.25"), never renamed, that
/// was closed having shown nothing but new tab pages leaves nothing behind (owner, Nov 16 2026).
/// Only stopped ones, a minute after they were made, and never a fork (it holds sign-ins).
pub fn unused_window(n: &Value, running: bool, used: bool, now_ms: u64) -> bool {
    let made = n["createdAt"].as_u64().unwrap_or(0);
    n["auto"] == true && n["parent"].is_null() && n["clonedFrom"].is_null() && !running && !used && made > 0 && now_ms.saturating_sub(made) > 60_000
        && n["tabs"].as_array().is_none_or(|t| t.iter().all(|u| !u.as_str().is_some_and(|u| u.starts_with("http") || u.starts_with("file:"))))
}

/// Where windows removed by the clean-up go: kept 14 days, so a mistake can be undone (owner's
/// data is never removed for good by a guess).
fn removed_dir() -> Option<PathBuf> {
    root().and_then(|r| r.parent().map(|p| p.join("sessions-removed")))
}
fn put_aside(dir: &Path) {
    let Some(bin) = removed_dir() else { return };
    let _ = fs::create_dir_all(&bin);
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let name = dir.file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default();
    let _ = fs::rename(dir, bin.join(format!("{name}-{stamp}")));
}
fn empty_removed(now_ms: u64) {
    let Some(bin) = removed_dir() else { return };
    let Ok(list) = fs::read_dir(&bin) else { return };
    for d in list.flatten() {
        // Its age is the stamp put_aside wrote into its name (a rename keeps the folder's old
        // write time, so that read every window as long expired).
        let set_aside = d.file_name().to_string_lossy().rsplit('-').next().and_then(|t| t.parse::<u64>().ok());
        let old = set_aside.map(|secs| now_ms.saturating_sub(secs * 1000) > 14 * 86_400_000);
        if old == Some(true) {
            let _ = fs::remove_dir_all(d.path());
        }
    }
}

fn prune_unused() {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    empty_removed(now);
    for e in entries() {
        let n = note(&e.dir);
        let running = pid_of(&e.dir).is_some();
        let made = n["createdAt"].as_u64().unwrap_or(0);
        // A No session window is not kept as a session once its browser has closed (Local State
        // written as it ends). One that showed a website or a file is set aside for 14 days like
        // any removed window, never deleted on the spot (Nov 28 2026: a used No session window was
        // deleted for good by the next icon start, issue #2); one that showed nothing goes now.
        // Age first, then the lock: a brand-new window's lockfile is never opened (review 3, A19);
        // a start still being made (the launcher's mark, up to 120 s) counts as in use.
        if n["temp"] == true && now.saturating_sub(made) > 60_000 && !running && !crate::pack::in_use(&e.dir) {
            if visited_anything(&e.dir) {
                put_aside(&e.dir);
            } else {
                let _ = fs::remove_dir_all(&e.dir);
            }
            continue;
        }
        if n["auto"] != true || running {
            continue;
        }
        if unused_window(&n, running, visited_anything(&e.dir), now) {
            put_aside(&e.dir);
        }
    }
}

/// A running session shown in a window (not hidden for an agent).
pub fn has_window(dir: &Path) -> bool {
    pid_of(dir).is_some() && note(dir)["hidden"] != true
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// The owner's own Gamblium, closed a while and not yet packed: packed in the background (its
/// own program, so whoever asked does not wait). Asked when sessions are listed and at start.
/// Every profile folder Gamblium packs: the owner's own and each session's.
pub fn all_profile_dirs() -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = entries().into_iter().map(|e| e.dir).collect();
    if let Some(own) = crate::install::profile_dir() {
        v.push(own);
    }
    v
}

pub fn pack_own_soon() {
    if !crate::pack::PACKING_ON {
        return;
    }
    let Some(own) = crate::install::profile_dir() else { return };
    crate::pack::drop_previous_if_settled(&own);
    // At most every 10 minutes (every helper start asked, each with a process snapshot; review 2, 1.13).
    let mark = own.parent().map(|p| p.join("pack-own-checked"));
    if let Some(m) = &mark {
        if fs::metadata(m).and_then(|x| x.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|e| e.as_secs() < 600) {
            return;
        }
        let _ = fs::write(m, b"");
    }
    if crate::pack::is_packed(&own) || crate::pack::is_packing(&own) || crate::pack::in_use(&own) || crate::procs::browser_running(BROWSER_EXE, Some(&own)) {
        return;
    }
    if !closed_at(&own).is_some_and(|t| now_ms().saturating_sub(t) > 120_000) {
        return;
    }
    if let Ok(me) = std::env::current_exe() {
        let _ = crate::launch::spawn_outliving(&me.with_file_name("gamblium.exe"), &["pack-own".to_owned()]);
    }
}

/// When the browser of a profile folder last closed: it writes `Local State` as it ends.
/// A stopped session may be packed (pack.rs): then the pack's own time says when.
pub fn closed_at(dir: &Path) -> Option<u64> {
    if let Some(t) = crate::pack::closed_at_kept(dir) {
        return Some(t);
    }
    let t = fs::metadata(dir.join("Local State")).and_then(|m| m.modified()).ok()?;
    t.duration_since(std::time::UNIX_EPOCH).ok().map(|d| d.as_millis() as u64)
}

// ---- How Gamblium starts (owner, Nov 16 2026) -------------------------------------------------
// "fresh" (the default): a neutral window that belongs to no session ("No session"), its New Tab
// page offering the sessions; nothing of it is kept once it is closed. "last": the session closed
// last (the owner's own Gamblium or a named one) comes back with its windows and tabs.
fn start_mode_file() -> Option<PathBuf> {
    root().and_then(|r| r.parent().map(|p| p.join("start-mode.txt")))
}
pub fn start_mode() -> &'static str {
    match start_mode_file().and_then(|f| fs::read_to_string(f).ok()).as_deref().map(str::trim) {
        Some("last") => "last",
        _ => "fresh",
    }
}

/// The neutral window: the running one gets a new window; otherwise a new one is made (the
/// closed ones were removed when sessions were listed, or are removed now).
fn begin_fresh() -> Result<Value, String> {
    neutral_window(&[])
}

/// A file opened with Gamblium (a PDF from Explorer) belongs to no session (owner, Nov 16 2026: it
/// opened in the owner's own Gamblium with all its old tabs): it opens in the neutral window, in
/// a new tab if one is open, or in a new neutral window. From there it can be moved to a session.
pub fn open_neutral(address: &str) -> Result<Value, String> {
    neutral_window(&[address.to_owned()])
}

// ---- A spare No session folder, made ready ahead (owner, Nov 20 2026: the Gamblium icon took 3.5
// to 7 s). Every icon start made a brand-new profile, and a new profile's first start does its
// one-time steps first (private windows, new extension code: about 4 s measured). A spare has done
// them already, in the background after the previous start; a click only renames it into place
// (same disk) and starts it. Each window is still a fresh profile of its own.
const SPARE_READY: &str = "gamblium-spare-ready";

pub fn spare_dir() -> Option<PathBuf> {
    spare_root()
}

fn spare_root() -> Option<PathBuf> {
    root().and_then(|r| r.parent().map(|p| p.join("spare-window")))
}

/// The ready spare, moved into the sessions folder under its own id.
fn take_spare() -> Option<(String, PathBuf)> {
    let sr = spare_root()?;
    let e = fs::read_dir(&sr).ok()?.flatten().find(|e| e.path().join(SPARE_READY).is_file())?;
    let id = e.file_name().to_string_lossy().into_owned();
    let taken: Vec<String> = entries().iter().flat_map(|x| [x.id.clone(), name_key(&x.name)]).collect();
    if taken.contains(&id) {
        let _ = fs::remove_dir_all(e.path());
        return None;
    }
    let dest = root()?.join(&id);
    fs::rename(e.path(), &dest).ok()?;
    let _ = fs::remove_file(dest.join(SPARE_READY));
    Some((id, dest))
}

/// Makes the next spare ready, in a program of its own, so the caller does not wait.
fn prepare_spare_soon() {
    if let Ok(me) = std::env::current_exe() {
        let _ = crate::launch::spawn_outliving(&me.with_file_name("gamblium.exe"), &["cli".to_owned(), "prepare-spare".to_owned()]);
    }
}

/// `prepare-spare`: one ready spare at most; half-made ones (a stopped preparation) are removed.
fn prepare_spare() -> Result<Value, String> {
    std::env::remove_var("GAMBLIUM_HOME");
    let sr = spare_root().ok_or("LOCALAPPDATA is not set")?;
    fs::create_dir_all(&sr).map_err(|e| e.to_string())?;
    for e in fs::read_dir(&sr).map_err(|e| e.to_string())?.flatten() {
        if e.path().join(SPARE_READY).is_file() {
            return Ok(json!({ "ok": true, "spare": "already ready" }));
        }
        let old = e.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|t| t.as_secs() > 300);
        if old {
            let _ = fs::remove_dir_all(e.path());
        } else {
            return Ok(json!({ "ok": true, "spare": "being prepared" }));
        }
    }
    let taken: Vec<String> = entries().iter().flat_map(|x| [x.id.clone(), name_key(&x.name)]).collect();
    let id = new_id(&taken);
    let dir = sr.join(&id);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let me = std::env::current_exe().map_err(|e| e.to_string())?;
    crate::launch::keep_our_output_to_ourselves();
    // The same start a No session window gets (launch_session), stopped before the window.
    let out = crate::launch::no_console_window(&mut Command::new(me))
        .args(["launch", "--user-data-dir"])
        .arg(&dir)
        .args(["--theme", &owners_theme(), "--auto-dark", "--no-theme-extension", "--skip-welcome", "--prepare-only"])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        let _ = fs::remove_dir_all(&dir);
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_owned());
    }
    fs::write(dir.join(SPARE_READY), b"").map_err(|e| e.to_string())?;
    Ok(json!({ "ok": true, "spare": "ready", "id": id }))
}

/// `warm-up` (run by install): the old spare goes (it holds the previous code), every closed
/// person's profile does its one-time steps now (the hidden start for new extension code), and a
/// new spare is made ready. Running browsers are left alone (they take the code themselves).
fn warm_up() -> Result<Value, String> {
    // The installed extension, always: started by an install from a work folder, GAMBLIUM_HOME
    // pointed at that folder's unstamped copy (Personal was warmed on it, Nov 20 2026).
    std::env::remove_var("GAMBLIUM_HOME");
    if let Some(sr) = spare_root() {
        let _ = fs::remove_dir_all(&sr);
    }
    let me = std::env::current_exe().map_err(|e| e.to_string())?;
    crate::launch::keep_our_output_to_ourselves();
    let mut warmed = Vec::new();
    let run = |dir: &Path, args: &[&str]| -> bool {
        crate::launch::no_console_window(&mut Command::new(&me)).args(["launch", "--user-data-dir"]).arg(dir).args(args).arg("--prepare-only").output().is_ok_and(|o| o.status.success())
    };
    if let Some(own) = crate::install::profile_dir() {
        let running = crate::procs::browsers(BROWSER_EXE).into_iter().any(|(_, d)| d.as_deref().is_some_and(|d| same(d, &own)));
        // As the desktop icon starts it (bin/gamblium-app.rs).
        if own.join("Default").is_dir() && !running && run(&own, &["--theme", "moon-dark", "--auto-dark"]) {
            warmed.push("your own Gamblium".to_owned());
        }
    }
    for e in entries() {
        let n = note(&e.dir);
        if n["person"] != true || n["temp"] == true || n["test"] == true || pid_of(&e.dir).is_some() || !e.dir.join("Default").is_dir() {
            continue;
        }
        if run(&e.dir, &["--theme", &owners_theme(), "--auto-dark", "--no-theme-extension", "--skip-welcome"]) {
            warmed.push(e.name.clone());
        }
    }
    let spare = prepare_spare().unwrap_or_else(|e| json!({ "error": e }));
    Ok(json!({ "ok": true, "warmed": warmed, "spare": spare }))
}

fn neutral_window(urls: &[String]) -> Result<Value, String> {
    prune_unused();
    if let Some(e) = entries().into_iter().find(|e| note(&e.dir)["temp"] == true && pid_of(&e.dir).is_some()) {
        if urls.is_empty() {
            start(&e.dir, false).ok();
        } else {
            // The running browser takes the address as a new tab (the browser hands it over).
            let browser = crate::rebrand::copy_dir().map(|d| d.join("brave.exe")).filter(|p| p.is_file()).ok_or("the Gamblium browser copy is missing (gamblium rebrand)")?;
            let mut args = vec![format!("--user-data-dir={}", e.dir.display())];
            args.extend(urls.iter().cloned());
            crate::launch::spawn_detached(&browser, &args).map_err(|x| x.to_string())?;
        }
        return Ok(json!({ "ok": true, "started": "fresh", "session": row(&e.name, &e.dir) }));
    }
    let taken: Vec<String> = entries().iter().map(|e| name_key(&e.name)).collect();
    let name = (1..100).map(|k| if k == 1 { "No session".to_owned() } else { format!("No session {k}") }).find(|n| !taken.contains(&name_key(n))).ok_or("too many neutral windows")?;
    let dir = match take_spare() {
        Some((id, dir)) => {
            let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
            write_note(&dir, &json!({ "id": id, "name": name, "createdAt": at }));
            dir
        }
        None => make_new(&name)?.1,
    };
    let mut n = note(&dir);
    n["temp"] = json!(true);
    n["person"] = json!(true);
    n["auto"] = json!(true);
    n["by"] = json!("start");
    write_note(&dir, &n);
    if urls.is_empty() {
        start_window(&dir)?;
    } else {
        start_with(&dir, false, urls)?;
    }
    prepare_spare_soon();
    Ok(json!({ "ok": true, "started": "fresh", "session": row(&name, &dir) }))
}

/// The session closed last. `{"launch":"default"}` asks the caller to start the owner's own
/// Gamblium (it knows how). With everything open, the owner's own gets a new window.
fn begin_last() -> Result<Value, String> {
    let own = crate::install::profile_dir();
    let own_closed = own.as_deref().filter(|p| !crate::procs::browsers(BROWSER_EXE).into_iter().any(|(_, d)| d.as_deref().is_some_and(|d| same(d, p)))).and_then(closed_at);
    let best = entries()
        .into_iter()
        .filter(|e| {
            let n = note(&e.dir);
            n["temp"] != true && n["test"] != true && pid_of(&e.dir).is_none()
        })
        .filter_map(|e| closed_at(&e.dir).map(|t| (t, e)))
        .max_by_key(|(t, _)| *t);
    match best {
        Some((t, e)) if own_closed.is_none_or(|o| t > o) => {
            start(&e.dir, false)?;
            Ok(json!({ "ok": true, "started": "last", "session": row(&e.name, &e.dir) }))
        }
        _ => Ok(json!({ "ok": true, "launch": "default" })),
    }
}

/// The name the owner gave their own Gamblium (`rename default <name>`), if any.
fn main_name_file() -> Option<PathBuf> {
    root().and_then(|r| r.parent().map(|p| p.join("main-name.txt")))
}
pub fn main_name() -> Option<String> {
    main_name_file().and_then(|f| fs::read_to_string(f).ok()).map(|t| t.trim().to_owned()).filter(|t| !t.is_empty())
}

/// A session by `#id`, by its name (spaces and capitals do not count), or by its id alone.
fn find(what: &str) -> Result<Entry, String> {
    let all = entries();
    if let Some(id) = what.trim().strip_prefix('#') {
        return all.into_iter().find(|e| e.id == id).ok_or_else(|| format!("there is no session with the id #{id}. See them with: gamblium-cli list"));
    }
    let key = name_key(what);
    if let Some(e) = all.iter().find(|e| name_key(&e.name) == key) {
        return Ok(e.clone());
    }
    all.into_iter().find(|e| e.id == what.trim()).ok_or_else(|| format!("there is no session '{what}'. See them with: gamblium-cli list, or make it with: gamblium-cli create \"{what}\""))
}

/// The label of the session in a folder (its note), if the folder is a session's.
pub fn display_name(dir: &Path) -> Option<String> {
    note(dir)["name"].as_str().map(str::to_owned)
}

/// The name of the session with this id ("main" stays "main"; an unknown id is shown as it is).
fn name_of_id(id: &str) -> String {
    if id == "main" || id == "default" {
        return "your Gamblium (default)".into();
    }
    root().map(|r| r.join(id)).and_then(|d| display_name(&d)).or_else(|| entries().into_iter().find(|e| e.id == id).map(|e| e.name)).unwrap_or_else(|| id.into())
}

/// A new session: the name is checked (free, not a command), then its folder is made under a
/// new id with the name noted in it.
fn make_new(name: &str) -> Result<(String, PathBuf), String> {
    let t = tidy_name(name);
    if !valid_name(&t) {
        return Err(format!("'{name}' cannot be a session name: up to 40 characters, not < > : \" | ? * / \\, not starting with - or #, not a command word"));
    }
    let all = entries();
    if let Some(e) = all.iter().find(|e| name_key(&e.name) == name_key(&t)) {
        return Err(format!("a session called '{}' is already there (#{}): pick another name", e.name, e.id));
    }
    if let Some(e) = all.iter().find(|e| e.id == name_key(&t)) {
        return Err(format!("'{}' is the id of the session '{}': pick another name", t, e.name));
    }
    // A new id never equals a session's name either (review 6, D1).
    let taken: Vec<String> = all.iter().flat_map(|e| [e.id.clone(), name_key(&e.name)]).collect();
    let id = new_id(&taken);
    let dir = root().ok_or("LOCALAPPDATA is not set")?.join(&id);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    write_note(&dir, &json!({ "id": id, "name": t, "createdAt": at }));
    Ok((id, dir))
}

fn norm(dir: &str) -> String {
    dir.to_ascii_lowercase().replace('/', "\\").trim_end_matches('\\').to_owned()
}

fn same(a: &str, b: &Path) -> bool {
    norm(a) == norm(&b.to_string_lossy())
}

/// The folder of a session that exists, by name or `#id`.
fn existing(name: &str) -> Result<PathBuf, String> {
    find(name).map(|e| e.dir)
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
    // Written beside and moved into place in one step: a reader never sees it half-written (an
    // empty note read in the middle of a write once looked like a session with no id: Nov 15 2026).
    let tmp = dir.join(format!("{NOTE}.{}.tmp", std::process::id()));
    if fs::write(&tmp, serde_json::to_string_pretty(note).unwrap()).is_ok() && fs::rename(&tmp, dir.join(NOTE)).is_err() {
        let _ = fs::remove_file(&tmp);
    }
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

/// Gamblium's own request to a session's browser (marked so: a person's window answers it
/// without asking them; review 9, G3/G4).
fn ask(bridge: &BridgeInfo, cmd: Value) -> Option<Value> {
    host::ctl_as(bridge, &cmd, 8_000, true).ok()
}

/// The look the owner picked for their own Gamblium (theme.txt), for a person's session window.
fn owners_theme() -> String {
    root()
        .and_then(|r| r.parent().map(|g| g.join("theme.txt")))
        .and_then(|f| fs::read_to_string(f).ok())
        .map(|t| t.trim().to_owned())
        .filter(|t| !t.is_empty() && t.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'))
        .unwrap_or_else(|| "moon-dark".into())
}

/// A session a person uses in a window (owner, Nov 15 2026): made with a window from the page
/// or the menu (New isolated / forked window, Create and open). It starts as a full Gamblium
/// window, exactly like the owner's own (Alt+K, picture-in-picture, menu, look), only with its
/// own fresh profile; not as an agent's browser. Hidden starts stay the agent's way.
/// For the launcher: a person's session folder (Work) is never started as an agent's browser.
/// A marker file in the owner's own profile folder (Personal), written by install and by each
/// start of it: with the session note's `person`, what a person's folder is known by wherever
/// LOCALAPPDATA points (review 9, G2: the gate trusted the folder's location only).
pub const OWNER_MARK: &str = "gamblium-owner-profile";

/// A person's own folder by what is inside it: a session note with person=true, or the owner's mark.
pub fn person_by_content(dir: &Path) -> bool {
    is_person(dir) || dir.join(OWNER_MARK).is_file()
}

/// The proxy a person set for their session (its note), if any.
pub fn note_proxy(dir: &Path) -> Option<String> {
    note(dir)["proxy"].as_str().map(str::to_owned)
}

/// A folder directly in the sessions folder (a named session's own).
pub fn is_session_folder(dir: &Path) -> bool {
    root().is_some_and(|r| dir.parent().is_some_and(|p| same(&p.to_string_lossy(), &r)))
}

pub fn person_folder(dir: &Path) -> bool {
    let real = |p: &Path| fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    let d = real(dir);
    root().is_some_and(|r| d.parent().is_some_and(|p| same(&p.to_string_lossy(), &real(&r)))) && is_person(&d)
}

fn is_person(dir: &Path) -> bool {
    note(dir)["person"] == true
}

/// Starts the session's browser and waits until it takes commands.
fn start(dir: &Path, hidden: bool) -> Result<BridgeInfo, String> {
    start_with(dir, hidden, &[])
}

/// A person's window, started and handed over at once (owner, Nov 20 2026: "when I click on a
/// profile it should open immediately"). The browser brings its own windows and tabs back; what
/// `start` waits for after it (the extension answering, pictures, noted tabs, agents' tab ids)
/// is for agents' sessions. Measured on a test session: the window was up at 0.8-1.9 s and
/// `open` answered 1-2 s after that.
fn start_window(dir: &Path) -> Result<(), String> {
    launch_session(dir, false, &[]).map(|_| ())
}

/// `start`, with addresses to open as its first tabs (a window only).
fn start_with(dir: &Path, hidden: bool, urls: &[String]) -> Result<BridgeInfo, String> {
    let hidden = launch_session(dir, hidden, urls)?;
    wait_for_bridge(dir, hidden)
}

/// Starts the session's browser through the launcher and notes how. Returns whether it is hidden.
fn launch_session(dir: &Path, hidden: bool, urls: &[String]) -> Result<bool, String> {
    // One gate for every start (review 4, B1: hide, fork, clone and set still started a person's
    // session hidden, which means as an agent's browser that reads every cookie): a person's
    // session always starts as their own window.
    let hidden = hidden && !is_person(dir);
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    // A closed session is packed small (pack.rs): unpacked before its browser starts.
    crate::pack::wait_unpacked(dir).map_err(|e| format!("could not unpack the session: {e}"))?;
    let me = std::env::current_exe().map_err(|e| e.to_string())?;
    // Or the browser inherits the terminal's pipe and whoever called us waits for it.
    crate::launch::keep_our_output_to_ourselves();
    let mut cmd = Command::new(me);
    crate::launch::no_console_window(&mut cmd);
    if is_person(dir) && !hidden {
        // As the desktop shortcut starts Gamblium (bin/gamblium-app.rs), in this session's folder;
        // the look through the profile's settings only, so no "Installed theme" bar.
        cmd.args(["launch", "--user-data-dir"]).arg(dir);
        cmd.args(["--theme", &owners_theme(), "--auto-dark", "--no-theme-extension", "--skip-welcome"]);
    } else {
        cmd.args(["launch", "--agent", "--user-data-dir"]).arg(dir);
    }
    // The session's own proxy, every time it starts.
    if let Some(proxy) = note(dir)["proxy"].as_str() {
        cmd.args(["--proxy", proxy]);
    }
    // A window opens maximized the first time (owner, Nov 16 2026: new session windows came up as
    // a small window). After that the browser remembers how the person left it.
    // A No session window is a fresh profile each time: always the full window (owner, Nov 20 2026).
    if !hidden && (!remembers_window(dir) || note(dir)["temp"] == true) {
        cmd.args(["--", "--start-maximized"]);
        cmd.args(urls);
    } else if !hidden && !urls.is_empty() {
        cmd.arg("--").args(urls);
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
    Ok(hidden)
}

/// Waits until the started browser's extension takes commands, then sets it up for its work.
fn wait_for_bridge(dir: &Path, hidden: bool) -> Result<BridgeInfo, String> {
    #[allow(unused_mut)]
    let mut n = note(dir);
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

/// Whether the profile has a window placement of its own (the browser writes one when a window
/// closes): then it opens the way the person left it.
pub fn remembers_window(dir: &Path) -> bool {
    fs::read_to_string(dir.join("Default").join("Preferences"))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .is_some_and(|v| v["browser"]["window_placement"].is_object() && !crate::launch::placement_is_from_hidden_start(&v["browser"]["window_placement"]))
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
/// How a running session is brought back after a restart (relaunch, update): "window" (a person's
/// window), "agent-window" (an agent's minimised window: back minimised, never in front of the
/// person), or "none" (hidden or not running: its next command starts it).
pub fn restart_kind(dir: &Path) -> &'static str {
    if pid_of(dir).is_none() || note(dir)["hidden"] == true {
        "none"
    } else if is_person(dir) || note(dir)["window"] != true {
        "window"
    } else {
        "agent-window"
    }
}
/// Starts a session again the way `restart_kind` said it ran.
pub fn start_again(id: &str, kind: &str) -> Result<(), String> {
    let e = find(id)?;
    match kind {
        "window" => command(&["open".to_owned(), id.to_owned()]).map(|_| ()),
        "agent-window" => start_for_agent(&e.dir).map(|_| ()),
        _ => Ok(()),
    }
}
fn start_for_agent(dir: &Path) -> Result<BridgeInfo, String> {
    // A person's session (Work, a window from the menu) always starts as their window, never with
    // the agent's copy of the extension (review 3, A4: hide, fork and set still did).
    if is_person(dir) {
        return start(dir, false);
    }
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
        if is_person(dir) {
            return start(dir, false);
        }
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
    // Every window at once (launch::stop_whole_browser): closed one by one, all but the last
    // went to Recently closed and did not come back.
    if note(dir)["hidden"] == false {
        crate::launch::stop_whole_browser(pid, dir);
        return true;
    }
    // A hidden browser has no window to ask (and closing its last tab does
    // not end it: tried), so it is stopped, and the exit marked as clean.
    crate::procs::kill_tree(pid);
    for _ in 0..20 {
        if !crate::procs::is_running(pid) {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let _ = crate::launch::mark_clean_exit(dir);
    true
}

/// Packs a closed profile folder in a program of its own at background priority (pack-dir: it
/// refuses a folder in use and takes the pack lock). True if it was started.
pub fn pack_in_background(dir: &Path) -> bool {
    if !crate::pack::PACKING_ON {
        return false;
    }
    let Ok(me) = std::env::current_exe() else { return false };
    crate::launch::spawn_outliving(&me.with_file_name("gamblium.exe"), &["pack-dir".to_owned(), dir.to_string_lossy().into_owned(), "--background".to_owned()]).is_ok()
}

/// Packs a stopped session (pack.rs): its caches go, the rest becomes one archive. The extension
/// list is noted first, since the archive cannot be read for it. The browser lets go of its files
/// a moment after it ends, so a few tries. -> { before, after } in MB, or the reason it did not.
fn pack_closed(dir: &Path) -> Value {
    if pid_of(dir).is_some() {
        return json!({ "error": "the session is running" });
    }
    // A packed folder's extensions are inside the archive: the list noted before stays (review 3, A22).
    if !crate::pack::is_packed(dir) {
        let mut n = note(dir);
        n["extensions"] = json!(installed_extensions(dir));
        write_note(dir, &n);
    }
    let mut last = String::new();
    for _ in 0..12 {
        let before = crate::pack::size_of(dir);
        match crate::pack::pack_locked(dir, || pid_of(dir).is_none()) {
            Ok(_) => {
                let after = crate::pack::size_of(dir);
                return json!({ "beforeMb": (before as f64 / 1048576.0 * 10.0).round() / 10.0, "afterMb": (after as f64 / 1048576.0 * 10.0).round() / 10.0 });
            }
            Err(e) => last = e.to_string(),
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    json!({ "error": last })
}

fn row(name: &str, dir: &Path) -> Value {
    // `applies`: what the session brings with it every time it is used.
    // `by`: "cli" (made from the command line, by an agent or a person) or
    // "page" (made on the Sessions page).
    let n = note(dir);
    let parent = n["parent"].as_str().map(name_of_id);
    let cloned = n["clonedFrom"].as_str().map(name_of_id);
    json!({
        "name": n["name"].as_str().unwrap_or(name), "id": n["id"], "state": state_of(dir), "folder": dir, "by": n["by"].as_str().unwrap_or("cli"),
        "applies": { "proxy": n["proxy"], "extensions": if crate::pack::is_packed(dir) { n["extensions"].clone() } else { json!(installed_extensions(dir)) }, "always": true },
        "packed": crate::pack::is_packed(dir), "sizeMb": (crate::pack::size_of(dir) as f64 / 1048576.0 * 10.0).round() / 10.0,
        // Hidden: pictures and web fonts off unless asked for. One tab at work:
        // opening the next page puts the one before to sleep.
        "images": n["images"] == true, "keepTabs": n["keepTabs"] == true,
        // Named by a person (false: a made-up name from the menu's isolated / forked window).
        "named": n["auto"] != true,
        // A person's own session (a window, never an agent's browser).
        "person": n["person"] == true,
        // Made by an automatic check; the Session manager and the menu leave it out.
        "test": n["test"] == true,
        "createdAt": n["createdAt"],
        // When its browser last closed (ms), for "Recent sessions" and Continue.
        "closedAt": closed_at(dir),
        // "No session": the neutral window Gamblium starts in; gone once closed.
        "temp": n["temp"] == true,
        // Running: the browser's process id (the page shows it beside a green dot).
        "pid": pid_of(dir),
        // Main or child (a fork); a child names the session it came from.
        "kind": if n["kind"] == "child" { "child" } else { "main" }, "parent": parent, "parentId": n["parent"], "clonedFrom": cloned, "clonedFromId": n["clonedFrom"],
    })
}

/// Which session a fork's cookies come from, and whether it is a person's: decided from the folder
/// of the browser that sent them (the helper knows it), never from the name that browser sends
/// (review 6, D1: a session named like Work's id was found instead of Work). Anything that is not
/// the owner's own Gamblium or a known session that is not a person's counts as a person's (fails
/// closed): its copy is a window, never a hidden session.
fn fork_source(said: &str, from_dir: Option<&str>) -> (String, bool) {
    let Some(from) = from_dir.map(PathBuf::from) else {
        let known = said == "main" || entries().into_iter().any(|e| e.id == said);
        return (if known { said.to_owned() } else { "unknown".into() }, true);
    };
    let owner = crate::install::profile_dir().is_some_and(|m| crate::dl::profile_key(&m) == crate::dl::profile_key(&from));
    if owner {
        return ("main".into(), false);
    }
    // The agent and pen-test profiles, known by their path: their copies stay as asked (review 7, E4).
    let is = |o: Option<PathBuf>| o.is_some_and(|o| crate::dl::profile_key(&o) == crate::dl::profile_key(&from));
    if is(crate::launch::agent_user_data_dir()) || is(crate::launch::pentest_user_data_dir()) {
        return ("unknown".into(), false);
    }
    let in_sessions = root().is_some_and(|r| from.parent().is_some_and(|p| same(&p.to_string_lossy(), &r)));
    // An agent's own folder elsewhere (a test window, a custom agent folder): marked by the
    // launcher; its copies stay as asked, under no raw name (review 8, F7).
    if !in_sessions && from.join(crate::launch::AGENT_MARKER).is_file() {
        return ("unknown".into(), false);
    }
    if !in_sessions {
        // An unknown source: its parent is a known session id or "unknown", never a raw name the
        // browser sent (review 7, E5).
        let known = entries().into_iter().any(|e| e.id == said);
        return (if known { said.to_owned() } else { "unknown".into() }, true);
    }
    let n = note(&from);
    let id = n["id"].as_str().map(str::to_owned).or_else(|| from.file_name().map(|f| f.to_string_lossy().into_owned())).unwrap_or_default();
    (id, n["person"] == true || !n["id"].is_string())
}

/// A fork's sign-ins, sealed, in the new session's folder until its browser has taken them.
pub const FORK_FILE: &str = "gamblium-fork.sealed";

/// The vault label a fork's cookies are sealed under: they open for that session only.
pub fn fork_label(name: &str) -> String {
    format!("fork:{name}")
}

/// Fork (owner, Nov 15 2026): a child session with the same sign-ins as the one it comes from
/// and none of its tabs. The source browser's extension hands over its cookies; they are sealed
/// (vault, the sessions key, labelled for this child only) into the child's folder, never kept
/// readable, and the child's own extension takes them in once at its first start and the file
/// goes. The child's note names its parent, so the Sessions page can show main and child.
pub fn fork_from_cookies(name: &str, parent: &str, from_dir: Option<&str>, cookies_json: &str, hidden: bool, kind: &str) -> Result<Value, String> {
    let parsed: Value = serde_json::from_str(cookies_json).map_err(|e| format!("the sign-ins could not be read: {e}"))?;
    let count = parsed.as_array().map(Vec::len).ok_or("the sign-ins are not a list")?;
    let (parent, from_person) = fork_source(parent, from_dir);
    // A copy of a person's session (Work) carries their sign-ins: it is a person's window too,
    // never a hidden session (an agent's browser that reads every cookie; review 5, C1).
    let hidden = hidden && !from_person;
    let (id, dir) = make_new(name)?;
    let key = crate::vault::key_for(crate::vault::Purpose::Sessions)?;
    let blob = crate::vault::seal_text(&key, crate::vault::Purpose::Sessions, &fork_label(&id), cookies_json)?;
    fs::write(dir.join(FORK_FILE), blob).map_err(|e| e.to_string())?;
    let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    // A clone of a main session is a main session of its own (owner, Nov 15 2026).
    let mut n = note(&dir);
    if kind == "main" {
        n["kind"] = json!("main");
        n["clonedFrom"] = json!(parent);
    } else {
        n["kind"] = json!("child");
        n["parent"] = json!(parent);
    }
    n["forkedAt"] = json!(at);
    // Made to be used in a window by a person (the page, the menu): a full Gamblium window.
    if !hidden {
        n["person"] = json!(true);
    }
    write_note(&dir, &n);
    let name = tidy_name(name);
    let name = name.as_str();
    if let Err(e) = start(&dir, hidden) {
        if pid_of(&dir).is_none() {
            let _ = fs::remove_dir_all(&dir);
        }
        return Err(e);
    }
    Ok(json!({ "ok": true, "session": row(name, &dir), "cookies": count, "parent": parent }))
}

/// The sealed sign-ins waiting in a session's folder, a slice at a time (a helper's answer to the
/// browser must stay under 1 MB). None when there is nothing waiting.
pub fn fork_cookies(dir: &Path, from: usize, count: usize) -> Result<Option<Value>, String> {
    let file = dir.join(FORK_FILE);
    if !file.is_file() {
        return Ok(None);
    }
    let name = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let blob = fs::read(&file).map_err(|e| e.to_string())?;
    let key = crate::vault::key_for(crate::vault::Purpose::Sessions)?;
    let text = crate::vault::open_text(&key, crate::vault::Purpose::Sessions, &fork_label(&name), &blob)?;
    let all: Vec<Value> = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let end = (from + count).min(all.len());
    let part = if from < all.len() { all[from..end].to_vec() } else { Vec::new() };
    Ok(Some(json!({ "cookies": part, "total": all.len(), "next": end })))
}

/// The owner's own browser as the CLI sees it (its open tabs and saved tab sets), sealed with the
/// sessions key. Written by the helper for the owner's browser a few seconds after a change.
const CLI_VIEW: &str = "cli-view.sealed";
fn cli_view_file() -> Option<PathBuf> {
    root().and_then(|r| r.parent().map(|g| g.join(CLI_VIEW)))
}
pub fn write_cli_view(view: &Value) -> Result<(), String> {
    let file = cli_view_file().ok_or("LOCALAPPDATA is not set")?;
    let key = crate::vault::key_for(crate::vault::Purpose::Sessions)?;
    let blob = crate::vault::seal_text(&key, crate::vault::Purpose::Sessions, "cli-view", &view.to_string())?;
    fs::write(file, blob).map_err(|e| e.to_string())
}
/// Every session's browser keeps its open tabs here too (owner, Nov 16 2026: a closed session
/// showed no tabs; Personal did). Sealed with the sessions key, for this session's folder only;
/// left outside the pack when the session is closed (pack.rs KEEP_OUT).
pub const SESSION_VIEW: &str = "gamblium-tabs.sealed";
fn view_label(dir: &Path) -> String {
    format!("tabs:{}", dir.file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default())
}
/// The view sent by a browser whose profile is a session folder; false if it is not one.
pub fn write_session_view(profile: &Path, view: &Value) -> Result<bool, String> {
    let Some(e) = entries().into_iter().find(|e| same(&profile.to_string_lossy(), &e.dir)) else { return Ok(false) };
    let key = crate::vault::key_for(crate::vault::Purpose::Sessions)?;
    let blob = crate::vault::seal_text(&key, crate::vault::Purpose::Sessions, &view_label(&e.dir), &view["open"].to_string())?;
    fs::write(e.dir.join(SESSION_VIEW), blob).map_err(|x| x.to_string())?;
    Ok(true)
}
// ---- Recently closed, across sessions (owner, Nov 20 2026): a session's own window lists what it
// closed itself; the default No session window lists everything: sessions closed whole (by their
// name) and what every session closed. Each browser keeps its list sealed in its own folder.
pub const CLOSED_VIEW: &str = "gamblium-closed.sealed";
fn closed_label(dir: &Path) -> String {
    format!("closed:{}", dir.file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default())
}
/// Saves the recently closed list a browser sent, in its own profile folder (the owner's or a
/// session's; a test or No session folder keeps none).
pub fn save_closed(profile: &Path, items: &Value) -> Result<bool, String> {
    let own = crate::install::profile_dir().is_some_and(|o| same(&profile.to_string_lossy(), &o));
    let session = entries().into_iter().find(|e| same(&profile.to_string_lossy(), &e.dir)).filter(|e| {
        let n = note(&e.dir);
        n["temp"] != true && n["test"] != true
    });
    let dir = if own { crate::install::profile_dir() } else { session.map(|e| e.dir) };
    let Some(dir) = dir else { return Ok(false) };
    let key = crate::vault::key_for(crate::vault::Purpose::Sessions)?;
    let blob = crate::vault::seal_text(&key, crate::vault::Purpose::Sessions, &closed_label(&dir), &items.to_string())?;
    fs::write(dir.join(CLOSED_VIEW), blob).map_err(|x| x.to_string())?;
    Ok(true)
}
fn read_closed(dir: &Path) -> Value {
    let Ok(blob) = fs::read(dir.join(CLOSED_VIEW)) else { return json!([]) };
    let Ok(key) = crate::vault::key_for(crate::vault::Purpose::Sessions) else { return json!([]) };
    crate::vault::open_text(&key, crate::vault::Purpose::Sessions, &closed_label(&dir), &blob)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_else(|| json!([]))
}
/// For the default window's Recently closed: every session (and the owner's own) with its state,
/// when it closed, and what it closed. `neutral`: the asking browser is a No session window.
pub fn closed_all(asking: Option<&str>) -> Value {
    let neutral = asking.and_then(|a| entries().into_iter().find(|e| same(a, &e.dir))).is_some_and(|e| note(&e.dir)["temp"] == true);
    if !neutral {
        return json!({ "neutral": false });
    }
    let mut out = Vec::new();
    if let Some(own) = crate::install::profile_dir() {
        let running = crate::procs::browsers(BROWSER_EXE).into_iter().any(|(_, d)| d.as_deref().is_some_and(|d| same(d, &own)));
        out.push(json!({ "id": "default", "name": main_name().unwrap_or_else(|| "Personal".into()), "open": running, "closedAt": closed_at(&own), "items": read_closed(&own) }));
    }
    for e in entries() {
        let n = note(&e.dir);
        if n["temp"] == true || n["test"] == true {
            continue;
        }
        out.push(json!({ "id": e.id, "name": e.name, "open": pid_of(&e.dir).is_some(), "closedAt": closed_at(&e.dir), "items": read_closed(&e.dir) }));
    }
    json!({ "neutral": true, "profiles": out })
}

/// A session's tabs as its browser last showed them: [{url, title, window}].
fn session_tabs(dir: &Path) -> Option<Vec<Value>> {
    let blob = fs::read(dir.join(SESSION_VIEW)).ok()?;
    let key = crate::vault::key_for(crate::vault::Purpose::Sessions).ok()?;
    let text = crate::vault::open_text(&key, crate::vault::Purpose::Sessions, &view_label(dir), &blob).ok()?;
    let open: Value = serde_json::from_str(&text).ok()?;
    let mut out = vec![];
    for (w, win) in open.as_array().into_iter().flatten().enumerate() {
        for t in win["tabs"].as_array().into_iter().flatten() {
            let url = t["url"].as_str().unwrap_or("");
            if url.starts_with("http") || url.starts_with("file:") {
                out.push(json!({ "url": url, "title": t["title"], "icon": t["icon"], "window": w }));
            }
        }
    }
    Some(out)
}

// ---- Global memory (owner, Nov 16 2026) --------------------------------------------------------
// What onboarding sets (the person's name, clock, search, New Tab cards and layout, colours) is
// the browser's, not a session's: kept here, beside the sessions, and read by every session's
// browser (the owner's own Gamblium is one of them, not the source). What a person changes inside
// a session is that session's own memory (its profile); what it never changed follows this file.
// { version: ms, look: { newtab, colours } }
// Sealed like everything else the helper keeps (vault.rs: XChaCha20-Poly1305, its key wrapped by
// Windows for this Windows user only): another Windows account, or a copy of the files on another
// machine, cannot read it (owner, Nov 16 2026).
fn global_file() -> Option<PathBuf> {
    root().and_then(|r| r.parent().map(|p| p.join("global.sealed")))
}
pub fn global_get() -> Value {
    let Some(blob) = global_file().and_then(|f| fs::read(f).ok()) else { return Value::Null };
    let Ok(key) = crate::vault::key_for(crate::vault::Purpose::Sessions) else { return Value::Null };
    crate::vault::open_text(&key, crate::vault::Purpose::Sessions, "global", &blob).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null)
}
/// Writes the global look; with `if_empty`, only when there is none yet. -> written or not.
pub fn global_set(look: &Value, if_empty: bool) -> Result<bool, String> {
    if if_empty && !global_get().is_null() {
        return Ok(false);
    }
    let f = global_file().ok_or("LOCALAPPDATA is not set")?;
    let version = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    let key = crate::vault::key_for(crate::vault::Purpose::Sessions)?;
    let blob = crate::vault::seal_text(&key, crate::vault::Purpose::Sessions, "global", &json!({ "version": version, "look": look }).to_string())?;
    let tmp = f.with_extension("sealed.tmp");
    fs::write(&tmp, blob).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &f).map_err(|e| e.to_string())?;
    Ok(true)
}

fn read_cli_view() -> Option<Value> {
    let blob = fs::read(cli_view_file()?).ok()?;
    let key = crate::vault::key_for(crate::vault::Purpose::Sessions).ok()?;
    let text = crate::vault::open_text(&key, crate::vault::Purpose::Sessions, "cli-view", &blob).ok()?;
    serde_json::from_str(&text).ok()
}

/// A saved tab set of the owner's browser by id (`#id` or bare) or name (spaces, capitals ignored).
fn find_set(what: &str) -> Result<Value, String> {
    let view = read_cli_view().ok_or("your own Gamblium has not shared its tab sets yet: open it once")?;
    let sets = view["sets"].as_array().cloned().unwrap_or_default();
    let w = what.trim().trim_start_matches('#');
    sets.iter()
        .find(|s| s["id"] == w)
        .or_else(|| sets.iter().find(|s| s["name"].as_str().is_some_and(|n| name_key(n) == name_key(what))))
        .cloned()
        .ok_or_else(|| format!("there is no saved tab set '{what}'. See them with: gamblium-cli list"))
}

/// A fork of the owner's own Gamblium asked for from the command line, waiting for the owner's
/// yes in their browser (ui/fork-ask.html). One at a time.
pub fn fork_ask_file() -> Option<PathBuf> {
    root().and_then(|r| r.parent().map(|g| g.join("fork-ask.json")))
}

/// How long a fork question waits for the owner.
pub const FORK_ASK_SECS: u64 = 180;

/// Fork from the owner's own browser: their sign-ins never leave it without their click. The
/// question is written down, shown as a tab in their Gamblium, and this waits for the session.
fn fork_from_main(name: &str, hidden: bool) -> Result<Value, String> {
    if !host::users_gamblium_is_open() {
        return Err("your own Gamblium is not open: start it, then ask again (the fork is made from it, with your yes)".into());
    }
    let file = fork_ask_file().ok_or("LOCALAPPDATA is not set")?;
    let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    fs::write(&file, json!({ "name": name, "hidden": hidden, "at": at }).to_string()).map_err(|e| e.to_string())?;
    let mut q = url::form_urlencoded::Serializer::new(String::new());
    q.append_pair("name", name);
    host::show_in_users_gamblium(&format!("ui/fork-ask.html?{}", q.finish()));
    let began = Instant::now();
    while began.elapsed() < Duration::from_secs(FORK_ASK_SECS) {
        std::thread::sleep(Duration::from_millis(500));
        if let Ok(e) = find(name) {
            if !note(&e.dir)["kind"].is_null() {
                let _ = fs::remove_file(&file);
                return Ok(json!({ "ok": true, "session": row(name, &e.dir), "parent": "main" }));
            }
        }
        if !file.is_file() {
            return Err("not allowed: the fork was turned down in Gamblium".into());
        }
    }
    let _ = fs::remove_file(&file);
    Err(format!("nobody answered in Gamblium within {FORK_ASK_SECS} s; nothing was copied"))
}

pub fn command(args: &[String]) -> Result<Value, String> {
    let name_at = |i: usize| args.get(i).map(String::as_str).ok_or("which session? Give its name");
    match args[0].as_str() {
        "create" | "new" => {
            let name = name_at(1)?;
            let window = args.iter().skip(2).any(|a| a == "--window");
            let proxy = proxy_among(&args[2..])?;
            let (id, dir) = make_new(name)?;
            {
                let mut n = note(&dir);
                if let Some(Some(proxy)) = proxy {
                    n["proxy"] = json!(proxy);
                }
                if window {
                    n["person"] = json!(true);
                }
                // Made by the menu with a made-up name: unnamed until renamed.
                if args.iter().skip(2).any(|a| a == "--auto") {
                    n["auto"] = json!(true);
                }
                // Made by Gamblium's own automatic checks (tools/*-check.mjs): not shown to the owner.
                if args.iter().skip(2).any(|a| a == "--test") {
                    n["test"] = json!(true);
                }
                write_note(&dir, &n);
            }
            if let Err(e) = start(&dir, !window) {
                // Nothing of a session that never started is left behind.
                if pid_of(&dir).is_none() {
                    let _ = fs::remove_dir_all(&dir);
                }
                return Err(e);
            }
            Ok(json!({ "ok": true, "session": row(name, &dir), "next": format!("gamblium-cli #{id} open url=https://example.com wait=true") }))
        }
        // Fork: a new session with another's sign-ins and none of its tabs.
        "fork" => {
            let name = name_at(1)?;
            if !valid_name(name) {
                return Err(format!("'{name}' cannot be a session name"));
            }
            if let Ok(e) = find(name) {
                if name_key(&e.name) == name_key(name) {
                    return Err(format!("a session called '{}' is already there (#{}): pick another name", e.name, e.id));
                }
            }
            let from = args.iter().skip(2).find_map(|a| a.strip_prefix("from=")).unwrap_or("default");
            let hidden = !args.iter().skip(2).any(|a| a == "--window");
            if from == "default" || from == "main" {
                return fork_from_main(name, hidden);
            }
            let parent = existing(from)?;
            let bridge = if pid_of(&parent).is_none() { start(&parent, true)? } else { ready(&parent)? };
            let answer = crate::ctl_with_own(&bridge, "fork", &[format!("name={name}"), format!("hidden={hidden}")], 90)?;
            if answer["ok"] != true {
                return Err(answer["error"].as_str().unwrap_or("the fork could not be made").to_owned());
            }
            let made = find(name)?;
            Ok(json!({ "ok": true, "session": row(name, &made.dir), "parent": name_of_id(&find(from)?.id), "cookies": answer["cookies"] }))
        }
        // Clone: the same sign-ins and the same tabs. Main stays main; a child's clone is a
        // child of the same parent. Settings of the session (proxy, pictures) come along.
        "clone" => {
            let from = name_at(1)?;
            let name = args.get(2).map(String::as_str).ok_or("clone <session> <new name>")?;
            let source = find(from)?;
            let src = source.dir.clone();
            if !valid_name(name) {
                return Err(format!("'{name}' cannot be a session name"));
            }
            if let Some(e) = entries().into_iter().find(|e| name_key(&e.name) == name_key(name)) {
                return Err(format!("a session called '{}' is already there (#{}): pick another name", e.name, e.id));
            }
            let window = args.iter().skip(3).any(|a| a == "--window");
            let bridge = if pid_of(&src).is_none() { start(&src, true)? } else { ready(&src)? };
            let urls = ask(&bridge, json!({ "op": "tabs" })).map(|t| web_addresses(&t)).unwrap_or_default();
            let answer = crate::ctl_with_own(&bridge, "fork", &[format!("name={name}"), format!("hidden={}", !window)], 90)?;
            if answer["ok"] != true {
                return Err(answer["error"].as_str().unwrap_or("the clone could not be made").to_owned());
            }
            let dir = find(name)?.dir;
            let s = note(&src);
            let mut n = note(&dir);
            if s["kind"] == "child" {
                n["parent"] = s["parent"].clone();
            } else {
                n["kind"] = json!("main");
                n["clonedFrom"] = json!(source.id);
                if let Some(o) = n.as_object_mut() {
                    o.remove("parent");
                }
            }
            for k in ["proxy", "images", "keepTabs", "window"] {
                if !s[k].is_null() {
                    n[k] = s[k].clone();
                }
            }
            write_note(&dir, &n);
            // The tabs wait until the new browser has taken its sign-ins (the sealed file goes).
            let began = Instant::now();
            while dir.join(FORK_FILE).is_file() && began.elapsed() < Duration::from_secs(30) {
                std::thread::sleep(Duration::from_millis(300));
            }
            let mut opened = 0;
            if !urls.is_empty() {
                let to = ready(&dir)?;
                for u in &urls {
                    if ask(&to, json!({ "op": "open", "url": u, "background": true })).is_some_and(|a| a["ok"] == true) {
                        opened += 1;
                    }
                }
            }
            Ok(json!({ "ok": true, "session": row(name, &dir), "from": source.name, "cookies": answer["cookies"], "tabs": opened }))
        }
        // A new name. The folder is the session, so a running one is stopped, renamed and
        // started again the way it was (logins and tabs are kept).
        "rename" => {
            let from = name_at(1)?;
            let to = args.get(2).map(String::as_str).ok_or("rename <session> <new name>")?;
            // The owner's own Gamblium has a name too (owner, Nov 16 2026: "Personal"), shown the
            // same in every window's session manager. Only a label: nothing moves or restarts.
            if matches!(from, "default" | "main" | "#default") {
                let t = tidy_name(to);
                if !valid_name(&t) {
                    return Err(format!("'{to}' cannot be a name"));
                }
                if let Some(e) = entries().into_iter().find(|e| name_key(&e.name) == name_key(&t) || e.id == name_key(&t)) {
                    return Err(format!("'{t}' is already the name or id of the session '{}' (#{}): pick another name", e.name, e.id));
                }
                let file = main_name_file().ok_or("LOCALAPPDATA is not set")?;
                fs::write(&file, &t).map_err(|e| e.to_string())?;
                return Ok(json!({ "ok": true, "renamed": "default", "name": t }));
            }
            let src = find(from)?;
            let t = tidy_name(to);
            if !valid_name(&t) {
                return Err(format!("'{to}' cannot be a session name"));
            }
            if let Some(e) = entries().into_iter().find(|e| e.id != src.id && name_key(&e.name) == name_key(&t)) {
                return Err(format!("a session called '{}' is already there (#{}): pick another name", e.name, e.id));
            }
            // Not another session's id either: names are looked up before ids (review 6, D1).
            if let Some(e) = entries().into_iter().find(|e| e.id != src.id && e.id == name_key(&t)) {
                return Err(format!("'{t}' is the id of the session '{}': pick another name", e.name));
            }
            // The folder is the id: only the label changes; nothing restarts, children keep their parent.
            let mut n = note(&src.dir);
            n["name"] = json!(t);
            n["auto"] = json!(false);
            // Named by a person: kept like any session (a renamed No session window was deleted; review 3, A18).
            n["temp"] = json!(false);
            write_note(&src.dir, &n);
            Ok(json!({ "ok": true, "session": row(&t, &src.dir), "was": src.name }))
        }
        // A saved tab set of the owner's (or the tabs open in it now: `open`) opened in a named
        // session, so an agent works on them with that session's sign-ins. Opened asleep.
        "open-set" => {
            let what = name_at(1)?;
            let to = args.iter().skip(2).find_map(|a| a.strip_prefix("in=")).ok_or("open-set <#set id|name|open> in=<session>")?;
            let session = find(to)?;
            let urls: Vec<String> = if what == "open" {
                let view = read_cli_view().ok_or("your own Gamblium has not shared its tabs yet: open it once")?;
                view["open"].as_array().into_iter().flatten().flat_map(|w| w["tabs"].as_array().cloned().unwrap_or_default()).filter_map(|t| t["url"].as_str().map(str::to_owned)).collect()
            } else {
                let set = find_set(what)?;
                set["windows"].as_array().into_iter().flatten().flat_map(|w| w["tabs"].as_array().cloned().unwrap_or_default()).filter_map(|t| t["url"].as_str().map(str::to_owned)).collect()
            };
            let urls: Vec<String> = urls.into_iter().filter(|u| u.starts_with("http://") || u.starts_with("https://")).collect();
            let bridge = ready(&session.dir)?;
            let mut opened = Vec::new();
            for u in &urls {
                if let Some(a) = ask(&bridge, json!({ "op": "open", "url": u, "background": true })) {
                    if a["ok"] == true {
                        opened.push(json!({ "id": a["tab"]["id"], "url": u }));
                    }
                }
            }
            ask(&bridge, json!({ "op": "sleep-others" }));
            Ok(json!({ "ok": true, "session": row(&session.name, &session.dir), "opened": opened, "note": "the tabs are asleep; a command for a tab wakes it" }))
        }
        "prepare-spare" => prepare_spare(),
        "warm-up" => warm_up(),
        "list" | "ls" => {
            // Reading changes nothing on disk (review, Nov 16 2026): clean-up and packing run when
            // Gamblium starts from its icon (begin).
            // Text-heavy on purpose (owner): an agent reads it. Each session with its tabs: asked
            // of a running browser, or the ones it will reopen when stopped.
            let list: Vec<Value> = entries()
                .iter()
                .map(|e| {
                    let mut r = row(&e.name, &e.dir);
                    let live = pid_of(&e.dir).and_then(|_| bridge_of(&e.dir)).and_then(|b| ask(&b, json!({ "op": "tabs" })));
                    let seen = if live.is_none() { session_tabs(&e.dir) } else { None };
                    r["tabsFrom"] = json!(if live.is_some() { "running browser" } else if seen.is_some() { "its browser, as last seen" } else { "noted when it stopped" });
                    r["tabs"] = match (live, seen) {
                        // Private windows are left out, as for the owner's own Gamblium (review 10, H3: Work's
                        // private tabs reached an agent through `list`).
                        (Some(t), _) => json!(t["tabs"].as_array().into_iter().flatten().filter(|t| t["private"] != true).map(|t| json!({ "id": t["id"], "url": t["url"], "title": t["title"], "icon": t["icon"], "active": t["active"], "asleep": t["state"] == "asleep" })).collect::<Vec<_>>()),
                        (None, Some(seen)) => json!(seen),
                        (None, None) => json!(note(&e.dir)["tabs"].as_array().into_iter().flatten().map(|u| json!({ "url": u })).collect::<Vec<_>>()),
                    };
                    r["use"] = json!(format!("gamblium-cli {} <command>   (help: gamblium-cli {} help; the id needs no #, which a shell reads as a comment)", e.id, e.id));
                    r
                })
                .collect();
            // The owner's own Gamblium is listed too (owner, Nov 15 2026: an empty list read as
            // "not installed"). It is not a named session: commands do not go to it; it is what
            // `fork <new>` (from=main) forks from, after the owner's Allow. Its saved tab sets
            // ("Tabs put away") live sealed inside it and are not listed here.
            let profile = crate::install::profile_dir();
            let pid = profile.as_ref().and_then(|p| crate::procs::browsers(BROWSER_EXE).into_iter().find(|(_, d)| d.as_deref().is_some_and(|d| same(d, p))).map(|(pid, _)| pid));
            let children: Vec<Value> = entries().iter().filter(|e| note(&e.dir)["parent"] == "main").map(|e| json!({ "id": e.id, "name": e.name })).collect();
            let main = json!({
                "id": "default", "name": main_name().unwrap_or_else(|| "your Gamblium (default profile)".into()), "named": main_name().is_some(), "closedAt": profile.as_deref().and_then(closed_at), "state": if pid.is_some() { "running" } else { "stopped" }, "pid": pid,
                "folder": profile, "children": children,
                "what": "The owner's own browser: every window opened normally (Ctrl+N, the taskbar) is part of it and shares its sign-ins. It is not a named session and not 'main'. Commands do not go to it. Fork it: gamblium-cli fork <new name> [from=default] (asks the owner first). Work on its open tabs or a saved tab set in a named session: gamblium-cli open-set <#set id|name|open> in=<session>",
            });
            let view = read_cli_view();
            let mut main = main;
            // Its windows, each with its own id: there is no "main" window.
            main["windows"] = view.as_ref().map(|v| v["open"].clone()).unwrap_or(Value::Null);
            main["seenAt"] = view.as_ref().map(|v| v["at"].clone()).unwrap_or(Value::Null);
            let sets: Vec<Value> = view
                .as_ref()
                .and_then(|v| v["sets"].as_array().cloned())
                .unwrap_or_default()
                .into_iter()
                .map(|mut s| {
                    let tabs: usize = s["windows"].as_array().into_iter().flatten().map(|w| w["tabs"].as_array().map_or(0, Vec::len)).sum();
                    s["tabCount"] = json!(tabs);
                    s["use"] = json!(format!("gamblium-cli open-set #{} in=<session>", s["id"].as_str().unwrap_or("")));
                    s
                })
                .collect();
            Ok(json!({
                "ok": true,
                "about": "default: the owner's own Gamblium, every window of it with its tabs (private windows left out). sessions: named sessions, each its own sign-ins, with id, kind (main = made on its own or cloned; child = forked, see parent), state, pid and tabs. tabSets: tab sets saved in the owner's Gamblium ('Tabs put away'), with every tab. Name a session or set exactly by #id.",
                "default": main, "sessions": list, "tabSets": sets,
            }))
        }
        op @ ("open" | "show" | "hide") => {
            let name = name_at(1)?;
            let dir = existing(name)?;
            let hidden = op == "hide";
            if hidden && is_person(&dir) {
                return Err(format!("'{name}' is a person's session: it runs in its own window, never unseen (an unseen session is an agent's browser)"));
            }
            let want = if hidden { "hidden" } else { "window" };
            if state_of(&dir) != want {
                stop(&dir);
                // A person's window: handed over as soon as it is launched.
                if !hidden && is_person(&dir) {
                    start_window(&dir)?;
                } else {
                    start(&dir, hidden)?;
                }
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
            if let Some(auto) = switch_among(&args[2..], "auto")? {
                // Made by the menu with a made-up name: such a session is "unnamed" until renamed.
                let mut n = note(&dir);
                n["auto"] = json!(auto);
                write_note(&dir, &n);
                if proxy.is_none() && images.is_none() && keep.is_none() && window.is_none() {
                    return Ok(json!({ "ok": true, "session": row(name, &dir) }));
                }
            }
            if proxy.is_none() && images.is_none() && keep.is_none() && window.is_none() {
                return Err("say what to set: proxy=<address>|none, images=on|off, keep-tabs=on|off, window=on|off".into());
            }
            // A person's session is their window: an agent's window setting does not apply to it,
            // and changing it restarted Work (review 4, B9).
            if window.is_some() && is_person(&dir) {
                return Err(format!("'{name}' is a person's session: it is always their own window (window= is for an agent's sessions)"));
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
        // Go to session: its window in front (the Session manager's button).
        // What the desktop icon runs (bin/gamblium-app.rs): the neutral window or the last session.
        "begin" => {
            pack_own_soon();
            prune_unused(); // in "last" mode too (review 2, 1.15)
            if start_mode() == "last" {
                begin_last()
            } else {
                begin_fresh()
            }
        }
        "start-mode" => {
            if let Some(m) = args.get(1) {
                if !matches!(m.as_str(), "fresh" | "last") {
                    return Err("start-mode fresh|last".into());
                }
                let f = start_mode_file().ok_or("LOCALAPPDATA is not set")?;
                fs::write(f, m).map_err(|e| e.to_string())?;
            }
            Ok(json!({ "ok": true, "startMode": start_mode() }))
        }
        "focus" => {
            let name = name_at(1)?;
            let e = find(name)?;
            if !is_person(&e.dir) && note(&e.dir)["window"] == true {
                return Err(format!("'{}' runs minimised for an agent: it is not brought in front of the person", e.name));
            }
            if pid_of(&e.dir).is_none() {
                return Err(format!("'{}' is not open", e.name));
            }
            // Its window as the person left it, in front (it was set to "normal", which made a
            // maximised window small).
            if pid_of(&e.dir).is_some_and(crate::capture::bring_forward) {
                return Ok(json!({ "ok": true, "session": row(&e.name, &e.dir) }));
            }
            let bridge = ready(&e.dir)?;
            let wins = ask(&bridge, json!({ "op": "windows" })).ok_or("the session did not answer")?;
            let id = wins["windows"].as_array().and_then(|w| w.first()).and_then(|w| w["id"].as_u64()).ok_or("the session has no window")?;
            ask(&bridge, json!({ "op": "window-focus", "window": id, "show": true }));
            Ok(json!({ "ok": true, "session": row(&e.name, &e.dir) }))
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
            // A fork or clone just made: its sign-ins go in first.
            let began = Instant::now();
            while dir.join(FORK_FILE).is_file() && began.elapsed() < Duration::from_secs(30) {
                std::thread::sleep(Duration::from_millis(300));
            }
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
            // A restart (update, relaunch) opens it again at once: no pack in between. Otherwise it
            // is packed by a program of its own at background priority, so close returns at once
            // (a level-19 pack of a big session takes minutes) and a start stops the pack.
            let packing = if args.iter().any(|a| a == "--keep-unpacked") {
                false
            } else {
                // A packed folder's extensions are inside the archive: the list noted before stays
                // (review 9, G15).
                if !crate::pack::is_packed(&dir) {
                    let mut n = note(&dir);
                    n["extensions"] = json!(installed_extensions(&dir));
                    write_note(&dir, &n);
                }
                pack_in_background(&dir)
            };
            Ok(json!({ "ok": true, "session": row(name, &dir), "wasRunning": was_running, "packing": packing }))
        }
        // Packs every stopped session that is not packed yet.
        "pack" => {
            let mut done = Vec::new();
            for e in entries() {
                let dir = e.dir;
                if pid_of(&dir).is_none() && !crate::pack::is_packed(&dir) {
                    done.push(json!({ "name": e.name, "id": e.id, "packed": pack_closed(&dir) }));
                }
            }
            Ok(json!({ "ok": true, "sessions": done }))
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
            // A run of many steps may take up to two minutes (agent.js RUN_MAX_MS).
            let mut timeout = if args.get(1).is_some_and(|a| a == "run") { 125u64 } else if args.iter().any(|a| a == "wait=true") { 75u64 } else { 30u64 };
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

/// From a terminal (an agent may be typing), a person's session's proxy and pictures are not
/// changed: a proxy would send Work's traffic where the agent picked and restart it (review 6, D8).
/// The owner changes them on the Sessions page, which goes through the helper, not here.
pub fn cli_may(args: &[String]) -> Result<(), String> {
    // An agent's command into a person's own window (Work), or a copy of it, needs the owner's
    // yes: org sessions are given to agents only with explicit permission (review 6, D2). Asked
    // like the settings permission (ui/permit.html?what=person), for a time the owner picks.
    let into_person = match args.first().map(String::as_str) {
        Some("fork") => args.iter().skip(2).find_map(|a| a.strip_prefix("from=")).map(str::to_owned),
        Some("clone") => args.get(1).cloned(),
        // Deleting a person's session, or putting a tab set into it (it sends their tabs to
        // sleep), needs their yes too (review 8, F5).
        Some("delete") => args.get(1).cloned(),
        // Opening an address in it, raising it, closing it (review 9, G5, G7).
        Some("open-url" | "focus" | "close") => args.get(1).cloned(),
        Some("open-set") => args.iter().skip(2).find_map(|a| a.strip_prefix("in=")).map(str::to_owned),
        // Gamblium's own status reads (host::PERSON_FREE_OPS) need no yes, as at the helper.
        Some(first) if args.len() > 1 && !RESERVED.contains(&first.to_lowercase().as_str()) && !host::PERSON_FREE_OPS.contains(&args[1].as_str()) => Some(first.to_owned()),
        _ => None,
    };
    if let Some(src) = into_person {
        if let Ok(e) = find(&src) {
            // An automatic check removes the session it made.
            let builtin = args.first().is_some_and(|a| RESERVED.contains(&a.to_lowercase().as_str()));
            let own_test_cleanup = builtin && note(&e.dir)["test"] == true;
            if is_person(&e.dir) && !own_test_cleanup {
                let now = crate::permit::now();
                let mut state = crate::permit::load();
                if !crate::permit::allowed(&state, "person", now) {
                    // An automatic check's session: refused the same, without leaving a question.
                    if note(&e.dir)["test"] == true {
                        return Err(format!("'{}' is a person's own session: an agent works in it only with their yes", e.name));
                    }
                    // One question per window, whatever the command (review 9, G8), shown in that
                    // window if it is open and in the owner's Gamblium if open (G9).
                    // Named as the helper names it, so the two ways in share one question (review 10, H12).
                    let show = crate::permit::ask(&mut state, "person", "agent commands", &host::profile_label(&e.dir.to_string_lossy()), now)?;
                    crate::permit::save(&state)?;
                    let mut shown = false;
                    if show && pid_of(&e.dir).is_some() {
                        host::show_in_profile(&e.dir, "ui/permit.html?what=person");
                        shown = true;
                    }
                    if show && host::users_gamblium_is_open() {
                        host::show_in_users_gamblium("ui/permit.html?what=person");
                        shown = true;
                    }
                    let where_ = if shown { "The question is shown in Gamblium" } else { "Allow it in Gamblium: Settings > Agents may work in your own session windows" };
                    return Err(format!("'{}' is a person's own session: an agent works in it only with their yes. {where_}; try again once allowed", e.name));
                }
            }
        }
    }
    // A new session's name that is another's id is refused before any source browser starts
    // (review 7, E5: fork/clone started a stopped Work and sent its cookies first).
    let new_name = match args.first().map(String::as_str) {
        Some("fork") => args.get(1),
        Some("clone") => args.get(2),
        _ => None,
    };
    if let Some(n) = new_name {
        if let Some(e) = entries().into_iter().find(|e| e.id == name_key(n)) {
            return Err(format!("'{n}' is the id of the session '{}': pick another name", e.name));
        }
    }
    if args.first().map(String::as_str) == Some("set") && args.len() > 2 {
        let touches = args[2..].iter().any(|a| a.starts_with("proxy=") || a.starts_with("images="));
        if touches && args.get(1).and_then(|n| find(n).ok()).is_some_and(|e| is_person(&e.dir)) {
            return Err(format!("'{}' is a person's session: its proxy and pictures are changed on the Sessions page in Gamblium, not from a terminal", args[1]));
        }
    }
    Ok(())
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
        Some(_) => match cli_may(args).and_then(|_| command(args)) {
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
mod prune_tests {
    use super::*;
    #[test]
    fn only_unused_menu_windows_go() {
        let now = 10_000_000u64;
        let made = json!({ "auto": true, "person": true, "createdAt": now - 120_000 });
        assert!(unused_window(&made, false, false, now));
        // Running, visited a site, too new, renamed (auto false), a fork, or a site tab noted: kept.
        assert!(!unused_window(&made, true, false, now));
        assert!(!unused_window(&made, false, true, now));
        assert!(!unused_window(&json!({ "auto": true, "createdAt": now - 5_000 }), false, false, now));
        assert!(!unused_window(&json!({ "auto": false, "createdAt": now - 120_000 }), false, false, now));
        assert!(!unused_window(&json!({ "auto": true, "parent": "x", "createdAt": now - 120_000 }), false, false, now));
        assert!(!unused_window(&json!({ "auto": true, "createdAt": now - 120_000, "tabs": ["https://mail.google.com/"] }), false, false, now));
        assert!(unused_window(&json!({ "auto": true, "createdAt": now - 120_000, "tabs": ["chrome://newtab/"] }), false, false, now));
        // No createdAt (made before it was noted): kept.
        assert!(!unused_window(&json!({ "auto": true }), false, false, now));
    }

    /// The clean-up sets a closed No session window aside instead of deleting it when this says
    /// it was used: a website in its history, a packed profile, or anything that cannot be read.
    #[test]
    fn a_window_that_showed_a_website_counts_as_used() {
        let dir = std::env::temp_dir().join(format!("gamblium-visited-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        // Never started: nothing to keep.
        assert!(!visited_anything(&dir));
        // A profile with no history file: something unexpected, kept.
        fs::create_dir_all(dir.join("Default")).unwrap();
        assert!(visited_anything(&dir));
        // New tab pages only: nothing to keep.
        let history = dir.join("Default").join("History");
        let db = rusqlite::Connection::open(&history).unwrap();
        db.execute_batch("CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT); INSERT INTO urls (url) VALUES ('chrome://newtab/');").unwrap();
        drop(db);
        assert!(!visited_anything(&dir));
        // A website: kept.
        let db = rusqlite::Connection::open(&history).unwrap();
        db.execute("INSERT INTO urls (url) VALUES ('https://mail.google.com/')", []).unwrap();
        drop(db);
        assert!(visited_anything(&dir));
        // A packed profile: its history is inside the pack, kept.
        fs::remove_dir_all(dir.join("Default")).unwrap();
        fs::write(dir.join("profile.tar.zst"), b"").unwrap();
        assert!(visited_anything(&dir));
        fs::remove_dir_all(&dir).unwrap();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_plain_words_and_never_a_command() {
        for good in ["work", "bank-2", "a_b", "X", "my work", "  spaced   out  ", "a.b"] {
            assert!(valid_name(good), "{good}");
        }
        for bad in ["", "   ", "create", "List", " open ", "help", "a/b", r"a\b", "-x", "#abc", "a:b", &"x".repeat(41)] {
            assert!(!valid_name(bad), "{bad}");
        }
        // The same name whatever the spaces and capitals.
        assert_eq!(name_key("  My   Work "), name_key("my work"));
        assert_eq!(tidy_name("  My   Work "), "My Work");
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

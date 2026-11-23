//! Launcher for the official Brave binary.
//!
//! Brave is configured from outside and never renamed or patched:
//! - prefs are written into `Local State` while the browser is closed,
//! - the per-app GPU preference is set in the registry,
//! - command-line switches are passed at start.
//!
//! A preset is only data (prefs + switches), so a new idea can be measured by
//! writing a small JSON file and passing `--preset-file`.

use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;

pub const DEFAULT_BRAVE: &str = r"C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe";

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct Preset {
    pub name: String,
    /// Dotted pref path -> value, written into `Local State`.
    #[serde(default)]
    pub local_state: Map<String, Value>,
    /// Dotted pref path -> value, written into the profile's `Preferences`.
    #[serde(default)]
    pub preferences: Map<String, Value>,
    /// Brave policy name -> value. Written to the current user's policy key,
    /// and only when the caller asks (`--apply-policies`): policies apply to
    /// every Brave profile of this user and show "Managed by your organization".
    #[serde(default)]
    pub policies: Map<String, Value>,
    /// Extra command-line switches.
    #[serde(default)]
    pub args: Vec<String>,
}

/// Prefs every preset writes: telemetry off (verified by an idle netlog) and no
/// background mode, so closing the last window really ends the browser.
fn base_prefs() -> Map<String, Value> {
    let v = json!({
        "brave.p3a.enabled": false,
        "brave.stats.reporting_enabled": false,
        "user_experience_metrics.reporting_enabled": false,
        // No "quit unexpectedly, send diagnostic reports?" bubble (owner's request).
        "brave.dont_ask_for_crash_reporting": true,
        "background_mode.enabled": false,
    });
    v.as_object().unwrap().clone()
}

/// Chromium's own tab freezing, switched on from outside. A frozen tab keeps
/// its state, runs no script, and resumes in about 0.1-0.2 s.
/// - `freezing_visible_protection_time/30s`: freeze 30 s after a tab is hidden.
/// - `unfreeze_interval/60m`, `unfreeze_duration/1s`: Chromium thaws frozen tabs
///   every so often; stretched to once an hour for a second.
/// - `MemoryPurgeOnFreeze`: a frozen tab gives back the memory it can.
/// Measured by the tester session on Brave 1.99 / Chromium 157, 9 hidden tabs,
/// one run each: 18.4% of one core plain, 6.0% with freezing, 3.5% with the
/// hourly thaw and purge (and about 200 MB less memory).
const FREEZE_SWITCH: &str = "--enable-features=InfiniteTabsFreezing:num_protected_tabs/0/freezing_visible_protection_time/30s/unfreeze_interval/60m/unfreeze_duration/1s,MemoryPurgeOnFreeze";

/// Built-in presets.
/// - lean, balanced: hidden tabs freeze after 30 s (instant resume). Brave's
///   Memory Saver may also discard them later; the Gamblium extension does the
///   reliable discarding.
/// - performance: nothing is frozen or discarded.
/// Anything else must be measured first and then added here.
pub fn builtin(name: &str) -> Option<Preset> {
    // state: 0 = off, 2 = on with a timer. aggressiveness: 0-2.
    let (freeze, state, aggressiveness, minutes) = match name {
        "lean" => (true, 2, 2, 10),
        "balanced" => (true, 2, 1, 60),
        "performance" => (false, 0, 0, 120),
        _ => return None,
    };
    let mut local_state = base_prefs();
    local_state.insert("performance_tuning.high_efficiency_mode.state".into(), json!(state));
    local_state.insert("performance_tuning.high_efficiency_mode.aggressiveness".into(), json!(aggressiveness));
    local_state
        .insert("performance_tuning.high_efficiency_mode.time_before_discard_in_minutes".into(), json!(minutes));
    local_state.insert("performance_tuning.tab_freezing.enabled".into(), json!(freeze));
    // No `--process-per-site` (tabs of one site sharing a page process). On
    // 12 tabs of three sites it saved 230 MB, but on 45 real tabs (tester,
    // Brave with only that switch, against plain Brave) it cost 45% more CPU
    // while loading, 61.8% of a core idle against 6.5%, 2 GB more memory and
    // not one process fewer: a hidden tab that shares its process with a
    // showing one is not throttled.
    let args = if freeze { vec![FREEZE_SWITCH.to_owned()] } else { vec![] };
    Some(Preset { name: name.into(), local_state, preferences: Map::new(), policies: Map::new(), args })
}

/// Lays a preset file over `base`: its prefs win, its switches are appended.
pub fn overlay_preset_file(base: &mut Preset, path: &Path) -> io::Result<()> {
    let text = fs::read_to_string(path)?;
    let p: Preset = serde_json::from_str(&text).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    base.name = format!("{}+{}", base.name, p.name);
    base.local_state.extend(p.local_state);
    base.preferences.extend(p.preferences);
    base.policies.extend(p.policies);
    base.args.extend(p.args);
    Ok(())
}

/// Sets `a.b.c` inside nested JSON objects. Returns true if the value changed.
pub fn set_dotted(root: &mut Value, key: &str, value: Value) -> bool {
    let mut node = root;
    let mut parts = key.split('.').peekable();
    while let Some(part) = parts.next() {
        if !node.is_object() {
            *node = Value::Object(Map::new());
        }
        let obj = node.as_object_mut().unwrap();
        if parts.peek().is_none() {
            if obj.get(part) == Some(&value) {
                return false;
            }
            obj.insert(part.to_owned(), value);
            return true;
        }
        node = obj.entry(part.to_owned()).or_insert_with(|| Value::Object(Map::new()));
    }
    false
}

/// Applies prefs to `<user_data_dir>/Local State`. Returns the keys that changed.
/// With `dry_run` nothing is written.
pub fn apply_local_state(user_data_dir: &Path, prefs: &Map<String, Value>, dry_run: bool) -> io::Result<Vec<String>> {
    apply_prefs_file(&user_data_dir.join("Local State"), prefs, dry_run)
}

/// Applies prefs to `<user_data_dir>/<profile>/Preferences`.
pub fn apply_preferences(
    user_data_dir: &Path,
    profile_directory: &str,
    prefs: &Map<String, Value>,
    dry_run: bool,
) -> io::Result<Vec<String>> {
    apply_prefs_file(&user_data_dir.join(profile_directory).join("Preferences"), prefs, dry_run)
}

/// Writes `<file>.gamblium.good` (tmp, sync, rename) when its text differs.
fn keep_last_good(path: &Path, text: &str) {
    let name = path.file_name().unwrap_or_default().to_string_lossy().into_owned();
    let good = path.with_file_name(format!("{name}.gamblium.good"));
    if fs::read_to_string(&good).is_ok_and(|t| t == text) {
        return;
    }
    let tmp = path.with_file_name(format!("{name}.gamblium.good.tmp"));
    let ok = fs::File::create(&tmp).and_then(|mut f| {
        io::Write::write_all(&mut f, text.as_bytes())?;
        f.sync_all()
    });
    if ok.is_ok() {
        let _ = fs::rename(&tmp, &good);
    } else {
        let _ = fs::remove_file(&tmp);
    }
}

/// Sets dotted prefs in one of Brave's JSON pref files. Only safe while Brave
/// is closed: it rewrites both files on exit.
fn apply_prefs_file(path: &Path, prefs: &Map<String, Value>, dry_run: bool) -> io::Result<Vec<String>> {
    let mut root: Value = match fs::read_to_string(path) {
        Ok(text) => match serde_json::from_str::<Value>(&text) {
            Ok(v) => {
                // The last good Local State, refreshed at every start that reads one (with its
                // current key), synced: what a damaged one is restored from (review 6, D6: the
                // first-ever copy could hold an older key, and many profiles had none).
                if !dry_run && v.get("os_crypt").is_some() && path.file_name().is_some_and(|n| n == "Local State") {
                    keep_last_good(path, &text);
                }
                v
            }
            // Preferences only. A damaged Local State is never handed to the browser: it holds the
            // key that decrypts the profile's cookies and saved passwords, and a rebuilt one makes
            // a new key, so every sign-in would be lost (review 4, B14). The start stops instead.
            Err(_) if !dry_run && path.file_name().is_some_and(|n| n == "Preferences") => {
                // Damaged (a power cut): kept aside as .corrupt and left to the browser, which
                // rebuilds it; our settings go in next time (review 2, 1.19: the icon did nothing).
                let mut aside = path.as_os_str().to_owned();
                aside.push(".corrupt");
                let _ = fs::copy(path, PathBuf::from(aside));
                return Ok(Vec::new());
            }
            Err(e) => {
                // A damaged Local State: our own copy of the original (written before our first
                // change, the same encryption key inside) is put back, the damaged one kept aside
                // (review 5, C2: the icon did nothing).
                let file = path.file_name().unwrap_or_default().to_string_lossy().into_owned();
                // The last good copy first (current key), then the first original.
                let read_good = |b: &Path| fs::read_to_string(b).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).filter(|v| v.get("os_crypt").is_some());
                let last = path.with_file_name(format!("{file}.gamblium.good"));
                let first = path.with_file_name(format!("{file}.gamblium.bak"));
                let (backup, good) = match read_good(&last) {
                    Some(v) => (last, Some(v)),
                    None => (first.clone(), read_good(&first)),
                };
                match good {
                    Some(v) if !dry_run => {
                        let mut aside = path.as_os_str().to_owned();
                        aside.push(".corrupt");
                        let _ = fs::copy(path, PathBuf::from(aside));
                        fs::copy(&backup, path)?;
                        v
                    }
                    _ => return Err(io::Error::new(io::ErrorKind::InvalidData, e)),
                }
            }
        },
        // A Local State gone from a profile that has been used (it has its Default folder): the
        // last good copy, with the key of its sign-ins, is put back first (review 8, F7).
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            let good = path.with_file_name(format!("{}.gamblium.good", path.file_name().unwrap_or_default().to_string_lossy()));
            let used = path.parent().is_some_and(|d| d.join("Default").is_dir());
            match fs::read_to_string(&good).ok().filter(|_| used && !dry_run && path.file_name().is_some_and(|n| n == "Local State")).and_then(|t| serde_json::from_str::<Value>(&t).ok().map(|v| (t, v))) {
                Some((t, v)) if v.get("os_crypt").is_some() => {
                    fs::write(path, t)?;
                    v
                }
                _ => Value::Object(Map::new()),
            }
        }
        Err(e) => return Err(e),
    };
    let mut changed = Vec::new();
    for (k, v) in prefs {
        if set_dotted(&mut root, k, v.clone()) {
            changed.push(k.clone());
        }
    }
    if changed.is_empty() || dry_run {
        return Ok(changed);
    }
    let dir = path.parent().unwrap_or(Path::new("."));
    let name = path.file_name().unwrap_or_default().to_string_lossy().into_owned();
    fs::create_dir_all(dir)?;
    // Keep the first original once, then replace the file in one step.
    let backup = dir.join(format!("{name}.gamblium.bak"));
    if path.exists() && !backup.exists() {
        fs::copy(path, &backup)?;
    }
    let tmp = dir.join(format!("{name}.gamblium.tmp"));
    {
        // On disk before it replaces the file: a power cut left it empty (review 5, C2).
        let mut f = fs::File::create(&tmp)?;
        io::Write::write_all(&mut f, serde_json::to_string(&root).unwrap().as_bytes())?;
        f.sync_all()?;
    }
    fs::rename(&tmp, path)?;
    Ok(changed)
}

/// Gamblium's toolbar button is its menu (Brave's own menu button is hidden in the copy), so it
/// must stay on the toolbar, at its right end: on every start of one of our profiles, with the
/// browser closed, our extension is put last in `extensions.pinned_extensions` (the copy's
/// extensions area puts the puzzle first and the pinned buttons after it). Other pins stay.
/// Only new folders got the pin before; an older profile, or one unpinned by accident, had the
/// menu four clicks deep (owner, Nov 14 2026). The pref is not protected on Brave 1.99.57.
pub fn ensure_pinned(user_data_dir: &Path, profile_directory: &str, extension_id: &str, dry_run: bool) -> io::Result<bool> {
    let path = user_data_dir.join(profile_directory).join("Preferences");
    let root: Value = match fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).unwrap_or(Value::Null),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Value::Null,
        Err(e) => return Err(e),
    };
    let mut pins: Vec<Value> = root.pointer("/extensions/pinned_extensions").and_then(Value::as_array).cloned().unwrap_or_default();
    if pins.last().is_some_and(|v| v == extension_id) {
        return Ok(false);
    }
    pins.retain(|v| v != extension_id);
    pins.push(json!(extension_id));
    let mut one = Map::new();
    one.insert("extensions.pinned_extensions".into(), Value::Array(pins));
    Ok(!apply_prefs_file(&path, &one, dry_run)?.is_empty())
}

/// How this profile was last started, for the helper to pass on to the
/// extension: its pages cannot read browser prefs, so this is how they learn
/// which theme the browser is wearing.
pub const LAUNCH_INFO_FILE: &str = "gamblium-launch.json";

/// `theme`: None keeps the theme of the last note, because the theme itself
/// stays in the profile. `freeze`: the extension freezes hidden tabs.
/// `seen`: a window a person looks at (not a test, agent, pen-test or hidden start), where the
/// one onboarding after an update may show even when the first-start welcome is skipped.
pub fn write_launch_info(user_data_dir: &Path, theme: Option<&str>, freeze: bool, welcome: bool, seen: bool) -> io::Result<()> {
    fs::create_dir_all(user_data_dir)?;
    let theme = theme.map(str::to_owned).or_else(|| read_launch_theme(user_data_dir));
    fs::write(user_data_dir.join(LAUNCH_INFO_FILE), serde_json::json!({ "theme": theme, "freeze": freeze, "welcome": welcome, "seen": seen }).to_string())
}

/// Whether this profile is a window a person looks at (see write_launch_info). False when unknown.
pub fn read_launch_seen(user_data_dir: &Path) -> bool {
    fs::read_to_string(user_data_dir.join(LAUNCH_INFO_FILE))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .is_some_and(|v| v["seen"] == json!(true))
}

/// Whether the welcome page may open in this profile (false for test,
/// agent and pen-test starts). True when the note says nothing.
pub fn read_launch_welcome(user_data_dir: &Path) -> bool {
    fs::read_to_string(user_data_dir.join(LAUNCH_INFO_FILE))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .map(|v| v["welcome"] != json!(false))
        .unwrap_or(true)
}

/// Whether the profile was last started with freezing handed to the extension.
pub fn read_launch_freeze(user_data_dir: &Path) -> bool {
    fs::read_to_string(user_data_dir.join(LAUNCH_INFO_FILE))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .map(|v| v["freeze"] == json!(true))
        .unwrap_or(false)
}

/// Notes whether this start darkens light-only websites (forced dark), so the
/// extension can give their links a colour that reads after darkening (owner,
/// Nov 14 2026: Google's blue links came out pink). Kept beside the rest of the note.
pub fn note_force_dark(user_data_dir: &Path, on: bool) -> io::Result<()> {
    let file = user_data_dir.join(LAUNCH_INFO_FILE);
    let mut v = fs::read_to_string(&file).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).unwrap_or_else(|| json!({}));
    if !v.is_object() {
        v = json!({});
    }
    v["forceDark"] = json!(on);
    fs::create_dir_all(user_data_dir)?;
    fs::write(file, v.to_string())
}

/// Notes whether this start had no window, so a restart brings it back the same way (review 3,
/// A12: the agent profile came back as a window in front of the person).
pub fn note_hidden(user_data_dir: &Path, hidden: bool) -> io::Result<()> {
    let file = user_data_dir.join(LAUNCH_INFO_FILE);
    let mut v = fs::read_to_string(&file).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).unwrap_or_else(|| json!({}));
    if !v.is_object() {
        v = json!({});
    }
    v["hidden"] = json!(hidden);
    fs::create_dir_all(user_data_dir)?;
    fs::write(file, v.to_string())
}
pub fn was_hidden(user_data_dir: &Path) -> bool {
    fs::read_to_string(user_data_dir.join(LAUNCH_INFO_FILE)).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).is_some_and(|v| v["hidden"] == true)
}

/// Notes whether the browser of this start shows PDFs in Gamblium PDF by itself (the rebranded
/// copy's viewer page). The extension then leaves PDFs alone instead of sending them to its page.
pub fn note_builtin_pdf(user_data_dir: &Path, on: bool) -> io::Result<()> {
    let file = user_data_dir.join(LAUNCH_INFO_FILE);
    let mut v = fs::read_to_string(&file).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).unwrap_or_else(|| json!({}));
    if !v.is_object() {
        v = json!({});
    }
    v["builtinPdf"] = json!(on);
    fs::create_dir_all(user_data_dir)?;
    fs::write(file, v.to_string())
}

pub fn read_builtin_pdf(user_data_dir: &Path) -> bool {
    fs::read_to_string(user_data_dir.join(LAUNCH_INFO_FILE))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .map(|v| v["builtinPdf"] == json!(true))
        .unwrap_or(false)
}

/// Whether the profile was last started with forced dark.
pub fn read_launch_force_dark(user_data_dir: &Path) -> bool {
    fs::read_to_string(user_data_dir.join(LAUNCH_INFO_FILE))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .map(|v| v["forceDark"] == json!(true))
        .unwrap_or(false)
}

/// Hands freezing to the extension: the built-in freezer cannot make
/// exceptions per tab, so it is switched off; frozen tabs still give memory
/// back, and the short debugger attachment shows no warning bar.
/// Returns true if this preset froze tabs.
pub fn freeze_by_extension(preset: &mut Preset) -> bool {
    let before = preset.args.len();
    preset.args.retain(|a| a != FREEZE_SWITCH);
    if preset.args.len() == before {
        return false;
    }
    preset.args.push("--enable-features=MemoryPurgeOnFreeze".into());
    preset.args.push("--silent-debugger-extension-api".into());
    preset.local_state.insert("performance_tuning.tab_freezing.enabled".into(), json!(false));
    true
}

/// The theme the profile was last started with, if any. Anything that is not
/// a plain theme name is ignored.
pub fn read_launch_theme(user_data_dir: &Path) -> Option<String> {
    let text = fs::read_to_string(user_data_dir.join(LAUNCH_INFO_FILE)).ok()?;
    let info: Value = serde_json::from_str(&text).ok()?;
    let theme = info["theme"].as_str()?;
    let plain = !theme.is_empty() && theme.len() <= 40 && theme.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    plain.then(|| theme.to_owned())
}

/// Brave treats a profile folder without a `First Run` file as brand new: it
/// copies its bundled initial preferences over ours and shows the welcome
/// page. `--no-first-run` only covers one start. An empty file settles it.
/// (Found and measured by the design session.) Returns true if it was created.
///
/// The file's date matters too: Brave reads it as the day the browser was
/// set up, and while that is recent one part of its window keeps animating
/// once tabs are frozen, a frame on every screen refresh with nothing
/// changing on screen. 45 tabs in three windows, idle (tester and backend,
/// Nov 13 2026): official Brave with a new file 8.4% of one core in the
/// browser process; ours 10.6% in all with a new file, 1.2% with the file
/// dated 2024. So in our own folders (`ours`) the file is dated
/// `SETTLED_SINCE`. Brave's own profile is not touched.
pub fn ensure_first_run_marker(user_data_dir: &Path, ours: bool) -> io::Result<bool> {
    let marker = user_data_dir.join("First Run");
    let created = !marker.exists();
    if created {
        fs::create_dir_all(user_data_dir)?;
        fs::write(&marker, b"")?;
    }
    if ours {
        settle_date(&marker)?;
    }
    Ok(created)
}

/// The date our profiles' `First Run` file carries (2024-01-01).
pub const SETTLED_SINCE: u64 = 1_704_067_200;

/// Dates a file `SETTLED_SINCE` (made and changed), unless it is older already.
fn settle_date(file: &Path) -> io::Result<()> {
    use std::time::{Duration, UNIX_EPOCH};
    let when = UNIX_EPOCH + Duration::from_secs(SETTLED_SINCE);
    let meta = fs::metadata(file)?;
    let made = meta.created().unwrap_or(when + Duration::from_secs(1));
    let changed = meta.modified().unwrap_or(when + Duration::from_secs(1));
    if made <= when && changed <= when {
        return Ok(());
    }
    let times = fs::FileTimes::new().set_accessed(when).set_modified(when);
    #[cfg(windows)]
    let times = {
        use std::os::windows::fs::FileTimesExt;
        times.set_created(when)
    };
    fs::OpenOptions::new().write(true).open(file)?.set_times(times)
}

/// Starts Brave fully detached from us. Brave must not inherit our output
/// handles, or a program reading the launcher's output through a pipe would
/// wait until the browser exits.
/// Windows' own setting "apps use the light mode" (Settings > Personalisation >
/// Colours). An "-auto" theme follows it; unknown counts as dark.
pub fn windows_apps_are_light() -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let out = std::process::Command::new("reg")
            .args(["query", r"HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize", "/v", "AppsUseLightTheme"])
            .creation_flags(0x0800_0000)
            .output();
        if let Ok(out) = out {
            return String::from_utf8_lossy(&out.stdout).lines().any(|l| l.contains("AppsUseLightTheme") && l.trim_end().ends_with("0x1"));
        }
    }
    false
}

/// A program we start inherits every handle of ours that is marked
/// inheritable, which includes the stdout and stderr we were given, and
/// passes them on to what it starts. A browser that holds the caller's pipe
/// keeps the caller waiting until the browser ends. Unmark them.
pub fn keep_our_output_to_ourselves() {
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::Foundation::{SetHandleInformation, HANDLE_FLAG_INHERIT};
        use windows_sys::Win32::System::Console::{
            GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
        };
        for id in [STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE] {
            let h = GetStdHandle(id);
            if !h.is_null() {
                SetHandleInformation(h, HANDLE_FLAG_INHERIT, 0);
            }
        }
    }
}

/// A file in a profile folder that agents drive (`launch --agent`).
pub const AGENT_MARKER: &str = "gamblium-agent";

/// No terminal window for a program we start (owner, Nov 20 2026: opening Gamblium showed a
/// terminal, which reads as malware). A console program started by one with no console gets a
/// new, visible one; with this it gets a hidden console, which everything it starts shares.
pub fn no_console_window(cmd: &mut std::process::Command) -> &mut std::process::Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}

pub fn spawn_detached(exe: &Path, args: &[String]) -> io::Result<()> {
    use std::process::{Command, Stdio};
    keep_our_output_to_ourselves();
    no_console_window(Command::new(exe).args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())).spawn()?;
    Ok(())
}

/// Like `spawn_detached`, but the new program also leaves the caller's job (the browser puts its
/// helper in one): a restart started by the helper must outlive the browser it closes. Falls back
/// to a plain start where leaving the job is not allowed.
pub fn spawn_outliving(exe: &Path, args: &[String]) -> io::Result<()> {
    use std::process::{Command, Stdio};
    keep_our_output_to_ourselves();
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // A hidden console, not none (DETACHED_PROCESS): with none, every console program it
        // starts (the launcher, taskkill, reg) opened a visible terminal window.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
        let mut cmd = Command::new(exe);
        cmd.args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        cmd.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB);
        if cmd.spawn().is_ok() {
            return Ok(());
        }
    }
    spawn_detached(exe, args)
}

/// One line in `Gamblium\relaunch.log` (the last 200 lines are kept): what a restart did, so a
/// failed one can be read afterwards instead of guessed.
pub fn relaunch_log(line: &str) {
    let Some(file) = std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join("Gamblium").join("relaunch.log")) else { return };
    let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let mut lines: Vec<String> = fs::read_to_string(&file).unwrap_or_default().lines().map(str::to_owned).collect();
    lines.push(format!("{at} {line}"));
    let keep = lines.len().saturating_sub(200);
    let _ = fs::write(&file, lines[keep..].join("\n") + "\n");
}

/// Chromium's "Auto Dark Mode for Web Contents": pages without a dark design
/// are recoloured by the engine at paint time. Photos are left alone.
pub const FORCE_DARK_SWITCH: &str = "--enable-features=WebContentsForceDark";

const LOAD_EXTENSION_GATE: &str = "DisableLoadExtensionCommandLineSwitch";

/// The folder that holds `extension/`, `theme/` and `presets/`: GAMBLIUM_HOME,
/// or the folder of this exe, or one of its parents (a source checkout has the
/// exe in target/release).
pub fn find_home() -> Option<PathBuf> {
    let is_home = |d: &Path| d.join("extension").join("manifest.json").is_file();
    if let Some(h) = std::env::var_os("GAMBLIUM_HOME").map(PathBuf::from) {
        return Some(h).filter(|h| is_home(h));
    }
    let exe = std::env::current_exe().ok()?;
    exe.ancestors().skip(1).take(4).find(|d| is_home(d)).map(Path::to_path_buf)
}

/// The agent profile's own copy of the extension. It is the same code with
/// permission to look at every page, which is what lets `gamblium ctl` read
/// and click without a prompt. Only the agent profile loads this copy.
///
/// The copy is named after its content (review 2, 1.8: every agent launch deleted and recopied
/// one shared folder, so launches at the same time raced and a running agent browser lost files):
/// the same code is reused untouched, new code goes to a new folder, and old copies are removed
/// only when nothing holds them.
pub fn agent_extension(source: &Path) -> io::Result<PathBuf> {
    let root = std::env::var_os("LOCALAPPDATA")
        .map(|d| PathBuf::from(d).join("Gamblium"))
        .ok_or_else(|| io::Error::other("LOCALAPPDATA is not set"))?;
    // Fingerprint: every file's path, size and write time under the source.
    fn walk(base: &Path, p: &Path, h: &mut u64) {
        let mut items: Vec<_> = fs::read_dir(p).into_iter().flatten().flatten().collect();
        items.sort_by_key(|e| e.file_name());
        for e in items {
            let path = e.path();
            let Ok(m) = e.metadata() else { continue };
            let rel = path.strip_prefix(base).unwrap_or(&path).to_string_lossy().into_owned();
            let t = m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_nanos() as u64);
            for b in rel.bytes().chain(m.len().to_le_bytes()).chain(t.to_le_bytes()) {
                *h = (*h ^ b as u64).wrapping_mul(0x100_0000_01b3); // FNV-1a
            }
            if m.is_dir() {
                walk(base, &path, h);
            }
        }
    }
    let mut h = 0xcbf2_9ce4_8422_2325u64;
    walk(source, source, &mut h);
    let dest = root.join(format!("agent-extension-{h:016x}"));
    if dest.join("manifest.json").is_file() {
        return Ok(dest);
    }
    // Built beside, then named: a launch never sees a half copy.
    let tmp = root.join(format!("agent-extension-{h:016x}.tmp{}", std::process::id()));
    let _ = fs::remove_dir_all(&tmp);
    crate::install::copy_tree(source, &tmp)?;
    let built = (|| -> io::Result<()> {
        let manifest_path = tmp.join("manifest.json");
        let mut manifest: Value = serde_json::from_str(&fs::read_to_string(&manifest_path)?).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
        agent_manifest(&mut manifest);
        fs::write(&manifest_path, serde_json::to_string_pretty(&manifest).unwrap())
    })();
    if let Err(e) = built {
        let _ = fs::remove_dir_all(&tmp);
        return Err(e);
    }
    if fs::rename(&tmp, &dest).is_err() {
        // Another launch made the same copy meanwhile: use it.
        let _ = fs::remove_dir_all(&tmp);
        if !dest.join("manifest.json").is_file() {
            return Err(io::Error::other("could not set up the agent's copy of the extension"));
        }
    }
    // Older copies go when nothing holds them (a running agent browser keeps its own).
    for e in fs::read_dir(&root).into_iter().flatten().flatten() {
        let n = e.file_name().to_string_lossy().into_owned();
        let day_old = e.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|el| el.as_secs() > 86_400);
        if (n == "agent-extension" || n.starts_with("agent-extension-")) && e.path() != dest && !n.contains(".tmp") && day_old {
            let _ = fs::rename(e.path(), root.join(format!("{n}.old"))).and_then(|_| fs::remove_dir_all(root.join(format!("{n}.old"))));
        }
    }
    Ok(dest)
}

fn agent_manifest(manifest: &mut Value) {
    manifest["host_permissions"] = json!(["<all_urls>"]);
    if let Some(perms) = manifest["permissions"].as_array_mut() {
        if !perms.contains(&json!("cookies")) {
            perms.push(json!("cookies"));
        }
        // Real mouse and keyboard input for agents: attached to one tab for
        // the length of one command, never held.
        // Dropping a half-done Cloudflare check's cache for one site (background.js).
        if !perms.contains(&json!("browsingData")) {
            perms.push(json!("browsingData"));
        }
        if !perms.contains(&json!("debugger")) {
            perms.push(json!("debugger"));
        }
    }
    manifest["name"] = json!("Gamblium (agent profile)");
}

/// A folder Brave has never run in.
pub fn is_new_profile_folder(user_data_dir: &Path) -> bool {
    !user_data_dir.join("Local State").exists() && !user_data_dir.join("First Run").exists()
}

/// Brave's ad-block filter lists into a brand-new profile folder, from Gamblium's own profile.
/// They are downloaded components kept per profile folder, so a new folder (a No session window,
/// a new session, a test window) blocked nothing until they arrived: YouTube showed ads in its
/// first minute (owner, Nov 23 2026; measured: 2 ad slots and an ad without, none with). Found by
/// each component's own name, not by id. Returns how many were copied.
pub fn seed_ad_block(to: &Path) -> usize {
    let Some(from) = std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join("Gamblium").join("User Data")) else { return 0 };
    if !from.is_dir() || from == to {
        return 0;
    }
    let mut n = 0;
    for e in fs::read_dir(&from).into_iter().flatten().flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if name.len() != 32 || !name.bytes().all(|b| (b'a'..=b'p').contains(&b)) || to.join(&name).exists() {
            continue;
        }
        let dir = e.path();
        let is_filter_list = fs::read_dir(&dir).into_iter().flatten().flatten().any(|v| {
            fs::read_to_string(v.path().join("manifest.json"))
                .ok()
                .and_then(|t| serde_json::from_str::<Value>(&t).ok())
                .and_then(|m| m["name"].as_str().map(|s| s.contains("Ad Block Updater") || s.contains("Local Data Files")))
                .unwrap_or(false)
        });
        if is_filter_list && crate::rebrand::copy_all(&dir, &to.join(&name)).is_ok() {
            n += 1;
        }
    }
    n
}

pub fn default_user_data_dir() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join(r"BraveSoftware\Brave-Browser\User Data"))
}

pub fn agent_user_data_dir() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join(r"Gamblium\agent-profile"))
}

pub fn pentest_user_data_dir() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join(r"Gamblium\pentest-profile"))
}

pub const POLICY_KEY: &str = r"HKCU\Software\Policies\BraveSoftware\Brave";

/// `reg add` arguments for one policy. true/false and whole numbers become
/// REG_DWORD, text becomes REG_SZ. Anything else is refused.
pub fn policy_reg_args(name: &str, value: &Value) -> Result<Vec<String>, String> {
    if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(format!("'{name}' is not a policy name"));
    }
    let (kind, data) = match value {
        Value::Bool(b) => ("REG_DWORD", (*b as u32).to_string()),
        Value::Number(n) => match n.as_u64().filter(|v| *v <= u32::MAX as u64) {
            Some(v) => ("REG_DWORD", v.to_string()),
            None => return Err(format!("policy {name}: {n} is not a whole number that fits")),
        },
        Value::String(text) => ("REG_SZ", text.clone()),
        other => return Err(format!("policy {name}: cannot write {other} to the registry")),
    };
    Ok(["add", POLICY_KEY, "/v", name, "/t", kind, "/d", &data, "/f"].iter().map(|s| s.to_string()).collect())
}

fn policies_record() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join("Gamblium").join("policies-applied.txt"))
}

/// Writes the policies and remembers their names so they can be removed again.
/// Returns the names written. With `dry_run` nothing is written.
pub fn apply_policies(policies: &Map<String, Value>, dry_run: bool) -> Result<Vec<String>, String> {
    let mut written = Vec::new();
    for (name, value) in policies {
        let args = policy_reg_args(name, value)?;
        if !dry_run {
            let out = Command::new("reg").args(&args).output().map_err(|e| e.to_string())?;
            if !out.status.success() {
                return Err(format!("policy {name}: {}", String::from_utf8_lossy(&out.stderr).trim()));
            }
        }
        written.push(name.clone());
    }
    if !dry_run && !written.is_empty() {
        if let Some(record) = policies_record() {
            let mut names: Vec<String> =
                fs::read_to_string(&record).unwrap_or_default().lines().map(str::to_owned).filter(|l| !l.is_empty()).collect();
            for n in &written {
                if !names.contains(n) {
                    names.push(n.clone());
                }
            }
            if let Some(dir) = record.parent() {
                let _ = fs::create_dir_all(dir);
            }
            fs::write(&record, names.join("\n") + "\n").map_err(|e| e.to_string())?;
        }
    }
    Ok(written)
}

/// Removes exactly the policies Gamblium wrote earlier. Returns their names.
pub fn remove_policies(dry_run: bool) -> Result<Vec<String>, String> {
    let Some(record) = policies_record() else { return Ok(vec![]) };
    let names: Vec<String> =
        fs::read_to_string(&record).unwrap_or_default().lines().map(str::to_owned).filter(|l| !l.is_empty()).collect();
    if !dry_run {
        for name in &names {
            let _ = Command::new("reg").args(["delete", POLICY_KEY, "/v", name, "/f"]).output();
        }
        let _ = fs::remove_file(&record);
    }
    Ok(names)
}

/// After a forced stop Brave thinks it crashed: next start it offers to restore
/// the old tabs and asks about crash reports. Marking the exit as clean avoids both.
/// The window a profile last had (its place, size, maximised), as the browser saved it.
pub fn window_placement(user_data_dir: &Path) -> Option<Value> {
    let t = fs::read_to_string(user_data_dir.join("Default").join("Preferences")).ok()?;
    let v: Value = serde_json::from_str(&t).ok()?;
    let p = v.get("browser")?.get("window_placement")?.clone();
    p.is_object().then_some(p)
}

/// Puts back the window a profile had before a start with no window (owner, Nov 20 2026: windows
/// opened small, about 780 x 580, after every update). A browser started with no window saves its
/// invisible 800 x 600 window as the profile's last one, and the next real start used that size.
pub fn put_back_window_placement(user_data_dir: &Path, before: Option<Value>) {
    let file = user_data_dir.join("Default").join("Preferences");
    let Ok(t) = fs::read_to_string(&file) else { return };
    let Ok(mut v) = serde_json::from_str::<Value>(&t) else { return };
    if v.get("browser").and_then(|b| b.get("window_placement")) == before.as_ref() {
        return;
    }
    let Some(browser) = v.get_mut("browser").and_then(Value::as_object_mut) else { return };
    match before {
        Some(p) => {
            browser.insert("window_placement".into(), p);
        }
        None => {
            browser.remove("window_placement");
        }
    }
    if let Ok(text) = serde_json::to_string(&v) {
        let _ = fs::write(&file, text);
    }
}

/// A saved window that a start with no window left: its screen is the 800 x 600 one.
pub fn placement_is_from_hidden_start(p: &Value) -> bool {
    p["work_area_right"].as_i64().unwrap_or(0) <= 800 && p["work_area_bottom"].as_i64().unwrap_or(0) <= 600
}

/// Stops a browser with ALL its windows at once, so every window comes back at its next start.
/// A polite close (`taskkill /PID`, a click on each close button) closes the windows one by one:
/// the browser moves each but the last to Recently closed and brings back only the last (owner,
/// Nov 16 2026: Personal's 17-tab window was lost at a restart). The browser saves its windows a
/// few seconds after each change, so it gets 3 s to settle, then stops as one, and the exit is
/// marked clean (no "restore pages?" question).
pub fn stop_whole_browser(pid: u32, user_data_dir: &Path) {
    std::thread::sleep(std::time::Duration::from_secs(3));
    crate::procs::kill_tree(pid);
    for _ in 0..40 {
        if !crate::procs::is_running(pid) {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
    std::thread::sleep(std::time::Duration::from_millis(500));
    let _ = mark_clean_exit(user_data_dir);
}

pub fn mark_clean_exit(user_data_dir: &Path) -> io::Result<()> {
    let prefs = user_data_dir.join("Default").join("Preferences");
    if !prefs.is_file() {
        return Ok(());
    }
    let mut m = Map::new();
    m.insert("profile.exit_type".into(), json!("Normal"));
    m.insert("profile.exited_cleanly".into(), json!(true));
    apply_prefs_file(&prefs, &m, false).map(|_| ())
}

/// Is this folder under the system temp directory (a throwaway test profile)?
pub fn is_temp_folder(dir: &str) -> bool {
    let temp = std::env::temp_dir().to_string_lossy().to_ascii_lowercase();
    let temp = temp.trim_end_matches(|c| c == '/' || c == '\\');
    dir.to_ascii_lowercase().replace('/', "\\").starts_with(temp)
}

const GPU_KEY: &str = r"HKCU\Software\Microsoft\DirectX\UserGpuPreferences";
const GPU_VALUE: &str = "GpuPreference=1;";

/// Routes the exe to the integrated GPU. On this machine the NVIDIA driver
/// profile for brave.exe otherwise forces a GPU where D3D11 fails and Brave
/// falls back to software rendering. Returns true if the registry was changed.
pub fn ensure_gpu_preference(exe: &Path, dry_run: bool) -> io::Result<bool> {
    let exe = exe.to_string_lossy().into_owned();
    let query = Command::new("reg").args(["query", GPU_KEY, "/v", &exe]).output()?;
    if query.status.success() && String::from_utf8_lossy(&query.stdout).contains(GPU_VALUE) {
        return Ok(false);
    }
    if dry_run {
        return Ok(true);
    }
    let add = Command::new("reg").args(["add", GPU_KEY, "/v", &exe, "/t", "REG_SZ", "/d", GPU_VALUE, "/f"]).output()?;
    if !add.status.success() {
        return Err(io::Error::other(String::from_utf8_lossy(&add.stderr).into_owned()));
    }
    Ok(true)
}

/// Command line for Brave. `user_data_dir` is None for Brave's default location.
pub fn build_args(
    user_data_dir: Option<&Path>,
    profile_directory: Option<&str>,
    debug_port: Option<u16>,
    preset: &Preset,
    extra: &[String],
) -> Vec<String> {
    let mut args = Vec::new();
    if let Some(dir) = user_data_dir {
        args.push(format!("--user-data-dir={}", dir.display()));
    }
    if let Some(p) = profile_directory {
        args.push(format!("--profile-directory={p}"));
    }
    if let Some(port) = debug_port {
        args.push(format!("--remote-debugging-port={port}"));
    }
    // Chromium keeps only the LAST --enable-features (and --disable-features)
    // switch, so every list from the preset and from the caller is joined into one.
    // The same goes for --load-extension: one switch, paths joined by commas.
    let mut enable: Vec<&str> = Vec::new();
    let mut disable: Vec<&str> = Vec::new();
    let mut extensions: Vec<&str> = Vec::new();
    for a in preset.args.iter().chain(extra.iter()) {
        if let Some(v) = a.strip_prefix("--enable-features=") {
            enable.push(v);
        } else if let Some(v) = a.strip_prefix("--disable-features=") {
            disable.push(v);
        } else if let Some(v) = a.strip_prefix("--load-extension=") {
            extensions.push(v);
        } else {
            args.push(a.clone());
        }
    }
    if !extensions.is_empty() {
        args.push(format!("--load-extension={}", extensions.join(",")));
        // Without this, Chromium 137+ ignores --load-extension.
        if !disable.iter().any(|d| d.split(',').any(|f| f == LOAD_EXTENSION_GATE)) {
            disable.push(LOAD_EXTENSION_GATE);
        }
    }
    // A tab put to sleep keeps its id (owner, Nov 20 2026: Claude in Chrome lost its tabs, whose
    // ids changed when they slept). Checked on Brave 1.99.57: without it the id changes and the
    // old one is gone; with it the same id, and the tab wakes by it.
    if !enable.iter().any(|e| e.split(',').any(|f| f == "WebContentsDiscard")) {
        enable.push("WebContentsDiscard");
    }
    if !enable.is_empty() {
        args.push(format!("--enable-features={}", enable.join(",")));
    }
    if !disable.is_empty() {
        args.push(format!("--disable-features={}", disable.join(",")));
    }
    args
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("gamblium-test-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn the_launch_theme_is_written_and_read_back() {
        let dir = temp_dir("launchinfo");
        assert_eq!(read_launch_theme(&dir), None);
        write_launch_info(&dir, Some("burgundy-dark"), false, true, true).unwrap();
        assert!(read_launch_welcome(&dir));
        assert_eq!(read_launch_theme(&dir).as_deref(), Some("burgundy-dark"));
        assert!(!read_launch_freeze(&dir));
        write_launch_info(&dir, None, true, false, false).unwrap();
        assert!(!read_launch_force_dark(&dir));
        note_force_dark(&dir, true).unwrap();
        assert!(read_launch_force_dark(&dir));
        assert!(read_launch_freeze(&dir)); // the rest of the note stays
        note_force_dark(&dir, false).unwrap();
        assert!(!read_launch_force_dark(&dir));
        assert!(!read_launch_welcome(&dir));
        assert_eq!(read_launch_theme(&dir).as_deref(), Some("burgundy-dark")); // kept
        assert!(read_launch_freeze(&dir));
        let mut lean = builtin("lean").unwrap();
        assert!(freeze_by_extension(&mut lean));
        assert!(!lean.args.iter().any(|a| a.contains("InfiniteTabsFreezing")));
        assert!(lean.args.iter().any(|a| a == "--silent-debugger-extension-api"));
        assert_eq!(lean.local_state["performance_tuning.tab_freezing.enabled"], json!(false));
        assert!(!freeze_by_extension(&mut builtin("performance").unwrap()));
        fs::write(dir.join(LAUNCH_INFO_FILE), r#"{"theme":"../x"}"#).unwrap();
        assert_eq!(read_launch_theme(&dir), None);
        fs::write(dir.join(LAUNCH_INFO_FILE), "not json").unwrap();
        assert_eq!(read_launch_theme(&dir), None);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn set_dotted_creates_nested_objects_and_reports_change() {
        let mut v = json!({"brave": {"other": 1}});
        assert!(set_dotted(&mut v, "brave.p3a.enabled", json!(false)));
        assert_eq!(v, json!({"brave": {"other": 1, "p3a": {"enabled": false}}}));
        assert!(!set_dotted(&mut v, "brave.p3a.enabled", json!(false)));
        assert!(set_dotted(&mut v, "brave.p3a.enabled", json!(true)));
    }

    #[test]
    fn apply_local_state_keeps_other_keys_backs_up_and_is_idempotent() {
        let dir = temp_dir("ls");
        fs::write(dir.join("Local State"), r#"{"browser":{"enabled_labs_experiments":["x@1"]}}"#).unwrap();
        let preset = builtin("lean").unwrap();

        let changed = apply_local_state(&dir, &preset.local_state, false).unwrap();
        assert_eq!(changed.len(), preset.local_state.len());
        let v: Value = serde_json::from_str(&fs::read_to_string(dir.join("Local State")).unwrap()).unwrap();
        assert_eq!(v["browser"]["enabled_labs_experiments"], json!(["x@1"]));
        assert_eq!(v["brave"]["p3a"]["enabled"], json!(false));
        assert_eq!(v["performance_tuning"]["high_efficiency_mode"]["time_before_discard_in_minutes"], json!(10));
        assert_eq!(v["performance_tuning"]["tab_freezing"]["enabled"], json!(true));
        assert!(dir.join("Local State.gamblium.bak").exists());

        assert!(apply_local_state(&dir, &preset.local_state, false).unwrap().is_empty());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn policies_become_registry_values_of_the_right_type() {
        let args = policy_reg_args("BraveTalkDisabled", &json!(1)).unwrap();
        assert_eq!(&args[2..], ["/v", "BraveTalkDisabled", "/t", "REG_DWORD", "/d", "1", "/f"]);
        assert!(args[1].ends_with("Policies\\BraveSoftware\\Brave"));
        assert_eq!(policy_reg_args("X", &json!(false)).unwrap()[7], "0");
        assert_eq!(policy_reg_args("X", &json!(true)).unwrap()[7], "1");
        let text = policy_reg_args("HomepageLocation", &json!("about:blank")).unwrap();
        assert_eq!((text[5].as_str(), text[7].as_str()), ("REG_SZ", "about:blank"));
        for bad in [json!(-1), json!(1.5), json!(5_000_000_000u64), json!(null), json!([1]), json!({"a": 1})] {
            assert!(policy_reg_args("X", &bad).is_err(), "{bad}");
        }
        for name in ["", "Bad Name", "a/b", "x;y"] {
            assert!(policy_reg_args(name, &json!(1)).is_err(), "{name}");
        }
        // Dry run: reports the names, writes nothing.
        let mut m = Map::new();
        m.insert("BraveTalkDisabled".into(), json!(1));
        assert_eq!(apply_policies(&m, true).unwrap(), vec!["BraveTalkDisabled"]);
    }

    #[test]
    fn temp_folders_are_recognised_and_others_are_not() {
        let t = std::env::temp_dir();
        assert!(is_temp_folder(&t.join("claude").join("x").join("profile").to_string_lossy()));
        assert!(is_temp_folder(&t.to_string_lossy().to_uppercase()));
        assert!(!is_temp_folder(r"C:\Users\someone\AppData\Local\BraveSoftware\Brave-Browser\User Data"));
        assert!(!is_temp_folder(r"C:\Users\someone\AppData\Local\Gamblium\agent-profile"));
    }

    #[test]
    fn a_forced_stop_is_marked_as_a_clean_exit() {
        let dir = temp_dir("exit");
        fs::create_dir_all(dir.join("Default")).unwrap();
        fs::write(dir.join("Default").join("Preferences"), r#"{"profile":{"exit_type":"Crashed","name":"x"}}"#).unwrap();
        mark_clean_exit(&dir).unwrap();
        let v: Value = serde_json::from_str(&fs::read_to_string(dir.join("Default").join("Preferences")).unwrap()).unwrap();
        assert_eq!(v["profile"]["exit_type"], json!("Normal"));
        assert_eq!(v["profile"]["exited_cleanly"], json!(true));
        assert_eq!(v["profile"]["name"], json!("x"));
        let none = temp_dir("exit-none");
        mark_clean_exit(&none).unwrap(); // no profile yet: nothing to do
        fs::remove_dir_all(&none).unwrap();
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn first_run_marker_is_created_once_and_dated_in_the_past_in_our_folders() {
        use std::time::{Duration, SystemTime, UNIX_EPOCH};
        let settled = UNIX_EPOCH + Duration::from_secs(SETTLED_SINCE);
        let dir = temp_dir("firstrun").join("new-profile");
        assert!(ensure_first_run_marker(&dir, true).unwrap());
        let marker = dir.join("First Run");
        assert!(marker.is_file());
        let meta = fs::metadata(&marker).unwrap();
        assert_eq!(meta.modified().unwrap(), settled);
        #[cfg(windows)]
        assert_eq!(meta.created().unwrap(), settled);
        assert!(!ensure_first_run_marker(&dir, true).unwrap());
        // A file made by an earlier version (dated today) is dated back too.
        fs::OpenOptions::new().write(true).open(&marker).unwrap().set_modified(SystemTime::now()).unwrap();
        assert!(fs::metadata(&marker).unwrap().modified().unwrap() > settled);
        ensure_first_run_marker(&dir, true).unwrap();
        assert_eq!(fs::metadata(&marker).unwrap().modified().unwrap(), settled);
        // Not our folder (Brave's own profile): created if missing, never re-dated.
        let brave = temp_dir("firstrun-brave");
        fs::write(brave.join("First Run"), b"").unwrap();
        ensure_first_run_marker(&brave, false).unwrap();
        assert!(fs::metadata(brave.join("First Run")).unwrap().modified().unwrap() > SystemTime::now() - Duration::from_secs(600));
        fs::remove_dir_all(dir.parent().unwrap()).unwrap();
        fs::remove_dir_all(&brave).unwrap();
    }

    #[test]
    fn dry_run_writes_nothing() {
        let dir = temp_dir("dry");
        let preset = builtin("balanced").unwrap();
        let changed = apply_local_state(&dir, &preset.local_state, true).unwrap();
        assert!(!changed.is_empty());
        assert!(!dir.join("Local State").exists());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn preset_file_overlays_the_builtin_preset() {
        let dir = temp_dir("preset");
        let f = dir.join("p.json");
        fs::write(
            &f,
            r#"{"name":"debloat","local_state":{"background_mode.enabled":true},
                "preferences":{"brave.show_side_panel_button":false},"args":["--enable-features=Foo"]}"#,
        )
        .unwrap();
        let mut p = builtin("lean").unwrap();
        overlay_preset_file(&mut p, &f).unwrap();
        assert_eq!(p.name, "lean+debloat");
        assert_eq!(p.local_state["background_mode.enabled"], json!(true));
        assert_eq!(p.local_state["brave.p3a.enabled"], json!(false));
        assert_eq!(p.preferences["brave.show_side_panel_button"], json!(false));
        assert_eq!(p.args, vec![FREEZE_SWITCH, "--enable-features=Foo"]);

        let changed = apply_preferences(&dir, "Default", &p.preferences, false).unwrap();
        assert_eq!(changed, vec!["brave.show_side_panel_button"]);
        let v: Value =
            serde_json::from_str(&fs::read_to_string(dir.join("Default").join("Preferences")).unwrap()).unwrap();
        assert_eq!(v["brave"]["show_side_panel_button"], json!(false));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn build_args_orders_profile_then_preset_then_extra() {
        let mut preset = builtin("performance").unwrap();
        assert!(preset.args.is_empty());
        preset.args.push("--a".into());
        let args = build_args(Some(Path::new(r"C:\x y")), Some("Profile 1"), Some(9333), &preset, &["--b".into()]);
        assert_eq!(
            args,
            vec![r"--user-data-dir=C:\x y", "--profile-directory=Profile 1", "--remote-debugging-port=9333", "--a", "--b", "--enable-features=WebContentsDiscard"]
        );
        assert!(builtin("nope").is_none());
    }

    #[test]
    fn feature_switches_are_merged_into_one_each() {
        let mut preset = builtin("lean").unwrap();
        preset.args.push("--disable-features=A".into());
        let extra = vec!["--enable-features=X,Y".to_string(), "about:blank".into(), "--disable-features=B".into()];
        let args = build_args(None, None, None, &preset, &extra);
        assert_eq!(args.iter().filter(|a| a.starts_with("--enable-features=")).count(), 1);
        assert_eq!(args.iter().filter(|a| a.starts_with("--disable-features=")).count(), 1);
        assert!(args.contains(&format!("{FREEZE_SWITCH},X,Y,WebContentsDiscard")));
        assert!(args.contains(&"--disable-features=A,B".to_string()));
        // No preset makes tabs of one site share a page process.
        assert!(args.contains(&"about:blank".to_string()));
        for name in ["lean", "balanced", "performance"] {
            assert!(!builtin(name).unwrap().args.iter().any(|a| a.contains("process-per-site")), "{name}");
        }
    }

    #[test]
    fn extensions_go_into_one_switch_and_open_the_gate_once() {
        let mut preset = builtin("performance").unwrap();
        preset.args.push(r"--load-extension=C:\g	heme\dark".into());
        preset.args.push(r"--load-extension=C:\g\extension".into());
        let args = build_args(None, None, None, &preset, &[]);
        assert_eq!(args, vec![
            r"--load-extension=C:\g	heme\dark,C:\g\extension",
            "--enable-features=WebContentsDiscard",
            "--disable-features=DisableLoadExtensionCommandLineSwitch",
        ]);
        let extra = vec!["--disable-features=X,DisableLoadExtensionCommandLineSwitch".to_string()];
        let args = build_args(None, None, None, &preset, &extra);
        assert_eq!(args[2], "--disable-features=X,DisableLoadExtensionCommandLineSwitch");
    }


    #[test]
    fn our_button_is_pinned_last_and_other_pins_stay() {
        let dir = std::env::temp_dir().join(format!("gpin-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("Default")).unwrap();
        fs::write(dir.join("Default").join("Preferences"), r#"{"extensions":{"pinned_extensions":["ours","other"]},"keep":1}"#).unwrap();
        assert!(ensure_pinned(&dir, "Default", "ours", false).unwrap());
        let v: Value = serde_json::from_str(&fs::read_to_string(dir.join("Default").join("Preferences")).unwrap()).unwrap();
        assert_eq!(v["extensions"]["pinned_extensions"], json!(["other", "ours"]));
        assert_eq!(v["keep"], json!(1));
        assert!(!ensure_pinned(&dir, "Default", "ours", false).unwrap()); // already there: nothing written
        let _ = fs::remove_dir_all(&dir);
    }
}

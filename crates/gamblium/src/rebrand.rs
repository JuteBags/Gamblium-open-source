//! A private copy of Brave's program folder that wears Gamblium's mark and
//! name. The installed Brave is never changed and `brave.exe` is never renamed
//! (a renamed exe costs about 80 MB more memory): only resource packs in the
//! copy are rewritten, by `tools/rebrand/rebrand.py`.
//!
//! Brave's updater does not know about the copy, so it goes stale with every
//! Brave update. The launcher uses the copy only while its version is the
//! installed one; otherwise it starts the official Brave and says so.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

/// The file the patcher leaves in the version folder when it is done.
const REPORT: &str = "gamblium-rebrand.json";
/// In a browser folder that came inside the Gamblium package: it is ours
/// whatever Brave is or is not installed on the machine.
pub const SHIPPED: &str = "gamblium-shipped";

/// The browser inside the package this program was started from
/// (`browser\Application` beside the programs), if it is there and patched.
pub fn packaged_browser() -> Option<PathBuf> {
    let dir = std::env::current_exe().ok()?.parent()?.join("browser").join("Application");
    patched_exe(&dir)
}

/// `brave.exe` of a browser folder the patcher has finished with.
pub fn patched_exe(application: &Path) -> Option<PathBuf> {
    let exe = application.join("brave.exe");
    let patched = version_folder(application).is_some_and(|v| v.join(REPORT).is_file());
    (exe.is_file() && patched).then_some(exe)
}

/// `%LOCALAPPDATA%\Gamblium\browser\Application`
/// Removes `*.gamblium-tmp` files the patcher left in the copy's folders.
fn leftovers_away(dest: &Path) {
    let mut dirs = vec![dest.to_path_buf()];
    if let Some(parent) = dest.parent() {
        dirs.push(parent.to_path_buf());
    }
    for d in dirs {
        for e in std::fs::read_dir(&d).into_iter().flatten().flatten() {
            if e.file_name().to_string_lossy().ends_with(".gamblium-tmp") {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
}

pub fn copy_dir() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join("Gamblium").join("browser").join("Application"))
}

/// A file that says: start the official Brave even though a copy exists.
/// Set from the Settings page or with `gamblium rebrand --off`.
pub fn official_marker() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join("Gamblium").join("use-official-brave"))
}

pub fn wants_official() -> bool {
    official_marker().map(|m| m.is_file()).unwrap_or(false)
}

/// Switches between the rebranded copy (false) and Brave's own look (true).
/// Takes effect the next time the browser is started.
pub fn set_official(on: bool) -> Result<(), String> {
    let marker = official_marker().ok_or("LOCALAPPDATA is not set")?;
    if on {
        if let Some(dir) = marker.parent() {
            fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        fs::write(&marker, "The official Brave is started instead of Gamblium's rebranded copy. Delete this file to go back.\n").map_err(|e| e.to_string())
    } else if marker.exists() {
        fs::remove_file(&marker).map_err(|e| e.to_string())
    } else {
        Ok(())
    }
}

static LOOK_DIR: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

/// Says which profile this program works for. The look the owner chose
/// (theme, own colours, dark websites) lives in the Gamblium folder and
/// belongs to Gamblium's own profile. Any other profile folder (a test
/// window, a named session, the agent profile) keeps its look inside itself,
/// so what a test clicks in Settings never changes how the owner's Gamblium
/// starts (it did: a test left the owner's theme on burgundy).
pub fn look_belongs_to(profile: Option<&Path>) {
    let Some(profile) = profile else { return };
    let norm = |p: &Path| p.to_string_lossy().to_ascii_lowercase().replace('/', "\\").trim_end_matches('\\').to_owned();
    let own = crate::install::profile_dir().map(|p| norm(&p));
    if own.as_deref() != Some(norm(profile).as_str()) {
        let _ = LOOK_DIR.set(profile.to_path_buf());
    }
}

fn look_dir() -> Option<PathBuf> {
    LOOK_DIR.get().cloned().or_else(|| std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join("Gamblium")))
}

/// A file that says: leave light-only websites light. Without it the starter
/// makes every website dark (`launch --auto-dark`), because a dark browser
/// around a white page is what the owner called broken.
pub fn light_pages_marker() -> Option<PathBuf> {
    look_dir().map(|d| d.join("keep-websites-light"))
}

pub fn wants_dark_pages() -> bool {
    !light_pages_marker().map(|m| m.is_file()).unwrap_or(false)
}

pub fn set_dark_pages(on: bool) -> Result<(), String> {
    let marker = light_pages_marker().ok_or("LOCALAPPDATA is not set")?;
    if !on {
        if let Some(dir) = marker.parent() {
            fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        fs::write(&marker, "Websites keep their own colours. Delete this file to make light-only websites dark again.\n").map_err(|e| e.to_string())
    } else if marker.exists() {
        fs::remove_file(&marker).map_err(|e| e.to_string())
    } else {
        Ok(())
    }
}

/// The theme the user chose (welcome page or Settings), for the next start.
pub fn chosen_theme_file() -> Option<PathBuf> {
    look_dir().map(|d| d.join("theme.txt"))
}

fn plain_theme_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 40 && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

pub fn chosen_theme() -> Option<String> {
    let name = fs::read_to_string(chosen_theme_file()?).ok()?.trim().to_owned();
    plain_theme_name(&name).then_some(name)
}

pub fn set_chosen_theme(name: &str) -> Result<(), String> {
    if !plain_theme_name(name) {
        return Err(format!("'{name}' is not a theme name"));
    }
    let file = chosen_theme_file().ok_or("LOCALAPPDATA is not set")?;
    if let Some(dir) = file.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    fs::write(&file, name).map_err(|e| e.to_string())
}

/// The colours the user picked in Settings (accent and background), kept in
/// a file so the launcher can dress the browser's own frame in them and tell
/// websites the truth about light or dark.
pub fn own_colours_file() -> Option<PathBuf> {
    look_dir().map(|d| d.join("own-colours.json"))
}

/// "#rrggbb" -> 0xRRGGBB
pub fn parse_colour(text: &str) -> Option<u32> {
    let hex = text.strip_prefix('#')?;
    if hex.len() != 6 {
        return None;
    }
    u32::from_str_radix(hex, 16).ok()
}

/// Is this colour dark? Perceived brightness under one half.
pub fn is_dark(rgb: u32) -> bool {
    let (r, g, b) = ((rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255);
    (299 * r + 587 * g + 114 * b) / 1000 < 128
}

/// (accent, background), either may be missing.
pub fn own_colours() -> Option<(Option<u32>, Option<u32>)> {
    let text = fs::read_to_string(own_colours_file()?).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    let get = |k: &str| v[k].as_str().and_then(parse_colour);
    let (accent, bg) = (get("accent"), get("bg"));
    (accent.is_some() || bg.is_some()).then_some((accent, bg))
}

pub fn set_own_colours(colours: &serde_json::Value) -> Result<(), String> {
    let file = own_colours_file().ok_or("LOCALAPPDATA is not set")?;
    let keep = |k: &str| colours[k].as_str().filter(|s| parse_colour(s).is_some()).map(str::to_owned);
    let (accent, bg) = (keep("accent"), keep("bg"));
    if accent.is_none() && bg.is_none() {
        if file.exists() {
            fs::remove_file(&file).map_err(|e| e.to_string())?;
        }
        return Ok(());
    }
    if let Some(dir) = file.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    fs::write(&file, serde_json::json!({ "accent": accent, "bg": bg }).to_string()).map_err(|e| e.to_string())
}

/// Lays the user's colours over a theme preset. The accent seeds the browser's
/// frame, tabs and menus; the background decides light or dark, which is also
/// what websites are told (prefers-color-scheme). Returns true if the look is dark.
pub fn apply_own_colours(preset: &mut crate::launch::Preset, accent: Option<u32>, bg: Option<u32>, theme_is_dark: bool) -> bool {
    let dark = bg.map(is_dark).unwrap_or(theme_is_dark);
    if let Some(seed) = accent.or(bg) {
        // Chromium stores the seed as a signed 32-bit colour with full opacity.
        preset.preferences.insert("browser.theme.user_color2".into(), serde_json::json!((0xFF00_0000u32 | seed) as i32));
    }
    preset.preferences.insert("browser.theme.color_scheme2".into(), serde_json::json!(if dark { 2 } else { 1 }));
    preset.preferences.insert("brave.dark_mode_migrated".into(), serde_json::json!(true));
    preset.local_state.insert("brave.dark_mode".into(), serde_json::json!(if dark { 1 } else { 2 }));
    if let Some(bg) = bg {
        preset.preferences.insert(
            "brave.new_tab_page.background".into(),
            serde_json::json!({ "type": "color", "selected_value": format!("#{bg:06X}"), "random": false }),
        );
    }
    dark
}

/// "fresh", "stale" or "none": the copy's state, for the Settings page.
pub fn describe(official_exe: &Path) -> &'static str {
    match copy_dir().map(|c| state(official_exe, &c)) {
        Some(Copy::Fresh(_)) => "fresh",
        Some(Copy::Stale { .. }) => "stale",
        _ => "none",
    }
}

/// The version folder inside an Application folder: the one with `resources.pak`.
/// Its name is the browser version, e.g. `157.1.99.56`.
pub fn version_folder(application: &Path) -> Option<PathBuf> {
    let mut found: Vec<PathBuf> = fs::read_dir(application)
        .ok()?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.join("resources.pak").is_file())
        .collect();
    // After an update two can exist for a moment; the newest name wins.
    found.sort();
    found.pop()
}

fn version_name(folder: &Path) -> Option<String> {
    folder.file_name().map(|n| n.to_string_lossy().into_owned())
}

#[derive(Debug, PartialEq)]
pub enum Copy {
    /// No copy has been made.
    None,
    /// The copy matches the installed Brave and is patched: use this exe.
    Fresh(PathBuf),
    /// The copy is from another Brave version, or was never patched.
    Stale { copy: String, installed: String },
}

/// A rebrand that died between its two renames leaves the working copy as `Application.old`
/// and no `Application`: put it back. `Application.old` is only ever deleted while
/// `Application` is there.
pub fn recover(copy: &Path) {
    let old = copy.with_file_name("Application.old");
    if !copy.exists() && old.is_dir() {
        let _ = fs::rename(&old, copy);
    }
}

/// What the launcher should do, given the installed Brave and the copy folder.
pub fn state(official_exe: &Path, copy: &Path) -> Copy {
    recover(copy);
    let exe = copy.join("brave.exe");
    // A browser that came with Gamblium, or the only browser there is.
    if copy.join(SHIPPED).is_file() || !official_exe.is_file() {
        return patched_exe(copy).map(Copy::Fresh).unwrap_or(Copy::None);
    }
    let Some(copy_version) = version_folder(copy) else { return Copy::None };
    if !exe.is_file() {
        return Copy::None;
    }
    let installed = official_exe.parent().and_then(version_folder).and_then(|f| version_name(&f)).unwrap_or_default();
    let name = version_name(&copy_version).unwrap_or_default();
    if name == installed && copy_version.join(REPORT).is_file() {
        Copy::Fresh(exe)
    } else {
        Copy::Stale { copy: if copy_version.join(REPORT).is_file() { name } else { format!("{name}, not patched") }, installed }
    }
}

/// Copies everything except Brave's installer, which the copy has no use for.
pub fn copy_all(from: &Path, to: &Path) -> std::io::Result<(usize, u64)> {
    let (mut files, mut bytes) = (0, 0);
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let name = entry.file_name();
        if name.to_string_lossy().eq_ignore_ascii_case("Installer") {
            continue;
        }
        let dest = to.join(&name);
        if entry.file_type()?.is_dir() {
            let (f, b) = copy_all(&entry.path(), &dest)?;
            files += f;
            bytes += b;
        } else {
            bytes += fs::copy(entry.path(), &dest)?;
            files += 1;
        }
    }
    Ok((files, bytes))
}

/// What the copy was made from: the patchers, the branding and the extension's manifest (its
/// version shows in Settings). A copy whose stamp differs is out of date. (Owner, Nov 14 2026:
/// the rebrand must happen by itself; nobody should have to think of running it.)
const STAMP: &str = "gamblium-rebrand-stamp";

pub fn inputs_stamp(home: &Path) -> String {
    use sha2::{Digest, Sha256};
    fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
        for e in fs::read_dir(dir).into_iter().flatten().flatten() {
            let p = e.path();
            let name = e.file_name().to_string_lossy().into_owned();
            // Only what changes the copy: not caches, notes or dot-folders (a checkout has
            // README.md and .pytest_cache, the installed folder may not).
            if name.starts_with('.') || name == "__pycache__" || name.ends_with(".md") || name.ends_with(".pyc") {
                continue;
            }
            if p.is_dir() {
                walk(&p, out);
            } else {
                out.push(p);
            }
        }
    }
    let mut files = Vec::new();
    walk(&home.join("tools").join("rebrand"), &mut files);
    walk(&home.join("branding"), &mut files);
    files.push(home.join("extension").join("manifest.json"));
    files.sort();
    let mut h = Sha256::new();
    for f in files {
        h.update(f.strip_prefix(home).unwrap_or(&f).to_string_lossy().replace('\\', "/").as_bytes());
        h.update(fs::read(&f).unwrap_or_default());
    }
    h.finalize().iter().take(12).map(|b| format!("{b:02x}")).collect()
}

/// The copy should be made again: missing, made for another Brave, or from other inputs. A copy
/// that came inside the package was made when the package was built and is left alone.
pub fn needs_refresh(official_exe: &Path, home: &Path) -> bool {
    let Some(copy) = copy_dir() else { return false };
    recover(&copy);
    if copy.join(SHIPPED).is_file() || !official_exe.is_file() || wants_official() {
        return false;
    }
    match state(official_exe, &copy) {
        Copy::Fresh(_) => fs::read_to_string(copy.join(STAMP)).map(|s| s.trim() != inputs_stamp(home)).unwrap_or(true),
        _ => true,
    }
}

/// Refreshes the copy when it needs it, saying what happened in one line (None: nothing to do).
/// A copy in use is left for the next start, when nothing runs from it.
pub fn refresh_if_needed(official_exe: &Path, home: &Path) -> Option<String> {
    if !needs_refresh(official_exe, home) {
        return None;
    }
    Some(match make(official_exe, home, false) {
        Ok(_) => "rebrand: the copy was made again (its inputs changed)".to_owned(),
        Err(e) if e.contains("in use") => "rebrand: the copy is in use; it is refreshed at the next start".to_owned(),
        Err(e) => format!("rebrand: could not refresh the copy ({e})"),
    })
}

/// Makes or refreshes the copy and patches it. `home` holds `tools/rebrand/`
/// and `branding/`. Returns lines to show.
pub fn make(official_exe: &Path, home: &Path, dry_run: bool) -> Result<Vec<String>, String> {
    let application = official_exe.parent().ok_or("no folder for brave.exe")?;
    let version = version_folder(application).and_then(|f| version_name(&f)).ok_or(format!("{} does not look like Brave's program folder", application.display()))?;
    let dest = copy_dir().ok_or("LOCALAPPDATA is not set")?;
    let script = home.join("tools").join("rebrand").join("rebrand.py");
    let branding = home.join("branding");
    if !script.is_file() || !branding.is_dir() {
        return Err(format!("the rebranding tool is missing (looked for {} and {})", script.display(), branding.display()));
    }
    let mut log = vec![format!("Brave {version} -> {}", dest.display())];
    if dry_run {
        log.push("would copy Brave's program folder (about 1 GB) and put Gamblium's mark and name into the copy".into());
        return Ok(log);
    }
    // The new copy is built and patched beside the old one and swapped in at the end, so a
    // browser still running from the old copy never loses files under it (Nov 14 2026: deleting
    // in place removed ten files, then stopped at chrome.dll, which a running browser held).
    // Windows refuses to rename a folder while a program runs from it: that is the check, made
    // once before the work and again at the swap.
    let staging = dest.with_file_name("Application.new");
    let old = dest.with_file_name("Application.old");
    recover(&dest);
    let _ = fs::remove_dir_all(&staging);
    if dest.exists() {
        let _ = fs::remove_dir_all(&old);
    }
    let busy = |e: std::io::Error| format!("the copy is in use, nothing was changed ({e}). Close every Gamblium window, including test and hidden ones, and run `gamblium rebrand` again");
    if dest.exists() {
        fs::rename(&dest, &old).map_err(busy)?;
        fs::rename(&old, &dest).map_err(|e| format!("could not put the copy back from {}: {e}", old.display()))?;
    }
    let (files, bytes) = copy_all(application, &staging).map_err(|e| {
        let _ = fs::remove_dir_all(&staging);
        format!("copy failed: {e}")
    })?;
    log.push(format!("copied {files} files, {} MB", bytes / (1024 * 1024)));

    let run = Command::new("python")
        .arg(&script)
        .arg(&staging)
        .arg("--branding")
        .arg(&branding)
        .arg("--json")
        .output()
        .map_err(|e| format!("could not run python ({e}). The patcher needs Python 3.10+ with Pillow"))?;
    if !run.status.success() {
        // An unpatched copy must never be used: remove it; the old copy stays as it was.
        let _ = fs::remove_dir_all(&staging);
        let why = match run.status.code() {
            Some(2) => "the patcher refused the folder or its inputs",
            Some(3) => "Brave's artwork has changed and the lion was not found; the patcher needs updating",
            _ => "the patcher failed",
        };
        let tail: String = String::from_utf8_lossy(&run.stderr).lines().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join(" | ");
        return Err(format!("{why}: {tail}"));
    }
    if let Ok(report) = serde_json::from_slice::<serde_json::Value>(&run.stdout) {
        if let (Some(images), Some(strings)) = (report["images_changed"].as_u64(), report["strings_changed"].as_u64()) {
            log.push(format!("patched: {images} images and {strings} interface strings now show Gamblium"));
        }
    }
    // The lions the pack patcher cannot reach: the welcome page's picture and
    // the small drawing compiled into chrome.dll (address-bar chip).
    let extra = home.join("tools").join("rebrand").join("extra.py");
    if extra.is_file() {
        // chrome.dll and brave.exe are patched in a temporary file, then swapped
        // in. Windows refuses the swap while anything holds the file: a running
        // Gamblium, or the virus scanner still reading the fresh copy (seen Nov
        // 13: "Access is denied", and the run still said "done"). So: one more
        // try after a pause, then a loud failure, never a half-patched "done".
        let mut last = String::new();
        let mut ok = false;
        for attempt in 0..3 {
            if attempt > 0 {
                std::thread::sleep(std::time::Duration::from_secs(15));
            }
            match Command::new("python").arg(&extra).arg(&staging).arg("--branding").arg(&branding).arg("--json").output() {
                Ok(run) if run.status.success() => {
                    let report: serde_json::Value = serde_json::from_slice(&run.stdout).unwrap_or_default();
                    let count = |k: &str| report[k].as_array().map(|a| a.len()).unwrap_or(0);
                    log.push(format!("also replaced: {} welcome-page picture(s), {} toolbar drawing(s)", count("welcome"), count("vector")));
                    ok = true;
                    break;
                }
                Ok(run) => last = String::from_utf8_lossy(&run.stderr).lines().last().unwrap_or("unknown error").to_owned(),
                Err(e) => last = e.to_string(),
            }
        }
        if !ok {
            let _ = fs::remove_dir_all(&staging);
            return Err(format!("chrome.dll / brave.exe of the new copy could not be patched ({last}); the old copy is unchanged. Run `gamblium rebrand` again."));
        }
        leftovers_away(&staging);
    }
    let _ = fs::write(staging.join(STAMP), inputs_stamp(home));
    if dest.exists() {
        if let Err(e) = fs::rename(&dest, &old) {
            let _ = fs::remove_dir_all(&staging);
            return Err(busy(e));
        }
    }
    if let Err(e) = fs::rename(&staging, &dest) {
        let _ = fs::rename(&old, &dest);
        let _ = fs::remove_dir_all(&staging);
        return Err(format!("could not move the new copy into place ({e}); the old copy is back"));
    }
    if dest.exists() {
        let _ = fs::remove_dir_all(&old);
    }
    let exe = dest.join("brave.exe");
    match crate::launch::ensure_gpu_preference(&exe, false) {
        Ok(_) => log.push("GPU preference set for the copy".into()),
        Err(e) => log.push(format!("GPU preference for the copy could not be set ({e})")),
    }
    log.push(format!("done. `gamblium launch` now starts {}", exe.display()));
    log.push("after a Brave update, run `gamblium rebrand` again; until then the official Brave is started".into());
    Ok(log)
}

pub fn remove() -> Result<bool, String> {
    let root = copy_dir().and_then(|d| d.parent().map(Path::to_path_buf)).ok_or("LOCALAPPDATA is not set")?;
    if !root.exists() {
        return Ok(false);
    }
    fs::remove_dir_all(&root).map_err(|e| format!("could not remove {}: {e} (close every Gamblium window first)", root.display()))?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("gamblium-test-rebrand-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn a_copy_left_as_application_old_is_put_back() {
        let root = folder("recover");
        let copy = root.join("Application");
        fs::create_dir_all(root.join("Application.old")).unwrap();
        fs::write(root.join("Application.old").join("brave.exe"), "exe").unwrap();
        recover(&copy);
        assert!(copy.join("brave.exe").is_file() && !root.join("Application.old").exists());
        // With a copy in place, an Application.old is left for make() to delete, never moved over it.
        fs::create_dir_all(root.join("Application.old")).unwrap();
        recover(&copy);
        assert!(copy.join("brave.exe").is_file() && root.join("Application.old").is_dir());
        let _ = fs::remove_dir_all(&root);
    }

    fn fake_brave(root: &Path, version: &str, patched: bool) -> PathBuf {
        let v = root.join(version);
        fs::create_dir_all(v.join("Installer")).unwrap();
        fs::write(v.join("resources.pak"), "pak").unwrap();
        fs::write(v.join("Installer").join("setup.exe"), "big").unwrap();
        if patched {
            fs::write(v.join(REPORT), "{}").unwrap();
        }
        fs::write(root.join("brave.exe"), "exe").unwrap();
        root.join("brave.exe")
    }

    #[test]
    fn the_copy_is_used_only_when_it_matches_the_installed_brave_and_is_patched() {
        let root = folder("state");
        let official = fake_brave(&root.join("official"), "157.1.99.56", false);
        let copy = root.join("copy");
        assert_eq!(state(&official, &copy), Copy::None);
        fake_brave(&copy, "157.1.99.56", true);
        assert_eq!(state(&official, &copy), Copy::Fresh(copy.join("brave.exe")));
        // Brave updated itself: the copy is stale.
        fs::remove_dir_all(root.join("official")).unwrap();
        let official = fake_brave(&root.join("official"), "158.1.100.3", false);
        assert_eq!(state(&official, &copy), Copy::Stale { copy: "157.1.99.56".into(), installed: "158.1.100.3".into() });
        // A copy that was never patched is not used either.
        fs::remove_dir_all(&copy).unwrap();
        fake_brave(&copy, "158.1.100.3", false);
        assert!(matches!(state(&official, &copy), Copy::Stale { .. }));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn the_users_colours_decide_light_or_dark() {
        assert_eq!(parse_colour("#1FC98A"), Some(0x1FC98A));
        assert_eq!(parse_colour("1FC98A"), None);
        assert_eq!(parse_colour("#12"), None);
        assert!(is_dark(0x030304));
        assert!(!is_dark(0xEEF0F3));
        let mut p = crate::launch::builtin("lean").unwrap();
        // A light background on a dark theme: the browser turns light and says so to websites.
        assert!(!apply_own_colours(&mut p, Some(0x8C1C3A), Some(0xF3F1E7), true));
        assert_eq!(p.preferences["browser.theme.color_scheme2"], 1);
        assert_eq!(p.local_state["brave.dark_mode"], 2);
        assert_eq!(p.preferences["browser.theme.user_color2"], (0xFF8C1C3Au32) as i32);
        assert_eq!(p.preferences["brave.new_tab_page.background"]["selected_value"], "#F3F1E7");
        // Only an accent: the theme's own light or dark stands.
        let mut p = crate::launch::builtin("lean").unwrap();
        assert!(apply_own_colours(&mut p, Some(0x1FC98A), None, true));
        assert_eq!(p.preferences["browser.theme.color_scheme2"], 2);
    }

    #[test]
    fn the_copy_leaves_out_the_installer() {
        let root = folder("copy");
        fake_brave(&root.join("from"), "157.1.99.56", false);
        let (files, _) = copy_all(&root.join("from"), &root.join("to")).unwrap();
        assert_eq!(files, 2); // brave.exe and resources.pak
        assert!(!root.join("to").join("157.1.99.56").join("Installer").exists());
        assert_eq!(version_folder(&root.join("to")).and_then(|f| version_name(&f)).as_deref(), Some("157.1.99.56"));
        fs::remove_dir_all(&root).unwrap();
    }
}

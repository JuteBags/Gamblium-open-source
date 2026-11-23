//! New extension code before the window opens (owner, Nov 16 2026: after an install, a profile
//! that was closed opened with pages drawn by the old code, closed once or twice and came back
//! right).
//!
//! The browser keeps an extension's background code from a profile's first start; the extension
//! sees that the code on disk is newer (code-stamp.js) and reloads itself, which takes effect at
//! the browser's next start, so it restarts the browser. Here that is done before the person's
//! window: the profile is started hidden for a few seconds, the extension reloads itself there
//! (the helper does not restart this hidden browser: the `gamblium-prestart` mark says so), and
//! it is closed; the real start then runs the new code from the first page.
//!
//! The profile's saved tabs are copied aside first and put back after, so the hidden start can
//! never change what the window brings back.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// Written by the helper when the extension runs the code that is on disk.
pub const RUNNING: &str = "gamblium-code-stamp";
/// The hidden start's mark: the helper answers a restart without restarting.
pub const PRESTART: &str = "gamblium-prestart";
/// Written by the helper when the extension asked for its restart during the hidden start.
pub const RELOADED: &str = "gamblium-prestart-reloaded";
/// The stamp a hidden start was last made for: tried once per install, never in a loop.
const TRIED: &str = "gamblium-prestart-tried";

/// The stamp in an extension folder's code-stamp.js.
pub fn installed_stamp(ext: &Path) -> Option<String> {
    let text = fs::read_to_string(ext.join("code-stamp.js")).ok()?;
    let at = text.find("CODE_STAMP")?;
    let rest = &text[at..];
    let a = rest.find('"')? + 1;
    let b = rest[a..].find('"')? + a;
    Some(rest[a..b].to_owned()).filter(|s| !s.is_empty())
}

fn read(p: &Path) -> Option<String> {
    fs::read_to_string(p).ok().map(|t| t.trim().to_owned()).filter(|t| !t.is_empty())
}

/// Should this profile get a hidden start first? Only when it has run before (its extension
/// state exists), runs other code than `stamp`, and was not tried for this stamp already.
pub fn wanted(profile: &Path, stamp: &str) -> bool {
    let ran_before = profile.join("Default").join("Local Extension Settings").is_dir();
    ran_before && read(&profile.join(RUNNING)).as_deref() != Some(stamp) && read(&profile.join(TRIED)).as_deref() != Some(stamp)
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::create_dir_all(to)?;
    for e in fs::read_dir(from)?.flatten() {
        let p = e.path();
        let t = to.join(e.file_name());
        if p.is_dir() {
            copy_dir(&p, &t)?;
        } else {
            fs::copy(&p, &t)?;
        }
    }
    Ok(())
}

/// The hidden start. `args` are the real start's switches (extension, profile folder). Returns
/// what happened, for the launcher's output; never an error that stops the real start.
pub fn refresh(browser: &Path, profile: &Path, args: &[String], stamp: &str) -> String {
    let _ = fs::write(profile.join(TRIED), stamp);
    // The saved tabs, aside.
    // Both folders: this Brave keeps its windows in Sessions_Encrypted too, and the hidden start
    // rewrote it (owner, Nov 16 2026).
    let kept: Vec<(PathBuf, PathBuf, bool)> = ["Sessions", "Sessions_Encrypted"]
        .iter()
        .map(|n| {
            let from = profile.join("Default").join(n);
            let had = from.is_dir();
            (from, profile.join(format!("gamblium-prestart-{n}")), had)
        })
        .collect();
    for (from, aside, had) in &kept {
        let _ = fs::remove_dir_all(aside);
        if *had && copy_dir(from, aside).is_err() {
            for (_, a, _) in &kept {
                let _ = fs::remove_dir_all(a);
            }
            return "new extension code: not prepared (the saved tabs could not be copied aside); the extension restarts the window itself".into();
        }
    }
    let _ = fs::write(profile.join(PRESTART), stamp);
    let _ = fs::remove_file(profile.join(RELOADED));
    let mut all: Vec<String> = args.iter().filter(|a| a.starts_with("--") && !a.starts_with("--remote-debugging-port") && !a.starts_with("--start-maximized")).cloned().collect();
    all.extend(["--headless=new".into(), "--no-first-run".into(), "about:blank".into()]);
    let started = Instant::now();
    let child = std::process::Command::new(browser)
        .args(&all)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
    let outcome = match child {
        Err(e) => format!("new extension code: the hidden start failed ({e}); the extension restarts the window itself"),
        Ok(mut child) => {
            // The extension asks for its restart (old code) or says it runs the new code.
            let until = Instant::now() + Duration::from_secs(15);
            let mut how = "timed out";
            while Instant::now() < until && matches!(child.try_wait(), Ok(None)) {
                if profile.join(RELOADED).is_file() {
                    how = "reloaded";
                    // runtime.reload() follows the restart request at once; let it land.
                    std::thread::sleep(Duration::from_millis(1500));
                    break;
                }
                if read(&profile.join(RUNNING)).as_deref() == Some(stamp) {
                    how = "already new";
                    break;
                }
                std::thread::sleep(Duration::from_millis(200));
            }
            crate::procs::kill_tree(child.id());
            let _ = child.wait();
            let _ = crate::launch::mark_clean_exit(profile);
            format!("new extension code: prepared in a hidden start ({how}, {:.1} s)", started.elapsed().as_secs_f32())
        }
    };
    // The saved tabs, back as they were.
    for (from, aside, had) in &kept {
        if *had {
            let _ = fs::remove_dir_all(from);
            let _ = copy_dir(aside, from);
        }
        let _ = fs::remove_dir_all(aside);
    }
    let _ = fs::remove_file(profile.join(PRESTART));
    let _ = fs::remove_file(profile.join(RELOADED));
    let _ = fs::remove_file(profile.join("DevToolsActivePort"));
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stamps_are_read_and_compared() {
        let dir = std::env::temp_dir().join(format!("gamblium-codestamp-{}", std::process::id()));
        let ext = dir.join("ext");
        fs::create_dir_all(&ext).unwrap();
        fs::write(ext.join("code-stamp.js"), "export const CODE_STAMP = \"abc123\";\n").unwrap();
        assert_eq!(installed_stamp(&ext).as_deref(), Some("abc123"));
        let prof = dir.join("prof");
        fs::create_dir_all(&prof).unwrap();
        assert!(!wanted(&prof, "abc123"), "a profile that never ran needs none");
        fs::create_dir_all(prof.join("Default").join("Local Extension Settings")).unwrap();
        assert!(wanted(&prof, "abc123"));
        fs::write(prof.join(RUNNING), "abc123").unwrap();
        assert!(!wanted(&prof, "abc123"));
        fs::write(prof.join(RUNNING), "old").unwrap();
        fs::write(prof.join(TRIED), "abc123").unwrap();
        assert!(!wanted(&prof, "abc123"), "tried once per stamp");
        let _ = fs::remove_dir_all(&dir);
    }
}

//! The program the Gamblium shortcuts point at. It has no window and no
//! console: it starts `gamblium.exe launch` on Gamblium's own profile folder
//! and exits. Anything given on its command line is passed along.

#![windows_subsystem = "windows"]

use std::path::PathBuf;
use std::process::Command;

// No note on screen while a start takes long (owner, Nov 16 2026: "it always shows up, it doesn't
// look good; make it background"): the start happens quietly, as before review 2's 1.21.
fn main() {
    start();
}

/// `Gamblium\updating` set within 30 minutes by an updater still running: an update is being
/// installed (pack.rs set_updating; a killed updater's flag is ignored, review 10, H11).
fn updating(local: &std::ffi::OsStr) -> bool {
    let f = PathBuf::from(local).join("Gamblium").join("updating");
    let fresh = std::fs::metadata(&f).and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|e| e.as_secs() < 1800);
    fresh && std::fs::read_to_string(&f).ok().and_then(|t| t.trim().parse::<u32>().ok()).is_none_or(pid_alive)
}

/// The process with this id is still running (the updater that set the flag).
#[cfg(windows)]
fn pid_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
    use windows_sys::Win32::System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            return false;
        }
        let mut code = 0u32;
        let ok = GetExitCodeProcess(h, &mut code) != 0;
        CloseHandle(h);
        ok && code == STILL_ACTIVE as u32
    }
}
#[cfg(not(windows))]
fn pid_alive(_pid: u32) -> bool {
    true
}

fn start() {
    let Ok(me) = std::env::current_exe() else { return };
    let Some(dir) = me.parent() else { return };
    let Some(local) = std::env::var_os("LOCALAPPDATA") else { return };
    let profile = PathBuf::from(&local).join("Gamblium").join("User Data");
    // An update being installed: wait for it, so the browser is not
    // started from files the installer is replacing (review 9, G30). At most 10 minutes.
    for _ in 0..1200 {
        if !updating(&local) {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
    }

    let extra: Vec<_> = std::env::args_os().skip(1).collect();
    // A clicked magnet link (Windows passes it as the only argument) or a
    // .torrent file goes to the downloader, which then shows its page; a PDF
    // file opened with Gamblium goes to Gamblium PDF.
    if let [only] = extra.as_slice() {
        let text = only.to_string_lossy().to_ascii_lowercase();
        let pdf = text.trim_matches('"').ends_with(".pdf") && std::path::Path::new(only).is_file();
        if text.starts_with("magnet:") || text.ends_with(".torrent") || pdf {
            let mut cmd = Command::new(dir.join("gamblium.exe"));
            cmd.arg("open").arg(only);
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                cmd.creation_flags(0x0800_0000);
            }
            let _ = cmd.spawn();
            return;
        }
    }
    // A downloaded update is installed first while Gamblium is closed; the updater then starts
    // Gamblium itself (exit 0). Anything else (3: nothing ready) starts it as usual.
    if extra.is_empty() {
        let mut up = Command::new(dir.join("gamblium.exe"));
        up.args(["update", "--apply-if-ready"]);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            up.creation_flags(0x0800_0000);
        }
        if up.status().is_ok_and(|s| s.success()) {
            return;
        }
    }
    // The icon with nothing else (owner, Nov 16 2026): Gamblium starts the way Settings says, a
    // neutral window that belongs to no session, or the session closed last. Only when that is
    // the owner's own Gamblium (or the step fails) does this start it, with a New Tab page in
    // front of the tabs it brings back. `--main` starts the owner's own Gamblium directly.
    let main_only = extra.len() == 1 && extra[0] == "--main";
    let mut extra = extra;
    if extra.is_empty() || main_only {
        if !main_only {
            let mut begin = Command::new(dir.join("gamblium.exe"));
            begin.args(["cli", "begin"]);
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                begin.creation_flags(0x0800_0000);
            }
            if let Ok(out) = begin.output() {
                let said = String::from_utf8_lossy(&out.stdout);
                if out.status.success() && !said.contains("\"launch\": \"default\"") && !said.contains("\"launch\":\"default\"") {
                    return;
                }
            }
        }
        // Nothing on top of the windows it brings back: an address here opened a New Tab window
        // of its own at every start (owner, Nov 16 2026). With nothing to bring back the browser
        // opens its New Tab page anyway.
        extra = vec![];
    }
    let mut cmd = Command::new(dir.join("gamblium.exe"));
    cmd.arg("launch").arg("--user-data-dir").arg(profile);
    // The starting look, until the owner picks a scheme. A shortcut that passes
    // its own --theme wins.
    if !extra.iter().any(|a| a == "--theme") {
        cmd.arg("--theme").arg("moon-dark").arg("--auto-dark");
    }
    cmd.args(extra);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    // Waited for (it ends once the browser is started), so the note stays while a packed profile
    // is unpacked.
    let _ = cmd.status();
}

//! The program the Gamblium shortcuts point at. It has no window and no
//! console: it starts `gamblium.exe launch` on Gamblium's own profile folder
//! and exits. Anything given on its command line is passed along.

#![windows_subsystem = "windows"]

use std::path::PathBuf;
use std::process::Command;

fn main() {
    let Ok(me) = std::env::current_exe() else { return };
    let Some(dir) = me.parent() else { return };
    let Some(local) = std::env::var_os("LOCALAPPDATA") else { return };
    let profile = PathBuf::from(local).join("Gamblium").join("User Data");

    let extra: Vec<_> = std::env::args_os().skip(1).collect();
    // A clicked magnet link (Windows passes it as the only argument) or a
    // .torrent file goes to the downloader, which then shows its page.
    if let [only] = extra.as_slice() {
        let text = only.to_string_lossy().to_ascii_lowercase();
        if text.starts_with("magnet:") || text.ends_with(".torrent") {
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
    let _ = cmd.spawn();
}

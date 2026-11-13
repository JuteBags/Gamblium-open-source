//! `gamblium-cli`: named browser sessions from the command line. It is the
//! `cli` command of `gamblium.exe` under a name of its own, so that typing
//! `gamblium-cli` in a terminal works after `gamblium install` (which puts
//! the folder on the user's PATH).

use std::process::Command;

fn main() {
    let gamblium = std::env::current_exe().ok().and_then(|me| me.parent().map(|d| d.join("gamblium.exe")));
    let Some(gamblium) = gamblium.filter(|g| g.is_file()) else {
        eprintln!("gamblium-cli: gamblium.exe is not beside this program. Run `gamblium install` again.");
        std::process::exit(2);
    };
    // Our own output handles are not for the programs further down. The
    // `cli` command gets copies of them (that is how a program is started);
    // without this it also inherits the originals, cannot know about them,
    // and passes them on to the browser, which then holds the caller's pipe:
    // `gamblium-cli create x | tail` never came back.
    keep_our_output_to_ourselves();
    let status = Command::new(gamblium).arg("cli").args(std::env::args_os().skip(1)).status();
    match status {
        Ok(s) => std::process::exit(s.code().unwrap_or(1)),
        Err(e) => {
            eprintln!("gamblium-cli: {e}");
            std::process::exit(2);
        }
    }
}

fn keep_our_output_to_ourselves() {
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::Foundation::{SetHandleInformation, HANDLE_FLAG_INHERIT};
        use windows_sys::Win32::System::Console::{GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE};
        for id in [STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE] {
            let h = GetStdHandle(id);
            if !h.is_null() {
                SetHandleInformation(h, HANDLE_FLAG_INHERIT, 0);
            }
        }
    }
}

//! `gamblium install`: puts Gamblium in its own folder for the current user,
//! registers the native host and creates shortcuts. No admin rights, nothing
//! outside the user's own folders, and `--remove` undoes it.
//!
//! Layout under %LOCALAPPDATA%\Gamblium:
//!   app\gamblium.exe        the command-line tool and native host
//!   app\gamblium-app.exe    windowless starter the shortcuts point at
//!   app\gamblium-cli.exe    named sessions from a terminal (the folder is put on the user's PATH)
//!   app\extension\, app\presets\, app\theme\, app\gamblium.ico
//!   User Data\              Gamblium's own browser profile (not Brave's)

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

pub fn base_dir() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join("Gamblium"))
}

/// Gamblium's own profile folder, so it never changes the user's Brave profile.
pub fn profile_dir() -> Option<PathBuf> {
    base_dir().map(|d| d.join("User Data"))
}

/// Files that are part of the source tree but not of an installed copy.
fn skip(name: &str) -> bool {
    name.ends_with(".test.mjs") || name == "Cached Theme.pak" || name == "README.md"
}

/// Copies a folder tree. Returns the number of files written.
pub fn copy_tree(from: &Path, to: &Path) -> std::io::Result<usize> {
    let mut n = 0;
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let name = entry.file_name();
        if skip(&name.to_string_lossy()) {
            continue;
        }
        let dest = to.join(&name);
        if entry.file_type()?.is_dir() {
            n += copy_tree(&entry.path(), &dest)?;
        } else {
            fs::copy(entry.path(), &dest)?;
            n += 1;
        }
    }
    Ok(n)
}

fn powershell(script: &str) -> Result<String, String> {
    let out = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_owned());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_owned())
}

/// PowerShell single-quoted string.
fn ps_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// The user's Start-menu Programs folder and Desktop (which may live in OneDrive).
fn shortcut_folders() -> Result<Vec<PathBuf>, String> {
    let out = powershell("[Environment]::GetFolderPath('Programs'); [Environment]::GetFolderPath('Desktop')")?;
    Ok(out.lines().map(|l| PathBuf::from(l.trim())).filter(|p| p.is_dir()).collect())
}

fn shortcut_script(lnk: &Path, target: &Path, icon: &Path, workdir: &Path) -> String {
    format!(
        "$s = (New-Object -ComObject WScript.Shell).CreateShortcut({}); $s.TargetPath = {}; $s.IconLocation = {}; \
         $s.WorkingDirectory = {}; $s.Description = 'Gamblium: a lean browser built on Brave'; $s.Save()",
        ps_quote(&lnk.to_string_lossy()),
        ps_quote(&target.to_string_lossy()),
        ps_quote(&icon.to_string_lossy()),
        ps_quote(&workdir.to_string_lossy()),
    )
}

pub fn install(home: &Path, dry_run: bool) -> Result<Vec<String>, String> {
    let mut log = Vec::new();
    let base = base_dir().ok_or("LOCALAPPDATA is not set")?;
    let app = base.join("app");
    let me = std::env::current_exe().map_err(|e| e.to_string())?;
    let my_dir = me.parent().ok_or("no folder for the running program")?;
    let starter = my_dir.join("gamblium-app.exe");
    if !starter.is_file() {
        return Err(format!("{} is missing; build it first (cargo build --release)", starter.display()));
    }
    let io = |e: std::io::Error| e.to_string();

    log.push(format!("install folder: {}", app.display()));
    if !dry_run {
        fs::create_dir_all(&app).map_err(io)?;
        // The downloader is a separate program; an older build may not have it.
        let downloader = my_dir.join("gamblium-dl.exe");
        let cli = my_dir.join("gamblium-cli.exe");
        for exe in [&me, &starter, &downloader, &cli] {
            if !exe.is_file() {
                continue;
            }
            let dest = app.join(exe.file_name().unwrap());
            if exe.as_path() != dest {
                fs::copy(exe, &dest).map_err(|e| format!("{}: {e} (is Gamblium running?)", dest.display()))?;
            }
        }
    }
    // tools/rebrand and branding are what `gamblium rebrand` needs.
    for dir in ["extension", "presets", "theme", "branding", "tools/rebrand"] {
        let from = home.join(dir);
        if !from.is_dir() {
            continue;
        }
        let to = app.join(dir);
        if dry_run {
            log.push(format!("would copy {dir}\\"));
        } else {
            // Replace the old copy so files removed from the source do not linger.
            if to.is_dir() {
                fs::remove_dir_all(&to).map_err(io)?;
            }
            log.push(format!("copied {dir}\\ ({} files)", copy_tree(&from, &to).map_err(io)?));
        }
    }
    // The browser that came inside the package becomes Gamblium's own.
    let shipped = my_dir.join("browser").join("Application");
    if crate::rebrand::patched_exe(&shipped).is_some() && my_dir != app.as_path() {
        let dest = crate::rebrand::copy_dir().ok_or("LOCALAPPDATA is not set")?;
        if dry_run {
            log.push(format!("would copy the browser to {}", dest.display()));
        } else {
            if dest.is_dir() {
                fs::remove_dir_all(&dest).map_err(|e| format!("{}: {e} (is Gamblium running?)", dest.display()))?;
            }
            let (files, bytes) = crate::rebrand::copy_all(&shipped, &dest).map_err(io)?;
            fs::write(dest.join(crate::rebrand::SHIPPED), "This browser came inside the Gamblium package.\n").map_err(io)?;
            log.push(format!("browser: copied ({files} files, {} MB)", bytes / 1_048_576));
        }
    }
    let icon_src = home.join("branding").join("gamblium.ico");
    let icon = app.join("gamblium.ico");
    if icon_src.is_file() && !dry_run {
        fs::copy(&icon_src, &icon).map_err(io)?;
    }

    for folder in shortcut_folders()? {
        let lnk = folder.join("Gamblium.lnk");
        if dry_run {
            log.push(format!("would create shortcut {}", lnk.display()));
        } else {
            powershell(&shortcut_script(&lnk, &app.join("gamblium-app.exe"), &icon, &app))?;
            log.push(format!("shortcut: {}", lnk.display()));
        }
    }

    if dry_run {
        log.push("would register the helper for the Gamblium extension".into());
    } else {
        let out = Command::new(app.join("gamblium.exe")).arg("install-host").output().map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_owned());
        }
        log.push("helper registered for the Gamblium extension".into());
    }
    if dry_run {
        log.push("would make Gamblium the program for magnet links".into());
    } else {
        log.push(take_magnet_links(&app.join("gamblium-app.exe"))?);
    }
    if dry_run {
        log.push("would put the install folder on your PATH, so `gamblium-cli` works in any terminal".into());
    } else {
        log.push(match on_path(&app, true) {
            Ok(true) => "PATH: the install folder was added, so `gamblium-cli` and `gamblium` work in any new terminal".into(),
            Ok(false) => "PATH: the install folder is already on it".into(),
            Err(e) => format!("PATH: could not add the install folder ({e}); `gamblium-cli` works by its full path"),
        });
    }
    if let Some(profile) = profile_dir() {
        log.push(format!("Gamblium's own profile will live in {}", profile.display()));
    }
    Ok(log)
}

/// A PATH value with `dir` added at the end or taken out. None if nothing
/// changes. Other entries are left exactly as written (`%NAME%` included).
pub fn path_with(current: &str, dir: &str, add: bool) -> Option<String> {
    let same = |entry: &str| entry.trim().trim_end_matches('\\').eq_ignore_ascii_case(dir.trim_end_matches('\\'));
    let entries: Vec<&str> = current.split(';').filter(|e| !e.trim().is_empty()).collect();
    let has = entries.iter().any(|e| same(e));
    if add == has {
        return None;
    }
    let mut kept: Vec<&str> = entries.into_iter().filter(|e| !same(e)).collect();
    if add {
        kept.push(dir);
    }
    Some(kept.join(";"))
}

/// Adds the install folder to this user's PATH, or takes it out. Only the
/// user's own PATH (HKCU\Environment) is touched, its kind is kept, and
/// Windows is told, so terminals opened afterwards see it. True if changed.
fn on_path(app: &Path, add: bool) -> Result<bool, String> {
    let dir = app.to_string_lossy();
    // Read without expanding, so entries like %USERPROFILE%\bin stay as they are.
    let read = "$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true); \
                $k.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)";
    let current = powershell(read)?;
    let Some(new) = path_with(&current, &dir, add) else { return Ok(false) };
    let write = format!(
        "$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true); \
         $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString; \
         if ($k.GetValueNames() -contains 'Path') {{ $kind = $k.GetValueKind('Path') }}; \
         $k.SetValue('Path', {}, $kind); \
         [Environment]::SetEnvironmentVariable('GAMBLIUM_PATH_REFRESH', $null, 'User')",
        ps_quote(&new)
    );
    powershell(&write)?;
    Ok(true)
}

const MAGNET_KEY: &str = r"HKCU\Software\Classes\magnet";

fn magnet_before_file() -> Option<PathBuf> {
    base_dir().map(|d| d.join("magnet-before.txt"))
}

fn reg(args: &[&str]) -> Result<String, String> {
    let out = Command::new("reg").args(args).output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_owned())
    }
}

/// The command in `reg query ... /ve` output: the text after "REG_SZ".
pub fn reg_default_value(output: &str) -> Option<String> {
    let line = output.lines().find(|l| l.contains("REG_SZ"))?;
    let value = line.split("REG_SZ").nth(1)?.trim();
    (!value.is_empty()).then(|| value.to_owned())
}

/// The registry command for a clicked magnet link.
pub fn magnet_command(starter: &Path) -> String {
    format!("\"{}\" \"%1\"", starter.display())
}

/// Makes Gamblium the program Windows starts for `magnet:` links, for this
/// user only. Whatever held them before is written down once, so that
/// `gamblium install --remove` can give them back.
fn take_magnet_links(starter: &Path) -> Result<String, String> {
    let command_key = format!(r"{MAGNET_KEY}\shell\open\command");
    let ours = magnet_command(starter);
    let before = reg(&["query", &command_key, "/ve"]).ok().and_then(|o| reg_default_value(&o));
    if before.as_deref() == Some(ours.as_str()) {
        return Ok("magnet links already open in Gamblium".into());
    }
    if let (Some(file), Some(cmd)) = (magnet_before_file(), &before) {
        if !file.exists() {
            fs::write(&file, cmd).map_err(|e| e.to_string())?;
        }
    }
    reg(&["add", MAGNET_KEY, "/ve", "/t", "REG_SZ", "/d", "URL:Magnet link", "/f"])?;
    reg(&["add", MAGNET_KEY, "/v", "URL Protocol", "/t", "REG_SZ", "/d", "", "/f"])?;
    reg(&["add", &command_key, "/ve", "/t", "REG_SZ", "/d", &ours, "/f"])?;
    Ok(match before {
        Some(cmd) => format!("magnet links now open in Gamblium (before: {cmd}; `gamblium install --remove` gives them back)"),
        None => "magnet links now open in Gamblium".into(),
    })
}

fn give_back_magnet_links() -> String {
    let command_key = format!(r"{MAGNET_KEY}\shell\open\command");
    let before = magnet_before_file().and_then(|f| fs::read_to_string(f).ok()).filter(|c| !c.trim().is_empty());
    let done = match &before {
        Some(cmd) => reg(&["add", &command_key, "/ve", "/t", "REG_SZ", "/d", cmd.trim(), "/f"]).map(|_| format!("magnet links given back to: {}", cmd.trim())),
        None => reg(&["delete", MAGNET_KEY, "/f"]).map(|_| "magnet links are no longer Gamblium's".to_owned()),
    };
    if let Some(f) = magnet_before_file() {
        let _ = fs::remove_file(f);
    }
    done.unwrap_or_else(|e| format!("magnet links: {e}"))
}

/// Removes the program, the shortcuts and the helper registration. The
/// profile folder is kept: it holds the user's own data.
pub fn remove(dry_run: bool) -> Result<Vec<String>, String> {
    let mut log = Vec::new();
    let base = base_dir().ok_or("LOCALAPPDATA is not set")?;
    for folder in shortcut_folders()? {
        let lnk = folder.join("Gamblium.lnk");
        if lnk.is_file() {
            if !dry_run {
                fs::remove_file(&lnk).map_err(|e| e.to_string())?;
            }
            log.push(format!("removed shortcut {}", lnk.display()));
        }
    }
    if !dry_run {
        crate::host::install(crate::host::EXTENSION_ID, true)?;
    }
    log.push("helper registration removed".into());
    if dry_run {
        log.push("would give magnet links back".into());
    } else {
        log.push(give_back_magnet_links());
        if let Ok(true) = on_path(&base.join("app"), false) {
            log.push("PATH: the install folder was taken out".into());
        }
    }
    let app = base.join("app");
    if app.is_dir() {
        if !dry_run {
            // The running program cannot delete itself on Windows; everything else goes.
            let me = std::env::current_exe().ok();
            for entry in fs::read_dir(&app).map_err(|e| e.to_string())?.flatten() {
                let p = entry.path();
                if Some(&p) == me.as_ref() {
                    continue;
                }
                let _ = if p.is_dir() { fs::remove_dir_all(&p) } else { fs::remove_file(&p) };
            }
        }
        log.push(format!("removed program files in {}", app.display()));
    }
    log.push(format!("kept your profile in {}", base.join("User Data").display()));
    Ok(log)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copy_tree_copies_nested_files_and_leaves_out_tests_and_caches() {
        let root = std::env::temp_dir().join(format!("gamblium-test-install-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let from = root.join("from");
        fs::create_dir_all(from.join("ui")).unwrap();
        for (name, body) in [("manifest.json", "{}"), ("rules.js", "x"), ("rules.test.mjs", "t"), ("ui/page.html", "p"), ("Cached Theme.pak", "c")] {
            fs::write(from.join(name), body).unwrap();
        }
        let to = root.join("to");
        assert_eq!(copy_tree(&from, &to).unwrap(), 3);
        assert!(to.join("manifest.json").is_file() && to.join("ui").join("page.html").is_file());
        assert!(!to.join("rules.test.mjs").exists() && !to.join("Cached Theme.pak").exists());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn path_gains_and_loses_only_our_folder() {
        let app = r"C:\Users\x\AppData\Local\Gamblium\app";
        // Added at the end; the other entries stay as written.
        assert_eq!(path_with(r"%USERPROFILE%\bin;C:\tools", app, true).unwrap(), format!(r"%USERPROFILE%\bin;C:\tools;{app}"));
        assert_eq!(path_with("", app, true).unwrap(), app);
        // Already there, in another case or with a trailing slash or stray semicolons: nothing to do.
        assert_eq!(path_with(&format!(r"C:\tools;;{}\;", app.to_uppercase()), app, true), None);
        // Taken out again, and only ours.
        assert_eq!(path_with(&format!(r"C:\tools;{app};D:\x"), app, false).unwrap(), r"C:\tools;D:\x");
        assert_eq!(path_with(r"C:\tools", app, false), None);
        // A folder that merely starts the same way is somebody else's.
        assert_eq!(path_with(&format!(r"{app}2"), app, false), None);
    }

    #[test]
    fn shortcut_script_quotes_paths_with_apostrophes() {
        let s = shortcut_script(
            Path::new(r"C:\Users\O'Neil\Desktop\Gamblium.lnk"),
            Path::new(r"C:\a\gamblium-app.exe"),
            Path::new(r"C:\a\gamblium.ico"),
            Path::new(r"C:\a"),
        );
        assert!(s.contains(r"CreateShortcut('C:\Users\O''Neil\Desktop\Gamblium.lnk')"));
        assert!(s.contains(r"$s.TargetPath = 'C:\a\gamblium-app.exe'"));
        assert_eq!(magnet_command(Path::new(r"C:\a\gamblium-app.exe")), r#""C:\a\gamblium-app.exe" "%1""#);
        let out = "\r\nHKEY_CURRENT_USER\\Software\\Classes\\magnet\\shell\\open\\command\r\n    (Default)    REG_SZ    \"C:\\x\\fdm.exe\" \"%1\"\r\n\r\n";
        assert_eq!(reg_default_value(out).as_deref(), Some(r#""C:\x\fdm.exe" "%1""#));
        assert_eq!(reg_default_value("ERROR: The system was unable to find the specified registry key or value."), None);
    }
}

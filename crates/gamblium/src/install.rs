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
use std::io;
use std::path::{Path, PathBuf};

/// The file in the extension that names its code (`export const CODE_STAMP = "...";`).
pub const CODE_STAMP_FILE: &str = "code-stamp.js";

/// Writes a fingerprint of the installed extension's files into its code-stamp.js.
///
/// The browser keeps an extension's background code from a profile's first start and runs that
/// copy ever after: new files, a new version number and restarts do not replace it (measured:
/// files A, B, C over four starts ran A, A, B, B; the owner's profile ran 1.0.0-era code under
/// 1.0.5, Nov 14 2026). The background code compares the stamp it was built with against the
/// file on disk and, when they differ, asks the browser to reload the extension once, which
/// registers the code on disk (checked: the next start ran the new code). The repository's own
/// copy says "dev" and never asks.
pub fn write_code_stamp(ext: &Path) -> io::Result<String> {
    use sha2::{Digest, Sha256};
    fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
        let Ok(rd) = fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                walk(&p, out);
            } else {
                out.push(p);
            }
        }
    }
    let mut files = Vec::new();
    walk(ext, &mut files);
    files.retain(|f| f.file_name().is_none_or(|n| n != CODE_STAMP_FILE));
    files.sort();
    let mut h = Sha256::new();
    for f in &files {
        h.update(f.strip_prefix(ext).unwrap_or(f).to_string_lossy().as_bytes());
        h.update([0]);
        h.update(fs::read(f)?);
    }
    let stamp: String = h.finalize().iter().take(8).map(|b| format!("{b:02x}")).collect();
    fs::write(
        ext.join(CODE_STAMP_FILE),
        format!("// Written by `gamblium install`: a fingerprint of this extension's files (install.rs, write_code_stamp).\nexport const CODE_STAMP = \"{stamp}\";\n"),
    )?;
    Ok(stamp)
}
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
/// Copies a program over the installed one. A running program cannot be overwritten on Windows,
/// but it can be renamed: a download or torrent still running keeps the old file under
/// `<name>.old-<n>`, and the next install removes those once nothing holds them.
pub fn replace_program(from: &Path, to: &Path) -> std::io::Result<()> {
    let name = to.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    if let Some(dir) = to.parent() {
        for e in fs::read_dir(dir).into_iter().flatten().flatten() {
            if e.file_name().to_string_lossy().starts_with(&format!("{name}.old-")) {
                let _ = fs::remove_file(e.path());
            }
        }
    }
    match fs::copy(from, to) {
        Ok(_) => Ok(()),
        Err(first) => {
            let aside = (0..100).map(|n| to.with_file_name(format!("{name}.old-{n}"))).find(|p| !p.exists()).ok_or(first)?;
            fs::rename(to, &aside)?;
            fs::copy(from, to).map(|_| ()).inspect_err(|_| {
                let _ = fs::rename(&aside, to); // put the old one back rather than leave none
            })
        }
    }
}

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
        // The floating lyrics window (issue #242), started by the helper.
        let lyrics = my_dir.join("gamblium-lyrics.exe");
        for exe in [&me, &starter, &downloader, &cli, &lyrics] {
            if !exe.is_file() {
                continue;
            }
            let dest = app.join(exe.file_name().unwrap());
            if exe.as_path() != dest {
                replace_program(exe, &dest).map_err(|e| format!("{}: {e} (is Gamblium running?)", dest.display()))?;
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
            // Copied whole and stamped beside the old copy, then put in its place in one step: a
            // running browser that looked in the middle of a copy saw the repository's "dev"
            // stamp and half the files, and restarted into that (Nov 15 2026).
            let staged = app.join(format!("{}.new", dir.replace('/', "-")));
            if staged.is_dir() {
                fs::remove_dir_all(&staged).map_err(io)?;
            }
            let files = copy_tree(&from, &staged).map_err(io)?;
            if dir == "extension" {
                write_code_stamp(&staged).map_err(io)?;
            }
            // Replace the old copy so files removed from the source do not linger: the old one is
            // renamed aside first, the new one renamed in, and only then the old one deleted. A
            // file held open (a running browser, a virus check) left it half-deleted before
            // (review 2, 1.17); now the old copy stays whole or is put back.
            if let Some(parent) = to.parent() {
                fs::create_dir_all(parent).map_err(io)?;
            }
            let mut old = app.join(format!("{}.old", dir.replace('/', "-")));
            if old.is_dir() && fs::remove_dir_all(&old).is_err() {
                // A leftover still held open: this install sets its old copy aside under another name
                // (review 9, G25: every later install failed).
                old = app.join(format!("{}.old{}", dir.replace('/', "-"), std::process::id()));
            }
            let had_old = to.is_dir();
            if had_old {
                fs::rename(&to, &old).map_err(io)?;
            }
            if let Err(e) = fs::rename(&staged, &to) {
                if had_old {
                    let _ = fs::rename(&old, &to);
                }
                return Err(io(e));
            }
            if had_old {
                // Files still open inside it stay until the next install; the new copy is in place.
                let _ = fs::remove_dir_all(&old);
            }
            log.push(format!("copied {dir}\\ ({files} files)"));
        }
    }
    // The browser that came inside the package becomes Gamblium's own.
    let shipped = my_dir.join("browser").join("Application");
    if crate::rebrand::patched_exe(&shipped).is_some() && my_dir != app.as_path() {
        let dest = crate::rebrand::copy_dir().ok_or("LOCALAPPDATA is not set")?;
        if dry_run {
            log.push(format!("would copy the browser to {}", dest.display()));
        } else {
            // Never under a running browser: deleting it half-way left a broken copy (review 2, 1.17).
            if crate::update::any_gamblium_browser() {
                return Err("a Gamblium browser is running from the browser folder: close every Gamblium window, then install again".into());
            }
            if dest.is_dir() {
                fs::remove_dir_all(&dest).map_err(|e| format!("{}: {e} (is Gamblium running?)", dest.display()))?;
            }
            let (files, bytes) = crate::rebrand::copy_all(&shipped, &dest).map_err(io)?;
            fs::write(dest.join(crate::rebrand::SHIPPED), "This browser came inside the Gamblium package.\n").map_err(io)?;
            // A note left by an older local rebrand is not about this browser (review 9, G28).
            if let Some(note) = crate::rebrand::incomplete_note() {
                let _ = fs::remove_file(note);
            }
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
        log.push("would offer Gamblium for PDF files (Open with, and Settings > Default apps)".into());
    } else {
        log.push(offer_for_pdfs(&app.join("gamblium-app.exe"), &app.join("gamblium.ico")));
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
        // Marked as the owner's, so no start ever takes it for an agent's (review 9, G2).
        if !dry_run && profile.is_dir() {
            let _ = fs::write(profile.join(crate::sessions::OWNER_MARK), "This is the owner's own Gamblium profile: never an agent's.\n");
        }
    }
    // Closed profiles take the new code now, in the background, and a spare No session window is
    // made ready on it: the first click after an install opens as quickly as any other (owner,
    // Nov 20 2026: Personal took 7 s to open after an install).
    // The old spare No session window holds the previous code: thrown away (a new one is made after
    // the next start). No hidden starts here (owner, Nov 20 2026: Defender quarantined gamblium.exe
    // while a warm-up after install started several hidden browsers in a row).
    if !dry_run {
        if let Some(spare) = crate::sessions::spare_dir() {
            let _ = fs::remove_dir_all(spare);
        }
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
        // Given back only while magnet links are still Gamblium's (review 9, G26).
        Some(cmd) => match reg(&["query", &command_key, "/ve"]) {
            Ok(now) if !now.to_ascii_lowercase().contains("gamblium") => Ok("magnet links belong to another program now: left as they are".to_owned()),
            _ => reg(&["add", &command_key, "/ve", "/t", "REG_SZ", "/d", cmd.trim(), "/f"]).map(|_| format!("magnet links given back to: {}", cmd.trim())),
        },
        // Deleted only while it is still ours: another program may have taken magnet links since
        // (review 2, 1.18).
        None => match reg(&["query", &command_key, "/ve"]) {
            Ok(now) if now.to_ascii_lowercase().contains("gamblium") => reg(&["delete", MAGNET_KEY, "/f"]).map(|_| "magnet links are no longer Gamblium's".to_owned()),
            Ok(_) => Ok("magnet links belong to another program now: left as they are".to_owned()),
            Err(_) => Ok("magnet links: nothing of Gamblium's".to_owned()),
        },
    };
    if let Some(f) = magnet_before_file() {
        let _ = fs::remove_file(f);
    }
    done.unwrap_or_else(|e| format!("magnet links: {e}"))
}

// PDF files (owner, Nov 15 2026: "when I open a PDF it does not offer Gamblium"). Gamblium is
// offered, for this Windows user: in "Open with", and in Settings > Default apps, where the
// owner can make it the default. It is never made the default by itself: Windows 11 keeps that
// choice to the person (and protects it), and whatever opened PDFs before still does.
const PDF_PROGID: &str = r"HKCU\Software\Classes\Gamblium.PDF";
const PDF_OPEN_WITH: &str = r"HKCU\Software\Classes\.pdf\OpenWithProgids";
const PDF_APP: &str = r"HKCU\Software\Classes\Applications\gamblium-app.exe";
const CAPABILITIES: &str = r"HKCU\Software\Gamblium\Capabilities";
const REGISTERED_APPS: &str = r"HKCU\Software\RegisteredApplications";

/// The registry writes that offer Gamblium for PDFs (key, value name or "" for the default, data).
pub fn pdf_entries(starter: &Path, icon: &Path) -> Vec<(String, String, String)> {
    let open = format!("\"{}\" \"%1\"", starter.display());
    let icon = format!("{},0", icon.display());
    let e = |k: &str, v: &str, d: &str| (k.to_owned(), v.to_owned(), d.to_owned());
    vec![
        e(PDF_PROGID, "", "PDF document"),
        e(&format!(r"{PDF_PROGID}\DefaultIcon"), "", &icon),
        e(&format!(r"{PDF_PROGID}\Application"), "ApplicationName", "Gamblium"),
        e(&format!(r"{PDF_PROGID}\shell\open"), "FriendlyAppName", "Gamblium"),
        e(&format!(r"{PDF_PROGID}\shell\open\command"), "", &open),
        e(PDF_OPEN_WITH, "Gamblium.PDF", ""),
        e(PDF_APP, "FriendlyAppName", "Gamblium"),
        e(&format!(r"{PDF_APP}\SupportedTypes"), ".pdf", ""),
        e(&format!(r"{PDF_APP}\DefaultIcon"), "", &icon),
        e(&format!(r"{PDF_APP}\shell\open\command"), "", &open),
        e(CAPABILITIES, "ApplicationName", "Gamblium"),
        e(CAPABILITIES, "ApplicationDescription", "A lean, private browser with its own PDF viewer and editor"),
        e(&format!(r"{CAPABILITIES}\FileAssociations"), ".pdf", "Gamblium.PDF"),
        e(REGISTERED_APPS, "Gamblium", r"Software\Gamblium\Capabilities"),
    ]
}

fn offer_for_pdfs(starter: &Path, icon: &Path) -> String {
    for (key, value, data) in pdf_entries(starter, icon) {
        let mut args = vec!["add", key.as_str()];
        if value.is_empty() {
            args.push("/ve");
        } else {
            args.extend(["/v", value.as_str()]);
        }
        args.extend(["/t", "REG_SZ", "/d", data.as_str(), "/f"]);
        if let Err(e) = reg(&args) {
            return format!("PDF files: could not offer Gamblium ({e})");
        }
    }
    shell_changed();
    "PDF files: Gamblium is offered in Open with, and can be made the default in Settings > Default apps".into()
}

fn withdraw_from_pdfs() -> String {
    let _ = reg(&["delete", PDF_PROGID, "/f"]);
    let _ = reg(&["delete", PDF_OPEN_WITH, "/v", "Gamblium.PDF", "/f"]);
    let _ = reg(&["delete", PDF_APP, "/f"]);
    let _ = reg(&["delete", CAPABILITIES, "/f"]);
    let _ = reg(&["delete", REGISTERED_APPS, "/v", "Gamblium", "/f"]);
    shell_changed();
    "PDF files: Gamblium is no longer offered".into()
}

/// Tells Explorer that file types changed, so the menu shows the new entry at once.
fn shell_changed() {
    #[cfg(windows)]
    {
        #[link(name = "shell32")]
        extern "system" {
            fn SHChangeNotify(event: i32, flags: u32, a: *const std::ffi::c_void, b: *const std::ffi::c_void);
        }
        // SHCNE_ASSOCCHANGED, SHCNF_IDLIST
        unsafe { SHChangeNotify(0x0800_0000, 0, std::ptr::null(), std::ptr::null()) };
    }
}

/// Removes the program, the shortcuts and the helper registration. The
/// profile folder is kept: it holds the user's own data.
pub fn remove(dry_run: bool) -> Result<Vec<String>, String> {
    let mut log = Vec::new();
    // A dry run says what it would do, not that it did it.
    let did = |what: &str| if dry_run { format!("would remove {what}") } else { format!("removed {what}") };
    let base = base_dir().ok_or("LOCALAPPDATA is not set")?;
    for folder in shortcut_folders()? {
        let lnk = folder.join("Gamblium.lnk");
        if lnk.is_file() {
            if !dry_run {
                fs::remove_file(&lnk).map_err(|e| e.to_string())?;
            }
            log.push(did(&format!("shortcut {}", lnk.display())));
        }
    }
    if !dry_run {
        crate::host::install(crate::host::EXTENSION_ID, true)?;
    }
    log.push(did("the helper's registration"));
    if dry_run {
        log.push("would give magnet links back".into());
    } else {
        log.push(give_back_magnet_links());
        log.push(withdraw_from_pdfs());
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
                // Said when something stays, not reported as removed (review 2, 1.18).
                if let Err(e) = if p.is_dir() { fs::remove_dir_all(&p) } else { fs::remove_file(&p) } {
                    log.push(format!("could not remove {}: {e}", p.display()));
                }
            }
        }
        log.push(did(&format!("program files in {}", app.display())));
    }
    // Everything else install and use made that is not the person's own data (review 2, 1.18):
    // the browser copy and its GPU preference, downloaded updates, agents' extension copies and
    // the helper's launcher. Profiles, sessions, keys, logins and records stay.
    let browser = base.join("browser");
    if browser.is_dir() {
        if crate::update::any_gamblium_browser() {
            log.push(format!("kept {} (a Gamblium browser is running from it; close it and remove again)", browser.display()));
        } else {
            if !dry_run {
                if let Some(exe) = crate::rebrand::copy_dir().map(|d| d.join("brave.exe")) {
                    let _ = reg(&["delete", r"HKCU\Software\Microsoft\DirectX\UserGpuPreferences", "/v", &exe.to_string_lossy(), "/f"]);
                }
                if let Err(e) = fs::remove_dir_all(&browser) {
                    log.push(format!("could not remove {}: {e}", browser.display()));
                }
            }
            log.push(did(&format!("the browser copy in {}", browser.display())));
        }
    }
    let mut extra: Vec<PathBuf> = vec![base.join("updates"), base.join("native-host.bat")];
    extra.extend(fs::read_dir(&base).into_iter().flatten().flatten().map(|e| e.path()).filter(|p| p.file_name().is_some_and(|n| n.to_string_lossy().starts_with("agent-extension"))));
    for p in extra.into_iter().filter(|p| p.exists()) {
        if !dry_run {
            if let Err(e) = if p.is_dir() { fs::remove_dir_all(&p) } else { fs::remove_file(&p) } {
                log.push(format!("could not remove {}: {e}", p.display()));
                continue;
            }
        }
        log.push(did(&p.display().to_string()));
    }
    log.push(format!("{} your profile in {}", if dry_run { "would keep" } else { "kept" }, base.join("User Data").display()));
    // The owner's profile keeps its mark (sessions::OWNER_MARK): it stays the owner's after a
    // remove and a new install.
    Ok(log)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_code_stamp_follows_the_files_and_not_itself() {
        let ext = std::env::temp_dir().join(format!("gamblium-test-stamp-{}", std::process::id()));
        let _ = fs::remove_dir_all(&ext);
        fs::create_dir_all(ext.join("ui")).unwrap();
        fs::write(ext.join("background.js"), "A").unwrap();
        fs::write(ext.join("ui").join("page.js"), "p").unwrap();
        let a = write_code_stamp(&ext).unwrap();
        assert_eq!(a.len(), 16);
        let text = fs::read_to_string(ext.join(CODE_STAMP_FILE)).unwrap();
        assert!(text.contains(&format!("export const CODE_STAMP = \"{a}\";")), "{text}");
        assert_eq!(write_code_stamp(&ext).unwrap(), a); // its own file does not count
        fs::write(ext.join("ui").join("page.js"), "q").unwrap();
        assert_ne!(write_code_stamp(&ext).unwrap(), a);
        let _ = fs::remove_dir_all(&ext);
    }

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
        let pdf = pdf_entries(Path::new(r"C:\a\gamblium-app.exe"), Path::new(r"C:\a\gamblium.ico"));
        assert!(pdf.iter().any(|(k, v, d)| k.ends_with(r"Gamblium.PDF\shell\open\command") && v.is_empty() && d == r#""C:\a\gamblium-app.exe" "%1""#));
        assert!(pdf.iter().any(|(k, v, _)| k.ends_with(r".pdf\OpenWithProgids") && v == "Gamblium.PDF"));
        // Offered only: nothing touches the .pdf key's own default or the user's choice.
        assert!(pdf.iter().all(|(k, v, _)| !(k.ends_with(r"Classes\.pdf") && v.is_empty()) && !k.contains("UserChoice")));
        let out = "\r\nHKEY_CURRENT_USER\\Software\\Classes\\magnet\\shell\\open\\command\r\n    (Default)    REG_SZ    \"C:\\x\\fdm.exe\" \"%1\"\r\n\r\n";
        assert_eq!(reg_default_value(out).as_deref(), Some(r#""C:\x\fdm.exe" "%1""#));
        assert_eq!(reg_default_value("ERROR: The system was unable to find the specified registry key or value."), None);
    }
}

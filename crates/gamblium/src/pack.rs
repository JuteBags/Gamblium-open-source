//! Stopped named sessions take little room (owner, Nov 14 2026: 42 sessions held 5.3 GB).
//!
//! A session is a whole browser profile. Most of its size is what the browser rebuilds on its
//! own (the page cache, compiled code, graphics shaders): one session after five sites was
//! 20 MB, 18 MB of it caches. When a session is closed, those are deleted and everything else
//! (logins, cookies, storage, history, settings) is packed into one `profile.tar.zst` with
//! zstd at a high level; the session's note stays beside it, readable. Starting the session
//! unpacks it first. Measured on that session: 20 MB -> 0.53 MB with xz; zstd -19 is within a
//! few percent and unpacks far faster.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

pub const ARCHIVE: &str = "profile.tar.zst";
/// When the profile's browser last closed (ms), written before packing: the archive's own time
/// is when the pack ended, not when the browser closed.
const CLOSED_AT: &str = "gamblium-closed-at";
pub fn closed_at_kept(dir: &Path) -> Option<u64> {
    if !is_packed(dir) {
        return None;
    }
    fs::read_to_string(dir.join(CLOSED_AT)).ok()?.trim().parse().ok()
}
/// Files that stay readable next to the archive.
// Outside the archive, so a packed folder is still known for what it is (session note, owner mark).
const KEEP_OUT: &[&str] = &["gamblium-session.json", ARCHIVE, COMPONENTS_NOTE, crate::sessions::SESSION_VIEW, CLOSED_AT, crate::sessions::OWNER_MARK];
// zstd level 3 (owner, Nov 16 2026, after measuring a copy of Personal, 939 MB): 6 s to pack
// against about 2 min at 19, 328 MB against 287 MB, and the same 12-15 s to unpack (writing the
// files, not decompressing, is what takes the time).
const LEVEL: i32 = 3;
/// The list of components a packed session had, inside its folder next to the archive.
const COMPONENTS_NOTE: &str = "gamblium-components.txt";

/// Brave's downloaded components (ad-block lists, certificate lists, ...): the same in every
/// session, and most of what is left once the caches are gone (32 of 33 MB after a few sites).
/// A component is a top-level folder holding a version folder with a manifest.json. Packing
/// moves each into one shared store beside the sessions (`.components`), so 42 sessions keep
/// one copy, and unpacking copies them back.
pub fn components_in(dir: &Path) -> Vec<String> {
    let mut out: Vec<String> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.path().is_dir())
        .filter(|e| fs::read_dir(e.path()).into_iter().flatten().flatten().any(|v| v.path().join("manifest.json").is_file()))
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    out.sort();
    out
}

/// One store for every profile: Gamblium\.components (the owner's and the sessions' were kept
/// apart, the same lists twice). Profiles packed before keep finding theirs in the old place.
fn store_of(_dir: &Path) -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join("Gamblium").join(".components"))
}
fn old_store_of(dir: &Path) -> Option<PathBuf> {
    dir.parent().map(|p| p.join(".components"))
}
/// A version folder's number, part by part ("1.0.10431" after "1.0.9999").
fn version_key(p: &Path) -> Vec<u64> {
    p.file_name().map(|n| n.to_string_lossy().split(['.', '_']).map(|x| x.parse().unwrap_or(0)).collect()).unwrap_or_default()
}
/// The newest version folder of a component in a store.
fn newest_in(store: &Path, name: &str) -> Option<PathBuf> {
    fs::read_dir(store.join(name)).into_iter().flatten().flatten().filter(|v| v.path().is_dir() && !v.file_name().to_string_lossy().contains(".tmp")).map(|v| v.path()).max_by_key(|p| version_key(p))
}

fn copy_tree(from: &Path, to: &Path) -> io::Result<()> {
    fs::create_dir_all(to)?;
    for e in fs::read_dir(from)?.flatten() {
        let target = to.join(e.file_name());
        if e.path().is_dir() {
            copy_tree(&e.path(), &target)?;
        } else {
            fs::copy(e.path(), target)?;
        }
    }
    Ok(())
}

/// Moves the session's components into the shared store (a newer version replaces the stored
/// one; the same version is not copied twice). -> their names.
fn share_components(dir: &Path) -> io::Result<Vec<String>> {
    let Some(store) = store_of(dir) else { return Ok(Vec::new()) };
    let names = components_in(dir);
    for name in &names {
        let src = dir.join(name);
        let dst = store.join(name);
        for v in fs::read_dir(&src)?.flatten() {
            let target = dst.join(v.file_name());
            if v.path().is_dir() && !target.exists() {
                // Beside, then named: a half copy is never taken for the newest version.
                let mut tmp = target.as_os_str().to_owned();
                tmp.push(format!(".tmp{}", std::process::id()));
                let tmp = PathBuf::from(tmp);
                let _ = fs::remove_dir_all(&tmp);
                copy_tree(&v.path(), &tmp)?;
                if fs::rename(&tmp, &target).is_err() {
                    let _ = fs::remove_dir_all(&tmp);
                    if !target.exists() {
                        // Not stored (a virus check held it): the pack stops and the profile keeps it
                        // (review 4, B7).
                        return Err(io::Error::other(format!("could not store component {name}")));
                    }
                }
            }
        }
    }
    // Every component is stored before any leaves the profile, and the note is written first: a
    // failure part-way loses nothing (review 4, B7).
    // Merged with what the note already lists: a pack that failed part-way had already removed
    // some, and this pack no longer sees them in the profile (review 6, D7).
    let mut listed: Vec<String> = fs::read_to_string(dir.join(COMPONENTS_NOTE)).unwrap_or_default().split('|').map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned).collect();
    for n in &names {
        if !listed.contains(n) {
            listed.push(n.clone());
        }
    }
    fs::write(dir.join(COMPONENTS_NOTE), listed.join("|"))?;
    for name in &names {
        // Only the newest version is ever restored: older ones in the store are dropped.
        if let Some(newest) = newest_in(&store, name) {
            for v in fs::read_dir(store.join(name)).into_iter().flatten().flatten() {
                if v.path().is_dir() && v.path() != newest && !v.file_name().to_string_lossy().contains(".tmp") {
                    let _ = fs::remove_dir_all(v.path());
                }
            }
        }
        fs::remove_dir_all(dir.join(name))?;
    }
    Ok(names)
}

/// Copies the session's components back from the shared store (newest version of each).
fn restore_components(dir: &Path) -> io::Result<()> {
    let list = dir.join(COMPONENTS_NOTE);
    let Ok(text) = fs::read_to_string(&list) else { return Ok(()) };
    let Some(store) = store_of(dir) else { return Ok(()) };
    // Folder names only: nothing that could point outside the session.
    for name in text.split('|').filter(|l| !l.is_empty() && l.chars().all(|c| c.is_ascii_alphanumeric() || c == ' ' || c == '_' || c == '-')) {
        let newest = newest_in(&store, name).or_else(|| old_store_of(dir).and_then(|old| newest_in(&old, name)));
        if let Some(v) = newest {
            copy_tree(&v, &dir.join(name).join(v.file_name().unwrap_or_default()))?;
        }
    }
    fs::remove_file(list)
}

pub fn archive_of(dir: &Path) -> PathBuf {
    dir.join(ARCHIVE)
}

pub fn is_packed(dir: &Path) -> bool {
    archive_of(dir).is_file()
}

/// Bytes on disk under `dir`.
pub fn size_of(dir: &Path) -> u64 {
    fn walk(p: &Path) -> u64 {
        match fs::symlink_metadata(p) {
            Ok(m) if m.is_dir() => fs::read_dir(p).map(|rd| rd.flatten().map(|e| walk(&e.path())).sum()).unwrap_or(0),
            Ok(m) => m.len(),
            Err(_) => 0,
        }
    }
    walk(dir)
}

/// Deletes the caches and packs the rest. The browser of this session must be stopped.
/// -> (bytes before, bytes after). Leaves the folder unpacked if anything goes wrong.
pub fn pack(dir: &Path) -> io::Result<(u64, u64)> {
    pack_with(dir, &|| false, &|| true)
}

/// Packs `dir`. `stop` is asked before every file (a start that wants the folder); `may_finish`
/// once more before the archive replaces the files. Anything that goes wrong or is stopped before
/// that point leaves the folder as it was, its components put back.
fn pack_with(dir: &Path, stop: &dyn Fn() -> bool, may_finish: &dyn Fn() -> bool) -> io::Result<(u64, u64)> {
    if is_packed(dir) {
        let s = size_of(dir);
        return Ok((s, s));
    }
    let before = size_of(dir);
    if let Some(t) = fs::metadata(dir.join("Local State")).and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()) {
        let _ = fs::write(dir.join(CLOSED_AT), (t.as_millis() as u64).to_string());
    }
    // Everything is packed, caches included (owner, Nov 16 2026: deleting them made every page
    // load from the network again after a reopen). They come back as they were when it opens.
    share_components(dir)?;
    let tmp = dir.join(format!("{ARCHIVE}.tmp"));
    let undo = |e: io::Error| {
        let _ = fs::remove_file(&tmp);
        let _ = restore_components(dir);
        e
    };
    let entries: Vec<PathBuf> = fs::read_dir(dir)
        .map_err(undo)?
        .flatten()
        .filter(|e| {
            let n = e.file_name();
            !KEEP_OUT.contains(&n.to_string_lossy().as_ref()) && n != PACKING && n != CANCEL && n != LAUNCHING && n != std::ffi::OsStr::new(&format!("{ARCHIVE}.tmp")) && n != std::ffi::OsStr::new(&format!("{ARCHIVE}.prev")) && n != std::ffi::OsStr::new(&format!("{ARCHIVE}.prev.at"))
        })
        .map(|e| e.path())
        .collect();
    let built = (|| -> io::Result<()> {
        let file = fs::File::create(&tmp)?;
        // Every core but one (the packer runs at background priority, so it yields to the person).
        let level = std::env::var("GAMBLIUM_PACK_LEVEL").ok().and_then(|v| v.parse().ok()).unwrap_or(LEVEL);
        let threads = std::thread::available_parallelism().map(|n| n.get().saturating_sub(1).max(1)).unwrap_or(2) as u32;
        let mut enc = zstd::Encoder::new(file, level)?;
        enc.long_distance_matching(true)?;
        enc.multithread(threads).ok();
        let mut tar = tar::Builder::new(enc);
        tar.follow_symlinks(false);
        // File by file, so a start that wants the folder is heard within one file.
        fn add(tar: &mut tar::Builder<zstd::Encoder<'static, fs::File>>, root: &Path, p: &Path, stop: &dyn Fn() -> bool) -> io::Result<()> {
            if stop() {
                return Err(io::Error::new(io::ErrorKind::Interrupted, "a start wants the profile"));
            }
            let name = p.strip_prefix(root).unwrap_or(p);
            let meta = fs::symlink_metadata(p)?;
            if meta.is_dir() {
                tar.append_dir(name, p)?;
                for e in fs::read_dir(p)?.flatten() {
                    add(tar, root, &e.path(), stop)?;
                }
                Ok(())
            } else if meta.is_file() {
                tar.append_path_with_name(p, name)
            } else {
                Ok(()) // links are not followed or kept
            }
        }
        for p in &entries {
            add(&mut tar, dir, p, stop)?;
        }
        // On disk before it replaces anything (review 3, A9: a power cut could lose the profile).
        tar.into_inner()?.finish()?.sync_all()?;
        Ok(())
    })();
    built.map_err(undo)?;
    // Only a whole, readable archive replaces the files, and only if nobody wants them now.
    check(&tmp).map_err(undo)?;
    if stop() || !may_finish() {
        return Err(undo(io::Error::new(io::ErrorKind::Interrupted, "the profile is wanted: not packed")));
    }
    fs::rename(&tmp, archive_of(dir)).map_err(undo)?;
    let _ = fs::remove_file(dir.join(format!("{ARCHIVE}.prev")));
    let _ = fs::remove_file(dir.join(format!("{ARCHIVE}.prev.at")));
    for p in &entries {
        let r = if p.is_dir() { fs::remove_dir_all(p) } else { fs::remove_file(p) };
        if let Err(e) = r {
            // Held by something (a virus check): it stays beside the archive; said, not hidden.
            crate::launch::relaunch_log(&format!("pack: {} stayed beside the archive: {e}", p.display()));
        }
    }
    Ok((before, size_of(dir)))
}

/// While a profile is being packed this file is in it, held open with no sharing for the whole
/// pack: another packer cannot open it, and a start knows a pack is at work (`wait_unpacked`).
/// Whether a pack is at work is the open handle, never the file's age.
pub const PACKING: &str = "gamblium-packing";
/// A start that wants a profile being packed leaves this; the packer stops and puts it back.
const CANCEL: &str = "gamblium-pack-cancel";

/// `Gamblium\updating`: an update is being installed. Packers waiting to start leave at once, so
/// none holds gamblium.exe open while the installer replaces it (review 3 A16, review 4 B12).
fn updating_file() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join("Gamblium").join("updating"))
}
pub fn set_updating(on: bool) {
    if let Some(f) = updating_file() {
        // The updater's process id: a killed updater's flag counts for nothing (review 10, H11).
        let _ = if on { fs::write(f, std::process::id().to_string()) } else { fs::remove_file(f) };
    }
}
/// Within 30 minutes of being set, and only while the updater that set it runs (a crashed or
/// killed updater does not hold back packing or the icon).
pub fn updating() -> bool {
    let Some(f) = updating_file() else { return false };
    let fresh = fs::metadata(&f).ok().and_then(|m| m.modified().ok()).and_then(|t| t.elapsed().ok()).is_some_and(|e| e.as_secs() < 1800);
    fresh && fs::read_to_string(&f).ok().and_then(|t| t.trim().parse::<u32>().ok()).is_none_or(pid_alive)
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
/// Sleeps, looking every second for an update; false if one began.
pub fn nap(secs: u64) -> bool {
    for _ in 0..secs {
        if updating() {
            return false;
        }
        std::thread::sleep(std::time::Duration::from_secs(1));
    }
    !updating()
}

#[cfg(windows)]
fn hold(p: &Path) -> io::Result<fs::File> {
    use std::os::windows::fs::OpenOptionsExt;
    fs::OpenOptions::new().write(true).create(true).truncate(true).share_mode(0).open(p)
}
#[cfg(not(windows))]
fn hold(p: &Path) -> io::Result<fs::File> {
    fs::OpenOptions::new().write(true).create(true).truncate(true).open(p)
}

/// Is a browser using this profile folder? Chromium keeps `lockfile` in it open for as long as
/// it runs (and creates it at start). A fact, not a guess from the process list: the list said
/// "stopped" once while the owner's browser still held its files (Nov 16 2026).
pub fn in_use(dir: &Path) -> bool {
    // Being started by the launcher (it marks the folder before anything else; review 3, A6).
    if fs::metadata(dir.join(LAUNCHING)).and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|e| e.as_secs() < 120) {
        return true;
    }
    let lock = dir.join("lockfile");
    if !lock.exists() {
        return false;
    }
    hold_existing(&lock).is_err()
}
#[cfg(windows)]
fn hold_existing(p: &Path) -> io::Result<fs::File> {
    use std::os::windows::fs::OpenOptionsExt;
    fs::OpenOptions::new().read(true).write(true).share_mode(0).open(p)
}
#[cfg(not(windows))]
fn hold_existing(p: &Path) -> io::Result<fs::File> {
    fs::OpenOptions::new().read(true).open(p)
}

/// The archive kept after an unpack (A9) goes once the profile has been in use for 10 minutes:
/// by then its files are on disk. Kept for ever it was a full second copy (review 4, B5).
pub fn drop_previous_if_settled(dir: &Path) {
    let prev = dir.join(format!("{ARCHIVE}.prev"));
    let mark = dir.join(format!("{ARCHIVE}.prev.at"));
    let age = |p: &Path| fs::metadata(p).and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).map(|e| e.as_secs());
    // The younger of the two counts: the mark is the unpack's own time.
    let old = match (age(&mark), age(&prev)) { (Some(m), Some(p)) => m.min(p) > 600, (None, Some(p)) => p > 600, _ => false };
    if old && in_use(dir) {
        let _ = fs::remove_file(prev);
        let _ = fs::remove_file(mark);
    }
}

/// Written by the launcher into a profile it is about to start.
pub const LAUNCHING: &str = "gamblium-launching";
pub fn mark_launching(dir: &Path) {
    let _ = fs::write(dir.join(LAUNCHING), b"");
}

/// Is a packer at work on `dir` right now?
pub fn is_packing(dir: &Path) -> bool {
    let lock = dir.join(PACKING);
    if !lock.exists() {
        return false;
    }
    match hold(&lock) {
        Ok(f) => {
            drop(f);
            let _ = fs::remove_file(&lock); // left by a packer that ended without cleaning up
            false
        }
        Err(_) => true,
    }
}

/// Packs a closed profile under the lock; false when it was already packed, another packer is at
/// work, or it is not closed. `closed` is asked once the lock is held and again before the
/// archive replaces the files; a start that wants the folder stops the pack (`wait_unpacked`).
/// Packing is off (owner, Nov 16 2026: "packing the session is creating a lot of friction"). No
/// folder is packed any more; one packed by an earlier version is still unpacked when it starts,
/// so nothing kept in an archive is lost.
pub const PACKING_ON: bool = false;

pub fn pack_locked(dir: &Path, closed: impl Fn() -> bool) -> io::Result<bool> {
    if !PACKING_ON || is_packed(dir) {
        return Ok(false);
    }
    let lock_path = dir.join(PACKING);
    let Ok(lock) = hold(&lock_path) else { return Ok(false) };
    let _ = fs::remove_file(dir.join(CANCEL));
    // An update began between the packer's last look and this lock (review 9, G31).
    if updating() {
        drop(lock);
        let _ = fs::remove_file(&lock_path);
        return Ok(false);
    }
    // Closed means the caller says so AND no browser holds the profile's lockfile, both now and
    // again before the archive replaces the files.
    let closed = || closed() && !in_use(dir);
    let r = if closed() {
        let cancel = dir.join(CANCEL);
        pack_with(dir, &|| cancel.exists(), &closed).map(|_| true)
    } else {
        Ok(false)
    };
    drop(lock);
    let _ = fs::remove_file(&lock_path);
    let _ = fs::remove_file(dir.join(CANCEL));
    match r {
        Err(e) if e.kind() == io::ErrorKind::Interrupted => Ok(false),
        other => other,
    }
}

/// Asks a pack at work on `dir` to stop (it puts the folder back) and waits up to `secs` for it.
/// True when no pack is at work any more.
pub fn stop_pack(dir: &Path, secs: u64) -> bool {
    if !is_packing(dir) {
        return true;
    }
    let _ = fs::write(dir.join(CANCEL), b"");
    let t = std::time::Instant::now();
    while is_packing(dir) && t.elapsed().as_secs() < secs {
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    let done = !is_packing(dir);
    if done {
        let _ = fs::remove_file(dir.join(CANCEL));
    }
    done
}

/// Before a browser starts on a folder: a pack at work is stopped (it puts the folder back) or,
/// past its last step, finished; then a packed profile is unpacked. True if it was unpacked.
pub fn wait_unpacked(dir: &Path) -> io::Result<bool> {
    if is_packing(dir) {
        let _ = fs::write(dir.join(CANCEL), b"");
        let t = std::time::Instant::now();
        while is_packing(dir) {
            if t.elapsed() > std::time::Duration::from_secs(600) {
                return Err(io::Error::new(io::ErrorKind::TimedOut, "the profile is still being packed after 10 minutes: not started"));
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        let _ = fs::remove_file(dir.join(CANCEL));
    }
    unpack(dir)
}

/// Reads the whole archive through, so a broken one is never trusted.
fn check(archive: &Path) -> io::Result<()> {
    let dec = zstd::Decoder::new(fs::File::open(archive)?)?;
    let mut tar = tar::Archive::new(dec);
    for entry in tar.entries()? {
        let mut entry = entry?;
        io::copy(&mut entry, &mut io::sink())?;
    }
    Ok(())
}

/// The archive is read in order (decompressing is fast); the files are written by several
/// threads at once, since writing is the slow part (each new file is also scanned by the virus
/// checker): 7,859 files of a 937 MB profile took 15 s one by one. Names are checked: nothing is
/// written outside `dir`.
fn unpack_parallel(archive: &Path, dir: &Path) -> io::Result<()> {
    use std::path::Component;
    use std::sync::mpsc::sync_channel;
    let writers = std::thread::available_parallelism().map(|n| n.get().clamp(2, 8)).unwrap_or(4);
    // At most this many files read ahead: memory stays bounded (a few MB per file at most).
    let (tx, rx) = sync_channel::<(PathBuf, Vec<u8>, Option<std::time::SystemTime>)>(writers * 4);
    let rx = std::sync::Arc::new(std::sync::Mutex::new(rx));
    let failed: std::sync::Arc<std::sync::Mutex<Option<io::Error>>> = Default::default();
    let pool: Vec<_> = (0..writers)
        .map(|_| {
            let rx = rx.clone();
            let failed = failed.clone();
            std::thread::spawn(move || loop {
                let job = rx.lock().map(|r| r.recv()).ok().and_then(Result::ok);
                let Some((path, data, mtime)) = job else { break };
                let r = (|| -> io::Result<()> {
                    let f = fs::File::create(&path)?;
                    io::Write::write_all(&mut &f, &data)?;
                    if let Some(t) = mtime {
                        let _ = f.set_modified(t);
                    }
                    Ok(())
                })();
                if let Err(e) = r {
                    failed.lock().unwrap().get_or_insert(io::Error::new(e.kind(), format!("{}: {e}", path.display())));
                }
            })
        })
        .collect();
    let read = (|| -> io::Result<()> {
        let dec = zstd::Decoder::new(fs::File::open(archive)?)?;
        let mut tar = tar::Archive::new(dec);
        for entry in tar.entries()? {
            let mut entry = entry?;
            let rel = entry.path()?.into_owned();
            if rel.components().any(|c| !matches!(c, Component::Normal(_) | Component::CurDir)) {
                return Err(io::Error::new(io::ErrorKind::InvalidData, format!("unsafe name in the archive: {}", rel.display())));
            }
            let out = dir.join(&rel);
            match entry.header().entry_type() {
                tar::EntryType::Directory => fs::create_dir_all(&out)?,
                tar::EntryType::Regular | tar::EntryType::Continuous => {
                    if let Some(p) = out.parent() {
                        fs::create_dir_all(p)?;
                    }
                    let mtime = entry.header().mtime().ok().map(|s| std::time::UNIX_EPOCH + std::time::Duration::from_secs(s));
                    // A big file is written here, straight from the archive: queued whole, a few
                    // of them could take gigabytes of memory.
                    if entry.size() > 8 * 1024 * 1024 {
                        let mut f = fs::File::create(&out)?;
                        io::copy(&mut entry, &mut f)?;
                        if let Some(t) = mtime {
                            let _ = f.set_modified(t);
                        }
                        continue;
                    }
                    let mut data = Vec::with_capacity(entry.size() as usize);
                    io::Read::read_to_end(&mut entry, &mut data)?;
                    if tx.send((out, data, mtime)).is_err() {
                        break;
                    }
                }
                _ => {} // links are never packed
            }
            if failed.lock().unwrap().is_some() {
                break;
            }
        }
        Ok(())
    })();
    drop(tx);
    for w in pool {
        let _ = w.join();
    }
    read?;
    if let Some(e) = failed.lock().unwrap().take() {
        return Err(e);
    }
    Ok(())
}

/// Unpacks a packed session in place and removes the archive. Nothing to do if it is not packed.
pub fn unpack(dir: &Path) -> io::Result<bool> {
    let archive = archive_of(dir);
    if !archive.is_file() {
        // A pack that was undone may have left its components in the store: put them back.
        if dir.join(COMPONENTS_NOTE).is_file() {
            restore_components(dir)?;
        }
        return Ok(false);
    }
    unpack_parallel(&archive, dir)?;
    // Kept beside as the previous archive until the next pack replaces it: files just written
    // may not be on disk yet when the archive goes (review 3, A9).
    let prev = dir.join(format!("{ARCHIVE}.prev"));
    let _ = fs::remove_file(&prev);
    fs::rename(&archive, &prev)?;
    // A rename keeps the pack's time: dated now, so "10 minutes in use" counts from this unpack
    // (review 6, D4: it went seconds after every morning start).
    if let Ok(f) = fs::OpenOptions::new().write(true).open(&prev) {
        let _ = f.set_modified(std::time::SystemTime::now());
    }
    // And a fresh mark beside it: its own time is the unpack's even if the date above could not
    // be set (review 7, E5).
    let _ = fs::write(dir.join(format!("{ARCHIVE}.prev.at")), b"");
    restore_components(dir)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "packing is off (PACKING_ON); kept for when it comes back"]
    fn a_stopped_pack_leaves_the_folder_as_it_was() {
        let dir = std::env::temp_dir().join(format!("gpack-stop-{}", std::process::id())).join("s");
        let _ = fs::remove_dir_all(dir.parent().unwrap());
        fs::create_dir_all(dir.join("Default/Network")).unwrap();
        for i in 0..20 {
            fs::write(dir.join(format!("Default/f{i}")), vec![i as u8; 1000]).unwrap();
        }
        fs::write(dir.join("Default/Network/Cookies"), b"jar").unwrap();
        fs::create_dir_all(dir.join("abcdefghijklmnopabcdefghijklmnop/1.2.3")).unwrap();
        fs::write(dir.join("abcdefghijklmnopabcdefghijklmnop/1.2.3/manifest.json"), b"{}").unwrap();
        let n = std::cell::Cell::new(0);
        let r = pack_with(&dir, &|| { n.set(n.get() + 1); n.get() > 5 }, &|| true);
        assert_eq!(r.unwrap_err().kind(), io::ErrorKind::Interrupted);
        assert!(!is_packed(&dir), "no archive");
        assert!(!dir.join(format!("{ARCHIVE}.tmp")).exists(), "no half archive left");
        assert_eq!(fs::read(dir.join("Default/Network/Cookies")).unwrap(), b"jar");
        assert!(dir.join("abcdefghijklmnopabcdefghijklmnop/1.2.3/manifest.json").is_file(), "components put back");
        // Not allowed to finish (the browser started): the same.
        assert_eq!(pack_with(&dir, &|| false, &|| false).unwrap_err().kind(), io::ErrorKind::Interrupted);
        assert!(!is_packed(&dir) && dir.join("Default/f3").is_file());
        // A second packer cannot start while one holds the lock.
        let held = hold(&dir.join(PACKING)).unwrap();
        assert!(is_packing(&dir));
        assert!(!pack_locked(&dir, || true).unwrap());
        drop(held);
        assert!(!is_packing(&dir), "a lock nobody holds is no lock");
        assert!(pack_locked(&dir, || true).unwrap());
        assert!(wait_unpacked(&dir).unwrap());
        assert_eq!(fs::read(dir.join("Default/Network/Cookies")).unwrap(), b"jar");
        let _ = fs::remove_dir_all(dir.parent().unwrap());
    }

    #[test]
    fn everything_round_trips() {
        let dir = std::env::temp_dir().join(format!("gpack-{}", std::process::id())).join("s");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("Default/Cache/Cache_Data")).unwrap();
        fs::create_dir_all(dir.join("Default/Network")).unwrap();
        fs::write(dir.join("Default/Cache/Cache_Data/data_1"), vec![7u8; 200_000]).unwrap();
        fs::write(dir.join("Default/Network/Cookies"), b"cookie jar".repeat(500)).unwrap();
        fs::write(dir.join("Local State"), b"{\"a\":1}").unwrap();
        fs::write(dir.join("gamblium-session.json"), b"{\"hidden\":true}").unwrap();
        fs::create_dir_all(dir.join("abcdefghijklmnopabcdefghijklmnop/1.2.3")).unwrap();
        fs::write(dir.join("abcdefghijklmnopabcdefghijklmnop/1.2.3/manifest.json"), b"{}").unwrap();
        fs::write(dir.join("abcdefghijklmnopabcdefghijklmnop/1.2.3/list.dat"), vec![3u8; 100_000]).unwrap();
        let (before, after) = pack(&dir).unwrap();
        assert!(after < before / 10, "{before} -> {after}");
        assert!(is_packed(&dir));
        assert!(!dir.join("Default").exists());
        assert!(dir.join("gamblium-session.json").is_file(), "the note stays readable");
        assert_eq!(pack(&dir).unwrap().0, size_of(&dir), "packing twice changes nothing");
        assert!(unpack(&dir).unwrap());
        assert!(!is_packed(&dir));
        assert_eq!(fs::read(dir.join("Default/Network/Cookies")).unwrap(), b"cookie jar".repeat(500));
        assert_eq!(fs::read(dir.join("Local State")).unwrap(), b"{\"a\":1}");
        assert_eq!(fs::read(dir.join("Default/Cache/Cache_Data/data_1")).unwrap().len(), 200_000, "caches are packed and come back too");
        assert_eq!(fs::read(dir.join("abcdefghijklmnopabcdefghijklmnop/1.2.3/list.dat")).unwrap().len(), 100_000, "components come back from the shared store");
        assert!(!unpack(&dir).unwrap());
        let _ = fs::remove_dir_all(&dir);
    }
}

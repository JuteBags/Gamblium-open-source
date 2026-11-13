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
/// Files that stay readable next to the archive.
const KEEP_OUT: &[&str] = &["gamblium-session.json", ARCHIVE, COMPONENTS_NOTE];
/// What the browser rebuilds by itself, relative to the profile folder. Never logins or storage,
/// and nothing under Service Worker: its database points at scripts there, and without them our
/// own extension's worker does not start (seen: a packed session no longer took commands).
pub const CACHES: &[&str] = &[
    "GrShaderCache",
    "ShaderCache",
    "GPUPersistentCache",
    "component_crx_cache",
    "Default/Cache",
    "Default/Code Cache",
    "Default/GPUCache",
    "Default/DawnWebGPUCache",
    "Default/DawnGraphiteCache",
];
const LEVEL: i32 = 19;
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

fn store_of(dir: &Path) -> Option<PathBuf> {
    dir.parent().map(|p| p.join(".components"))
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
                copy_tree(&v.path(), &target)?;
            }
        }
        fs::remove_dir_all(&src)?;
    }
    fs::write(dir.join(COMPONENTS_NOTE), names.join("|"))?;
    Ok(names)
}

/// Copies the session's components back from the shared store (newest version of each).
fn restore_components(dir: &Path) -> io::Result<()> {
    let list = dir.join(COMPONENTS_NOTE);
    let Ok(text) = fs::read_to_string(&list) else { return Ok(()) };
    let Some(store) = store_of(dir) else { return Ok(()) };
    // Folder names only: nothing that could point outside the session.
    for name in text.split('|').filter(|l| !l.is_empty() && l.chars().all(|c| c.is_ascii_alphanumeric() || c == ' ' || c == '_' || c == '-')) {
        let src = store.join(name);
        let newest = fs::read_dir(&src).into_iter().flatten().flatten().filter(|v| v.path().is_dir()).map(|v| v.path()).max();
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
    if is_packed(dir) {
        let s = size_of(dir);
        return Ok((s, s));
    }
    let before = size_of(dir);
    for c in CACHES {
        let p = dir.join(c);
        if p.exists() {
            let _ = fs::remove_dir_all(&p);
        }
    }
    share_components(dir)?;
    let entries: Vec<PathBuf> = fs::read_dir(dir)?
        .flatten()
        .filter(|e| !KEEP_OUT.contains(&e.file_name().to_string_lossy().as_ref()))
        .map(|e| e.path())
        .collect();
    let tmp = dir.join(format!("{ARCHIVE}.tmp"));
    {
        let file = fs::File::create(&tmp)?;
        let mut enc = zstd::Encoder::new(file, LEVEL)?;
        enc.long_distance_matching(true)?;
        enc.multithread(2).ok();
        let mut tar = tar::Builder::new(enc);
        tar.follow_symlinks(false);
        for p in &entries {
            let name = p.strip_prefix(dir).unwrap_or(p);
            if name.as_os_str() == std::ffi::OsStr::new(&format!("{ARCHIVE}.tmp")) {
                continue;
            }
            if p.is_dir() {
                tar.append_dir_all(name, p)?;
            } else {
                tar.append_path_with_name(p, name)?;
            }
        }
        tar.into_inner()?.finish()?;
    }
    // Only a whole, readable archive replaces the files.
    if let Err(e) = check(&tmp) {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    fs::rename(&tmp, archive_of(dir))?;
    for p in &entries {
        let _ = if p.is_dir() { fs::remove_dir_all(p) } else { fs::remove_file(p) };
    }
    Ok((before, size_of(dir)))
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

/// Unpacks a packed session in place and removes the archive. Nothing to do if it is not packed.
pub fn unpack(dir: &Path) -> io::Result<bool> {
    let archive = archive_of(dir);
    if !archive.is_file() {
        return Ok(false);
    }
    let dec = zstd::Decoder::new(fs::File::open(&archive)?)?;
    let mut tar = tar::Archive::new(dec);
    tar.set_overwrite(true);
    tar.unpack(dir)?;
    fs::remove_file(&archive)?;
    restore_components(dir)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn caches_go_the_rest_round_trips() {
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
        assert!(!dir.join("Default/Cache").exists(), "caches are not brought back");
        assert_eq!(fs::read(dir.join("abcdefghijklmnopabcdefghijklmnop/1.2.3/list.dat")).unwrap().len(), 100_000, "components come back from the shared store");
        assert!(!unpack(&dir).unwrap());
        let _ = fs::remove_dir_all(&dir);
    }
}

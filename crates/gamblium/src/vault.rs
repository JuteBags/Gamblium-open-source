//! Where the login cookie of an unfinished download is kept, so the download
//! can be continued (owner, Nov 12 2026: safety first).
//!
//! - **Sealed:** XChaCha20-Poly1305. One step both encrypts and proves the
//!   text has not been changed; a wrong key, a changed byte or a changed
//!   label fails to open.
//! - **The key** is 32 random bytes made on first use and stored wrapped by
//!   Windows for this user account (DPAPI). Another Windows user, or the same
//!   files copied to another machine, cannot unwrap it.
//! - **One key per purpose** (owner, Nov 12 2026): download logins and saved
//!   sessions each have their own key file in `Gamblium\keys`, made
//!   independently. Learning one tells nothing about the other, and the
//!   purpose is also part of every label, so a text sealed for one purpose
//!   never opens under another even with the right key. A new purpose is a
//!   new entry in `Purpose`.
//! - **Bound to its download:** the label sealed with the cookie names the
//!   download's id, the site and the moment it expires. A sealed cookie moved
//!   onto another download, another site or a later expiry does not open.
//! - **Short-lived:** it expires with the cookie itself and never later than
//!   one day after it was stored. It is deleted when the download finishes
//!   (by the downloader, at that instant), when the download is cancelled or
//!   removed, and whenever the list is read after its time is up.
//! - The cookie is never written anywhere else: not in the download's own
//!   files, not on a command line.

use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use std::fs;
use std::path::{Path, PathBuf};

/// What a key is for. Each purpose has its own key file and its own labels.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Purpose {
    /// The login cookie of an unfinished download.
    Downloads,
    /// Saved sessions and checkpoints (typed text, page state).
    Sessions,
    /// Logins the owner lets agents use without reading them (logins.rs).
    Logins,
}

impl Purpose {
    pub fn name(self) -> &'static str {
        match self {
            Purpose::Downloads => "downloads",
            Purpose::Sessions => "sessions",
            Purpose::Logins => "logins",
        }
    }
}

/// The folder that holds the wrapped keys, one file per purpose.
pub fn keys_dir() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join("Gamblium").join("keys"))
}

/// Seals any text for a purpose under a label that names what it belongs to.
pub fn seal_text(key: &[u8; 32], purpose: Purpose, label: &str, text: &str) -> Result<Vec<u8>, String> {
    let mut nonce = [0u8; 24];
    getrandom::getrandom(&mut nonce).map_err(|e| e.to_string())?;
    let aad = format!("gamblium {} v1|{label}", purpose.name());
    let sealed = XChaCha20Poly1305::new(key.into())
        .encrypt(XNonce::from_slice(&nonce), Payload { msg: text.as_bytes(), aad: aad.as_bytes() })
        .map_err(|_| "could not seal the text".to_string())?;
    Ok([nonce.as_slice(), &sealed].concat())
}

pub fn open_text(key: &[u8; 32], purpose: Purpose, label: &str, blob: &[u8]) -> Result<String, String> {
    if blob.len() < 24 + 16 {
        return Err("the sealed text is damaged".into());
    }
    let (nonce, sealed) = blob.split_at(24);
    let aad = format!("gamblium {} v1|{label}", purpose.name());
    let plain = XChaCha20Poly1305::new(key.into())
        .decrypt(XNonce::from_slice(nonce), Payload { msg: sealed, aad: aad.as_bytes() })
        .map_err(|_| "the sealed text does not belong here or was changed".to_string())?;
    String::from_utf8(plain).map_err(|_| "the sealed text is damaged".to_string())
}

/// However long the site's cookie lives, ours is gone after this.
pub const LONGEST_SECS: u64 = 24 * 60 * 60;

/// When a cookie stored now must be gone: the site's own expiry if it gave
/// one and it is sooner, else one day from now.
pub fn until(now: u64, cookie_expires: Option<u64>) -> u64 {
    let cap = now + LONGEST_SECS;
    cookie_expires.map(|e| e.min(cap)).unwrap_or(cap)
}

fn label(id: &str, site: &str, until: u64) -> String {
    format!("gamblium-dl cookie v1|{id}|{site}|{until}")
}

pub fn file(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.cookie"))
}

/// Seals `cookie` for one download. Returns nonce followed by the sealed text.
pub fn seal(key: &[u8; 32], id: &str, site: &str, until: u64, cookie: &str) -> Result<Vec<u8>, String> {
    let mut nonce = [0u8; 24];
    getrandom::getrandom(&mut nonce).map_err(|e| e.to_string())?;
    let cipher = XChaCha20Poly1305::new(key.into());
    let sealed = cipher
        .encrypt(XNonce::from_slice(&nonce), Payload { msg: cookie.as_bytes(), aad: label(id, site, until).as_bytes() })
        .map_err(|_| "could not seal the cookie".to_string())?;
    Ok([nonce.as_slice(), &sealed].concat())
}

/// Opens what `seal` made. Fails if anything differs: key, id, site, expiry or a single byte.
pub fn open(key: &[u8; 32], id: &str, site: &str, until: u64, blob: &[u8]) -> Result<String, String> {
    if blob.len() < 24 + 16 {
        return Err("the stored login is damaged".into());
    }
    let (nonce, sealed) = blob.split_at(24);
    let cipher = XChaCha20Poly1305::new(key.into());
    let plain = cipher
        .decrypt(XNonce::from_slice(nonce), Payload { msg: sealed, aad: label(id, site, until).as_bytes() })
        .map_err(|_| "the stored login does not belong to this download or was changed".to_string())?;
    String::from_utf8(plain).map_err(|_| "the stored login is damaged".to_string())
}

#[cfg(windows)]
fn dpapi(data: &[u8], protect: bool) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB};
    const UI_FORBIDDEN: u32 = 1;
    let input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
    let mut output = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
    // SAFETY: `input` points at `data` for the length of the call; `output`
    // is filled by Windows and freed below with LocalFree, as documented.
    let ok = unsafe {
        if protect {
            CryptProtectData(&input, std::ptr::null(), std::ptr::null(), std::ptr::null(), std::ptr::null(), UI_FORBIDDEN, &mut output)
        } else {
            CryptUnprotectData(&input, std::ptr::null_mut(), std::ptr::null(), std::ptr::null(), std::ptr::null(), UI_FORBIDDEN, &mut output)
        }
    };
    if ok == 0 || output.pbData.is_null() {
        return Err("Windows would not protect the key for this account".into());
    }
    // SAFETY: Windows returned `cbData` bytes at `pbData`.
    let bytes = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe { LocalFree(output.pbData as _) };
    Ok(bytes)
}

#[cfg(not(windows))]
fn dpapi(_data: &[u8], _protect: bool) -> Result<Vec<u8>, String> {
    Err("stored logins need Windows".into())
}

/// The key for one purpose: made once, kept wrapped for this Windows account
/// in its own file. `old` is where an earlier build kept it, if anywhere.
pub fn key_in(keys: &Path, purpose: Purpose, old: Option<&Path>) -> Result<[u8; 32], String> {
    let path = keys.join(format!("{}.key", purpose.name()));
    if !path.exists() {
        if let Some(old) = old.filter(|o| o.is_file()) {
            fs::create_dir_all(keys).map_err(|e| e.to_string())?;
            fs::rename(old, &path).map_err(|e| e.to_string())?;
        }
    }
    read_or_make(&path)
}

/// The key for a purpose in the usual place.
pub fn key_for(purpose: Purpose) -> Result<[u8; 32], String> {
    key_in(&keys_dir().ok_or("LOCALAPPDATA is not set")?, purpose, None)
}

/// The downloads key. `dir` is the downloads folder: tests give a folder of
/// their own, and the key then lives beside it.
fn key(dir: &Path) -> Result<[u8; 32], String> {
    let keys = dir.parent().map(|p| p.join("keys")).unwrap_or_else(|| dir.join("keys"));
    key_in(&keys, Purpose::Downloads, Some(&dir.join("vault.key")))
}

fn read_or_make(path: &Path) -> Result<[u8; 32], String> {
    let dir = path.parent().unwrap_or(Path::new("."));
    let open = |wrapped: &[u8]| -> Result<[u8; 32], String> {
        let raw = dpapi(wrapped, false)?;
        raw.as_slice().try_into().map_err(|_| "the vault key is damaged".to_string())
    };
    match fs::read(path) {
        Ok(wrapped) => return open(&wrapped),
        // Only a key that is not there is made. Any other failure (a file in use, no access) is
        // an error: replacing the key would make everything sealed with it unreadable.
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(format!("could not read the key {}: {e}", path.display())),
        Err(_) => {}
    }
    let mut fresh = [0u8; 32];
    getrandom::getrandom(&mut fresh).map_err(|e| e.to_string())?;
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let wrapped = dpapi(&fresh, true)?;
    // Two helpers at first use: the first file wins and the other reads it.
    // Written whole beside, then linked in place: the link fails if another helper got there
    // first, and a crash never leaves an empty key file (review 2, 1.16).
    let tmp = path.with_extension(format!("tmp{}", std::process::id()));
    fs::write(&tmp, &wrapped).map_err(|e| e.to_string())?;
    let linked = fs::hard_link(&tmp, path);
    let _ = fs::remove_file(&tmp);
    match linked {
        Ok(()) => Ok(fresh),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => open(&fs::read(path).map_err(|e| e.to_string())?),
        Err(e) => Err(e.to_string()),
    }
}

/// Stores the cookie for download `id`. Returns the moment it expires.
pub fn store(dir: &Path, id: &str, site: &str, cookie: &str, now: u64, cookie_expires: Option<u64>) -> Result<u64, String> {
    let until = until(now, cookie_expires);
    if until <= now {
        return Err("the login has already expired".into());
    }
    let blob = seal(&key(dir)?, id, site, until, cookie)?;
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    fs::write(file(dir, id), blob).map_err(|e| e.to_string())?;
    Ok(until)
}

/// The cookie for download `id`, if it is still there, still valid and really its own.
pub fn load(dir: &Path, id: &str, site: &str, until: u64, now: u64) -> Result<String, String> {
    if now >= until {
        remove(dir, id);
        return Err("the login for this download has expired; start it again from the page".into());
    }
    let blob = fs::read(file(dir, id)).map_err(|_| "the login for this download is no longer stored; start it again from the page".to_string())?;
    open(&key(dir)?, id, site, until, &blob)
}

pub fn remove(dir: &Path, id: &str) {
    let path = file(dir, id);
    if let Ok(meta) = fs::metadata(&path) {
        // Overwritten before it is deleted, so the sealed text does not linger in freed space.
        let _ = fs::write(&path, vec![0u8; meta.len() as usize]);
    }
    let _ = fs::remove_file(path);
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: [u8; 32] = [7; 32];

    #[test]
    fn a_sealed_cookie_opens_only_for_its_own_download() {
        let blob = seal(&KEY, "00112233445566ff", "drive.example.com", 5000, "SID=secret; HSID=x").unwrap();
        assert!(!blob.windows(6).any(|w| w == b"secret"));
        assert_eq!(open(&KEY, "00112233445566ff", "drive.example.com", 5000, &blob).unwrap(), "SID=secret; HSID=x");
        // Another download, another site, a later expiry, another key, one changed byte: all refused.
        assert!(open(&KEY, "ffffffffffffffff", "drive.example.com", 5000, &blob).is_err());
        assert!(open(&KEY, "00112233445566ff", "evil.example.com", 5000, &blob).is_err());
        assert!(open(&KEY, "00112233445566ff", "drive.example.com", 9000, &blob).is_err());
        assert!(open(&[8; 32], "00112233445566ff", "drive.example.com", 5000, &blob).is_err());
        let mut bent = blob.clone();
        *bent.last_mut().unwrap() ^= 1;
        assert!(open(&KEY, "00112233445566ff", "drive.example.com", 5000, &bent).is_err());
        assert!(open(&KEY, "00112233445566ff", "drive.example.com", 5000, &blob[..20]).is_err());
        // The same cookie sealed twice does not look the same.
        assert_ne!(blob, seal(&KEY, "00112233445566ff", "drive.example.com", 5000, "SID=secret; HSID=x").unwrap());
    }

    #[test]
    fn it_lives_as_long_as_the_cookie_but_never_more_than_a_day() {
        assert_eq!(until(1000, Some(1300)), 1300); // the site says five minutes
        assert_eq!(until(1000, Some(1000 + 12 * 3600)), 1000 + 12 * 3600); // twelve hours
        assert_eq!(until(1000, Some(1000 + 30 * 24 * 3600)), 1000 + LONGEST_SECS); // a month: capped
        assert_eq!(until(1000, None), 1000 + LONGEST_SECS); // a session cookie
    }

    #[test]
    fn a_text_sealed_for_one_purpose_never_opens_for_another() {
        let blob = seal_text(&KEY, Purpose::Sessions, "work", "typed text").unwrap();
        assert_eq!(open_text(&KEY, Purpose::Sessions, "work", &blob).unwrap(), "typed text");
        // Same key, other purpose or other label: refused.
        assert!(open_text(&KEY, Purpose::Downloads, "work", &blob).is_err());
        assert!(open_text(&KEY, Purpose::Sessions, "personal", &blob).is_err());
        assert!(open_text(&[9; 32], Purpose::Sessions, "work", &blob).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn each_purpose_has_its_own_key_and_an_old_key_is_moved_not_remade() {
        let root = std::env::temp_dir().join(format!("gamblium-keys-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let keys = root.join("keys");
        let downloads = key_in(&keys, Purpose::Downloads, None).unwrap();
        let sessions = key_in(&keys, Purpose::Sessions, None).unwrap();
        assert_ne!(downloads, sessions);
        assert!(keys.join("downloads.key").is_file() && keys.join("sessions.key").is_file());
        // Read again: the same keys, not new ones.
        assert_eq!(key_in(&keys, Purpose::Downloads, None).unwrap(), downloads);
        assert_eq!(key_in(&keys, Purpose::Sessions, None).unwrap(), sessions);
        // A key from an earlier build is carried over.
        let other = root.join("other");
        fs::create_dir_all(&other).unwrap();
        fs::copy(keys.join("downloads.key"), other.join("vault.key")).unwrap();
        let moved = root.join("moved-keys");
        assert_eq!(key_in(&moved, Purpose::Downloads, Some(&other.join("vault.key"))).unwrap(), downloads);
        assert!(!other.join("vault.key").exists());
        fs::remove_dir_all(&root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn stored_loaded_expired_and_removed_on_disk() {
        let dir = std::env::temp_dir().join(format!("gamblium-vault-test-{}", std::process::id())).join("downloads");
        let _ = fs::remove_dir_all(&dir);
        let id = "00112233445566ff";
        let until = store(&dir, id, "x.org", "s=1", 1000, Some(1600)).unwrap();
        assert_eq!(until, 1600);
        assert!(!fs::read(file(&dir, id)).unwrap().windows(3).any(|w| w == b"s=1"));
        assert!(!fs::read(dir.parent().unwrap().join("keys").join("downloads.key")).unwrap().is_empty());
        assert_eq!(load(&dir, id, "x.org", until, 1200).unwrap(), "s=1");
        // Past its time: refused and deleted.
        assert!(load(&dir, id, "x.org", until, 1600).is_err());
        assert!(!file(&dir, id).exists());
        assert!(store(&dir, id, "x.org", "s=1", 1000, Some(900)).is_err());
        store(&dir, id, "x.org", "s=1", 1000, None).unwrap();
        remove(&dir, id);
        assert!(!file(&dir, id).exists());
        fs::remove_dir_all(dir.parent().unwrap()).unwrap();
    }
}

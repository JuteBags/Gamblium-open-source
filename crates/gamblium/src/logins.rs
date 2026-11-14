//! Logins agents may use without reading them (owner, Nov 14 2026: "the agent can directly use
//! it without reading it").
//!
//! The owner saves a site, user name and password in Settings > Agents. They are kept sealed in
//! `Gamblium\logins.sealed` with a key of their own (vault Purpose::Logins), made on this
//! machine and wrapped by Windows for this user. An agent asks with `login site=...`; the helper
//! gives the login to the extension only (never in an answer to the agent), and only with the
//! owner's yes (permit "logins"); the extension types it into the page and submits.
//!
//! What this cannot stop: an agent that may run scripts in the page could read a field in the
//! moment between filling and the page going on; the extension submits at once to keep that short.

use crate::vault::{self, Purpose};
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;

const LABEL: &str = "agent logins";

fn file() -> Option<PathBuf> {
    if let Some(f) = std::env::var_os("GAMBLIUM_LOGINS_FILE") {
        return Some(PathBuf::from(f));
    }
    Some(PathBuf::from(std::env::var_os("LOCALAPPDATA")?).join("Gamblium").join("logins.sealed"))
}

fn load_with(key: &[u8; 32]) -> Result<Vec<Value>, String> {
    let Some(f) = file() else { return Err("LOCALAPPDATA is not set".into()) };
    let Ok(blob) = fs::read(&f) else { return Ok(Vec::new()) };
    let text = vault::open_text(key, Purpose::Logins, LABEL, &blob)?;
    Ok(serde_json::from_str::<Vec<Value>>(&text).unwrap_or_default())
}

fn save_with(key: &[u8; 32], all: &[Value]) -> Result<(), String> {
    let f = file().ok_or("LOCALAPPDATA is not set")?;
    if let Some(d) = f.parent() {
        fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    let blob = vault::seal_text(key, Purpose::Logins, LABEL, &serde_json::to_string(all).unwrap())?;
    let tmp = f.with_extension("sealed.tmp");
    fs::write(&tmp, blob).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &f).map_err(|e| e.to_string())
}

/// "https://www.GitHub.com/login" or "github.com" -> "github.com".
pub fn site_of(text: &str) -> Option<String> {
    let t = text.trim();
    let host = if t.contains("://") { url::Url::parse(t).ok()?.host_str()?.to_owned() } else { t.split(['/', ':']).next()?.to_owned() };
    let host = host.trim_start_matches("www.").to_ascii_lowercase();
    (host.contains('.') && host.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')).then_some(host)
}

/// Whether a page's host belongs to a saved site (the site itself or one of its subdomains).
pub fn host_matches(host: &str, site: &str) -> bool {
    let h = host.trim_start_matches("www.").to_ascii_lowercase();
    h == site || h.ends_with(&format!(".{site}"))
}

/// Sites and user names, never a password.
pub fn list() -> Result<Value, String> {
    let all = load_with(&vault::key_for(Purpose::Logins)?)?;
    Ok(json!({ "logins": all.iter().map(|l| json!({ "site": l["site"], "username": l["username"] })).collect::<Vec<_>>() }))
}

pub fn save(site: &str, username: &str, password: &str) -> Result<Value, String> {
    let site = site_of(site).ok_or_else(|| format!("'{site}' is not a site (like github.com)"))?;
    if password.is_empty() || password.len() > 1000 || username.len() > 300 {
        return Err("a password (and a user name of a sensible length) is needed".into());
    }
    let key = vault::key_for(Purpose::Logins)?;
    let mut all = load_with(&key)?;
    all.retain(|l| !(l["site"] == site.as_str() && l["username"] == username));
    all.push(json!({ "site": site, "username": username, "password": password }));
    save_with(&key, &all)?;
    list()
}

pub fn remove(site: &str, username: &str) -> Result<Value, String> {
    let key = vault::key_for(Purpose::Logins)?;
    let mut all = load_with(&key)?;
    all.retain(|l| !(l["site"] == site && l["username"] == username));
    save_with(&key, &all)?;
    list()
}

/// The login for the page's host (the first saved one; or the one with `username`).
pub fn get(host: &str, username: Option<&str>) -> Result<Option<(String, String, String)>, String> {
    let all = load_with(&vault::key_for(Purpose::Logins)?)?;
    Ok(all
        .iter()
        .filter(|l| host_matches(host, l["site"].as_str().unwrap_or("-")))
        .find(|l| username.is_none_or(|u| l["username"] == u))
        .map(|l| (l["site"].as_str().unwrap_or("").to_owned(), l["username"].as_str().unwrap_or("").to_owned(), l["password"].as_str().unwrap_or("").to_owned())))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sites_and_hosts() {
        assert_eq!(site_of("https://www.GitHub.com/login").as_deref(), Some("github.com"));
        assert_eq!(site_of("accounts.example.org").as_deref(), Some("accounts.example.org"));
        assert_eq!(site_of("localhost"), None);
        assert_eq!(site_of("evil.com\"; x"), None);
        assert!(host_matches("github.com", "github.com"));
        assert!(host_matches("gist.github.com", "github.com"));
        assert!(!host_matches("github.com.evil.org", "github.com"));
        assert!(!host_matches("notgithub.com", "github.com"));
    }

    #[test]
    fn saved_sealed_listed_without_password_and_found_by_host() {
        let dir = std::env::temp_dir().join(format!("gamblium-test-logins-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let key = [7u8; 32];
        std::env::set_var("GAMBLIUM_LOGINS_FILE", dir.join("logins.sealed"));
        save_with(&key, &[json!({ "site": "github.com", "username": "me", "password": "pw-secret-1" })]).unwrap();
        let raw = fs::read(dir.join("logins.sealed")).unwrap();
        assert!(!String::from_utf8_lossy(&raw).contains("pw-secret-1") && !String::from_utf8_lossy(&raw).contains("github"));
        let all = load_with(&key).unwrap();
        assert_eq!(all[0]["password"], "pw-secret-1");
        assert!(load_with(&[8u8; 32]).is_err(), "another key does not open it");
        std::env::remove_var("GAMBLIUM_LOGINS_FILE");
        fs::remove_dir_all(&dir).unwrap();
    }
}

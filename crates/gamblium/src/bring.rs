//! "Bring your stuff over" (owner, Nov 14 2026): which accounts the other browsers on this
//! computer are signed in to, so the owner can sign in again in Gamblium.
//!
//! Read, never changed, and never a password: for each profile of Chrome, Brave, Edge and Comet
//! it reads the profile's name and its Google accounts (Local State and Preferences) and, from a
//! copy of `Login Data`, the sites with a saved login and their user names. Cookies and signed-in
//! sessions cannot be carried over (they are encrypted for that browser, and Google ties its
//! sessions to the device); the browser's own importer carries passwords, bookmarks and history.

use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

/// (name shown, user-data folder under LOCALAPPDATA)
const BROWSERS: &[(&str, &str)] = &[
    ("Chrome", r"Google\Chrome\User Data"),
    ("Brave", r"BraveSoftware\Brave-Browser\User Data"),
    ("Edge", r"Microsoft\Edge\User Data"),
    ("Comet", r"Perplexity\Comet\User Data"),
];

/// At most this many sites per profile (the rest are counted).
const MAX_SITES: usize = 300;

pub fn scan() -> Value {
    let Some(local) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) else {
        return json!({ "browsers": [] });
    };
    let browsers: Vec<Value> = BROWSERS
        .iter()
        .filter_map(|(name, rel)| {
            let root = local.join(rel);
            let profiles = profiles_of(&root);
            (!profiles.is_empty()).then(|| json!({ "browser": name, "profiles": profiles }))
        })
        .collect();
    json!({ "browsers": browsers })
}

fn read_json(path: &Path) -> Value {
    fs::read_to_string(path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null)
}

fn profiles_of(root: &Path) -> Vec<Value> {
    let state = read_json(&root.join("Local State"));
    let cache = state["profile"]["info_cache"].as_object().cloned().unwrap_or_default();
    let mut folders: Vec<String> = cache.keys().cloned().collect();
    if folders.is_empty() && root.join("Default").is_dir() {
        folders.push("Default".into());
    }
    folders.sort();
    folders
        .into_iter()
        .filter(|f| root.join(f).join("Preferences").is_file())
        .map(|folder| {
            let dir = root.join(&folder);
            let info = &cache.get(&folder).cloned().unwrap_or(Value::Null);
            let prefs = read_json(&dir.join("Preferences"));
            let mut accounts: Vec<Value> = Vec::new();
            for a in prefs["account_info"].as_array().into_iter().flatten() {
                if let Some(email) = a["email"].as_str().filter(|e| e.contains('@')) {
                    accounts.push(json!({ "email": email, "name": a["full_name"].as_str().unwrap_or("") }));
                }
            }
            if accounts.is_empty() {
                if let Some(email) = info["user_name"].as_str().filter(|e| e.contains('@')) {
                    accounts.push(json!({ "email": email, "name": info["gaia_name"].as_str().unwrap_or("") }));
                }
            }
            // "For Account": the passwords Chrome keeps in the Google account.
            let (sites, total) = saved_logins(&[dir.join("Login Data"), dir.join("Login Data For Account")]);
            json!({
                "folder": folder,
                "name": info["name"].as_str().or(prefs["profile"]["name"].as_str()).unwrap_or(&folder),
                "accounts": accounts,
                "sites": sites,
                "sitesTotal": total,
            })
        })
        .collect()
}

/// Sites with a saved login, newest use first: `[{ site, origin, users }]`, and how many in all.
fn saved_logins(dbs: &[PathBuf]) -> (Vec<Value>, usize) {
    let mut rows = Vec::new();
    for db in dbs.iter().filter(|d| d.is_file()) {
        // A copy: the other browser may have the file open, and nothing of it is ever written.
        let copy = std::env::temp_dir().join(format!("gamblium-logins-{}-{}", std::process::id(), random_suffix()));
        if fs::copy(db, &copy).is_ok() {
            rows.extend(read_logins(&copy).unwrap_or_default());
        }
        let _ = fs::remove_file(&copy);
    }
    let mut by_site: BTreeMap<String, (String, Vec<String>, i64)> = BTreeMap::new();
    for (origin, user, used) in rows {
        let Ok(u) = url::Url::parse(&origin) else { continue };
        if !matches!(u.scheme(), "https" | "http") {
            continue;
        }
        let Some(host) = u.host_str() else { continue };
        let site = host.trim_start_matches("www.").to_owned();
        let entry = by_site.entry(site).or_insert_with(|| (format!("{}://{}", u.scheme(), host), Vec::new(), 0));
        if !user.is_empty() && !entry.1.contains(&user) && entry.1.len() < 5 {
            entry.1.push(user);
        }
        entry.2 = entry.2.max(used);
    }
    let total = by_site.len();
    let mut list: Vec<(String, (String, Vec<String>, i64))> = by_site.into_iter().collect();
    list.sort_by(|a, b| b.1 .2.cmp(&a.1 .2).then(a.0.cmp(&b.0)));
    let sites = list.into_iter().take(MAX_SITES).map(|(site, (origin, users, _))| json!({ "site": site, "origin": origin, "users": users })).collect();
    (sites, total)
}

/// origin, user name, last used: never the password column.
fn read_logins(path: &Path) -> rusqlite::Result<Vec<(String, String, i64)>> {
    let db = rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX)?;
    // Sites the user said "never save" for are not logins.
    let mut st = db.prepare("SELECT origin_url, username_value, COALESCE(date_last_used, date_created, 0) FROM logins WHERE blacklisted_by_user = 0")?;
    let rows = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1).unwrap_or_default(), r.get::<_, i64>(2).unwrap_or(0))))?;
    Ok(rows.filter_map(Result::ok).collect())
}

fn random_suffix() -> String {
    let mut b = [0u8; 6];
    let _ = getrandom::getrandom(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn logins_are_read_by_site_without_passwords() {
        let dir = std::env::temp_dir().join(format!("gamblium-test-bring-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let db = dir.join("Login Data");
        {
            let c = rusqlite::Connection::open(&db).unwrap();
            c.execute_batch(
                "CREATE TABLE logins (origin_url TEXT, username_value TEXT, password_value BLOB, blacklisted_by_user INTEGER, date_created INTEGER, date_last_used INTEGER);
                 INSERT INTO logins VALUES ('https://github.com/login', 'me', x'01', 0, 1, 50);
                 INSERT INTO logins VALUES ('https://www.github.com/session', 'other', x'02', 0, 1, 10);
                 INSERT INTO logins VALUES ('https://bank.example/', '', x'03', 1, 1, 99);
                 INSERT INTO logins VALUES ('android://abc@com.app/', 'x', x'04', 0, 1, 99);
                 INSERT INTO logins VALUES ('https://mail.example.org/', 'me@example.org', x'05', 0, 1, 70);",
            )
            .unwrap();
        }
        let (sites, total) = saved_logins(&[db.clone(), dir.join("missing")]);
        assert_eq!(total, 2);
        assert_eq!(sites[0]["site"], "mail.example.org");
        assert_eq!(sites[1]["site"], "github.com");
        assert_eq!(sites[1]["users"], json!(["me", "other"]));
        assert!(!serde_json::to_string(&sites).unwrap().contains("\\u0001"));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn profiles_with_their_google_accounts() {
        let root = std::env::temp_dir().join(format!("gamblium-test-bring-p-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("Default")).unwrap();
        fs::create_dir_all(root.join("Profile 1")).unwrap();
        fs::write(root.join("Local State"), r#"{"profile":{"info_cache":{"Default":{"name":"Work","user_name":"w@x.org"},"Profile 1":{"name":"Home"}}}}"#).unwrap();
        fs::write(root.join("Default").join("Preferences"), r#"{"account_info":[{"email":"w@x.org","full_name":"W"}]}"#).unwrap();
        fs::write(root.join("Profile 1").join("Preferences"), "{}").unwrap();
        let p = profiles_of(&root);
        assert_eq!(p.len(), 2);
        assert_eq!(p[0]["name"], "Work");
        assert_eq!(p[0]["accounts"][0]["email"], "w@x.org");
        assert_eq!(p[1]["accounts"], json!([]));
        fs::remove_dir_all(&root).unwrap();
    }
}

#[cfg(test)]
mod on_this_machine {
    /// `cargo test -p gamblium on_this_machine -- --ignored --nocapture`: counts only.
    #[test]
    #[ignore]
    fn counts() {
        let t = std::time::Instant::now();
        for b in super::scan()["browsers"].as_array().unwrap() {
            for p in b["profiles"].as_array().unwrap() {
                println!("{} / {}: {} account(s), {} site(s)", b["browser"], p["folder"], p["accounts"].as_array().unwrap().len(), p["sitesTotal"]);
            }
        }
        println!("{:?}", t.elapsed());
    }
}

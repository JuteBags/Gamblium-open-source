//! A small log of what agents did (owner, Nov 14 2026): one line per command an agent sent
//! (`gamblium ctl`, `gamblium-cli <session> ...`), for the owner to read. We do not write a
//! story of it; the agent decides what to tell, the owner can look here.
//!
//! `Gamblium\agent-logs\YYYY-MM-DD.log` under LOCALAPPDATA, kept 14 days. A line:
//! `14:03:07  the session 'shop'  open url=https://x.org wait=true  -> ok  812 ms`.
//! What is typed into pages and anything that looks like a secret is never written, only its
//! length (`text=<12 characters>`).

use serde_json::Value;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

const KEEP_DAYS: u64 = 14;
/// Arguments whose value is never written.
const SECRET_KEYS: &[&str] = &["text", "value", "password", "pass", "secret", "token", "cookie", "key", "code", "otp", "expression", "script", "js", "body"];

pub fn dir() -> Option<PathBuf> {
    Some(PathBuf::from(std::env::var_os("LOCALAPPDATA")?).join("Gamblium").join("agent-logs"))
}

/// "open url=https://x.org text=<5 characters>": the command as the agent sent it, made safe.
pub fn describe(cmd: &Value) -> String {
    let op = cmd["op"].as_str().unwrap_or("?");
    let mut parts = vec![op.to_owned()];
    if let Some(map) = cmd.as_object() {
        let mut keys: Vec<&String> = map.keys().filter(|k| k.as_str() != "op").collect();
        keys.sort();
        for k in keys {
            let v = &map[k];
            let shown = if SECRET_KEYS.iter().any(|s| k.eq_ignore_ascii_case(s)) {
                format!("<{} characters>", v.as_str().map(|s| s.chars().count()).unwrap_or_else(|| v.to_string().len()))
            } else {
                let s = match v {
                    Value::String(s) => s.clone(),
                    other => other.to_string(),
                };
                let one_line: String = s.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
                if one_line.chars().count() > 160 { one_line.chars().take(160).collect::<String>() + "…" } else { one_line }
            };
            parts.push(format!("{k}={shown}"));
        }
    }
    parts.join(" ")
}

/// "ok", or "error: <first 200 characters>".
pub fn outcome(answer: &Value) -> String {
    if answer["ok"].as_bool() == Some(false) {
        let e: String = answer["error"].as_str().unwrap_or("failed").chars().take(200).collect();
        format!("error: {}", e.replace(['\r', '\n'], " "))
    } else {
        "ok".into()
    }
}

/// Days since 1970 -> (year, month, day), proleptic Gregorian.
fn civil(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// Local time is not known without more code; the log is in UTC and says so in its name.
fn stamp(secs: u64) -> (String, String) {
    let (y, m, d) = civil((secs / 86_400) as i64);
    let s = secs % 86_400;
    (format!("{y:04}-{m:02}-{d:02}"), format!("{:02}:{:02}:{:02}", s / 3600, (s / 60) % 60, s % 60))
}

pub fn write(who: &str, cmd: &Value, answer: &Value, ms: u128) {
    let Some(dir) = dir() else { return };
    if fs::create_dir_all(&dir).is_err() {
        return;
    }
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let (day, time) = stamp(now);
    let line = format!("{time} UTC  {who}  {}  -> {}  {ms} ms\n", describe(cmd), outcome(answer));
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(dir.join(format!("{day}.log"))) {
        let _ = f.write_all(line.as_bytes());
    }
    // Old days go (once in a while is enough: on the first command of a day).
    if let Ok(meta) = fs::metadata(dir.join(format!("{day}.log"))) {
        if meta.len() as usize == line.len() {
            prune(&dir, now);
        }
    }
}

fn prune(dir: &std::path::Path, now: u64) {
    for e in fs::read_dir(dir).into_iter().flatten().flatten() {
        let old = e.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| now.saturating_sub(d.as_secs()) > KEEP_DAYS * 86_400).unwrap_or(false);
        if old && e.path().extension().is_some_and(|x| x == "log") {
            let _ = fs::remove_file(e.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn commands_are_written_without_what_was_typed() {
        let line = describe(&json!({ "op": "type", "selector": "#q", "text": "hunter2", "tab": 4 }));
        assert_eq!(line, "type selector=#q tab=4 text=<7 characters>");
        assert!(!line.contains("hunter2"));
        assert_eq!(describe(&json!({ "op": "eval", "expression": "document.cookie" })), "eval expression=<15 characters>");
        assert_eq!(describe(&json!({ "op": "open", "url": "https://x.org/\nnext" })), "open url=https://x.org/ next");
        assert_eq!(outcome(&json!({ "ok": true })), "ok");
        assert_eq!(outcome(&json!({ "ok": false, "error": "no such tab\nat x" })), "error: no such tab at x");
    }

    #[test]
    fn dates_are_right() {
        assert_eq!(stamp(0), ("1970-01-01".into(), "00:00:00".into()));
        assert_eq!(stamp(1_794_664_283), ("2026-11-14".into(), "13:51:23".into()));
        assert_eq!(stamp(951_782_400), ("2000-02-29".into(), "00:00:00".into()));
    }
}

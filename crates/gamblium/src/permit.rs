//! Agents changing settings: only with the user's permission (owner, Nov 12
//! 2026: "like UAC").
//!
//! A command that changes settings asks here first. With no permission in
//! force the request is written down and the user's own Gamblium, if it is
//! open, shows a page that asks: not now, or allow for 30 minutes, 1, 2 or 6
//! hours, or never ask again. The answer is kept in one file for the Windows
//! user, so it holds for every agent profile and named session.
//!
//! Only a browser the user sits in can give the answer: a helper that
//! belongs to an agent profile refuses to (see `host.rs`).

use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;

/// Minutes the user may choose. 0: not allowed, ask each time. -1: never ask.
pub const CHOICES: [i64; 6] = [0, 30, 60, 120, 360, -1];
/// A question nobody answered is forgotten after this.
const ASK_LIVES_SECS: u64 = 600;
/// The page is not opened again for the same question within this time.
const ASK_QUIET_SECS: u64 = 60;

fn file() -> Option<PathBuf> {
    // Tests point this at a file of their own, so they never touch the user's answer.
    if let Some(f) = std::env::var_os("GAMBLIUM_PERMISSION_FILE") {
        return Some(PathBuf::from(f));
    }
    std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join("Gamblium").join("agent-permission.json"))
}

pub fn load() -> Value {
    file().and_then(|f| fs::read_to_string(f).ok()).and_then(|t| serde_json::from_str(&t).ok()).filter(Value::is_object).unwrap_or_else(|| json!({}))
}

pub fn save(state: &Value) -> Result<(), String> {
    let f = file().ok_or("LOCALAPPDATA is not set")?;
    if let Some(dir) = f.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    // Merged with the file as it is now: an answer the owner saved since this copy was loaded
    // (the newer answeredAt wins) is not undone by a question saved at the same moment, and
    // questions from both are kept (review 9, G18).
    let disk = load();
    let mut out = state.clone();
    if let (Some(o), Some(d)) = (out.as_object_mut(), disk.as_object()) {
        for (k, v) in d {
            if k == "asks" {
                continue;
            }
            let newer = v["answeredAt"].as_u64().unwrap_or(0) > o.get(k).and_then(|x| x["answeredAt"].as_u64()).unwrap_or(0);
            if newer {
                o.insert(k.clone(), v.clone());
            }
        }
        let mut asks: Vec<Value> = o.get("asks").and_then(Value::as_array).cloned().unwrap_or_default();
        for a in d.get("asks").and_then(Value::as_array).into_iter().flatten() {
            let same = |b: &Value| b["what"] == a["what"] && b["command"] == a["command"] && b["profile"] == a["profile"];
            let answered = o.get(a["what"].as_str().unwrap_or("")).and_then(|x| x["answeredAt"].as_u64()).unwrap_or(0) >= a["at"].as_u64().unwrap_or(0);
            if !asks.iter().any(same) && !answered {
                asks.push(a.clone());
            }
        }
        o.insert("asks".into(), json!(asks));
    }
    let tmp = f.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_string_pretty(&out).unwrap()).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &f).map_err(|e| e.to_string())
}

pub fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn known(what: &str) -> Result<(), String> {
    // settings: agents changing settings; logins: agents using the owner's saved logins.
    // person: agents working in a person's own session window, Work (review 6, D2).
    // logins:<site>|<profile>: one site's saved logins for one browser (review 2, 1.6).
    if matches!(what, "settings" | "logins" | "person") || (what.starts_with("logins:") && what.len() <= 300 && !what.chars().any(char::is_control)) { Ok(()) } else { Err(format!("there is no permission called '{what}'")) }
}

pub fn allowed(state: &Value, what: &str, now: u64) -> bool {
    match state[what]["until"].as_i64() {
        Some(-1) => true,
        Some(until) => until > now as i64,
        None => false,
    }
}

/// The user's answer. Any answer settles the open questions.
pub fn grant(state: &mut Value, what: &str, minutes: i64, now: u64) -> Result<(), String> {
    known(what)?;
    if !CHOICES.contains(&minutes) {
        return Err(format!("choose one of {CHOICES:?} minutes (0: ask each time, -1: never ask)"));
    }
    let until = match minutes {
        0 => 0,
        -1 => -1,
        m => now as i64 + m * 60,
    };
    state[what] = json!({ "until": until, "answeredAt": now });
    state["asks"] = json!(asks(state, now).into_iter().filter(|a| a["what"] != what).collect::<Vec<_>>());
    Ok(())
}

/// Questions still waiting for the user.
pub fn asks(state: &Value, now: u64) -> Vec<Value> {
    state["asks"].as_array().into_iter().flatten().filter(|a| a["at"].as_u64().is_some_and(|at| at + ASK_LIVES_SECS > now)).cloned().collect()
}

/// Writes a question down. True if the user should be shown the page now
/// (a new question, or the same one after a quiet while).
pub fn ask(state: &mut Value, what: &str, command: &str, profile: &str, now: u64) -> Result<bool, String> {
    known(what)?;
    let mut list = asks(state, now);
    let same = list.iter().position(|a| a["what"] == what && a["command"] == command && a["profile"] == profile);
    let show = match same {
        Some(i) => {
            let shown = list[i]["shownAt"].as_u64().unwrap_or(0);
            let again = shown + ASK_QUIET_SECS <= now;
            if again {
                list[i]["shownAt"] = json!(now);
            }
            again
        }
        None => {
            list.push(json!({ "what": what, "command": command, "profile": profile, "at": now, "shownAt": now }));
            true
        }
    };
    if list.len() > 20 {
        list.drain(..list.len() - 20);
    }
    state["asks"] = json!(list);
    Ok(show)
}

/// What a page needs to draw the question and the current answer.
pub fn view(state: &Value, what: &str, now: u64) -> Value {
    let until = state[what]["until"].as_i64().unwrap_or(0);
    json!({
        "ok": true,
        "what": what,
        "allowed": allowed(state, what, now),
        "neverAsk": until == -1,
        "until": if until > now as i64 { json!(until) } else { Value::Null },
        "choices": CHOICES,
        "asks": asks(state, now).into_iter().filter(|a| a["what"] == what).collect::<Vec<_>>(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nothing_is_allowed_until_the_user_says_so_and_only_for_the_time_chosen() {
        let mut s = json!({});
        assert!(!allowed(&s, "settings", 1000));
        grant(&mut s, "settings", 30, 1000).unwrap();
        assert!(allowed(&s, "settings", 1000) && allowed(&s, "settings", 1000 + 30 * 60 - 1));
        assert!(!allowed(&s, "settings", 1000 + 30 * 60));
        // Six hours is the longest; never-ask has no end; "not now" takes it away.
        grant(&mut s, "settings", 360, 1000).unwrap();
        assert!(allowed(&s, "settings", 1000 + 6 * 3600 - 1) && !allowed(&s, "settings", 1000 + 6 * 3600));
        grant(&mut s, "settings", -1, 1000).unwrap();
        assert!(allowed(&s, "settings", u32::MAX as u64));
        assert_eq!(view(&s, "settings", 2000)["neverAsk"], json!(true));
        grant(&mut s, "settings", 0, 1000).unwrap();
        assert!(!allowed(&s, "settings", 1000));
        // Other lengths and other names are refused.
        for bad in [1, 45, 361, 720, -2] {
            assert!(grant(&mut s, "settings", bad, 1000).is_err(), "{bad}");
        }
        assert!(grant(&mut s, "everything", 30, 1000).is_err());
    }

    #[test]
    fn a_question_is_shown_once_then_kept_quiet_and_an_answer_settles_it() {
        let mut s = json!({});
        assert!(ask(&mut s, "settings", "proxy-set", "work", 1000).unwrap());
        // The same question again straight away: written down already, not shown again.
        assert!(!ask(&mut s, "settings", "proxy-set", "work", 1010).unwrap());
        assert_eq!(asks(&s, 1010).len(), 1);
        // After a quiet minute it may be shown again; another command is another question.
        assert!(ask(&mut s, "settings", "proxy-set", "work", 1061).unwrap());
        assert!(ask(&mut s, "settings", "settings-set", "work", 1062).unwrap());
        assert_eq!(view(&s, "settings", 1062)["asks"].as_array().unwrap().len(), 2);
        // Unanswered questions are forgotten after ten minutes.
        assert_eq!(asks(&s, 1000 + 601).len(), 1);
        // Any answer clears them.
        grant(&mut s, "settings", 0, 1100).unwrap();
        assert!(asks(&s, 1100).is_empty());
        assert!(ask(&mut s, "nonsense", "x", "work", 1000).is_err());
    }
}

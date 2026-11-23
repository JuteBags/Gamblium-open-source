//! Lyrics: LRCLIB lookup (only title, artist, album and duration are sent; no cookies, no
//! account), a cache on disk, and the LRC parser.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Clone, Debug, PartialEq)]
pub struct Line {
    pub at_ms: i64,
    pub text: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Found {
    pub synced: Option<String>,
    pub plain: Option<String>,
    pub source: String,
    /// The found song's length (LRCLIB's), to compare with the video's.
    #[serde(default)]
    pub duration: Option<f64>,
}

#[derive(Clone, Debug, Default)]
pub struct Track {
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration_s: f64,
    /// The song's picture (address), for the card.
    pub art: String,
}

/// `[mm:ss.xx] text` lines; several stamps on one line each get the text. Sorted by time.
pub fn parse(lrc: &str) -> Vec<Line> {
    let mut out = Vec::new();
    for raw in lrc.lines() {
        let mut rest = raw.trim();
        let mut stamps = Vec::new();
        while let Some(stripped) = rest.strip_prefix('[') {
            let Some(end) = stripped.find(']') else { break };
            let tag = &stripped[..end];
            rest = stripped[end + 1..].trim_start();
            if let Some(ms) = stamp(tag) {
                stamps.push(ms);
            }
        }
        for ms in stamps {
            out.push(Line { at_ms: ms, text: rest.trim().to_owned() });
        }
    }
    out.sort_by_key(|l| l.at_ms);
    out
}

fn stamp(tag: &str) -> Option<i64> {
    let (m, s) = tag.split_once(':')?;
    let m: i64 = m.trim().parse().ok()?;
    let s: f64 = s.trim().replace(',', ".").parse().ok()?;
    Some(m * 60_000 + (s * 1000.0).round() as i64)
}

/// Unsynced lyrics: one line every few seconds across the song, so they still scroll.
pub fn spread(plain: &str, duration_s: f64) -> Vec<Line> {
    let lines: Vec<&str> = plain.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    if lines.is_empty() {
        return Vec::new();
    }
    let step = ((duration_s.max(60.0) * 1000.0) / (lines.len() as f64 + 1.0)) as i64;
    lines.iter().enumerate().map(|(i, t)| Line { at_ms: step * (i as i64 + 1), text: (*t).to_owned() }).collect()
}

/// The line showing at `ms` (the last one that has started), or None before the first.
pub fn current(lines: &[Line], ms: i64) -> Option<usize> {
    let i = lines.partition_point(|l| l.at_ms <= ms);
    if i == 0 { None } else { Some(i - 1) }
}

/// The song's own name out of a video title: brackets, "| ...", "#tags", "ft. ..." and
/// "(Official Video)" style words removed. Keeps " - " (see `guesses` for that).
pub fn clean_title(t: &str) -> String {
    let mut s = String::new();
    let mut depth = 0i32;
    for c in t.chars() {
        match c {
            '(' | '[' | '{' | '【' => depth += 1,
            ')' | ']' | '}' | '】' => depth = (depth - 1).max(0),
            _ if depth == 0 => s.push(c),
            _ => {}
        }
    }
    for cut in [" |", " ｜", " #", " ft.", " feat.", " Ft.", " Feat.", " FT.", " x ", " X "] {
        if let Some(i) = s.find(cut) {
            if i > 0 {
                s.truncate(i);
            }
        }
    }
    let lower = s.to_lowercase();
    let mut out = s.clone();
    for noise in ["official music video", "official video", "official audio", "lyric video", "lyrical video", "full video", "music video", "lyrics", "audio", "video song"] {
        if let Some(i) = lower.rfind(noise) {
            if i > 0 && i + noise.len() >= lower.trim_end().len() {
                out.truncate(i);
            }
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ").trim_matches(|c: char| c == '"' || c == '-' || c == '–' || c == '|' || c.is_whitespace()).to_owned()
}

/// A channel name as an artist: "Anuv Jain - Topic" -> "Anuv Jain", "ArijitSinghVEVO" -> "ArijitSingh".
pub fn clean_artist(a: &str) -> String {
    let mut s = a.trim().to_owned();
    for tail in [" - Topic", "VEVO", " Official", " Music"] {
        if s.ends_with(tail) && s.len() > tail.len() {
            s.truncate(s.len() - tail.len());
        }
    }
    s.trim().to_owned()
}

/// Lowercase Latin words: Devanagari is written in Hinglish first, everything else not a letter
/// or digit is a space. What titles and lyric lines are compared by.
pub fn words(s: &str) -> Vec<String> {
    let s = if crate::hinglish::is_devanagari(s) { crate::hinglish::line(s) } else { s.to_owned() };
    s.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(|w| w.to_owned())
        .collect()
}

/// How alike two names are, 0-1: shared words over the shorter name's words.
pub fn alike(a: &str, b: &str) -> f64 {
    let (wa, wb) = (words(a), words(b));
    if wa.is_empty() || wb.is_empty() {
        return 0.0;
    }
    let shared = wa.iter().filter(|w| wb.contains(w)).count() as f64;
    shared / wa.len().min(wb.len()) as f64
}

/// (song, artist) guesses from a video title and channel. "Anuv Jain - Alag Aasmaan (Official
/// Video)" by channel "Anuv Jain" gives ("Alag Aasmaan", "Anuv Jain") first (owner, Nov 23 2026:
/// the title was cut at " - " and another Anuv Jain song's lyrics showed).
pub fn guesses(t: &Track) -> Vec<(String, String)> {
    let artist = clean_artist(&t.artist);
    let title = clean_title(&t.title);
    let mut out: Vec<(String, String)> = Vec::new();
    let mut push = |s: &str, a: &str| {
        let s = s.trim().to_owned();
        if !s.is_empty() && !out.iter().any(|(x, y)| x == &s && y == a) {
            out.push((s, a.trim().to_owned()));
        }
    };
    let parts: Vec<&str> = title.split(|c| c == '-' || c == '–' || c == '—').map(str::trim).filter(|p| !p.is_empty()).collect();
    if parts.len() >= 2 {
        let (left, right) = (parts[0], parts[1..].join(" "));
        // The side that is the artist is not the song.
        if !artist.is_empty() && alike(left, &artist) >= 0.5 {
            push(&right, &artist);
        } else if !artist.is_empty() && alike(&right, &artist) >= 0.5 {
            push(left, &artist);
        } else {
            push(&right, left);
            push(left, &right);
            push(&right, &artist);
            push(left, &artist);
        }
    }
    push(&title, &artist);
    out
}

fn cache_dir() -> Option<PathBuf> {
    // v2: lookups before Nov 23 2026 could hold another song's lyrics.
    std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join("Gamblium").join("lyrics").join("cache-v2"))
}

fn cache_key(t: &Track) -> String {
    let k = format!("{}|{}|{}", t.title.to_lowercase(), t.artist.to_lowercase(), t.duration_s.round() as i64);
    let mut h: u64 = 0xcbf29ce484222325;
    for b in k.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}.json")
}

#[derive(Deserialize, Clone)]
struct LrcLib {
    #[serde(rename = "syncedLyrics")]
    synced: Option<String>,
    #[serde(rename = "plainLyrics")]
    plain: Option<String>,
    duration: Option<f64>,
    #[serde(rename = "trackName")]
    track: Option<String>,
    #[serde(rename = "artistName")]
    artist: Option<String>,
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(12))
        .user_agent("Gamblium lyrics (https://github.com/JuteBags/Gamblium-open-source)")
        .build()
}

/// Synced lyrics if there are any, else plain. Cached on disk so a replay asks nobody; a song
/// with none found is not cached (it may be added to LRCLIB later).
pub fn find(t: &Track) -> Result<Found, String> {
    let key = cache_key(t);
    if let Some(dir) = cache_dir() {
        if let Ok(text) = std::fs::read_to_string(dir.join(&key)) {
            if let Ok(f) = serde_json::from_str::<Found>(&text) {
                return Ok(f);
            }
        }
    }
    let found = lookup(t)?;
    if let Some(dir) = cache_dir() {
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::write(dir.join(&key), serde_json::to_string(&found).unwrap_or_default());
    }
    Ok(found)
}

/// How well a result fits a guess: the song's name must match (else 0), then the artist, then the
/// length (a music video may be longer than the song: an intro, an ending).
/// Words that name a recording, not a song: "Alag Aasmaan (a song on the ukulele)" is not the
/// studio "Alag Aasmaan" (owner, Nov 23 2026: the studio timings ran against the ukulele video).
const VERSIONS: [&str; 15] = ["ukulele", "acoustic", "unplugged", "live", "remix", "slowed", "reverb", "lofi", "reprise", "cover", "instrumental", "karaoke", "paused", "sped", "studio"];

/// `raw` is the whole video title, version words and all.
fn fit(x: &LrcLib, song: &str, artist: &str, duration_s: f64, raw: &str) -> f64 {
    let track = x.track.as_deref().unwrap_or("");
    let name = alike(track, song).max(alike(track, raw));
    if name < 0.6 {
        return 0.0;
    }
    let mut s = name * 2.0;
    // Exactly the song's name (not "Alag Aasmaan(PaglaSongs)", a re-upload with extra words).
    if words(track) == words(song) {
        s += 0.5;
    }
    // Filed under the video's own title: this very recording.
    if !raw.is_empty() && words(track) == words(raw) {
        s += 3.0;
    }
    let (rw, xw) = (words(raw), words(&format!("{track} {}", x.artist.as_deref().unwrap_or(""))));
    for v in VERSIONS {
        let (in_raw, in_x) = (rw.iter().any(|w| w == v), xw.iter().any(|w| w == v));
        s += match (in_raw, in_x) {
            (true, true) => 1.0,
            (true, false) => -0.7,
            (false, true) => -1.5,
            _ => 0.0,
        };
    }
    if !artist.is_empty() {
        s += alike(x.artist.as_deref().unwrap_or(""), artist);
    }
    if duration_s > 0.0 {
        if let Some(d) = x.duration {
            let gap = duration_s - d;
            s += if gap.abs() <= 3.0 { 1.0 } else if (-5.0..=90.0).contains(&gap) { 0.4 } else { -1.0 };
        }
    }
    if x.synced.is_some() {
        s += 0.5;
    }
    s
}

fn lookup(t: &Track) -> Result<Found, String> {
    let a = agent();
    let mut seen: Vec<(LrcLib, f64)> = Vec::new();
    // The whole title first: a recording filed under the video's own name (versions and all).
    let first = guesses(t).into_iter().next().unwrap_or_default();
    if let Ok(r) = a.get("https://lrclib.net/api/search").query("q", t.title.trim()).call() {
        if let Ok(list) = r.into_json::<Vec<LrcLib>>() {
            for x in list.into_iter().take(20) {
                let f = fit(&x, &first.0, &first.1, t.duration_s, &t.title);
                seen.push((x, f));
            }
        }
    }
    for (song, artist) in guesses(t).into_iter().take(4) {
        if seen.iter().any(|(_, f)| *f >= 6.0) {
            break;
        }
        if !artist.is_empty() {
            if let Ok(r) = a.get("https://lrclib.net/api/get").query("track_name", &song).query("artist_name", &artist).call() {
                if let Ok(x) = r.into_json::<LrcLib>() {
                    let f = fit(&x, &song, &artist, t.duration_s, &t.title);
                    seen.push((x, f));
                }
            }
        }
        let q = format!("{song} {artist}").trim().to_owned();
        if let Ok(r) = a.get("https://lrclib.net/api/search").query("q", &q).call() {
            if let Ok(list) = r.into_json::<Vec<LrcLib>>() {
                for x in list.into_iter().take(20) {
                    let f = fit(&x, &song, &artist, t.duration_s, &t.title);
                    seen.push((x, f));
                }
            }
        }
        // A sure match: name, artist and length all fit.
        if seen.iter().any(|(_, f)| *f >= 4.0) {
            break;
        }
    }
    let best = seen.into_iter().filter(|(x, f)| *f > 0.0 && (x.synced.is_some() || x.plain.is_some())).max_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
    match best {
        Some((x, f)) => Ok(Found {
            synced: x.synced.clone(),
            plain: x.plain.clone(),
            source: format!("lrclib: {} - {} ({:.0} s, fit {f:.1})", x.track.clone().unwrap_or_default(), x.artist.clone().unwrap_or_default(), x.duration.unwrap_or(0.0)),
            duration: x.duration,
        }),
        None => Err(format!("no lyrics found for \"{}\"", clean_title(&t.title))),
    }
}

/// Whether automatic captions look like the song's words: enough lines of several words each.
/// YouTube decides a song's language once; a Hindi song taken for English gets "do", "i",
/// "foreign" (owner, Nov 23 2026, Alag Aasmaan): such captions are neither shown nor used as the clock.
pub fn usable_auto(lines: &[Line]) -> bool {
    let said: Vec<usize> = lines.iter().map(|l| words(&l.text).len()).filter(|n| *n > 0).collect();
    said.len() >= 8 && said.iter().sum::<usize>() as f64 / said.len() as f64 >= 2.5
}

/// Moves lyrics onto this video's own clock: each lyric line is matched with the automatic
/// caption that says the same words, and the typical gap between them (an intro the song's
/// timings do not have) is the shift. None when too few lines match to be sure.
pub fn shift_to(lines: &[Line], anchors: &[Line]) -> Option<i64> {
    let aw: Vec<Vec<String>> = anchors.iter().map(|a| words(&a.text)).collect();
    let mut gaps = Vec::new();
    for l in lines {
        let lw = words(&l.text);
        if lw.len() < 2 {
            continue;
        }
        let mut best = (0.0, 0usize);
        for (j, w) in aw.iter().enumerate() {
            if w.is_empty() {
                continue;
            }
            let shared = lw.iter().filter(|x| w.contains(x)).count() as f64;
            let score = shared / lw.len().max(w.len()) as f64;
            if score > best.0 {
                best = (score, j);
            }
        }
        if best.0 >= 0.45 {
            gaps.push(anchors[best.1].at_ms - l.at_ms);
        }
    }
    if gaps.len() < 3 {
        return None;
    }
    gaps.sort();
    let mid = gaps[gaps.len() / 2];
    // Most matches must agree on it (a repeated chorus matches the wrong repeat sometimes).
    let agree = gaps.iter().filter(|g| (*g - mid).abs() <= 1500).count();
    (agree * 2 >= gaps.len()).then_some(mid)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lrc_lines_are_parsed_and_sorted() {
        let l = parse("[ar:x]\n[00:12.50]second\n[00:01.00][00:30.00]first and again\nno stamp\n");
        assert_eq!(l.len(), 3);
        assert_eq!(l[0], Line { at_ms: 1000, text: "first and again".into() });
        assert_eq!(l[1].at_ms, 12_500);
        assert_eq!(l[2].at_ms, 30_000);
        assert_eq!(current(&l, 500), None);
        assert_eq!(current(&l, 12_500), Some(1));
        assert_eq!(current(&l, 99_000), Some(2));
    }

    #[test]
    fn titles_are_cleaned_for_lookup() {
        assert_eq!(clean_title("KALYANI (with Shreya Ghoshal) by ARJN | KDS"), "KALYANI by ARJN");
        assert_eq!(clean_title("Tum Hi Ho | Aashiqui 2"), "Tum Hi Ho");
        assert_eq!(clean_title("Anuv Jain - Alag Aasmaan (Official Video)"), "Anuv Jain - Alag Aasmaan");
        assert_eq!(clean_title("Alag Aasmaan Official Video"), "Alag Aasmaan");
        assert_eq!(clean_artist("Anuv Jain - Topic"), "Anuv Jain");
    }

    #[test]
    fn the_artist_side_of_a_title_is_not_the_song() {
        let t = Track { title: "Anuv Jain - Alag Aasmaan (Official Video)".into(), artist: "Anuv Jain".into(), album: String::new(), duration_s: 240.0, art: String::new() };
        assert_eq!(guesses(&t)[0], ("Alag Aasmaan".to_owned(), "Anuv Jain".to_owned()));
        let t = Track { title: "Alag Aasmaan - Anuv Jain".into(), artist: "Some Label".into(), album: String::new(), duration_s: 0.0, art: String::new() };
        assert_eq!(guesses(&t)[0], ("Anuv Jain".to_owned(), "Alag Aasmaan".to_owned()));
        assert!(guesses(&t).contains(&("Alag Aasmaan".to_owned(), "Anuv Jain".to_owned())));
    }

    #[test]
    fn another_song_by_the_artist_does_not_fit() {
        let gul = LrcLib { synced: Some("[00:01.00]x".into()), plain: None, duration: Some(200.0), track: Some("GUL (Studio)".into()), artist: Some("Anuv Jain".into()) };
        assert_eq!(fit(&gul, "Alag Aasmaan", "Anuv Jain", 240.0, "Anuv Jain - Alag Aasmaan (Official Video)"), 0.0);
        let right = LrcLib { synced: Some("[00:01.00]x".into()), plain: None, duration: Some(238.0), track: Some("Alag Aasmaan".into()), artist: Some("Anuv Jain".into()) };
        assert!(fit(&right, "Alag Aasmaan", "Anuv Jain", 240.0, "Anuv Jain - Alag Aasmaan (Official Video)") >= 4.0);
        // The ukulele video: its own recording beats the studio song, an acoustic one loses.
        let raw = "Anuv Jain - ALAG AASMAAN (a song on the ukulele)";
        let uke = LrcLib { synced: Some("[00:16.86]x".into()), plain: None, duration: Some(225.0), track: Some(raw.into()), artist: Some("Anuv Jain".into()) };
        let studio = LrcLib { synced: Some("[00:17.27]x".into()), plain: None, duration: Some(209.0), track: Some("Alag Aasmaan".into()), artist: Some("Anuv Jain".into()) };
        let acoustic = LrcLib { synced: Some("[00:09.60]x".into()), plain: None, duration: Some(212.0), track: Some("Alag Aasmaan (Acoustic)".into()), artist: Some("Anuv Jain".into()) };
        let (u, st, ac) = (fit(&uke, "ALAG AASMAAN", "Anuv Jain", 0.0, raw), fit(&studio, "ALAG AASMAAN", "Anuv Jain", 0.0, raw), fit(&acoustic, "ALAG AASMAAN", "Anuv Jain", 0.0, raw));
        assert!(u > st && st > ac, "{u} {st} {ac}");
    }

    #[test]
    fn lyrics_move_onto_the_videos_clock() {
        let lyr = parse("[00:10.00]tu hai kahaan main hoon yahaan\n[00:15.00]alag aasmaan alag zameen\n[00:20.00]phir bhi mile hum kahin\n[00:25.00]jo na mile woh sahi");
        // The video has a 12 s intro: its automatic captions run 12 s later.
        let cap = parse("[00:22.10]tu hai kahan main hu yahaan\n[00:27.00]alag aasmaan alag zameen\n[00:32.20]phir bhi mile hum kahin\n[00:37.00]jo na mile woh sahi");
        let s = shift_to(&lyr, &cap).unwrap();
        assert!((11_900..=12_200).contains(&s), "{s}");
        assert_eq!(shift_to(&lyr, &parse("[00:01.00]something else entirely")), None);
    }

    #[test]
    fn automatic_captions_in_the_wrong_language_are_not_used() {
        // Alag Aasmaan's real automatic captions (YouTube took the song for English).
        let junk = parse("[00:14.92]do\n[00:29.84]i\n[00:31.95]me\n[02:20.87]m\n[03:02.84]foreign\n[03:16.84]foreign\n[03:45.28]you");
        assert!(!usable_auto(&junk));
        let real: String = (0..10).map(|i| format!("[00:{:02}.00]jo teri khaatir tadpe pahle se hi\n", i * 5)).collect();
        assert!(usable_auto(&parse(&real)));
    }
}

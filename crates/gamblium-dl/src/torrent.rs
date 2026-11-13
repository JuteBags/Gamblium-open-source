//! Torrents and magnet links, on librqbit (Apache-2.0).
//!
//! One torrent per run, saved into the chosen folder. Peers come from the
//! torrent's trackers and the DHT. While it downloads it also gives pieces
//! to other peers, as the protocol expects; when it is complete the program
//! ends, unless `--seed-minutes` asks it to stay and keep sharing.
//! Run again with the same folder and it checks what is there and continues.

use crate::http::{mb, Done, Options};
use librqbit::{AddTorrent, AddTorrentOptions, AddTorrentResponse, Session, SessionOptions};
use serde_json::json;
use std::time::{Duration, Instant};

/// Is this something the torrent engine should take?
pub fn is_torrent(address: &str) -> bool {
    let lower = address.to_ascii_lowercase();
    let path = lower.split(['?', '#']).next().unwrap_or("");
    lower.starts_with("magnet:") || path.ends_with(".torrent")
}

/// The peers we are connected to, busiest first: address, program, bytes
/// taken from and given to each. At most 60, so the state file stays small.
fn peer_list(handle: &librqbit::ManagedTorrent) -> serde_json::Value {
    let Some(live) = handle.live() else { return json!([]) };
    let snapshot = serde_json::to_value(live.per_peer_stats_snapshot(Default::default())).unwrap_or_default();
    let mut peers: Vec<serde_json::Value> = snapshot["peers"]
        .as_object()
        .map(|m| {
            m.iter()
                .map(|(addr, p)| json!({ "addr": addr, "client": p["client_name"], "state": p["state"], "down": p["counters"]["fetched_bytes"], "up": p["counters"]["uploaded_bytes"] }))
                .collect()
        })
        .unwrap_or_default();
    peers.sort_by_key(|p| std::cmp::Reverse(p["down"].as_u64().unwrap_or(0) + p["up"].as_u64().unwrap_or(0)));
    peers.truncate(60);
    json!(peers)
}

/// The files in the torrent with how much of each is here.
fn file_list(handle: &librqbit::ManagedTorrent, progress: &[u64]) -> serde_json::Value {
    let files = handle
        .with_metadata(|m| m.file_infos.iter().map(|f| (f.relative_filename.to_string_lossy().into_owned(), f.len)).collect::<Vec<_>>())
        .unwrap_or_default();
    json!(files.iter().enumerate().map(|(i, (name, len))| json!({ "name": name, "size": len, "done": progress.get(i).copied().unwrap_or(0) })).collect::<Vec<_>>())
}

fn report(o: &Options, value: serde_json::Value, plain: impl FnOnce() -> String) {
    crate::status::event(&value);
    if o.json {
        println!("{value}");
    } else if !o.quiet {
        eprintln!("{}", plain());
    }
}

pub fn download(o: &Options, seed_minutes: u64, use_web_seed: bool) -> Result<Done, String> {
    let started = Instant::now();
    // A torrent file may also name an ordinary address of the same file (a
    // "web seed"). That is fetched first, with our own splitter; the torrent
    // engine then checks every piece against the torrent's hashes, fetches
    // from peers whatever is missing or wrong, and shares if asked to.
    if let Some(seed) = use_web_seed.then(|| torrent_bytes(&o.urls[0])).flatten().as_deref().and_then(web_seed) {
        from_web_seed(o, &seed);
    }
    let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().map_err(|e| e.to_string())?;
    runtime.block_on(run(o, seed_minutes, started))
}

/// What a torrent file says about an ordinary address of its one file.
#[derive(Debug, PartialEq)]
pub struct WebSeed {
    pub urls: Vec<String>,
    pub name: String,
    pub size: u64,
}

/// Slower than this on average after `WEB_SEED_TRIAL`, and the peers are asked
/// instead. The trial was 12 s; with a slow web address that was 12 s of
/// nothing (tester: 60 s against ~50 s for the same torrent). Our splitter
/// has two or three connections up within a few seconds, which is enough to
/// tell 512 KiB/s from a server that is throttled.
const WEB_SEED_FLOOR: f64 = 512.0 * 1024.0;
const WEB_SEED_TRIAL: Duration = Duration::from_secs(5);
/// No byte at all for this long: the web address is left.
const WEB_SEED_SILENT: Duration = Duration::from_secs(8);

fn torrent_bytes(source: &str) -> Option<Vec<u8>> {
    if source.to_ascii_lowercase().starts_with("magnet:") {
        return None; // the torrent's own description comes from peers later
    }
    if source.starts_with("http://") || source.starts_with("https://") {
        let resp = ureq::AgentBuilder::new().timeout(Duration::from_secs(15)).build().get(source).call().ok()?;
        let mut bytes = Vec::new();
        std::io::Read::read_to_end(&mut std::io::Read::take(resp.into_reader(), 16 * 1024 * 1024), &mut bytes).ok()?;
        return Some(bytes);
    }
    std::fs::read(source).ok()
}

enum Ben<'a> {
    Int(i64),
    Bytes(&'a [u8]),
    List(Vec<Ben<'a>>),
    Dict(Vec<(&'a [u8], Ben<'a>)>),
}

/// Reads one value of a torrent file's format at `*at`. None if it is damaged.
fn ben<'a>(b: &'a [u8], at: &mut usize, depth: usize) -> Option<Ben<'a>> {
    if depth > 32 {
        return None;
    }
    match *b.get(*at)? {
        b'i' => {
            let end = *at + b[*at..].iter().position(|&c| c == b'e')?;
            let n = std::str::from_utf8(&b[*at + 1..end]).ok()?.parse().ok()?;
            *at = end + 1;
            Some(Ben::Int(n))
        }
        b'l' | b'd' => {
            let dict = b[*at] == b'd';
            *at += 1;
            let (mut list, mut pairs) = (Vec::new(), Vec::new());
            while *b.get(*at)? != b'e' {
                if dict {
                    let Ben::Bytes(key) = ben(b, at, depth + 1)? else { return None };
                    pairs.push((key, ben(b, at, depth + 1)?));
                } else {
                    list.push(ben(b, at, depth + 1)?);
                }
            }
            *at += 1;
            Some(if dict { Ben::Dict(pairs) } else { Ben::List(list) })
        }
        b'0'..=b'9' => {
            let colon = *at + b[*at..].iter().position(|&c| c == b':')?;
            let len: usize = std::str::from_utf8(&b[*at..colon]).ok()?.parse().ok()?;
            let end = colon.checked_add(1)?.checked_add(len)?;
            let bytes = b.get(colon + 1..end)?;
            *at = end;
            Some(Ben::Bytes(bytes))
        }
        _ => None,
    }
}

fn get<'a, 'b>(dict: &'b Ben<'a>, key: &str) -> Option<&'b Ben<'a>> {
    match dict {
        Ben::Dict(pairs) => pairs.iter().find(|(k, _)| *k == key.as_bytes()).map(|(_, v)| v),
        _ => None,
    }
}

/// The web addresses of a one-file torrent, if it names any. A torrent of
/// several files is left to the peers.
pub fn web_seed(torrent: &[u8]) -> Option<WebSeed> {
    let top = ben(torrent, &mut 0, 0)?;
    let info = get(&top, "info")?;
    if get(info, "files").is_some() {
        return None;
    }
    let Ben::Bytes(name) = get(info, "name")? else { return None };
    let name = std::str::from_utf8(name).ok()?.to_owned();
    // The name becomes a file name in the download folder: nothing that leaves it.
    if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\', ':']) {
        return None;
    }
    let Ben::Int(size) = get(info, "length")? else { return None };
    let size = u64::try_from(*size).ok().filter(|s| *s > 0)?;
    let listed: Vec<&[u8]> = match get(&top, "url-list")? {
        Ben::Bytes(one) => vec![*one],
        Ben::List(many) => many.iter().filter_map(|v| if let Ben::Bytes(b) = v { Some(*b) } else { None }).collect(),
        _ => return None,
    };
    let mut urls: Vec<String> = Vec::new();
    for raw in listed {
        let Ok(text) = std::str::from_utf8(raw) else { continue };
        if !(text.starts_with("http://") || text.starts_with("https://")) {
            continue;
        }
        // An address ending in "/" is a folder: the file's name goes after it.
        let full = if text.ends_with('/') { format!("{text}{}", name.replace('%', "%25").replace(' ', "%20").replace('#', "%23").replace('?', "%3F")) } else { text.to_owned() };
        if !urls.contains(&full) && urls.len() < 8 {
            urls.push(full);
        }
    }
    (!urls.is_empty()).then_some(WebSeed { urls, name, size })
}

/// Fetches the file from its web address into the place the torrent engine
/// will look. Whatever goes wrong here is not an error: the peers are next.
fn from_web_seed(o: &Options, seed: &WebSeed) {
    let target = o.dir.join(&seed.name);
    // Something is there already (whole, or pieces from an earlier run): the engine checks it.
    if target.exists() {
        return;
    }
    report(o, json!({ "event": "web-seed", "sources": seed.urls.len() }), || format!("{} web address(es) in the torrent: fetching from there first", seed.urls.len()));
    let web = Options {
        urls: seed.urls.clone(),
        out: Some(target.clone()),
        dir: o.dir.clone(),
        max_connections: o.max_connections,
        headers: Vec::new(), // a login for the torrent's site is not for another server
        json: o.json,
        quiet: o.quiet,
        give_up_after: WEB_SEED_SILENT,
        status_details: o.status_details,
        start_connections: o.start_connections,
        too_slow: Some((WEB_SEED_FLOOR, WEB_SEED_TRIAL)),
    };
    let left = match crate::http::download(&web) {
        Ok(d) if d.bytes == seed.size => None,
        Ok(d) => Some(format!("the web address gave {} bytes, the torrent says {}", d.bytes, seed.size)),
        // Without the downloader's "run the same command to continue": the peers take over by themselves.
        Err(e) => Some(match e.rsplit_once(". ") {
            Some((why, tail)) if tail.ends_with("to continue") => why.to_owned(),
            _ => e,
        }),
    };
    if let Some(why) = left {
        // A file of the wrong size is of no use to the engine; half-fetched pieces are not kept.
        let _ = std::fs::remove_file(&target);
        for tail in [".part", ".part.state"] {
            let mut p = target.as_os_str().to_owned();
            p.push(tail);
            let _ = std::fs::remove_file(std::path::PathBuf::from(p));
        }
        report(o, json!({ "event": "web-seed-left", "error": why }), || format!("web address left ({why}); asking peers"));
    }
}

async fn run(o: &Options, seed_minutes: u64, started: Instant) -> Result<Done, String> {
    std::fs::create_dir_all(&o.dir).map_err(|e| format!("{}: {e}", o.dir.display()))?;
    let session = Session::new_with_opts(o.dir.clone(), SessionOptions { fastresume: true, ..Default::default() })
        .await
        .map_err(|e| format!("could not start the torrent engine: {e:#}"))?;
    let source = AddTorrent::from_cli_argument(&o.urls[0]).map_err(|e| format!("{}: {e:#}", o.urls[0]))?;
    // Existing files are checked piece by piece and kept, which is how a
    // stopped torrent continues.
    let added = session
        .add_torrent(source, Some(AddTorrentOptions { overwrite: true, ..Default::default() }))
        .await
        .map_err(|e| format!("could not add the torrent: {e:#}"))?;
    let handle = match added {
        AddTorrentResponse::Added(_, h) | AddTorrentResponse::AlreadyManaged(_, h) => h,
        AddTorrentResponse::ListOnly(_) => return Err("the torrent was only listed".into()),
    };
    let name = handle.name().unwrap_or_else(|| "torrent".into());
    let path = o.dir.join(&name);
    let total = handle.stats().total_bytes;
    report(o, json!({ "event": "start", "kind": "torrent", "path": path, "size": total, "split": true, "sources": 1 }), || {
        format!("{} ({}), torrent", path.display(), mb(total as f64))
    });

    let mut peak = 0usize;
    let (mut quiet_since, mut quiet_done) = (Instant::now(), 0u64);
    loop {
        tokio::time::sleep(Duration::from_secs(1)).await;
        let s = handle.stats();
        if let Some(e) = &s.error {
            return Err(format!("the torrent stopped: {e}"));
        }
        let live = s.live.as_ref();
        let peers = live.map(|l| l.snapshot.peer_stats.live as usize).unwrap_or(0);
        let speed = live.map(|l| l.download_speed.mbps * 1_048_576.0).unwrap_or(0.0);
        let up = live.map(|l| l.upload_speed.mbps * 1_048_576.0).unwrap_or(0.0);
        peak = peak.max(peers);
        // The lists go into the state file; the --json stream stays one short line.
        if o.status_details {
            crate::status::event(&json!({ "event": "details", "peerList": peer_list(&handle), "files": file_list(&handle, &s.file_progress) }));
        }
        report(
            o,
            json!({ "event": "progress", "kind": "torrent", "done": s.progress_bytes, "total": s.total_bytes, "speed": speed, "connections": peers, "peers": peers, "up": up, "uploaded": s.uploaded_bytes }),
            || format!("{:>5.1}%  {}/s  {} peer(s)", s.progress_bytes as f64 * 100.0 / s.total_bytes.max(1) as f64, mb(speed), peers),
        );
        if s.finished {
            break;
        }
        if s.progress_bytes != quiet_done {
            (quiet_since, quiet_done) = (Instant::now(), s.progress_bytes);
        } else if quiet_since.elapsed() >= o.give_up_after.max(Duration::from_secs(180)) {
            // Finding the first peers of a magnet link can take a minute or two.
            return Err(format!("nothing arrived for {} s (no peers, or none that has the file)", quiet_since.elapsed().as_secs()));
        }
    }
    let total = handle.stats().total_bytes;
    let seconds = started.elapsed().as_secs_f64();

    if seed_minutes > 0 {
        let until = Instant::now() + Duration::from_secs(seed_minutes * 60);
        while Instant::now() < until {
            tokio::time::sleep(Duration::from_secs(2)).await;
            let s = handle.stats();
            let live = s.live.as_ref();
            let peers = live.map(|l| l.snapshot.peer_stats.live).unwrap_or(0);
            let up = live.map(|l| l.upload_speed.mbps * 1_048_576.0).unwrap_or(0.0);
            let ratio = s.uploaded_bytes as f64 / total.max(1) as f64;
            if o.status_details {
                crate::status::event(&json!({ "event": "details", "peerList": peer_list(&handle), "files": file_list(&handle, &s.file_progress) }));
            }
            report(o, json!({ "event": "seeding", "uploaded": s.uploaded_bytes, "ratio": ratio, "peers": peers, "up": up }), || {
                format!("sharing: {} sent, {} peer(s)", mb(s.uploaded_bytes as f64), peers)
            });
        }
    }
    session.stop().await;
    Ok(Done { path, bytes: total, seconds, connections: peak })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn magnet_links_and_torrent_files_go_to_the_torrent_engine() {
        assert!(is_torrent("magnet:?xt=urn:btih:cab507494d02ebb1178b38f2e9d7be299c86b862"));
        assert!(is_torrent("MAGNET:?xt=urn:btih:abc"));
        assert!(is_torrent("https://cdimage.debian.org/x/debian.iso.torrent"));
        assert!(is_torrent("https://x.org/a.TORRENT?download=1"));
        assert!(is_torrent(r"C:\Users\me\Downloads\debian.torrent"));
        assert!(!is_torrent("https://x.org/debian.iso"));
        assert!(!is_torrent("https://x.org/torrent/list.html"));
        assert!(!is_torrent("https://x.org/a.iso?name=b.torrent"));
    }

    fn torrent(url_list: &str, info: &str) -> Vec<u8> {
        format!("d8:announce20:http://t.example/ann{url_list}4:infod{info}ee").into_bytes()
    }

    #[test]
    fn a_one_file_torrent_gives_its_web_addresses() {
        let info = "6:lengthi441450496e4:name8:file.iso12:piece lengthi262144e6:pieces0:";
        // One address, as a text.
        let t = torrent("8:url-list99:https://cd.example/x/file.iso", info);
        assert_eq!(web_seed(&t), None, "a damaged file is refused, not guessed at");
        let t = torrent("8:url-list29:https://cd.example/x/file.iso", info);
        assert_eq!(web_seed(&t), Some(WebSeed { urls: vec!["https://cd.example/x/file.iso".into()], name: "file.iso".into(), size: 441450496 }));
        // A list; a folder address gets the name; other schemes and repeats are dropped.
        let t = torrent("8:url-listl20:https://a.example/d/20:ftp://b.example/file20:https://a.example/d/27:http://c.example/m/file.isoe", info);
        assert_eq!(web_seed(&t).unwrap().urls, ["https://a.example/d/file.iso", "http://c.example/m/file.iso"]);
    }

    #[test]
    fn no_web_address_no_single_file_or_a_name_that_leaves_the_folder_means_peers_only() {
        let one = "6:lengthi10e4:name8:file.iso";
        assert_eq!(web_seed(&torrent("", one)), None);
        let many = "5:filesld6:lengthi5e4:pathl1:aeee4:name3:dir";
        assert_eq!(web_seed(&torrent("8:url-list22:https://cd.example/dir", many)), None);
        for name in ["11:../evil.iso", "10:a/evil.iso", "2:..", "9:C:evil.is"] {
            let info = format!("6:lengthi10e4:name{name}");
            assert_eq!(web_seed(&torrent("8:url-list22:https://cd.example/dir", &info)), None, "{name}");
        }
        assert_eq!(web_seed(b"not a torrent"), None);
        assert_eq!(web_seed(b"d4:infod6:lengthi10e4:name999999999999999999999:xee"), None);
    }
}

//! Split HTTP downloads: several connections write different parts of one
//! file. The number of connections follows what the line delivers
//! (`plan::Adaptive`); several addresses of the same file may be given.

use crate::plan::{self, Adaptive};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::fs::{self, File, OpenOptions};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering::SeqCst};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub struct Options {
    pub urls: Vec<String>,
    pub out: Option<PathBuf>,
    pub dir: PathBuf,
    pub max_connections: usize,
    pub headers: Vec<(String, String)>,
    /// Login cookies by host name. Each request, every hop of a redirect included, carries only
    /// the cookies of the host it goes to, as the browser does.
    pub cookies: Vec<(String, String)>,
    pub json: bool,
    pub quiet: bool,
    /// A download that receives nothing at all for this long is given up
    /// (what it has is kept, and the same command continues it).
    pub give_up_after: Duration,
    /// A state file is kept: also write the lists of peers and files into it.
    pub status_details: bool,
    /// Connections to open at once before measuring (1 unless told otherwise).
    pub start_connections: usize,
    /// Give up if, this long after the start, the average is under this many
    /// bytes a second. For a source that has a better alternative (a
    /// torrent's web address, when the peers are there too).
    pub too_slow: Option<(f64, Duration)>,
}

pub struct Done {
    pub path: PathBuf,
    pub bytes: u64,
    pub seconds: f64,
    pub connections: usize,
}

struct Probe {
    /// The address that was asked (before redirects): asked again when the one it led to expires.
    asked: String,
    url: String,
    size: Option<u64>,
    ranges: bool,
    name: String,
    tag: String,
}

/// Login cookies by host, set by `download` for its run (empty for a torrent's web address).
static COOKIES: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new());

fn cookie_for(url: &url::Url) -> Option<String> {
    let host = url.host_str()?;
    COOKIES.lock().unwrap().iter().find(|(h, _)| h.eq_ignore_ascii_case(host)).map(|(_, c)| c.clone())
}

/// Redirects are followed here, not by the HTTP library, so that a login cookie goes only to
/// the host it belongs to (owner, Nov 14 2026: signed-in downloads that redirect, and safety
/// first). A signed address that a link leads to (GitHub, Drive) gets no cookie of the site
/// that sent us there.
fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        // Every address of a server is tried at once; the first to answer is used (fastconnect.rs).
        .resolver(crate::fastconnect::FirstToAnswer)
        .timeout_connect(Duration::from_secs(5))
        .timeout_read(Duration::from_secs(30))
        .redirects(0)
        .user_agent(concat!("gamblium-dl/", env!("CARGO_PKG_VERSION")))
        .build()
}

fn request(agent: &ureq::Agent, url: &str, headers: &[(String, String)], range: Option<(u64, Option<u64>)>) -> Result<ureq::Response, Fail> {
    let mut at = url::Url::parse(url).map_err(|e| Fail { pushed_back: false, fatal: true, code: 0, text: format!("{url}: {e}") })?;
    for _hop in 0..10 {
        let mut req = agent.get(at.as_str());
        for (k, v) in headers.iter().filter(|(k, _)| !k.eq_ignore_ascii_case("cookie")) {
            req = req.set(k, v);
        }
        if let Some(c) = cookie_for(&at) {
            req = req.set("Cookie", &c);
        }
        if let Some((from, to)) = range {
            let value = match to {
                Some(to) => format!("bytes={from}-{to}"),
                None => format!("bytes={from}-"),
            };
            req = req.set("Range", &value);
        }
        match req.call() {
            Ok(r) if (300..400).contains(&r.status()) => {
                let next = r.header("Location").and_then(|l| at.join(l).ok());
                match next {
                    // Never from https down to http.
                    Some(n) if matches!(n.scheme(), "https") || (n.scheme() == "http" && at.scheme() == "http") => at = n,
                    _ => return Err(Fail { pushed_back: false, fatal: true, code: r.status(), text: format!("the server sends us elsewhere ({}) without a usable address", r.status()) }),
                }
            }
            Ok(r) => return Ok(r),
            Err(ureq::Error::Status(code, _)) => return Err(Fail { pushed_back: matches!(code, 429 | 503 | 509), fatal: matches!(code, 400..=428 | 430..=499), code, text: format!("the server answered {code}") }),
            Err(e) => return Err(Fail { pushed_back: false, fatal: false, code: 0, text: e.to_string() }),
        }
    }
    Err(Fail { pushed_back: false, fatal: true, code: 0, text: "more than 10 redirects".into() })
}

struct Fail {
    /// The server asked for fewer requests.
    pushed_back: bool,
    /// Trying again cannot help (404, 403...).
    fatal: bool,
    /// The HTTP status, 0 when there was none.
    code: u16,
    text: String,
}

/// One small request that tells the size, whether parts can be asked for,
/// the address after redirects and the file's name.
fn probe(agent: &ureq::Agent, url: &str, headers: &[(String, String)]) -> Result<Probe, String> {
    let resp = request(agent, url, headers, Some((0, Some(0)))).map_err(|f| format!("{url}: {}", f.text))?;
    let name = plan::name_for(resp.header("Content-Disposition"), resp.get_url());
    let tag = resp.header("ETag").or(resp.header("Last-Modified")).unwrap_or("").to_owned();
    let final_url = resp.get_url().to_owned();
    let asked = url.to_owned();
    if resp.status() == 206 {
        let total = resp.header("Content-Range").and_then(plan::content_range).and_then(|(_, _, t)| t);
        return Ok(Probe { asked, url: final_url, size: total, ranges: total.is_some(), name, tag });
    }
    let size = resp.header("Content-Length").and_then(|v| v.parse().ok());
    Ok(Probe { asked, url: final_url, size, ranges: false, name, tag })
}

#[cfg(windows)]
fn write_at(file: &File, mut buf: &[u8], mut at: u64) -> std::io::Result<()> {
    use std::os::windows::fs::FileExt;
    while !buf.is_empty() {
        let n = file.seek_write(buf, at)?;
        buf = &buf[n..];
        at += n as u64;
    }
    Ok(())
}

#[cfg(unix)]
fn write_at(file: &File, buf: &[u8], at: u64) -> std::io::Result<()> {
    use std::os::unix::fs::FileExt;
    file.write_all_at(buf, at)
}

struct Shared {
    todo: Mutex<VecDeque<(u64, u64)>>,
    got: AtomicU64,
    want: AtomicUsize,
    alive: AtomicUsize,
    stop: AtomicBool,
    pushed_back: AtomicBool,
    failures: AtomicUsize,
    error: Mutex<Option<String>>,
    last_error: Mutex<Option<String>>,
    /// Failures in a row per source; a source that keeps failing is skipped.
    source_fails: Vec<AtomicUsize>,
    /// Bytes fetched from each source and the milliseconds that took, summed
    /// over its connections: bytes per connection-second, the measure by
    /// which the next piece picks its source.
    source_bytes: Vec<AtomicU64>,
    source_ms: Vec<AtomicU64>,
    /// Pieces being fetched now: (worker, next byte to fetch, last byte).
    /// A worker with nothing left to do takes the second half of the piece
    /// with the most left, so one slow connection cannot hold up the end.
    flying: Mutex<Vec<Flying>>,
    /// Per source: the address in use (after redirects), the one that was asked, and when the
    /// one in use was last fetched again (seconds since the start).
    urls: Vec<Mutex<String>>,
    asked: Vec<String>,
    renewed: Vec<AtomicU64>,
    /// Held while a source's address is checked and renewed, so connections refused together
    /// wait for the one renewal instead of giving up beside it.
    renewing: Vec<Mutex<()>>,
    size: u64,
}

/// A signed address that has run out (GitHub's release files after about an hour, Drive, S3):
/// the address that was asked leads to a fresh one. At most once every 5 s per source (a fresh
/// address that is refused at once must not loop); the size must not have changed.
fn renew(shared: &Shared, source: usize, agent: &ureq::Agent, headers: &[(String, String)], began: Instant) -> bool {
    let now = began.elapsed().as_secs() + 60;
    let last = shared.renewed[source].load(SeqCst);
    if now < last + 5 || shared.renewed[source].compare_exchange(last, now, SeqCst, SeqCst).is_err() {
        return false;
    }
    match probe(agent, &shared.asked[source], headers) {
        Ok(p) if p.size == Some(shared.size) && p.ranges => {
            *shared.urls[source].lock().unwrap() = p.url;
            true
        }
        _ => false,
    }
}

struct Flying {
    worker: usize,
    /// Next byte to fetch, and the last byte of the piece.
    pos: Arc<AtomicU64>,
    end: Arc<AtomicU64>,
    first: u64,
    since: Instant,
    /// Milliseconds after `since` at which the first byte arrived (0: none yet).
    /// Connecting takes a second or more and must not count as crawling.
    first_byte_ms: Arc<AtomicU64>,
}

/// Do not split what is left of a piece below this.
const STEAL_FROM: u64 = 192 * 1024;

/// The source for the next piece: one that has not been tried yet, else the
/// one that delivers most per connection. Sources that failed three times in
/// a row are left out while any other remains.
fn pick_source(shared: &Shared, turn: usize) -> usize {
    let n = shared.source_fails.len();
    let healthy: Vec<usize> = (0..n).filter(|&s| shared.source_fails[s].load(SeqCst) < 3).collect();
    if healthy.is_empty() {
        return turn % n;
    }
    if let Some(&fresh) = healthy.iter().find(|&&s| shared.source_ms[s].load(SeqCst) == 0) {
        // Several workers may start at once: spread them over the untried ones.
        let untried: Vec<usize> = healthy.iter().copied().filter(|&s| shared.source_ms[s].load(SeqCst) == 0).collect();
        return *untried.get(turn % untried.len()).unwrap_or(&fresh);
    }
    let rate = |s: usize| shared.source_bytes[s].load(SeqCst) as f64 / shared.source_ms[s].load(SeqCst).max(1) as f64;
    healthy.into_iter().max_by(|&a, &b| rate(a).total_cmp(&rate(b))).unwrap_or(0)
}

/// Work for a connection that found the list empty. A piece crawling on a
/// connection far slower than the best source (or still waiting for its
/// first byte) is taken over whole; otherwise the piece with the most left
/// is halved.
fn steal(shared: &Shared) -> Option<(u64, u64)> {
    let best = (0..shared.source_ms.len())
        .map(|s| shared.source_bytes[s].load(SeqCst) as f64 / shared.source_ms[s].load(SeqCst).max(1) as f64)
        .fold(0.0, f64::max);
    let flying = shared.flying.lock().unwrap();
    let left = |f: &Flying| (f.end.load(SeqCst) + 1).saturating_sub(f.pos.load(SeqCst));
    let crawling = flying.iter().filter(|f| left(f) > 0).find(|f| {
        let ms = f.since.elapsed().as_millis() as u64;
        match f.first_byte_ms.load(SeqCst) {
            // Still connecting: only a connection that takes far too long is given up on.
            0 => ms > 5000,
            started => {
                let flowing = ms.saturating_sub(started) as f64;
                let rate = (f.pos.load(SeqCst) - f.first) as f64 / flowing.max(1.0);
                flowing > 1500.0 && rate < best / 3.0
            }
        }
    });
    if let Some(f) = crawling {
        let (at, last) = (f.pos.load(SeqCst), f.end.load(SeqCst));
        if at == 0 {
            return None;
        }
        f.end.store(at - 1, SeqCst);
        return Some((at, last));
    }
    let f = flying.iter().max_by_key(|f| left(f))?;
    let (at, last) = (f.pos.load(SeqCst), f.end.load(SeqCst));
    if last < at || last - at + 1 < STEAL_FROM {
        return None;
    }
    let mid = at + (last - at + 1) / 2;
    f.end.store(mid - 1, SeqCst);
    Some((mid, last))
}

fn worker(id: usize, shared: Arc<Shared>, file: Arc<File>, headers: Arc<Vec<(String, String)>>, began: Instant) {
    let agent = agent();
    let mut buf = vec![0u8; 256 * 1024];
    let mut wait = Duration::from_millis(500);
    let mut turn = id;
    loop {
        if shared.stop.load(SeqCst) {
            break;
        }
        // Too many of us for the current target: the newest leave first.
        let alive = shared.alive.load(SeqCst);
        if alive > shared.want.load(SeqCst) && shared.alive.compare_exchange(alive, alive - 1, SeqCst, SeqCst).is_ok() {
            return;
        }
        let next = shared.todo.lock().unwrap().pop_front();
        let (mut from, to) = match next.or_else(|| steal(&shared)) {
            Some(piece) => piece,
            None if all_done(&shared) => break,
            None => {
                // Others are finishing small remainders; one of them may still fail.
                std::thread::sleep(Duration::from_millis(100));
                continue;
            }
        };
        let (pos, end) = (Arc::new(AtomicU64::new(from)), Arc::new(AtomicU64::new(to)));
        let first_byte_ms = Arc::new(AtomicU64::new(0));
        let asked = Instant::now();
        shared.flying.lock().unwrap().push(Flying { worker: id, pos: pos.clone(), end: end.clone(), first: from, since: asked, first_byte_ms: first_byte_ms.clone() });
        let source = pick_source(&shared, turn);
        turn += 1;
        let (asked_at, first_byte) = (Instant::now(), from);
        let used = shared.urls[source].lock().unwrap().clone();
        // Set when this connection leaves because the target fell (a try that did not pay): with
        // a whole-file piece it would otherwise run to the end of the file.
        let mut leaving = false;
        let outcome: Result<(), Fail> = (|| {
            let resp = request(&agent, &used, &headers, Some((from, Some(to))))?;
            let starts_right = resp.header("Content-Range").and_then(plan::content_range).map(|(a, _, _)| a == from).unwrap_or(false);
            if resp.status() != 206 || !starts_right {
                return Err(Fail { pushed_back: false, fatal: shared.urls.len() == 1, code: resp.status(), text: "the server did not send the part that was asked for".into() });
            }
            let mut reader = resp.into_reader();
            loop {
                // Someone may have taken the second half of this piece.
                let to = end.load(SeqCst);
                if from > to {
                    break;
                }
                if shared.stop.load(SeqCst) {
                    return Ok(());
                }
                let room = ((to - from + 1) as usize).min(buf.len());
                let n = reader.read(&mut buf[..room]).map_err(|e| Fail { pushed_back: false, fatal: false, code: 0, text: e.to_string() })?;
                if shared.stop.load(SeqCst) || from > end.load(SeqCst) {
                    // Finished or taken over while this read was waiting: write nothing.
                    return Ok(());
                }
                if n == 0 {
                    return Err(Fail { pushed_back: false, fatal: false, code: 0, text: "the connection closed early".into() });
                }
                write_at(&file, &buf[..n], from).map_err(|e| Fail { pushed_back: false, fatal: true, code: 0, text: format!("could not write the file: {e}") })?;
                if first_byte_ms.load(SeqCst) == 0 {
                    first_byte_ms.store((asked.elapsed().as_millis() as u64).max(1), SeqCst);
                }
                from += n as u64;
                pos.store(from, SeqCst);
                shared.got.fetch_add(n as u64, SeqCst);
                // The slowest connection is the one that leaves (GitHub, Nov 14 2026: the faster
                // one left and the download ran at 0.7 MB/s for 10 s on the one that stayed).
                let alive = shared.alive.load(SeqCst);
                if alive > shared.want.load(SeqCst) && slowest(&shared, id) && shared.alive.compare_exchange(alive, alive - 1, SeqCst, SeqCst).is_ok() {
                    leaving = true;
                    return Ok(());
                }
            }
            Ok(())
        })();
        shared.source_bytes[source].fetch_add(from - first_byte, SeqCst);
        shared.source_ms[source].fetch_add(asked_at.elapsed().as_millis().max(1) as u64, SeqCst);
        // Off the flying list and back on the to-do list in one step (flying is locked first,
        // everywhere), so nobody halves a piece that is being put back and nobody sees the
        // remainder in neither list and takes the download for finished.
        let to = {
            let mut flying = shared.flying.lock().unwrap();
            flying.retain(|f| f.worker != id);
            let to = end.load(SeqCst);
            if from <= to {
                shared.todo.lock().unwrap().push_front((from, to));
            }
            to
        };
        if leaving {
            return;
        }
        match outcome {
            Ok(()) => {
                shared.source_fails[source].store(0, SeqCst);
                shared.failures.store(0, SeqCst);
                wait = Duration::from_millis(500);
            }
            Err(fail) => {
                let _ = to;
                // Refused where it was fine before: a signed address ran out. Ask the address
                // that led to it for a fresh one and carry on.
                // Another connection may already have fetched it: then just use that one.
                let guard = shared.renewing[source].lock().unwrap();
                let renewed_meanwhile = *shared.urls[source].lock().unwrap() != used;
                let renewed = matches!(fail.code, 401 | 403 | 410) && used != shared.asked[source] && (renewed_meanwhile || renew(&shared, source, &agent, &headers, began));
                drop(guard);
                if renewed {
                    // Not a failure of the source: straight on with the fresh address.
                    continue;
                }
                shared.source_fails[source].fetch_add(1, SeqCst);
                if fail.pushed_back {
                    shared.pushed_back.store(true, SeqCst);
                }
                let all_bad = shared.source_fails.iter().all(|f| f.load(SeqCst) >= 3);
                shared.failures.fetch_add(1, SeqCst);
                let address = shared.urls[source].lock().unwrap().clone();
                *shared.last_error.lock().unwrap() = Some(format!("{address}: {}", fail.text));
                // Timeouts and resets are waited out (the main loop gives up after
                // a minute without a single byte); only a plain "no" ends it here.
                if (fail.fatal && shared.urls.len() == 1) || (fail.fatal && all_bad) {
                    *shared.error.lock().unwrap() = Some(format!("{address}: {}", fail.text));
                    shared.stop.store(true, SeqCst);
                    break;
                }
                std::thread::sleep(wait);
                wait = (wait * 2).min(Duration::from_secs(20));
            }
        }
    }
    shared.alive.fetch_sub(1, SeqCst);
}

/// The count of connections each server's downloads came to rest at, newest first, at most 200
/// servers: `Gamblium\downloads\servers.json` under LOCALAPPDATA. Only a number per host name;
/// no address, file or cookie.
fn servers_file() -> Option<PathBuf> {
    Some(PathBuf::from(std::env::var_os("LOCALAPPDATA")?).join("Gamblium").join("downloads").join("servers.json"))
}

fn remembered(host: &str) -> Option<usize> {
    let text = fs::read_to_string(servers_file()?).ok()?;
    let all: Value = serde_json::from_str(&text).ok()?;
    let known: Vec<(String, usize)> = all
        .as_array()?
        .iter()
        .filter_map(|e| Some((e["host"].as_str()?.to_owned(), e["connections"].as_u64()? as usize)))
        .collect();
    plan::first_guess(&known, host)
}

fn remember(host: &str, conns: usize) {
    let Some(path) = servers_file() else { return };
    if host.is_empty() {
        return;
    }
    let mut all: Vec<Value> = fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    all.retain(|e| e["host"] != host);
    all.insert(0, json!({ "host": host, "connections": conns }));
    all.truncate(200);
    let _ = fs::create_dir_all(path.parent().unwrap());
    let tmp = path.with_extension("json.tmp");
    if fs::write(&tmp, Value::Array(all).to_string()).is_ok() {
        let _ = fs::rename(&tmp, &path);
    }
}

/// Whether this worker's piece is arriving slowest of all pieces in flight (ties: the newest).
fn slowest(shared: &Shared, id: usize) -> bool {
    let rate = |f: &Flying| {
        let ms = (f.since.elapsed().as_millis() as u64).saturating_sub(f.first_byte_ms.load(SeqCst)).max(1);
        (f.pos.load(SeqCst) - f.first) as f64 / ms as f64
    };
    let flying = shared.flying.lock().unwrap();
    let Some(me) = flying.iter().find(|f| f.worker == id) else { return true };
    let mine = rate(me);
    flying.iter().filter(|f| f.worker != id).all(|f| {
        let r = rate(f);
        mine < r || (mine == r && id > f.worker)
    })
}

/// Nothing on either list. Flying is locked first, as everywhere.
fn all_done(shared: &Shared) -> bool {
    let flying = shared.flying.lock().unwrap();
    flying.is_empty() && shared.todo.lock().unwrap().is_empty()
}

fn state_file(part: &Path) -> PathBuf {
    let mut s = part.as_os_str().to_owned();
    s.push(".state");
    PathBuf::from(s)
}

fn save_state(part: &Path, size: u64, tag: &str, shared: &Shared, in_flight_unknown: bool) {
    // Pieces being fetched right now are not in the list; they are only safe
    // to record once every worker has stopped.
    if in_flight_unknown {
        return;
    }
    let todo: Vec<(u64, u64)> = shared.todo.lock().unwrap().iter().copied().collect();
    let _ = fs::write(state_file(part), json!({ "size": size, "tag": tag, "todo": todo }).to_string());
}

/// While running: what is still missing is the queue plus, for each piece in flight, the part
/// from its current position to its end. Written every 2 s, so a download that is stopped hard
/// (Pause kills the program; so does a crash or a power cut) continues from there, not from zero
/// (owner, Nov 14 2026: a paused GitHub download started again at 0).
fn save_progress(part: &Path, size: u64, tag: &str, shared: &Shared) {
    let flying = shared.flying.lock().unwrap();
    let mut todo: Vec<(u64, u64)> = shared.todo.lock().unwrap().iter().copied().collect();
    for f in flying.iter() {
        let (pos, end) = (f.pos.load(SeqCst), f.end.load(SeqCst));
        if pos <= end {
            todo.push((pos, end));
        }
    }
    todo.sort_unstable();
    let tmp = state_file(part).with_extension("state.tmp");
    if fs::write(&tmp, json!({ "size": size, "tag": tag, "todo": todo }).to_string()).is_ok() {
        let _ = fs::rename(&tmp, state_file(part));
    }
}

fn load_state(part: &Path, size: u64, tag: &str) -> Option<VecDeque<(u64, u64)>> {
    let text = fs::read_to_string(state_file(part)).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    if v["size"].as_u64()? != size || v["tag"].as_str()? != tag || fs::metadata(part).ok()?.len() != size {
        return None;
    }
    let mut out = VecDeque::new();
    for r in v["todo"].as_array()? {
        let (a, b) = (r[0].as_u64()?, r[1].as_u64()?);
        if a > b || b >= size {
            return None;
        }
        out.push_back((a, b));
    }
    Some(out)
}

fn free_name(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_owned(), format!(".{e}")),
        _ => (name.to_owned(), String::new()),
    };
    (1..10_000).map(|i| dir.join(format!("{stem} ({i}){ext}"))).find(|p| !p.exists()).unwrap_or(first)
}

fn report(o: &Options, value: serde_json::Value, plain: impl FnOnce() -> String) {
    crate::status::event(&value);
    if o.json {
        println!("{value}");
    } else if !o.quiet {
        eprintln!("{}", plain());
    }
}

pub fn mb(bytes: f64) -> String {
    format!("{:.1} MB", bytes / 1_048_576.0)
}

pub fn download(o: &Options) -> Result<Done, String> {
    *COOKIES.lock().unwrap() = o.cookies.clone();
    let started = Instant::now();
    let agent = agent();
    // Every address is asked once. Those that agree on the size are used together.
    // All at once; when the first answers, the others get two more seconds.
    let mut probes: Vec<Probe> = Vec::new();
    let mut first_error = None;
    let (tx, rx) = std::sync::mpsc::channel();
    for url in o.urls.clone() {
        let (tx, agent, headers) = (tx.clone(), agent.clone(), o.headers.clone());
        std::thread::spawn(move || {
            let _ = tx.send(probe(&agent, &url, &headers));
        });
    }
    drop(tx);
    let mut deadline: Option<Instant> = None;
    for _ in 0..o.urls.len() {
        let answer = match deadline {
            None => rx.recv().ok(),
            Some(d) => rx.recv_timeout(d.saturating_duration_since(Instant::now())).ok(),
        };
        match answer {
            Some(Ok(p)) => {
                probes.push(p);
                deadline.get_or_insert(Instant::now() + Duration::from_secs(2));
            }
            Some(Err(e)) => {
                report(o, json!({ "event": "source-failed", "error": e }), || format!("skipped: {e}"));
                first_error.get_or_insert(e);
            }
            None => break,
        }
    }
    let lead = probes.first().ok_or_else(|| first_error.unwrap_or_else(|| "no address given".into()))?;
    let (size, name, tag) = (lead.size, lead.name.clone(), lead.tag.clone());
    let split = lead.ranges && size.map(|s| s >= plan::SPLIT_FROM).unwrap_or(false) && o.max_connections > 1;
    let usable: Vec<&Probe> = probes.iter().filter(|p| p.size == size && (p.ranges || !split)).collect();
    let urls: Vec<String> = usable.iter().map(|p| p.url.clone()).collect();
    let asked: Vec<String> = usable.iter().map(|p| p.asked.clone()).collect();

    fs::create_dir_all(&o.dir).map_err(|e| format!("{}: {e}", o.dir.display()))?;
    let target = match &o.out {
        Some(p) if p.is_absolute() => p.clone(),
        Some(p) => o.dir.join(p),
        None => free_name(&o.dir, &name),
    };
    let mut part = target.as_os_str().to_owned();
    part.push(".part");
    let part = PathBuf::from(part);
    report(o, json!({ "event": "start", "path": target, "size": size, "split": split, "sources": urls.len() }), || {
        format!("{} ({}), {} source(s){}", target.display(), size.map(|s| mb(s as f64)).unwrap_or_else(|| "size unknown".into()), urls.len(), if split { "" } else { ", one connection" })
    });

    if !split {
        // One stream from start to end.
        let resp = request(&agent, &urls[0], &o.headers, None).map_err(|f| f.text)?;
        let mut reader = resp.into_reader();
        let mut file = File::create(&part).map_err(|e| format!("{}: {e}", part.display()))?;
        let (mut total, mut last, mut last_total) = (0u64, Instant::now(), 0u64);
        let mut buf = vec![0u8; 256 * 1024];
        loop {
            let n = reader.read(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            std::io::Write::write_all(&mut file, &buf[..n]).map_err(|e| e.to_string())?;
            total += n as u64;
            if last.elapsed() >= Duration::from_secs(1) {
                let speed = (total - last_total) as f64 / last.elapsed().as_secs_f64();
                report(o, json!({ "event": "progress", "done": total, "total": size, "speed": speed, "connections": 1 }), || format!("{} at {}/s", mb(total as f64), mb(speed)));
                (last, last_total) = (Instant::now(), total);
            }
        }
        if let Some(s) = size {
            if total != s {
                return Err(format!("the download stopped at {total} of {s} bytes"));
            }
        }
        drop(file);
        fs::rename(&part, &target).map_err(|e| e.to_string())?;
        return Ok(Done { path: target, bytes: total, seconds: started.elapsed().as_secs_f64(), connections: 1 });
    }

    let size = size.unwrap();
    let resumed = load_state(&part, size, &tag);
    let todo = match &resumed {
        Some(t) => t.clone(),
        // One piece, the whole file: one connection streams it in one request (about 64 pieces
        // cost a round trip each: 35-40 % slower than curl on GitHub's file host, tester Nov 14
        // 2026). A second connection takes half of what is left (steal), and is kept only if the
        // total speed rises.
        None => VecDeque::from([(0, size - 1)]),
    };
    let already = size - todo.iter().map(|(a, b)| b - a + 1).sum::<u64>();
    let file = OpenOptions::new().create(true).write(true).truncate(resumed.is_none()).open(&part).map_err(|e| format!("{}: {e}", part.display()))?;
    file.set_len(size).map_err(|e| format!("not enough room for {}: {e}", mb(size as f64)))?;
    if already > 0 {
        report(o, json!({ "event": "resume", "have": already }), || format!("continuing: {} already here", mb(already as f64)));
    }
    let file = Arc::new(file);
    let shared = Arc::new(Shared {
        todo: Mutex::new(todo),
        got: AtomicU64::new(0),
        want: AtomicUsize::new(1),
        alive: AtomicUsize::new(0),
        stop: AtomicBool::new(false),
        pushed_back: AtomicBool::new(false),
        failures: AtomicUsize::new(0),
        error: Mutex::new(None),
        last_error: Mutex::new(None),
        source_fails: urls.iter().map(|_| AtomicUsize::new(0)).collect(),
        source_bytes: urls.iter().map(|_| AtomicU64::new(0)).collect(),
        source_ms: urls.iter().map(|_| AtomicU64::new(0)).collect(),
        flying: Mutex::new(Vec::new()),
        urls: urls.iter().map(|u| Mutex::new(u.clone())).collect(),
        renewed: urls.iter().map(|_| AtomicU64::new(0)).collect(),
        renewing: urls.iter().map(|_| Mutex::new(())).collect(),
        asked,
        size,
    });
    let headers = Arc::new(o.headers.clone());
    // Start where this server ended last time (owner, Nov 14 2026: find the right count, don't
    // guess one); a count asked for on the command line wins; with several sources, at least one
    // connection to each.
    let host = url::Url::parse(&urls[0]).ok().and_then(|u| u.host_str().map(str::to_owned)).unwrap_or_default();
    let start = if o.start_connections > 1 { o.start_connections } else { remembered(&host).unwrap_or(1) };
    let mut adaptive = Adaptive::starting_at(o.max_connections, start.max(urls.len()));
    shared.want.store(adaptive.conns, SeqCst);

    let mut handles = Vec::new();
    let mut spawned = 0usize;
    let (mut window_start, mut window_got) = (Instant::now(), 0u64);
    let mut measured_from = Instant::now();
    let (mut tick, mut tick_got) = (Instant::now(), 0u64);
    let mut peak = adaptive.conns;
    let mut learned: Option<usize> = None;
    let (mut quiet_since, mut quiet_got) = (Instant::now(), 0u64);
    let loop_started = Instant::now();
    let mut saved_at = Instant::now();
    #[allow(unused_assignments)]
    let mut finished = false;
    loop {
        // Bring the number of workers up to the target.
        while shared.alive.load(SeqCst) < shared.want.load(SeqCst) && !shared.stop.load(SeqCst) && !all_done(&shared) {
            shared.alive.fetch_add(1, SeqCst);
            let (s, f, h) = (shared.clone(), file.clone(), headers.clone());
            let id = spawned;
            spawned += 1;
            handles.push(std::thread::spawn(move || worker(id, s, f, h, started)));
        }
        std::thread::sleep(Duration::from_millis(100));
        if saved_at.elapsed() >= Duration::from_secs(2) {
            save_progress(&part, size, &tag, &shared);
            saved_at = Instant::now();
        }
        let got = shared.got.load(SeqCst);
        // Bytes at a seam may be fetched twice, so the count alone proves nothing.
        // A connection whose piece was taken over may still sit in a read that
        // never returns; it has nothing left to fetch and is not waited for.
        let nothing_left = {
            let flying = shared.flying.lock().unwrap();
            shared.todo.lock().unwrap().is_empty() && flying.iter().all(|f| f.pos.load(SeqCst) > f.end.load(SeqCst))
        };
        if shared.stop.load(SeqCst) || nothing_left {
            finished = nothing_left && !shared.stop.load(SeqCst);
            break;
        }
        if got != quiet_got {
            (quiet_since, quiet_got) = (Instant::now(), got);
        } else if quiet_since.elapsed() >= o.give_up_after {
            let why = shared.last_error.lock().unwrap().clone().unwrap_or_else(|| "the server sends nothing".into());
            *shared.error.lock().unwrap() = Some(format!("nothing arrived for {} s ({why})", o.give_up_after.as_secs()));
            break;
        }
        if let Some((floor, after)) = o.too_slow {
            let ran = loop_started.elapsed();
            if ran >= after && (got as f64 / ran.as_secs_f64()) < floor {
                *shared.error.lock().unwrap() = Some(format!("too slow: {}/s on average after {} s", mb(got as f64 / ran.as_secs_f64()), ran.as_secs()));
                break;
            }
        }
        if tick.elapsed() >= Duration::from_secs(1) {
            let speed = (got - tick_got) as f64 / tick.elapsed().as_secs_f64();
            let conns = shared.alive.load(SeqCst);
            report(o, json!({ "event": "progress", "done": already + got, "total": size, "speed": speed, "connections": conns }), || {
                format!("{:>5.1}%  {}/s  {} connection(s)", (already + got) as f64 * 100.0 / size as f64, mb(speed), conns)
            });
            (tick, tick_got) = (Instant::now(), got);
        }
        // Nothing has arrived yet (connecting, or a slow first byte): no window is judged. A
        // window of 0 bytes made every doubling look like a gain, up to 16 connections on a
        // host that gets slower with each one (tester, GitHub's file host, Nov 14 2026).
        // Likewise while a new connection is still connecting: a try judged then looks like it
        // does not pay (a 2 s connect cost every second connection its chance, Nov 14 2026).
        let connecting = shared.flying.lock().unwrap().iter().any(|f| f.first_byte_ms.load(SeqCst) == 0 && f.since.elapsed() < Duration::from_secs(5));
        if got == 0 || connecting {
            (window_start, window_got, measured_from) = (Instant::now(), got, Instant::now());
            continue;
        }
        // Every two seconds: is the current number of connections paying?
        let pushed = shared.pushed_back.swap(false, SeqCst);
        // The first second of a window is left out: new connections are still
        // being set up then.
        if !pushed && window_start.elapsed() < Duration::from_millis(800) {
            window_got = got;
            measured_from = Instant::now();
        }
        if pushed || window_start.elapsed() >= Duration::from_millis(2300) {
            let speed = (got - window_got) as f64 / measured_from.elapsed().as_secs_f64().max(0.001);
            let next = adaptive.step(speed, pushed);
            if adaptive.at_rest() && learned != Some(next) {
                remember(&host, next);
                learned = Some(next);
            }
            measured_from = Instant::now();
            shared.want.store(next, SeqCst);
            peak = peak.max(next);
            (window_start, window_got) = (Instant::now(), got);
        }
    }
    shared.stop.store(true, SeqCst);
    if learned != Some(adaptive.proven()) && shared.got.load(SeqCst) > 0 {
        remember(&host, adaptive.proven());
    }
    if !finished {
        // Stopped early: wait, so that every unfinished piece is back on the list.
        for h in handles {
            let _ = h.join();
        }
    }
    let left: u64 = shared.todo.lock().unwrap().iter().map(|(a, b)| b - a + 1).sum();
    if left > 0 || shared.error.lock().unwrap().is_some() {
        save_state(&part, size, &tag, &shared, false);
        let why = shared.error.lock().unwrap().clone().unwrap_or_else(|| "stopped".into());
        return Err(format!("{why}. {} of {} is saved; run the same command to continue", mb((size - left) as f64), mb(size as f64)));
    }
    drop(file);
    let _ = fs::remove_file(state_file(&part));
    fs::rename(&part, &target).map_err(|e| format!("could not name the finished file: {e}"))?;
    Ok(Done { path: target, bytes: size, seconds: started.elapsed().as_secs_f64(), connections: peak })
}

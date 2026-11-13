//! Split HTTP downloads: several connections write different parts of one
//! file. The number of connections follows what the line delivers
//! (`plan::Adaptive`); several addresses of the same file may be given.

use crate::plan::{self, Adaptive};
use serde_json::json;
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
    url: String,
    size: Option<u64>,
    ranges: bool,
    name: String,
    tag: String,
}

/// With a login cookie on board a redirect is not followed: the cookie
/// belongs to the site it came from and must not travel to another one.
static NO_REDIRECTS: AtomicBool = AtomicBool::new(false);

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(15))
        .timeout_read(Duration::from_secs(30))
        .redirects(if NO_REDIRECTS.load(SeqCst) { 0 } else { 10 })
        .user_agent(concat!("gamblium-dl/", env!("CARGO_PKG_VERSION")))
        .build()
}

fn request(agent: &ureq::Agent, url: &str, headers: &[(String, String)], range: Option<(u64, Option<u64>)>) -> Result<ureq::Response, Fail> {
    let mut req = agent.get(url);
    for (k, v) in headers {
        req = req.set(k, v);
    }
    if let Some((from, to)) = range {
        let value = match to {
            Some(to) => format!("bytes={from}-{to}"),
            None => format!("bytes={from}-"),
        };
        req = req.set("Range", &value);
    }
    match req.call() {
        // With redirects off a 3xx comes back as an answer; it is not the file.
        Ok(r) if (300..400).contains(&r.status()) => Err(Fail { pushed_back: false, fatal: true, text: format!("the server sends us elsewhere ({}), and a login cookie does not follow", r.status()) }),
        Ok(r) => Ok(r),
        Err(ureq::Error::Status(code, _)) => Err(Fail { pushed_back: matches!(code, 429 | 503 | 509), fatal: matches!(code, 400..=428 | 430..=499), text: format!("the server answered {code}") }),
        Err(e) => Err(Fail { pushed_back: false, fatal: false, text: e.to_string() }),
    }
}

struct Fail {
    /// The server asked for fewer requests.
    pushed_back: bool,
    /// Trying again cannot help (404, 403...).
    fatal: bool,
    text: String,
}

/// One small request that tells the size, whether parts can be asked for,
/// the address after redirects and the file's name.
fn probe(agent: &ureq::Agent, url: &str, headers: &[(String, String)]) -> Result<Probe, String> {
    let resp = request(agent, url, headers, Some((0, Some(0)))).map_err(|f| format!("{url}: {}", f.text))?;
    let name = plan::name_for(resp.header("Content-Disposition"), resp.get_url());
    let tag = resp.header("ETag").or(resp.header("Last-Modified")).unwrap_or("").to_owned();
    let final_url = resp.get_url().to_owned();
    if resp.status() == 206 {
        let total = resp.header("Content-Range").and_then(plan::content_range).and_then(|(_, _, t)| t);
        return Ok(Probe { url: final_url, size: total, ranges: total.is_some(), name, tag });
    }
    let size = resp.header("Content-Length").and_then(|v| v.parse().ok());
    Ok(Probe { url: final_url, size, ranges: false, name, tag })
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

fn worker(id: usize, shared: Arc<Shared>, file: Arc<File>, urls: Arc<Vec<String>>, headers: Arc<Vec<(String, String)>>) {
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
            None if shared.flying.lock().unwrap().is_empty() => break,
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
        let outcome: Result<(), Fail> = (|| {
            let resp = request(&agent, &urls[source], &headers, Some((from, Some(to))))?;
            let starts_right = resp.header("Content-Range").and_then(plan::content_range).map(|(a, _, _)| a == from).unwrap_or(false);
            if resp.status() != 206 || !starts_right {
                return Err(Fail { pushed_back: false, fatal: urls.len() == 1, text: "the server did not send the part that was asked for".into() });
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
                let n = reader.read(&mut buf[..room]).map_err(|e| Fail { pushed_back: false, fatal: false, text: e.to_string() })?;
                if shared.stop.load(SeqCst) || from > end.load(SeqCst) {
                    // Finished or taken over while this read was waiting: write nothing.
                    return Ok(());
                }
                if n == 0 {
                    return Err(Fail { pushed_back: false, fatal: false, text: "the connection closed early".into() });
                }
                write_at(&file, &buf[..n], from).map_err(|e| Fail { pushed_back: false, fatal: true, text: format!("could not write the file: {e}") })?;
                if first_byte_ms.load(SeqCst) == 0 {
                    first_byte_ms.store((asked.elapsed().as_millis() as u64).max(1), SeqCst);
                }
                from += n as u64;
                pos.store(from, SeqCst);
                shared.got.fetch_add(n as u64, SeqCst);
            }
            Ok(())
        })();
        shared.source_bytes[source].fetch_add(from - first_byte, SeqCst);
        shared.source_ms[source].fetch_add(asked_at.elapsed().as_millis().max(1) as u64, SeqCst);
        // Off the list first, so nobody halves a piece that is being put back.
        let to = {
            let mut flying = shared.flying.lock().unwrap();
            flying.retain(|f| f.worker != id);
            end.load(SeqCst)
        };
        match outcome {
            Ok(()) => {
                if from <= to {
                    shared.todo.lock().unwrap().push_front((from, to));
                }
                shared.source_fails[source].store(0, SeqCst);
                shared.failures.store(0, SeqCst);
                wait = Duration::from_millis(500);
            }
            Err(fail) => {
                // What is left of this piece goes back for anyone to take.
                if from <= to {
                    shared.todo.lock().unwrap().push_front((from, to));
                }
                shared.source_fails[source].fetch_add(1, SeqCst);
                if fail.pushed_back {
                    shared.pushed_back.store(true, SeqCst);
                }
                let all_bad = shared.source_fails.iter().all(|f| f.load(SeqCst) >= 3);
                shared.failures.fetch_add(1, SeqCst);
                *shared.last_error.lock().unwrap() = Some(format!("{}: {}", urls[source], fail.text));
                // Timeouts and resets are waited out (the main loop gives up after
                // a minute without a single byte); only a plain "no" ends it here.
                if (fail.fatal && urls.len() == 1) || (fail.fatal && all_bad) {
                    *shared.error.lock().unwrap() = Some(format!("{}: {}", urls[source], fail.text));
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
    NO_REDIRECTS.store(o.headers.iter().any(|(k, _)| k.eq_ignore_ascii_case("cookie")), SeqCst);
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
    let urls: Vec<String> = probes.iter().filter(|p| p.size == size && (p.ranges || !split)).map(|p| p.url.clone()).collect();

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
        None => plan::pieces(size, plan::piece_size(size)),
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
    });
    let (urls, headers) = (Arc::new(urls), Arc::new(o.headers.clone()));
    // With several sources, start with one connection to each.
    let mut adaptive = Adaptive::new(o.max_connections);
    while adaptive.conns < urls.len().max(o.start_connections).min(o.max_connections) {
        adaptive.conns += 1;
    }
    shared.want.store(adaptive.conns, SeqCst);

    let mut handles = Vec::new();
    let mut spawned = 0usize;
    let (mut window_start, mut window_got) = (Instant::now(), 0u64);
    let mut measured_from = Instant::now();
    let (mut tick, mut tick_got) = (Instant::now(), 0u64);
    let mut peak = adaptive.conns;
    let (mut quiet_since, mut quiet_got) = (Instant::now(), 0u64);
    let loop_started = Instant::now();
    #[allow(unused_assignments)]
    let mut finished = false;
    loop {
        // Bring the number of workers up to the target.
        while shared.alive.load(SeqCst) < shared.want.load(SeqCst) && !shared.stop.load(SeqCst) && (!shared.todo.lock().unwrap().is_empty() || !shared.flying.lock().unwrap().is_empty()) {
            shared.alive.fetch_add(1, SeqCst);
            let (s, f, u, h) = (shared.clone(), file.clone(), urls.clone(), headers.clone());
            let id = spawned;
            spawned += 1;
            handles.push(std::thread::spawn(move || worker(id, s, f, u, h)));
        }
        std::thread::sleep(Duration::from_millis(100));
        let got = shared.got.load(SeqCst);
        // Bytes at a seam may be fetched twice, so the count alone proves nothing.
        // A connection whose piece was taken over may still sit in a read that
        // never returns; it has nothing left to fetch and is not waited for.
        let nothing_left = shared.todo.lock().unwrap().is_empty()
            && shared.flying.lock().unwrap().iter().all(|f| f.pos.load(SeqCst) > f.end.load(SeqCst));
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
            measured_from = Instant::now();
            shared.want.store(next, SeqCst);
            peak = peak.max(next);
            (window_start, window_got) = (Instant::now(), got);
        }
    }
    shared.stop.store(true, SeqCst);
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

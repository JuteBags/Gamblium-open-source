//! gamblium-dl: Gamblium's own downloader.
//!
//!   gamblium-dl https://example.org/big.iso
//!   gamblium-dl https://mirror-a/big.iso https://mirror-b/big.iso --dir D:\Downloads
//!
//!   gamblium-dl "magnet:?xt=urn:btih:..." --dir D:\Downloads
//!   gamblium-dl https://example.org/big.iso.torrent
//!
//! Normal links are split over connections (http.rs); magnet links and
//! .torrent files go to the torrent engine (torrent.rs).

mod fastconnect;
mod http;
mod plan;
mod status;
mod torrent;

use clap::Parser;
use std::path::PathBuf;

#[derive(Parser)]
#[command(name = "gamblium-dl", version, about = "Gamblium's downloader: split downloads with as many connections as the line can use, several sources, resume")]
struct Args {
    /// One address, or several addresses of the same file (mirrors).
    #[arg(required = true)]
    urls: Vec<String>,
    /// File name to save as (default: the server's name for it).
    #[arg(short, long)]
    out: Option<PathBuf>,
    /// This continues an earlier run of the same download: its unfinished part at `--out` is
    /// its own (Gamblium passes it on Resume). Without it an unfinished part of that name is
    /// someone else's and a free name is taken.
    #[arg(long)]
    resume: bool,
    /// Folder to save into (default: the current folder).
    #[arg(short, long, default_value = ".")]
    dir: PathBuf,
    /// Most connections to open. The downloader starts with one and adds
    /// more only while they make the download faster.
    #[arg(short = 'x', long, default_value_t = 16)]
    max_connections: usize,
    /// Connections to open straight away. The count still grows or shrinks
    /// from there. Without it, the count this server's last download came to
    /// rest at (Gamblium\downloads\servers.json), else one.
    #[arg(long, default_value_t = 1)]
    start_connections: usize,
    /// Extra request header, "Name: value". May be repeated (cookies, referer).
    #[arg(short = 'H', long = "header")]
    headers: Vec<String>,
    /// Progress as one JSON object per line on standard output.
    #[arg(long)]
    json: bool,
    /// Give up when nothing at all has arrived for this many seconds.
    #[arg(long, default_value_t = 60)]
    give_up_after: u64,
    /// Torrents: keep sharing for this many minutes after the download is
    /// complete. 0 (the default) stops as soon as the file is whole.
    #[arg(long, default_value_t = 0)]
    seed_minutes: u64,
    /// Torrents: peers only, even if the torrent names an ordinary web
    /// address of its file (a "web seed", fetched first otherwise).
    #[arg(long)]
    no_web_seed: bool,
    /// Delete this file when the download is complete (the stored login).
    #[arg(long, hide = true)]
    forget_file: Option<PathBuf>,
    /// Keep the latest state in this file (used by Gamblium's helper).
    #[arg(long, hide = true)]
    status_file: Option<PathBuf>,
    /// No progress lines.
    #[arg(short, long)]
    quiet: bool,
}

/// `{"host": "a=1; b=2", ...}`, or one plain cookie header for `first`'s host.
fn cookies_from(text: &str, first: &str) -> Vec<(String, String)> {
    if text.trim_start().starts_with('{') {
        let map: serde_json::Map<String, serde_json::Value> = serde_json::from_str(text).unwrap_or_default();
        return map.into_iter().filter_map(|(h, c)| Some((h.to_ascii_lowercase(), c.as_str().filter(|c| !c.is_empty())?.to_owned()))).collect();
    }
    let host = url::Url::parse(first).ok().and_then(|u| u.host_str().map(str::to_owned)).unwrap_or_default();
    if text.is_empty() || host.is_empty() {
        return Vec::new();
    }
    vec![(host, text.to_owned())]
}

#[cfg(test)]
mod tests {
    #[test]
    fn cookies_are_kept_per_host() {
        let c = super::cookies_from(r#"{"github.com":"s=1","Objects.Example.org":"t=2","x.org":""}"#, "https://github.com/a");
        assert!(c.contains(&("github.com".into(), "s=1".into())));
        assert!(c.contains(&("objects.example.org".into(), "t=2".into())));
        assert_eq!(c.len(), 2);
        assert_eq!(super::cookies_from("s=1", "https://drive.example.com/f"), vec![("drive.example.com".to_string(), "s=1".to_string())]);
        assert!(super::cookies_from("", "https://x.org/").is_empty());
    }
}

fn main() {
    let a = Args::parse();
    if let Some(file) = a.status_file.clone() {
        status::init(file);
    }
    let mut headers = Vec::new();
    // Login cookies come in through the environment, so they never show on a
    // command line, and are taken out again at once: a JSON object of host ->
    // cookie header, or one plain header for the host of the first address.
    let mut cookies: Vec<(String, String)> = Vec::new();
    if let Ok(text) = std::env::var("GAMBLIUM_DL_COOKIE") {
        std::env::remove_var("GAMBLIUM_DL_COOKIE");
        cookies = cookies_from(&text, a.urls.first().map(String::as_str).unwrap_or(""));
    }
    for h in &a.headers {
        match h.split_once(':') {
            Some((k, v)) if !k.trim().is_empty() => headers.push((k.trim().to_owned(), v.trim().to_owned())),
            _ => {
                eprintln!("error: a header is written \"Name: value\", not '{h}'");
                std::process::exit(2);
            }
        }
    }
    let as_torrent = a.urls.iter().any(|u| torrent::is_torrent(u));
    if as_torrent && a.urls.len() > 1 {
        eprintln!("error: one torrent or magnet link at a time");
        std::process::exit(2);
    }
    for u in a.urls.iter().filter(|_| !as_torrent) {
        let ok = url::Url::parse(u).map(|p| matches!(p.scheme(), "http" | "https")).unwrap_or(false);
        if !ok {
            eprintln!("error: '{u}' is not an http or https address, a magnet link or a .torrent file");
            std::process::exit(2);
        }
    }
    // A Cookie given with -H belongs to the first address's host, like the environment's.
    if let Some(i) = headers.iter().position(|(k, _): &(String, String)| k.eq_ignore_ascii_case("cookie")) {
        let (_, c) = headers.remove(i);
        cookies.extend(cookies_from(&c, a.urls.first().map(String::as_str).unwrap_or("")));
    }
    let o = http::Options { resume: a.resume, urls: a.urls, out: a.out, dir: a.dir, max_connections: a.max_connections.clamp(1, 32), headers, cookies, json: a.json, quiet: a.quiet, status_details: a.status_file.is_some(), start_connections: a.start_connections.clamp(1, 16), too_slow: None, give_up_after: std::time::Duration::from_secs(a.give_up_after.max(1)) };
    let seed_minutes = a.seed_minutes.min(24 * 60);
    let result = if as_torrent { torrent::download(&o, seed_minutes, !a.no_web_seed) } else { http::download(&o) };
    match result {
        Ok(d) => {
            let speed = d.bytes as f64 / d.seconds.max(0.001);
            if let Some(f) = &a.forget_file {
                if let Ok(meta) = std::fs::metadata(f) {
                    let _ = std::fs::write(f, vec![0u8; meta.len() as usize]);
                }
                let _ = std::fs::remove_file(f);
            }
            // Written last, so a torrent that was sharing ends as "done".
            status::event(&serde_json::json!({ "event": "done", "path": d.path, "bytes": d.bytes, "seconds": d.seconds, "speed": speed, "connections": d.connections }));
            if o.json {
                println!("{}", serde_json::json!({ "event": "done", "path": d.path, "bytes": d.bytes, "seconds": d.seconds, "speed": speed, "connections": d.connections }));
            } else {
                println!("{}  {} in {:.1} s  ({}/s, up to {} {})", d.path.display(), http::mb(d.bytes as f64), d.seconds, http::mb(speed), d.connections, if as_torrent { "peer(s)" } else { "connection(s)" });
            }
        }
        Err(e) => {
            status::event(&serde_json::json!({ "event": "error", "error": e }));
            if o.json {
                println!("{}", serde_json::json!({ "event": "error", "error": e }));
            } else {
                eprintln!("error: {e}");
            }
            std::process::exit(1);
        }
    }
}

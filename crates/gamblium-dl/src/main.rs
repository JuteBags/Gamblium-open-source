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
    /// Folder to save into (default: the current folder).
    #[arg(short, long, default_value = ".")]
    dir: PathBuf,
    /// Most connections to open. The downloader starts with one and adds
    /// more only while they make the download faster.
    #[arg(short = 'x', long, default_value_t = 16)]
    max_connections: usize,
    /// Connections to open straight away. The count still grows or shrinks
    /// from there. Gamblium's helper asks for 4 on files it knows are big.
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

fn main() {
    let a = Args::parse();
    if let Some(file) = a.status_file.clone() {
        status::init(file);
    }
    let mut headers = Vec::new();
    // A login cookie comes in through the environment, so it never shows on a
    // command line, and is taken out again at once.
    if let Ok(cookie) = std::env::var("GAMBLIUM_DL_COOKIE") {
        std::env::remove_var("GAMBLIUM_DL_COOKIE");
        if !cookie.is_empty() {
            headers.push(("Cookie".to_owned(), cookie));
        }
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
    let o = http::Options { urls: a.urls, out: a.out, dir: a.dir, max_connections: a.max_connections.clamp(1, 32), headers, json: a.json, quiet: a.quiet, status_details: a.status_file.is_some(), start_connections: a.start_connections.clamp(1, 16), too_slow: None, give_up_after: std::time::Duration::from_secs(a.give_up_after.max(1)) };
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

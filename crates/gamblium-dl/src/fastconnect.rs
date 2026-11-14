//! A server's address that answers first (owner's machine, Nov 14 2026: GitHub's file host
//! resolved to several addresses, one did not answer, and trying them in order cost a 21 s
//! connect timeout per new connection; an agent's download sat at "starting" for 8 s).
//!
//! The resolver tries every address of a name at once and puts the first one that accepts a
//! connection at the front; the HTTP library then connects to it. The order is kept for a
//! minute per name, so a download's many connections pay for the race once.

use std::collections::HashMap;
use std::io;
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant};

const RACE_FOR: Duration = Duration::from_secs(4);
const KEEP: Duration = Duration::from_secs(60);

static CACHE: Mutex<Option<HashMap<String, (Instant, Vec<SocketAddr>)>>> = Mutex::new(None);

pub struct FirstToAnswer;

impl ureq::Resolver for FirstToAnswer {
    fn resolve(&self, netloc: &str) -> io::Result<Vec<SocketAddr>> {
        if let Some((at, addrs)) = CACHE.lock().unwrap().as_ref().and_then(|c| c.get(netloc).cloned()) {
            if at.elapsed() < KEEP {
                return Ok(addrs);
            }
        }
        let addrs: Vec<SocketAddr> = netloc.to_socket_addrs()?.collect();
        let ordered = race(&addrs);
        CACHE.lock().unwrap().get_or_insert_with(HashMap::new).insert(netloc.to_owned(), (Instant::now(), ordered.clone()));
        Ok(ordered)
    }
}

/// The addresses, those that accepted a connection first (in the order they did), then the rest.
pub fn race(addrs: &[SocketAddr]) -> Vec<SocketAddr> {
    if addrs.len() <= 1 {
        return addrs.to_vec();
    }
    let (tx, rx) = mpsc::channel();
    for (i, a) in addrs.iter().copied().enumerate() {
        let tx = tx.clone();
        std::thread::spawn(move || {
            if TcpStream::connect_timeout(&a, RACE_FOR).is_ok() {
                let _ = tx.send(i);
            }
        });
    }
    drop(tx);
    let mut first: Vec<usize> = Vec::new();
    let deadline = Instant::now() + RACE_FOR;
    // The first answer decides; others that answer within 50 ms of it follow it.
    while let Ok(i) = rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
        first.push(i);
        let soon = Instant::now() + Duration::from_millis(50);
        while let Ok(j) = rx.recv_timeout(soon.saturating_duration_since(Instant::now())) {
            first.push(j);
        }
        break;
    }
    let mut out: Vec<SocketAddr> = first.iter().map(|&i| addrs[i]).collect();
    out.extend(addrs.iter().enumerate().filter(|(i, _)| !first.contains(i)).map(|(_, a)| *a));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn the_address_that_answers_comes_first() {
        let live = TcpListener::bind("127.0.0.1:0").unwrap();
        let live_addr = live.local_addr().unwrap();
        // A port nobody listens on (bound, then closed): refused at once on most systems; and
        // an address that swallows the connection (TEST-NET-1, never routed).
        let dead = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap();
        let black_hole: SocketAddr = "192.0.2.1:443".parse().unwrap();
        let t = Instant::now();
        let order = race(&[black_hole, dead, live_addr]);
        assert_eq!(order[0], live_addr);
        assert_eq!(order.len(), 3);
        assert!(t.elapsed() < Duration::from_secs(2), "{:?}", t.elapsed());
        assert_eq!(race(&[dead]), vec![dead]);
    }
}

//! TCP connect port scan with a scope check.
//!
//! Loopback and private addresses can be scanned freely. Any other target must
//! be listed in a scope file the user wrote (for example a bug bounty scope).
//! There is deliberately no switch that skips this.

use serde::Serialize;
use std::io::Read;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Duration;

/// Ports worth checking first on a web or infrastructure target.
pub const COMMON_PORTS: &[u16] = &[
    21, 22, 23, 25, 53, 80, 81, 110, 111, 135, 139, 143, 389, 443, 445, 465, 587, 636, 993, 995, 1080, 1433, 1521,
    1883, 2049, 2181, 2375, 2376, 3000, 3306, 3389, 4443, 5000, 5432, 5601, 5672, 5900, 5984, 6379, 7001, 8000,
    8008, 8080, 8081, 8088, 8443, 8888, 9000, 9090, 9092, 9200, 9300, 9418, 10000, 11211, 15672, 27017,
];

/// "80,443,8000-8010" -> sorted, de-duplicated list.
pub fn parse_ports(spec: &str) -> Result<Vec<u16>, String> {
    let mut out = Vec::new();
    for part in spec.split(',').map(str::trim).filter(|p| !p.is_empty()) {
        let (a, b) = match part.split_once('-') {
            Some((a, b)) => (a.trim(), b.trim()),
            None => (part, part),
        };
        let lo: u16 = a.parse().map_err(|_| format!("bad port '{part}'"))?;
        let hi: u16 = b.parse().map_err(|_| format!("bad port '{part}'"))?;
        if lo == 0 || lo > hi {
            return Err(format!("bad port range '{part}'"));
        }
        out.extend(lo..=hi);
    }
    out.sort_unstable();
    out.dedup();
    if out.is_empty() {
        return Err("no ports given".into());
    }
    Ok(out)
}

/// Addresses that can only be the user's own machine or local network.
pub fn is_local(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_loopback() || v4.is_private() || v4.is_link_local(),
        IpAddr::V6(v6) => v6.is_loopback() || (v6.segments()[0] & 0xfe00) == 0xfc00 || (v6.segments()[0] & 0xffc0) == 0xfe80,
    }
}

/// One line of a scope file: a host name, `*.example.com`, an IP, or an IPv4 CIDR.
#[derive(Debug, PartialEq)]
pub enum ScopeEntry {
    Host(String),
    Wildcard(String),
    Cidr(u32, u32),
}

pub fn parse_scope(text: &str) -> Vec<ScopeEntry> {
    text.lines()
        .map(|l| l.split('#').next().unwrap_or("").trim().to_ascii_lowercase())
        .filter(|l| !l.is_empty())
        .filter_map(|l| {
            if let Some(rest) = l.strip_prefix("*.") {
                return Some(ScopeEntry::Wildcard(rest.to_owned()));
            }
            if let Some((ip, bits)) = l.split_once('/') {
                let ip: Ipv4Addr = ip.parse().ok()?;
                let bits: u32 = bits.parse().ok().filter(|b| *b <= 32)?;
                let mask = if bits == 0 { 0 } else { u32::MAX << (32 - bits) };
                return Some(ScopeEntry::Cidr(u32::from(ip) & mask, mask));
            }
            Some(ScopeEntry::Host(l))
        })
        .collect()
}

/// Is this target (as typed, plus the address it resolved to) inside the scope?
pub fn in_scope(target: &str, ip: IpAddr, scope: &[ScopeEntry]) -> bool {
    let t = target.to_ascii_lowercase();
    scope.iter().any(|e| match e {
        ScopeEntry::Host(h) => *h == t || *h == ip.to_string(),
        ScopeEntry::Wildcard(d) => t.ends_with(&format!(".{d}")),
        ScopeEntry::Cidr(net, mask) => matches!(ip, IpAddr::V4(v4) if u32::from(v4) & mask == *net),
    })
}

pub fn resolve(target: &str) -> Result<IpAddr, String> {
    if let Ok(ip) = target.parse::<IpAddr>() {
        return Ok(ip);
    }
    (target, 0u16)
        .to_socket_addrs()
        .map_err(|e| format!("cannot resolve {target}: {e}"))?
        .next()
        .map(|a| a.ip())
        .ok_or(format!("cannot resolve {target}"))
}

#[derive(Serialize, Debug)]
pub struct OpenPort {
    pub port: u16,
    /// First bytes the service sent by itself, if any (SSH, FTP, SMTP do).
    pub banner: Option<String>,
}

#[derive(Serialize)]
pub struct ScanResult {
    pub target: String,
    pub ip: String,
    pub ports_scanned: usize,
    pub open: Vec<OpenPort>,
}

fn banner(stream: &mut TcpStream) -> Option<String> {
    stream.set_read_timeout(Some(Duration::from_millis(300))).ok()?;
    let mut buf = [0u8; 96];
    let n = stream.read(&mut buf).ok().filter(|n| *n > 0)?;
    let text: String = String::from_utf8_lossy(&buf[..n])
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    Some(text.trim().to_owned()).filter(|t| !t.is_empty())
}

pub fn scan(target: &str, ip: IpAddr, ports: &[u16], timeout: Duration, workers: usize) -> ScanResult {
    let next = AtomicUsize::new(0);
    let open = Mutex::new(Vec::new());
    std::thread::scope(|s| {
        for _ in 0..workers.clamp(1, ports.len()) {
            s.spawn(|| loop {
                let i = next.fetch_add(1, Ordering::Relaxed);
                let Some(&port) = ports.get(i) else { break };
                if let Ok(mut stream) = TcpStream::connect_timeout(&SocketAddr::new(ip, port), timeout) {
                    let b = banner(&mut stream);
                    open.lock().unwrap().push(OpenPort { port, banner: b });
                }
            });
        }
    });
    let mut open = open.into_inner().unwrap();
    open.sort_by_key(|p| p.port);
    ScanResult { target: target.to_owned(), ip: ip.to_string(), ports_scanned: ports.len(), open }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn parses_port_lists_and_ranges() {
        assert_eq!(parse_ports("443, 80,8000-8002,80").unwrap(), vec![80, 443, 8000, 8001, 8002]);
        assert!(parse_ports("0").is_err());
        assert!(parse_ports("90-80").is_err());
        assert!(parse_ports("http").is_err());
        assert!(parse_ports("").is_err());
    }

    #[test]
    fn local_addresses_need_no_scope() {
        for ip in ["127.0.0.1", "10.1.2.3", "192.168.1.5", "172.16.0.9", "169.254.1.1", "::1", "fd00::1"] {
            assert!(is_local(ip.parse().unwrap()), "{ip}");
        }
        for ip in ["8.8.8.8", "172.32.0.1", "1.1.1.1", "2606:4700::1111"] {
            assert!(!is_local(ip.parse().unwrap()), "{ip}");
        }
    }

    #[test]
    fn scope_matches_hosts_wildcards_and_cidrs_only() {
        let scope = parse_scope("# my bounty scope\nexample.com\n*.example.org  # subdomains\n203.0.113.0/24\n198.51.100.7\nbad/99\n");
        assert_eq!(scope.len(), 4);
        let ip = |s: &str| s.parse::<IpAddr>().unwrap();
        assert!(in_scope("Example.com", ip("93.184.216.34"), &scope));
        assert!(in_scope("api.example.org", ip("93.184.216.34"), &scope));
        assert!(!in_scope("example.org", ip("93.184.216.34"), &scope)); // wildcard covers subdomains only
        assert!(!in_scope("notexample.com", ip("93.184.216.34"), &scope));
        assert!(in_scope("whatever.test", ip("203.0.113.200"), &scope));
        assert!(!in_scope("whatever.test", ip("203.0.114.1"), &scope));
        assert!(in_scope("198.51.100.7", ip("198.51.100.7"), &scope));
        assert!(!in_scope("8.8.8.8", ip("8.8.8.8"), &[]));
    }

    #[test]
    fn finds_an_open_local_port_and_skips_a_closed_one() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let open_port = listener.local_addr().unwrap().port();
        let closed_port = {
            let l = TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap().port()
        };
        let r = scan("127.0.0.1", "127.0.0.1".parse().unwrap(), &[open_port, closed_port], Duration::from_millis(500), 4);
        assert_eq!(r.open.iter().map(|p| p.port).collect::<Vec<_>>(), vec![open_port]);
        assert_eq!(r.ports_scanned, 2);
    }
}

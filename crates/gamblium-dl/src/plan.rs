//! The parts of the downloader that need no network: how a file is cut into
//! pieces, how many connections to use, what to call the file.

use std::collections::VecDeque;

/// Files smaller than this are fetched in one go: splitting costs more than it gains.
pub const SPLIT_FROM: u64 = 8 * 1024 * 1024;

/// Byte ranges (first, last inclusive) still to fetch.
pub fn pieces(size: u64, piece: u64) -> VecDeque<(u64, u64)> {
    let mut out = VecDeque::new();
    let mut at = 0;
    while at < size {
        let end = (at + piece).min(size) - 1;
        out.push_back((at, end));
        at = end + 1;
    }
    out
}

/// Piece size: about 1/64 of the file, between 1 and 8 MB, so that there is
/// always work to hand to a new connection and little to redo after a failure.
pub fn piece_size(size: u64) -> u64 {
    const MB: u64 = 1024 * 1024;
    (size / 64).clamp(MB, 8 * MB)
}

/// "bytes 0-0/756023296" -> (0, 0, Some(756023296))
pub fn content_range(text: &str) -> Option<(u64, u64, Option<u64>)> {
    let rest = text.trim().strip_prefix("bytes")?.trim_start_matches([' ', '=']);
    let (span, total) = rest.split_once('/')?;
    let (a, b) = span.split_once('-')?;
    Some((a.trim().parse().ok()?, b.trim().parse().ok()?, total.trim().parse().ok()))
}

/// Chooses the number of connections from what the line actually delivers.
///
/// It starts with one. While doubling keeps raising the speed by a real
/// margin it doubles again; the first doubling that does not pay is undone
/// and the count stays there. A server that pushes back (429, 503, resets)
/// halves the count, and the count never again rises above that.
#[derive(Debug)]
pub struct Adaptive {
    pub conns: usize,
    max: usize,
    before: Option<(usize, f64)>,
    settled: bool,
}

/// A doubling must raise the speed by this factor to be kept. At 1.2 a
/// fast server settled on 4 connections at 9.8 MiB/s where 16 gave 11
/// (tester, kernel.org), so a smaller gain is now enough.
const WORTH_IT: f64 = 1.08;

impl Adaptive {
    pub fn new(max: usize) -> Self {
        Adaptive { conns: 1, max: max.max(1), before: None, settled: max <= 1 }
    }

    /// `speed`: bytes per second over the last window at the current count.
    pub fn step(&mut self, speed: f64, pushed_back: bool) -> usize {
        if pushed_back {
            self.conns = (self.conns / 2).max(1);
            self.max = self.conns;
            self.settled = true;
            return self.conns;
        }
        if self.settled {
            return self.conns;
        }
        if let Some((prev, prev_speed)) = self.before {
            if speed < prev_speed * WORTH_IT {
                self.conns = prev;
                self.settled = true;
                return self.conns;
            }
        }
        if self.conns >= self.max {
            self.settled = true;
            return self.conns;
        }
        self.before = Some((self.conns, speed));
        self.conns = (self.conns * 2).min(self.max);
        self.conns
    }
}

/// A file name that is safe on Windows, from a header or an address.
pub fn safe_name(raw: &str) -> Option<String> {
    let last = raw.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = last.chars().map(|c| if c.is_control() || "<>:\"|?*".contains(c) { '_' } else { c }).collect();
    let cleaned = cleaned.trim().trim_matches('.').trim().to_owned();
    let stem = cleaned.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = ["CON", "PRN", "AUX", "NUL"].contains(&stem.as_str())
        || (stem.len() == 4 && (stem.starts_with("COM") || stem.starts_with("LPT")) && stem.as_bytes()[3].is_ascii_digit());
    if cleaned.is_empty() || reserved {
        return None;
    }
    Some(cleaned.chars().take(180).collect())
}

/// The name in a Content-Disposition header, if it carries one.
pub fn disposition_name(header: &str) -> Option<String> {
    for part in header.split(';').map(str::trim) {
        if let Some(v) = part.strip_prefix("filename*=") {
            let v = v.trim_matches('"');
            let encoded = v.splitn(3, '\'').nth(2).unwrap_or(v);
            let decoded = percent_decode(encoded);
            if let Some(n) = safe_name(&decoded) {
                return Some(n);
            }
        }
    }
    for part in header.split(';').map(str::trim) {
        if let Some(v) = part.strip_prefix("filename=") {
            if let Some(n) = safe_name(v.trim_matches('"')) {
                return Some(n);
            }
        }
    }
    None
}

pub fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Some(b) = std::str::from_utf8(&bytes[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The name to save under: the server's, else the end of the address.
pub fn name_for(disposition: Option<&str>, address: &str) -> String {
    disposition
        .and_then(disposition_name)
        .or_else(|| {
            let path = url::Url::parse(address).ok()?.path().to_owned();
            safe_name(&percent_decode(&path))
        })
        .unwrap_or_else(|| "download".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_file_is_cut_into_pieces_that_cover_it_exactly() {
        let p = pieces(10, 4);
        assert_eq!(p, VecDeque::from([(0, 3), (4, 7), (8, 9)]));
        assert!(pieces(0, 4).is_empty());
        assert_eq!(pieces(4, 4), VecDeque::from([(0, 3)]));
        let size = 756_023_296u64;
        let p = pieces(size, piece_size(size));
        assert_eq!(p.iter().map(|(a, b)| b - a + 1).sum::<u64>(), size);
        assert_eq!(piece_size(1000), 1024 * 1024);
        assert_eq!(piece_size(u64::MAX / 2), 8 * 1024 * 1024);
    }

    #[test]
    fn content_range_is_read() {
        assert_eq!(content_range("bytes 0-0/756023296"), Some((0, 0, Some(756023296))));
        assert_eq!(content_range("bytes 4-7/*"), Some((4, 7, None)));
        assert_eq!(content_range("items 0-1/2"), None);
    }

    #[test]
    fn a_fast_server_stays_on_one_connection() {
        // One connection already fills the line: the second adds nothing.
        let mut a = Adaptive::new(16);
        assert_eq!(a.step(11.0e6, false), 2);
        assert_eq!(a.step(11.5e6, false), 1);
        assert_eq!(a.step(11.0e6, false), 1);
    }

    #[test]
    fn a_server_slow_per_connection_gets_more_until_it_stops_paying() {
        let mut a = Adaptive::new(16);
        assert_eq!(a.step(0.2e6, false), 2);
        assert_eq!(a.step(0.4e6, false), 4);
        assert_eq!(a.step(0.8e6, false), 8);
        assert_eq!(a.step(1.6e6, false), 16);
        assert_eq!(a.step(3.2e6, false), 16);
        // The line is full at 8: 16 is undone.
        let mut a = Adaptive::new(16);
        for s in [1.0e6, 2.0e6, 4.0e6, 8.0e6] {
            a.step(s, false);
        }
        assert_eq!(a.conns, 16);
        assert_eq!(a.step(8.3e6, false), 8);
    }

    #[test]
    fn a_server_that_pushes_back_halves_the_count_for_good() {
        let mut a = Adaptive::new(16);
        a.step(1.0e6, false);
        a.step(2.0e6, false);
        a.step(4.0e6, false);
        assert_eq!(a.conns, 8);
        assert_eq!(a.step(0.1e6, true), 4);
        assert_eq!(a.step(9.0e6, false), 4);
        assert_eq!(a.step(0.1e6, true), 2);
        assert_eq!(a.step(0.1e6, true), 1);
        assert_eq!(a.step(0.1e6, true), 1);
    }

    #[test]
    fn names_are_made_safe() {
        assert_eq!(name_for(None, "https://x.org/iso/debian-13.7.0-amd64-netinst.iso?mirror=1"), "debian-13.7.0-amd64-netinst.iso");
        assert_eq!(name_for(Some("attachment; filename=\"report 2026.pdf\""), "https://x.org/dl"), "report 2026.pdf");
        assert_eq!(name_for(Some("attachment; filename*=UTF-8''na%C3%AFve%20file.txt; filename=\"x.txt\""), "https://x.org/"), "naïve file.txt");
        assert_eq!(name_for(Some("attachment; filename=\"..\\..\\evil.exe\""), "https://x.org/"), "evil.exe");
        assert_eq!(name_for(None, "https://x.org/"), "download");
        assert_eq!(name_for(None, "https://x.org/a%20b.zip"), "a b.zip");
        assert_eq!(safe_name("CON.txt"), None);
        assert_eq!(safe_name("a<b>:c.txt").as_deref(), Some("a_b__c.txt"));
        assert_eq!(percent_decode("100%"), "100%");
    }
}

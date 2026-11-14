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
/// and the count rests there. A server that pushes back (429, 503, resets)
/// halves the count, and the count never again rises above that.
///
/// Resting is not for good (owner, Nov 14 2026: one bad window must not fix the count for the
/// whole download). It tries one more doubling again after 13 windows (about 30 s), and each
/// try that does not pay doubles that wait (1, 2, 4, then 8 minutes at most); a try that pays
/// starts the waits over. It tries early, but never within 13 windows of the last try, when the
/// speed has stayed under 3/4 of the resting speed for 3 windows (the server or the line
/// changed). Each rest takes the speed of the moment as its new level, so a line that is simply
/// slower now is not tried again and again.
#[derive(Debug)]
pub struct Adaptive {
    pub conns: usize,
    max: usize,
    before: Option<(usize, f64)>,
    settled: bool,
    /// Tries in a row that did not pay; the wait before the next is `RETRY << (misses - 1)`.
    misses: u32,
    /// Windows since the count last came to rest.
    resting: u32,
    /// Speed when it came to rest, and windows in a row since then well below it.
    level: f64,
    low: u32,
    /// A doubling k -> 2k did not pay and k + k/2 is being tried, so the count lands between
    /// two powers of two when that is where the most speed is (6 rather than 4 or 8).
    between: bool,
}

/// Windows (about 2.3 s each) to rest before trying one more doubling.
const RETRY: u32 = 13;
/// The wait doubles at most this many times: 13 << 4 windows is about 8 minutes.
const MAX_MISSES: u32 = 4;

/// A doubling must raise the speed by this factor to be kept. At 1.2 a
/// fast server settled on 4 connections at 9.8 MiB/s where 16 gave 11
/// (tester, kernel.org), so a smaller gain is now enough.
const WORTH_IT: f64 = 1.08;

impl Adaptive {
    pub fn new(max: usize) -> Self {
        Adaptive { conns: 1, max: max.max(1), before: None, settled: max <= 1, misses: 0, resting: 0, level: 0.0, low: 0, between: false }
    }

    /// Starts at a count that was found before for this server (or asked for), resting there:
    /// no doubling from it straight away, the usual tries 30 s later.
    pub fn starting_at(max: usize, n: usize) -> Self {
        let mut a = Self::new(max);
        if n > 1 {
            a.conns = n.min(a.max);
            a.settled = true;
            a.misses = 1;
        }
        a
    }

    /// Not in the middle of a try.
    pub fn at_rest(&self) -> bool {
        self.settled
    }

    /// The highest count shown to pay so far: the current one at rest, else the one before the
    /// try under way. Remembered when a download ends before the count came to rest.
    pub fn proven(&self) -> usize {
        if self.settled { self.conns } else { self.before.map_or(self.conns, |b| b.0) }
    }

    fn rest(&mut self, conns: usize, level: f64) -> usize {
        self.conns = conns;
        self.settled = true;
        self.before = None;
        self.resting = 0;
        self.level = level;
        self.low = 0;
        conns
    }

    /// `speed`: bytes per second over the last window at the current count.
    pub fn step(&mut self, speed: f64, pushed_back: bool) -> usize {
        if pushed_back {
            let half = (self.conns / 2).max(1);
            self.max = half;
            return self.rest(half, 0.0);
        }
        if self.settled {
            // Nothing more to try: at the limit, or a server that pushed back.
            if self.conns >= self.max {
                return self.conns;
            }
            self.resting += 1;
            if self.level == 0.0 {
                self.level = speed;
            }
            self.low = if speed < self.level * 0.75 { self.low + 1 } else { 0 };
            let due = self.resting >= RETRY << self.misses.saturating_sub(1).min(MAX_MISSES);
            let changed = self.low >= 3 && self.resting >= RETRY;
            if !(due || changed) {
                return self.conns;
            }
            self.settled = false;
        } else if let Some((prev, prev_speed)) = self.before {
            if speed < prev_speed * WORTH_IT {
                if !self.between && prev >= 2 && self.conns == prev * 2 {
                    self.between = true;
                    self.conns = prev + prev / 2;
                    return self.conns;
                }
                self.between = false;
                self.misses += 1;
                return self.rest(prev, prev_speed);
            }
            self.misses = 0;
            if self.between {
                self.between = false;
                return self.rest(self.conns, speed);
            }
        }
        if self.conns >= self.max {
            return self.rest(self.conns, speed);
        }
        self.before = Some((self.conns, speed));
        self.conns = (self.conns * 2).min(self.max);
        self.conns
    }
}

/// The site a host belongs to: its last two labels, three when the second-last is a short
/// country-style label (`a.b.co.uk` -> `b.co.uk`). Good enough to group one company's servers.
pub fn site_of(host: &str) -> &str {
    let labels: Vec<&str> = host.split('.').collect();
    if labels.len() <= 2 || host.parse::<std::net::IpAddr>().is_ok() {
        return host;
    }
    let short = labels[labels.len() - 2].len() <= 3 && labels[labels.len() - 1].len() == 2;
    let keep = if short { 3 } else { 2 }.min(labels.len());
    let cut: usize = labels[..labels.len() - keep].iter().map(|l| l.len() + 1).sum();
    &host[cut..]
}

/// Where to start a download from `host`, from the counts other downloads came to rest at
/// (owner, Nov 14 2026: a new website must not cost a fresh search every time):
/// 1. this very host;
/// 2. another host of the same site (the newest);
/// 3. once at least 3 servers are known, the count most of them came to (ties: the lower), as
///    that mostly says how much the line itself carries.
/// It is only a start: the count is still tried and corrected while the file arrives.
pub fn first_guess(known: &[(String, usize)], host: &str) -> Option<usize> {
    let clamp = |n: usize| n.clamp(1, 16);
    if let Some((_, n)) = known.iter().find(|(h, _)| h == host) {
        return Some(clamp(*n));
    }
    let site = site_of(host);
    if let Some((_, n)) = known.iter().find(|(h, _)| site_of(h) == site) {
        return Some(clamp(*n));
    }
    if known.len() < 3 {
        return None;
    }
    let mut counts = std::collections::BTreeMap::new();
    for (_, n) in known {
        *counts.entry(clamp(*n)).or_insert(0) += 1;
    }
    counts.into_iter().max_by(|a, b| a.1.cmp(&b.1).then(b.0.cmp(&a.0))).map(|(n, _)| n)
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
        // 16 does not pay: 12 is tried, does not pay either, back to 8.
        assert_eq!(a.step(8.3e6, false), 12);
        assert_eq!(a.step(8.2e6, false), 8);
        // Where the most is between two powers of two, it lands there.
        let mut a = Adaptive::new(16);
        for s in [1.0e6, 2.0e6, 4.0e6] {
            a.step(s, false);
        }
        assert_eq!(a.conns, 8);
        assert_eq!(a.step(4.1e6, false), 6);
        assert_eq!(a.step(5.0e6, false), 6);
        assert_eq!(a.step(5.0e6, false), 6);
    }

    #[test]
    fn a_try_that_did_not_pay_is_made_again_later_with_growing_waits() {
        let mut a = Adaptive::new(16);
        assert_eq!(a.step(10.0e6, false), 2);
        assert_eq!(a.step(10.2e6, false), 1);
        // Rests 13 windows, then tries 2 again.
        let mut windows = 0;
        while a.step(10.0e6, false) == 1 {
            windows += 1;
        }
        assert_eq!(windows, RETRY as usize - 1);
        assert_eq!(a.step(10.0e6, false), 1);
        // Second miss: twice the wait.
        let mut windows = 0;
        while a.step(10.0e6, false) == 1 {
            windows += 1;
        }
        assert_eq!(windows, 2 * RETRY as usize - 1);
        // This time the second connection pays: kept, and the waits start over.
        assert_eq!(a.step(14.0e6, false), 4);
        assert_eq!(a.step(14.1e6, false), 3);
        assert_eq!(a.step(14.0e6, false), 2);
        let mut windows = 0;
        while a.step(14.0e6, false) == 2 {
            windows += 1;
        }
        assert_eq!(windows, RETRY as usize - 1, "one miss since the last gain");
        assert_eq!(a.step(14.0e6, false), 3);
        assert_eq!(a.step(14.0e6, false), 2);
        // The wait never grows past 13 << 4 windows.
        a.misses = 9;
        let mut windows = 0;
        while a.step(14.0e6, false) == 2 {
            windows += 1;
        }
        assert_eq!(windows, (RETRY << MAX_MISSES) as usize - 1);
    }

    #[test]
    fn a_drop_in_speed_brings_the_next_try_forward_once() {
        let mut a = Adaptive::new(16);
        a.step(10.0e6, false);
        a.step(10.0e6, false);
        for _ in 0..5 {
            a.step(10.0e6, false);
        }
        a.misses = 3; // the next regular try would be minutes away
        // The single connection falls to 4 MB/s: tried again once 13 windows have passed.
        let mut windows = 0;
        while a.step(4.0e6, false) == 1 {
            windows += 1;
        }
        assert!(windows <= RETRY as usize, "{windows}");
        // Not paying: back to one, resting at the new, lower level; no new early try at 4 MB/s.
        assert_eq!(a.step(4.1e6, false), 1);
        for _ in 0..(RETRY * 4) {
            assert_eq!(a.step(4.0e6, false), 1);
        }
    }

    #[test]
    fn a_count_found_before_is_where_it_starts_and_rests() {
        let mut a = Adaptive::starting_at(16, 4);
        assert_eq!(a.conns, 4);
        for _ in 0..(RETRY - 1) {
            assert_eq!(a.step(9.0e6, false), 4);
        }
        assert_eq!(a.step(9.0e6, false), 8);
        assert_eq!(Adaptive::starting_at(16, 1).conns, 1);
        assert_eq!(Adaptive::starting_at(2, 9).conns, 2);
    }

    #[test]
    fn at_the_limit_or_after_push_back_nothing_more_is_tried() {
        let mut a = Adaptive::new(1);
        for _ in 0..200 {
            assert_eq!(a.step(1.0e6, false), 1);
        }
        let mut a = Adaptive::new(16);
        a.step(1.0e6, false);
        a.step(2.0e6, false);
        assert_eq!(a.step(0.1e6, true), 2);
        for _ in 0..500 {
            assert_eq!(a.step(0.1e6, false), 2);
        }
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
    fn a_new_server_starts_from_what_is_known() {
        let k = |v: &[(&str, usize)]| v.iter().map(|(h, n)| (h.to_string(), *n)).collect::<Vec<_>>();
        let known = k(&[("release-assets.githubusercontent.com", 3), ("cdn.kernel.org", 1), ("files.example.co.uk", 6)]);
        assert_eq!(first_guess(&known, "release-assets.githubusercontent.com"), Some(3));
        // Same site, other server.
        assert_eq!(first_guess(&known, "objects.githubusercontent.com"), Some(3));
        assert_eq!(first_guess(&known, "dl.example.co.uk"), Some(6));
        // Unknown site: what most servers came to; a tie goes to the lower count.
        assert_eq!(first_guess(&known, "mirror.xtom.com.hk"), Some(1));
        let known = k(&[("a.one.org", 4), ("b.two.org", 4), ("c.three.org", 1)]);
        assert_eq!(first_guess(&known, "new.site.net"), Some(4));
        // Too little known: start at one.
        assert_eq!(first_guess(&k(&[("a.one.org", 8)]), "new.site.net"), None);
        assert_eq!(first_guess(&[], "x.org"), None);
        assert_eq!(site_of("127.0.0.1"), "127.0.0.1");
        assert_eq!(site_of("kernel.org"), "kernel.org");
        assert_eq!(site_of("a.b.c.com.au"), "c.com.au");
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

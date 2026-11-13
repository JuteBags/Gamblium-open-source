// Pure helpers for the popup and the dashboard pages (tabs and memory, sessions,
// downloads, settings). No browser APIs, so node --test runs them.
import { safeFolder } from '../download-rules.js';

const DASH = '–';

// ---- Numbers ------------------------------------------------------------------

export function fmtMb(mb) {
  if (mb === null || mb === undefined || Number.isNaN(mb)) return DASH;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

/** Percent of one core, one decimal. */
export function fmtPct(p) {
  return p === null || p === undefined || Number.isNaN(p) ? DASH : `${Number(p).toFixed(1)}%`;
}

export function fmtSize(bytes) {
  if (bytes === null || bytes === undefined || bytes < 0) return DASH;
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1e6) return `${(bytes / 1e3).toFixed(1)} kB`;
  if (bytes < 1e9) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${(bytes / 1e9).toFixed(2)} GB`;
}

export function fmtAgo(then, now) {
  const s = Math.max(0, (now - then) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 7 * 86400) {
    const d = Math.floor(s / 86400);
    return `${d} day${d === 1 ? '' : 's'} ago`;
  }
  return new Date(then).toISOString().slice(0, 10);
}

/** "10 min", "90 s", "2 h": a sleep delay in words. */
export function fmtDelay(sec) {
  if (sec % 3600 === 0) return `${sec / 3600} h`;
  if (sec % 60 === 0) return `${sec / 60} min`;
  return `${sec} s`;
}

/** A whole number inside [min, max], or the fallback. */
export function clampInt(raw, min, max, fallback) {
  const n = Number(raw);
  if (raw === '' || raw === null || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// ---- Tabs ---------------------------------------------------------------------

export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Where a tab's page comes from, for the small line under its title. */
export function siteLabel(url) {
  const u = String(url ?? '');
  if (/^https?:/i.test(u)) return hostOf(u) || u;
  if (/^chrome-extension:/i.test(u)) return 'Extension page';
  if (/^(brave|chrome|edge|about|devtools|view-source):/i.test(u)) return 'Browser page';
  if (/^file:/i.test(u)) return 'File on this computer';
  return u;
}

/** State of a browser tab object: asleep (discarded), frozen, or awake. */
export function stateOf(tab) {
  return tab.discarded ? 'asleep' : tab.frozen ? 'frozen' : 'awake';
}

/** tabs: anything with a `state`, or raw browser tabs. */
export function countStates(tabs) {
  const c = { total: 0, awake: 0, frozen: 0, asleep: 0 };
  for (const t of tabs ?? []) {
    c.total += 1;
    c[t.state ?? stateOf(t)] += 1;
  }
  return c;
}

export function statesLine(c) {
  const parts = [plural(c.total, 'tab')];
  for (const k of ['awake', 'frozen', 'asleep']) if (c[k]) parts.push(`${c[k]} ${k}`);
  return parts.join(' · ');
}

/** Widths in percent for the awake / frozen / asleep bar. They add up to 100. */
export function stateShares(c) {
  if (!c.total) return { awake: 0, frozen: 0, asleep: 0 };
  const awake = Math.round((c.awake / c.total) * 100);
  const frozen = Math.round((c.frozen / c.total) * 100);
  return { awake, frozen, asleep: Math.max(0, 100 - awake - frozen) };
}

/** The pill in a tab's row. Only a tab the user is using gets colour. */
export function tabPill(row) {
  if (row.state === 'asleep' || row.state === 'frozen') return { text: row.state, cls: row.state };
  if (row.active) return { text: 'showing', cls: 'now' };
  if (row.audible) return { text: 'playing', cls: 'now' };
  return { text: 'awake', cls: '' };
}

const STATE_ORDER = { awake: 0, frozen: 1, asleep: 2 };

/** key: memory | cpu | title | state. Unknown numbers always sort last. */
export function sortTabs(rows, key = 'memory', descending = true) {
  const dir = descending ? -1 : 1;
  const num = (a, b, f) => {
    const x = f(a);
    const y = f(b);
    if (x === null || x === undefined) return y === null || y === undefined ? 0 : 1;
    if (y === null || y === undefined) return -1;
    return (x - y) * dir;
  };
  const cmp =
    key === 'cpu' ? (a, b) => num(a, b, (r) => r.cpuPct)
    : key === 'title' ? (a, b) => (a.title || a.url).localeCompare(b.title || b.url) * dir
    : key === 'state' ? (a, b) => (STATE_ORDER[a.state] - STATE_ORDER[b.state]) * -dir
    : (a, b) => num(a, b, (r) => r.memoryMb);
  return (rows ?? []).map((r, i) => [r, i]).sort((a, b) => cmp(a[0], b[0]) || a[1] - b[1]).map(([r]) => r);
}

/** Share of the largest value, 0 to 100, for the bar beside a memory figure. */
// How heavy a tab is, for its colour: what one tab holds on a 16 GB machine.
// Under 150 MB is light, 150-399 MB is heavy-ish (amber), 400 MB and more is heavy (red).
export const WEIGHT_MB = { mid: 150, heavy: 400 };
export function weightOf(mb) {
  if (mb === null || mb === undefined || !(mb >= 0)) return '';
  return mb >= WEIGHT_MB.heavy ? 'heavy' : mb >= WEIGHT_MB.mid ? 'mid' : 'light';
}

// How tight the computer is: free memory, and the browser's processor use.
export function freeLevel(mb) {
  if (mb === null || mb === undefined || !(mb >= 0)) return '';
  return mb < 1024 ? 'bad' : mb < 2048 ? 'warn' : 'ok';
}
export function cpuLevel(pct) {
  if (pct === null || pct === undefined || !(pct >= 0)) return '';
  return pct >= 60 ? 'bad' : pct >= 20 ? 'warn' : 'ok';
}

export function meterPct(value, max) {
  if (!value || !max) return 0;
  return Math.max(2, Math.min(100, Math.round((value / max) * 100)));
}

// The helper's process types (crates/gamblium/src/procs.rs, classify).
const KIND_NAMES = {
  browser: 'The browser itself',
  renderer: 'Pages',
  extension: 'Extensions',
  gpu: 'Graphics',
  utility: 'Other services',
  'utility:NetworkService': 'Network',
  'utility:AudioService': 'Audio',
  'utility:StorageService': 'Storage',
  'crashpad-handler': 'Crash reporter',
  other: 'Programs the browser started',
};

export function kindName(kind) {
  if (KIND_NAMES[kind]) return KIND_NAMES[kind];
  const service = /^utility:(.+)$/.exec(kind);
  // "VideoCaptureService" reads better as "Video capture service".
  if (service) return service[1].replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^(.)(.*)$/, (_, a, b) => a + b.toLowerCase());
  return kind;
}

/** Process types, largest first, with a name a person recognises. */
export function kindRows(kinds) {
  return Object.entries(kinds ?? {})
    .map(([kind, k]) => ({ kind, name: kindName(kind), processes: k.processes, memoryMb: k.memoryMb, cpuPct: k.cpuPct }))
    .sort((a, b) => b.memoryMb - a.memoryMb);
}

// The sleep rule that applies to a tab right now (rules.js, keepReason).
const REASON_LABELS = {
  visible: 'Showing in a window',
  'playing audio': 'Playing audio',
  pinned: 'Pinned',
  'marked never sleep': 'Marked never sleep by the browser',
  'not a web page': 'Not a web page',
  allowlisted: 'On your never-sleep list',
  'hidden, waiting': 'Hidden, waiting for the delay',
  'due to sleep': 'Due to sleep at the next check',
  'already asleep': 'Already asleep',
};

/** What the sleep rules say about the open tabs, most common first. */
export function reasonRows(reasons) {
  return Object.entries(reasons ?? {})
    .map(([reason, count]) => ({ reason, label: REASON_LABELS[reason] || reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

// ---- Host lists (never sleep, keep light) --------------------------------------

const HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** A host name out of whatever was typed: an address, a host, a host with a port. */
export function cleanHost(raw) {
  let s = String(raw ?? '').trim().toLowerCase();
  if (!s) return '';
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/[/?#].*$/, '').replace(/^.*@/, '').replace(/:\d+$/, '').replace(/^\*\./, '');
  return s.replace(/\.$/, '');
}

/** Lines of text into host names. `bad` lists what could not be used. */
export function parseHosts(text, { allowLocal = false } = {}) {
  const hosts = [];
  const bad = [];
  for (const raw of String(text ?? '').split(/[\s,]+/)) {
    if (!raw) continue;
    const h = cleanHost(raw);
    if (HOST.test(h) || (allowLocal && h === 'localhost')) {
      if (!hosts.includes(h)) hosts.push(h);
    } else if (!bad.includes(raw)) bad.push(raw);
  }
  return { hosts, bad };
}

/** True if the list covers this host, itself or through a parent domain. */
export function hostListed(list, host) {
  const h = String(host || '').toLowerCase();
  return !!h && (list ?? []).some((e) => {
    const x = String(e).trim().toLowerCase();
    return x && (h === x || h.endsWith('.' + x));
  });
}

/** The list with this host switched on or off. Off also removes a parent entry that covered it. */
export function toggleHost(list, host, on) {
  const h = String(host || '').toLowerCase();
  const rest = (list ?? []).filter((e) => {
    const x = String(e).trim().toLowerCase();
    return !(h === x || h.endsWith('.' + x));
  });
  if (!on) return rest;
  return hostListed(list, h) ? [...(list ?? [])] : [...(list ?? []), h];
}

// ---- Sessions -----------------------------------------------------------------

/** A default name for a checkpoint: local date and time to the minute. */
export function checkpointName(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}.${p(now.getMinutes())}`;
}

export function sessionSize(s) {
  return `${plural(s.windows, 'window')}, ${plural(s.tabs, 'tab')}`;
}

export function sessionSites(s) {
  return (s.hosts ?? []).join(', ');
}

/** The profile a checkpoint came from, if it has a label. A bare id says nothing to a person. */
export function sessionFrom(s) {
  const p = String(s.profile ?? '');
  return !p || /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(p) ? '' : `from ${p}`;
}

/** What to say after a save. `r` is the background's answer. */
export function savedLine(r) {
  if (!r || r.ok === false) return { cls: 'bad', text: r?.error || 'The checkpoint could not be saved.' };
  const parts = [`Saved "${r.name}": ${plural(r.tabs ?? 0, 'tab')} in ${plural(r.windows ?? 0, 'window')}.`];
  if (r.pagesCaptured) parts.push(`Scroll position and form text kept for ${plural(r.pagesCaptured, 'page')}.`);
  if (r.skipped) parts.push(`${plural(r.skipped, 'tab')} left out because ${r.skipped === 1 ? 'it is not a web page' : 'they are not web pages'}.`);
  return { cls: 'ok', text: parts.join(' ') };
}

export function restoredLine(r) {
  if (!r || r.ok === false) return { cls: 'bad', text: r?.error || 'The checkpoint could not be reopened.' };
  const tail = r.settingsRestored ? ' Its settings were put back too.' : '';
  return { cls: 'ok', text: `Reopened ${plural(r.tabs, 'tab')} in ${plural(r.windows, 'window')}. Only the tab that was showing is loaded; the others wake when you open them.${tail}` };
}

/** A file name Windows accepts for an exported checkpoint. */
export function exportFileName(name) {
  const safe = String(name ?? '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
  return `gamblium-session-${safe || 'checkpoint'}.json`;
}

// ---- Downloads ----------------------------------------------------------------

export function baseName(path) {
  return String(path ?? '').split(/[\\/]/).pop();
}

const DOWNLOAD_ERRORS = {
  USER_CANCELED: 'Cancelled',
  USER_SHUTDOWN: 'Stopped when the browser closed',
  NETWORK_FAILED: 'Failed: the connection dropped',
  NETWORK_TIMEOUT: 'Failed: the server stopped answering',
  NETWORK_DISCONNECTED: 'Failed: no connection',
  NETWORK_SERVER_DOWN: 'Failed: the server is down',
  SERVER_FORBIDDEN: 'Failed: the server refused',
  SERVER_UNAUTHORIZED: 'Failed: sign-in needed',
  SERVER_BAD_CONTENT: 'Failed: the file is no longer there',
  SERVER_NO_RANGE: 'Failed: the server cannot resume',
  FILE_NO_SPACE: 'Failed: the disk is full',
  FILE_ACCESS_DENIED: 'Failed: no permission to save there',
  FILE_VIRUS_INFECTED: 'Blocked: flagged as unsafe',
  FILE_BLOCKED: 'Blocked',
  FILE_SECURITY_CHECK_FAILED: 'Blocked: safety check failed',
  // The rest of Chromium's reasons, in words (seen: 'server content length mismatch' as raw code).
  FILE_FAILED: 'Failed: could not save the file',
  FILE_NAME_TOO_LONG: 'Failed: the file name is too long',
  FILE_TOO_LARGE: 'Failed: too large for the disk',
  FILE_TRANSIENT_ERROR: 'Failed: the disk was busy; try again',
  FILE_TOO_SHORT: 'Failed: the file arrived incomplete',
  FILE_HASH_MISMATCH: 'Failed: the file arrived damaged',
  FILE_SAME_AS_SOURCE: 'Failed: it would overwrite itself',
  NETWORK_INVALID_REQUEST: 'Failed: the address was refused',
  SERVER_FAILED: 'Failed: the server had an error',
  SERVER_CERT_PROBLEM: "Failed: the site's certificate is not valid",
  SERVER_CONTENT_LENGTH_MISMATCH: 'Failed: the file arrived incomplete',
  SERVER_CROSS_ORIGIN_REDIRECT: 'Failed: sent to another site',
  CRASH: 'Stopped when the browser closed',
};

/** Everything one row of the downloads table shows. */
export function downloadView(d) {
  let fromUrl = '';
  try {
    fromUrl = decodeURIComponent(new URL(d.url).pathname.split('/').pop() || '');
  } catch {
    // Not an address we can read a name from.
  }
  const name = baseName(d.filename) || fromUrl || 'download';
  const host = hostOf(d.url);
  const total = d.totalBytes > 0 ? d.totalBytes : null;
  const percent = total ? Math.min(100, Math.floor((d.bytesReceived / total) * 100)) : null;
  const base = { id: d.id, name, host, percent: null, cls: '', size: fmtSize(total ?? d.bytesReceived) };

  // tone picks the tint: done green, paused or moved amber, failed red, running blue, cancelled none.
  if (d.state === 'complete') {
    return d.exists === false
      ? { ...base, status: 'File moved or deleted', tone: 'moved', actions: ['erase'] }
      : { ...base, status: 'Done', tone: 'done', actions: ['show', 'erase'] };
  }
  if (d.state === 'interrupted') {
    const cancelled = d.error === 'USER_CANCELED';
    const status = DOWNLOAD_ERRORS[d.error] || `Failed: ${String(d.error || 'unknown').toLowerCase().replace(/_/g, ' ')}`;
    return { ...base, status, cls: cancelled ? '' : 'bad', tone: cancelled ? '' : 'bad', actions: d.canResume ? ['resume', 'erase'] : ['erase'] };
  }
  const got = total ? `${fmtSize(d.bytesReceived)} of ${fmtSize(total)}` : fmtSize(d.bytesReceived);
  if (d.paused) return { ...base, percent, status: `Paused · ${got}`, tone: 'paused', actions: ['resume', 'cancel'] };
  return { ...base, percent, status: got, tone: 'run', actions: ['pause', 'cancel'] };
}

export const DOWNLOAD_ACTION_NAMES = { pause: 'Pause', resume: 'Resume', cancel: 'Cancel', show: 'Show in folder', erase: 'Remove from list' };

export function anyInProgress(list) {
  return (list ?? []).some((d) => d.state === 'in_progress' && !d.paused);
}

/** One folder rule out of the three text boxes of the editor. */
export function ruleFromFields({ folder, extensions, hosts }) {
  const cleanFolder = safeFolder(folder);
  if (!cleanFolder) return { ok: false, error: 'Give the rule a folder name.' };
  const exts = [];
  for (const raw of String(extensions ?? '').split(/[\s,;]+/)) {
    const e = raw.trim().toLowerCase().replace(/^\*?\./, '');
    if (!e) continue;
    if (!/^[a-z0-9]{1,12}$/.test(e)) return { ok: false, error: `"${raw}" is not a file type. Use endings such as pdf or mp4.` };
    if (!exts.includes(e)) exts.push(e);
  }
  const parsed = parseHosts(hosts, { allowLocal: true });
  if (parsed.bad.length) return { ok: false, error: `"${parsed.bad[0]}" is not a site name.` };
  if (!exts.length && !parsed.hosts.length) return { ok: false, error: `"${cleanFolder}" needs at least one file type or site.` };
  return { ok: true, rule: { folder: cleanFolder, extensions: exts, hosts: parsed.hosts } };
}

/** All rows of the editor into rules, stopping at the first one that is wrong. */
export function rulesFromRows(rows) {
  const rules = [];
  for (const row of rows ?? []) {
    if (!String(row.folder ?? '').trim() && !String(row.extensions ?? '').trim() && !String(row.hosts ?? '').trim()) continue;
    const r = ruleFromFields(row);
    if (!r.ok) return r;
    rules.push(r.rule);
  }
  return { ok: true, rules };
}

// ---- Proxy and agent control ---------------------------------------------------

/** Why the proxy cannot be changed here, or null if it can. */
export function proxyLocked(p) {
  if (!p || p.ok === false) return null;
  if (p.controlledBy === 'controlled_by_other_extensions') return 'Another extension controls the proxy, so Gamblium cannot change it.';
  if (p.controlledBy === 'not_controllable') return 'The proxy is fixed by a policy on this computer.';
  return null;
}

/** The line under the agent-control switch. `b` is the background's bridge-status. */
export function bridgeLine(b) {
  if (!b || b.ok === false) return { cls: 'bad', text: b?.error || 'The extension did not answer.' };
  // Off: the unticked box already says it, so no line (Rule 11). On: the hint above says what it means.
  if (!b.wanted) return { cls: '', text: '' };
  if (b.connected) return { cls: 'warn', text: 'On and connected.' };
  return { cls: 'bad', text: `On, but the Gamblium helper is not connected${b.error ? ` (${b.error})` : ''}. Run "gamblium install-host", then switch this off and on.` };
}

// ---- Tabs and memory: filter, map, groups ----------------------------------------

/** Rows whose title or address holds every word of the query, in one state or all. */
export function filterTabs(rows, { query = '', state = 'all' } = {}) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter((r) => {
    if (state !== 'all' && r.state !== state) return false;
    const hay = `${r.title || ''} ${r.url || ''}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/**
 * The memory map: one block per tab, largest first, each as wide as its memory.
 * A tab with no figure (asleep, or no helper) gets the smallest share, so it is
 * still there to click. `wide` marks blocks with room for a label.
 */
export function mapBlocks(rows) {
  const known = rows.filter((r) => r.memoryMb > 0);
  const total = known.reduce((sum, r) => sum + r.memoryMb, 0);
  const floor = total ? Math.max(total * 0.012, 1) : 1;
  return [...rows]
    .sort((a, b) => (b.memoryMb || 0) - (a.memoryMb || 0))
    .map((row) => {
      const grow = Math.max(row.memoryMb || 0, floor);
      return { row, grow: Math.round(grow * 10) / 10, wide: total > 0 && (row.memoryMb || 0) / total >= 0.09 };
    });
}

/** Rows kept in their order, gathered under the window they are in. */
export function groupByWindow(rows) {
  const groups = [];
  for (const r of rows) {
    let g = groups.find((x) => x.windowId === r.windowId);
    if (!g) groups.push((g = { windowId: r.windowId, rows: [] }));
    g.rows.push(r);
  }
  return groups.sort((a, b) => a.windowId - b.windowId);
}

/** Whether a background colour (#rrggbb) makes a dark or a light look. */
export function lookOf(hex) {
  const n = parseInt(String(hex ?? '').slice(1), 16);
  if (!/^#[0-9a-f]{6}$/i.test(String(hex ?? ''))) return 'dark';
  const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(n >> 16) + 0.7152 * f((n >> 8) & 255) + 0.0722 * f(n & 255) < 0.3 ? 'dark' : 'light';
}

/** "[title](address)" for pasting into notes; brackets in the title are escaped. */
export function markdownLink(title, url) {
  const text = String(title ?? '').trim().replace(/\s+/g, ' ').replace(/([\[\]\\])/g, '\\$1') || String(url ?? '');
  return `[${text}](${String(url ?? '').replace(/\(/g, '%28').replace(/\)/g, '%29')})`;
}

/** The chip beside a site's name: is what you send there encrypted on the way? */
export function secureChip(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return { text: '', cls: '' };
  }
  if (u.protocol === 'https:') return { text: 'Secure', cls: 'ok', title: 'The connection to this site is encrypted.' };
  if (/^(localhost|127\.|10\.|192\.168\.|\[::1\])/.test(u.host)) return { text: 'Local', cls: '', title: 'This site is on your own machine or network.' };
  if (u.protocol === 'http:') return { text: 'Not secure', cls: 'warn', title: 'Not encrypted: others on the network can read what you send.' };
  return { text: '', cls: '' };
}

/** A file name for a screenshot: "screenshot example.org 2026-11-12 04.05.09.png". */
export function shotName(host, when = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${when.getFullYear()}-${p(when.getMonth() + 1)}-${p(when.getDate())} ${p(when.getHours())}.${p(when.getMinutes())}.${p(when.getSeconds())}`;
  return `screenshot ${String(host || 'page').replace(/[^a-z0-9.-]/gi, '_')} ${stamp}.png`;
}

// ---- Library: when something happened, and what kind of file it is

export const WHENS = [
  { id: 'all', label: 'Any time' },
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: 'week', label: 'Last 7 days' },
  { id: 'month', label: 'Last 30 days' },
];
const DAY = 86_400_000;
const midnight = (t) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** [from, to] in milliseconds for one of WHENS, by the local calendar. */
export function whenRange(id, now = Date.now()) {
  const today = midnight(now);
  if (id === 'today') return [today, now];
  if (id === 'yesterday') return [midnight(today - 1), today - 1];
  if (id === 'week') return [midnight(today - 6 * DAY + DAY / 2), now];
  if (id === 'month') return [midnight(today - 29 * DAY + DAY / 2), now];
  return [0, now];
}

/** Items (newest first) cut into days: "Today", "Yesterday", then the date. */
export function groupByDay(items, timeOf, now = Date.now()) {
  const today = midnight(now);
  const yesterday = midnight(today - 1);
  const groups = [];
  for (const item of items ?? []) {
    const day = midnight(timeOf(item));
    const last = groups.at(-1);
    if (last && last.day === day) last.items.push(item);
    else {
      const label = day === today ? 'Today' : day === yesterday ? 'Yesterday' : new Date(day).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
      groups.push({ day, label, items: [item] });
    }
  }
  return groups;
}

export const FILE_KINDS = [
  { id: 'all', label: 'All' },
  { id: 'document', label: 'Documents', ext: 'pdf doc docx odt rtf txt md xls xlsx ods csv ppt pptx odp epub' },
  { id: 'picture', label: 'Pictures', ext: 'jpg jpeg png gif webp avif svg bmp tif tiff heic ico' },
  { id: 'video', label: 'Video', ext: 'mp4 mkv webm mov avi m4v wmv flv' },
  { id: 'audio', label: 'Audio', ext: 'mp3 flac wav ogg opus m4a aac wma' },
  { id: 'archive', label: 'Archives', ext: 'zip 7z rar tar gz bz2 xz zst iso' },
  { id: 'program', label: 'Programs', ext: 'exe msi msix apk dmg deb rpm appimage bat ps1 sh' },
  { id: 'other', label: 'Other' },
];

/** Which of FILE_KINDS a file name belongs to. */
export function fileKind(name) {
  const ext = /\.([a-z0-9]{1,8})$/i.exec(String(name ?? ''))?.[1]?.toLowerCase();
  return FILE_KINDS.find((k) => k.ext && ext && k.ext.split(' ').includes(ext))?.id ?? 'other';
}

/** Downloads narrowed by kind, time and typed text. `list` as downloads-list gives it. */
export function filterDownloads(list, { kind = 'all', when = 'all', query = '' } = {}, now = Date.now()) {
  const [from, to] = whenRange(when, now);
  const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  return (list ?? []).filter((d) => {
    const name = baseName(d.filename) || d.url || '';
    if (kind !== 'all' && fileKind(name) !== kind) return false;
    const t = Date.parse(d.startTime);
    if (when !== 'all' && !(t >= from && t <= to)) return false;
    const hay = `${name} ${d.url ?? ''}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

// ---- Settings: colour sets and the find box

/** Named colour sets: an accent and a ground for dark, and their pair for light. */
export const COLOUR_SETS = [
  { id: 'ember', name: 'Ember', dark: { accent: '#E8A04C', bg: '#120C06' }, light: { accent: '#9A5A0E', bg: '#FBF3E6' } },
  { id: 'lagoon', name: 'Lagoon', dark: { accent: '#4CC9D6', bg: '#051214' }, light: { accent: '#0E7480', bg: '#E8F7F8' } },
  { id: 'garnet', name: 'Garnet', dark: { accent: '#E06A6A', bg: '#140707' }, light: { accent: '#A32E2E', bg: '#FBECEC' } },
  { id: 'orchid', name: 'Orchid', dark: { accent: '#A78BFA', bg: '#0C0914' }, light: { accent: '#5B3FC4', bg: '#F1EDFC' } },
  { id: 'sage', name: 'Sage', dark: { accent: '#7FD1A1', bg: '#07110B' }, light: { accent: '#1F7A47', bg: '#EAF6EE' } },
  { id: 'fog', name: 'Fog', dark: { accent: '#B8C0CC', bg: '#0D0F12' }, light: { accent: '#4A5361', bg: '#EEF1F4' } },
  { id: 'blossom', name: 'Blossom', dark: { accent: '#F29BC1', bg: '#14090F' }, light: { accent: '#B03A72', bg: '#FCEDF4' } },
  { id: 'ink', name: 'Ink', dark: { accent: '#F2F2F2', bg: '#000000' }, light: { accent: '#111111', bg: '#FFFFFF' } },
];

/** A colour with its saturation scaled: 100 leaves it, 0 makes it grey. Lightness is kept. */
export function tune(hex, sat = 100) {
  const n = parseInt(String(hex).slice(1), 16);
  const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255].map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return String(hex).toLowerCase();
  const s0 = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  const s = s0 * Math.max(0, Math.min(100, sat)) / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h % 2) - 1));
  const m = l - c / 2;
  const rgb = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x];
  return '#' + rgb.map((v) => Math.round((v + m) * 255).toString(16).padStart(2, '0')).join('');
}

/** The {accent, bg} a colour set gives for a look ('dark' or 'light') at a strength. */
export function setColours(id, look, sat = 100) {
  const set = COLOUR_SETS.find((s) => s.id === id);
  if (!set) return null;
  const pair = set[look === 'light' ? 'light' : 'dark'];
  return { accent: tune(pair.accent, sat), bg: tune(pair.bg, sat) };
}

/** Does a setting's text hold every typed word? */
export function findMatches(text, query) {
  const hay = String(text ?? '').toLowerCase();
  return String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

/** "moon-dark" -> ['moon', 'dark']; anything else falls back to the default theme, dark. */
export function splitTheme(theme) {
  const m = /^([a-z]+)-(dark|light|auto)$/.exec(String(theme ?? ''));
  return m ? [m[1], m[2]] : ['moon', 'dark'];
}

// ---- Keyboard shortcuts

/** A chord as its keys in the Windows order (Ctrl, Alt, Shift, then the key), "+" and "−" as symbols. */
export function keyParts(chord) {
  const ORDER = ['Ctrl', 'Alt', 'Shift', 'Meta'];
  const parts = String(chord ?? '').split(/\+(?!$)/).filter(Boolean);
  const mods = parts.filter((k) => ORDER.includes(k)).sort((x, y) => ORDER.indexOf(x) - ORDER.indexOf(y));
  const rest = parts.filter((k) => !ORDER.includes(k)).map((k) => (k === 'Plus' ? '+' : k === '-' || k === 'Minus' ? '−' : k));
  return [...mods, ...rest];
}
const KEY_NAMES = { ' ': 'Space', ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down', Escape: 'Esc', Delete: 'Del', '+': 'Plus' };

/**
 * A key press as "Ctrl+Shift+K", or null while only modifiers are down.
 * A bare letter or digit is refused: it would fire while typing.
 */
export function chordOf(e) {
  if (['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'Dead', 'Unidentified'].includes(e.key)) return null;
  const code = String(e.code ?? '');
  const key = /^Key[A-Z]$/.test(code) ? code.slice(3) : /^Digit\d$/.test(code) ? code.slice(5) : KEY_NAMES[e.key] ?? (e.key.length === 1 ? e.key.toUpperCase() : e.key);
  const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Win'].filter(Boolean);
  const plain = key.length === 1 || key === 'Space';
  if (plain && !mods.some((m) => m !== 'Shift')) return null;
  return [...mods, key].join('+');
}

/** The other command that already holds these keys, if any. */
export function findClash(commands, keys, exceptId) {
  const want = String(keys).toLowerCase();
  return (commands ?? []).find((c) => c.id !== exceptId && (c.keys ?? []).some((k) => k.toLowerCase() === want)) ?? null;
}

export const sameKeys = (a, b) => JSON.stringify([...(a ?? [])].map((k) => k.toLowerCase()).sort()) === JSON.stringify([...(b ?? [])].map((k) => k.toLowerCase()).sort());

/** Commands whose name, group or keys hold every typed word. */
export function filterCommands(commands, query) {
  const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  return (commands ?? []).filter((c) => {
    const hay = `${c.name} ${c.group ?? ''} ${(c.keys ?? []).join(' ')}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** Commands under their group names, groups in the order they first appear. */
export function groupCommands(commands) {
  const groups = [];
  for (const c of commands ?? []) {
    const name = c.group || 'Other';
    let g = groups.find((x) => x.name === name);
    if (!g) groups.push((g = { name, commands: [] }));
    g.commands.push(c);
  }
  return groups;
}

/** The browser's usual keys, shown when the helper cannot list the real ones. */
export const USUAL_KEYS = [
  ['Tabs', 'New tab', 'Ctrl+T'], ['Tabs', 'Close tab', 'Ctrl+W'], ['Tabs', 'Reopen closed tab', 'Ctrl+Shift+T'], ['Tabs', 'Next tab', 'Ctrl+Tab'],
  ['Tabs', 'Previous tab', 'Ctrl+Shift+Tab'], ['Tabs', 'Search tabs', 'Ctrl+Shift+A'],
  ['Windows', 'New window', 'Ctrl+N'], ['Windows', 'New private window', 'Ctrl+Shift+N'], ['Windows', 'Full screen', 'F11'],
  ['Page', 'Reload', 'Ctrl+R'], ['Page', 'Find in page', 'Ctrl+F'], ['Page', 'Zoom in', 'Ctrl+Plus'], ['Page', 'Zoom out', 'Ctrl+-'], ['Page', 'Print', 'Ctrl+P'],
  ['Go to', 'Address bar', 'Ctrl+L'], ['Go to', 'History', 'Ctrl+H'], ['Go to', 'Downloads', 'Ctrl+J'], ['Go to', 'Bookmarks', 'Ctrl+Shift+O'],
  ['Go to', 'Bookmark this page', 'Ctrl+D'], ['Go to', 'Developer tools', 'F12'],
].map(([group, name, key]) => ({ id: `usual:${name.toLowerCase().replace(/\s+/g, '-')}`, group, name, defaults: [key] }));

// ---- Gamblium's own downloader (gamblium-dl): one job, folded from its events

/** "9.4 MB/s" from bytes a second. */
export function fmtSpeed(bps) {
  if (!(bps > 0)) return '0 kB/s';
  if (bps < 1e6) return `${Math.max(1, Math.round(bps / 1e3))} kB/s`;
  return `${(bps / 1e6).toFixed(1)} MB/s`;
}

/** "51 s", "3 min", "1 h 12 min". */
export function fmtSpan(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return m ? `${h} h ${m} min` : `${h} h`;
}

/**
 * A download job after one more line of `gamblium-dl --json`:
 * start {path,size,split,sources}, source-failed {error}, resume {have},
 * progress {done,total,speed,connections}, done {path,bytes,seconds,speed,connections},
 * error {error}. For torrents, progress may also carry {peers,seeds,up,uploaded}
 * and "seeding" {uploaded,ratio,peers,up} follows "done".
 */
export function dlFold(job, ev) {
  const j = { kind: 'http', state: 'starting', done: 0, size: null, speed: 0, connections: 0, sources: 1, failed: 0, ...job };
  const pick = (...keys) => Object.fromEntries(keys.filter((k) => ev[k] !== undefined && ev[k] !== null).map((k) => [k, ev[k]]));
  switch (ev?.event) {
    case 'start':
      return { ...j, ...pick('path', 'size', 'split', 'sources'), name: baseName(ev.path) || j.name, state: 'downloading' };
    case 'source-failed':
      return { ...j, failed: j.failed + 1 };
    case 'resume':
      return { ...j, resumed: ev.have, done: Math.max(j.done, ev.have ?? 0) };
    case 'progress':
      return { ...j, ...pick('done', 'speed', 'connections', 'peers', 'seeds', 'up', 'uploaded'), size: ev.total ?? j.size, state: j.state === 'paused' ? 'paused' : 'downloading' };
    case 'done':
      return { ...j, ...pick('path', 'seconds', 'speed', 'connections'), name: baseName(ev.path) || j.name, done: ev.bytes, size: ev.bytes, state: 'done' };
    case 'seeding':
      return { ...j, ...pick('uploaded', 'ratio', 'peers', 'up'), state: 'seeding' };
    case 'error':
      return { ...j, error: String(ev.error ?? 'It stopped.'), speed: 0, state: 'error' };
    default:
      return j;
  }
}

const many = (n, one, more = one + 's') => `${n} ${n === 1 ? one : more}`;
export const DL_ACTION_NAMES = { pause: 'Pause', resume: 'Resume', cancel: 'Cancel', retry: 'Try again', remove: 'Remove', open: 'Open', show: 'Show in folder', stop: 'Stop seeding' };
export const dlActive = (jobs) => (jobs ?? []).some((j) => ['starting', 'downloading', 'seeding'].includes(j.state));

/** What one job's row shows: a word for its state, the bar, one line of figures, small facts, buttons. */
export function dlView(j) {
  const torrent = j.kind === 'torrent';
  const known = j.size > 0;
  const percent = known ? Math.min(100, Math.floor((j.done / j.size) * 100)) : null;
  const amount = known ? `${fmtSize(j.done)} of ${fmtSize(j.size)}` : fmtSize(j.done);
  const facts = [];
  if (torrent) facts.push('Torrent');
  let line = [];
  let word = 'Starting';
  let cls = '';
  let actions = ['cancel'];
  if (j.state === 'downloading' || j.state === 'paused') {
    const paused = j.state === 'paused';
    word = paused ? 'Paused' : 'Downloading';
    line = [amount];
    if (percent !== null) line.push(`${percent}%`);
    if (!paused) {
      line.push(fmtSpeed(j.speed));
      if (known && j.speed > 0) line.push(`${fmtSpan((j.size - j.done) / j.speed)} left`);
      if (torrent) {
        if (j.peers !== undefined) facts.push(many(j.peers, 'peer'));
        if (j.seeds !== undefined) facts.push(many(j.seeds, 'seed'));
        if (j.up > 0) facts.push(`up ${fmtSpeed(j.up)}`);
      } else {
        if (j.connections > 0) facts.push(many(j.connections, 'connection'));
        if (j.sources > 1) facts.push(j.failed ? `${j.sources - j.failed} of ${j.sources} sources` : many(j.sources, 'source'));
        if (j.split === false) facts.push('this server allows one connection');
      }
    }
    if (j.resumed > 0) facts.push(`picked up at ${fmtSize(j.resumed)}`);
    actions = [paused ? 'resume' : 'pause', 'cancel'];
  } else if (j.state === 'done') {
    word = 'Done';
    cls = 'ok';
    line = [fmtSize(j.size)];
    if (j.seconds > 0) line.push(`in ${fmtSpan(j.seconds)}`);
    if (j.speed > 0) line.push(`${fmtSpeed(j.speed)} on average`);
    if (!torrent && j.connections > 1) facts.push(many(j.connections, 'connection'));
    actions = ['open', 'show', 'remove'];
  } else if (j.state === 'seeding') {
    word = 'Seeding';
    line = [`${fmtSize(j.uploaded ?? 0)} given back`];
    if (j.ratio !== undefined) line.push(`ratio ${Number(j.ratio).toFixed(2)}`);
    if (j.up > 0) line.push(`up ${fmtSpeed(j.up)}`);
    if (j.peers !== undefined) facts.push(many(j.peers, 'peer'));
    actions = ['stop', 'open', 'show'];
  } else if (j.state === 'error') {
    word = 'Stopped';
    cls = 'bad';
    line = [j.error, ...(j.done > 0 ? [`${amount} kept`] : [])];
    actions = ['retry', 'remove'];
  }
  return { name: j.name || baseName(j.path) || j.url || 'Download', word, cls, percent: j.state === 'done' || j.state === 'seeding' ? 100 : percent, line, facts, actions, torrent };
}

// ---- One download opened: who is giving, what is in it ----------------------------

/** A peer's address with its last part hidden: "203.0.113.···", "2001:db8:···". The port goes too. */
export function maskAddr(addr) {
  const s = String(addr ?? '');
  const v6 = /^\[([0-9a-f:.]+)\](?::\d+)?$/i.exec(s);
  if (v6) return `${v6[1].split(':').filter(Boolean).slice(0, 2).join(':')}:···`;
  const v4 = /^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}(?::\d+)?$/.exec(s);
  if (v4) return `${v4[1]}.···`;
  return s ? '···' : '';
}

const PEER_WORDS = { live: 'Connected', connecting: 'Connecting', queued: 'Waiting', dead: 'Gone', not_needed: 'Not needed' };

/**
 * The peers of a torrent, busiest first, ready to draw: what each has given us and taken from us,
 * and how big its dot is (its share of the most any one peer gave, 0 to 1).
 * kind: "gives" (we got bytes from it), "takes" (it only got bytes from us), "quiet".
 */
export function peerRows(peerList) {
  const rows = (Array.isArray(peerList) ? peerList : []).map((p) => {
    const down = Number(p?.down) || 0;
    const up = Number(p?.up) || 0;
    return { addr: String(p?.addr ?? ''), masked: maskAddr(p?.addr), client: String(p?.client || '').trim() || 'Unknown program', word: PEER_WORDS[p?.state] ?? 'Connected', down, up, kind: down > 0 ? 'gives' : up > 0 ? 'takes' : 'quiet' };
  });
  rows.sort((a, b) => b.down + b.up - (a.down + a.up));
  const most = Math.max(1, ...rows.map((r) => r.down));
  return rows.map((r) => ({ ...r, share: r.down / most }));
}

/** The files of a torrent with how far each one is. */
export function fileRows(files) {
  return (Array.isArray(files) ? files : []).map((f) => {
    const size = Number(f?.size) || 0;
    const done = Math.min(size, Number(f?.done) || 0);
    return { name: String(f?.name ?? 'File'), size, done, percent: size > 0 ? Math.floor((done / size) * 100) : 0 };
  });
}

/**
 * What an opened job shows under its row: a few figures with their names, and for a torrent
 * its peers and files. A normal download shows where it comes from and how.
 */
export function dlDetail(j) {
  const figures = [];
  const add = (name, value) => { if (value !== undefined && value !== null && value !== '') figures.push([name, String(value)]); };
  if (j.kind === 'torrent') {
    const peers = peerRows(j.peerList);
    const files = fileRows(j.files);
    const giving = peers.filter((p) => p.kind === 'gives').length;
    add('Peers', j.peers ?? peers.length);
    if (peers.length) add('Giving to us', giving);
    if (['starting', 'downloading'].includes(j.state)) add('Coming in', fmtSpeed(j.speed));
    add('Going out', fmtSpeed(j.up));
    add('Given back', fmtSize(j.uploaded ?? peers.reduce((n, p) => n + p.up, 0)));
    if (j.ratio !== undefined && j.ratio !== null) add('Ratio', Number(j.ratio).toFixed(2));
    return { torrent: true, figures, peers, files, saved: j.path || '' };
  }
  add('From', hostOf(j.url) || j.url);
  if (j.connections > 0) add('Connections', j.connections);
  add('Sources', j.failed ? `${j.sources - j.failed} of ${j.sources} answering` : j.sources);
  if (j.split === false) add('Server', 'allows one connection');
  if (j.resumed > 0) add('Picked up at', fmtSize(j.resumed));
  if (j.seconds > 0) add('Took', fmtSpan(j.seconds));
  return { torrent: false, figures, peers: [], files: [], saved: j.path || '', url: j.url || '' };
}

// ---- Sessions: a session drawn as its windows ---------------------------------------

/** The browser's tab-group colours as ours. */
export const GROUP_COLOURS = { grey: '#9aa0a6', blue: '#8ab4f8', red: '#f28b82', yellow: '#fdd663', green: '#81c995', pink: '#ff8bcb', purple: '#c58af9', cyan: '#78d9ec', orange: '#fcad70' };

/**
 * The open tabs as the same shape a saved session has (see shapeOf in ../sessions.js): one entry per
 * window, the window in front first, tabs in their order. Pages that cannot be saved are left out
 * and counted.
 */
export function nowShape(tabs, groups = [], currentWindowId = null) {
  const colour = new Map((groups ?? []).map((g) => [g.id, g.color || 'grey']));
  const wins = new Map();
  let skipped = 0;
  for (const t of [...(tabs ?? [])].sort((a, b) => a.windowId - b.windowId || a.index - b.index)) {
    const url = /^https?:/i.test(t.url ?? '') ? t.url : /^https?:/i.test(t.pendingUrl ?? '') ? t.pendingUrl : null;
    if (!url) {
      skipped++;
      continue;
    }
    if (!wins.has(t.windowId)) wins.set(t.windowId, { id: t.windowId, tabs: 0, icons: [] });
    const w = wins.get(t.windowId);
    w.tabs++;
    w.icons.push({ url, pinned: !!t.pinned, color: t.groupId !== undefined && t.groupId !== -1 ? colour.get(t.groupId) ?? 'grey' : null, asleep: !!t.discarded });
  }
  const shape = [...wins.values()].sort((a, b) => (b.id === currentWindowId) - (a.id === currentWindowId));
  return { shape, windows: shape.length, tabs: shape.reduce((n, w) => n + w.tabs, 0), skipped };
}

/** One window of a shape cut to what fits a row: the icons to draw and how many more there are. */
export function stripOf(win, limit = 18) {
  const icons = (win?.icons ?? []).slice(0, limit);
  return { icons, more: Math.max(0, (win?.tabs ?? icons.length) - icons.length) };
}

/** "Today 14:05", "Yesterday 18:40", "Mon 09:12" (this week), "3 Nov", "3 Nov 2025". */
export function sessionWhen(savedAt, now = Date.now()) {
  const d = new Date(savedAt);
  const n = new Date(now);
  const p = (x) => String(x).padStart(2, '0');
  const time = `${p(d.getHours())}:${p(d.getMinutes())}`;
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(n) - day(d)) / 86400000);
  if (days <= 0) return `Today ${time}`;
  if (days === 1) return `Yesterday ${time}`;
  if (days < 7) return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]} ${time}`;
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
  return d.getFullYear() === n.getFullYear() ? `${d.getDate()} ${month}` : `${d.getDate()} ${month} ${d.getFullYear()}`;
}

/** Sessions whose name, sites or tab addresses contain every word typed. */
export function filterSessions(list, query = '') {
  const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return list ?? [];
  return (list ?? []).filter((s) => {
    const hay = [s.name, ...(s.hosts ?? []), s.profile ?? '', ...(s.shape ?? []).flatMap((w) => w.icons.map((t) => t.url))].join(' ').toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** The small facts under a session's name: what was kept with it. */
export function sessionFacts(s) {
  const facts = [];
  const from = sessionFrom(s);
  if (from) facts.push(from);
  if (s.pagesCaptured) facts.push(`scroll and form text for ${plural(s.pagesCaptured, 'page')}`);
  if (s.hasSettings) facts.push('settings');
  return facts;
}

/** A saved session's tabs for its opened view: per window, each tab with a title to show and its site. */
export function sessionTabs(session) {
  return (session?.windows ?? []).map((w, i) => ({
    title: `Window ${i + 1}`,
    count: w.tabs.length,
    tabs: w.tabs.map((t) => ({
      url: t.url,
      title: String(t.title || '').trim() || hostOf(t.url) || t.url,
      host: hostOf(t.url),
      pinned: !!t.pinned,
      color: Number.isInteger(t.group) && w.groups?.[t.group] ? w.groups[t.group].color || 'grey' : null,
      group: Number.isInteger(t.group) && w.groups?.[t.group] ? w.groups[t.group].title || '' : '',
      kept: !!t.page,
    })),
  }));
}

// ---- Named sessions: a profile of its own each (logins, extensions, proxy) ------------
// The helper's row: { name, state: "stopped" | "hidden" | "window", by: "cli" | "page",
// applies: { proxy, always, extensions: [names] } }. "cli" is the command line: an agent or a person.

const NAMED_WORDS = ['create', 'list', 'open', 'hide', 'close', 'delete', 'set', 'help'];

/** Why a name cannot be used for a named session, or '' when it can. */
export function namedNameError(raw, taken = []) {
  const name = String(raw ?? '').trim();
  if (!name) return 'Give the session a name.';
  if (name.length > 40) return 'A session name can be at most 40 characters.';
  if (!/^[A-Za-z0-9_-]+$/.test(name)) return 'Use letters, digits, - and _ only (no spaces).';
  if (NAMED_WORDS.includes(name.toLowerCase())) return `"${name}" is a command word; pick another name.`;
  if (taken.some((t) => String(t).toLowerCase() === name.toLowerCase())) return `There is already a session called "${name}".`;
  return '';
}

/** A proxy address as the helper takes it. -> { ok, value: 'socks5://host:port' | 'none' } or { ok: false, error }. */
export function proxyAddress(raw) {
  const text = String(raw ?? '').trim();
  if (!text || /^(none|off|direct)$/i.test(text)) return { ok: true, value: 'none' };
  let u;
  try {
    u = new URL(text);
  } catch {
    return { ok: false, error: 'Write it as kind://host:port, for example socks5://127.0.0.1:9050.' };
  }
  const kind = u.protocol.replace(/:$/, '').toLowerCase();
  if (!['http', 'https', 'socks4', 'socks5'].includes(kind)) return { ok: false, error: 'The kind must be http, https, socks4 or socks5.' };
  if (u.username || u.password) return { ok: false, error: 'A proxy address here cannot carry a name or password.' };
  if (!u.hostname) return { ok: false, error: 'The address needs a host.' };
  if (!u.port) return { ok: false, error: 'The address needs a port, for example :8080.' };
  if ((u.pathname && u.pathname !== '/') || u.search || u.hash) return { ok: false, error: 'Only kind://host:port, nothing after the port.' };
  return { ok: true, value: `${kind}://${u.hostname}:${u.port}` };
}

/** What a named session's card shows: a word for its state, the facts under its name, its buttons. */
export function namedView(s) {
  const state = ['stopped', 'hidden', 'window'].includes(s?.state) ? s.state : 'stopped';
  const word = { stopped: 'Stopped', hidden: 'Working unseen', window: 'Open in a window' }[state];
  const cls = { stopped: '', hidden: 'warn', window: 'ok' }[state];
  const actions = { stopped: ['open', 'hide', 'delete'], hidden: ['open', 'close'], window: ['hide', 'close'] }[state];
  const proxy = s?.applies?.proxy || null;
  const facts = [proxy ? `Proxy ${proxy}` : 'No proxy'];
  const extensions = s?.applies?.extensions;
  if (Array.isArray(extensions)) facts.push(extensions.length ? plural(extensions.length, 'extension') : 'No extensions of its own');
  if (s?.by === 'cli') facts.push('made from the command line');
  return { name: String(s?.name ?? ''), state, word, cls, actions, proxy, facts, extensions: Array.isArray(extensions) ? extensions : [] };
}
export const NAMED_ACTION_NAMES = { open: 'Open in a window', hide: 'Run unseen', close: 'Stop', delete: 'Delete' };
/** Sessions whose name holds every word typed (any order, any case). */
export function filterNamed(list, query) {
  const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return list;
  return list.filter((s) => { const n = String(s?.name ?? '').toLowerCase(); return words.every((w) => n.includes(w)); });
}
/** Deleting a session deletes its logins on disk, so the question says so, in words. */
export function namedDeleteQuestion(names) {
  return names.length === 1 ? `Delete ${names[0]} and its logins?` : `Delete ${names.length} sessions and their logins?`;
}
/** What a stopped session's "hide" really does is start it with no window. */
export const namedActionLabel = (action, state) => (action === 'hide' && state === 'window' ? 'Hide the window' : action === 'open' && state === 'stopped' ? 'Start in a window' : action === 'hide' && state === 'stopped' ? 'Start unseen' : NAMED_ACTION_NAMES[action]);

// ---- the permission prompt (ui/permit.html): agents changing settings
/** The button for a choice in minutes: 0 not now, -1 never ask. */
export function permitLabel(minutes) {
  if (minutes === 0) return 'Not now';
  if (minutes === -1) return 'Always allow, never ask';
  if (minutes < 60) return `Allow for ${minutes} minutes`;
  const hours = minutes / 60;
  return `Allow for ${hours} ${hours === 1 ? 'hour' : 'hours'}`;
}
/** One line saying what is in force. `view` is the helper's permit-get answer; `nowMs` the clock. */
export function permitStatus(view, nowMs) {
  if (view?.neverAsk) return 'Agents may change settings; you are not asked.';
  if (view?.allowed && view.until) {
    const left = Math.max(1, Math.round((view.until * 1000 - nowMs) / 60000));
    return left >= 60 ? `Agents may change settings for another ${Math.floor(left / 60)} h ${left % 60} min.` : `Agents may change settings for another ${left} min.`;
  }
  return 'Agents may not change settings. They ask each time.';
}

/** A choice of the permission prompt in a word or two: "30 min", "1 hour", "Not now", "Always". */
export function permitShort(minutes) {
  if (minutes === 0) return 'Not now';
  if (minutes === -1) return 'Always';
  if (minutes < 60) return `${minutes} min`;
  const hours = minutes / 60;
  return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
}

/**
 * The permission prompt's parts. `view` is the helper's permit-get answer.
 * -> { state: "asking" | "allowed" | "always" | "closed", choice (the minutes in force: 0, -1 or null while a
 *      timed permission runs), until ("18:40" when timed), times (the timed choices), asks: [{ command, who, when }] }.
 */
export function permitParts(view, nowMs) {
  const asks = (view?.asks ?? []).map((a) => ({ command: String(a.command ?? ''), who: String(a.profile || 'an agent'), when: fmtAgo((a.at ?? 0) * 1000, nowMs) }));
  const times = (view?.choices ?? [0, 30, 60, 120, 360, -1]).filter((m) => m > 0);
  const timed = !!view?.allowed && !view?.neverAsk && view?.until;
  const d = timed ? new Date(view.until * 1000) : null;
  const until = d ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : '';
  const state = view?.neverAsk ? 'always' : timed ? 'allowed' : asks.length ? 'asking' : 'closed';
  return { state, choice: view?.neverAsk ? -1 : timed ? null : 0, until, times, asks };
}

/** The browser's own zoom steps, as factors. */
export const ZOOMS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];

/** The next zoom factor below (dir < 0) or above (dir > 0) `now`; it stays at either end. */
export function zoomStep(now, dir) {
  const z = Number(now) || 1;
  if (dir < 0) return [...ZOOMS].reverse().find((s) => s < z - 0.005) ?? ZOOMS[0];
  return ZOOMS.find((s) => s > z + 0.005) ?? ZOOMS.at(-1);
}

/** A zoom factor as the browser writes it: 1 -> "100%", 0.67 -> "67%". */
export const zoomLabel = (z) => `${Math.round((Number(z) || 1) * 100)}%`;

// Pure helpers for the new tab page. No browser APIs here, so node --test can run them.

// Endings that people type as addresses. Anything else with a dot is searched;
// a search for "example.fr" still puts the site first.
const TLDS = new Set(
  ('com org net io dev app co in uk de fr es it nl ru jp cn br au ca us eu ch se no fi pl ' +
    'edu gov mil int info biz me tv ai sh xyz tech site online store blog page wiki onion').split(' '),
);
const INTERNAL = /^(brave|chrome|about|edge):/i;

/** Decides whether typed text is an address or a search. */
export function classify(input) {
  const text = String(input ?? '').trim();
  if (!text) return { kind: 'empty' };
  if (/\s/.test(text)) return { kind: 'search', text };
  if (INTERNAL.test(text)) return { kind: 'url', url: text.replace(/^brave:/i, 'chrome:') };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return { kind: 'url', url: text };

  const host = text.split(/[/?#]/)[0];
  const [name, port] = host.split(':');
  if (port !== undefined && !/^\d{1,5}$/.test(port)) return { kind: 'search', text };
  const isLocal = /^localhost$/i.test(name);
  const isIp = /^(\d{1,3}\.){3}\d{1,3}$/.test(name);
  if (isLocal || isIp) return { kind: 'url', url: 'http://' + text };
  const labels = name.split('.');
  const wellFormed = labels.length >= 2 && labels.every((l) => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i.test(l));
  if (wellFormed && (TLDS.has(labels.at(-1).toLowerCase()) || /^www$/i.test(labels[0]) || port !== undefined)) {
    return { kind: 'url', url: 'https://' + text };
  }
  return { kind: 'search', text };
}

/** Short name under a site chip: its title, or its host without "www." */
export function siteLabel(site) {
  const title = String(site?.title ?? '').trim();
  if (title) return title;
  try {
    return new URL(site.url).hostname.replace(/^www\./, '');
  } catch {
    return String(site?.url ?? '');
  }
}

/** The first `max` usable sites, as plain {url, title}. */
export function pickSites(list, max = 8) {
  const out = [];
  for (const s of list ?? []) {
    if (!/^https?:\/\//i.test(s?.url ?? '')) continue;
    out.push({ url: s.url, title: String(s.title ?? '') });
    if (out.length === max) break;
  }
  return out;
}

/** `sites` filled up to `max` from history entries, most visited first, one per site. */
export function fillSites(sites, history, max = 8) {
  const out = [...sites];
  const hosts = new Set(out.map((s) => hostOf(s.url)));
  const ranked = [...(history ?? [])].sort((a, b) => (b.visitCount ?? 0) - (a.visitCount ?? 0));
  for (const h of ranked) {
    if (out.length >= max) break;
    const host = hostOf(h?.url);
    if (!/^https?:\/\//i.test(h?.url ?? '') || !host || hosts.has(host)) continue;
    hosts.add(host);
    out.push({ url: h.url, title: String(h.title ?? '') });
  }
  return out;
}

export const sameSites = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "23 tabs · 14 asleep · 5.1 GB memory free" from the background status answer. */
export function statusLine(status) {
  if (!status || typeof status.total !== 'number') return '';
  const asleep = status.reasons?.['already asleep'] ?? 0;
  const parts = [plural(status.total, 'tab'), `${asleep} asleep`];
  if (typeof status.availableMb === 'number') parts.push(`${(status.availableMb / 1024).toFixed(1)} GB memory free`);
  return parts.join(' · ');
}

// ---- Quick access, widgets and the search list (the page keeps these in
// extension storage under "newtab", with a copy in localStorage for first paint).

/** The parts of the page that can be switched on and off, in the order they are listed. */
export const WIDGETS = [
  { id: 'clock', label: 'Greeting and clock', hint: 'The time, the date and a hello.', on: true },
  { id: 'pins', label: 'Quick access', hint: 'Sites you pinned, in your order.', on: true },
  // The default cards, first to third (owner, Nov 16 2026): Recently closed, Right now, Recent sessions.
  { id: 'closed', label: 'Recently closed', hint: 'Tabs and windows you can bring back.', on: true },
  { id: 'status', label: 'Right now', hint: 'Tabs open, tabs asleep, memory in use.', on: true },
  { id: 'browsers', label: 'Recent sessions', hint: 'Personal, Work and your other sessions: go to one, or start it.', on: true },
  { id: 'top', label: 'Most visited', hint: 'What you open most, from this browser.', on: false },
  { id: 'sessions', label: 'Saved tab sets', hint: 'Sets of tabs you saved.', on: false },
  { id: 'downloads', label: 'Downloads', hint: 'The last few files.', on: false },
  { id: 'notes', label: 'Notes', hint: 'A few lines kept on this computer.', on: true },
  { id: 'todo', label: 'To do', hint: 'A short list you can tick off.', on: true },
  { id: 'playing', label: 'Playing now', hint: 'Tabs making sound: go to them, or mute them.', on: false },
  { id: 'heavy', label: 'Heaviest tabs', hint: 'The tabs using the most memory, with a sleep button.', on: false },
  { id: 'recent', label: 'Recently visited', hint: 'The last pages you opened.', on: false },
  { id: 'marks', label: 'Bookmarks', hint: 'The bookmarks you added last.', on: false },
  { id: 'calendar', label: 'Calendar', hint: 'This month, with today marked.', on: false },
  { id: 'zones', label: 'World clocks', hint: 'The time in places you choose.', on: false },
];
/** The cards of the deck: every part except the greeting and quick access, which have their own place. */
export const CARDS = WIDGETS.map((w) => w.id).filter((id) => id !== 'clock' && id !== 'pins');
export const MAX_W = 3; // a card is 1, 2 or 3 columns wide (3 = the whole row)
export const MAX_H = 2; // and 1 or 2 rows tall

/**
 * Where the cards are and how big: { order: [every card id once], size: { id: { w, h } }, pack }.
 * `pack` (on unless switched off): a card slides up into a gap left beside a bigger one.
 * Unknown cards are dropped, missing ones go to the end in their usual order, sizes are kept in range.
 */
/** The layout a new page starts with (owner, Nov 16 2026): Recently closed, Right now, Recent
 *  sessions; then Notes, two columns wide, and To do. */
export const DEFAULT_LAYOUT = { order: ['closed', 'status', 'browsers', 'notes', 'todo'], size: { notes: { w: 2, h: 1 } }, pack: true };

export function readLayout(raw) {
  const r = raw && typeof raw === 'object' ? raw : DEFAULT_LAYOUT;
  const order = [];
  for (const id of Array.isArray(r.order) ? r.order : []) if (CARDS.includes(id) && !order.includes(id)) order.push(id);
  for (const id of CARDS) if (!order.includes(id)) order.push(id);
  const size = {};
  const whole = (n, max) => (Number.isInteger(n) ? Math.min(max, Math.max(1, n)) : 1);
  for (const id of CARDS) {
    const s = r.size?.[id];
    const w = whole(s?.w, MAX_W);
    const h = whole(s?.h, MAX_H);
    if (w > 1 || h > 1) size[id] = { w, h };
  }
  return { order, size, pack: r.pack !== false };
}

/** The size of one card: { w, h }, 1 x 1 unless it was changed. */
export const cardSize = (layout, id) => layout?.size?.[id] ?? { w: 1, h: 1 };

/** The layout with card `id` put just before card `before` (null: at the end). */
export function moveCard(layout, id, before) {
  if (!CARDS.includes(id) || id === before) return layout;
  const order = layout.order.filter((x) => x !== id);
  const at = before === null || before === undefined ? order.length : order.indexOf(before);
  if (at < 0) return layout;
  order.splice(at, 0, id);
  return { ...layout, order };
}

/**
 * The layout with card `id` moved one place earlier (-1) or later (+1) among the cards that are shown;
 * `shown` is the list of card ids on the page. At either end nothing changes.
 */
export function nudgeCard(layout, id, step, shown = CARDS) {
  const seen = layout.order.filter((x) => shown.includes(x));
  const i = seen.indexOf(id);
  const j = i + step;
  if (i < 0 || j < 0 || j >= seen.length) return layout;
  // Going later means landing after the neighbour: before the one that follows it.
  return moveCard(layout, id, step < 0 ? seen[j] : seen[j + 1] ?? null);
}

/** The layout with card `id` given a size; out-of-range sizes are pulled in. */
export function sizeCard(layout, id, w, h) {
  if (!CARDS.includes(id)) return layout;
  const size = { ...layout.size };
  const fit = { w: Math.min(MAX_W, Math.max(1, Math.round(w) || 1)), h: Math.min(MAX_H, Math.max(1, Math.round(h) || 1)) };
  if (fit.w === 1 && fit.h === 1) delete size[id];
  else size[id] = fit;
  return { ...layout, size };
}

/**
 * The size a card snaps to while its corner is dragged to `px` wide and `py` tall.
 * `col` is one column's width, `row` one row's height, `gap` the space between cards, `cols` the columns on screen.
 */
export function snapSize(px, py, { col, row, gap, cols }) {
  const w = Math.round((px + gap) / (col + gap));
  const h = Math.round((py + gap) / (row + gap));
  return { w: Math.min(Math.min(MAX_W, Math.max(1, cols)), Math.max(1, w || 1)), h: Math.min(MAX_H, Math.max(1, h || 1)) };
}

/** How many rows a list card shows at a height: 5, or 11 when it is two rows tall. */
export const rowsFor = (h) => (h >= 2 ? 11 : 5);

export const CLOCKS = ['auto', '12', '24'];
/** Where the time sits: large beside the greeting (the default, owner Nov 13 2026) or in the date line. */
export const CLOCK_SIZES = ['large', 'line'];
export const MAX_TODOS = 40;
export const MAX_ZONES = 5;
export const BACKDROPS = ['moon', 'plain', 'picture'];
export const MAX_PINS = 16;

const key = (url) => String(url ?? '').replace(/#.*$/, '').replace(/\/$/, '').toLowerCase();

/** Host without "www.", or '' when the address cannot be read. */
export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** A pin from what was typed: {url, title}, or null when it is not a web address. */
export function cleanPin(input) {
  const typed = classify(input?.url);
  if (typed.kind !== 'url') return null;
  let url;
  try {
    url = new URL(typed.url);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const title = String(input?.title ?? '').trim().slice(0, 60);
  return { url: url.href, title: title || hostOf(url.href) };
}

/** Stored settings with everything missing or wrong replaced by the default. */
export function readPrefs(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const pins = [];
  for (const p of Array.isArray(r.pins) ? r.pins : []) {
    const pin = cleanPin(p);
    if (pin && !pins.some((q) => key(q.url) === key(pin.url))) pins.push(pin);
    if (pins.length === MAX_PINS) break;
  }
  const widgets = {};
  for (const w of WIDGETS) widgets[w.id] = typeof r.widgets?.[w.id] === 'boolean' ? r.widgets[w.id] : w.on;
  // Once, for pages set up before Recent sessions (owner, Nov 16 2026): sessions in, Most visited out.
  if (!r.sessionDeck) {
    widgets.browsers = true;
    widgets.top = false;
  }
  // Saved tab sets are off (owner, Nov 16 2026: a session keeps its tabs already).
  if (!r.noTabSets) widgets.sessions = false;
  return {
    pins,
    widgets,
    sessionDeck: true,
    noTabSets: true,
    layout: readLayout(r.layout),
    backdrop: BACKDROPS.includes(r.backdrop) ? r.backdrop : 'moon',
    name: String(r.name ?? '').trim().slice(0, 30),
    notes: String(r.notes ?? '').slice(0, 4000),
    clock: CLOCKS.includes(r.clock) ? r.clock : 'auto',
    clockSize: CLOCK_SIZES.includes(r.clockSize) ? r.clockSize : 'large',
    search: ENGINES.some((e) => e.id === r.search) ? r.search : '',
    todos: cleanTodos(r.todos),
    zones: [...new Set((Array.isArray(r.zones) ? r.zones : []).filter((z) => typeof z === 'string' && /^[\w+\-/]{2,40}$/.test(z)))].slice(0, MAX_ZONES),
  };
}

export const isPinned = (pins, url) => pins.some((p) => key(p.url) === key(url));

/** Pins with one more at the end. The same address twice, or one too many, changes nothing. */
export function addPin(pins, pin) {
  if (!pin || isPinned(pins, pin.url) || pins.length >= MAX_PINS) return pins;
  return [...pins, pin];
}

/** Pins with the one at `from` moved to `to`. */
export function movePin(pins, from, to) {
  if (from === to || from < 0 || to < 0 || from >= pins.length || to >= pins.length) return pins;
  const out = [...pins];
  out.splice(to, 0, ...out.splice(from, 1));
  return out;
}

/**
 * The open tab a pin stands for, if there is one. A pin of a site's front page
 * matches any tab on that site; a pin of a deeper page only that page.
 */
export function openTabFor(pin, tabs) {
  let p;
  try {
    p = new URL(pin.url);
  } catch {
    return null;
  }
  const whole = p.pathname === '/' && !p.search;
  return (tabs ?? []).find((t) => {
    try {
      const u = new URL(t.url);
      return whole ? u.host === p.host : key(t.url) === key(pin.url);
    } catch {
      return false;
    }
  }) ?? null;
}

/** "Good evening, Asha" for the hour of the day (0 to 23). */
export function greeting(hour, name = '') {
  const part = hour < 5 ? 'Still up' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  return name ? `${part}, ${name}` : part;
}

/** "just now", "12 min ago", "3 h ago", "2 days ago". */
export function ago(then, now) {
  const min = Math.max(0, Math.round((now - then) / 60000));
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

const BASE = { tab: 40, pin: 34, bookmark: 26, history: 20 };

/**
 * What to offer while someone types: open tabs, pins, bookmarks and history
 * whose title or address holds every typed word. Best first, each address once.
 * sources: { tabs, pins, bookmarks, history } as the browser returns them.
 */
export function suggest(text, sources, max = 6) {
  const words = String(text ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const first = words[0];
  const best = new Map();
  const offer = (kind, item, extra = {}) => {
    const url = String(item?.url ?? '');
    if (!/^https?:\/\//i.test(url)) return;
    const title = String(item.title ?? '').trim();
    const hay = `${title} ${url}`.toLowerCase();
    if (!words.every((w) => hay.includes(w))) return;
    const host = hostOf(url);
    let score = BASE[kind];
    if (host.startsWith(first)) score += 30;
    else if (host.includes(first)) score += 8;
    if (title.toLowerCase().startsWith(first)) score += 12;
    score += Math.min(20, (item.typedCount ?? 0) * 4 + (item.visitCount ?? 0));
    // A redirect leaves two addresses with one title on one site: offer it once.
    const k = kind === 'history' ? `${host} ${title.toLowerCase()}` : key(url);
    const had = best.get(k) ?? best.get(key(url));
    if (!had) best.set(k, { kind, url, title: title || host, score, ...extra });
    else {
      // The same address from two places: the better score, named after the nearer place.
      had.score = Math.max(had.score, score);
      if (BASE[kind] > BASE[had.kind]) Object.assign(had, { kind, title: title || had.title }, extra);
    }
  };
  for (const t of sources.tabs ?? []) offer('tab', t, { tabId: t.id, windowId: t.windowId });
  for (const p of sources.pins ?? []) offer('pin', p);
  for (const b of sources.bookmarks ?? []) offer('bookmark', b);
  for (const h of sources.history ?? []) offer('history', h);
  return [...best.values()]
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    .slice(0, max)
    .map(({ score, ...rest }) => rest);
}

/** A to-do list as stored: [{text, done}], empty lines dropped, at most MAX_TODOS. */
export function cleanTodos(list) {
  const out = [];
  for (const t of Array.isArray(list) ? list : []) {
    const text = String(t?.text ?? '').trim().slice(0, 120);
    if (text) out.push({ text, done: t.done === true });
    if (out.length === MAX_TODOS) break;
  }
  return out;
}

/**
 * The weeks of one month as rows of seven: day numbers, 0 where the row runs
 * outside the month. `month` is 0 to 11; `firstDay` is 0 for Sunday, 1 for Monday.
 */
export function monthGrid(year, month, firstDay = 1) {
  const days = new Date(year, month + 1, 0).getDate();
  const lead = (new Date(year, month, 1).getDay() - firstDay + 7) % 7;
  const cells = [...Array(lead).fill(0), ...Array.from({ length: days }, (_, i) => i + 1)];
  while (cells.length % 7) cells.push(0);
  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

/** "Asia/Kolkata" -> "Kolkata", "America/Argentina/Buenos_Aires" -> "Buenos Aires". */
export const zoneName = (zone) => String(zone ?? '').split('/').pop().replace(/_/g, ' ');

/** The options for showing a time: the system's habit, or 12 or 24 hours on request. */
export function timeOptions(clock, timeZone) {
  const o = { hour: 'numeric', minute: '2-digit' };
  if (clock === '12') o.hour12 = true;
  if (clock === '24') Object.assign(o, { hour: '2-digit', hourCycle: 'h23' });
  if (timeZone) o.timeZone = timeZone;
  return o;
}

/** The tabs holding the most memory, biggest first. `tabs` as tab-stats gives them. */
export function heaviest(tabs, max = 5) {
  return (tabs ?? [])
    .filter((t) => typeof t.memoryMb === 'number' && t.memoryMb > 0 && /^https?:/i.test(t.url ?? ''))
    .sort((a, b) => b.memoryMb - a.memoryMb)
    .slice(0, max);
}

/** History entries, newest first, one per title on one site, as rows need them. */
export function recentPages(history, max = 5) {
  const seen = new Set();
  const out = [];
  const sorted = [...(history ?? [])].sort((a, b) => (b.lastVisitTime ?? 0) - (a.lastVisitTime ?? 0));
  for (const h of sorted) {
    if (!/^https?:\/\//i.test(h?.url ?? '')) continue;
    const title = String(h.title ?? '').trim() || hostOf(h.url);
    const k = `${hostOf(h.url)} ${title.toLowerCase()}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ url: h.url, title, at: h.lastVisitTime ?? 0 });
    if (out.length === max) break;
  }
  return out;
}

/** Search engines the new tab page can send a search to. No choice ('') means the browser's own default. */
export const ENGINES = [
  { id: 'google', name: 'Google', url: 'https://www.google.com/search?q=' },
  { id: 'duckduckgo', name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=' },
  { id: 'brave', name: 'Brave Search', url: 'https://search.brave.com/search?q=' },
  { id: 'bing', name: 'Bing', url: 'https://www.bing.com/search?q=' },
];

/** The address that searches `text` with the chosen engine, or null to use the browser's default. */
export function searchUrl(engine, text) {
  const e = ENGINES.find((x) => x.id === engine);
  return e ? e.url + encodeURIComponent(String(text ?? '').trim()) : null;
}

/** Sites offered on first run as a 3 x 3 grid; the ones picked become pins. */
export const STARTERS = [
  { title: 'YouTube', url: 'https://www.youtube.com/' },
  { title: 'Gmail', url: 'https://mail.google.com/' },
  { title: 'GitHub', url: 'https://github.com/' },
  { title: 'WhatsApp', url: 'https://web.whatsapp.com/' },
  { title: 'Reddit', url: 'https://www.reddit.com/' },
  { title: 'Wikipedia', url: 'https://www.wikipedia.org/' },
  { title: 'LinkedIn', url: 'https://www.linkedin.com/' },
  { title: 'Amazon', url: 'https://www.amazon.com/' },
  { title: 'X', url: 'https://x.com/' },
];

/** Pins with one starter site switched on or off; the user's other pins are left as they are. */
export function togglePin(pins, site, on) {
  if (on) return addPin(pins, { url: site.url, title: site.title });
  return pins.filter((p) => !isPinned([site], p.url));
}

// Gamblium new tab. Everything is asked once when the page opens; after that
// the page only reacts to the person using it. The one timer is the clock:
// one tick a minute, and only while the page is showing.
import {
  classify, siteLabel, pickSites, sameSites, statusLine, readPrefs, cleanPin, addPin, movePin, isPinned,
  greeting, ago, suggest, hostOf, fillSites, openTabFor, WIDGETS, MAX_PINS,
  searchUrl, cleanTodos, monthGrid, zoneName, timeOptions, heaviest, recentPages, MAX_TODOS, MAX_ZONES,
  CARDS, cardSize, moveCard, nudgeCard, sizeCard, snapSize, rowsFor, readLayout,
} from './logic.js';
import { $, el, send, openPage } from '../ui/page.js';
import { showUpdateBanner } from '../ui/update-banner.js';
import { GROUP_COLOURS } from '../ui/pages-logic.js';
import { siteIcon, siteIconEl, monogram, guardIcon } from '../site-icons.js';
import { resolve, suggestRoutes } from '../routes.js'; // also brings the stored colour scheme up to date

const KEY = 'gamblium.newtab';
const PICTURE = 'gamblium.newtab.picture';
const TOP_CACHE = 'gamblium.topSites';
const root = document.documentElement;
const local = {
  get: (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k, v) => {
    try {
      if (v === null) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
      return true;
    } catch {
      return false;
    }
  },
};
const parse = (text) => {
  try {
    return JSON.parse(text ?? 'null');
  } catch {
    return null;
  }
};

let prefs = readPrefs(parse(local.get(KEY)));
let topSites = pickSites(parse(local.get(TOP_CACHE)) ?? [], 8);
let topKnown = false; // true once the browser has answered

const favicon = (url, size = 32) => guardIcon(el('img', { alt: '', src: `/_favicon/?pageUrl=${encodeURIComponent(url)}&size=${size}` }));
// A pin's picture: our own mark for a well-known site, else the browser's icon, and a letter when
// the browser has none (it only has one for a site that was opened before).
const iconBytes = (url) => fetch(`/_favicon/?pageUrl=${encodeURIComponent(url)}&size=32`).then((r) => r.arrayBuffer()).then((b) => new Uint8Array(b));
let blankIcon; // what the browser gives when it has no icon; asked once
function pinIcon(pin) {
  const known = siteIcon(pin.url);
  if (known) return siteIconEl(known, 24);
  const img = favicon(pin.url);
  blankIcon ??= iconBytes('https://no-such-site.invalid/');
  Promise.all([iconBytes(pin.url), blankIcon]).then(([mine, blank]) => {
    if (mine.length !== blank.length || !mine.every((v, i) => v === blank[i])) return;
    img.replaceWith(el('span', { className: 'letter', textContent: monogram(pin.title, pin.url), ariaHidden: 'true' }));
  }).catch(() => {}); // the browser's picture stays
  return img;
}
const NS = 'http://www.w3.org/2000/svg';
const glyph = (d, size = 16) => {
  const svg = document.createElementNS(NS, 'svg');
  for (const [k, v] of Object.entries({ width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.4, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(k, v);
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', d);
  svg.append(path);
  return svg;
};
const GLYPH = {
  search: 'M7 12A5 5 0 1 0 7 2a5 5 0 0 0 0 10zM10.600 10.600 14 14',
  go: 'M3 8h10M9 4l4 4-4 4',
  plus: 'M8 3v10M3 8h10',
  dots: 'M3.500 8h.01M8 8h.01M12.500 8h.01',
  window: 'M2.500 4.500a1.500 1.500 0 0 1 1.500-1.500h8a1.500 1.500 0 0 1 1.500 1.500v7a1.500 1.500 0 0 1-1.500 1.500H4a1.500 1.500 0 0 1-1.500-1.500zM2.500 6.500h11',
  stack: 'M3 5.500 8 3l5 2.500L8 8zM3 8.500 8 11l5-2.500M3 11l5 2.500 5-2.500',
  file: 'M4.500 2.500h4.500L12 5.500v8H4.500zM9 2.500v3h3',
};

// ---- settings: extension storage is the truth, localStorage is the copy for first paint

/** How many rows the list card `id` shows: more when it was made taller. */
const rowsOf = (id) => rowsFor(cardSize(prefs.layout, id).h);
const deck = document.querySelector('.deck');
const cardOf = (id) => deck.querySelector(`.card[data-widget="${id}"]`);
/** Puts the cards in the stored order and gives each its stored size. */
function applyLayout() {
  deck.dataset.pack = prefs.layout.pack ? 'on' : 'off';
  const cards = prefs.layout.order.map(cardOf).filter(Boolean);
  if (cards.some((c, i) => deck.children[i] !== c)) deck.append(...cards);
  for (const c of cards) {
    const { w, h } = cardSize(prefs.layout, c.dataset.widget);
    c.dataset.w = w;
    c.dataset.h = h;
  }
}

/** The time large beside the greeting, or small in the date line (Customise > Clock size). */
function placeClock() {
  const hero = document.querySelector('.hero');
  const t = $('time');
  hero.dataset.clock = prefs.clockSize;
  if (prefs.clockSize === 'large' && t.parentElement !== hero) hero.append(t);
  if (prefs.clockSize === 'line' && t.parentElement === hero) document.querySelector('.hero .date').append(t);
}
function applyPrefs() {
  applyLayout();
  placeClock();
  root.dataset.hide = WIDGETS.filter((w) => !prefs.widgets[w.id]).map((w) => w.id).join(' ');
  const picture = prefs.backdrop === 'picture' ? local.get(PICTURE) : null;
  root.dataset.backdrop = prefs.backdrop === 'picture' && !picture ? 'moon' : prefs.backdrop;
  if (picture) root.style.setProperty('--picture', `url("${picture}")`);
  else root.style.removeProperty('--picture');
}
function save() {
  local.set(KEY, JSON.stringify(prefs));
  chrome.storage.local.set({ newtab: prefs });
  applyPrefs();
}

// ---- hello and time

let clockTimer = null;
/** A time as [digits, small "AM"/"PM"], in the user's 12 or 24 hour choice, here or in another zone. */
function clockParts(now, zone) {
  const parts = new Intl.DateTimeFormat([], timeOptions(prefs.clock, zone)).formatToParts(now);
  const half = parts.find((p) => p.type === 'dayPeriod')?.value;
  const digits = parts.filter((p) => p.type !== 'dayPeriod').map((p) => p.value).join('').trim();
  return [digits, ...(half ? [el('small', { textContent: half })] : [])];
}
function paintClock() {
  const now = new Date();
  // The digits large, "AM" or "PM" small beside them where the system's clock uses them.
  $('time').replaceChildren(...clockParts(now));
  $('date').textContent = now.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
  $('hello').textContent = greeting(now.getHours(), prefs.name);
}
function runClock() {
  clearTimeout(clockTimer);
  clockTimer = null;
  if (document.visibilityState !== 'visible' || !(prefs.widgets.clock || prefs.widgets.zones)) return;
  paintClock();
  if (prefs.widgets.zones) paintZones();
  clockTimer = setTimeout(runClock, 60_000 - (Date.now() % 60_000) + 40);
}
document.addEventListener('visibilitychange', () => {
  runClock();
  if (document.visibilityState === 'hidden') keepNotes();
});

// ---- quick access

let editing = -1; // index of the pin in the form, or pins.length for a new one
let openTabs = []; // the other tabs, asked once, to mark pins that are already open
let dragFrom = -1;

function pinTile(pin, i) {
  const a = el('a', { href: pin.url, title: pin.title, draggable: true }, [
    el('span', { className: 'chip' }, pinIcon(pin)),
    el('span', { className: 'name', textContent: pin.title }),
  ]);
  const edit = el('button', { type: 'button', className: 'edit', title: 'Edit', ariaLabel: `Edit ${pin.title}` }, glyph(GLYPH.dots, 14));
  edit.addEventListener('click', () => openPinForm(i));
  const li = el('li', { className: 'tile' }, [a, edit]);
  // Already open somewhere: say so, and go there instead of opening it twice.
  const open = openTabFor(pin, openTabs);
  if (open) {
    li.classList.add('open');
    if (open.discarded) li.classList.add('asleep');
    a.title = `${pin.title}: already open${open.discarded ? ', asleep' : ''}. Click goes to that tab.`;
    a.addEventListener('click', (e) => {
      if (e.ctrlKey || e.metaKey || e.shiftKey) return; // asked for a new tab or window on purpose
      e.preventDefault();
      go({ kind: 'tab', tabId: open.id, windowId: open.windowId });
    });
  }
  a.dataset.pin = String(i); // the right-click menu offers Edit and Remove for it (pageMenu below)
  a.addEventListener('dragstart', (e) => {
    dragFrom = i;
    li.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });
  a.addEventListener('dragend', () => {
    dragFrom = -1;
    li.classList.remove('dragging');
  });
  li.addEventListener('dragover', (e) => {
    if (dragFrom < 0 || dragFrom === i) return;
    e.preventDefault();
    li.classList.add('over');
  });
  li.addEventListener('dragleave', () => li.classList.remove('over'));
  li.addEventListener('drop', (e) => {
    e.preventDefault();
    if (dragFrom < 0) return;
    prefs.pins = movePin(prefs.pins, dragFrom, i);
    dragFrom = -1;
    save();
    paintPins();
  });
  return li;
}

function paintPins() {
  const tiles = prefs.pins.map(pinTile);
  if (prefs.pins.length < MAX_PINS) {
    const add = el('button', { type: 'button', className: 'add', title: 'Pin a site' }, [
      el('span', { className: 'chip' }, glyph(GLYPH.plus, 18)),
      el('span', { className: 'name', textContent: 'Pin a site' }),
    ]);
    add.addEventListener('click', () => openPinForm(prefs.pins.length));
    tiles.push(el('li', { className: 'tile' }, add));
  }
  $('pins').replaceChildren(...tiles);
}

function openPinForm(i) {
  editing = i;
  const pin = prefs.pins[i];
  $('pinName').value = pin?.title ?? '';
  $('pinUrl').value = pin?.url ?? '';
  $('pinSaid').textContent = '';
  for (const id of ['pinRemove', 'pinLeft', 'pinRight']) $(id).hidden = !pin;
  $('pinLeft').disabled = i === 0;
  $('pinRight').disabled = i >= prefs.pins.length - 1;
  paintPinOffers(!pin);
  $('pinForm').hidden = false;
  (pin ? $('pinName') : $('pinUrl')).focus();
}
/** A new pin: the most visited sites not pinned yet, one click each. The one way in stays the + tile,
    and nothing is pinned that was not chosen. */
function paintPinOffers(adding) {
  const offers = adding ? topSites.filter((s) => !isPinned(prefs.pins, s.url)).slice(0, 4) : [];
  $('pinOffers').hidden = offers.length === 0;
  $('pinOffers').replaceChildren(...offers.map((s) => {
    const b = el('button', { type: 'button', className: 'offer', title: `Pin ${hostOf(s.url)}` }, [favicon(s.url, 16), el('span', { textContent: hostOf(s.url) })]);
    b.addEventListener('click', () => {
      prefs.pins = addPin(prefs.pins, { url: s.url, title: hostOf(s.url) });
      save();
      paintPins();
      paintTop();
      if (prefs.pins.length >= MAX_PINS) return closePinForm();
      editing = prefs.pins.length;
      paintPinOffers(true);
      ($('pinOffers').querySelector('button') ?? $('pinUrl')).focus();
    });
    return b;
  }));
}
function closePinForm() {
  editing = -1;
  $('pinForm').hidden = true;
}
$('pinForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const pin = cleanPin({ url: $('pinUrl').value, title: $('pinName').value });
  if (!pin) return void ($('pinSaid').textContent = 'That does not look like a web address. Try example.com.');
  const others = prefs.pins.filter((_, i) => i !== editing);
  if (isPinned(others, pin.url)) return void ($('pinSaid').textContent = 'That site is already pinned.');
  if (editing < prefs.pins.length) prefs.pins = prefs.pins.map((p, i) => (i === editing ? pin : p));
  else prefs.pins = addPin(prefs.pins, pin);
  save();
  closePinForm();
  paintPins();
  paintTop();
});
$('pinRemove').addEventListener('click', () => {
  prefs.pins = prefs.pins.filter((_, i) => i !== editing);
  save();
  closePinForm();
  paintPins();
  paintTop();
});
for (const [id, step] of [['pinLeft', -1], ['pinRight', 1]]) {
  $(id).addEventListener('click', () => {
    prefs.pins = movePin(prefs.pins, editing, editing + step);
    save();
    paintPins();
    openPinForm(editing + step);
  });
}
$('pinCancel').addEventListener('click', closePinForm);
$('pinForm').addEventListener('keydown', (e) => e.key === 'Escape' && closePinForm());

// ---- the right-click menu (content/menu.js asks for this page's own entries)

/** What the menu adds on this page: for a tile, a link elsewhere on the page, a card, and the page itself. */
globalThis.gambliumPageMenu = (target) => {
  const tile = target.closest?.('a[data-pin]');
  const card = target.closest?.('section[data-widget]');
  const link = target.closest?.('a[href]');
  let about = null;
  if (tile) {
    const i = Number(tile.dataset.pin);
    about = { items: [
      { label: 'Edit', icon: 'edit', run: () => openPinForm(i) },
      { label: 'Remove from quick access', icon: 'remove', run: () => { prefs.pins = prefs.pins.filter((_, j) => j !== i); save(); paintPins(); paintTop(); } },
    ] };
  } else if (link && /^https?:/.test(link.href) && !isPinned(prefs.pins, link.href) && prefs.pins.length < MAX_PINS) {
    about = { items: [{ label: 'Pin to quick access', icon: 'pin', run: () => { prefs.pins = addPin(prefs.pins, { url: link.href, title: hostOf(link.href) }); save(); paintPins(); paintTop(); } }] };
  }
  const page = [];
  const w = card && WIDGETS.find((x) => x.id === card.dataset.widget);
  if (w) page.push({ label: `Hide ${w.label}`, icon: 'hide', run: () => { prefs.widgets[w.id] = false; save(); loadShown(); if (w.id === 'clock' || w.id === 'zones') runClock(); if (!panel.hidden) paintPanel(); } });
  page.push({ label: 'Customise this page', icon: 'grid', run: () => showPanel(true) });
  return { about, page };
};

// ---- the deck

/** One row: a link (or a button when `act` is given) with an icon, a name and a short note. */
function row({ icon, text, note = '', href, title, act }) {
  const inner = [icon, el('span', { className: 'what', textContent: text }), el('span', { className: 'meta', textContent: note })];
  if (href) return el('a', { href, title: title ?? text }, inner);
  const b = el('button', { type: 'button', className: 'row', title: title ?? text }, inner);
  b.addEventListener('click', act);
  return b;
}
function fill(id, items, known = true) {
  $(id).replaceChildren(...items.slice(0, rowsOf(id)).map((item) => (item instanceof Node && item.tagName === 'LI' ? item : el('li', {}, item))));
  $(`${id}-empty`).hidden = !(known && items.length === 0);
}

function paintTop() {
  fill('top', topSites.map((s) => {
    const li = el('li', {}, row({ icon: favicon(s.url), text: siteLabel(s), note: hostOf(s.url), href: s.url }));
    if (!isPinned(prefs.pins, s.url) && prefs.pins.length < MAX_PINS) {
      const pin = el('button', { type: 'button', className: 'pin', textContent: 'Pin', ariaLabel: `Pin ${siteLabel(s)}` });
      pin.addEventListener('click', () => {
        prefs.pins = addPin(prefs.pins, { url: s.url, title: hostOf(s.url) });
        save();
        paintPins();
        paintTop();
      });
      li.classList.add('pinnable');
      li.append(pin);
    }
    return li;
  }), topKnown);
}

async function loadTop() {
  try {
    let sites = pickSites(await chrome.topSites.get(), 11);
    if (sites.length < rowsOf('top') && chrome.history) {
      // A young profile has no "most visited" yet: fill up from history, most visits first.
      sites = fillSites(sites, await chrome.history.search({ text: '', maxResults: 200, startTime: 0 }), 11);
    }
    const changed = !sameSites(sites, topSites);
    topSites = sites;
    topKnown = true;
    local.set(TOP_CACHE, JSON.stringify(sites));
    paintTop();
    if (changed) paintPins();
  } catch {
    topKnown = true;
    paintTop();
  }
}

async function loadClosed() {
  if (!chrome.sessions) return fill('closed', []);
  try {
    const closed = await chrome.sessions.getRecentlyClosed({ maxResults: 11 });
    const now = Date.now();
    const items = [];
    // Closed tab groups (kept by the extension; the browser's list has none), in time order with the rest.
    const groups = (await send({ type: 'closed-groups' }))?.groups ?? [];
    // A closed group's own tabs are not listed again under it (closing the group closed them).
    const inGroup = (c) => c.tab && groups.some((g) => Math.abs(g.at - (c.lastModified ?? 0) * 1000) < 10_000 && g.tabs.some((t) => t.url === c.tab.url));
    const rows = [...closed.filter((c) => !inGroup(c)).map((c) => ({ at: (c.lastModified ?? 0) * 1000, c })), ...groups.map((g) => ({ at: g.at, g }))].sort((a, b) => b.at - a.at).slice(0, 11);
    for (const { at, c, g } of rows) {
      if (g) {
        const n = g.tabs.length;
        // The group's own colour, as its chip had in the tab strip.
        const dot = el('span', { className: 'gdot', ariaHidden: 'true' });
        dot.style.setProperty('--group', GROUP_COLOURS[g.color] ?? GROUP_COLOURS.grey);
        items.push(row({ icon: dot, text: `${g.title || 'Group'} · ${n} tab${n === 1 ? '' : 's'}`, note: ago(at, now), title: 'Reopen this group as it was', act: () => send({ type: 'group-reopen', id: g.id }).then(loadClosed) }));
        continue;
      }
      const when = ago((c.lastModified ?? 0) * 1000, now);
      if (c.tab && /^https?:/i.test(c.tab.url ?? '')) {
        items.push(row({ icon: favicon(c.tab.url), text: c.tab.title || hostOf(c.tab.url), note: when, title: `Reopen ${c.tab.url}`, act: () => chrome.sessions.restore(c.tab.sessionId) }));
      } else if (c.window) {
        const n = c.window.tabs?.length ?? 0;
        items.push(row({ icon: glyph(GLYPH.window), text: `Window with ${n} tab${n === 1 ? '' : 's'}`, note: when, title: 'Reopen this window', act: () => chrome.sessions.restore(c.window.sessionId) }));
      }
    }
    fill('closed', items);
  } catch {
    fill('closed', []);
  }
}

async function loadStatus() {
  const status = await send({ type: 'status' });
  if (typeof status?.total !== 'number') return void ($('sLine').textContent = 'Gamblium did not answer.');
  const asleep = status.reasons?.['already asleep'] ?? 0;
  $('sTabs').textContent = status.total;
  $('sAsleep').textContent = asleep;
  $('sFrozen').textContent = typeof status.frozen === 'number' ? status.frozen : '–';
  if (typeof status.availableMb === 'number') $('sFree').textContent = `${(status.availableMb / 1024).toFixed(1)} GB`;
  try {
    const { capacity, availableCapacity } = await chrome.system.memory.getInfo();
    const used = Math.round(((capacity - availableCapacity) / capacity) * 100);
    $('sUsed').style.width = `${used}%`;
    $('sMeter').ariaLabel = `Memory in use: ${used}%`;
    $('sLine').textContent = `${used}% of ${(capacity / 2 ** 30).toFixed(0)} GB memory in use on this computer`;
  } catch {
    $('sLine').textContent = statusLine(status);
  }
  $('sleepAll').disabled = status.total - asleep <= 1;
}
$('sleepAll').addEventListener('click', async () => {
  $('sleepAll').disabled = true;
  const answer = await send({ type: 'sleep-now' });
  await loadStatus();
  const n = answer?.slept ?? 0;
  $('sLine').textContent = n ? `Put ${n} tab${n === 1 ? '' : 's'} to sleep.` : 'Nothing to put to sleep: the other tabs are playing, pinned awake or already asleep.';
});
$('openDash').addEventListener('click', () => openPage('ui/dashboard.html'));

async function loadSessions() {
  const list = await send({ type: 'session-list' });
  const now = Date.now();
  fill('sessions', (Array.isArray(list) ? list : []).map((s) =>
    row({ icon: glyph(GLYPH.stack), text: s.name, note: `${s.tabs} tab${s.tabs === 1 ? '' : 's'} · ${ago(s.savedAt, now)}`, title: `Open the session "${s.name}"`, act: () => send({ type: 'session-restore', name: s.name }) })));
}
$('openSessions').addEventListener('click', () => openPage('ui/sessions.html'));

async function loadDownloads() {
  const list = await send({ type: 'downloads-list', limit: rowsOf('downloads') });
  const now = Date.now();
  fill('downloads', (Array.isArray(list) ? list : []).map((d) => {
    const name = String(d.filename || d.url || '').split(/[\\/]/).pop() || 'Download';
    const note = d.state === 'in_progress' ? (d.paused ? 'paused' : 'downloading') : d.state === 'interrupted' ? 'stopped' : ago(Date.parse(d.endTime || d.startTime), now);
    return row({ icon: glyph(GLYPH.file), text: name, note, title: 'Open Downloads', act: () => openPage('ui/downloads.html') });
  }));
}

function keepNotes() {
  const text = $('notes').value;
  if (text === prefs.notes) return;
  prefs.notes = text;
  save();
}
$('notes').addEventListener('change', keepNotes);

// ---- more panels

/** A row with one small button at its right end. */
function rowWith(item, label, act, cls = 'pin show') {
  const side = el('button', { type: 'button', className: cls, textContent: label });
  side.addEventListener('click', act);
  return el('li', { className: 'acts-on' }, [row(item), side]);
}
/** A row whose one action is a small icon that shows on hover or keyboard focus (the row's note
    steps aside for it), so a column of rows is not a column of identical buttons. */
function rowWithIcon(item, label, d, act) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  for (const [k, v] of Object.entries({ width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.4, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(k, v);
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', d);
  svg.append(p);
  const side = el('button', { type: 'button', className: 'rowicon', title: label, ariaLabel: label }, svg);
  side.addEventListener('click', act);
  return el('li', { className: 'icon-on' }, [row(item), side]);
}
const SLEEP_ICON = 'M12.5 9.6A5 5 0 0 1 6.4 3.5a5 5 0 1 0 6.1 6.1z';
const showTab = async (t) => {
  await chrome.tabs.update(t.id ?? t.tabId, { active: true });
  await chrome.windows.update(t.windowId, { focused: true });
};

async function loadPlaying() {
  const tabs = (await chrome.tabs.query({})).filter((t) => t.audible || t.mutedInfo?.muted);
  fill('playing', tabs.map((t) => {
    const muted = !!t.mutedInfo?.muted;
    return rowWith({ icon: favicon(t.url), text: t.title || hostOf(t.url), note: muted ? 'muted' : '', title: 'Go to this tab', act: () => showTab(t) }, muted ? 'Unmute' : 'Mute', async () => {
      await chrome.tabs.update(t.id, { muted: !muted });
      loadPlaying();
    });
  }));
}

async function loadHeavy() {
  const stats = await send({ type: 'tab-stats' });
  fill('heavy', heaviest(stats?.tabs, rowsOf('heavy')).map((t) =>
    rowWithIcon({ icon: favicon(t.url), text: t.title || hostOf(t.url), note: `${Math.round(t.memoryMb)} MB`, title: 'Go to this tab', act: () => showTab(t) }, 'Sleep this tab', SLEEP_ICON, async () => {
      await chrome.tabs.discard(t.tabId).catch(() => {});
      loadHeavy();
    })));
}

async function loadRecent() {
  const now = Date.now();
  const seen = await Promise.resolve(chrome.history?.search({ text: '', maxResults: 40, startTime: 0 }) ?? []).catch(() => []);
  fill('recent', recentPages(seen, rowsOf('recent')).map((p) => row({ icon: favicon(p.url), text: p.title, note: ago(p.at, now), href: p.url })));
}

async function loadMarks() {
  const marks = await Promise.resolve(chrome.bookmarks?.getRecent(rowsOf('marks')) ?? []).catch(() => []);
  fill('marks', marks.filter((m) => /^https?:/i.test(m.url ?? '')).map((m) => row({ icon: favicon(m.url), text: m.title || hostOf(m.url), note: hostOf(m.url), href: m.url })));
}

// To do: kept with the page's settings, on this computer.
function paintTodo() {
  $('todo').replaceChildren(...prefs.todos.map((t, i) => {
    const box = el('input', { type: 'checkbox', id: `todo-${i}`, checked: t.done });
    box.addEventListener('change', () => {
      prefs.todos[i].done = box.checked;
      save();
      paintTodo();
    });
    const drop = el('button', { type: 'button', className: 'drop', textContent: '×', ariaLabel: `Remove "${t.text}"` });
    drop.addEventListener('click', () => {
      prefs.todos.splice(i, 1);
      save();
      paintTodo();
    });
    return el('li', { className: t.done ? 'done' : '' }, [box, el('label', { htmlFor: `todo-${i}`, textContent: t.text }), drop]);
  }));
  $('todoClear').hidden = !prefs.todos.some((t) => t.done);
}
$('todoForm').addEventListener('submit', (e) => {
  e.preventDefault();
  prefs.todos = cleanTodos([...prefs.todos, { text: $('todoText').value }]).slice(0, MAX_TODOS);
  $('todoText').value = '';
  save();
  paintTodo();
});
$('todoClear').addEventListener('click', () => {
  prefs.todos = prefs.todos.filter((t) => !t.done);
  save();
  paintTodo();
});

// Calendar: one month, today marked. Drawn when asked for, never on a timer.
let calAt = null; // [year, month] on show; null means this month
function paintCalendar() {
  const today = new Date();
  const [y, m] = calAt ?? [today.getFullYear(), today.getMonth()];
  let firstDay = 1;
  try {
    const loc = new Intl.Locale(navigator.language);
    firstDay = (loc.getWeekInfo?.() ?? loc.weekInfo)?.firstDay % 7 ?? 1;
  } catch {}
  if (!Number.isInteger(firstDay)) firstDay = 1;
  const dayName = new Intl.DateTimeFormat([], { weekday: 'narrow' });
  const heads = Array.from({ length: 7 }, (_, i) => el('th', { scope: 'col', textContent: dayName.format(new Date(2023, 0, 1 + firstDay + i)) })); // 1 Jan 2023 was a Sunday
  const isNow = y === today.getFullYear() && m === today.getMonth();
  const body = monthGrid(y, m, firstDay).map((week) => el('tr', {}, week.map((d) => el('td', { className: isNow && d === today.getDate() ? 'today' : '', textContent: d || '' }))));
  $('cal').replaceChildren(
    el('caption', { textContent: new Date(y, m, 1).toLocaleDateString([], { month: 'long', year: 'numeric' }) }),
    el('thead', {}, el('tr', {}, heads)),
    el('tbody', {}, body),
  );
  $('calNow').hidden = isNow;
}
for (const [id, step] of [['calPrev', -1], ['calNext', 1]]) {
  $(id).addEventListener('click', () => {
    const now = new Date();
    const [y, m] = calAt ?? [now.getFullYear(), now.getMonth()];
    const d = new Date(y, m + step, 1);
    calAt = [d.getFullYear(), d.getMonth()];
    paintCalendar();
  });
}
$('calNow').addEventListener('click', () => {
  calAt = null;
  paintCalendar();
});

// World clocks: repainted with the page's one minute tick.
function paintZones() {
  const now = new Date();
  const day = (zone) => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const here = day(undefined);
  $('zones').replaceChildren(...prefs.zones.map((zone, i) => {
    let when;
    let other = '';
    try {
      when = clockParts(now, zone);
      const there = day(zone);
      other = there > here ? 'tomorrow' : there < here ? 'yesterday' : '';
    } catch {
      when = ['–'];
    }
    const where = el('span', { className: 'what where', textContent: zoneName(zone) });
    if (other) where.append(el('small', { textContent: other }));
    const drop = el('button', { type: 'button', className: 'drop', textContent: '×', ariaLabel: `Remove ${zoneName(zone)}` });
    drop.addEventListener('click', () => {
      prefs.zones.splice(i, 1);
      save();
      paintZones();
    });
    return el('li', {}, [el('div', { className: 'zone' }, [where, el('span', { className: 'when' }, when)]), drop]);
  }));
  $('zoneForm').hidden = prefs.zones.length >= MAX_ZONES;
}
let zoneNames = null;
const allZones = () => (zoneNames ??= Intl.supportedValuesOf?.('timeZone') ?? []);
$('zoneText').addEventListener('focus', () => {
  if (!$('zoneList').children.length) $('zoneList').replaceChildren(...allZones().map((z) => el('option', { value: zoneName(z), label: z })));
}, { once: true });
$('zoneForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const typed = $('zoneText').value.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!typed) return;
  const zone = allZones().find((z) => z.toLowerCase() === typed.replace(/ /g, '_')) ?? allZones().find((z) => zoneName(z).toLowerCase() === typed) ?? allZones().find((z) => zoneName(z).toLowerCase().startsWith(typed));
  if (!zone) return void ($('zoneSaid').textContent = 'No place by that name. Try a large city, such as Tokyo or London.');
  $('zoneSaid').textContent = '';
  $('zoneText').value = '';
  if (!prefs.zones.includes(zone)) prefs.zones.push(zone);
  save();
  paintZones();
  runClock();
});

const LOAD = { top: loadTop, closed: loadClosed, status: loadStatus, sessions: loadSessions, downloads: loadDownloads, playing: loadPlaying, heavy: loadHeavy, recent: loadRecent, marks: loadMarks, calendar: paintCalendar, zones: paintZones, todo: paintTodo };
const loaded = new Set();
/** Asks for what the shown panels need. Each panel asks once per page. */
function loadShown() {
  for (const [id, load] of Object.entries(LOAD)) {
    // Quick access needs the visited sites too, for its first-time offer.
    const wanted = prefs.widgets[id] || (id === 'top' && prefs.widgets.pins && prefs.pins.length === 0);
    if (wanted && !loaded.has(id)) {
      loaded.add(id);
      load();
    }
  }
}

// ---- search: the web, an address, or something this browser already knows

let offers = []; // [{kind, text|url, title, tabId, windowId}], the first is always what Enter does with the text
let picked = 0;
let asked = 0;
const KIND = { route: 'Gamblium', tab: 'Switch to tab', pin: 'Pinned', bookmark: 'Bookmark', history: 'History' };
const me = chrome.tabs.getCurrent();

function paintOffers() {
  const list = $('suggest');
  list.replaceChildren(...offers.map((o, i) => {
    const icon = o.kind === 'search' ? glyph(GLYPH.search) : o.kind === 'url' || o.kind === 'route' ? glyph(GLYPH.go) : favicon(o.url, 16);
    const what = el('span', { className: 'what', textContent: o.title });
    if (o.url && o.kind !== 'url') what.append(el('small', { textContent: hostOf(o.url) }));
    if (o.kind === 'route' && o.address !== o.title) what.append(el('small', { textContent: o.address }));
    const li = el('li', { id: `offer-${i}`, role: 'option', ariaSelected: String(i === picked) }, [icon, what, el('span', { className: 'kind', textContent: KIND[o.kind] ?? (o.kind === 'url' ? 'Go to address' : 'Search the web') })]);
    li.addEventListener('mousedown', (e) => e.preventDefault()); // keep the caret in the box
    li.addEventListener('click', () => go(o));
    // The mouse only lights a row; what Enter opens stays the keyboard's row, so the two never look alike.
    return li;
  }));
  list.hidden = offers.length === 0;
  $('q').ariaExpanded = String(offers.length > 0);
  if (offers.length) $('q').setAttribute('aria-activedescendant', `offer-${picked}`);
  else $('q').removeAttribute('aria-activedescendant');
}
function pick(i) {
  picked = (i + offers.length) % offers.length;
  for (const [n, li] of [...$('suggest').children].entries()) li.ariaSelected = String(n === picked);
  $('q').setAttribute('aria-activedescendant', `offer-${picked}`);
}
function closeOffers() {
  offers = [];
  picked = 0;
  paintOffers();
}

async function ask() {
  const text = $('q').value;
  const typed = classify(text);
  if (typed.kind === 'empty') return closeOffers();
  // gamblium://name: our own pages and the browser's, by name.
  if (/^gamblium:/i.test(text.trim())) {
    ++asked;
    const exact = resolve(text);
    const named = suggestRoutes(text).map((s) => ({ kind: 'route', title: s.title, address: s.address, to: resolve(s.address) }));
    // A name we know comes first; an address we only pass on to the browser comes after the names that fit.
    const typedRow = exact && !named.some((n) => n.address === text.trim().toLowerCase()) ? [{ kind: 'route', title: text.trim(), address: text.trim(), to: exact }] : [];
    offers = exact?.kind === 'page' || exact?.name ? [...typedRow, ...named] : [...named, ...typedRow];
    picked = 0;
    return paintOffers();
  }
  const first = typed.kind === 'url' ? { kind: 'url', url: typed.url, title: text.trim() } : { kind: 'search', text: typed.text, title: typed.text };
  const turn = ++asked;
  const quiet = (p) => Promise.resolve(p).catch(() => []);
  const [tabs, history, bookmarks, self] = await Promise.all([
    quiet(chrome.tabs.query({})),
    quiet(chrome.history?.search({ text: text.trim(), maxResults: 14, startTime: 0 }) ?? []),
    quiet(chrome.bookmarks?.search(text.trim()) ?? []),
    quiet(me),
  ]);
  if (turn !== asked) return; // a later keystroke already answered
  const found = suggest(text, { tabs: tabs.filter((t) => t.id !== self?.id), pins: prefs.pins, bookmarks, history });
  offers = [first, ...found];
  picked = 0;
  paintOffers();
}

async function go(o) {
  if (!o) return;
  if (o.kind === 'route') {
    if (o.to.kind === 'browser') return chrome.tabs.update({ url: o.to.url });
    location.hash = '#/' + o.to.route; // this document becomes the frame around that page
    return location.reload();
  }
  if (o.kind === 'search') {
    // The engine picked on first run, or the browser's own default when none was.
    const url = searchUrl(prefs.search, o.text);
    return url ? chrome.tabs.update({ url }) : chrome.search.query({ text: o.text, disposition: 'CURRENT_TAB' });
  }
  if (o.kind === 'tab') {
    const self = await me;
    await chrome.tabs.update(o.tabId, { active: true });
    await chrome.windows.update(o.windowId, { focused: true });
    if (self) chrome.tabs.remove(self.id); // this empty tab has done its job
    return;
  }
  chrome.tabs.update({ url: o.url });
}

$('q').addEventListener('input', ask);
$('q').addEventListener('keydown', (e) => {
  if (!offers.length) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    pick(picked + (e.key === 'ArrowDown' ? 1 : -1));
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeOffers();
  }
});
$('q').addEventListener('blur', closeOffers);
$('q').addEventListener('focus', () => $('q').value && ask());
$('search').addEventListener('submit', (e) => {
  e.preventDefault();
  if (offers.length) return go(offers[picked]);
  const typed = classify($('q').value);
  if (typed.kind === 'url') go({ kind: 'url', url: typed.url });
  else if (typed.kind === 'search') go({ kind: 'search', text: typed.text });
});

// ---- moving and resizing the cards: drag a card by its title, drag its corner, or use the keys on the corner

/** The card ids on the page now (switched on), in order. */
const shownCards = () => prefs.layout.order.filter((id) => prefs.widgets[id]);
/** Saves a changed layout; a card whose height changed asks for its rows again. */
function keepLayout(next, id) {
  if (next === prefs.layout) return;
  const before = cardSize(prefs.layout, id).h;
  prefs.layout = next;
  save();
  if (cardSize(next, id).h !== before && LOAD[id]) LOAD[id]();
}
/** What the grid looks like now: one column's width, one row's height, the gap and the number of columns. */
function gridNow() {
  const cs = getComputedStyle(deck);
  const cols = cs.gridTemplateColumns.split(' ').map(parseFloat).filter((n) => n > 0);
  return { col: cols[0] ?? deck.clientWidth, row: 236, gap: parseFloat(cs.columnGap) || 16, cols: cols.length || 1 };
}
let lifted = null; // the id of the card being dragged
function clearMarks() {
  for (const c of deck.querySelectorAll('.before, .after')) c.classList.remove('before', 'after');
}
for (const id of CARDS) {
  const card = cardOf(id);
  if (!card) continue;
  const title = card.querySelector('h2');
  title.title = 'Drag to move this card';
  // Only a drag that starts on the title moves the card; links and buttons inside keep their own drags and clicks.
  title.addEventListener('pointerdown', () => { card.draggable = true; });
  card.addEventListener('pointerup', () => { card.draggable = false; });
  card.addEventListener('dragstart', (e) => {
    if (e.target !== card) return;
    lifted = id;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', title.textContent);
    requestAnimationFrame(() => { if (lifted === id) card.classList.add('lifted'); }); // after the browser took its picture of the card
  });
  card.addEventListener('dragend', () => {
    lifted = null;
    card.draggable = false;
    card.classList.remove('lifted');
    clearMarks();
  });
  card.addEventListener('dragover', (e) => {
    if (!lifted || lifted === id) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const r = card.getBoundingClientRect();
    const after = e.clientX > r.left + r.width / 2;
    if (card.classList.contains(after ? 'after' : 'before')) return;
    clearMarks();
    card.classList.add(after ? 'after' : 'before');
  });
  card.addEventListener('drop', (e) => {
    if (!lifted || lifted === id) return;
    e.preventDefault();
    const after = card.classList.contains('after');
    const seen = shownCards().filter((x) => x !== lifted);
    const target = after ? seen[seen.indexOf(id) + 1] ?? null : id;
    const moved = lifted;
    clearMarks();
    keepLayout(moveCard(prefs.layout, moved, target), moved);
  });

  const grip = el('button', { type: 'button', className: 'grip', title: 'Drag to resize. Arrow keys resize, Ctrl + arrow keys move.', ariaLabel: `Resize or move ${title.textContent}` }, glyph('M13 7 7 13M13 11.500 11.500 13', 16));
  let start = null;
  grip.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    const r = card.getBoundingClientRect();
    start = { left: r.left, top: r.top, grid: gridNow() };
    card.classList.add('sizing');
  });
  grip.addEventListener('pointermove', (e) => {
    if (!start) return;
    const { w, h } = snapSize(e.clientX - start.left, e.clientY - start.top, start.grid);
    card.dataset.w = w;
    card.dataset.h = h;
  });
  const done = (e) => {
    if (!start) return;
    start = null;
    card.classList.remove('sizing');
    if (e.type === 'pointercancel') return applyLayout();
    keepLayout(sizeCard(prefs.layout, id, Number(card.dataset.w), Number(card.dataset.h)), id);
  };
  grip.addEventListener('pointerup', done);
  grip.addEventListener('pointercancel', done);
  grip.addEventListener('keydown', (e) => {
    const step = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (!step) return;
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      keepLayout(nudgeCard(prefs.layout, id, step[0] || step[1], shownCards()), id);
      grip.focus();
      return;
    }
    const { w, h } = cardSize(prefs.layout, id);
    keepLayout(sizeCard(prefs.layout, id, Math.min(w + step[0], gridNow().cols), h + step[1]), id);
  });
  card.append(grip);
}

// ---- customise

const panel = $('panel');
function paintPanel() {
  const sw = (w) => {
    const box = el('input', { type: 'checkbox', role: 'switch', checked: prefs.widgets[w.id] });
    box.addEventListener('change', () => {
      prefs.widgets[w.id] = box.checked;
      save();
      loadShown();
      if (w.id === 'clock' || w.id === 'zones') runClock();
    });
    // Rule 11: the name says it; what the card shows is the row's tooltip, not a second line under every switch.
    return el('li', {}, el('label', { title: w.hint }, [el('span', { textContent: w.label }), box]));
  };
  $('switchesTop').replaceChildren(...WIDGETS.filter((w) => !CARDS.includes(w.id)).map(sw));
  $('switches').replaceChildren(...WIDGETS.filter((w) => CARDS.includes(w.id)).map(sw));
  $('packCards').checked = prefs.layout.pack;
  const has = !!local.get(PICTURE);
  for (const r of document.querySelectorAll('input[name="backdrop"]')) r.checked = r.value === prefs.backdrop;
  $('dropPicture').hidden = !has;
  $('pickPicture').textContent = has ? 'Change the picture' : 'Choose a picture';
  $('pictureSwatch').style.backgroundImage = has ? `url("${local.get(PICTURE)}")` : '';
  $('name').value = prefs.name;
  for (const r of document.querySelectorAll('input[name="clock"]')) r.checked = r.value === prefs.clock;
  for (const r of document.querySelectorAll('input[name="clockSize"]')) r.checked = r.value === prefs.clockSize;
}
function showPanel(open) {
  panel.hidden = !open;
  $('customise').ariaExpanded = String(open);
  if (open) {
    paintPanel();
    panel.focus();
  }
}
$('packCards').addEventListener('change', () => {
  prefs.layout = { ...prefs.layout, pack: $('packCards').checked };
  save();
});
$('resetLayout').addEventListener('click', () => {
  const tall = CARDS.filter((id) => cardSize(prefs.layout, id).h > 1);
  prefs.layout = readLayout(null);
  save();
  for (const id of tall) if (LOAD[id]) LOAD[id]();
  $('packCards').checked = true;
});
$('customise').addEventListener('click', () => showPanel(panel.hidden));
$('panelClose').addEventListener('click', () => {
  showPanel(false);
  $('customise').focus();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !panel.hidden) {
    showPanel(false);
    $('customise').focus();
  }
});
document.addEventListener('pointerdown', (e) => {
  if (!panel.hidden && !panel.contains(e.target) && !$('customise').contains(e.target)) showPanel(false);
});

for (const r of document.querySelectorAll('input[name="backdrop"]')) {
  r.addEventListener('change', () => {
    if (r.value === 'picture' && !local.get(PICTURE)) return $('pictureFile').click(); // chosen once a picture is in
    prefs.backdrop = r.value;
    save();
  });
}
$('pickPicture').addEventListener('click', () => $('pictureFile').click());
$('pictureFile').addEventListener('change', async () => {
  const file = $('pictureFile').files[0];
  $('pictureFile').value = '';
  if (!file) return paintPanel();
  try {
    // Kept on this computer only, scaled to the screen so it opens with the page.
    const image = await createImageBitmap(file);
    const scale = Math.min(1, 1920 / image.width, 1200 / image.height);
    const canvas = el('canvas', { width: Math.round(image.width * scale), height: Math.round(image.height * scale) });
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    if (!local.set(PICTURE, canvas.toDataURL('image/jpeg', 0.82))) throw new Error('no room');
    prefs.backdrop = 'picture';
    $('pictureSaid').textContent = '';
    save();
  } catch {
    $('pictureSaid').textContent = 'That picture could not be used. Try a JPEG or PNG.';
  }
  paintPanel();
});
$('dropPicture').addEventListener('click', () => {
  local.set(PICTURE, null);
  if (prefs.backdrop === 'picture') prefs.backdrop = 'moon';
  save();
  paintPanel();
});
$('name').addEventListener('input', () => {
  prefs.name = $('name').value.trim().slice(0, 30);
  save();
  paintClock();
});
for (const r of document.querySelectorAll('input[name="clock"]')) {
  r.addEventListener('change', () => {
    prefs.clock = r.value;
    save();
    paintClock();
    if (prefs.widgets.zones) paintZones();
  });
}
for (const r of document.querySelectorAll('input[name="clockSize"]')) {
  r.addEventListener('change', () => {
    prefs.clockSize = r.value;
    save();
    placeClock();
  });
}
$('openLook').addEventListener('click', () => openPage('ui/settings.html', '#look'));
$('reset').addEventListener('click', () => {
  // Pins, notes, the list and the places are the user's own work: reset puts the layout back, not those.
  prefs = readPrefs({ pins: prefs.pins, notes: prefs.notes, todos: prefs.todos, zones: prefs.zones, search: prefs.search });
  save();
  paintPanel();
  runClock();
  loadShown();
});

// ---- first paint from the copy, then the truth from extension storage

function paintAll() {
  applyPrefs();
  paintClock();
  runClock();
  paintPins();
  paintTop();
  $('notes').value = prefs.notes;
  paintTodo();
  paintZones();
  loadShown();
}
paintAll();
Promise.all([chrome.tabs.query({}), me]).then(([tabs, self]) => {
  openTabs = tabs.filter((t) => t.id !== self?.id && /^https?:/i.test(t.url ?? ''));
  if (openTabs.length && prefs.pins.length) paintPins();
}, () => {});
chrome.storage.local.get({ newtab: null }).then(({ newtab }) => {
  if (!newtab) return void chrome.storage.local.set({ newtab: prefs });
  const stored = readPrefs(newtab);
  if (JSON.stringify(stored) === JSON.stringify(prefs)) return;
  prefs = stored;
  local.set(KEY, JSON.stringify(prefs));
  paintAll();
});

// ---- Spaces: this window's tab groups as spaces (background.js, spaces.js) --------------
// A chip per space; the one you are in is pressed. Clicking one switches: its tabs come
// back, the other spaces fold and freeze. Repainted on tab and group events only, while
// this page is visible: no timers.
// Chromium's group colours, toned for a dark page; the browser's own strip uses these names.
const SPACE_INK = { grey: '#9DA1AA', blue: '#7EA6E0', red: '#E08A80', yellow: '#E2C26B', green: '#7FC79A', pink: '#E59BC4', purple: '#B49AE6', cyan: '#78C9D4', orange: '#E8A46A' };
let spacesPainted = '';
async function paintSpaces() {
  if (document.visibilityState !== 'visible') return;
  const w = (await me)?.windowId;
  const r = await send({ type: 'spaces-list', windowId: w });
  const bar = $('spacesBar');
  if (!r?.ok) return void (bar.hidden = true);
  const key = JSON.stringify(r.spaces);
  if (key === spacesPainted) return;
  spacesPainted = key;
  // No row is held for spaces until there is one (owner, Nov 13 2026); the first one is made
  // from the right-click menu (Move to space > New space) or the popup.
  bar.hidden = r.spaces.length === 0;
  $('spaces').replaceChildren(...r.spaces.map((s) => {
    const name = s.title || 'Untitled space';
    const counts = !s.frozen ? String(s.tabs) : s.frozen === s.tabs ? `${s.tabs} frozen` : `${s.tabs} · ${s.frozen} frozen`;
    const b = el('button', { type: 'button', title: `${name}: ${s.tabs} tab${s.tabs === 1 ? '' : 's'}, ${s.awake} awake, ${s.frozen} frozen, ${s.asleep} asleep` }, [
      el('span', { className: 'swatch', style: `background:${SPACE_INK[s.color] ?? SPACE_INK.grey}` }),
      el('span', { textContent: name }),
      el('span', { className: 'n', textContent: counts }),
    ]);
    b.setAttribute('aria-pressed', String(s.active));
    b.addEventListener('click', () => send({ type: 'space-switch', groupId: s.id }));
    return el('li', {}, b);
  }));
}
// The first space: offered only once a window has grouped tabs, or from the button below.
$('spaceNew').addEventListener('click', async () => {
  const w = (await me)?.windowId;
  await send({ type: 'space-new', windowId: w });
  paintSpaces();
});
let spacesSoon = null;
const spacesLater = () => { clearTimeout(spacesSoon); spacesSoon = setTimeout(paintSpaces, 120); };
if (chrome.tabGroups) for (const ev of ['onCreated', 'onUpdated', 'onRemoved', 'onMoved']) chrome.tabGroups[ev]?.addListener(spacesLater);
for (const ev of ['onCreated', 'onRemoved', 'onAttached', 'onDetached', 'onActivated']) chrome.tabs[ev].addListener(spacesLater);
chrome.tabs.onUpdated.addListener((id, change) => { if ('groupId' in change || 'discarded' in change) spacesLater(); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { spacesPainted = ''; paintSpaces(); } });
paintSpaces();

// An update that is ready: across the top of the page, with "Later" for this version.
{
  const main = document.querySelector('main');
  if (main) {
    showUpdateBanner(main, { later: true }).catch(() => {});
    // Downloaded while this page is open: shown then.
    chrome.storage.onChanged.addListener((c, area) => {
      if (area === 'local' && c.updateReady && !document.querySelector('.gamblium-update')) showUpdateBanner(main, { later: true }).catch(() => {});
    });
  }
}


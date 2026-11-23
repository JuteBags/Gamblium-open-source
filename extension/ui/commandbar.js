// The command bar: type, arrows, Enter runs, Esc closes. Matching: ../commandbar.js.
// Over a page (?overlay=1, content/commandbar-host.js) or, where no extension may draw (the
// browser's own pages), in a small window of its own. Results come in groups: what the text
// itself is (an address, a bang search), actions, open tabs, the web.
import { suggest } from '../commandbar.js';
import { bangOffer } from '../bangs.js';

const params = new URLSearchParams(location.search);
const overlay = params.get('overlay') === '1';
if (overlay) document.documentElement.classList.add('overlay');
let under = Number(params.get('w')) || null; // the window it was called from
const $ = (id) => document.getElementById(id);
const send = (msg) => new Promise((r) => chrome.runtime.sendMessage(msg, (a) => r(chrome.runtime.lastError ? null : a)));
let lines = [];
let at = 0;
let tabs = [];
let bangPrefs = { ownBangs: {}, bangsOn: true };

const GROUP = { go: 'Go to', bang: 'Bangs', hint: 'Bangs', action: 'Actions', tab: 'Open tabs', search: 'Search' };
const ORDER = ['go', 'bang', 'hint', 'action', 'tab', 'search'];
const PAGE_FILE = { tabs: 'dashboard' };
const NS = 'http://www.w3.org/2000/svg';
const GLYPH = {
  action: 'M11 2.5 4.5 11h5l-1 6.5L15.5 9h-5z',
  page: 'M5.5 3h6l3 3v11h-9zM11.5 3v3h3',
  search: 'M8.5 3a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11zM13 13l4 4',
  go: 'M4 10h11M11 6l4 4-4 4',
  hint: 'M9 3v9M9 15.5v.5',
};

function glyph(d) {
  const svg = document.createElementNS(NS, 'svg');
  for (const [k, v] of Object.entries({ width: 18, height: 18, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(k, v);
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', d);
  svg.append(p);
  return svg;
}
function favicon(url) {
  const img = document.createElement('img');
  img.alt = '';
  img.src = chrome.runtime.getURL(`_favicon/?pageUrl=${encodeURIComponent(url)}&size=32`);
  return img;
}
function iconOf(l) {
  if ((l.kind === 'tab' || l.kind === 'bang') && l.url) return favicon(l.url);
  if (l.kind === 'action') return glyph(l.do?.page ? GLYPH.page : GLYPH.action);
  return glyph(GLYPH[l.kind] || GLYPH.search);
}

/** What the text gives: bangs first when it holds one, then the usual lines, grouped. */
function linesFor(text) {
  const bang = bangPrefs.bangsOn ? bangOffer(text, bangPrefs.ownBangs) : null;
  $('bangtag').hidden = !(bang?.kind === 'bang');
  if (bang?.kind === 'bang') $('bangtag').textContent = `!${bang.bang} · ${bang.name}`;
  if (bang?.kind === 'bangs') return bang.list.map((b) => ({ kind: 'hint', bang: b.bang, title: `!${b.bang}`, note: b.name }));
  const found = suggest(text, tabs);
  if (bang?.kind === 'bang') {
    const plain = found.filter((l) => l.kind !== 'search');
    return [
      { kind: 'bang', url: bang.url, title: bang.query ? `Search ${bang.name} for “${bang.query}”` : `Open ${bang.name}`, note: '' },
      ...plain,
      { kind: 'search', title: `“${text.trim()}”`, note: 'Search the web as typed', query: text.trim(), literal: true },
    ];
  }
  // Grouped, each group keeping the order of fit.
  return ORDER.flatMap((k) => found.filter((l) => l.kind === k));
}

function draw() {
  lines = linesFor($('q').value);
  at = Math.min(at, Math.max(0, lines.length - 1));
  const out = [];
  let group = null;
  lines.forEach((l, i) => {
    if (GROUP[l.kind] !== group) {
      group = GROUP[l.kind];
      out.push(Object.assign(document.createElement('li'), { className: 'group', role: 'presentation', textContent: group }));
    }
    const li = document.createElement('li');
    li.className = 'row';
    li.setAttribute('role', 'option');
    li.id = `line-${i}`;
    li.setAttribute('aria-selected', String(i === at));
    const ic = Object.assign(document.createElement('span'), { className: 'ic' });
    ic.append(iconOf(l));
    const t = Object.assign(document.createElement('span'), { className: 't' });
    t.append(Object.assign(document.createElement('b'), { textContent: l.title }));
    const note = l.kind === 'action' ? '' : l.note || '';
    if (note) t.append(Object.assign(document.createElement('small'), { textContent: note }));
    li.append(ic, t, Object.assign(document.createElement('kbd'), { className: 'enter', textContent: l.kind === 'hint' ? 'Tab' : '↵' }));
    li.addEventListener('mousemove', () => { if (at !== i) { at = i; mark(); } });
    li.addEventListener('mousedown', (e) => e.preventDefault()); // the caret stays in the field
    li.addEventListener('click', () => run(l));
    out.push(li);
  });
  if (!lines.length) out.push(Object.assign(document.createElement('li'), { className: 'empty', textContent: 'Nothing fits. Enter searches the web.' }));
  $('list').replaceChildren(...out);
  mark();
  fitFrame();
}
// Over a page the frame is as tall as the panel: below it the page shows, not an empty frame.
function fitFrame() {
  if (overlay) parent.postMessage({ type: 'gamblium-commandbar-size', height: Math.ceil(document.querySelector('.panel').getBoundingClientRect().height) }, '*');
}
function mark() {
  for (const li of $('list').querySelectorAll('.row')) li.setAttribute('aria-selected', String(li.id === `line-${at}`));
  const cur = $(`line-${at}`);
  if (cur) {
    $('q').setAttribute('aria-activedescendant', cur.id);
    cur.scrollIntoView({ block: 'nearest' });
  }
}

function close() {
  if (overlay) parent.postMessage({ type: 'gamblium-commandbar-close' }, '*');
  else window.close();
}

async function openUrl(url) {
  await chrome.tabs.create(under ? { windowId: under, url, active: true } : { url, active: true });
  if (under) await chrome.windows.update(under, { focused: true }).catch(() => {});
}

async function run(l) {
  if (!l) return;
  if (l.kind === 'hint') {
    // The bang goes into the field; the words come next.
    $('q').value = `!${l.bang} `;
    at = 0;
    return draw();
  }
  if (l.kind === 'tab') {
    await chrome.tabs.update(l.tabId, { active: true });
    await chrome.windows.update(l.windowId, { focused: true });
  } else if (l.kind === 'go' || l.kind === 'bang') {
    await openUrl(l.url);
  } else if (l.kind === 'search') {
    if (l.literal) {
      // The text as typed, bang and all: the bang rules let this one tab pass for a moment.
      const tab = await chrome.tabs.create(under ? { windowId: under, active: true } : { active: true });
      await send({ type: 'bang-literal', tabId: tab.id });
      await chrome.search.query({ text: l.query, tabId: tab.id });
    } else {
      await chrome.search.query({ text: l.query, disposition: 'NEW_TAB' });
    }
  } else {
    const d = l.do;
    if (d.page) {
      const [name, inner] = d.page.split('#');
      await openUrl(chrome.runtime.getURL(`ui/${PAGE_FILE[name] || name}.html`) + (inner ? '#' + inner : ''));
    } else if (d.url) await openUrl(d.url);
    else if (d.private) await chrome.windows.create({ incognito: true });
    else if (d.sidePanel) {
      // Opened from this keypress (a side panel needs a person's action), in the window below.
      if (under) await chrome.sidePanel.open({ windowId: under }).catch(() => {});
    }
    else if (d.set) await chrome.storage.local.set(d.set);
    else if (d.message) await send({ ...d.message, windowId: under });
    else if (d.container) {
      const [front] = under ? await chrome.tabs.query({ active: true, windowId: under }) : [];
      if (front && front.groupId !== -1) await send({ type: 'space-container', groupId: front.groupId });
    }
    if (under && !d.private && !overlay) await chrome.windows.update(under, { focused: true }).catch(() => {});
  }
  close();
}

$('q').addEventListener('input', () => { at = 0; draw(); });
$('q').addEventListener('keydown', (e) => {
  const rows = lines.length;
  if (e.key === 'ArrowDown') { at = Math.min(at + 1, rows - 1); mark(); e.preventDefault(); }
  else if (e.key === 'ArrowUp') { at = Math.max(at - 1, 0); mark(); e.preventDefault(); }
  else if (e.key === 'Tab' && lines[at]?.kind === 'hint') { run(lines[at]); e.preventDefault(); }
  else if (e.key === 'Enter') {
    e.preventDefault();
    if (lines[at]) run(lines[at]);
    else if ($('q').value.trim()) run({ kind: 'search', query: $('q').value.trim() });
  }
  else if (e.key === 'Escape') { e.preventDefault(); close(); }
});
// In a window of its own: gone when it loses the focus, like a menu. Over a page the page's
// shade closes it.
if (!overlay) addEventListener('blur', () => setTimeout(() => { if (!document.hasFocus()) window.close(); }, 150));

(async () => {
  if (!under) under = (await chrome.tabs.getCurrent().catch(() => null))?.windowId ?? null;
  bangPrefs = await chrome.storage.local.get({ ownBangs: {}, bangsOn: true });
  const all = await chrome.tabs.query({});
  const me = chrome.runtime.getURL('ui/commandbar.html');
  tabs = all.filter((t) => !(t.url || '').startsWith(me)).map((t) => ({ id: t.id, windowId: t.windowId, title: t.title, url: t.url }));
  draw();
})();
draw();
$('q').focus();
// Keyboard only (owner, Nov 15 2026: "I press Alt+K and have to click into it"): a frame inside a
// page may not take the focus by itself, so the page gives it (content/commandbar-host.js) and the
// field takes it the moment the frame has it.
addEventListener('focus', () => $('q').focus());
addEventListener('message', (e) => {
  if (e.data?.type === 'gamblium-commandbar-focus') {
    window.focus();
    $('q').focus();
  }
});

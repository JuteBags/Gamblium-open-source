// History: what this browser remembers, by day, with a search box and a
// choice of when. Read when the page opens and when a filter changes;
// nothing runs on a timer.
import { $, el, button, say, send } from './page.js';
import { urlKey } from '../sessions.js';
import { WHENS, whenRange, groupByDay, siteLabel } from './pages-logic.js';
import { timeOptions } from '../newtab/logic.js';
import { guardIcon } from '../site-icons.js';

// Times follow the New Tab clock's choice (system, 12 or 24 hours): "7:30 PM", not "07:30 PM".
const clock = (await chrome.storage.local.get({ newtab: null })).newtab?.clock ?? 'auto';

const STEP = 200;
let when = 'all';
let limit = STEP;
let turn = 0;

function renderWhens() {
  $('whens').replaceChildren(...WHENS.map((w) => {
    const b = button(w.label, () => {
      when = w.id;
      limit = STEP;
      renderWhens();
      read();
    });
    b.setAttribute('aria-pressed', String(w.id === when));
    return b;
  }));
}

// Where else a page of the history is: open in a tab right now, and kept in saved sessions.
// Read once when the page opens and again when it is shown after being hidden.
let openNow = new Map(); // page key -> tab
let saved = {}; // page key -> [session names]
async function readWhere() {
  const [tabs, map] = await Promise.all([chrome.tabs.query({}), send({ type: 'session-urls' })]);
  openNow = new Map(tabs.filter((t) => /^https?:/i.test(t.url ?? '')).map((t) => [urlKey(t.url), t]));
  saved = map && typeof map === 'object' && map.ok !== false ? map : {};
}

function where(h) {
  const key = urlKey(h.url);
  const chips = [];
  const tab = openNow.get(key);
  if (tab) {
    const go = button('Open now', async () => {
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
    }, 'chip here');
    go.title = 'This page is open in a tab. Go to it.';
    chips.push(go);
  }
  const names = saved[key] ?? [];
  if (names.length) {
    chips.push(el('a', {
      className: 'chip', href: `sessions.html?q=${encodeURIComponent(h.url.replace(/#.*$/, ''))}`,
      textContent: names.length === 1 ? `In ${names[0]}` : `In ${names.length} sessions`,
      title: `Saved in: ${names.join(', ')}. Show where.`,
    }));
  }
  return chips;
}

// Remove has an Undo: the row goes at once, the page leaves the history only when the note goes (6 s),
// or when this page is left. A timer only while a removal waits.
const leaving = new Map(); // url -> timer
function forget(url) {
  clearTimeout(leaving.get(url));
  leaving.delete(url);
  return chrome.history.deleteUrl({ url });
}
function showToast(text, undo) {
  let t = $('toast');
  if (!t) document.body.append(t = el('div', { id: 'toast', className: 'toast', role: 'status' }));
  const b = el('button', { type: 'button', textContent: 'Undo' });
  b.addEventListener('click', () => { hideToast(); undo(); });
  t.replaceChildren(el('span', { textContent: text }), b);
  t.hidden = false;
  t.dataset.on = '';
}
function hideToast() {
  const t = $('toast');
  if (t) { delete t.dataset.on; t.hidden = true; }
}
function remove(h) {
  for (const url of leaving.keys()) forget(url); // one Undo at a time: an earlier one is done now
  leaving.set(h.url, setTimeout(() => { hideToast(); forget(h.url).then(read); }, 6000));
  showToast(`Removed ${h.title || siteLabel(h.url)} from history.`, () => {
    clearTimeout(leaving.get(h.url));
    leaving.delete(h.url);
    read();
  });
  read();
}
addEventListener('pagehide', () => { for (const url of [...leaving.keys()]) forget(url); });

function row(h) {
  const icon = guardIcon(el('img', { className: 'fav', alt: '', width: 16, height: 16, loading: 'lazy', src: chrome.runtime.getURL(`_favicon/?pageUrl=${encodeURIComponent(h.url)}&size=32`) }));
  const link = el('a', { className: 'tablink', href: h.url, textContent: h.title || h.url, title: h.url });
  // Shown on hover or keyboard focus.
  const open = button('New tab', () => chrome.tabs.create({ url: h.url, active: false }), 'quiet');
  open.title = 'Open in a new tab behind this one';
  open.setAttribute('aria-label', `Open ${h.title || h.url} in a new tab`);
  const gone = button('Remove', () => remove(h), 'danger');
  gone.title = 'Remove from history (Undo for a few seconds)';
  gone.setAttribute('aria-label', `Remove ${h.title || h.url} from history`);
  return el('li', {}, [
    el('span', { className: 'at num', textContent: new Date(h.lastVisitTime).toLocaleTimeString([], timeOptions(clock)) }),
    icon,
    el('span', { className: 'what' }, [link, el('span', { className: 'sub', textContent: siteLabel(h.url) })]),
    el('span', { className: 'where' }, where(h)),
    el('span', { className: 'acts' }, [open, gone]),
  ]);
}

async function read() {
  const mine = ++turn;
  const now = Date.now();
  const [startTime, endTime] = whenRange(when, now);
  let found;
  try {
    found = await chrome.history.search({ text: $('hq').value.trim(), startTime, endTime, maxResults: limit + 1 });
  } catch (e) {
    return say($('said'), 'bad', `History could not be read: ${String(e?.message ?? e)}`);
  }
  if (mine !== turn) return; // a later keystroke already answered
  say($('said'), '', '');
  const more = found.length > limit;
  const items = found.filter((h) => /^https?:/i.test(h.url) && !leaving.has(h.url)).sort((a, b) => b.lastVisitTime - a.lastVisitTime).slice(0, limit);
  // Empty: the line under the title stays quiet, and the box says why in one place: nothing searched
  // and any time means there is no history at all; otherwise the search or the time found nothing.
  const filtered = !!$('hq').value.trim() || when !== 'all';
  $('line').textContent = items.length ? `${items.length}${more ? ' or more' : ''} page${items.length === 1 ? '' : 's'}` : '';
  $('none').textContent = filtered ? 'Nothing here for that search and time.' : 'No history yet. Pages you visit show here.';
  $('none').hidden = items.length > 0;
  $('more').hidden = !more;
  $('days').replaceChildren(...groupByDay(items, (h) => h.lastVisitTime, now).map((g) =>
    el('section', {}, [el('h2', { textContent: g.label }), el('ul', { className: 'visits' }, g.items.map(row))])));
}

$('hq').addEventListener('input', () => {
  limit = STEP;
  read();
});
$('more').addEventListener('click', () => {
  limit += STEP;
  read();
});
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement !== $('hq')) {
    e.preventDefault();
    $('hq').focus();
  }
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) readWhere().then(read);
});

renderWhens();
readWhere().catch(() => {}).then(read);

// The command bar's window: type, arrows, Enter runs, Esc closes. Matching: ../commandbar.js.
import { suggest } from '../commandbar.js';

const under = Number(new URLSearchParams(location.search).get('w')) || null; // the window it was called from
const $ = (id) => document.getElementById(id);
const send = (msg) => new Promise((r) => chrome.runtime.sendMessage(msg, (a) => r(chrome.runtime.lastError ? null : a)));
let lines = [];
let at = 0;
let tabs = [];

const KIND = { action: 'Action', tab: 'Tab', go: 'Open', search: 'Search' };
const PAGE_FILE = { tabs: 'dashboard' };

function draw() {
  lines = suggest($('q').value, tabs);
  at = Math.min(at, Math.max(0, lines.length - 1));
  $('list').replaceChildren(...lines.map((l, i) => {
    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', String(i === at));
    const k = Object.assign(document.createElement('span'), { className: 'k', textContent: KIND[l.kind] });
    const t = Object.assign(document.createElement('span'), { className: 't', textContent: l.title });
    const n = Object.assign(document.createElement('span'), { className: 'n', textContent: l.kind === 'action' ? '' : l.note || '' });
    li.append(k, t, n);
    li.addEventListener('mousemove', () => { if (at !== i) { at = i; draw(); } });
    li.addEventListener('click', () => run(l));
    return li;
  }));
}

async function openUrl(url) {
  await chrome.tabs.create(under ? { windowId: under, url, active: true } : { url, active: true });
  if (under) await chrome.windows.update(under, { focused: true }).catch(() => {});
}

async function run(l) {
  if (!l) return;
  if (l.kind === 'tab') {
    await chrome.tabs.update(l.tabId, { active: true });
    await chrome.windows.update(l.windowId, { focused: true });
  } else if (l.kind === 'go') {
    await openUrl(l.url);
  } else if (l.kind === 'search') {
    await chrome.search.query({ text: l.query, disposition: 'NEW_TAB' });
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
    if (under && !d.private) await chrome.windows.update(under, { focused: true }).catch(() => {});
  }
  window.close();
}

$('q').addEventListener('input', () => { at = 0; draw(); });
$('q').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { at = Math.min(at + 1, lines.length - 1); draw(); e.preventDefault(); }
  else if (e.key === 'ArrowUp') { at = Math.max(at - 1, 0); draw(); e.preventDefault(); }
  else if (e.key === 'Enter') { run(lines[at]); e.preventDefault(); }
  else if (e.key === 'Escape') window.close();
});
// Gone when it loses the focus, like a menu.
addEventListener('blur', () => setTimeout(() => { if (!document.hasFocus()) window.close(); }, 150));

chrome.tabs.query({}).then((all) => {
  const me = chrome.runtime.getURL('ui/commandbar.html');
  tabs = all.filter((t) => !(t.url || '').startsWith(me)).map((t) => ({ id: t.id, windowId: t.windowId, title: t.title, url: t.url }));
  draw();
});
draw();
$('q').focus();

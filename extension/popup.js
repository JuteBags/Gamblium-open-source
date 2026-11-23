// The toolbar popup: find a tab and go to it, one button to give memory back,
// the switches for the site in front of you, and the way into the full pages.
// It reads once when opened and after each action; nothing runs on a timer.
import { DEFAULTS, describeTemp } from './rules.js';
import { $, send, el, openPage } from './ui/page.js';
import { showUpdateBanner } from './ui/update-banner.js';
import { zoomStep, zoomLabel, fmtMb, fmtDelay, countStates, stateShares, statesLine, cleanHost, parseHosts, hostListed, toggleHost, stateOf, filterTabs, siteLabel, markdownLink, secureChip, versionLabel } from './ui/pages-logic.js';

let current = null; // the tab the popup was opened on
let host = '';
let allTabs = [];
let at = 0; // which row of the list the arrow keys are on

// The row pointed at (or moved to with the arrows) lights its tab in the strip; the background
// holds the light and takes it off when the popup closes. Ctrl, Alt or the pointer leaving the
// list take it off at once.
const lightPort = chrome.runtime.connect({ name: 'tab-light' });
const lightTab = (id) => { try { lightPort.postMessage({ tabId: id || 0 }); } catch { /* popup closing */ } };

// The finder: this window's tabs first, the one in front left out. Type to
// narrow, arrow keys to move, Enter to go.
function shownTabs() {
  const rows = allTabs.filter((t) => !(t.active && t.windowId === current?.windowId));
  rows.sort((a, b) => (a.windowId === current?.windowId ? 0 : 1) - (b.windowId === current?.windowId ? 0 : 1) || (b.lastAccessed || 0) - (a.lastAccessed || 0));
  return filterTabs(rows, { query: $('find').value });
}

function renderList() {
  const rows = shownTabs();
  at = Math.min(at, Math.max(0, rows.length - 1));
  $('nomatch').hidden = rows.length > 0 || allTabs.length <= 1;
  $('tablist').replaceChildren(...rows.map((t, i) => {
    const icon = el('img', { className: 'fav', alt: '', width: 16, height: 16 });
    if (t.favIconUrl && /^(https?|data):/.test(t.favIconUrl)) icon.src = t.favIconUrl;
    else icon.style.visibility = 'hidden';
    icon.addEventListener('error', () => (icon.style.visibility = 'hidden'));
    const close = el('button', { type: 'button', className: 'quiet x', textContent: 'Close' });
    close.setAttribute('aria-label', `Close ${t.title || 'tab'}`);
    close.addEventListener('click', async (e) => {
      e.stopPropagation();
      await chrome.tabs.remove(t.id).catch(() => {});
      showTabs();
    });
    const li = el('li', { className: `state-${stateOf(t)}` }, [
      icon,
      el('span', { className: 'what' }, [el('span', { className: 't', textContent: t.title || t.url || 'Untitled' }), el('span', { className: 's', textContent: siteLabel(t.url || '') })]),
      el('span', { className: 'dot', title: stateOf(t) }),
      close,
    ]);
    li.dataset.tab = String(t.id);
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', String(i === at));
    li.addEventListener('click', () => goTo(t));
    li.addEventListener('mousemove', () => {
      if (at !== i) {
        at = i;
        for (const [k, node] of [...$('tablist').children].entries()) node.setAttribute('aria-selected', String(k === at));
      }
      lightTab(t.id);
    });
    return li;
  }));
}

async function goTo(t) {
  await chrome.tabs.update(t.id, { active: true }).catch(() => {});
  await chrome.windows.update(t.windowId, { focused: true }).catch(() => {});
  window.close();
}

async function showTabs() {
  const tabs = await chrome.tabs.query({});
  allTabs = tabs.map((t) => ({ ...t, state: stateOf(t) }));
  renderList();
  const c = countStates(tabs);
  $('count').textContent = `${c.total} tab${c.total === 1 ? '' : 's'}`;
  const shares = stateShares(c);
  for (const k of ['awake', 'frozen', 'asleep']) $('split').querySelector('.' + k).style.width = shares[k] + '%';
  $('split').setAttribute('aria-label', statesLine(c));
  $('legend').replaceChildren(...['awake', 'frozen', 'asleep'].map((k) => el('li', { className: k, textContent: `${c[k]} ${k}` })));
}

// The helper's totals when it is there; otherwise just the free memory.
async function showMemory() {
  const [stats, status] = await Promise.all([send({ type: 'tab-stats' }), send({ type: 'status' })]);
  const free = stats.ok ? stats.systemAvailableMb : status.availableMb;
  const parts = [];
  if (stats.ok) parts.push(`${fmtMb(stats.total.memoryMb)} used`);
  if (free !== null && free !== undefined) parts.push(`${fmtMb(free)} free`);
  $('memory').textContent = parts.join(' · ') || ' ';
  const s = status.settings;
  if (s) {
    $('enabled').checked = s.enabled;
    const short = status.delaySecNow < s.delaySec;
    $('enabledText').textContent = short
      ? `Put hidden tabs to sleep after ${fmtDelay(status.delaySecNow)} (memory is short)`
      : `Put hidden tabs to sleep after ${fmtDelay(s.delaySec)}`;
  }
}

async function showSite() {
  // popup.html?tab=<id> shows the popup for that tab: for when it is opened as
  // a page, where "the tab in front" would be the popup itself.
  const asked = Number(new URLSearchParams(location.search).get('tab'));
  if (asked) current = await chrome.tabs.get(asked).catch(() => null);
  else [current] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = current?.url || '';
  host = /^https?:/.test(url) ? cleanHost(url) : '';
  $('site').hidden = !host;
  showView('menu'); // always opens on Menu (owner, Nov 15 2026); This site is one click away
  $('securityLink').textContent = host ? `Security for ${host}` : 'Security';
  if (!host) return;
  $('siteHost').textContent = host;
  const chip = secureChip(url);
  $('secure').textContent = chip.text;
  $('secure').className = `pill ${chip.cls}`.trim();
  $('secure').title = chip.title ?? '';
  $('secure').hidden = !chip.text;
  $('siteIcon').src = `/_favicon/?pageUrl=${encodeURIComponent(url)}&size=32`;
  showSiteExtras();
  renderList(); // now that the tab in front is known, it leaves the list
  const { allowlist, lightSites } = await chrome.storage.local.get({ allowlist: DEFAULTS.allowlist, lightSites: [] });
  const awake = await send({ type: 'awake-get', tabId: current.id });
  $('awakeTab').checked = !!awake.tab;
  $('temp').value = awake.temp ?? 0;
  $('tempText').textContent = `In the background: ${describeTemp(awake.temp ?? 0)}`;
  $('neverSleep').checked = hostListed(allowlist, host);
  $('keepLight').checked = hostListed(lightSites, host);
  // The keep-light list only takes real site names, not "localhost" or an address.
  $('keepLightRow').hidden = parseHosts(host).hosts.length === 0;
}

// The three views. The finder takes the keyboard when the tabs view shows.
function showView(which) {
  const view = which === 'site' && !host ? 'menu' : which;
  $('viewMenu').hidden = view !== 'menu';
  $('viewBrowser').hidden = view !== 'browser';
  $('viewSite').hidden = view !== 'site';
  $('vMenu').setAttribute('aria-selected', String(view === 'menu'));
  $('vBrowser').setAttribute('aria-selected', String(view === 'browser'));
  $('vSite').setAttribute('aria-selected', String(view === 'site'));
  // Greyed, not disabled: a click on it says why, instead of doing nothing.
  $('vSite').setAttribute('aria-disabled', String(!host));
  $('vSite').title = host ? '' : 'Open a website to see its settings.';
  if (view === 'browser') $('find').focus();
}
$('vMenu').addEventListener('click', () => showView('menu'));
$('vSite').addEventListener('click', () => {
  if (!host) { $('menuSaid').textContent = 'Open a website to see its settings.'; return; }
  showView('site');
});
$('vBrowser').addEventListener('click', () => showView('browser'));
// Typing while the menu shows means "find a tab": the letter lands in the finder.
document.addEventListener('keydown', (e) => {
  if ($('viewMenu').hidden || e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1 || e.key === ' ') return;
  showView('browser');
});

// Bookmark state and the JavaScript switch for the page in front.
let markId = null;
async function showSiteExtras() {
  const marks = await chrome.bookmarks.search({ url: current.url }).catch(() => []);
  markId = marks[0]?.id ?? null;
  $('actMark').setAttribute('aria-pressed', String(!!markId));
  $('actMark').querySelector('span').textContent = markId ? 'Bookmarked' : 'Bookmark';
  try {
    const js = await chrome.contentSettings.javascript.get({ primaryUrl: current.url });
    $('jsOff').checked = js.setting === 'block';
  } catch {
    $('jsOffRow').hidden = true; // no permission yet, or an address this setting does not cover
  }
}
const siteSay = (text) => ($('siteSaid').textContent = text);
$('actMark').addEventListener('click', async () => {
  try {
    if (markId) await chrome.bookmarks.remove(markId);
    else await chrome.bookmarks.create({ title: current.title || host, url: current.url });
    siteSay(markId ? 'Bookmark removed.' : 'Bookmarked.');
  } catch (e) {
    siteSay(String(e?.message ?? e));
  }
  showSiteExtras();
});
// The same overlay as right-click > Screenshot: one engine, one look.
$('actShot').addEventListener('click', async () => {
  try {
    const ours = /^chrome:\/\/newtab\//.test(current.url || '') || (current.url || '').startsWith(chrome.runtime.getURL(''));
    if (ours) await chrome.tabs.sendMessage(current.id, { type: 'gamblium-shot-start' });
    else await chrome.scripting.executeScript({ target: { tabId: current.id }, files: ['content/shot.js'] });
    window.close();
  } catch (e) {
    siteSay(`No screenshot: ${String(e?.message ?? e)}`);
  }
});
for (const [id, text, done] of [['actCopy', () => current.url, 'Address copied.'], ['actMd', () => markdownLink(current.title, current.url), 'Copied as a Markdown link.']]) {
  $(id).addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(text());
      siteSay(done);
    } catch (e) {
      siteSay(`Could not copy: ${String(e?.message ?? e)}`);
    }
  });
}
$('jsOff').addEventListener('change', async () => {
  try {
    const u = new URL(current.url);
    await chrome.contentSettings.javascript.set({ primaryPattern: `${u.protocol}//${u.hostname}/*`, setting: $('jsOff').checked ? 'block' : 'allow' });
    await chrome.tabs.reload(current.id);
    siteSay($('jsOff').checked ? 'JavaScript is off on this site. The page was reloaded.' : 'JavaScript is on again. The page was reloaded.');
  } catch (e) {
    $('jsOff').checked = !$('jsOff').checked;
    siteSay(String(e?.message ?? e));
  }
});

async function showExtras() {
  const { profileLabel } = await chrome.storage.local.get({ profileLabel: '' });
  $('label').hidden = !profileLabel;
  $('label').textContent = profileLabel;
  const b = await send({ type: 'bridge-status' });
  // In the agent profile this is the point of the profile, so no warning there.
  $('agent').hidden = !(b.wanted && !b.agentBuild);
}

async function sleepNow(scope, done) {
  const win = await chrome.windows.getCurrent();
  const r = await send({ type: 'sleep-now', scope, windowId: win.id });
  $('said').textContent = r.ok === false ? r.error : r.slept ? `${r.slept} tab${r.slept === 1 ? '' : 's'} put to sleep.` : done;
  showTabs();
  showMemory();
}

// The menu: Brave's app menu item for item, in its order, then ours. Each entry does one thing and
// closes the popup; rows with a > open a flyout to the left on hover (the popup is anchored at its right
// edge, so it grows that way and the row under the pointer stays put). What an extension cannot do
// itself (the find bar, cut and paste in the page, developer tools) is a row that names its keys.
const web = () => /^https?:/i.test(current?.url ?? '');
const say = (text) => { $('menuSaid').textContent = text; };
const keysOnly = (keys) => () => { say(`Press ${keys} on the page.`); return 'stay'; };
const GO = {
  tab: () => chrome.tabs.create({}),
  window: () => chrome.windows.create({}),
  // A window in a session of its own (owner, Nov 15 2026: a normal new window shares every
  // sign-in, so it isolates nothing). Isolated: a new session with no sign-ins. Forked: a new
  // session with this browser's sign-ins and none of its tabs. Both get a made-up name, marked
  // as such; renaming one on the Sessions page keeps it.
  // Made by the background worker (session-new): the menu closes as soon as the new window takes
  // focus, which cut its later steps off and a second click made a second window.
  isolated: () => { send({ type: 'session-new', kind: 'isolated', name: autoName('Window') }); },
  forked: () => { send({ type: 'session-new', kind: 'forked', name: autoName('Fork') }); },
  private: () => chrome.windows.create({ incognito: true }),
  tor: async () => {
    const r = await send({ type: 'native', request: { type: 'open-tor' } });
    if (r && r.ok === false) throw new Error(r.error || 'The Gamblium helper is needed for a Tor window.');
  },
  // Profiles (owner, Nov 15 2026: "how do I see profiles?"): the browser's own pages, each profile
  // its own window with its own cookies, logins and history.
  profiles: () => chrome.tabs.create({ url: 'chrome://profile-picker/' }),
  // The picker's own "new profile" page is blank in a tab (it lives in the picker's window): its Add button works.
  profileNew: () => chrome.tabs.create({ url: 'chrome://profile-picker/' }),
  profileEdit: () => chrome.tabs.create({ url: 'chrome://settings/manageProfile' }),
  sidebar: () => chrome.tabs.create({ url: 'chrome://settings/appearance' }),
  passwords: () => chrome.tabs.create({ url: 'chrome://password-manager/passwords' }),
  payments: () => chrome.tabs.create({ url: 'chrome://settings/payments' }),
  addresses: () => chrome.tabs.create({ url: 'chrome://settings/addresses' }),
  history: () => openPage('ui/history.html'),
  bookmark: async () => {
    if (!web()) throw new Error('Only web pages can be bookmarked from here.');
    await chrome.bookmarks.create({ title: current.title || current.url, url: current.url });
    say('Bookmarked.');
    return 'stay';
  },
  bookmarks: () => chrome.tabs.create({ url: 'chrome://bookmarks/' }),
  downloads: () => openPage('ui/downloads.html'),
  extensions: () => chrome.tabs.create({ url: 'chrome://extensions/' }),
  store: () => chrome.tabs.create({ url: 'https://chromewebstore.google.com/' }),
  clear: () => chrome.tabs.create({ url: 'chrome://settings/clearBrowserData' }),
  print: async () => {
    if (!web()) throw new Error('This page cannot be printed from here. Press Ctrl+P.');
    await chrome.scripting.executeScript({ target: { tabId: current.id }, func: () => setTimeout(() => window.print(), 60) });
  },
  find: keysOnly('Ctrl+F'),
  cut: keysOnly('Ctrl+X'),
  copy: keysOnly('Ctrl+C'),
  paste: keysOnly('Ctrl+V'),
  save: async () => {
    if (!web()) throw new Error('This page cannot be saved from here. Press Ctrl+S.');
    await chrome.downloads.download({ url: current.url, saveAs: true });
  },
  link: async () => {
    await navigator.clipboard.writeText(current?.url ?? '');
    say('Link copied.');
    return 'stay';
  },
  markdown: async () => {
    await navigator.clipboard.writeText(markdownLink(current?.title, current?.url));
    say('Copied as a Markdown link.');
    return 'stay';
  },
  dashboard: () => openPage('ui/dashboard.html'),
  devtools: keysOnly('Ctrl+Shift+I'),
  sessions: () => openPage('ui/sessions.html'),
  security: () => openPage('ui/security.html'),
  ours: () => openPage('ui/settings.html'),
  about: () => chrome.tabs.create({ url: 'chrome://settings/help' }),
  shortcuts: () => openPage('ui/shortcuts.html'),
  settings: () => chrome.tabs.create({ url: 'chrome://settings/' }),
  exit: async () => {
    for (const w of await chrome.windows.getAll()) await chrome.windows.remove(w.id).catch(() => {});
  },
};
const ICON = {
  tab: 'M3 6.5A2.5 2.5 0 0 1 5.5 4h9A2.5 2.5 0 0 1 17 6.5v7a2.5 2.5 0 0 1-2.5 2.5h-9A2.5 2.5 0 0 1 3 13.5zM10 7.5v5M7.5 10h5',
  window: 'M3 6.5A2.5 2.5 0 0 1 5.5 4h9A2.5 2.5 0 0 1 17 6.5v7a2.5 2.5 0 0 1-2.5 2.5h-9A2.5 2.5 0 0 1 3 13.5zM3 8h14',
  isolated: 'M3 6.5A2.5 2.5 0 0 1 5.5 4h9A2.5 2.5 0 0 1 17 6.5v7a2.5 2.5 0 0 1-2.5 2.5h-9A2.5 2.5 0 0 1 3 13.5zM3 8h14M8 11.5h4M8 11.5v2.5h4v-2.5M8.8 11.5v-1a1.200 1.200 0 0 1 2.400 0v1',
  forked: 'M6 4.500a1.500 1.500 0 1 0 0 3 1.500 1.500 0 0 0 0-3zM6 7.500v8M14 6a1.500 1.500 0 1 0 0 3 1.500 1.500 0 0 0 0-3zM14 9c0 3-8 2-8 5',
  private: 'M3 9.5c2-1.2 4-1.2 5.5 0h3c1.5-1.2 3.5-1.2 5.5 0M8.8 12.3h2.4M5 7l1-3h8l1 3M4.2 12.5a2.3 2.3 0 1 0 4.6 0 2.3 2.3 0 1 0-4.6 0M11.2 12.5a2.3 2.3 0 1 0 4.6 0 2.3 2.3 0 1 0-4.6 0',
  tor: 'M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM10 5.5a4.5 4.5 0 1 0 0 9M10 8a2 2 0 1 0 0 4',
  sidebar: 'M3.5 4.5h13v11h-13zM8 4.5v11',
  profiles: 'M7.500 9a2.500 2.500 0 1 0 0-5 2.500 2.500 0 0 0 0 5zM3 16c0-2.500 2-4.500 4.500-4.500S12 13.500 12 16M13 4.300a2.500 2.500 0 0 1 0 4.400M14.500 11.800c1.500.600 2.500 2.100 2.500 4.200',
  passwords: 'M12.500 11.500a4 4 0 1 0-3.700-2.500L3.500 14.300V16.500h2.500v-1.700h1.700v-1.700h1.600l.900-.900a4 4 0 0 0 2.300-.700zM13.500 6.700v.010',
  history: 'M4 10a6 6 0 1 0 1.9-4.4M4 4.5v3h3M10 7v3.3l2.2 1.4',
  bookmarks: 'M6 3.5h8a1 1 0 0 1 1 1V17l-5-3.2L5 17V4.5a1 1 0 0 1 1-1z',
  downloads: 'M10 3.5v9M6.5 9.3 10 12.8l3.5-3.5M4 16.5h12',
  extensions: 'M8 4.5a2 2 0 1 1 4 0V6h3.5v3.5H14a2 2 0 1 0 0 4h1.5V17H12v-1.5a2 2 0 1 0-4 0V17H4.5V6H8z',
  clear: 'M4.500 6h11M8 6V4h4v2M6 6l.800 10.500h6.400L14 6M8.500 9v4.500M11.500 9v4.500',
  print: 'M6 7V3.500h8V7M6 14H4.500A1.500 1.500 0 0 1 3 12.500v-4A1.500 1.500 0 0 1 4.500 7h11A1.500 1.500 0 0 1 17 8.500v4a1.500 1.500 0 0 1-1.500 1.500H14M6 11.500h8v5H6z',
  find: 'M7.500 4h5M7.500 16h5M10 4v12M4 7.500v5M16 7.500v5',
  share: 'M10 3.500v9M6.500 7 10 3.500 13.500 7M5 10.500v5h10v-5',
  tools: 'M12.500 3.500a3.500 3.500 0 0 0-3.300 4.700L3.500 13.900 6.100 16.500l5.700-5.700a3.500 3.500 0 0 0 4.700-3.300l-2.200 2.200-2.200-.600-.600-2.200z',
  ours: 'M10 2.500 15.500 8 10 17.500 4.500 8zM4.500 8h11',
  help: 'M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM8 8a2 2 0 1 1 2.800 1.800c-.5.300-.8.700-.8 1.300v.4M10 14v.010',
  settings: 'M8.58 4.07L8.78 1.84L11.22 1.84L11.42 4.07A6.1 6.1 0 0 1 13.19 4.80L14.91 3.37L16.63 5.09L15.20 6.81A6.1 6.1 0 0 1 15.93 8.58L18.16 8.78L18.16 11.22L15.93 11.42A6.1 6.1 0 0 1 15.20 13.19L16.63 14.91L14.91 16.63L13.19 15.20A6.1 6.1 0 0 1 11.42 15.93L11.22 18.16L8.78 18.16L8.58 15.93A6.1 6.1 0 0 1 6.81 15.20L5.09 16.63L3.37 14.91L4.80 13.19A6.1 6.1 0 0 1 4.07 11.42L1.84 11.22L1.84 8.78L4.07 8.58A6.1 6.1 0 0 1 4.80 6.81L3.37 5.09L5.09 3.37L6.81 4.80A6.1 6.1 0 0 1 8.58 4.07ZM12.60 10.00A2.6 2.6 0 1 1 7.40 10.00A2.6 2.6 0 1 1 12.60 10.00Z',
  exit: 'M8 4H5.500A1.500 1.500 0 0 0 4 5.500v9A1.500 1.500 0 0 0 5.500 16H8M12 6.500 15.500 10 12 13.500M15.500 10H8',
  update: 'M10 15.500v-11M5.500 9 10 4.500 14.500 9',
};
// A row: [go, label, keys, icon?]. A flyout: { label, icon, sub: [rows] } (sub may be a function, read when it opens).
const MENU = [
  ['tab', 'New tab', 'Ctrl+T'], ['window', 'New window', 'Ctrl+N'], ['isolated', 'New session window', ''], ['forked', 'Forked session window', ''], ['private', 'New private window', 'Ctrl+Shift+N'], ['tor', 'New private window with Tor', 'Alt+Shift+N'],
  // Sessions replace Brave's profiles (owner, Nov 15 2026): each its own sign-ins, forked or cloned.
  { label: 'Sessions', icon: 'profiles', sub: sessionsSub },
  null,
  ['sidebar', 'Sidebar settings', ''],
  null,
  { label: 'Passwords and autofill', icon: 'passwords', sub: [['passwords', 'Passwords', ''], ['payments', 'Payment methods', ''], ['addresses', 'Addresses and more', '']] },
  { label: 'History', icon: 'history', sub: recentSub },
  { label: 'Bookmarks and lists', icon: 'bookmarks', sub: [['bookmark', 'Bookmark this tab', 'Ctrl+D'], ['bookmarks', 'Bookmark manager', 'Ctrl+Shift+O']] },
  ['downloads', 'Downloads', 'Ctrl+J'],
  { label: 'Extensions', icon: 'extensions', sub: [['extensions', 'Manage extensions', ''], ['store', 'Chrome Web Store', '']] },
  ['clear', 'Delete browsing data', 'Ctrl+Shift+Del'],
  null,
  'zoom',
  null,
  ['print', 'Print', 'Ctrl+P'],
  { label: 'Find and edit', icon: 'find', sub: [['find', 'Find…', 'Ctrl+F'], null, ['cut', 'Cut', 'Ctrl+X'], ['copy', 'Copy', 'Ctrl+C'], ['paste', 'Paste', 'Ctrl+V']] },
  { label: 'Save and share', icon: 'share', sub: [['save', 'Save page as…', 'Ctrl+S'], ['link', 'Copy link', ''], ['markdown', 'Copy as a Markdown link', '']] },
  { label: 'More tools', icon: 'tools', sub: [['dashboard', 'Tabs and memory', 'Shift+Esc'], ['clear', 'Delete browsing data', 'Ctrl+Shift+Del'], ['extensions', 'Extensions', ''], null, ['devtools', 'Developer tools', 'Ctrl+Shift+I']] },
  null,
  { label: 'Gamblium', icon: 'ours', sub: [['dashboard', 'Tabs and memory', ''], ['security', 'Security', ''], ['ours', 'Gamblium settings', '']] },
  { label: 'Help', icon: 'help', sub: [['about', 'About Gamblium', ''], ['shortcuts', 'Keyboard shortcuts', '']] },
  ['settings', 'Settings', ''],
  // Exit closes every window: it asks once, in place.
  ['exit', 'Exit', ''],
];
// A made-up session name: "Window 15 Nov 16.42.07".
function autoName(word) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${word} ${d.getDate()} ${d.toLocaleString('en', { month: 'short' })} ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`;
}

// Sessions' flyout: the page, then each named session (a green dot and its process id while it
// runs; a click shows it in a window), main ones first with their children under them.
async function sessionsSub() {
  const rows = [['sessions', 'Session manager', '']];
  // Both asked at once (one after the other made the flyout slow to open).
  const [r, ping] = await Promise.all([
    send({ type: 'native', request: { type: 'named-sessions', args: ['list'] } }).catch(() => null),
    send({ type: 'native', request: { type: 'ping' } }).catch(() => null),
  ]);
  const list = (r && r.ok !== false && Array.isArray(r.sessions)) ? r.sessions.filter((s) => !s.test && !s.temp) : [];
  const me = ping?.browserPid ?? null;
  const d = r && r.default;
  // The owner's own Gamblium (Personal) first, unless this is it (owner, Nov 16 2026: missing here).
  const own = d && !(me && d.pid === me) ? { go: () => send({ type: 'native', request: { type: 'start-main' } }), label: d.named ? d.name : 'Your Gamblium', keys: d.pid ? String(d.pid) : '', live: !!d.pid } : null;
  if (list.length || own) {
    rows.push(null);
    if (own) rows.push(own);
    const mains = list.filter((s) => s.kind !== 'child' || !list.some((p) => p.name === s.parent));
    for (const m of mains.slice(0, 8)) {
      for (const s of [m, ...list.filter((c) => c.kind === 'child' && c.parent === m.name)]) {
        rows.push({
          go: () => send({ type: 'native', request: { type: 'named-sessions', args: [s.pid && s.state === 'window' ? 'focus' : 'open', s.id ? `#${s.id}` : s.name] } }),
          label: s === m ? s.name : `  ↳ ${s.name}`,
          keys: s.pid ? String(s.pid) : '',
          live: !!s.pid,
        });
      }
    }
  }
  return rows;
}

// History's flyout: History, then the tabs closed last (the browser's own list), then Delete browsing data.
async function recentSub() {
  const rows = [['history', 'History', 'Ctrl+H']];
  const closed = await chrome.sessions.getRecentlyClosed({ maxResults: 6 }).catch(() => []);
  const tabs = closed.map((c) => c.tab).filter((t) => t && /^https?:/i.test(t.url ?? '')).slice(0, 5);
  if (tabs.length) {
    rows.push(null, { head: 'Recently closed' });
    for (const t of tabs) rows.push({ go: () => chrome.sessions.restore(t.sessionId), label: t.title || t.url, favicon: t.url });
  }
  rows.push(null, ['clear', 'Delete browsing data', 'Ctrl+Shift+Del']);
  return rows;
}
const NS = 'http://www.w3.org/2000/svg';
function icon(d) {
  const svg = document.createElementNS(NS, 'svg');
  for (const [k, v] of Object.entries({ width: 18, height: 18, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.4, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(k, v);
  if (d) {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
}
async function run(go, b) {
  if (go === 'exit' && !b.classList.contains('danger')) {
    // Closing every window is not undone by a click: ask once, in place.
    b.querySelector('span').textContent = 'Close every window?';
    b.classList.add('danger');
    return;
  }
  try {
    const r = await (typeof go === 'function' ? go() : GO[go]());
    if (r !== 'stay') window.close();
  } catch (e) {
    say(String(e?.message ?? e));
  }
}
function row(m, inFlyout = false) {
  if (!m) return el('hr', {});
  if (m.head) return el('p', { className: 'mhead', textContent: m.head });
  if (Array.isArray(m)) {
    const [go, label, keys] = m;
    const b = el('button', { type: 'button', role: 'menuitem', className: go === 'exit' ? 'mrow exit' : 'mrow' }, [icon(inFlyout ? '' : ICON[go]), el('span', { textContent: label }), el('kbd', { textContent: keys })]);
    b.dataset.go = go;
    b.addEventListener('click', () => run(go, b));
    return b;
  }
  if (m.go) {
    const img = m.favicon ? el('img', { className: 'fav', alt: '', width: 16, height: 16, src: chrome.runtime.getURL(`_favicon/?pageUrl=${encodeURIComponent(m.favicon)}&size=32`) }) : icon('');
    const keys = el('kbd', { className: m.live ? 'live' : '', textContent: m.keys || '' });
    if (m.live) keys.prepend(el('i', { className: 'dot', ariaHidden: 'true' }));
    const b = el('button', { type: 'button', role: 'menuitem', className: 'mrow' }, [img, el('span', { textContent: m.label }), keys]);
    b.addEventListener('click', () => run(m.go, b));
    return b;
  }
  // A row that opens a submenu: in place (a popup is one opaque window, so a flyout beside it would
  // widen it into a slab). Click, Enter or Right arrow; the submenu's header goes back.
  const b = el('button', { type: 'button', role: 'menuitem', className: 'mrow more', ariaHasPopup: 'menu' }, [icon(ICON[m.icon]), el('span', { textContent: m.label }), el('i', { className: 'chev', ariaHidden: 'true' })]);
  b.addEventListener('click', () => openSub(b, m));
  b.addEventListener('keydown', (e) => { if (e.key === 'ArrowRight') { e.preventDefault(); openSub(b, m); } });
  return b;
}
let subFrom = null; // the row the open submenu came from
async function openSub(b, m) {
  const items = typeof m.sub === 'function' ? await m.sub() : m.sub;
  subFrom = b;
  const back = el('button', { type: 'button', className: 'mrow subback', ariaLabel: `Back to the menu` }, [el('i', { className: 'chev back', ariaHidden: 'true' }), el('span', { textContent: m.label }), el('kbd', {})]);
  back.addEventListener('click', closeSub);
  const f = $('flyout');
  f.replaceChildren(back, el('hr', {}), ...items.map((x) => row(x, true)));
  f.setAttribute('aria-label', m.label);
  f.style.minHeight = `${$('menuRows').offsetHeight}px`; // the popup keeps its height: no jump
  $('menuRows').hidden = true;
  f.hidden = false;
  say('');
  f.querySelector('button.mrow:not(.subback)')?.focus();
}
function closeSub() {
  $('flyout').hidden = true;
  $('menuRows').hidden = false;
  subFrom?.focus();
  subFrom = null;
}
$('flyout').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft' || e.key === 'Escape' || e.key === 'Backspace') { e.preventDefault(); e.stopPropagation(); closeSub(); }
});
const zoomRow = document.querySelector('#viewMenu .zoom');
$('menuRows').replaceChildren(...MENU.map((m) => (m === 'zoom' ? zoomRow : row(m))));
// A downloaded update: a banner at the very top of the popup as soon as it opens (owner: people
// must see it); it replaces the line that used to head the Menu.
showUpdateBanner(document.body).catch(() => {});
// Arrow keys move through the rows.
$('viewMenu').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const list = e.target.closest('#flyout') ? $('flyout') : $('menuRows');
  const rows = [...list.querySelectorAll('button.mrow')];
  const i = rows.indexOf(document.activeElement);
  if (!rows.length) return;
  e.preventDefault();
  rows[(i + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length].focus();
});

// Zoom of the page in front: one step smaller or bigger, or back to 100%. The popup stays open.
async function showZoom() {
  const z = await chrome.tabs.getZoom().catch(() => 1);
  $('zoomNow').textContent = zoomLabel(z);
  return z;
}
async function zoomBy(dir) {
  const z = await showZoom();
  await chrome.tabs.setZoom(dir === 0 ? 1 : zoomStep(z, dir)).catch((e) => { $('menuSaid').textContent = String(e?.message ?? e); });
  showZoom();
}
$('zoomOut').addEventListener('click', () => zoomBy(-1));
$('zoomIn').addEventListener('click', () => zoomBy(1));
$('zoomNow').addEventListener('click', () => zoomBy(0));
$('fullScreen').addEventListener('click', async () => {
  const w = await chrome.windows.getCurrent();
  await chrome.windows.update(w.id, { state: w.state === 'fullscreen' ? 'normal' : 'fullscreen' }).catch(() => {});
  window.close();
});
showZoom();

$('tablist').addEventListener('pointerleave', () => lightTab(0));
addEventListener('keydown', (e) => { if (e.ctrlKey || e.metaKey || e.altKey || /^(Control|Meta|Alt)$/.test(e.key)) lightTab(0); }, true);
addEventListener('blur', () => lightTab(0));

$('find').addEventListener('input', () => {
  at = 0;
  renderList();
});
$('find').addEventListener('keydown', (e) => {
  const rows = shownTabs();
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    at = (at + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % Math.max(1, rows.length);
    renderList();
    $('tablist').children[at]?.scrollIntoView({ block: 'nearest' });
    lightTab(rows[at]?.id);
  } else if (e.key === 'Enter' && rows[at]) {
    e.preventDefault();
    goTo(rows[at]);
  }
});

$('thisWindow').addEventListener('click', () => sleepNow('this-window', 'Nothing to put to sleep in this window.'));
$('otherWindows').addEventListener('click', () => sleepNow('other-windows', 'No other window has tabs that can sleep.'));

$('enabled').addEventListener('change', () => chrome.storage.local.set({ enabled: $('enabled').checked }));

async function toggleList(key, box) {
  const stored = await chrome.storage.local.get({ [key]: [] });
  await chrome.storage.local.set({ [key]: toggleHost(stored[key], host, box.checked) });
}
// Awake = never frozen and never put to sleep: an ordinary background tab.
$('awakeTab').addEventListener('change', async () => {
  await send({ type: 'awake-set', tabId: current.id, tab: $('awakeTab').checked });
  siteSay($('awakeTab').checked ? 'This tab keeps running in the background.' : 'This tab freezes again when hidden.');
});
// 0 K is frozen solid, 273 K is never frozen; between, the site is woken on a schedule.
$('temp').addEventListener('input', () => {
  $('tempText').textContent = `In the background: ${describeTemp(Number($('temp').value))}`;
});
$('temp').addEventListener('change', async () => {
  await send({ type: 'awake-set', tabId: current.id, temp: Number($('temp').value) });
});
$('neverSleep').addEventListener('change', () => toggleList('allowlist', $('neverSleep')));
$('keepLight').addEventListener('change', async () => {
  await toggleList('lightSites', $('keepLight'));
  siteSay('Reload the page to see it change.');
});

for (const a of document.querySelectorAll('.links a')) {
  a.addEventListener('click', async (e) => {
    e.preventDefault();
    const page = a.dataset.page;
    const query = page === 'ui/security.html' && host ? '?' + new URLSearchParams({ url: current.url, tab: String(current.id), panel: '' }) : '';
    await openPage(page, query);
    window.close();
  });
}

showTabs();
showSite();
showMemory();
showExtras();

// ---- Spaces row (spaces.js): this window's spaces as chips; a click switches. ----------
const SPACE_INK = { grey: '#9DA1AA', blue: '#7EA6E0', red: '#E08A80', yellow: '#E2C26B', green: '#7FC79A', pink: '#E59BC4', purple: '#B49AE6', cyan: '#78C9D4', orange: '#E8A46A' };
async function paintSpaceRow() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const r = tab ? await send({ type: 'spaces-list', windowId: tab.windowId }) : null;
  const row = $('spaceRow');
  if (!r?.ok || !r.spaces.length) return void (row.hidden = true);
  $('spaceChips').replaceChildren(...r.spaces.map((s) => {
    const name = s.title || 'Untitled space';
    const b = el('button', { type: 'button', title: `${name}: ${s.tabs} tab${s.tabs === 1 ? '' : 's'}, ${s.frozen} frozen, ${s.asleep} asleep` }, [
      el('span', { className: 'swatch', style: `background:${SPACE_INK[s.color] ?? SPACE_INK.grey}` }),
      el('span', { textContent: name }),
      el('span', { className: 'n', textContent: String(s.tabs) }),
    ]);
    b.setAttribute('aria-pressed', String(s.active));
    b.addEventListener('click', async () => { await send({ type: 'space-switch', groupId: s.id }); window.close(); });
    return el('li', {}, b);
  }));
  // The space in view can move into a container of its own: its own cookies and logins, in its
  // own window (a named session).
  const here = r.spaces.find((s) => s.active);
  if (here) {
    const c = el('button', { type: 'button', className: 'containerbtn', textContent: 'Container', title: `Move "${here.title || 'Untitled space'}" into a container of its own: its own logins and cookies, in its own window` });
    c.addEventListener('click', async () => {
      c.disabled = true;
      c.textContent = 'Moving…';
      const a = await send({ type: 'space-container', groupId: here.id });
      c.textContent = a?.ok ? `Moved ${a.moved}` : 'Failed';
      c.title = a?.ok ? `In the container "${a.session}"` : (a?.error || 'Failed');
      if (a?.ok) setTimeout(() => window.close(), 900);
    });
    $('spaceChips').append(el('li', {}, c));
  }
  row.hidden = false;
}
paintSpaceRow();

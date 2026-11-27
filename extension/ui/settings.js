// Settings: sleeping tabs, appearance, proxy, agent control, profile label.
// Everything except the proxy is stored the moment it changes. No timers.
import { $, send, helper, el, say } from './page.js';
import { DEFAULTS, describeTemp } from '../rules.js';
import { OWN_DEFAULTS } from '../download-rules.js';
import { parseBangs, bangsText } from '../bangs.js';
import { LINK_SETS, LINK_DEFAULT, linkColours, shownAs } from '../darklinks.js';
import { clampInt, parseHosts, proxyLocked, bridgeLine, COLOUR_SETS, setColours, findMatches, splitTheme, permitStatus, permitShort, permitParts, versionLabel } from './pages-logic.js';
import { proxyLine } from './security-logic.js';

const store = async (values) => {
  await chrome.storage.local.set(values);
  $('saved').textContent = 'Saved.';
};

// ---- Sleeping tabs ----------------------------------------------------------------

async function loadSleep() {
  const s = { ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) };
  $('enabled').checked = s.enabled;
  $('delayMin').value = Math.max(1, Math.round(s.delaySec / 60));
  $('lowMb').value = s.lowMemoryMb;
  $('lowSec').value = s.lowMemoryDelaySec;
  $('allowlist').value = s.allowlist.join('\n');
}

$('enabled').addEventListener('change', () => store({ enabled: $('enabled').checked }));
$('delayMin').addEventListener('change', () => {
  const min = clampInt($('delayMin').value, 1, 1440, DEFAULTS.delaySec / 60);
  $('delayMin').value = min;
  store({ delaySec: min * 60 });
});
$('lowMb').addEventListener('change', () => {
  const mb = clampInt($('lowMb').value, 0, 65536, DEFAULTS.lowMemoryMb);
  $('lowMb').value = mb;
  store({ lowMemoryMb: mb });
});
$('lowSec').addEventListener('change', () => {
  const sec = clampInt($('lowSec').value, 30, 86400, DEFAULTS.lowMemoryDelaySec);
  $('lowSec').value = sec;
  store({ lowMemoryDelaySec: sec });
});

// A list of sites: what can be used is stored, what cannot is named under the box.
function hostList(id, key, hintText, options) {
  $(id).addEventListener('change', async () => {
    const { hosts, bad } = parseHosts($(id).value, options);
    await store({ [key]: hosts });
    $(id).value = hosts.join('\n');
    const hint = $(id + 'Hint');
    hint.textContent = bad.length ? `Left out, not a site name: ${bad.join(', ')}` : hintText;
    hint.style.color = bad.length ? 'var(--danger)' : '';
  });
}
hostList('allowlist', 'allowlist', $('allowlistHint').textContent, { allowLocal: true });
hostList('awakeHosts', 'awakeHosts', $('awakeHostsHint').textContent, { allowLocal: true });
hostList('wakeHosts', 'wakeHosts', $('wakeHostsHint').textContent);

// ---- Freezing tabs ----------------------------------------------------------------

const ALL_SITES = { origins: ['<all_urls>'] };

async function loadFreeze() {
  const s = { ...DEFAULTS, protectUploads: false, launchFreeze: null, ...(await chrome.storage.local.get({ ...DEFAULTS, protectUploads: false, launchFreeze: null })) };
  $('freezeEnabled').checked = s.freezeEnabled;
  $('freezeSec').value = s.freezeDelaySec;
  $('defaultTemp').value = s.defaultTemp;
  $('defaultTempText').textContent = describeTemp(s.defaultTemp);
  $('awakeHosts').value = s.awakeHosts.join('\n');
  $('wakeHosts').value = s.wakeHosts.join('\n');
  $('wakeMin').value = s.wakeEveryMin;
  $('protectUploads').checked = s.protectUploads && (await chrome.permissions.contains(ALL_SITES));
  $('freezeNote').hidden = s.launchFreeze === true;
}

$('freezeEnabled').addEventListener('change', () => store({ freezeEnabled: $('freezeEnabled').checked }));
$('freezeSec').addEventListener('change', () => {
  const sec = clampInt($('freezeSec').value, 10, 3600, DEFAULTS.freezeDelaySec);
  $('freezeSec').value = sec;
  store({ freezeDelaySec: sec });
});
$('defaultTemp').addEventListener('input', () => ($('defaultTempText').textContent = describeTemp(Number($('defaultTemp').value))));
$('defaultTemp').addEventListener('change', () => store({ defaultTemp: Number($('defaultTemp').value) }));
$('wakeMin').addEventListener('change', () => {
  const min = clampInt($('wakeMin').value, 1, 120, DEFAULTS.wakeEveryMin);
  $('wakeMin').value = min;
  store({ wakeEveryMin: min });
});
// The browser only shows its permission question in answer to a click.
$('protectUploads').addEventListener('change', async () => {
  if ($('protectUploads').checked) {
    const granted = await chrome.permissions.request(ALL_SITES).catch(() => false);
    $('protectUploads').checked = granted;
    await store({ protectUploads: granted });
  } else {
    await store({ protectUploads: false });
    const cap = await send({ type: 'capture-status' });
    if (!cap.on) await chrome.permissions.remove(ALL_SITES).catch(() => {});
  }
});
hostList('lightSites', 'lightSites', $('lightSitesHint').textContent);

// ---- Appearance -------------------------------------------------------------------

async function loadLook() {
  let scheme = 'moon';
  try {
    scheme = localStorage.getItem('gamblium.scheme') || 'moon';
  } catch {
    // Storage is blocked; the default scheme shows.
  }
  for (const r of document.querySelectorAll('input[name="scheme"]')) r.checked = r.value === scheme;
  const { lightSites } = await chrome.storage.local.get({ lightSites: [] });
  $('lightSites').value = lightSites.join('\n');
}

for (const r of document.querySelectorAll('input[name="scheme"]')) {
  r.addEventListener('change', () => {
    if (!r.checked) return;
    try {
      localStorage.setItem('gamblium.scheme', r.value);
    } catch {
      // Still applied to this page below.
    }
    document.documentElement.dataset.scheme = r.value;
    store({ scheme: r.value });
    sendTheme(); // the window's frame follows at the next start
  });
}

// ---- Light, dark, auto ------------------------------------------------------------

let mode = 'dark';
let themes = [];
const chosenScheme = () => document.querySelector('input[name="scheme"]:checked')?.value ?? 'moon';
function paintModes() {
  for (const b of document.querySelectorAll('#modes button')) {
    b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
    b.disabled = themes.length > 0 && !themes.includes(`${chosenScheme()}-${b.dataset.mode}`);
    b.title = b.disabled ? 'This Gamblium does not have that choice yet.' : '';
  }
}
async function sendTheme() {
  if ($('modeField').hidden) return; // no helper: only our own pages change
  const r = await helper({ type: 'brand-set', theme: `${chosenScheme()}-${mode}` });
  $('saved').textContent = r.ok === false ? r.error : 'Saved. The window follows the next time Gamblium starts.';
  paintModes();
}
for (const b of document.querySelectorAll('#modes button')) {
  b.addEventListener('click', () => {
    mode = b.dataset.mode;
    paintModes();
    sendTheme();
    if (preset) applySet(); // a colour set has a light and a dark pair
  });
}
$('restartNow').addEventListener('click', async () => {
  const r = await helper({ type: 'restart' });
  if (r.ok === false) $('saved').textContent = 'Gamblium could not restart itself. Close it and open it again.';
});
for (const b of document.querySelectorAll('#engine button')) b.addEventListener('click', () => chrome.tabs.create({ url: b.dataset.open.startsWith('ui/') ? chrome.runtime.getURL(b.dataset.open) : b.dataset.open }));

// ---- Name and logo ----------------------------------------------------------------

async function loadBrand() {
  const b = await helper({ type: 'brand-get' });
  if (b.ok === false) return; // an older helper, or none: nothing to offer
  $('brandField').hidden = false;
  // Light, dark or auto: what the browser starts with. Auto needs its preset to exist.
  themes = b.themes ?? [];
  mode = splitTheme(b.theme)[1];
  $('modeField').hidden = false;
  paintModes();
  if (typeof b.darkPages === 'boolean') {
    $('darkPagesField').hidden = false;
    $('darkPages').checked = b.darkPages;
  }
  $('brandOfficial').checked = b.official || b.copy !== 'fresh';
  $('brandOfficial').disabled = b.copy === 'none';
  if (b.copy === 'none') $('brandHint').textContent = 'There is no rebranded copy on this computer. Make one with: gamblium rebrand';
  if (b.copy === 'stale') $('brandHint').textContent = 'Brave has been updated, so the rebranded copy is out of date and Brave\'s own look is showing. Refresh it with: gamblium rebrand';
  // Changes the last rebrand could not make on this Brave build (review 2, 5.2).
  if (b.copy === 'fresh' && Array.isArray(b.incomplete) && b.incomplete.length) $('brandHint').textContent = `On this Brave version the rebrand could not make every change: ${b.incomplete.join('; ')}. Brave's own look shows there.`;
}

$('darkPages').addEventListener('change', async () => {
  const r = await helper({ type: 'brand-set', darkPages: $('darkPages').checked });
  $('saved').textContent = r.ok === false ? r.error : 'Saved. It shows the next time Gamblium starts.';
});

$('brandOfficial').addEventListener('change', async () => {
  const r = await helper({ type: 'brand-set', official: $('brandOfficial').checked });
  $('saved').textContent = r.ok === false ? r.error : 'Saved. It shows the next time Gamblium starts.';
});

// ---- Proxy ------------------------------------------------------------------------

function showProxy(p) {
  lastProxy = p;
  $('proxyNow').textContent = proxyLine(p);
  const locked = proxyLocked(p);
  for (const c of $('proxyForm').querySelectorAll('input, select, button')) c.disabled = !!locked;
  say($('proxyError'), 'bad', locked || '');
  if (!p || p.ok === false) return;
  const mode = p.mode === 'fixed' || p.mode === 'direct' ? p.mode : 'system';
  for (const r of document.querySelectorAll('input[name="mode"]')) r.checked = r.value === mode;
  if (p.mode === 'fixed') {
    $('pScheme').value = p.scheme;
    $('pHost').value = p.host;
    $('pPort').value = p.port;
    $('pBypass').value = (p.bypass || []).join(', ');
  }
  syncProxyFields();
  $('proxyForm').querySelector('button[type=submit]').disabled = true; // nothing changed yet
}

function syncProxyFields() {
  const fixed = new FormData($('proxyForm')).get('mode') === 'fixed';
  $('proxyServer').hidden = !fixed;
}
for (const r of document.querySelectorAll('input[name="mode"]')) r.addEventListener('change', syncProxyFields);
for (const ev of ['input', 'change']) $('proxyForm').addEventListener(ev, () => { if (!proxyLocked(lastProxy)) $('proxyForm').querySelector('button[type=submit]').disabled = false; });
let lastProxy = null;

$('proxyForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const mode = new FormData($('proxyForm')).get('mode');
  const proxy = mode === 'fixed'
    ? { mode, scheme: $('pScheme').value, host: $('pHost').value, port: $('pPort').value, bypass: $('pBypass').value.split(/[\s,]+/).filter(Boolean) }
    : { mode };
  const r = await send({ type: 'proxy-set', proxy });
  if (r.ok === false) return say($('proxyError'), 'bad', r.error);
  showProxy(r);
  $('saved').textContent = 'Proxy applied.';
});

// ---- Agent control ----------------------------------------------------------------

async function showBridge() {
  const b = await send({ type: 'bridge-status' });
  $('bridge').checked = !!b.wanted;
  const line = bridgeLine(b);
  const extra = b.agentBuild ? ' This is the agent profile, where it is on by default.' : '';
  // Plain status with a dot, not a box that looks like a button.
  $('bridgeNow').className = `statusline ${line.cls}`.trim();
  $('bridgeNow').textContent = line.text + extra;
  $('bridgeNow').hidden = !(line.text + extra);
  // The permission only matters while agents can reach this profile.
  const off = !b.wanted;
  $('permitField').classList.toggle('dim', off);
  for (const x of $('permitChoices').querySelectorAll('button')) x.disabled = off;
  $('permitOff').hidden = !off;
  $('permitNow').hidden = off; // while off, only the reason
}

$('bridge').addEventListener('change', async () => {
  await send({ type: 'bridge-set', on: $('bridge').checked });
  $('saved').textContent = 'Saved.';
  // The helper takes a moment to start or stop listening.
  setTimeout(showBridge, 1200);
});

// ---- This profile -----------------------------------------------------------------

async function loadProfile() {
  const { profileLabel } = await chrome.storage.local.get({ profileLabel: '' });
  $('profileLabel').value = profileLabel;
  const ping = await helper({ type: 'ping' });
  const m = chrome.runtime.getManifest();
  // The user-agent string says "157.0.0.0" on purpose (reduced); the brand list has the real major version.
  const chromium = (navigator.userAgentData?.brands ?? []).find((x) => x.brand === 'Chromium')?.version;
  const brave = ping.ok === false ? '' : ping.braveVersion || '';
  // "1.0.0 beta 2" (version_name) where there is one; the helper says "1.0.0-beta.2" for the same build.
  const shown = m.version_name || m.version;
  const sameBuild = (h) => versionLabel(h) === shown || h === m.version;
  const rows = [['Version', `${shown} on Brave${brave ? ' ' + brave : ''}${chromium ? ` (Chromium ${chromium})` : ''}`]];
  if (ping.ok === false) rows.push(['Helper', 'not reachable; run "gamblium install-host"']);
  else {
    if (!sameBuild(ping.version)) rows.push(['Helper', ping.version]); // only worth a line when it differs
    const folder = ping.userDataDir || '';
    const copy = el('button', { type: 'button', className: 'quiet copybtn', textContent: 'Copy path' });
    copy.addEventListener('click', async () => {
      await navigator.clipboard.writeText(folder).catch(() => {});
      copy.textContent = 'Copied';
      setTimeout(() => { copy.textContent = 'Copy path'; }, 1500);
    });
    // The helper opens its own browser's profile folder; the page passes no path.
    const open = el('button', { type: 'button', className: 'quiet copybtn', textContent: 'Open folder' });
    open.addEventListener('click', async () => {
      const r = await helper({ type: 'open-folder' });
      if (r.ok === false) $('saved').textContent = r.error || 'The folder could not be opened.';
    });
    rows.push(['Profile folder', folder ? [el('span', { className: 'mono path', textContent: folder }), open, copy] : "Brave's default folder"]);
  }
  if (ping.ok !== false) rows.splice(1, 0, ['Updates', updatesCell()]);
  // Version, updates and the helper in the Gamblium section; this profile keeps its folder.
  const kv = (list) => list.flatMap(([k, v]) => [el('dt', { textContent: k }), el('dd', {}, v)]);
  $('version').replaceChildren(...kv(rows.filter(([k]) => k !== 'Profile folder')));
  $('about').replaceChildren(...kv(rows.filter(([k]) => k === 'Profile folder')));
  showUpdate(await send({ type: 'update-state' }).catch(() => null));
}

// ---- Updates: where things stand, Check for updates, and Restart when one is ready ----
function updatesCell() {
  const check = el('button', { type: 'button', id: 'updCheck', textContent: 'Check for updates' });
  check.addEventListener('click', checkUpdates);
  const restart = el('button', { type: 'button', className: 'good', id: 'updRestart', textContent: 'Restart to update', hidden: true });
  restart.addEventListener('click', async () => {
    if (restart.dataset.sure !== '1') {
      restart.dataset.sure = '1';
      restart.textContent = 'Close every window and update? Your tabs come back.';
      return;
    }
    const r = await send({ type: 'update-restart' });
    if (!r || r.ok === false) $('updState').textContent = r?.error || 'The update could not start.';
  });
  return el('span', { className: 'updrow' }, [el('span', { id: 'updState', textContent: '…' }), check, restart]);
}
const BUSY = new Set(['checking', 'downloading', 'busy', 'installing']);
function updateLine(u) {
  if (!u || u.ok === false) return 'The helper does not answer.';
  const st = u.update || {};
  if (u.ready) return `${versionLabel(st.version)} is ready`;
  return st.state === 'checking' || st.state === 'busy' ? 'Checking…'
    : st.state === 'downloading' ? `Downloading ${versionLabel(st.version)}…`
    : st.state === 'installing' ? 'Installing…'
    : st.state === 'up-to-date' ? 'Up to date'
    : st.state === 'error' ? `Could not check: ${st.error || 'unknown error'}`
    : 'Not checked yet';
}
function showUpdate(u) {
  if (!$('updState')) return;
  $('updState').textContent = updateLine(u);
  $('updRestart').hidden = !u?.ready;
  $('updCheck').hidden = !!u?.ready;
}
// The check runs in its own process: ask where it stands every 2 s, for a minute at most.
async function checkUpdates() {
  $('updCheck').disabled = true;
  $('updState').textContent = 'Checking…';
  const since = Math.floor(Date.now() / 1000) - 1;
  await send({ type: 'update-check' }).catch(() => null);
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const u = await send({ type: 'update-state' }).catch(() => null);
    const st = u?.update || {};
    const fresh = (st.at || 0) >= since;
    if (fresh || u?.ready) showUpdate(u);
    if (u?.ready || (fresh && !BUSY.has(st.state))) break;
  }
  $('updCheck').disabled = false;
}
chrome.storage.local.get({ autoUpdate: true }).then(({ autoUpdate }) => ($('autoUpdate').checked = autoUpdate));
$('autoUpdate').addEventListener('change', () => store({ autoUpdate: $('autoUpdate').checked }));

$('profileLabel').addEventListener('change', () => store({ profileLabel: $('profileLabel').value.trim().slice(0, 40) }));

loadSleep();
loadBrand();
loadFreeze();

// ---- Tab groups: fold the others (the background does the folding) ----
chrome.storage.local.get({ foldGroups: true }).then(({ foldGroups }) => ($('foldGroups').checked = foldGroups));
$('foldGroups').addEventListener('change', () => store({ foldGroups: $('foldGroups').checked }));
loadLook();
send({ type: 'proxy-get' }).then(showProxy);
showBridge();
loadProfile();

// ---- Gamblium's downloader ---------------------------------------------------------

async function loadOwn() {
  const own = { ...OWN_DEFAULTS, ...(await chrome.storage.local.get(OWN_DEFAULTS)) };
  const mode = own.ownDownloader === 'off' ? 'off' : 'always';
  for (const r of document.querySelectorAll('input[name="ownDownloader"]')) r.checked = r.value === mode;
  $('ownTorrents').checked = own.ownTorrents;
  $('seedMinutes').value = own.seedMinutes;
  $('seedMinutes').disabled = !own.ownTorrents;
}
for (const r of document.querySelectorAll('input[name="ownDownloader"]')) {
  r.addEventListener('change', async () => {
    if (!r.checked) return;
    await store({ ownDownloader: r.value });
  });
}
$('ownTorrents').addEventListener('change', async () => {
  await store({ ownTorrents: $('ownTorrents').checked });
  $('seedMinutes').disabled = !$('ownTorrents').checked;
});
$('seedMinutes').addEventListener('change', () => {
  const min = clampInt($('seedMinutes').value, 0, 10080, OWN_DEFAULTS.seedMinutes);
  $('seedMinutes').value = min;
  store({ seedMinutes: min });
});
loadOwn();
// The folder and the two questions are the browser's own; its page is no longer in its menu, this is the way in.
$('saveFolder').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://settings/downloads' }));

// ---- Agents changing settings: the permission, and taking it back ----------------------

// The same row for agents in the person's own windows (review 8, F6), ids prefixed "person".
async function loadPermit(view, what = 'settings') {
  const ids = what === 'person' ? { field: 'personField', choices: 'personChoices', now: 'personNow' } : { field: 'permitField', choices: 'permitChoices', now: 'permitNow' };
  const thing = what === 'person' ? 'work in your own session windows' : 'change settings';
  const v = view ?? (await send({ type: 'native', request: { type: 'permit-get', what } }));
  $(ids.field).hidden = !(v && v.ok);
  if (!v || !v.ok) return;
  const p = permitParts(v, Date.now());
  const label = (m) => (m === 0 ? 'Ask each time' : m === -1 ? 'Always' : permitShort(m));
  $(ids.choices).replaceChildren(...(v.choices ?? [0, 30, 60, 120, 360, -1]).map((minutes) => {
    const b = el('button', { type: 'button', textContent: label(minutes) });
    b.setAttribute('aria-pressed', String(p.choice === minutes));
    b.addEventListener('click', async () => {
      const r = await send({ type: 'native', request: { type: 'permit-set', what, minutes } });
      document.activeElement?.blur();
      if (r && r.ok) loadPermit(r, what);
      else $(ids.now).textContent = r?.error || 'That could not be changed.';
    });
    return b;
  }));
  $(ids.now).textContent = p.state === 'allowed' ? `${permitStatus(v, Date.now(), thing)} Until ${p.until}.` : permitStatus(v, Date.now(), thing);
  if (what === 'settings' && !$('bridge').checked) for (const x of $(ids.choices).querySelectorAll('button')) x.disabled = true;
}
loadPermit();
loadPermit(undefined, 'person');

// ---- Copy buttons beside commands ----------------------------------------------------
for (const b of document.querySelectorAll('[data-copy]')) {
  b.addEventListener('click', async () => {
    await navigator.clipboard.writeText($(b.dataset.copy).textContent.trim()).catch(() => {});
    b.textContent = 'Copied';
    setTimeout(() => { b.textContent = 'Copy'; }, 1500);
  });
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { loadPermit(); loadPermit(undefined, 'person'); }
});

// ---- One view per area -------------------------------------------------------------
// The address picks the area (settings.html#network). "#all" shows every area on
// one page, which is what the tests and a search of the page (Ctrl+F) want.
const AREAS = ['tabs', 'look', 'downloads', 'network', 'agents', 'gamblium', 'profile', 'browser', 'bring'];
let bringShown = false;
function showArea() {
  const asked = location.hash.slice(1);
  // #lyrics: the lyrics window's gear opens the Look area at its section.
  const area = asked === 'all' ? 'all' : asked === 'lyrics' ? 'look' : AREAS.includes(asked) ? asked : 'tabs';
  if (asked === 'lyrics') setTimeout(() => $('lyrics-title') && $('lyrics-title').scrollIntoView({ block: 'start' }), 50);
  // The other browsers are looked at only when this area is opened.
  if (area === 'bring' && !bringShown) {
    bringShown = true;
    import('./bring.js').then((m) => m.renderBring($('bringBox')));
  }
  for (const sec of document.querySelectorAll('.area > section[data-area]')) sec.hidden = area !== 'all' && sec.dataset.area !== area;
  for (const a of document.querySelectorAll('.areas a')) {
    if (a.dataset.area === area) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
}
addEventListener('hashchange', showArea);
showArea();

// ---- Find in Settings ---------------------------------------------------------------
// Typing shows every area at once and leaves only the settings that hold the words.
function applyFind() {
  const query = $('find').value.trim();
  for (const f of document.querySelectorAll('.area .field')) f.classList.remove('nomatch');
  $('nofind').hidden = true;
  document.querySelector('.settings').classList.toggle('finding', !!query);
  if (!query) return showArea();
  let any = false;
  for (const sec of document.querySelectorAll('.area > section[data-area]')) {
    const title = sec.querySelector('h2')?.textContent ?? '';
    const fields = [...sec.querySelectorAll('.field')];
    let shown = 0;
    for (const f of fields) {
      const hit = findMatches(`${title} ${f.textContent} ${[...f.querySelectorAll('[placeholder]')].map((i) => i.placeholder).join(' ')}`, query);
      f.classList.toggle('nomatch', !hit);
      if (hit) shown += 1;
    }
    sec.hidden = fields.length ? shown === 0 : !findMatches(sec.textContent, query);
    any ||= !sec.hidden;
  }
  $('nofind').hidden = any;
}
$('find').addEventListener('input', applyFind);
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? '')) {
    e.preventDefault();
    $('find').focus();
  }
});

// ---- Your own colours ---------------------------------------------------------------
// Stored as {accent, bg}; either may be missing. Applied at once here and picked
// up by every other page of ours when it next opens (ui/scheme.js, ui/page.js).
async function ownColours(change) {
  const { colours } = await chrome.storage.local.get({ colours: null });
  const next = change === null ? null : { ...(colours || {}), ...change };
  await chrome.storage.local.set({ colours: next });
  try {
    if (next) localStorage.setItem('gamblium.colours', JSON.stringify(next));
    else localStorage.removeItem('gamblium.colours');
  } catch {
    // Storage is blocked; the colours still apply to this page.
  }
  globalThis.gambliumColours?.(next);
}
chrome.storage.local.get({ colours: null }).then(({ colours }) => {
  if (colours?.accent) $('ownAccent').value = colours.accent;
  if (colours?.bg) $('ownBg').value = colours.bg;
});
// A colour picked by hand, or "back to the theme", ends any colour set.
const leaveSet = () => {
  preset = null;
  chrome.storage.local.set({ colourSet: null });
  paintSets();
};
$('ownAccent').addEventListener('input', () => (leaveSet(), ownColours({ accent: $('ownAccent').value })));
$('ownBg').addEventListener('input', () => (leaveSet(), ownColours({ bg: $('ownBg').value })));
$('ownReset').addEventListener('click', () => (leaveSet(), ownColours(null)));

// ---- Colour sets ---------------------------------------------------------------------
// A named pair of accent and background, with a strength. Which pair (dark or
// light) follows the look chosen above, or the system when that is not known.
let preset = null; // { id, sat } while a set is on
const lookNow = () => {
  if (!$('modeField').hidden && mode !== 'auto') return mode;
  return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
};
function paintSets() {
  const look = lookNow();
  $('presets').replaceChildren(...COLOUR_SETS.map((s) => {
    const c = setColours(s.id, look, 100);
    const b = el('button', { type: 'button', className: 'set' }, [el('i', { style: `background: linear-gradient(135deg, ${c.bg} 0 50%, ${c.accent} 50% 100%)` }), s.name]);
    b.setAttribute('aria-pressed', String(preset?.id === s.id));
    b.addEventListener('click', () => {
      preset = { id: s.id, sat: preset?.sat ?? 100 };
      applySet();
    });
    return b;
  }));
  $('sat').disabled = !preset;
  $('sat').value = String(preset?.sat ?? 100);
  $('satText').textContent = preset ? `Colour strength: ${preset.sat}%` : 'Colour strength (pick a set first)';
}
async function applySet() {
  const c = setColours(preset.id, lookNow(), preset.sat);
  $('ownAccent').value = c.accent;
  $('ownBg').value = c.bg;
  await ownColours(c);
  await chrome.storage.local.set({ colourSet: preset });
  paintSets();
}
$('sat').addEventListener('input', () => {
  if (!preset) return;
  preset.sat = Number($('sat').value);
  applySet();
});
chrome.storage.local.get({ colourSet: null }).then(({ colourSet }) => {
  if (colourSet && COLOUR_SETS.some((s) => s.id === colourSet.id)) preset = { id: colourSet.id, sat: Number(colourSet.sat) || 100 };
  paintSets();
});

// ---- Links on darkened websites (../darklinks.js) ---------------------------------------
// Stored as darkLinks: { set } or { set: 'own', link, visited }. Cyan unless changed.
let darkLinks = { set: LINK_DEFAULT };
function paintLinks() {
  const shown = linkColours(darkLinks);
  $('linkSets').replaceChildren(...LINK_SETS.map((s) => {
    const dot = s.link ? `background: ${s.link}` : 'background: linear-gradient(135deg, #1a0dab 0 50%, #f5bdff 50% 100%)';
    const b = el('button', { type: 'button', className: 'set link' }, [el('i', { style: dot }), s.name]);
    b.setAttribute('aria-pressed', String(darkLinks.set === s.id));
    b.addEventListener('click', () => saveLinks({ set: s.id }));
    return b;
  }));
  if (shown) {
    $('ownLink').value = shown.link;
    $('ownVisited').value = shown.visited;
  }
  $('ownLink').disabled = $('ownVisited').disabled = !shown;
  $('linkDemo').hidden = !shown;
  if (shown) {
    // What darkening really gives (a very light, vivid colour cannot be had exactly).
    $('demoLink').style.color = shownAs(shown.link);
    $('demoVisited').style.color = shownAs(shown.visited);
  }
}
async function saveLinks(next) {
  darkLinks = next;
  await store({ darkLinks: next });
  paintLinks();
}
const ownLinks = () => saveLinks({ set: 'own', link: $('ownLink').value, visited: $('ownVisited').value });
$('ownLink').addEventListener('input', ownLinks);
$('ownVisited').addEventListener('input', ownLinks);
chrome.storage.local.get({ darkLinks: null }).then(({ darkLinks: d }) => {
  if (d && typeof d === 'object') darkLinks = d;
  paintLinks();
});

// Our own right-click menu on websites: on unless switched off here.
chrome.storage.local.get({ ownRightClick: true }).then(({ ownRightClick }) => { $('ownRightClick').checked = ownRightClick; });
$('ownRightClick').addEventListener('change', () => chrome.storage.local.set({ ownRightClick: $('ownRightClick').checked }));

// ---- !bangs ---------------------------------------------------------------------------
(async () => {
  const { bangsOn = true, ownBangs = {} } = await chrome.storage.local.get({ bangsOn: true, ownBangs: {} });
  $('bangsOn').checked = bangsOn;
  $('ownBangs').value = bangsText(ownBangs);
})();
$('bangsOn').addEventListener('change', () => chrome.storage.local.set({ bangsOn: $('bangsOn').checked }));
$('ownBangs').addEventListener('change', () => {
  const own = parseBangs($('ownBangs').value);
  chrome.storage.local.set({ ownBangs: own });
  $('ownBangs').value = bangsText(own); // lines that were not a bang drop out, so it is visible
});

// ---- Logins agents may use (the helper keeps them sealed; logins.rs) --------------------
async function loginsDraw(r) {
  r = r || (await helper({ type: 'login-list' }));
  const list = $('loginList');
  if (!r || r.ok === false) {
    list.replaceChildren(el('li', { className: 'hint', textContent: (r && r.error) || 'The helper did not answer.' }));
    return;
  }
  list.replaceChildren(...(r.logins.length ? r.logins.map((l) => {
    const rm = el('button', { type: 'button', className: 'quiet', textContent: 'Remove' });
    rm.addEventListener('click', async () => loginsDraw(await helper({ type: 'login-remove', site: l.site, username: l.username })));
    return el('li', {}, [el('span', { className: 'mono', textContent: l.site }), el('span', { className: 'hint', textContent: l.username || '(no user name)' }), rm]);
  }) : [el('li', { className: 'hint', textContent: 'None yet.' })]));
}
$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await helper({ type: 'login-save', site: $('loginSite').value, username: $('loginUser').value, password: $('loginPass').value });
  $('loginPass').value = '';
  if (r && r.ok !== false) {
    $('loginSite').value = '';
    $('loginUser').value = '';
    $('loginSaid').textContent = 'Saved.';
    loginsDraw(r);
  } else {
    $('loginSaid').textContent = (r && r.error) || 'Not saved.';
  }
});
loginsDraw();

// ---- Video pops out when its tab is left ------------------------------------------------
chrome.storage.local.get({ popOutVideo: true }).then(({ popOutVideo }) => { $('popOutVideo').checked = popOutVideo; });
$('popOutVideo').addEventListener('change', () => chrome.storage.local.set({ popOutVideo: $('popOutVideo').checked }));
chrome.storage.local.get({ peekOn: true }).then(({ peekOn }) => { $('peekOn').checked = peekOn; });
$('peekOn').addEventListener('change', () => chrome.storage.local.set({ peekOn: $('peekOn').checked }));

// How Gamblium starts from its icon (owner, Nov 16 2026): a neutral window that belongs to no
// session, or the session closed last with its windows and tabs. Kept by the helper.
const START_HINT = {
  fresh: 'A clean window that belongs to no session. Pick Personal, Work or another from the New Tab page. It is not kept as a session when you close it (one you browsed in is set aside for 14 days).',
  last: 'The session you closed last comes back with its windows and tabs (asleep until you open them), and a New Tab page in front.',
};
function showStart(mode) {
  for (const b of document.querySelectorAll('#startChoices button')) b.setAttribute('aria-pressed', String(b.dataset.start === mode));
  $('startHint').textContent = START_HINT[mode] || '';
}
send({ type: 'native', request: { type: 'named-sessions', args: ['start-mode'] } }).then((r) => {
  if (r?.ok === false || !r?.startMode) { $('startField').hidden = true; return; }
  showStart(r.startMode);
}).catch(() => { $('startField').hidden = true; });
for (const b of document.querySelectorAll('#startChoices button')) b.addEventListener('click', async () => {
  const r = await send({ type: 'native', request: { type: 'named-sessions', args: ['start-mode', b.dataset.start] } });
  if (r?.startMode) showStart(r.startMode);
});

// ---- Floating lyrics: the look (the lyrics window keeps it in its style.json, through the helper) ----
const LYR_FONTS = ['Segoe UI', 'Segoe UI Semibold', 'Segoe UI Black', 'Bahnschrift', 'Georgia', 'Cambria', 'Palatino Linotype', 'Trebuchet MS', 'Verdana', 'Comic Sans MS', 'Consolas', 'Nirmala UI'];
let lyrStyle = null;
let lyrTimer = null;
let lyrPending = {};
const lyrName = (p) => p.charAt(0).toUpperCase() + p.slice(1);
function lyrPaint(st, presets) {
  const sel = $('lyrPreset');
  if (presets && !sel.options.length) for (const p of presets) sel.append(new Option(lyrName(p), p));
  const fonts = $('lyrFont');
  if (!fonts.options.length) for (const f of LYR_FONTS) fonts.append(new Option(f, f));
  if (![...fonts.options].some((o) => o.value === st.font)) fonts.append(new Option(st.font, st.font));
  sel.value = st.preset;
  $('lyrLayout').value = st.layout;
  $('lyrScript').value = st.script;
  $('lyrLines').value = String(st.lines);
  fonts.value = st.font;
  const size = st.layout === 'card' ? st.card_text_size : st.size;
  $('lyrSize').value = size; $('lyrSizeText').textContent = `${Math.round(size)} px`;
  $('lyrColor').value = st.color; $('lyrGradOn').checked = !!st.gradient_to; $('lyrGrad').value = st.gradient_to || st.color; $('lyrGrad').disabled = !st.gradient_to;
  $('lyrTitle').value = st.title_color;
  $('lyrGlow').value = st.glow_color; $('lyrGlowSize').value = st.glow_radius; $('lyrGlowText').textContent = st.glow_radius ? `${st.glow_radius} px` : 'off';
  $('lyrOutline').value = st.outline_color; $('lyrOutlineSize').value = st.outline_width; $('lyrOutlineText').textContent = st.outline_width ? `${st.outline_width} px` : 'off';
  $('lyrSparkle').checked = st.sparkle; $('lyrSparkleColor').value = st.sparkle_color; $('lyrSparkleAmount').value = st.sparkle_amount; $('lyrSparkleText').textContent = `${st.sparkle_amount}`;
  $('lyrShine').checked = st.shine; $('lyrShineColor').value = st.shine_color;
  $('lyrBg').value = st.background; $('lyrBgOpacity').value = st.background_opacity; $('lyrBgText').textContent = `${Math.round(st.background_opacity)}%`;
  $('lyrArt').value = st.art_opacity; $('lyrArtText').textContent = `${Math.round(st.art_opacity)}%`;
  $('lyrMood').value = st.mood_tint; $('lyrMoodText').textContent = `${Math.round(st.mood_tint)}%`;
  $('lyrRound').value = st.corner_radius; $('lyrRoundText').textContent = `${Math.round(st.corner_radius)} px`;
  $('lyrThrough').checked = st.click_through;
  $('lyrGlass').checked = st.glass; $('lyrGlassK').value = st.glass_strength; $('lyrGlassText').textContent = `${Math.round(st.glass_strength)}%`;
  $('lyrGlassK').disabled = !st.glass;
  $('lyrSeekBar').checked = st.words_seek_bar !== false;
  knobPaint(st);
}
async function lyrLoad() {
  const r = await send({ type: 'native', request: { type: 'lyrics-style-get' } }).catch(() => null);
  if (!r || r.ok === false || !r.style) {
    $('lyrState').textContent = 'The lyrics window is not installed yet (it comes with the next Gamblium update).';
    for (const x of $('lyrFields').querySelectorAll('input, select, button')) x.disabled = true;
    return;
  }
  lyrStyle = r.style;
  lyrPaint(lyrStyle, r.presets);
}
// Changes go out a moment after the last touch (a dragged slider is one change).
function lyrSet(changes, reload = false) {
  Object.assign(lyrPending, changes);
  Object.assign(lyrStyle, changes);
  lyrPaint(lyrStyle);
  clearTimeout(lyrTimer);
  lyrTimer = setTimeout(async () => {
    const c = lyrPending;
    lyrPending = {};
    const r = await send({ type: 'native', request: { type: 'lyrics-style-set', changes: c } }).catch(() => null);
    if (!r || r.ok === false) $('lyrState').textContent = 'Could not save the lyrics look: ' + ((r && r.error) || 'the helper did not answer');
    else if (reload) await lyrLoad();
  }, 150);
}
const lyrNum = (id) => Number($(id).value);
$('lyrPreset').addEventListener('change', () => lyrSet({ preset: $('lyrPreset').value }, true));
$('lyrReset').addEventListener('click', () => lyrSet({ preset: lyrStyle.preset }, true));
$('lyrLayout').addEventListener('change', () => lyrSet({ layout: $('lyrLayout').value }));
$('lyrScript').addEventListener('change', () => lyrSet({ script: $('lyrScript').value }));
$('lyrLines').addEventListener('change', () => lyrSet({ lines: lyrNum('lyrLines') }));
$('lyrFont').addEventListener('change', () => lyrSet({ font: $('lyrFont').value }));
$('lyrSize').addEventListener('input', () => lyrSet(lyrStyle.layout === 'card' ? { card_text_size: lyrNum('lyrSize') } : { size: lyrNum('lyrSize') }));
$('lyrColor').addEventListener('input', () => lyrSet({ color: $('lyrColor').value }));
$('lyrGradOn').addEventListener('change', () => lyrSet({ gradient_to: $('lyrGradOn').checked ? $('lyrGrad').value : null }));
$('lyrGrad').addEventListener('input', () => lyrSet({ gradient_to: $('lyrGrad').value }));
$('lyrTitle').addEventListener('input', () => lyrSet({ title_color: $('lyrTitle').value }));
$('lyrGlow').addEventListener('input', () => lyrSet({ glow_color: $('lyrGlow').value, glow_radius: lyrStyle.glow_radius || 10 }));
$('lyrGlowSize').addEventListener('input', () => lyrSet({ glow_radius: lyrNum('lyrGlowSize') }));
$('lyrOutline').addEventListener('input', () => lyrSet({ outline_color: $('lyrOutline').value, outline_width: lyrStyle.outline_width || 2 }));
$('lyrOutlineSize').addEventListener('input', () => lyrSet({ outline_width: lyrNum('lyrOutlineSize') }));
$('lyrSparkle').addEventListener('change', () => lyrSet({ sparkle: $('lyrSparkle').checked }));
$('lyrSparkleColor').addEventListener('input', () => lyrSet({ sparkle_color: $('lyrSparkleColor').value, sparkle: true }));
$('lyrSparkleAmount').addEventListener('input', () => lyrSet({ sparkle_amount: lyrNum('lyrSparkleAmount'), sparkle: true }));
$('lyrShine').addEventListener('change', () => lyrSet({ shine: $('lyrShine').checked }));
$('lyrShineColor').addEventListener('input', () => lyrSet({ shine_color: $('lyrShineColor').value, shine: true }));
$('lyrBg').addEventListener('input', () => lyrSet({ background: $('lyrBg').value }));
$('lyrBgOpacity').addEventListener('input', () => lyrSet({ background_opacity: lyrNum('lyrBgOpacity') }));
$('lyrArt').addEventListener('input', () => lyrSet({ art_opacity: lyrNum('lyrArt') }));
$('lyrMood').addEventListener('input', () => lyrSet({ mood_tint: lyrNum('lyrMood') }));
$('lyrRound').addEventListener('input', () => lyrSet({ corner_radius: lyrNum('lyrRound') }));
$('lyrThrough').addEventListener('change', () => lyrSet({ click_through: $('lyrThrough').checked }));
$('lyrGlass').addEventListener('change', () => lyrSet({ glass: $('lyrGlass').checked }));
$('lyrSeekBar').addEventListener('change', () => lyrSet({ words_seek_bar: $('lyrSeekBar').checked }));
$('lyrGlassK').addEventListener('input', () => lyrSet({ glass_strength: lyrNum('lyrGlassK') }));
void lyrLoad();

// ---- The seek bar's knob: a shape, or the person's own picture (shown while the mouse is over the bar).
const KNOBS = [
  ['dot', 'Dot', '<circle cx="12" cy="12" r="6"/>'],
  ['heart', 'Heart', '<path d="M12 19.5C5 14.5 4.5 10.5 6.5 8.3c1.8-1.9 4.3-1.2 5.5.9 1.2-2.1 3.7-2.8 5.5-.9 2 2.2 1.5 6.2-5.5 11.2z"/>'],
  ['star', 'Star', '<path d="M12 4.5l2.2 4.8 5.2.5-3.9 3.5 1.1 5.1L12 15.8l-4.6 2.6 1.1-5.1-3.9-3.5 5.2-.5z"/>'],
  ['note', 'Music note', '<path d="M10.5 16.5a2.5 2.5 0 1 1-2.5-2.5c.9 0 1.6.3 2.5.8V5.5l7-1.5v3.5l-5 1v8z"/>'],
  ['moon', 'Moon', '<path d="M15.5 4.8A7.5 7.5 0 1 0 19.2 16 6 6 0 0 1 15.5 4.8z"/>'],
  ['sparkle', 'Sparkle', '<path d="M12 3.5l1.6 6.9 6.9 1.6-6.9 1.6L12 20.5l-1.6-6.9L3.5 12l6.9-1.6z"/>'],
  ['diamond', 'Diamond', '<path d="M12 4l5.5 8-5.5 8-5.5-8z"/>'],
];
function knobPaint(st) {
  const box = $('lyrKnobs');
  if (!box.childElementCount) {
    for (const [key, label, svg] of [...KNOBS, ['custom', 'Your picture', '<rect x="5.5" y="5.5" width="13" height="13" rx="3" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M7.5 16l3-3.5 2.5 2.5 2-2 2 3z"/>']]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'knob';
      b.dataset.knob = key;
      b.title = label;
      b.setAttribute('aria-label', label);
      b.innerHTML = `<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true">${svg}</svg>`;
      b.addEventListener('click', () => (key === 'custom' ? $('lyrKnobFile').click() : lyrSet({ knob: key })));
      box.append(b);
    }
  }
  for (const b of box.children) b.setAttribute('aria-pressed', String(b.dataset.knob === st.knob));
  $('lyrKnobColor').value = st.knob_color || '#ffffff';
  $('lyrKnobSize').value = st.knob_size || 11;
  $('lyrKnobSizeText').textContent = `${Math.round(st.knob_size || 11)} px`;
}
$('lyrKnobColor').addEventListener('input', () => lyrSet({ knob_color: $('lyrKnobColor').value }));
$('lyrKnobSize').addEventListener('input', () => lyrSet({ knob_size: Number($('lyrKnobSize').value) }));
$('lyrKnobUpload').addEventListener('click', () => $('lyrKnobFile').click());
$('lyrKnobFile').addEventListener('change', async () => {
  const f = $('lyrKnobFile').files && $('lyrKnobFile').files[0];
  $('lyrKnobFile').value = '';
  if (!f) return;
  if (f.size > 1 << 20) { $('lyrKnobHint').textContent = 'That picture is larger than 1 MB.'; return; }
  const buf = new Uint8Array(await f.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  const r = await send({ type: 'native', request: { type: 'lyrics-knob-upload', data: btoa(bin) } }).catch(() => null);
  if (!r || r.ok === false) { $('lyrKnobHint').textContent = 'Could not use it: ' + ((r && r.error) || 'the helper did not answer'); return; }
  $('lyrKnobHint').textContent = 'Your picture is the knob now.';
  lyrStyle.knob_custom_seen = true;
  await lyrLoad();
});

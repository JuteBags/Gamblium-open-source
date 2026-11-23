// Sessions: put the open windows away under a name, and bring a saved one back.
// A session is drawn as its windows: one row of site icons per window, so it is
// recognised by sight. Nothing here runs on a timer: the page is read on load,
// when it is shown again, and after each action.
// sessions.html?demo shows made-up sessions, to look at the page.
import { $, send, el, button, say } from './page.js';
import { findInSessions, urlKey } from '../sessions.js';
import { guardIcon } from '../site-icons.js';
import {
  fmtAgo, checkpointName, sessionSites, savedLine, restoredLine, exportFileName,
  nowShape, stripOf, sessionWhen, filterSessions, sessionFacts, sessionTabs, GROUP_COLOURS,
  namedNameError, nameKey, proxyAddress, namedView, namedActionLabel, filterNamed, namedDeleteQuestion, siteLabel,
} from './pages-logic.js';

const demo = new URLSearchParams(location.search).has('demo');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

let list = [];
let scope = 'all';
let query = '';
let found = null; // while something is typed: Map of session name -> { nameHit, total, tabs }
let turn = 0;
let opened = null; // the name of the session whose tabs show
let confirming = null; // 'delete:<name>' or 'replace:<name>' after the first press
let withSettings = false;
const full = new Map(); // name -> the whole session, read when it is opened

// ---- A window as a row of site icons -------------------------------------------------

const icon = (t, size = 16) => {
  const own = typeof t.icon === 'string' && /^(https:|data:image\/)/.test(t.icon) ? t.icon : null;
  const img = guardIcon(el('img', { alt: '', width: size, height: size, loading: 'lazy', src: own || chrome.runtime.getURL(`_favicon/?pageUrl=${encodeURIComponent(t.url)}&size=32`) }));
  const chip = el('span', { className: 'tabicon' }, img);
  if (t.pinned) chip.dataset.pinned = '';
  if (t.asleep) chip.dataset.asleep = '';
  if (t.color) chip.style.setProperty('--group', GROUP_COLOURS[t.color] ?? GROUP_COLOURS.grey);
  return chip;
};

// `hits` is a set of page keys to point out: those icons stay bright, the others step back.
function windowRow(win, limit, hits = null) {
  const { icons, more } = stripOf(win, limit);
  const li = el('li', { className: 'win' }, [
    el('span', { className: 'wcount num', textContent: String(win.tabs), title: plural(win.tabs, 'tab') }),
    el('span', { className: 'strip' }, [...icons.map((t) => {
      const chip = icon(t);
      if (hits) chip.dataset[hits.has(urlKey(t.url)) ? 'hit' : 'miss'] = '';
      return chip;
    }), ...(more ? [el('span', { className: 'more num', textContent: `+${more}` })] : [])]),
  ]);
  return li;
}

// ---- Named sessions: a browser of its own each ---------------------------------------
// The helper keeps them (gamblium-cli makes the same ones): named-sessions ["list"] and
// ["create" | "open" | "hide" | "close" | "delete" | "set", name, ...]. Starting, opening and
// hiding restart a browser and take a few seconds, so the card says it is busy meanwhile.
// A helper without them answers ok:false and this part of the page stays away.

let named = [];
let mainGamblium = null; // the owner's own Gamblium, as the helper lists it ("default")
let mainSets = []; // its saved tab sets, mirrored (cli-view.sealed)
// The session this page runs in, if it is one (owner, Nov 16 2026: opened in the Work window the
// page called Work "This Gamblium" and listed it again under Active, and the owner's own Gamblium
// was nowhere).
const mySession = () => { try { return myPid ? named.find((s) => s.pid && s.pid === myPid) : null; } catch { return null; } }; // myPid is declared further down
let busy = null; // the name being started, opened, hidden or stopped
let editing = null; // the name whose proxy is being changed
let namedConfirm = null; // the name whose Delete was pressed once
let namedShown = null; // the session whose tabs are listed

// Sessions are sent to the helper by id (#k3f9qa), never by name: an id is exact and never changes.
const idOf = (name) => { const s = named.find((x) => x.name === name); return s?.id ? `#${s.id}` : name; };
const byId = (args) => (args[0] === 'create' ? args : args.map((a, i) => (i === 1 && !(args[0] === 'fork') ? idOf(a) : a.startsWith('from=') ? `from=${idOf(a.slice(5))}` : a)));
const namedCall = (...args) => (demo ? DEMO_NAMED(args) : send({ type: 'native', request: { type: 'named-sessions', args: byId(args) } }));

async function readNamed() {
  const r = await namedCall('list');
  const ok = r?.ok !== false && Array.isArray(r?.sessions);
  const showTests = new URLSearchParams(location.search).has('tests');
  named = ok ? r.sessions.filter((s) => (showTests || !s.test) && !s.temp) : [];
  mainGamblium = ok ? r.default || null : null;
  mainSets = ok && Array.isArray(r.tabSets) ? r.tabSets : [];
  // No answer at all: the panel stays away. An answer that fails after it was there keeps it, to show why.
  if (ok) $('named').hidden = false;
  renderNamed();
}

// With many sessions the list gets a name filter and a checkbox per row; the row's other
// actions show on hover or keyboard focus, so one quiet primary per row is what stays.
let namedQuery = '';
const picked = new Set(); // names ticked for deleting together
let pickedConfirm = false;

function renderNamed() {
  $('namedNone').hidden = true;
  for (const n of [...picked]) if (!named.some((s) => s.name === n)) picked.delete(n);
  $('namedTools').hidden = named.length < 1;
  renderPicked();
  if ($('namedRows').contains(document.activeElement) && document.activeElement.tagName === 'INPUT' && document.activeElement.type !== 'checkbox') return; // someone is typing a proxy
  const shown = filterNamed(named, namedQuery);
  $('namedNomatch').hidden = !(named.length && !shown.length);
  $('namedRows').classList.toggle('picking', picked.size > 0);
  const want = (s) => filter === 'all' || (filter === 'named' && s.named !== false) || (filter === 'unnamed' && s.named === false);
  const me = mySession();
  const active = shown.filter((s) => s.state !== 'stopped' && want(s) && s !== me);
  // In a session, the owner's own Gamblium is another browser that is running: listed here.
  const own = me && mainGamblium?.state === 'running' && filter === 'all' ? [mainRow(mainGamblium)] : [];
  // Closed, it is an inactive session like any other (owner, Nov 16 2026: it vanished from the list).
  const ownClosed = me && mainGamblium && mainGamblium.state !== 'running' && filter === 'all' && filterNamed([{ name: mainGamblium.named ? mainGamblium.name : 'Your Gamblium', tabs: (mainGamblium.windows || []).flatMap((w) => w.tabs || []) }], namedQuery).length ? [mainRow(mainGamblium)] : [];
  const inactive = shown.filter((s) => s.state === 'stopped' && want(s));
  const anon = privateWindows > 0 && filter === 'all' ? [el('li', { className: 'nsess anon' }, [
    el('span', { ariaHidden: 'true' }),
    el('div', { className: 'nmain' }, [el('div', { className: 'ntop' }, [el('h3', { textContent: 'Anonymous session' }), el('span', { className: 'live num', title: 'A private window: nothing of it is listed, saved or kept' }, [el('i', { className: 'dot', ariaHidden: 'true' })])])]),
  ])] : [];
  $('activeRows').hidden = active.length + anon.length + own.length === 0;
  $('activeNone').hidden = active.length + anon.length + own.length > 0;
  $('activeRows').replaceChildren(...own, ...anon, ...active.map(namedLi));
  $('namedRows').replaceChildren(...ownClosed, ...inactive.map(namedLi));
  $('inactCount').textContent = inactive.length + ownClosed.length ? String(inactive.length + ownClosed.length) : '';
  $('inactNone').hidden = inactive.length + ownClosed.length > 0 || !!namedQuery;
  const nActive = active.length + anon.length + own.length;
  $('activeCount').textContent = nActive ? String(nActive) : '';
  // The card on top is the browser this page is in: a session by its name, or the owner's own.
  const mainName = mainGamblium?.named ? mainGamblium.name : null;
  $('now-title').firstChild.textContent = me ? `${me.name} ` : `${mainName || 'This Gamblium'} `;
  $('now-title').querySelector('.kind').textContent = me ? `this session (#${me.id}), its own sign-ins` : mainName ? 'this Gamblium: every window you open normally' : 'your own, every window you open normally';
  $('mainRename').hidden = !!me || !mainGamblium;
  $('ownCard').hidden = filter !== 'all';
  render();
}

/** The owner's own Gamblium as a row: its windows' tabs, read-only (commands do not go to it). */
function mainRow(m) {
  const wins = (Array.isArray(m.windows) ? m.windows : []).map((w) => {
    const tabs = (w.tabs || []).filter((t) => /^https?:/i.test(t.url || ''));
    return { tabs: tabs.length, icons: tabs.map((t) => ({ url: t.url, title: t.title || t.url, icon: t.icon })) };
  }).filter((w) => w.tabs > 0);
  const all = (Array.isArray(m.windows) ? m.windows : []).flatMap((w) => w.tabs || []).filter((t) => /^https?:/i.test(t.url || ''));
  const name = m.named ? m.name : 'Your Gamblium';
  const showing = namedShown === 'default';
  // The same buttons as any other session (owner, Nov 16 2026: it had none).
  const acts = [
    button(m.state === 'running' ? 'Go to session' : 'Start in a window', () => send({ type: 'native', request: { type: 'start-main' } }).then(() => setTimeout(readNamed, 2500)), 'reopen'),
    Object.assign(button('Fork', () => namedDo('fork', freeName(`${name}-child`), 'from=default', '--window'), 'quiet later'), { title: 'A child session: the same sign-ins, none of the tabs (asks in that window first)' }),
    button('Rename', () => { renaming = 'default'; renderNamed(); $('activeRows')?.querySelector('.renameedit input')?.select(); }, 'quiet later'),
    ...(all.length ? [button(showing ? 'Hide tabs' : 'Show tabs', () => { namedShown = showing ? null : 'default'; renderNamed(); }, 'quiet later')] : []),
  ];
  const list = showing ? el('ul', { className: 'ntabs' }, all.map((t) => el('li', {}, [icon({ url: t.url, title: t.title || t.url, icon: t.icon }), el('span', { className: 'ttitle', textContent: t.title || t.url }), el('span', { className: 'thost', textContent: t.url.replace(/^https?:\/\/(www\.)?/, '') })]))) : null;
  return el('li', { className: 'nsess own' }, [
    el('span', { ariaHidden: 'true' }),
    el('div', { className: 'nmain' }, [
      el('div', { className: 'ntop' }, [
        renaming === 'default' ? renameEditor(name, 'default') : el('h3', { textContent: name }),
        ...(m.state === 'running' ? [el('span', { className: 'live num', title: 'Running' }, [el('i', { className: 'dot', ariaHidden: 'true' }), m.pid ? String(m.pid) : ''])] : [el('span', { className: 'pill', textContent: 'Stopped' })]),
        el('span', { className: 'kind', textContent: 'every window you open normally' }),
      ]),
      ...(wins.length ? [el('ul', { className: 'wins' }, wins.map((w) => windowRow(w, 22)))] : []),
      ...(list ? [list] : []),
    ]),
    el('div', { className: 'sacts' }, acts),
  ]);
}

function namedLi(s) {
  {
    const v = namedView(s);
    const isBusy = busy === v.name;
    const asking = namedConfirm === v.name;
    const acts = asking
      ? [el('span', { className: 'ask', textContent: namedDeleteQuestion([v.name]) }), button('Delete', () => namedDo('delete', v.name), 'danger'), button('Keep it', () => { namedConfirm = null; renderNamed(); }, 'quiet')]
      : v.actions.map((a, i) => {
        const b = button(namedActionLabel(a, v.state), () => (a === 'delete' ? (namedConfirm = v.name, renderNamed(), $('namedRows').querySelector('.nsess[data-asking] .sacts .quiet')?.focus()) : namedDo(a, v.name)), i === 0 ? 'reopen' : a === 'delete' ? 'quiet ending' : 'quiet');
        b.disabled = isBusy;
        if (i > 0) b.classList.add('later');
        return b;
      });
    const proxyRow = editing === v.name ? proxyEditor(v) : el('p', { className: 'nfacts' }, [
      ...v.facts.map((f) => el('span', { textContent: f, title: / extensions?$/.test(f) && v.extensions.length ? v.extensions.join(', ') : '' })),
      Object.assign(button(v.proxy ? 'Change' : 'Set a proxy', () => { editing = v.name; renderNamed(); $('namedRows').querySelector('.proxyedit input')?.focus(); }, 'quiet later'), { disabled: isBusy }),
      Object.assign(button('Fork', () => namedDo('fork', freeName(`${v.name}-child`), `from=${v.name}`, '--window'), 'quiet later'), { disabled: isBusy, title: 'A child session: the same sign-ins, none of the tabs' }),
      Object.assign(button('Clone', () => namedDo('clone', v.name, freeName(`${v.name}-copy`), '--window'), 'quiet later'), { disabled: isBusy, title: 'The same sign-ins and tabs, as a session of its own' }),
      Object.assign(button('Rename', () => { renaming = v.name; renderNamed(); $('namedRows').querySelector('.renameedit input')?.select(); }, 'quiet later'), { disabled: isBusy }),
    ]);
    const web = (s.tabs || []).filter((t) => /^https?:/i.test(t.url || ''));
    const strip = web.length ? el('ul', { className: 'wins', ariaLabel: `The tabs of ${v.name}` }, [windowRow({ tabs: web.length, icons: web.map((t) => ({ url: t.url, title: t.title || t.url, icon: t.icon })) }, 26)]) : null;
    const showing = namedShown === v.name;
    const list = showing && web.length ? el('ul', { className: 'ntabs' }, web.map((t) => el('li', {}, [icon({ url: t.url, title: t.title || t.url, icon: t.icon }), el('span', { className: 'ttitle', textContent: t.title || t.url }), el('span', { className: 'thost', textContent: t.url.replace(/^https?:\/\/(www\.)?/, '') })]))) : null;
    const showBtn = web.length ? button(showing ? 'Hide tabs' : 'Show tabs', () => { namedShown = showing ? null : v.name; renderNamed(); }, 'quiet later') : null;
    const tick = el('input', { type: 'checkbox', className: 'npick', checked: picked.has(v.name), ariaLabel: `Select ${v.name}` });
    tick.addEventListener('change', () => { tick.checked ? picked.add(v.name) : picked.delete(v.name); pickedConfirm = false; renderNamed(); });
    const li = el('li', { className: 'nsess' }, [
      tick,
      el('div', { className: 'nmain' }, [
        el('div', { className: 'ntop' }, [
          renaming === v.name ? renameEditor(v.name) : el('h3', { textContent: v.name }),
          ...(s.id ? [idChip(s.id)] : []),
          ...(s.pid ? [live(s.pid)] : []),
          el('span', { className: 'kind', textContent: s.kind === 'child' ? `Child of ${s.parent || 'your Gamblium'}` : 'Main', title: s.clonedFrom ? `A clone of ${s.clonedFrom}` : '' }),
          ...(s.named === false ? [el('span', { className: 'kind', textContent: 'unnamed', title: 'Made by the menu with a made-up name. Rename it to keep it.' })] : []),
          el('span', { className: `pill ${v.cls}`.trim(), textContent: isBusy ? 'One moment…' : v.word }),
        ]),
        ...(strip ? [strip] : []),
        ...(list ? [list] : []),
        proxyRow,
      ]),
      el('div', { className: 'sacts' }, [...acts, ...(showBtn && !asking ? [showBtn] : [])]),
    ]);
    li.dataset.state = v.state;
    if (isBusy) li.dataset.busy = '';
    if (asking) li.dataset.asking = '';
    if (picked.has(v.name)) li.dataset.picked = '';
    return li;
  }
}

// Running: a green dot and the browser's process id, small.
function live(pid) {
  return el('span', { className: 'live num', title: `Running, process ${pid}` }, [el('i', { className: 'dot', ariaHidden: 'true' }), String(pid)]);
}

// The session's id, small: a click copies it, for telling an agent which session (gamblium-cli #id ...).
function idChip(id) {
  const b = el('button', { type: 'button', className: 'idchip num', textContent: `#${id}`, title: 'This session\'s id: it never changes. Click to copy.' });
  b.addEventListener('click', async () => {
    await navigator.clipboard.writeText(`#${id}`).catch(() => {});
    say($('namedSaid'), 'ok', `Copied #${id}. An agent can use it: gamblium-cli #${id} tabs`);
  });
  return b;
}

// A name not taken yet: base, base-2, base-3 ... (spaces and capitals do not count).
function freeName(base) {
  const taken = new Set(named.map((s) => nameKey(s.name)));
  const has = (n) => taken.has(nameKey(n));
  const b = base.slice(0, 36);
  if (!has(b)) return b;
  for (let i = 2; ; i += 1) if (!has(`${b}-${i}`)) return `${b}-${i}`;
}

let renaming = null;
function renameEditor(name, as = name) {
  const input = el('input', { type: 'text', value: name, spellcheck: false, ariaLabel: `New name for ${name}` });
  const form = el('form', { className: 'renameedit' }, [input, el('button', { type: 'submit', textContent: 'Rename' }), button('Cancel', () => { renaming = null; renderNamed(); }, 'quiet')]);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const to = input.value.trim();
    renaming = null;
    if (!to || to === name) return renderNamed();
    const bad = namedNameError(to, named.map((s) => s.name));
    if (bad) { renderNamed(); return say($('namedSaid'), 'bad', bad); }
    await namedDo('rename', as, to);
  });
  return form;
}

function renderPicked() {
  const box = $('namedPicked');
  box.hidden = picked.size === 0;
  if (!picked.size) return box.replaceChildren();
  const names = [...picked];
  const running = names.filter((n) => named.find((s) => s.name === n)?.state !== 'stopped').length;
  box.replaceChildren(...(pickedConfirm
    ? [el('span', { className: 'ask', textContent: namedDeleteQuestion(names) }), button(running ? `Stop and delete ${names.length}` : 'Delete', deletePicked, 'danger'), button('Keep them', () => { pickedConfirm = false; renderNamed(); }, 'quiet')]
    : [el('span', { className: 'n num', textContent: `${names.length} selected` }), button('Delete…', () => { pickedConfirm = true; renderNamed(); box.querySelector('.quiet')?.focus(); }, 'quiet ending'), button('Clear', () => { picked.clear(); pickedConfirm = false; renderNamed(); }, 'quiet')]));
}

async function deletePicked() {
  const names = [...picked];
  picked.clear();
  pickedConfirm = false;
  let failed = 0;
  for (const name of names) {
    busy = name;
    renderNamed();
    const s = named.find((x) => x.name === name);
    if (s && s.state !== 'stopped') await namedCall('close', name);
    const r = await namedCall('delete', name);
    if (r?.ok === false) failed += 1;
  }
  busy = null;
  say($('namedSaid'), failed ? 'bad' : 'ok', failed ? `${names.length - failed} deleted; ${failed} could not be.` : `${names.length} sessions and everything in them are deleted.`);
  await readNamed();
}

$('nq').addEventListener('input', () => { namedQuery = $('nq').value; renderNamed(); });

function proxyEditor(v) {
  const input = el('input', { type: 'text', value: v.proxy ?? '', spellcheck: false, placeholder: 'socks5://127.0.0.1:9050, or empty for none', ariaLabel: `Proxy for ${v.name}` });
  const form = el('form', { className: 'proxyedit' }, [input, el('button', { type: 'submit', textContent: 'Use it' }), button('Cancel', () => { editing = null; document.activeElement?.blur(); renderNamed(); }, 'quiet')]);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const addr = proxyAddress(input.value);
    if (!addr.ok) return say($('namedSaid'), 'bad', addr.error);
    editing = null;
    document.activeElement?.blur();
    await namedDo('set', v.name, `proxy=${addr.value}`);
  });
  return form;
}

async function namedDo(action, name, ...more) {
  namedConfirm = null;
  busy = name;
  renderNamed();
  const r = await namedCall(action, name, ...more);
  busy = null;
  const done = {
    focus: `"${name}" is in front.`,
    fork: `"${name}" is open in its own window, signed in like ${String(more[0] || '').replace('from=', '')}.`,
    clone: `"${more[0]}" is open: a copy of ${name} with its sign-ins and ${r?.tabs ?? 0} tabs.`,
    rename: `"${name}" is now "${more[0]}".`,
    open: `"${name}" is open in a window.`, hide: `"${name}" is working with no window.`, close: `"${name}" is stopped. Its logins and tabs are kept.`, delete: `"${name}" and everything in it is deleted.`, set: `"${name}" uses ${r?.session?.applies?.proxy ?? 'no proxy'} from now on.`, create: `"${name}" is made.` }[action];
  say($('namedSaid'), r?.ok === false ? 'bad' : 'ok', r?.ok === false ? r.error || 'That did not work.' : done);
  await readNamed();
}

$('namedForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('namedName').value.trim();
  const bad = namedNameError(name, named.map((s) => s.name));
  if (bad) return say($('namedSaid'), 'bad', bad);
  const addr = proxyAddress($('namedProxy').value);
  if (!addr.ok) return say($('namedSaid'), 'bad', addr.error);
  const args = [name, ...(addr.value === 'none' ? [] : [`proxy=${addr.value}`]), ...(e.submitter === $('namedOpen') ? ['--window'] : [])];
  $('namedName').value = '';
  $('namedProxy').value = '';
  document.activeElement?.blur();
  named = [{ name, state: 'stopped', applies: { proxy: addr.value === 'none' ? null : addr.value, always: true } }, ...named];
  await namedDo('create', ...args);
});

// ---- Filter: All, Named, Unnamed, Saved tab sets ----------------------------------------
let filter = 'all';
for (const b of document.querySelectorAll('#sfilter [data-filter]')) {
  b.addEventListener('click', () => {
    filter = b.dataset.filter;
    for (const x of document.querySelectorAll('#sfilter [data-filter]')) x.setAttribute('aria-pressed', String(x === b));
    renderNamed();
  });
}

// ---- Open now ----------------------------------------------------------------------

let now = { shape: [], windows: 0, tabs: 0, skipped: 0 };
let privateWindows = 0; // open private windows: shown as one "Anonymous session", nothing more
let currentWindow = null;

async function readNow() {
  if (demo) {
    now = DEMO_NOW();
    currentWindow = now.shape[0]?.id ?? null;
  } else {
    const [all, groups, win] = await Promise.all([chrome.tabs.query({}), chrome.tabGroups ? chrome.tabGroups.query({}) : [], chrome.windows.getCurrent()]);
    currentWindow = win.id;
    const tabs = all.filter((t) => !t.incognito);
    privateWindows = new Set(all.filter((t) => t.incognito).map((t) => t.windowId)).size;
    now = nowShape(tabs, groups, win.id);
    renderNamed();
  }
  renderNow();
}

// Naming the owner's own Gamblium ("Personal"): the same name in every window's manager.
$('mainRename').addEventListener('click', () => {
  const h = $('now-title');
  const input = el('input', { value: mainGamblium?.named ? mainGamblium.name : '', placeholder: 'A name, e.g. Personal', className: 'renameedit' });
  const done = async (keep) => {
    const v = input.value.trim();
    input.remove();
    h.hidden = false;
    if (!keep || !v) return;
    const r = await namedCall('rename', 'default', v);
    if (r?.ok === false) say($('namedSaid'), 'bad', r.error);
    await readNamed();
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); });
  input.addEventListener('blur', () => done(true));
  h.hidden = true;
  h.after(input);
  input.focus();
  input.select();
});

function renderNow() {
  const mine = now.shape.filter((w) => scope === 'all' || w.id === currentWindow);
  const tabs = mine.reduce((n, w) => n + w.tabs, 0);
  const parts = [tabs ? `${plural(tabs, 'tab')} in ${plural(mine.length, 'window')}` : 'Nothing to save'];
  if (now.skipped) parts.push(`${plural(now.skipped, 'browser page')} left out`);
  $('nowLine').textContent = parts.join(' · ');
  $('nowNone').hidden = now.shape.length > 0;
  $('nowWins').hidden = now.shape.length === 0;
  $('nowWins').replaceChildren(...now.shape.map((w) => {
    const li = windowRow(w, 22);
    if (w.tabs <= 2) li.append(el('span', { className: 'whosts', textContent: [...new Set(w.icons.map((t) => siteLabel(t.url)))].join(', ') }));
    if (scope === 'window' && w.id !== currentWindow) li.dataset.off = '';
    if (w.id === currentWindow && now.shape.length > 1) li.append(el('span', { className: 'here', textContent: 'this window' }));
    return li;
  }));
  for (const b of document.querySelectorAll('#saveForm [data-scope]')) b.setAttribute('aria-pressed', String(b.dataset.scope === scope));
  $('saveKeep').disabled = $('saveClose').disabled = tabs === 0;
  matchNow(mine, parts);
}

// The open tabs may be a saved session come back (the browser reopens them after a restart, or
// Reopen did): then that session's name is offered, and saving brings it up to date instead of
// adding a second copy. A name typed by hand is never replaced.
let nameTyped = false;
let openMatch = null; // the saved set whose tabs are the ones open now
let myPid = null;
if (!demo) send({ type: 'native', request: { type: 'ping' } }).then((r) => { myPid = r?.browserPid ?? null; renderNamed(); }).catch(() => {});
let nameOffered = null;
$('name').addEventListener('input', () => { nameTyped = true; });
async function matchNow(mine, parts) {
  if (demo) return;
  const urls = mine.flatMap((w) => w.icons.map((i) => i.url));
  const r = urls.length ? await send({ type: 'session-match', urls }) : null;
  const m = r && r.ok !== false ? r.match : null;
  if ((m?.name ?? null) !== openMatch) {
    openMatch = m?.name ?? null;
    render();
  }
  if (m) {
    $('nowLine').textContent = [...parts, `the tabs of "${m.name}": saving updates it`].join(' · ');
    if (!nameTyped) {
      $('name').value = m.name;
      nameOffered = m.name;
    }
  } else if (nameOffered && !nameTyped) {
    $('name').value = checkpointName();
    nameOffered = null;
  }
}

for (const b of document.querySelectorAll('#saveForm [data-scope]')) {
  b.addEventListener('click', () => {
    scope = b.dataset.scope;
    renderNow();
  });
}

$('saveForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const closeAfter = e.submitter === $('saveClose');
  const name = $('name').value;
  if (demo) return say($('said'), 'ok', `Saved "${name}" (made-up data: nothing was saved).`);
  const r = await send({ type: 'session-save', name, scope, windowId: currentWindow, closeAfter, withPages: $('withPages').checked });
  const line = savedLine(r);
  say($('said'), line.cls, line.text);
  if (r.ok !== false) {
    $('name').value = checkpointName();
    nameTyped = false;
    nameOffered = null;
    full.delete(r.name);
  }
  refresh();
});

// Fork: a new session, signed in where this one is, with none of its tabs (background.js sessionFork).
const hereName = () => mySession()?.name || (mainGamblium?.named ? mainGamblium.name : 'Gamblium');
$('forkNow').addEventListener('click', async () => {
  const name = $('name').value.trim() || freeName(`${hereName()}-child`);
  if (demo) return say($('said'), 'ok', `Forked "${name}" (made-up data: nothing was made).`);
  $('forkNow').disabled = true;
  say($('said'), 'ok', `Making "${name}"…`);
  const r = await send({ type: 'session-fork', name });
  $('forkNow').disabled = false;
  if (r?.ok === false) return say($('said'), 'bad', r.error || 'The session could not be made.');
  say($('said'), 'ok', `"${r.name}" is open in its own window, signed in like this one (${r.cookies} sign-in cookies).`);
  refresh();
});

// Clone: a new main session with this browser's sign-ins and these same tabs.
$('cloneNow').addEventListener('click', async () => {
  const name = $('name').value.trim() || freeName(`${hereName()}-copy`);
  if (demo) return say($('said'), 'ok', `Cloned "${name}" (made-up data: nothing was made).`);
  $('cloneNow').disabled = true;
  say($('said'), 'ok', `Making "${name}"…`);
  const r = await send({ type: 'session-fork', name, kind: 'main' });
  if (r?.ok === false) {
    $('cloneNow').disabled = false;
    return say($('said'), 'bad', r.error || 'The session could not be made.');
  }
  const tabs = (await chrome.tabs.query({})).filter((t) => !t.incognito);
  const urls = tabs.map((t) => t.url).filter((u) => /^https?:/.test(u || ''));
  let n = 0;
  for (const u of urls) {
    const o = await send({ type: 'native', request: { type: 'named-sessions', args: ['open-url', r.name, u] } });
    if (o?.ok !== false) n += 1;
  }
  $('cloneNow').disabled = false;
  say($('said'), 'ok', `"${r.name}" is open: your sign-ins and ${n} of these tabs, a main session of its own.`);
  readNamed();
});

// ---- Saved sessions ------------------------------------------------------------------

async function readList() {
  if (demo) {
    if (!list.length) list = DEMO_LIST();
    return render();
  }
  const r = await send({ type: 'session-list' });
  if (!Array.isArray(r)) return say($('said'), 'bad', r?.error || 'The tabs put away could not be read.');
  list = r;
  render();
}

function render() {
  const sets = filter === 'all' || filter === 'sets' ? list.filter((s) => s.name !== openMatch) : [];
  const shown = found ? sets.filter((s) => found.has(s.name)) : filterSessions(sets, query);
  const me = mySession();
  const mirrored = me && (filter === 'all' || filter === 'sets') ? filterSessions(mainSets, query) : [];
  $('none').hidden = shown.length + mirrored.length > 0 || !!(query || found);
  $('nomatch').hidden = !((query || found) && shown.length + mirrored.length === 0);
  $('sq').hidden = sets.length + (me ? mainSets.length : 0) === 0 && !query;
  $('count').textContent = shown.length + mirrored.length ? String(shown.length + mirrored.length) : '';
  $('mirrorRows').replaceChildren(...mirrored.map((s) => mirrorCard(s, me)));
  const tabsFound = found ? [...found.values()].reduce((n, f) => n + f.total, 0) : 0;
  $('foundLine').hidden = !(found && shown.length);
  $('foundLine').textContent = found ? (tabsFound ? `${plural(tabsFound, 'tab')} in ${plural(shown.length, 'set')}` : `${plural(shown.length, 'set')} by name`) : '';
  const t = Date.now();
  $('rows').replaceChildren(...shown.map((s) => card(s, t)));
}

/** A tab set saved in the owner's own Gamblium, seen from a session: its tabs open here. */
function mirrorCard(s, me) {
  const tabs = (s.windows || []).flatMap((w) => w.tabs || []).filter((t) => /^https?:/i.test(t.url || ''));
  const open = button('Open here', async () => {
    open.disabled = true;
    const r = await namedCall('open-set', `#${s.id}`, `in=#${me.id}`);
    open.disabled = false;
    say($('namedSaid'), r?.ok === false ? 'bad' : 'ok', r?.ok === false ? (r.error || 'Could not open it') : `${s.name}: its tabs are open in ${me.name}.`);
  }, 'reopen');
  return el('li', { className: 'sess' }, [
    el('div', { className: 'shead' }, [
      el('div', {}, [el('h3', { textContent: s.name }), el('p', { className: 'swhen num', textContent: `${sessionWhen(s.savedAt)} · ${plural(s.tabCount ?? tabs.length, 'tab')} · saved in ${mainGamblium?.named ? mainGamblium.name : 'your Gamblium'}` })]),
      el('div', { className: 'sacts' }, [open]),
    ]),
    el('ul', { className: 'wins' }, [windowRow({ tabs: tabs.length, icons: tabs.map((t) => ({ url: t.url, title: t.title || t.url })) }, 22)]),
  ]);
}

function card(s, t) {
  const isOpen = opened === s.name;
  const hit = found?.get(s.name);
  const facts = sessionFacts(s);
  const more = button(isOpen ? 'Hide tabs' : 'Show tabs', () => toggle(s.name), 'quiet');
  more.setAttribute('aria-expanded', String(isOpen));
  const li = el('li', { className: 'sess' }, [
    el('div', { className: 'shead' }, [
      el('div', { className: 'sname' }, [
        el('h3', { textContent: s.name, title: s.name }),
        el('p', { className: 'smeta num' }, [
          el('time', { textContent: sessionWhen(s.savedAt, t), title: `${new Date(s.savedAt).toLocaleString()} (${fmtAgo(s.savedAt, t)})`, dateTime: new Date(s.savedAt).toISOString() }),
          ` · ${plural(s.tabs, 'tab')} in ${plural(s.windows, 'window')}`,
        ]),
      ]),
      el('div', { className: 'sacts' }, [
        openMatch === s.name
          ? el('span', { className: 'live num', title: myPid ? `Open now, process ${myPid}` : 'Open now' }, [el('i', { className: 'dot', ariaHidden: 'true' }), myPid ? String(myPid) : 'open'])
          : button('Reopen', () => restore(s.name), 'reopen'),
        more,
      ]),
    ]),
    el('ul', { className: 'wins', ariaLabel: `The windows of ${s.name}` }, (s.shape ?? []).map((w) => windowRow(w, 26, hit?.total ? new Set(hit.tabs.map((t) => urlKey(t.url))) : null))),
    ...(hit?.total ? [hits(hit)] : []),
    el('p', { className: 'sub' }, [sessionSites(s), ...(facts.length ? [el('span', { className: 'kept', textContent: `Kept: ${facts.join(', ')}` })] : [])]),
    ...(isOpen ? [detail(s)] : []),
  ]);
  if (isOpen) li.dataset.open = '';
  return li;
}

// What was typed, found in this session: the tabs themselves. A click opens just that one.
function hits(hit) {
  const rows = hit.tabs.map((t) => tabButton({ url: t.url, title: t.title.trim() || t.url, pinned: t.pinned, host: `Window ${t.window + 1} · ${t.url.replace(/^https?:\/\/(www\.)?/, '')}` }));
  const rest = hit.total - hit.tabs.length;
  return el('div', { className: 'shits' }, [
    el('h4', { textContent: hit.total === 1 ? '1 tab matches' : `${hit.total} tabs match` }),
    el('ul', {}, rows.map((b) => el('li', {}, b))),
    ...(rest > 0 ? [el('p', { className: 'hint', textContent: `and ${rest} more: "Show tabs" lists them all.` })] : []),
  ]);
}

function tabButton(tab) {
  const b = el('button', { type: 'button', className: 'stab', title: `Open only this tab\n${tab.url}` }, [
    icon(tab),
    el('span', { className: 'ttitle', textContent: tab.title }),
    el('span', { className: 'thost', textContent: tab.host }),
  ]);
  b.addEventListener('click', () => openOne(tab.url));
  return b;
}

// The session opened: every tab by window (a click opens just that one), and what else can be done with it.
function detail(s) {
  const session = full.get(s.name);
  const body = !session
    ? [el('p', { className: 'hint', textContent: 'Reading its tabs…' })]
    : [el('div', { className: 'swins' }, sessionTabs(session).map((w) => el('section', { className: 'swin' }, [
      el('h4', {}, [w.title, el('span', { className: 'n num', textContent: String(w.count) })]),
      el('ul', {}, w.tabs.map((tab) => el('li', {}, tabButton({ ...tab, host: [tab.pinned ? 'pinned' : '', tab.group, tab.host].filter(Boolean).join(' · ') })))),
    ])))];
  const ask = (key, first, second, act) => (confirming === `${key}:${s.name}`
    ? [button(second, act, 'danger'), button('Keep it', () => { confirming = null; render(); }, 'quiet')]
    : [button(first, () => { confirming = `${key}:${s.name}`; render(); }, 'quiet')]);
  const tools = el('div', { className: 'stools' }, [
    ...(s.hasSettings ? [el('label', { className: 'check' }, [Object.assign(el('input', { type: 'checkbox', checked: withSettings }), { onchange: (e) => { withSettings = e.target.checked; } }), ' Reopen with the settings saved in it'])] : []),
    el('span', { className: 'grow' }),
    ...ask('replace', 'Replace with what is open now', 'Replace it for good', () => replace(s.name)),
    button('Export', () => exportOne(s.name), 'quiet'),
    ...ask('delete', 'Delete', 'Delete for good', () => remove(s.name)),
  ]);
  return el('div', { className: 'sdetail' }, [...body, tools]);
}

async function toggle(name) {
  confirming = null;
  opened = opened === name ? null : name;
  render();
  if (!opened || full.has(name)) return;
  const session = demo ? DEMO_FULL(list.find((s) => s.name === name)) : await send({ type: 'session-export', name });
  if (!session || session.ok === false) return say($('said'), 'bad', session?.error || 'Those tabs are gone.');
  full.set(name, session);
  if (opened === name) render();
}

async function restore(name) {
  if (demo) return say($('said'), 'ok', `Reopened "${name}" (made-up data: nothing was opened).`);
  const r = await send({ type: 'session-restore', name, withSettings });
  const line = restoredLine(r);
  say($('said'), line.cls, line.text);
}

async function openOne(url) {
  if (demo) return say($('said'), '', `Would open ${url}`);
  await chrome.tabs.create({ url, active: false });
  say($('said'), '', 'Opened in a new tab behind this one.');
}

async function replace(name) {
  confirming = null;
  if (demo) return render();
  const r = await send({ type: 'session-save', name, scope: 'all', windowId: currentWindow, closeAfter: false, withPages: $('withPages').checked });
  const line = savedLine(r);
  say($('said'), line.cls, r.ok === false ? line.text : line.text.replace(/^Saved/, 'Replaced'));
  full.delete(name);
  if (opened === name) opened = null;
  refresh();
}

async function remove(name) {
  confirming = null;
  if (demo) {
    list = list.filter((s) => s.name !== name);
    return render();
  }
  const r = await send({ type: 'session-delete', name });
  say($('said'), r.ok === false ? 'bad' : '', r.ok === false ? r.error : `Deleted "${name}".`);
  full.delete(name);
  if (opened === name) opened = null;
  refresh();
}

async function exportOne(name) {
  const session = demo ? DEMO_FULL(list.find((s) => s.name === name)) : await send({ type: 'session-export', name });
  if (!session || session.ok === false) return say($('said'), 'bad', session?.error || 'Those tabs are gone.');
  const url = URL.createObjectURL(new Blob([JSON.stringify(session, null, 2)], { type: 'application/json' }));
  el('a', { href: url, download: exportFileName(name) }).click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  say($('said'), '', `Exported "${name}" to your download folder. The file holds page addresses and any form text that was kept, so treat it as private.`);
}

// Typing looks inside every saved session: tab addresses and titles, and session names.
async function search() {
  query = $('sq').value.trim();
  const mine = ++turn;
  if (!query) {
    found = null;
    return render();
  }
  const r = demo ? findInSessions(Object.fromEntries(list.map((s) => [s.name, DEMO_FULL(s)])), query) : await send({ type: 'session-find', query });
  if (mine !== turn) return; // a later keystroke already answered
  found = new Map((Array.isArray(r) ? r : []).map((f) => [f.name, f]));
  render();
}
$('sq').addEventListener('input', search);

$('importBtn').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', async () => {
  const file = $('file').files[0];
  $('file').value = '';
  if (!file) return;
  let session;
  try {
    session = JSON.parse(await file.text());
  } catch {
    return say($('said'), 'bad', 'That file does not hold tabs put away by Gamblium.');
  }
  const r = await send({ type: 'session-import', session });
  say($('said'), r.ok === false ? 'bad' : 'ok', r.ok === false ? r.error : `Imported "${r.name}". It is in the list below.`);
  refresh();
});

function refresh() {
  return Promise.all([readNamed(), readNow(), readList().then(() => (query ? search() : null))]);
}
// Tabs change while this page is in the background; look again when it is shown.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    readNow();
    if (!busy) readNamed(); // an agent or a terminal may have started or stopped one meanwhile
  }
});

// ---- Made-up data for ?demo ------------------------------------------------------------

const SITES = ['https://github.com/', 'https://www.wikipedia.org/', 'https://www.youtube.com/', 'https://www.bbc.com/news', 'https://developer.mozilla.org/', 'https://news.ycombinator.com/', 'https://stackoverflow.com/', 'https://www.openstreetmap.org/', 'https://example.com/'];
const fake = (n, start, extra = () => ({})) => Array.from({ length: n }, (_, i) => ({ url: SITES[(start + i * 2 + (i % 3)) % SITES.length], pinned: false, color: null, ...extra(i) }));
let demoNamed = [
  { name: 'research', state: 'hidden', by: 'cli', applies: { proxy: 'socks5://127.0.0.1:9050', always: true, extensions: ['JSON viewer', 'Zotero Connector', 'uBlock filters'] } },
  { name: 'work', state: 'window', by: 'page', applies: { proxy: null, always: true, extensions: ['Bitwarden', 'Claude'] } },
  { name: 'bank', state: 'stopped', by: 'page', applies: { proxy: null, always: true, extensions: [] } },
  { name: 'pen-test-lab', state: 'stopped', by: 'cli', applies: { proxy: 'http://127.0.0.1:8080', always: true, extensions: ['Wappalyzer'] } },
  { name: 'shopping', state: 'stopped', by: 'page', applies: { proxy: null, always: true, extensions: [] } },
  { name: 'scraper-1', state: 'stopped', by: 'cli', applies: { proxy: null, always: true, extensions: [] } },
  { name: 'scraper-2', state: 'stopped', by: 'cli', applies: { proxy: null, always: true, extensions: [] } },
];
async function DEMO_NAMED([action, name, ...more]) {
  if (action === 'list') return { ok: true, sessions: demoNamed };
  await new Promise((r) => setTimeout(r, 900));
  const proxy = more.find((m) => m.startsWith('proxy='))?.slice(6);
  if (action === 'create') demoNamed = [{ name, state: more.includes('--window') ? 'window' : 'hidden', by: 'page', applies: { proxy: proxy ?? null, always: true, extensions: [] } }, ...demoNamed];
  else if (action === 'delete') demoNamed = demoNamed.filter((s) => s.name !== name);
  else demoNamed = demoNamed.map((s) => (s.name !== name ? s : action === 'set' ? { ...s, applies: { ...s.applies, proxy: proxy === 'none' ? null : proxy } } : { ...s, state: { open: 'window', hide: 'hidden', close: 'stopped' }[action] }));
  return { ok: true, session: demoNamed.find((s) => s.name === name) ?? null };
}
function DEMO_NOW() {
  return { shape: [
    { id: 1, tabs: 17, icons: fake(17, 0, (i) => ({ pinned: i < 3, color: i > 4 && i < 9 ? 'blue' : i > 11 ? 'green' : null, asleep: i > 9 })) },
    { id: 2, tabs: 9, icons: fake(9, 3, (i) => ({ asleep: i > 5 })) },
    { id: 3, tabs: 4, icons: fake(4, 6) },
  ], windows: 3, tabs: 30, skipped: 2 };
}
function DEMO_LIST() {
  const t = Date.now();
  const s = (name, ago, wins, more = {}) => ({ name, savedAt: t - ago, windows: wins.length, tabs: wins.reduce((n, w) => n + w.tabs, 0), hosts: [...new Set(wins.flatMap((w) => w.icons.map((i) => new URL(i.url).hostname.replace(/^www\./, ''))))].slice(0, 3), profile: null, pagesCaptured: 0, hasSettings: true, shape: wins, ...more });
  return [
    s('Release week', 42 * 60000, [{ tabs: 41, icons: fake(28, 0, (i) => ({ pinned: i < 4, color: i > 5 && i < 14 ? 'purple' : i > 18 ? 'orange' : null })) }, { tabs: 12, icons: fake(12, 4, (i) => ({ color: i < 5 ? 'cyan' : null })) }, { tabs: 3, icons: fake(3, 7) }], { pagesCaptured: 19, profile: 'Work' }),
    s('Flat hunting', 26 * 3600000, [{ tabs: 14, icons: fake(14, 5, (i) => ({ color: i < 6 ? 'yellow' : null })) }], { pagesCaptured: 6 }),
    s('Reading list', 3 * 86400000, [{ tabs: 8, icons: fake(8, 2) }, { tabs: 5, icons: fake(5, 8) }], { hasSettings: false }),
    s('Tax return 2026', 9 * 86400000, [{ tabs: 6, icons: fake(6, 1, (i) => ({ pinned: i === 0 })) }], { pagesCaptured: 2 }),
    s('Conference talk', 40 * 86400000, [{ tabs: 22, icons: fake(22, 3, (i) => ({ color: i > 8 && i < 16 ? 'red' : null })) }, { tabs: 2, icons: fake(2, 0) }]),
  ];
}
function DEMO_FULL(s) {
  const titles = ['Pull requests', 'Release checklist', 'Build 0.5.0 is green', 'Notes from the review', 'Changelog draft', 'How tab freezing works', 'Issue 214: the popup on small screens'];
  return { version: 2, name: s.name, savedAt: s.savedAt, windows: s.shape.map((w) => ({
    groups: [...new Set(w.icons.map((i) => i.color).filter(Boolean))].map((c) => ({ title: { purple: 'Review', orange: 'Docs', cyan: 'Design', yellow: 'Shortlist', red: 'Slides' }[c] ?? '', color: c })),
    tabs: w.icons.map((i, k, all) => ({ url: i.url, title: titles[k % titles.length], pinned: i.pinned, group: i.color ? [...new Set(all.map((x) => x.color).filter(Boolean))].indexOf(i.color) : null, page: k % 3 === 0 ? {} : null })),
  })) };
}

$('name').value = checkpointName();
// sessions.html?q=<text> arrives with something to find already typed (History links here).
const asked = new URLSearchParams(location.search).get('q');
if (asked) {
  $('sq').value = asked;
  query = asked;
}
refresh();

// The settings panel: opened from the icon by the title, closed by Close, Esc or the icon again.
function settingsOpen(open) {
  $('sSettings').hidden = !open;
  $('sGear').setAttribute('aria-expanded', String(open));
  if (open) $('withPages').focus();
  else $('sGear').focus();
}
$('sGear').addEventListener('click', () => settingsOpen($('sSettings').hidden));
$('sSettingsClose').addEventListener('click', () => settingsOpen(false));
$('sSettings').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); settingsOpen(false); } });

// The proxy of a new session: only when asked for (almost nobody sets one at creation).
$('namedProxyShow').addEventListener('click', () => {
  $('namedProxy').hidden = false;
  $('namedProxyShow').hidden = true;
  $('namedProxy').focus();
});

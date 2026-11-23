// First run: one decision per screen. What is asked sits on the left of the
// card, the choices on the right. Opened once per profile by the background
// while storage "onboarded" is not true. Every choice is saved the moment it
// is made, so closing the tab loses nothing; "onboarded" is set when the
// person finishes or skips.
import { readPrefs, greeting, timeOptions, isPinned, togglePin, WIDGETS, ENGINES, STARTERS, DEFAULT_LAYOUT } from '../newtab/logic.js';
import { lookOf } from './pages-logic.js';
import { siteIcon, siteIconEl } from '../site-icons.js';
import './address.js'; // shown under the clean address

const $ = (id) => document.getElementById(id);
const root = document.documentElement;
const make = (tag, props = {}, children = []) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...[].concat(children));
  return e;
};
const helper = async (request) => {
  try {
    return (await chrome.runtime.sendMessage({ type: 'native', request })) ?? { ok: false };
  } catch {
    return { ok: false };
  }
};
const local = (key, value) => {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage is blocked; extension storage still has it.
  }
};

// ---- what is being chosen

const stored = await chrome.storage.local.get({ newtab: null, colours: null, lookOwnKeys: [], newtabBefore: null });
let prefs = readPrefs(stored.newtab);
// This window's own card places stay its own (owner, Nov 16 2026: what a session chose wins), and
// what it had is kept before the onboarding changes anything here (review 10, H15).
const ownKeys = new Set(Array.isArray(stored.lookOwnKeys) ? stored.lookOwnKeys : []);
if (!stored.newtabBefore && stored.newtab) chrome.storage.local.set({ newtabBefore: { at: Date.now(), newtab: stored.newtab, lookOwnKeys: [...ownKeys] } }).catch(() => {});
// The cards this update shows by default (owner, Nov 16 2026), switched on as well as placed (H16).
const DEFAULT_ON = ['closed', 'status', 'browsers', 'notes', 'todo'];
const withDefaultCards = (w) => ({ ...(w || {}), ...Object.fromEntries(DEFAULT_ON.map((k) => [k, true])) });
// One merge per onboarding run, not per write (review 10, H5): sessions merge once for this id.
// A later visit of the page keeps the id of the run that is already in global memory.
// Older global memory of this form has no run id: its version stands for it (as in followGlobal).
const known = await helper({ type: 'global-get' });
const runOf = (g) => (g?.look?.merge >= 2 ? g.look.mergeRun || g.version : null);
let mergeRun = runOf(known?.global) || Date.now();
// A window with nothing of its own yet starts from global memory, not from defaults (H17).
if (!stored.newtab && known?.global?.look?.newtab) prefs = readPrefs(known.global.look.newtab);
// The default cards, once, before the card screen is drawn: what the person then ticks or
// unticks there stands. A window that chose its own cards keeps them.
if (!ownKeys.has('widgets')) prefs.widgets = withDefaultCards(prefs.widgets);
let theme = 'moon-dark';
let colours = stored.colours; // {accent, bg} when the person made their own
let imported = false;
let bringShown = false;

// Onboarding's choices are the browser's: global memory (helper), read by every session.
// Written at most once a second while choosing (review 10, H5: every keystroke made a new version
// that every session merged again), and always when the onboarding is finished.
let globalTimer = null;
function keepGlobalSoon() {
  clearTimeout(globalTimer);
  globalTimer = setTimeout(keepGlobal, 1200);
}
async function keepGlobal() {
  clearTimeout(globalTimer);
  // An onboarding tab in another window that wrote first set the run: this one joins it, so
  // sessions merge once (review 10, H5).
  const now = await helper({ type: 'global-get' });
  mergeRun = runOf(now?.global) || mergeRun;
  // The default card layout of this update (owner, Nov 16 2026), for every session; the default
  // cards on for all even when this window chose its own.
  const newtab = { ...prefs, layout: DEFAULT_LAYOUT, widgets: ownKeys.has('widgets') ? withDefaultCards(prefs.widgets) : prefs.widgets };
  delete newtab.notes;
  delete newtab.todos;
  // merge 2: every session follows this once more, its own keys set aside (background.js followGlobal).
  await helper({ type: 'global-set', look: { newtab, colours: colours ?? null, merge: 2, mergeRun } });
}
function keepPrefs() {
  // This update's default cards here too, unless this window placed or chose its own.
  if (!ownKeys.has('layout')) prefs.layout = DEFAULT_LAYOUT;
  chrome.storage.local.set({ newtab: prefs });
  local('gamblium.newtab', JSON.stringify(prefs));
  keepGlobalSoon();
}
const pressed = (name) => document.querySelector(`input[name="${name}"]:checked`)?.value;

// ---- the look, on this page now and on the browser at its next start

function wear() {
  const s = root.style;
  for (const p of ['--bg', '--accent', '--hi']) s.removeProperty(p);
  if (colours?.bg) s.setProperty('--bg', colours.bg);
  if (colours?.accent) {
    s.setProperty('--accent', colours.accent);
    s.setProperty('--hi', colours.accent);
  }
  const look = colours?.bg ? lookOf(colours.bg) : theme === 'moon-light' ? 'light' : 'dark';
  root.dataset.look = look;
  // Own colours are neither of the two themes, so neither card is marked.
  for (const r of document.querySelectorAll('input[name="look"]')) r.checked = !colours && r.value === theme;
  return look;
}
async function keepLook() {
  const look = wear();
  await chrome.storage.local.set({ colours: colours ?? null });
  local('gamblium.colours', colours ? JSON.stringify(colours) : null);
  keepGlobal();
  // The preset decides the frame; with own colours the launcher derives it from them.
  helper({ type: 'brand-set', theme: look === 'light' ? 'moon-light' : 'moon-dark', darkPages: look === 'dark' && pressed('night') === 'yes' });
  paintDots();
}
for (const r of document.querySelectorAll('input[name="look"]')) {
  r.addEventListener('change', () => {
    theme = r.value;
    colours = null;
    keepLook();
  });
}
$('customise').addEventListener('click', () => {
  const open = $('own').hidden;
  $('own').hidden = !open;
  $('customise').ariaExpanded = String(open);
});
for (const [id, key] of [['ownAccent', 'accent'], ['ownBg', 'bg']]) {
  $(id).addEventListener('input', () => {
    colours = { ...(colours ?? {}), [key]: $(id).value };
    wear(); // follow the picker while it is dragged
  });
  $(id).addEventListener('change', keepLook);
}
$('ownReset').addEventListener('click', () => {
  colours = null;
  keepLook();
});
for (const r of document.querySelectorAll('input[name="night"]')) r.addEventListener('change', keepLook);

// ---- name: the top of a new tab, greeting you as you type

function paintHello() {
  const now = new Date();
  $('pHello').textContent = greeting(now.getHours(), prefs.name);
  $('pDate').textContent = now.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
  $('pTime').textContent = new Intl.DateTimeFormat([], timeOptions(prefs.clock)).format(now).replace(/\s?[AP]M$/i, '');
}
$('name').value = prefs.name;
$('name').addEventListener('input', () => {
  prefs.name = $('name').value.trim().slice(0, 30);
  keepPrefs();
  paintHello();
});

// ---- search engine

$('engines').replaceChildren(...ENGINES.map((e, i) => {
  const box = make('input', { type: 'radio', name: 'engine', value: e.id, checked: prefs.search ? prefs.search === e.id : i === 0 });
  box.addEventListener('change', () => {
    prefs.search = e.id;
    keepPrefs();
  });
  const mark = siteIcon(e.url);
  const badge = make('span', { className: 'mono', ariaHidden: 'true' }, mark ? [siteIconEl(mark, 24)] : []);
  if (!mark) badge.textContent = e.name[0];
  return make('label', { className: 'option' }, [box, make('span', { className: 'oname', textContent: e.name }), badge]);
}));
$('openSearch').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://settings/search' }));

// ---- sites you use most: they become tiles on the new tab page

$('starters').replaceChildren(...STARTERS.map((site) => {
  const box = make('input', { type: 'checkbox', checked: isPinned(prefs.pins, site.url) });
  box.addEventListener('change', () => {
    prefs.pins = togglePin(prefs.pins, site, box.checked);
    keepPrefs();
  });
  const mark = siteIcon(site.url);
  const badge = make('span', { className: 'mono', ariaHidden: 'true' }, mark ? [siteIconEl(mark, 24)] : []);
  if (!mark) badge.textContent = site.title[0];
  return make('li', {}, make('label', {}, [box, badge, site.title, make('span', { className: 'tick', ariaHidden: 'true' })]));
}));

// ---- the new tab page

const CHOICE = WIDGETS.filter((w) => w.id !== 'clock' && w.id !== 'pins'); // the greeting and quick access are always there to start with
$('parts').replaceChildren(...CHOICE.map((w) => {
  const box = make('input', { type: 'checkbox', checked: prefs.widgets[w.id] });
  box.addEventListener('change', () => {
    prefs.widgets[w.id] = box.checked;
    keepPrefs();
  });
  return make('li', {}, make('label', { title: w.hint }, [box, w.label]));
}));
for (const r of document.querySelectorAll('input[name="clock"]')) {
  r.checked = r.value === prefs.clock;
  r.addEventListener('change', () => {
    prefs.clock = r.value;
    keepPrefs();
    paintHello();
  });
}

// ---- the screens

const SCREENS = {
  name: { title: 'What should I call you?', line: 'Only to greet you on new tabs. Your name stays on this computer.' },
  look: { title: 'Pick your light.', line: 'Try both. The whole page changes as you choose.' },
  night: { title: 'Should white websites go dark too?', line: 'Some sites only come in white. Gamblium can darken them for you.' },
  search: { title: 'Pick your search.', line: 'Used by the search box on every new tab.' },
  sites: { title: 'Choose the sites you use most.', line: 'They become tiles on your new tab, one click away.' },
  import: { title: 'Bring your things?', line: 'Passwords, addresses and autofill, bookmarks and history can come over from Chrome, Edge or Firefox in one click. Or press Next to start fresh.' },
  newtab: { title: 'Set up your new tab.', line: 'Pick what you want to see each time. Change it any time from the square at the bottom right of a new tab.' },
  done: { title: 'Ready.', line: 'The window\'s frame and tabs take the new look the next time Gamblium starts.', next: 'Open a new tab' },
};
/** The screens in order. The question about white websites is only asked for a dark look. */
const order = () => Object.keys(SCREENS).filter((id) => id !== 'night' || root.dataset.look === 'dark');
let at = 'name';

function paintDots() {
  const ids = order();
  // One dot per question; the last screen ("It is yours.") is not a question, so it has no dot and no number.
  $('dots').replaceChildren(...ids.filter((id) => id !== 'done').map((id) => make('li', { className: id === at || at === 'done' ? 'on' : '' })));
  const n = ids.indexOf(at);
  $('count').textContent = at === 'done' ? 'All set' : `${n + 1} of ${ids.length - 1}`;
}
function show(id) {
  at = id;
  const s = SCREENS[id];
  for (const step of document.querySelectorAll('.step')) step.hidden = step.dataset.id !== id;
  $('title').textContent = id === 'done' && prefs.name ? `Ready, ${prefs.name}.` : s.title;
  $('line').textContent = s.line;
  $('next').textContent = s.next ?? 'Next';
  $('back').disabled = order()[0] === id;
  $('said').textContent = '';
  if (id === 'done') paintSummary();
  if (id === 'import' && !bringShown) {
    bringShown = true;
    import('./bring.js').then((m) => m.renderBring($('bringBox')));
    // The summary at the end says whether the importer was opened.
    $('bringBox').addEventListener('click', (e) => { if (e.target.closest('.bring-import')) imported = true; });
  }
  paintDots();
  (id === 'name' ? $('name') : $('title')).focus();
}
/** A row of small chips, each a name with its mark when there is one. */
const chips = (items) => make('span', { className: 'chips' }, items.map(([text, mark]) => make('span', { className: 'chip' }, [...(mark ? [siteIconEl(mark, 14)] : []), text])));
function paintSummary() {
  const look = root.dataset.look;
  const on = WIDGETS.filter((w) => prefs.widgets[w.id]).map((w) => w.label);
  const rows = [
    ['Look', colours ? `Your own colours (${look})` : look === 'light' ? 'Moonlight · light' : 'Moonlight · dark'],
    ...(look === 'dark' ? [['Websites', pressed('night') === 'yes' ? 'White ones are made dark' : 'Left as they are']] : []),
    ['Search', ENGINES.find((e) => e.id === prefs.search)?.name ?? 'The browser\'s own'],
    ['Pinned', prefs.pins.length ? chips(prefs.pins.map((p) => [p.title, siteIcon(p.url)])) : 'Nothing yet'],
    ['Imported', imported ? 'You opened the importer' : 'Nothing. Settings has it when you want it.'],
    ['New tab', on.length ? chips(on.map((t) => [t])) : 'Just the search box'],
  ];
  $('summary').replaceChildren(...rows.map(([k, v]) => make('li', {}, [make('span', { textContent: k }), typeof v === 'string' ? make('span', { textContent: v }) : v])));
}

const done = () => chrome.storage.local.set({ onboarded: true });
async function finish() {
  // Finished with nothing changed still writes global memory: otherwise the onboarding came back
  // at every start, for good (review 10, H2).
  await keepGlobal();
  await done();
  location.replace(chrome.runtime.getURL('newtab/index.html'));
}
async function forward() {
  if (at === 'done') return finish();
  if (at === 'search' && !prefs.search) {
    prefs.search = pressed('engine') ?? '';
    keepPrefs();
  }
  const ids = order();
  show(ids[ids.indexOf(at) + 1]);
}
$('next').addEventListener('click', forward);
$('back').addEventListener('click', () => {
  const ids = order();
  show(ids[Math.max(0, ids.indexOf(at) - 1)]);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.id === 'name') forward();
});
$('restart').addEventListener('click', async () => {
  await done();
  const r = await helper({ type: 'restart' });
  if (r.ok === false) $('said').textContent = 'Gamblium could not restart itself. Close it and open it again to see the new look on the window.';
});

wear();
paintHello();
show('name');

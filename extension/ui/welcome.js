// First run: one decision per screen. What is asked sits on the left of the
// card, the choices on the right. Opened once per profile by the background
// while storage "onboarded" is not true. Every choice is saved the moment it
// is made, so closing the tab loses nothing; "onboarded" is set when the
// person finishes or skips.
import { readPrefs, greeting, timeOptions, isPinned, togglePin, WIDGETS, ENGINES, STARTERS } from '../newtab/logic.js';
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

const stored = await chrome.storage.local.get({ newtab: null, colours: null });
let prefs = readPrefs(stored.newtab);
let theme = 'moon-dark';
let colours = stored.colours; // {accent, bg} when the person made their own
let imported = false;
let bringShown = false;

function keepPrefs() {
  chrome.storage.local.set({ newtab: prefs });
  local('gamblium.newtab', JSON.stringify(prefs));
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
  import: { title: 'Bring your things?', line: 'Bookmarks, history and saved passwords can come over from Chrome, Edge or Firefox. Below: where you are signed in elsewhere, to sign in here too.' },
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
    import('./bring.js').then((m) => m.renderBring($('bringBox'), { compact: true }));
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
  await done();
  location.replace(chrome.runtime.getURL('newtab/index.html'));
}
async function forward() {
  if (at === 'done') return finish();
  if (at === 'search' && !prefs.search) {
    prefs.search = pressed('engine') ?? '';
    keepPrefs();
  }
  if (at === 'import' && pressed('import') === 'yes' && !imported) {
    imported = true;
    await chrome.tabs.create({ url: 'chrome://settings/importData', active: true });
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

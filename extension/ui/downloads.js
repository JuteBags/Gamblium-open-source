// Downloads: the list with its controls, and the folder rules.
// The list is re-read once a second only while something is downloading and
// the page is showing. Otherwise it is read on load and after each action.
import { $, send, el, td, button, say, whileVisible } from './page.js';
import { DOWNLOAD_DEFAULTS, OWN_DEFAULTS } from '../download-rules.js';
import { fmtAgo, downloadView, anyInProgress, rulesFromRows, DOWNLOAD_ACTION_NAMES, WHENS, FILE_KINDS, filterDownloads, fileKind, baseName, dlFold, dlView, dlActive, DL_ACTION_NAMES, dlDetail, fmtSize } from './pages-logic.js';

// ---- The list -------------------------------------------------------------------

let list = [];
// Rows on their way out, waiting out their Undo: 'b:<id>' for the browser's rows, the job id for ours.
const UNDO_MS = 6000;
const leaving = new Map(); // key -> { action, timer, run? }
const filter = { kind: 'all', when: 'all', query: '' };

// The filters: a word, when, and what kind of file. Each kind shows how many files it holds.
function renderFilters() {
  const seg = (node, options, key, label) => node.replaceChildren(...options.map((o) => {
    const b = button('', () => {
      filter[key] = o.id;
      renderFilters();
      render();
    });
    b.append(...[].concat(label(o)));
    b.setAttribute('aria-pressed', String(filter[key] === o.id));
    return b;
  }));
  seg($('whens'), WHENS, 'when', (o) => o.label);
  $('kinds').hidden = list.length === 0;
  const counts = {};
  for (const d of list) counts[fileKind(baseName(d.filename) || d.url)] = (counts[fileKind(baseName(d.filename) || d.url)] || 0) + 1;
  seg($('kinds'), FILE_KINDS.filter((k) => k.id === 'all' || counts[k.id] || filter.kind === k.id), 'kind', (o) => [o.label, el('span', { className: 'n', textContent: String(o.id === 'all' ? list.length : counts[o.id] || 0) })]);
}

function render() {
  const shown = filterDownloads(list, filter).filter((d) => !leaving.has('b:' + d.id));
  $('none').hidden = list.length > 0;
  // Nothing to filter yet: no search box and no date or kind chips.
  $('dq').parentElement.hidden = list.length === 0; // the search box and the date chips share one row
  $('kinds').hidden = list.length === 0;
  $('nomatch').hidden = !(list.length > 0 && shown.length === 0);
  $('table').hidden = shown.length === 0;
  paintLine();
  const now = Date.now();
  // Leave the rows alone while someone is tabbing through their buttons.
  if ($('rows').contains(document.activeElement)) return;
  $('rows').replaceChildren(
    ...shown.map((d) => {
      const v = downloadView(d);
      const status = [el('span', { className: v.tone && v.tone !== 'run' ? `pill t-${v.tone}` : '', textContent: v.status })];
      if (v.percent !== null) status.push(el('span', { className: `progress t-${v.tone}`, role: 'progressbar', ariaValueNow: String(v.percent), ariaLabel: `${v.percent}% downloaded` }, el('i', { style: `width:${v.percent}%` })));
      return el('tr', {}, [
        td([el('span', { className: 'finding', textContent: v.name }), el('span', { className: 'sub', textContent: v.host })], 'clip'),
        td(status),
        td(v.size, 'num'),
        td(fmtAgo(Date.parse(d.startTime), now), 'fit muted'),
        td(v.actions.map((a) => button(DOWNLOAD_ACTION_NAMES[a], () => act(d.id, a), 'quiet')), 'actions'),
      ]);
    }),
  );
}

async function read() {
  const r = await send({ type: 'downloads-list', limit: 100 });
  if (!Array.isArray(r)) return say($('said'), 'bad', r?.error || 'The download list could not be read.');
  list = r;
  renderFilters();
  render();
}

$('dq').addEventListener('input', () => {
  filter.query = $('dq').value;
  render();
});

// ---- Gamblium's own downloader ---------------------------------------------------
// The helper runs gamblium-dl and keeps each job as dlFold would (see
// pages-logic.js): dl-list -> { ok, jobs: [...] }, dl-action { id, action }.
// A helper without it answers ok:false and this part of the page stays away.
// downloads.html?demo shows made-up jobs, to look at the rows.
const demo = new URLSearchParams(location.search).has('demo');
let jobs = [];
let fast = false; // the helper has the downloader
const ENDING = new Set(['cancel', 'remove']);
let opened = null; // the id of the job whose details show
let allPeers = false; // every peer, not the busiest dozen
let fullAddrs = false; // peers' whole addresses, not masked
const PEERS_SHOWN = 12;
const GLYPH = {
  http: 'M10 3.500v9M6.500 9.300 10 12.800l3.500-3.500M4 16.500h12',
  torrent: 'M10 6.500a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM4.500 17a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM15.500 17a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM9 6.300 5.500 13.200M11 6.300l3.500 6.900M6.500 15h7',
};
function glyph(kind) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  for (const [k, v] of Object.entries({ width: 20, height: 20, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.4, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(k, v);
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', GLYPH[kind] ?? GLYPH.http);
  svg.append(p);
  return svg;
}

// One job opened: figures, then for a torrent its peers as dots down a line (the bigger the dot,
// the more that peer gave us) and its files. Drawn again whenever the list is read; nothing animates.
function detail(j) {
  const d = dlDetail(j);
  const parts = [el('dl', { className: 'jfigs' }, d.figures.map(([name, value]) => el('div', {}, [el('dt', { textContent: name }), el('dd', { className: 'num', textContent: value })])))];
  const toggle = (label, on, flip) => {
    const b = button(label, () => { flip(); document.activeElement?.blur(); renderJobs(true); }, 'quiet');
    b.setAttribute('aria-pressed', String(on));
    return b;
  };
  if (d.torrent) {
    const shown = allPeers ? d.peers : d.peers.slice(0, PEERS_SHOWN);
    const head = el('div', { className: 'jhead' }, [el('h3', { textContent: d.peers.length ? `Peers (${d.peers.length})` : 'Peers' })]);
    if (d.peers.length) head.append(toggle(fullAddrs ? 'Hide addresses' : 'Show addresses', fullAddrs, () => { fullAddrs = !fullAddrs; }));
    parts.push(head);
    if (!d.peers.length) parts.push(el('p', { className: 'hint', textContent: j.state === 'starting' ? 'Looking for peers.' : 'No peer is connected right now.' }));
    else {
      parts.push(el('ol', { className: 'peers' }, shown.map((p) => {
        const li = el('li', { className: 'peer' }, [
          el('span', { className: 'dot', style: `--share:${p.share.toFixed(3)}` }),
          el('span', { className: 'paddr mono', textContent: fullAddrs ? p.addr : p.masked, title: fullAddrs ? '' : 'Whole address: switch on "Show addresses"' }),
          el('span', { className: 'pclient', textContent: p.client }),
          el('span', { className: 'pstate', textContent: p.word === 'Connected' ? '' : p.word }),
          el('span', { className: 'pgave num', textContent: p.down > 0 ? `gave ${fmtSize(p.down)}` : '' }),
          el('span', { className: 'ptook num', textContent: p.up > 0 ? `took ${fmtSize(p.up)}` : '' }),
        ]);
        li.dataset.kind = p.kind;
        return li;
      })));
      if (d.peers.length > PEERS_SHOWN) parts.push(el('div', {}, toggle(allPeers ? `Show the busiest ${PEERS_SHOWN}` : `Show all ${d.peers.length}`, allPeers, () => { allPeers = !allPeers; })));
    }
    if (d.files.length) {
      parts.push(el('div', { className: 'jhead' }, el('h3', { textContent: d.files.length === 1 ? 'File' : `Files (${d.files.length})` })));
      parts.push(el('ul', { className: 'jfiles' }, d.files.map((f) => el('li', {}, [
        el('span', { className: 'fname', textContent: f.name, title: f.name }),
        el('span', { className: 'jbar', role: 'progressbar', ariaValueNow: String(f.percent), ariaLabel: `${f.percent}% of ${f.name}` }, el('i', { style: `width:${f.percent}%` })),
        el('span', { className: 'fsize num', textContent: f.percent === 100 ? fmtSize(f.size) : `${fmtSize(f.done)} of ${fmtSize(f.size)}` }),
      ]))));
    }
  } else if (d.url) parts.push(el('p', { className: 'jpath mono', textContent: d.url }));
  if (d.saved) parts.push(el('p', { className: 'jpath', textContent: `Saved to ${d.saved}` }));
  return el('div', { className: 'jdetail' }, parts);
}

/** The line under the title counts both lists: the browser's downloads and Gamblium's downloader's. */
function paintLine() {
  const all = list.length + jobs.length;
  const running = list.filter((d) => d.state === 'in_progress').length + jobs.filter((j) => ['starting', 'downloading'].includes(j.state)).length;
  // Nothing at all: the card says so once; the line under the title stays empty.
  $('line').textContent = !all ? '' : running ? `${running} in progress, ${all} in the list.` : `${all} in the list, none in progress.`;
}

function renderJobs(available) {
  paintLine();
  $('fast').hidden = !jobs.length; // the card is for its jobs; what it does is in Settings
  if ($('jobs').contains(document.activeElement)) return; // someone is tabbing through the buttons
  $('jobs').replaceChildren(...jobs.filter((j) => !leaving.has(j.id)).map((j) => {
    const v = dlView(j);
    const bar = el('span', { className: 'jbar', role: 'progressbar', ariaLabel: v.percent === null ? 'Size not known yet' : `${v.percent}% downloaded` }, el('i', { style: `width:${v.percent ?? 100}%` }));
    if (v.percent !== null) bar.ariaValueNow = String(v.percent);
    const open = opened === j.id;
    const more = button(open ? 'Less' : 'Details', () => { opened = open ? null : j.id; allPeers = false; document.activeElement?.blur(); renderJobs(true); }, 'quiet');
    more.setAttribute('aria-expanded', String(open));
    const li = el('li', { className: 'job' }, [
      el('span', { className: 'jkind' }, glyph(j.kind)),
      el('div', { className: 'jmain' }, [
        el('div', { className: 'jtop' }, [el('span', { className: 'jname', textContent: v.name, title: j.path || j.url || v.name }), el('span', { className: `pill ${v.cls}`.trim(), textContent: v.word }), ...v.facts.map((f) => el('span', { className: 'fact', textContent: f }))]),
        bar,
        el('div', { className: 'jline num', textContent: v.line.join(' · ') }),
      ]),
      // The ending ones (cancel, remove) come last, after Details, away from the everyday ones.
      el('div', { className: 'jacts' }, [...v.actions.filter((a) => !ENDING.has(a)).map((a, i) => button(DL_ACTION_NAMES[a], () => jobAct(j.id, a), i === 0 && ['resume', 'retry', 'open'].includes(a) ? '' : 'quiet')), more, ...v.actions.filter((a) => ENDING.has(a)).map((a) => button(DL_ACTION_NAMES[a], () => jobAct(j.id, a), 'quiet ending'))]),
      ...(open ? [detail(j)] : []),
    ]);
    // A click anywhere on the row that is not a button or selected text opens it too.
    li.addEventListener('click', (e) => {
      if (e.target.closest('button, a, .jdetail') || String(getSelection())) return;
      more.click();
    });
    if (open) li.dataset.open = '';
    li.dataset.state = j.state;
    li.dataset.kind = j.kind ?? 'http';
    if (v.percent === null) li.dataset.unknown = '';
    return li;
  }));
}

async function readJobs() {
  if (demo) {
    if (!jobs.length) jobs = DEMO_JOBS();
    return renderJobs(true);
  }
  const r = await send({ type: 'native', request: { type: 'dl-list' } });
  const ok = r?.ok !== false && Array.isArray(r?.jobs);
  jobs = ok ? r.jobs : [];
  fast = ok;
  renderJobs(ok);
}

// Cancel and Remove wait a few seconds with an Undo, instead of acting on the first click.
async function jobAct(id, action) {
  if (ENDING.has(action) && !leaving.has(id)) {
    const j = jobs.find((x) => x.id === id);
    const name = j?.name || baseName(j?.path) || 'The download';
    const timer = setTimeout(() => { leaving.delete(id); hideToast(); jobDo(id, action); }, UNDO_MS);
    leaving.set(id, { action, timer });
    showToast(`${action === 'cancel' ? 'Cancelled' : 'Removed'} ${name}.`, () => {
      clearTimeout(leaving.get(id)?.timer);
      leaving.delete(id);
      renderJobs(true);
    });
    document.activeElement?.blur();
    return renderJobs(true);
  }
  return jobDo(id, action);
}
function showToast(text, undo) {
  let t = $('toast');
  if (!t) {
    t = el('div', { id: 'toast', className: 'toast', role: 'status' });
    document.body.append(t);
  }
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
// Leaving the page while an Undo is open: what was asked is done, not lost.
addEventListener('pagehide', () => { for (const [id, l] of leaving) { clearTimeout(l.timer); l.run ? l.run() : jobDo(id, l.action); } leaving.clear(); });

async function jobDo(id, action) {
  if (demo) {
    // Enough to see the rows change: pause and resume flip, remove and cancel drop the row.
    jobs = jobs.flatMap((j) => (j.id !== id ? [j] : action === 'pause' ? [{ ...j, state: 'paused' }] : action === 'resume' ? [{ ...j, state: 'downloading' }] : ['remove', 'cancel'].includes(action) ? [] : [j]));
    document.activeElement?.blur();
    return renderJobs(true);
  }
  const r = await send({ type: 'native', request: { type: 'dl-action', id, action } });
  say($('fastSaid'), r?.ok === false ? 'bad' : '', r?.ok === false ? r.error || 'That did not work.' : '');
  document.activeElement?.blur();
  refresh();
}

/** Made-up peers for ?demo, from the address ranges kept for examples. */
function DEMO_PEERS(n) {
  const clients = ['qBittorrent 5.0.2', 'Transmission 4.0.6', 'libtorrent 2.0.11', 'Deluge 2.1.1', 'rqbit 9.1', null, 'aria2 1.37.0'];
  return Array.from({ length: n }, (_, i) => {
    const down = i < 9 ? Math.round(310_000_000 / (i + 1) ** 1.3) : i < 14 ? Math.round(4_000_000 / (i - 7)) : 0;
    const up = i % 5 === 1 ? 18_000_000 - i * 400_000 : i > 20 && i % 4 === 0 ? 3_000_000 : 0;
    const addr = i % 6 === 4 ? `[2001:db8:${(i * 517).toString(16)}::${(i * 91).toString(16)}]:6881` : `${['203.0.113', '198.51.100', '192.0.2'][i % 3]}.${(i * 37) % 250 + 2}:${51413 - i * 7}`;
    return { addr, client: clients[i % clients.length], state: i > 30 ? 'queued' : i > 27 ? 'connecting' : 'live', down, up: Math.max(0, up) };
  });
}

/** Made-up jobs for ?demo, built from the lines gamblium-dl prints. */
function DEMO_JOBS() {
  const run = (base, ...lines) => lines.reduce(dlFold, base);
  return [
    run({ id: 'a', url: 'https://releases.example.org/ubuntu-26.04-desktop-amd64.iso' },
      { event: 'source-failed', error: 'refused' },
      { event: 'start', path: 'C:\\Users\\you\\Downloads\\ubuntu-26.04-desktop-amd64.iso', size: 6_100_000_000, split: true, sources: 3 },
      { event: 'resume', have: 1_200_000_000 },
      { event: 'progress', done: 2_560_000_000, total: 6_100_000_000, speed: 10_800_000, connections: 8 }),
    run({ id: 'b', url: 'https://slow.example.net/dataset.tar.zst' },
      { event: 'start', path: 'C:\\Users\\you\\Downloads\\dataset.tar.zst', size: 940_000_000, split: false, sources: 1 },
      { event: 'progress', done: 310_000_000, total: 940_000_000, speed: 1_900_000, connections: 1 }),
    { ...run({ id: 'c', url: 'https://cdn.example.com/video-course.zip' },
      { event: 'start', path: 'C:\\Users\\you\\Downloads\\video-course.zip', size: 2_300_000_000, split: true, sources: 1 },
      { event: 'progress', done: 700_000_000, total: 2_300_000_000, speed: 0, connections: 4 }), state: 'paused' },
    { ...run({ id: 'd', kind: 'torrent' },
      { event: 'start', path: 'C:\\Users\\you\\Downloads\\debian-13.2.0-amd64-DVD-1', size: 3_900_000_000, sources: 1 },
      { event: 'progress', done: 1_450_000_000, total: 3_900_000_000, speed: 8_700_000, peers: 41, seeds: 17, up: 620_000, uploaded: 96_000_000 }),
    peerList: DEMO_PEERS(41), files: [
      { name: 'debian-13.2.0-amd64-DVD-1.iso', size: 3_899_000_000, done: 1_449_600_000 },
      { name: 'SHA256SUMS', size: 600_000, done: 400_000 },
      { name: 'SHA256SUMS.sign', size: 400_000, done: 0 }] },
    { ...run({ id: 'e', kind: 'torrent' },
      { event: 'done', path: 'C:\\Users\\you\\Downloads\\archlinux-2026.11.01-x86_64.iso', bytes: 1_250_000_000, seconds: 140, speed: 8_900_000 },
      { event: 'seeding', uploaded: 1_800_000_000, ratio: 1.44, peers: 6, up: 240_000 }),
    peerList: DEMO_PEERS(6).map((p) => ({ ...p, down: 0 })), files: [{ name: 'archlinux-2026.11.01-x86_64.iso', size: 1_250_000_000, done: 1_250_000_000 }] },
    run({ id: 'f', url: 'https://mirror.example.org/firmware.bin' },
      { event: 'done', path: 'C:\\Users\\you\\Downloads\\firmware.bin', bytes: 84_000_000, seconds: 9, speed: 9_300_000, connections: 4 }),
    run({ id: 'g', url: 'https://old.example.org/backup-2019.7z' },
      { event: 'start', path: 'C:\\Users\\you\\Downloads\\backup-2019.7z', size: 410_000_000, split: true, sources: 1 },
      { event: 'progress', done: 96_000_000, total: 410_000_000, speed: 2_000_000, connections: 2 },
      { event: 'error', error: 'No byte arrived for 60 seconds.' }),
  ];
}

const refresh = whileVisible(async () => {
  await Promise.all([read(), readJobs()]);
}, 1000, () => anyInProgress(list) || (!demo && dlActive(jobs)));

// The browser's own rows take the same Undo as the downloader's (interaction spec, rule 5):
// Cancel and Remove from list leave the list at once and act after a few seconds.
async function act(id, action) {
  const key = 'b:' + id;
  if (['cancel', 'erase'].includes(action) && !leaving.has(key)) {
    const d = list.find((x) => x.id === id);
    const name = baseName(d?.filename) || d?.url || 'The download';
    const timer = setTimeout(() => { leaving.delete(key); hideToast(); actNow(id, action); }, UNDO_MS);
    leaving.set(key, { action, timer, run: () => actNow(id, action) });
    showToast(`${action === 'cancel' ? 'Cancelled' : 'Removed'} ${name}.`, () => {
      clearTimeout(leaving.get(key)?.timer);
      leaving.delete(key);
      render();
    });
    document.activeElement?.blur();
    return render();
  }
  return actNow(id, action);
}
async function actNow(id, action) {
  const r = await send({ type: 'downloads-action', id, action });
  if (r.ok === false) say($('said'), 'bad', r.error);
  else say($('said'), '', '');
  document.activeElement?.blur();
  refresh();
}

$('startForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = $('url').value.trim();
  const magnet = /^magnet:\?\S+$/i.test(url);
  if (!magnet && !/^https?:\/\/\S+$/i.test(url)) return say($('said'), 'bad', 'Paste a full address that starts with http:// or https://, or a magnet link.');
  if (magnet && !fast) return say($('said'), 'bad', 'Magnet links need Gamblium\'s downloader, which is not answering.');
  // What is pasted here goes to our own downloader when it is there; the browser's otherwise.
  const r = fast ? await send({ type: 'native', request: { type: 'dl-start', url } }) : await send({ type: 'downloads-start', url });
  if (r.ok === false) return say($('said'), 'bad', r.error);
  say($('said'), '', '');
  $('url').value = '';
  refresh();
});


// A download started from a page, not from here, should show up too.
chrome.downloads.onCreated.addListener(() => refresh());
chrome.downloads.onChanged.addListener((delta) => {
  if (delta.state || delta.paused || delta.exists) refresh();
});

// ---- Folder rules ---------------------------------------------------------------

function ruleRow(rule = { folder: '', extensions: [], hosts: [] }) {
  const input = (value, label, placeholder) => {
    const i = el('input', { type: 'text', value, ariaLabel: label, placeholder, spellcheck: false });
    i.addEventListener('change', saveRules);
    return i;
  };
  const tr = el('tr', {}, [
    td(input(rule.folder, 'Folder', 'Folder name')),
    td(input((rule.extensions || []).join(', '), 'File types', 'pdf, docx')),
    td(input((rule.hosts || []).join(', '), 'Only from these sites', 'any site')),
    td(button('Remove', () => { tr.remove(); saveRules(); }, 'quiet ending'), 'actions'),
  ]);
  return tr;
}

function showRules(rules) {
  $('rules').replaceChildren(...rules.map(ruleRow));
}

async function saveRules() {
  const rows = [...$('rules').children].map((tr) => {
    const [folder, extensions, hosts] = [...tr.querySelectorAll('input')].map((i) => i.value);
    return { folder, extensions, hosts };
  });
  const r = rulesFromRows(rows);
  $('rulesError').hidden = r.ok;
  if (!r.ok) {
    $('rulesError').textContent = `Not saved yet. ${r.error}`;
    $('rulesSaved').textContent = '';
    return;
  }
  await chrome.storage.local.set({ rules: r.rules });
  $('rulesSaved').textContent = 'Saved';
  // Show what was stored ("https://github.com/x" became "github.com"), in place,
  // so the box being typed in next keeps its cursor.
  const filled = [...$('rules').children].filter((tr) => [...tr.querySelectorAll('input')].some((i) => i.value.trim()));
  filled.forEach((tr, n) => {
    const [folder, extensions, hosts] = tr.querySelectorAll('input');
    const rule = r.rules[n];
    if (document.activeElement !== folder) folder.value = rule.folder;
    if (document.activeElement !== extensions) extensions.value = rule.extensions.join(', ');
    if (document.activeElement !== hosts) hosts.value = rule.hosts.join(', ');
  });
}

const paintRouting = () => {
  const on = $('routing').checked;
  $('dlSettings').classList.toggle('rulesoff', !on);
};

// The settings panel: opened from the icon by the title, closed by Close, Esc or the icon again.
function settingsOpen(open) {
  $('dlSettings').hidden = !open;
  $('dlGear').setAttribute('aria-expanded', String(open));
  if (open) $('routing').focus();
  else $('dlGear').focus();
}
$('dlGear').addEventListener('click', () => settingsOpen($('dlSettings').hidden));
$('dlSettingsClose').addEventListener('click', () => settingsOpen(false));
$('dlSettings').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); settingsOpen(false); } });
if (location.hash === '#settings') settingsOpen(true);
$('routing').addEventListener('change', async () => {
  paintRouting();
  await chrome.storage.local.set({ routingEnabled: $('routing').checked });
  $('rulesSaved').textContent = 'Saved';
});
$('addRule').addEventListener('click', () => {
  const tr = ruleRow();
  $('rules').append(tr);
  tr.querySelector('input').focus();
});
// Going back replaces the person's own rules, so it says so with an Undo.
$('resetRules').addEventListener('click', async () => {
  const before = (await chrome.storage.local.get({ rules: DOWNLOAD_DEFAULTS.rules })).rules;
  showRules(DOWNLOAD_DEFAULTS.rules);
  await saveRules();
  showToast('Back to the built-in rules.', async () => { showRules(before); await saveRules(); });
  setTimeout(hideToast, UNDO_MS);
});

const stored = { ...DOWNLOAD_DEFAULTS, ...(await chrome.storage.local.get(DOWNLOAD_DEFAULTS)) };
$('routing').checked = stored.routingEnabled;
paintRouting();
showRules(stored.rules);
paintRouting();

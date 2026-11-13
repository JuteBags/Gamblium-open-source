// Tabs and memory: a tab manager. The map shows every tab as a block as wide
// as the memory it holds; the table below is filtered, grouped by window and
// worked through with the mouse or the keyboard. Reads every 5 s while the
// page is showing and not at all while it is hidden, so an open dashboard in
// a background tab costs nothing.
import { $, send, el, td, pill, button, whileVisible } from './page.js';
import {
  fmtMb, fmtPct, fmtDelay, siteLabel, stateOf, countStates, statesLine, tabPill, sortTabs, meterPct, weightOf, freeLevel, cpuLevel, WEIGHT_MB, kindRows, reasonRows,
  filterTabs, mapBlocks, groupByWindow,
} from './pages-logic.js';

let sortKey = 'memory';
let sortDesc = true;
let rows = [];
let query = '';
let show = 'all'; // all | awake | frozen | asleep
const picked = new Set();

// Without the helper there are no numbers, but the tabs and their states still show.
function rowsFromTabs(tabs) {
  return tabs.map((t) => ({
    tabId: t.id, windowId: t.windowId, title: t.title || '', url: t.url || '', state: stateOf(t),
    active: !!t.active, audible: !!t.audible, memoryMb: null, cpuPct: null, shared: false,
  }));
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const nameOf = (r) => r.title || r.url || 'Untitled';

// What each state means, on the legend's tooltip instead of a paragraph under the table.
const STATE_TIPS = {
  awake: 'Running normally.',
  frozen: 'Keeps its memory, uses no processor time, comes back at once.',
  asleep: 'Gave its memory back; reloads when you open it.',
};

function renderFacts(counts, stats, status) {
  const total = stats.ok ? stats.total : null;
  const free = stats.ok ? stats.systemAvailableMb : status.availableMb;
  const s = status.settings;
  const rule = !s ? ''
    : !s.enabled ? 'Automatic sleep is off'
    : status.delaySecNow < s.delaySec ? `Short on memory: hidden tabs sleep after ${fmtDelay(status.delaySecNow)}`
    : `Hidden tabs sleep after ${fmtDelay(s.delaySec)}`;
  $('line').textContent = [statesLine(counts), rule].filter(Boolean).join(' · ');
  $('fTabs').textContent = String(counts.total);
  const heavy = rows.filter((r) => r.state === 'awake' && weightOf(r.memoryMb) === 'heavy').length;
  $('fLegend').replaceChildren(
    ...['awake', 'frozen', 'asleep'].map((k) => el('li', { className: k, textContent: `${counts[k]} ${k}`, title: STATE_TIPS[k] })),
    ...(heavy ? [el('li', { className: 'heavy', textContent: `${heavy} heavy (${WEIGHT_MB.heavy} MB+)` })] : []),
  );
  $('fMem').textContent = fmtMb(total?.memoryMb);
  $('fMemSub').textContent = total ? `in ${total.processes} processes` : '';
  $('fCpu').textContent = fmtPct(total?.cpuPct);
  $('fCpu').dataset.level = cpuLevel(total?.cpuPct);
  $('fCpuSub').textContent = total && total.cpuPct === null ? 'measuring…' : 'of one core, last few seconds';
  $('fFree').textContent = fmtMb(free);
  $('fFree').dataset.level = freeLevel(free);
  $('fFreeSub').textContent = '';
}

// One block per tab. Clicking a block finds that tab's row in the table.
function renderMap() {
  const blocks = mapBlocks(rows).map((b) => {
    const r = b.row;
    const label = `${nameOf(r)}, ${r.state}${r.memoryMb === null ? '' : ', ' + fmtMb(r.memoryMb)}`;
    const node = el('button', { type: 'button', className: `block ${r.state}`, title: label });
    node.dataset.weight = weightOf(r.memoryMb);
    node.setAttribute('role', 'listitem');
    node.setAttribute('aria-label', label);
    node.style.flexGrow = String(b.grow);
    if (b.wide) node.append(el('span', { textContent: nameOf(r) }), el('b', { textContent: fmtMb(r.memoryMb) }));
    node.addEventListener('click', () => find(r.tabId));
    return node;
  });
  $('map').replaceChildren(...blocks);
}

function find(tabId) {
  if (!filterTabs(rows, { query, state: show }).some((r) => r.tabId === tabId)) {
    query = '';
    show = 'all';
    $('q').value = '';
    renderTabs();
  }
  const tr = $('rows').querySelector(`tr[data-tab="${tabId}"]`);
  if (!tr) return;
  tr.scrollIntoView({ block: 'center', behavior: 'smooth' });
  tr.querySelector('a.tablink')?.focus();
}

function renderStates(counts) {
  const options = [['all', 'All', counts.total], ['awake', 'Awake', counts.awake], ['frozen', 'Frozen', counts.frozen], ['asleep', 'Asleep', counts.asleep]];
  $('states').replaceChildren(...options.map(([key, label, n]) => {
    const b = el('button', { type: 'button' }, [label, el('span', { className: 'n', textContent: String(n) })]);
    b.setAttribute('aria-pressed', String(show === key));
    b.addEventListener('click', () => {
      show = key;
      renderTabs();
    });
    return b;
  }));
}

function renderBulk(shown) {
  for (const id of [...picked]) if (!rows.some((r) => r.tabId === id)) picked.delete(id);
  $('bulk').hidden = picked.size === 0;
  $('picked').textContent = `${picked.size} selected`;
  const all = $('pickAll');
  all.checked = shown.length > 0 && shown.every((r) => picked.has(r.tabId));
  all.indeterminate = !all.checked && shown.some((r) => picked.has(r.tabId));
}

function tabRow(r, max) {
  const p = tabPill(r);
  const check = el('input', { type: 'checkbox', checked: picked.has(r.tabId) });
  check.setAttribute('aria-label', `Select ${nameOf(r)}`);
  check.addEventListener('change', () => {
    if (check.checked) picked.add(r.tabId);
    else picked.delete(r.tabId);
    renderBulk(filterTabs(rows, { query, state: show }));
  });
  const icon = el('img', { className: 'fav', alt: '', width: 16, height: 16, loading: 'lazy' });
  if (/^https?:/.test(r.url)) icon.src = chrome.runtime.getURL(`_favicon/?pageUrl=${encodeURIComponent(r.url)}&size=32`);
  else icon.style.visibility = 'hidden';
  const link = el('a', { className: 'tablink', href: '#', textContent: nameOf(r) });
  link.addEventListener('click', (e) => {
    e.preventDefault();
    go(r);
  });
  const where = [siteLabel(r.url)];
  if (r.shared) where.push('shares a process with other tabs');
  const mem = r.memoryMb === null ? '–' : el('span', { className: 'mem' }, [el('span', { className: 'meter' }, el('i', { style: `width:${meterPct(r.memoryMb, max)}%` })), el('span', { className: 'amount', textContent: fmtMb(r.memoryMb) })]);
  if (r.memoryMb !== null) mem.dataset.weight = weightOf(r.memoryMb);
  const acts = [];
  if (r.state !== 'asleep' && !r.active) acts.push(button('Sleep', () => act(() => chrome.tabs.discard(r.tabId), 'Tab put to sleep.'), 'quiet'));
  acts.push(button('Close', () => act(() => chrome.tabs.remove(r.tabId), 'Tab closed.'), 'quiet'));
  const tr = el('tr', {}, [
    td(check, 'fit'),
    td(el('div', { className: 'who' }, [icon, el('div', {}, [link, el('span', { className: 'sub', textContent: where.join(' · ') })])]), 'clip'),
    td(pill(p.text, p.cls), 'fit'),
    td(mem, 'num'),
    td(fmtPct(r.cpuPct), 'num'),
    td(acts, 'actions'),
  ]);
  tr.dataset.tab = String(r.tabId);
  tr.dataset.state = r.state; // asleep and frozen rows show a dimmed icon
  return tr;
}

function renderTabs() {
  const counts = countStates(rows);
  renderStates(counts);
  const shown = filterTabs(rows, { query, state: show });
  const max = Math.max(0, ...rows.map((r) => r.memoryMb || 0));
  const groups = groupByWindow(sortTabs(shown, sortKey, sortDesc));
  const body = [];
  groups.forEach((g, i) => {
    if (groups.length > 1 || new Set(rows.map((r) => r.windowId)).size > 1) {
      const mb = g.rows.reduce((sum, r) => sum + (r.memoryMb || 0), 0);
      const facts = [plural(g.rows.length, 'tab')];
      if (mb) facts.push(fmtMb(mb));
      const head = el('tr', { className: 'group' }, el('th', { colSpan: 6, scope: 'colgroup' }, [`Window ${i + 1}`, el('span', { className: 'sub', textContent: facts.join(' · ') })]));
      body.push(head);
    }
    for (const r of g.rows) body.push(tabRow(r, max));
  });
  $('rows').replaceChildren(...body);
  $('none').hidden = shown.length > 0 || rows.length === 0;
  renderBulk(shown);
  for (const h of document.querySelectorAll('th[data-sort]')) {
    if (h.dataset.sort === sortKey) h.setAttribute('aria-sort', sortDesc ? 'descending' : 'ascending');
    else h.removeAttribute('aria-sort');
  }
}

function renderSide(stats, status) {
  if (stats.ok) {
    const body = kindRows(stats.kinds).map((k) => el('tr', {}, [td(k.name), td(String(k.processes), 'num'), td(fmtMb(k.memoryMb), 'num'), td(fmtPct(k.cpuPct), 'num')]));
    const head = el('tr', {}, [el('th', { textContent: 'Part', scope: 'col' }), el('th', { className: 'num', textContent: 'Processes', scope: 'col' }), el('th', { className: 'num', textContent: 'Memory', scope: 'col' }), el('th', { className: 'num', textContent: 'Processor', scope: 'col' })]);
    $('kinds').classList.remove('muted');
    $('kinds').replaceChildren(el('div', { className: 'tablewrap' }, el('table', {}, [el('thead', {}, head), el('tbody', {}, body)])));
  } else {
    $('kinds').classList.add('muted');
    $('kinds').textContent = 'Needs the Gamblium helper.';
  }
  $('reasons').replaceChildren(
    ...reasonRows(status.reasons).map((r) => el('li', {}, [el('span', { textContent: r.label }), el('span', { className: 'num', textContent: String(r.count) })])),
  );
}

async function read({ keepTable = false } = {}) {
  const [stats, status, tabs] = await Promise.all([send({ type: 'tab-stats' }), send({ type: 'status' }), chrome.tabs.query({})]);
  rows = stats.ok ? stats.tabs : rowsFromTabs(tabs);
  $('helperNote').hidden = !!stats.ok;
  if (!stats.ok) $('helperNote').textContent = `Memory and processor figures are missing. ${stats.error || ''}`;
  renderFacts(countStates(rows), stats, status);
  renderMap();
  // Do not pull a row out from under someone who is working in the table.
  const busy = $('rows').contains(document.activeElement) || document.activeElement === $('q');
  if (!(keepTable && busy)) renderTabs();
  renderSide(stats, status);
}

async function go(r) {
  try {
    await chrome.tabs.update(r.tabId, { active: true });
    await chrome.windows.update(r.windowId, { focused: true });
  } catch {
    refresh(); // the tab is gone
  }
}

async function act(fn, done) {
  try {
    await fn();
    $('did').textContent = done;
  } catch (e) {
    $('did').textContent = String(e?.message ?? e);
  }
  refresh();
}

for (const h of document.querySelectorAll('th[data-sort]')) {
  h.querySelector('button').addEventListener('click', () => {
    if (sortKey === h.dataset.sort) sortDesc = !sortDesc;
    else {
      sortKey = h.dataset.sort;
      sortDesc = sortKey !== 'title';
    }
    renderTabs();
  });
}

$('q').addEventListener('input', () => {
  query = $('q').value;
  renderTabs();
});
$('reset').addEventListener('click', () => {
  query = '';
  show = 'all';
  $('q').value = '';
  renderTabs();
});
$('pickAll').addEventListener('change', () => {
  const shown = filterTabs(rows, { query, state: show });
  for (const r of shown) {
    if ($('pickAll').checked) picked.add(r.tabId);
    else picked.delete(r.tabId);
  }
  renderTabs();
});
$('clearPicked').addEventListener('click', () => {
  picked.clear();
  renderTabs();
});
$('sleepPicked').addEventListener('click', () => {
  const ids = rows.filter((r) => picked.has(r.tabId) && r.state !== 'asleep' && !r.active).map((r) => r.tabId);
  picked.clear();
  act(() => Promise.allSettled(ids.map((id) => chrome.tabs.discard(id))), ids.length ? `${plural(ids.length, 'tab')} put to sleep.` : 'Those tabs are showing or already asleep.');
});
$('closePicked').addEventListener('click', () => {
  const ids = [...picked];
  picked.clear();
  act(() => chrome.tabs.remove(ids), `${plural(ids.length, 'tab')} closed.`);
});

// "/" goes to the filter from anywhere; Escape clears it.
document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
  if (e.key === '/' && !typing) {
    e.preventDefault();
    $('q').focus();
  } else if (e.key === 'Escape' && document.activeElement === $('q') && query) {
    query = '';
    $('q').value = '';
    renderTabs();
  }
});

$('sleepAll').addEventListener('click', async () => {
  const r = await send({ type: 'sleep-now', scope: 'all' });
  $('did').textContent = r.ok === false ? r.error : r.slept ? `${plural(r.slept, 'tab')} put to sleep.` : 'Nothing to put to sleep: every hidden tab is asleep, pinned, playing or on your never-sleep list.';
  refresh();
});

let first = true;
const refresh = whileVisible(async () => {
  await read({ keepTable: !first });
  first = false;
}, 5000);
// Processor use needs two readings; take the second one soon after the first.
setTimeout(() => document.visibilityState === 'visible' && read({ keepTable: true }), 1500);

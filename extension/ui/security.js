// Security dashboard for one site. Opened from the right-click menu as
// security.html?url=<page>&tab=<id>&panel=<""|audit|capture>.
// It talks to the background only; it never polls while hidden, and only polls
// at all while request capture is on.
import {
  hostOf, scopeMessage, auditSummary,
  cveRows, requestStatus, splitUrl, fmtMs, fmtBytes, captureLine, proxyLine,
  checkup, verdict, portInfo, CHECKS, SEVERITY_WORD,
} from './security-logic.js';
import './page.js'; // one read of the stored colour scheme when the page opens

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const targetUrl = params.get('url') || '';
const tabId = params.get('tab') ? Number(params.get('tab')) : undefined;
const host = hostOf(targetUrl);

// Every call answers with an object; a failure never throws past here.
const send = async (msg) => {
  try {
    return (await chrome.runtime.sendMessage(msg)) ?? { ok: false, error: 'The extension did not answer.' };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
};
const helper = (request) => send({ type: 'native', request });

function el(tag, props = {}, children = []) {
  const e = Object.assign(document.createElement(tag), props);
  for (const c of [].concat(children)) e.append(c);
  return e;
}
const td = (content, className = '') => el('td', { className }, content);
const th = (text, className = '') => el('th', { className, textContent: text, scope: 'col' });
const pill = (text, cls = '') => el('span', { className: `pill ${cls}`.trim(), textContent: text });

function show(node, content) {
  node.classList.remove('muted');
  node.replaceChildren(...[].concat(content));
}
const working = (node, text) => show(node, el('p', { className: 'muted', textContent: text, style: 'margin:0' }));
const failed = (node, text) => show(node, el('div', { className: 'notice bad', textContent: text }));

// ---- Scope ------------------------------------------------------------------

async function refreshScope() {
  $('host').textContent = host || 'Security';
  $('target').textContent = targetUrl;
  $('target').hidden = !host;
  // No site given (opened from the sidebar): the page asks for one instead of saying what is missing.
  $('sitePick').hidden = !!host;
  $('scopeBox').hidden = !host;
  if (!host) $('siteAddr').focus();
  // One Check button at a time: with no site, the field's own; the card's comes back once a site is set.
  $('auditBtn').hidden = !host;
  $('scanBtn').title = host ? '' : 'Name a site above first.';
  if (host) document.title = `${host} · Security · Gamblium`;
  const answer = host ? await helper({ type: 'scope-check', host }) : undefined;
  const m = scopeMessage(host, answer);
  $('scope').className = `notice ${m.kind}`.trim();
  $('scope').textContent = m.text;
  $('scopeAdd').hidden = !m.canAdd;
  $('scopeAddBtn').textContent = host ? `Add ${host} to my scope` : 'Add it to my scope';
  const blocked = !host;
  $('auditBtn').disabled = blocked;
  $('scanBtn').disabled = blocked;
}

// Check waits for something to check.
$('siteAddr').addEventListener('input', () => {
  const empty = !$('siteAddr').value.trim();
  $('siteGo').disabled = empty;
  $('siteGo').title = empty ? 'Type a site name first' : '';
  $('siteBad').hidden = true;
});
$('sitePick').addEventListener('submit', (e) => {
  e.preventDefault();
  const typed = $('siteAddr').value.trim();
  const url = /^https?:\/\//i.test(typed) ? typed : `https://${typed}`;
  if (!typed || !hostOf(url)) {
    $('siteBad').textContent = 'Type a site name, like example.com.';
    $('siteBad').hidden = false;
    return;
  }
  location.search = `?url=${encodeURIComponent(url)}`;
});

$('scopeConfirm').addEventListener('change', () => ($('scopeAddBtn').disabled = !$('scopeConfirm').checked));
$('scopeAddBtn').addEventListener('click', async () => {
  if (!$('scopeConfirm').checked) return;
  const r = await helper({ type: 'scope-add', entry: host });
  $('scopeConfirm').checked = false;
  $('scopeAddBtn').disabled = true;
  if (r.ok === false) {
    // The helper refuses entries that cover too much; its words say why.
    $('scope').className = 'notice bad';
    $('scope').textContent = r.error;
    return;
  }
  refreshScope();
});

// ---- Audit ------------------------------------------------------------------

const STATE_CLASS = { high: 'bad', medium: 'warn', pass: 'ok' };

/** One check: its verdict in a word, its name, what was found. Opens to say what it means and what to do. */
function probe(row) {
  const head = [
    pill(SEVERITY_WORD[row.state], STATE_CLASS[row.state] ?? ''),
    el('span', { className: 'pname', textContent: row.name }),
  ];
  if (!row.items.length) return el('li', { className: `probe ${row.state}` }, el('div', { className: 'phead' }, [...head, el('span', { className: 'pfound muted', textContent: row.fine })]));
  const more = row.items.length - 1;
  head.push(el('span', { className: 'pfound', textContent: row.items[0].plain + (more ? ` (and ${more} more)` : '') }));
  const body = row.items.map((i) => {
    const dl = el('dl', { className: 'explain' });
    const add = (term, text, cls = '') => text && dl.append(el('dt', { textContent: term }), el('dd', { className: cls, textContent: text }));
    add('What it means', i.means);
    add('What to do', i.todo);
    add('What was seen', [i.title, i.detail].filter(Boolean).join(' · '), 'mono');
    return el('div', { className: 'pitem' }, more ? [el('p', { className: 'finding', textContent: i.title }), dl] : dl);
  });
  const d = el('details', { open: row.state === 'high' }, [el('summary', { className: 'phead' }, head), ...body]);
  return el('li', { className: `probe ${row.state}` }, d);
}

function cveTable(cves) {
  const word = (score) => (score === '–' ? '' : Number(score) >= 9 ? 'Critical' : Number(score) >= 7 ? 'High' : Number(score) >= 4 ? 'Medium' : 'Low');
  const rows = cveRows(cves).map((c) => {
    const w = word(c.score);
    return el('tr', {}, [td(c.id, 'mono'), td(w ? pill(`${w} ${c.score}`, w === 'Critical' || w === 'High' ? 'bad' : w === 'Medium' ? 'warn' : '') : '–'), td(c.published, 'num'), td(c.summary)]);
  });
  return el('div', { className: 'tablewrap' }, el('table', {}, [el('thead', {}, el('tr', {}, [th('Entry'), th('How bad'), th('Published', 'num'), th('What it is')])), el('tbody', {}, rows)]));
}

/** Before the first run: what the check-up will look at. */
function showPlan() {
  show($('auditOut'), [
    // One line; what the things are is in its tooltip (Rule 11).
    el('p', { className: 'muted plan', textContent: `Looks at ${CHECKS.length} things, as any visitor's browser would. Nothing is attacked.`, title: CHECKS.map((c) => c.name).join(' · ') }),
  ]);
}

async function runAudit() {
  working($('auditOut'), 'Checking…');
  $('auditBtn').disabled = true;
  const r = await helper({ type: 'audit', url: targetUrl, cve: $('auditCve').checked });
  $('auditBtn').disabled = false;
  $('auditBtn').textContent = 'Check again';
  if (r.ok === false) return failed($('auditOut'), r.error);
  const rows = checkup(r.findings ?? [], { https: /^https:/i.test(targetUrl) });
  const v = verdict(rows);
  const parts = [
    el('div', { className: `verdict ${v.kind}`.trim() }, [
      el('p', { className: 'vtext', textContent: v.text }),
      el('p', { className: 'vsub', textContent: v.sub }),
      // One mark per check, worst first: the whole result at a glance.
      el('div', { className: 'marks', role: 'img', ariaLabel: rows.map((x) => `${x.name}: ${SEVERITY_WORD[x.state]}`).join(', ') }, rows.map((x) => el('span', { className: x.state, title: `${x.name}: ${SEVERITY_WORD[x.state]}` }))),
    ]),
    el('ol', { className: 'probes' }, rows.map(probe)),
  ];
  const software = r.software ?? [];
  parts.push(el('h3', { textContent: 'Software the site names' }));
  parts.push(
    software.length
      ? el('p', { className: 'mono', style: 'margin:0', textContent: software.map(([p, ver]) => `${p} ${ver}`.trim()).join('   ') })
      : el('p', { className: 'muted', style: 'margin:0', textContent: 'None. The site does not say what it runs on.' }),
  );
  if (software.length && !$('auditCve').checked) parts.push(el('p', { className: 'muted', style: 'margin:6px 0 0', textContent: 'Tick the box below and check again to see the known flaws of these versions.' }));
  for (const [name, cves] of Object.entries(r.cves ?? {})) {
    parts.push(el('h3', { textContent: `${name}: ${cves.length} known flaw${cves.length === 1 ? '' : 's'}${cves.length > 8 ? ', worst 8 shown' : ''}` }));
    if (cves.length) parts.push(cveTable(cves));
  }
  // The helper's own summary, for testers and for the smoke test.
  parts.push(el('p', { className: 'muted fine-print', textContent: auditSummary(r) }));
  show($('auditOut'), parts);
}
$('auditBtn').addEventListener('click', runAudit);

// ---- Ports ------------------------------------------------------------------

$('scanBtn').addEventListener('click', async () => {
  working($('scanOut'), 'Scanning…');
  const request = { type: 'scan', target: host };
  if ($('scanPorts').value.trim()) request.ports = $('scanPorts').value.trim();
  const r = await helper(request);
  if (r.ok === false) return failed($('scanOut'), r.error);
  const open = r.open ?? [];
  const risky = open.filter((p) => portInfo(p.port).risky).length;
  const parts = [el('p', { className: 'num', style: 'margin:0 0 8px; font-weight:500', textContent: `${open.length} of ${r.ports_scanned} ports open on ${r.target} (${r.ip}).` })];
  if (risky) parts.push(el('div', { className: 'notice warn', textContent: `${risky} of them ${risky === 1 ? 'is a service' : 'are services'} that should not be reachable by everyone. If this is your server, close ${risky === 1 ? 'it' : 'them'} in its firewall.` }));
  if (open.length) {
    const rows = open.map((p) => {
      const info = portInfo(p.port);
      return el('tr', {}, [td(`${p.port}`, 'num'), td([el('span', { textContent: info.name }), ...(info.risky ? [' ', pill('Keep private', 'warn')] : []), el('span', { className: 'sub mono', textContent: p.banner || '' })])]);
    });
    parts.push(el('div', { className: 'tablewrap' }, el('table', {}, [el('thead', {}, el('tr', {}, [th('Port', 'num'), th('What usually listens there')])), el('tbody', {}, rows)])));
  }
  show($('scanOut'), parts);
});

// ---- Request capture --------------------------------------------------------

let pollTimer = null;
let selectedId = null;

function requestRow(r) {
  const st = requestStatus(r);
  const { host: h, rest } = splitUrl(r.url);
  const row = el('tr', { className: 'pick', tabIndex: 0 }, [
    td(r.method),
    td(pill(st.text, st.cls)),
    td(r.type, 'muted'),
    td(fmtMs(r.durationMs), 'num'),
    td(fmtBytes(r.contentLength), 'num'),
    td([el('span', { textContent: h }), el('span', { className: 'muted', textContent: rest })], 'clip'),
  ]);
  row.title = r.url;
  row.setAttribute('aria-selected', String(r.id === selectedId));
  const open = () => showRequest(r.id);
  row.addEventListener('click', open);
  row.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), open()));
  return row;
}

async function refreshCapture() {
  const st = await send({ type: 'capture-status' });
  if (st.ok === false) {
    $('capStatus').textContent = st.error;
    return;
  }
  $('capStatus').textContent = captureLine(st);
  $('capStart').disabled = !!st.on;
  $('capStop').disabled = !st.on;
  const filter = { text: $('capFilter').value, errorsOnly: $('capErrors').checked };
  if (tabId !== undefined && !Number.isNaN(tabId)) filter.tabId = tabId;
  const rows = await send({ type: 'capture-list', filter, limit: 200 });
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) {
    const why = st.on
      ? 'Nothing yet. Requests appear here as the page makes them.'
      : st.count
        ? 'No request matches the filter.'
        : 'Start capture, then reload the page. Headers hold cookies: clear when done.';
    show($('capOut'), el('p', { className: 'empty', textContent: why }));
  } else {
    const head = el('thead', {}, el('tr', {}, [th('Method'), th('Status'), th('Type'), th('ms', 'num'), th('Size', 'num'), th('Address')]));
    show($('capOut'), el('table', {}, [head, el('tbody', {}, list.map(requestRow))]));
  }
  schedule(st.on);
}

function headerList(pairs) {
  const dl = el('dl', { className: 'kv mono' });
  for (const h of pairs ?? []) dl.append(el('dt', { textContent: h.name }), el('dd', { textContent: h.value ?? '' }));
  return dl;
}

async function showRequest(id) {
  selectedId = id;
  const r = await send({ type: 'capture-get', id });
  if (!r || r.ok === false || !r.record) {
    $('capDetail').hidden = true;
    return;
  }
  const rec = r.record;
  const copy = el('button', { type: 'button', textContent: 'Copy as curl' });
  copy.addEventListener('click', async () => {
    await navigator.clipboard.writeText(r.curl);
    copy.textContent = 'Copied';
  });
  const close = el('button', { type: 'button', className: 'quiet', textContent: 'Close' });
  close.addEventListener('click', () => {
    selectedId = null;
    $('capDetail').hidden = true;
    refreshCapture();
  });
  $('capDetail').replaceChildren(
    el('div', { className: 'spread', style: 'margin:20px 0 8px' }, [el('h3', { textContent: `${rec.method} ${splitUrl(rec.url).host}`, style: 'margin:0' }), el('div', { className: 'row' }, [copy, close])]),
    el('p', { className: 'mono', style: 'margin:0 0 12px; overflow-wrap:anywhere', textContent: rec.url }),
    el('p', { className: 'muted', style: 'margin:0 0 4px', textContent: rec.statusLine || 'No response yet' }),
    el('h3', { textContent: 'Request headers' }),
    headerList(rec.requestHeaders),
    el('h3', { textContent: 'Response headers' }),
    headerList(rec.responseHeaders),
    el('h3', { textContent: 'As curl' }),
    el('pre', { className: 'code', textContent: r.curl }),
  );
  $('capDetail').hidden = false;
  refreshCapture();
}

// Once a second, only while capturing and only while this page is visible.
function schedule(on) {
  clearTimeout(pollTimer);
  if (on && !document.hidden) pollTimer = setTimeout(refreshCapture, 1000);
}
document.addEventListener('visibilitychange', () => (document.hidden ? clearTimeout(pollTimer) : refreshCapture()));

// The Copy button beside the pen-test command (as in Settings).
for (const b of document.querySelectorAll('[data-copy]')) {
  b.addEventListener('click', async () => {
    await navigator.clipboard.writeText($(b.dataset.copy).textContent.trim()).catch(() => {});
    b.textContent = 'Copied';
    setTimeout(() => { b.textContent = 'Copy'; }, 1500);
  });
}

$('capStart').addEventListener('click', async () => {
  let r = await send({ type: 'capture-start' });
  if (r.needPermission) {
    // Must happen inside this click: the browser shows its own permission prompt.
    const granted = await chrome.permissions.request({ origins: ['<all_urls>'] });
    if (granted) r = await send({ type: 'capture-start' });
  }
  refreshCapture();
});
$('capStop').addEventListener('click', async () => {
  await send({ type: 'capture-stop' });
  refreshCapture();
});
$('capClear').addEventListener('click', async () => {
  await send({ type: 'capture-clear' });
  selectedId = null;
  $('capDetail').hidden = true;
  refreshCapture();
});
$('capFilter').addEventListener('input', refreshCapture);
$('capErrors').addEventListener('change', refreshCapture);

// ---- Start ------------------------------------------------------------------

send({ type: 'proxy-get' }).then((p) => ($('proxyNow').textContent = proxyLine(p)));
showPlan();
await refreshScope();
refreshCapture();
if (params.get('panel') === 'audit' && host) runAudit();
if (params.get('panel') === 'capture') { $('testers').open = true; $('capStart').scrollIntoView(); }

// ---- Decode and encode (decode.js): on this computer only ------------------------------
import('../decode.js').then(({ OPS, readJwt, weakSecret }) => {
  const input = $('decIn'), output = $('decOut'), note = $('decNote'), jwtBox = $('decJwt');
  const show = (out, text = '') => {
    output.value = out;
    note.textContent = text;
    $('decUse').hidden = !out;
  };
  let checking = 0;
  const readToken = async () => {
    const j = readJwt(input.value);
    jwtBox.hidden = !j;
    if (!j) return;
    const t = j.times;
    const lines = [
      `JWT · ${j.alg || 'no alg'}` + (j.expired === true ? ' · expired' : j.expired === false ? ' · not expired' : ''),
      ...(t.issued ? [`Issued ${t.issued}`] : []), ...(t.notBefore ? [`Not before ${t.notBefore}`] : []), ...(t.expires ? [`Expires ${t.expires}`] : []),
    ];
    jwtBox.replaceChildren(
      el('p', { className: 'jwtline', textContent: lines.join(' · ') }),
      ...j.warnings.map((w) => el('p', { className: 'warn', textContent: '⚠ ' + w })),
      el('p', { className: 'muted', id: 'decWeak', textContent: /^HS/.test(j.alg) ? 'Trying common secrets…' : '' }),
    );
    show(JSON.stringify({ header: j.header, payload: j.payload }, null, 2), 'Header and payload');
    if (/^HS/.test(j.alg)) {
      const mine = ++checking;
      const s = await weakSecret(j);
      if (mine !== checking || !$('decWeak')) return;
      $('decWeak').className = s ? 'warn' : 'muted';
      $('decWeak').textContent = s ? `⚠ Signed with a common secret: "${s}". Anyone can make tokens this server accepts.` : 'Not signed with any of the common secrets tried.';
    }
  };
  input.addEventListener('input', readToken);
  for (const b of document.querySelectorAll('.decops button')) {
    b.addEventListener('click', () => {
      try {
        const r = OPS[b.dataset.op](input.value);
        show(r.out, r.note || b.textContent);
      } catch (e) {
        show('', e.message);
      }
    });
  }
  $('decUse').addEventListener('click', () => {
    input.value = output.value;
    readToken();
    input.focus();
  });
});


import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hostOf, scopeMessage, sortFindings, countBySeverity, severityClass, auditSummary,
  cveRows, requestStatus, splitUrl, fmtMs, fmtBytes, captureLine, proxyLine,
} from './security-logic.js';

test('hostOf reads a host or gives nothing', () => {
  assert.equal(hostOf('https://shop.example.org:8443/a?b=1'), 'shop.example.org');
  assert.equal(hostOf('nonsense'), '');
});

test('scope banner: every state, and only "not in scope" offers to add', () => {
  assert.deepEqual(scopeMessage('', undefined), { kind: '', text: 'Name a site to check.', canAdd: false });
  assert.equal(scopeMessage('a.test', { ok: false, error: 'helper missing' }).kind, 'bad');
  assert.equal(scopeMessage('a.test', { ok: false, error: 'helper missing' }).text, 'helper missing');
  assert.equal(scopeMessage('a.test', undefined).canAdd, false);
  const local = scopeMessage('localhost', { ok: true, ip: '127.0.0.1', local: true, inScope: true });
  assert.equal(local.kind, 'ok');
  assert.match(local.text, /own machine or network: in scope/);
  const listed = scopeMessage('a.test', { ok: true, ip: '10.0.0.5', local: false, inScope: true });
  assert.match(listed.text, /is in your scope file/);
  assert.equal(listed.canAdd, false);
  const out = scopeMessage('b.test', { ok: true, ip: '93.184.216.34', local: false, inScope: false });
  assert.equal(out.kind, 'warn');
  assert.match(out.text, /NOT in your scope/);
  assert.equal(out.canAdd, true);
});

test('findings are sorted worst first and counted', () => {
  const f = [{ severity: 'low', id: 1 }, { severity: 'HIGH', id: 2 }, { severity: 'info', id: 3 }, { severity: 'low', id: 4 }, { severity: 'medium', id: 5 }];
  assert.deepEqual(sortFindings(f).map((x) => x.id), [2, 5, 1, 4, 3]);
  assert.deepEqual(countBySeverity(f), { high: 1, medium: 1, low: 2, info: 1 });
  assert.deepEqual(sortFindings(undefined), []);
});

test('only high is red and only medium is amber', () => {
  assert.equal(severityClass('high'), 'bad');
  assert.equal(severityClass('Medium'), 'warn');
  assert.equal(severityClass('low'), '');
  assert.equal(severityClass('info'), '');
});

test('audit summary names the counts it has', () => {
  assert.equal(auditSummary({ status: 200, findings: [] }), 'The site answered 200. Number of findings: 0.');
  assert.equal(auditSummary({ status: 200, findings: [{ severity: 'high' }] }), 'The site answered 200. Number of findings: 1 (1 high).');
  assert.equal(
    auditSummary({ status: 403, findings: [{ severity: 'low' }, { severity: 'high' }, { severity: 'low' }] }),
    'The site answered 403. Number of findings: 3 (1 high, 2 low).',
  );
});

test('CVE rows: fixed decimals, a dash for no score, one-line summary', () => {
  const rows = cveRows([{ id: 'CVE-2024-1', score: 9.8, published: '2024-03-02T10:00:00', summary: 'a\n  b' }, { id: 'CVE-2023-2', score: null, published: '2023-01-01', summary: 'x' }]);
  assert.deepEqual(rows[0], { id: 'CVE-2024-1', score: '9.8', published: '2024-03-02', summary: 'a b' });
  assert.equal(rows[1].score, '–');
  assert.equal(cveRows(new Array(20).fill({ id: 'x', score: 7, published: '', summary: '' })).length, 8);
});

test('request status: errors and 5xx red, 4xx amber, the rest plain', () => {
  assert.deepEqual(requestStatus({ error: 'net::ERR_BLOCKED_BY_CLIENT', status: null, done: true }), { text: 'ERR_BLOCKED_BY_CLIENT', cls: 'bad' });
  assert.deepEqual(requestStatus({ status: 503, done: true }), { text: '503', cls: 'bad' });
  assert.deepEqual(requestStatus({ status: 404, done: true }), { text: '404', cls: 'warn' });
  assert.deepEqual(requestStatus({ status: 200, done: true }), { text: '200', cls: '' });
  assert.deepEqual(requestStatus({ status: null, done: false }), { text: 'pending', cls: '' });
});

test('address, time and size formatting', () => {
  assert.deepEqual(splitUrl('https://a.test:8443/x/y?z=1'), { host: 'a.test:8443', rest: '/x/y?z=1' });
  assert.deepEqual(splitUrl('weird'), { host: '', rest: 'weird' });
  assert.equal(fmtMs(12.6), '13');
  assert.equal(fmtMs(null), '–');
  assert.equal(fmtBytes(0), '0 B');
  assert.equal(fmtBytes(1536), '1.5 kB');
  assert.equal(fmtBytes(2_500_000), '2.5 MB');
  assert.equal(fmtBytes(-1), '–');
  assert.equal(fmtBytes(null), '–');
});

test('capture and proxy lines', () => {
  assert.equal(captureLine({ on: true, count: 1 }), 'Capturing · 1 request kept');
  assert.equal(captureLine({ on: false, count: 0 }), 'Capture is off · 0 requests kept');
  assert.equal(proxyLine({ ok: true, mode: 'fixed', scheme: 'http', host: '127.0.0.1', port: 8080 }), 'This profile sends its traffic through http://127.0.0.1:8080.');
  assert.equal(proxyLine({ ok: true, mode: 'system' }), 'This profile uses the system proxy setting.');
  assert.equal(proxyLine({ ok: true, mode: 'direct' }), 'This profile connects directly, with no proxy.');
  assert.equal(proxyLine({ ok: false, error: 'x' }), 'This profile: proxy setting unknown.');
});

import { checkup, verdict, portInfo, ADVICE, CHECKS } from './security-logic.js';

test('every finding id a check lists has advice in plain words', () => {
  for (const c of CHECKS) for (const id of c.ids) assert.ok(ADVICE[id]?.plain && ADVICE[id].means && ADVICE[id].todo, id);
});

test('checkup: one row per check, worst first, nothing dropped', () => {
  const rows = checkup([
    { severity: 'low', id: 'version-disclosed', title: 'Software version disclosed in the server header', detail: 'server: Apache/2.4.49' },
    { severity: 'high', id: 'cors-reflect-credentials', title: 'x', detail: 'y' },
    { severity: 'medium', id: 'cookie-flags', title: "Cookie 'a' lacks HttpOnly", detail: '' },
    { severity: 'medium', id: 'cookie-flags', title: "Cookie 'b' lacks HttpOnly", detail: '' },
    { severity: 'low', id: 'something-new', title: 'A new kind of finding', detail: 'from a newer helper' },
  ], { https: false });
  assert.equal(rows.length, CHECKS.length + 1);
  assert.equal(rows[0].id, 'cors');
  assert.equal(rows[0].state, 'high');
  assert.equal(rows[0].items[0].plain, 'Any website can read this page as the logged-in visitor');
  const cookies = rows.find((r) => r.id === 'cookies');
  assert.equal(cookies.items.length, 2);
  assert.equal(cookies.items[1].title, "Cookie 'b' lacks HttpOnly");
  assert.equal(rows.find((r) => r.id === 'hsts').state, 'skipped');
  assert.match(rows.find((r) => r.id === 'https').fine, /own machine/);
  const other = rows.find((r) => r.id === 'other');
  assert.equal(other.items[0].plain, 'A new kind of finding');
  assert.equal(rows.at(-1).state, 'skipped');
});

test('verdict speaks plainly', () => {
  const v = verdict(checkup([{ severity: 'high', id: 'cors-reflect-credentials' }, { severity: 'medium', id: 'csp-missing' }, { severity: 'medium', id: 'clickjacking' }]));
  assert.equal(v.kind, 'bad');
  assert.equal(v.text, '1 serious problem, and 2 more things worth fixing');
  assert.equal(v.sub, '7 of 10 checks are fine.');
  assert.equal(verdict(checkup([{ severity: 'medium', id: 'csp-missing' }])).text, '1 thing worth fixing');
  assert.equal(verdict(checkup([{ severity: 'info', id: 'cors-any' }])).text, 'Nothing serious. 1 minor remark');
  assert.deepEqual(verdict(checkup([])), { kind: 'ok', text: 'Nothing to fix', sub: '10 of 10 checks are fine.' });
});

test('portInfo names common services', () => {
  assert.deepEqual(portInfo(3306), { name: 'MySQL database', risky: true });
  assert.deepEqual(portInfo('443'), { name: 'Website (HTTPS)', risky: false });
  assert.equal(portInfo(49152).name, 'Unknown service');
});

// Pure helpers for the security dashboard. No browser APIs, so node --test runs them.

export const SEVERITIES = ['high', 'medium', 'low', 'info'];

export function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** What the scope banner says. `r` is the helper's scope-check answer. */
export function scopeMessage(host, r) {
  if (!host) return { kind: '', text: 'Name a site to check.', canAdd: false };
  if (!r || r.ok === false) return { kind: 'bad', text: r?.error || 'The helper did not answer.', canAdd: false };
  if (r.local) return { kind: 'ok', text: `${host} (${r.ip}) is on your own machine or network: in scope.`, canAdd: false };
  if (r.inScope) return { kind: 'ok', text: `${host} (${r.ip}) is in your scope file. Only test what you own or are authorised to test.`, canAdd: false };
  return { kind: 'warn', text: `${host} (${r.ip}) is NOT in your scope. Audit and scan are refused until you add it.`, canAdd: true };
}

const rank = (sev) => {
  const i = SEVERITIES.indexOf(String(sev).toLowerCase());
  return i < 0 ? SEVERITIES.length : i;
};

/** Worst first; findings of one severity keep the helper's order. */
export function sortFindings(findings) {
  return (findings ?? []).map((f, i) => [f, i]).sort((a, b) => rank(a[0].severity) - rank(b[0].severity) || a[1] - b[1]).map(([f]) => f);
}

export function countBySeverity(findings) {
  const counts = Object.fromEntries(SEVERITIES.map((s) => [s, 0]));
  for (const f of findings ?? []) {
    const s = String(f.severity).toLowerCase();
    if (s in counts) counts[s] += 1;
  }
  return counts;
}

/** Only "high" is red and only "medium" is amber: red is a signal, not a texture. */
export function severityClass(sev) {
  const s = String(sev).toLowerCase();
  return s === 'high' ? 'bad' : s === 'medium' ? 'warn' : '';
}

export function auditSummary(r) {
  // The backend's smoke test looks for the word "findings" here, so every form has it.
  const n = r.findings?.length ?? 0;
  const head = `The site answered ${r.status}.`;
  if (!n) return `${head} Number of findings: 0.`;
  const counts = countBySeverity(r.findings);
  const parts = SEVERITIES.filter((s) => counts[s]).map((s) => `${counts[s]} ${s}`);
  return `${head} Number of findings: ${n} (${parts.join(', ')}).`;
}

/** CVE rows for a table: id, score, published date, one-line summary. */
export function cveRows(cves, max = 8) {
  return (cves ?? []).slice(0, max).map((c) => ({
    id: c.id,
    score: c.score === null || c.score === undefined ? '–' : Number(c.score).toFixed(1),
    published: String(c.published ?? '').slice(0, 10),
    summary: String(c.summary ?? '').replace(/\s+/g, ' ').trim().slice(0, 180),
  }));
}

/** A captured request's status cell: text and pill class. */
export function requestStatus(row) {
  if (row.error) return { text: row.error.replace(/^net::/, ''), cls: 'bad' };
  if (!row.done && (row.status === null || row.status === undefined)) return { text: 'pending', cls: '' };
  const code = Number(row.status);
  return { text: String(row.status ?? ''), cls: code >= 500 ? 'bad' : code >= 400 ? 'warn' : '' };
}

/** Host and the rest of an address, for a two-tone cell. */
export function splitUrl(url) {
  try {
    const u = new URL(url);
    return { host: u.host, rest: u.pathname + u.search };
  } catch {
    return { host: '', rest: String(url ?? '') };
  }
}

export function fmtMs(ms) {
  return ms === null || ms === undefined ? '–' : String(Math.round(ms));
}

export function fmtBytes(n) {
  if (n === null || n === undefined || n < 0) return '–';
  if (n < 1000) return `${n} B`;
  if (n < 1e6) return `${(n / 1e3).toFixed(1)} kB`;
  return `${(n / 1e6).toFixed(1)} MB`;
}

export function captureLine(st) {
  if (!st) return '';
  return `${st.on ? 'Capturing' : 'Capture is off'} · ${st.count} request${st.count === 1 ? '' : 's'} kept`;
}

export function proxyLine(p) {
  if (!p || p.ok === false) return 'This profile: proxy setting unknown.';
  if (p.mode === 'fixed') return `This profile sends its traffic through ${p.scheme}://${p.host}:${p.port}.`;
  if (p.mode === 'direct') return 'This profile connects directly, with no proxy.';
  if (p.mode === 'system') return 'This profile uses the system proxy setting.';
  return 'This profile has a proxy set by something else.';
}

// ---- The check-up in plain words -------------------------------------------
// The helper reports findings by a stable id. Here each id gets what a person
// who is not a security tester needs: what it is, what it means, what to do.

export const SEVERITY_WORD = { high: 'Serious', medium: 'Worth fixing', low: 'Minor', info: 'Good to know', pass: 'Fine', skipped: 'Not applicable' };

export const ADVICE = {
  'no-https': {
    plain: 'The connection is not encrypted',
    means: 'Anyone on the same Wi-Fi or network path can read what is sent and change what is shown.',
    todo: 'Your site: serve it over HTTPS and redirect HTTP to it. As a visitor: do not type passwords or card numbers here.',
  },
  'hsts-missing': {
    plain: 'The site does not insist on encryption',
    means: 'A hostile network can quietly push a visitor back to the unencrypted version of the site.',
    todo: 'Send the header Strict-Transport-Security: max-age=31536000; includeSubDomains',
  },
  'hsts-short': {
    plain: 'The site insists on encryption for a short time only',
    means: 'After that time a visitor can again be pushed to the unencrypted version.',
    todo: 'Raise max-age in Strict-Transport-Security to at least 15552000 (six months).',
  },
  'csp-missing': {
    plain: 'Nothing limits which scripts may run',
    means: 'If an attacker gets a script into the page (a comment field, an ad, a tampered library), the browser runs it without question.',
    todo: "Add a Content-Security-Policy header. Start with default-src 'self' and loosen it only where the site breaks.",
  },
  'csp-no-script-rule': {
    plain: 'The script rules do not mention scripts',
    means: 'The policy is there, but scripts from anywhere still run.',
    todo: 'Add script-src (or default-src) to the Content-Security-Policy.',
  },
  'csp-unsafe-inline': {
    plain: 'Scripts written into the page are allowed',
    means: 'That is exactly the kind of script an attacker injects, so the rule stops little.',
    todo: "Move inline scripts into files, or allow them one by one with a nonce, and remove 'unsafe-inline'.",
  },
  'csp-unsafe-eval': {
    plain: 'Text may be run as code',
    means: 'A flaw that lets an attacker control a piece of text can become running code.',
    todo: "Remove 'unsafe-eval' and replace eval() and new Function() in the site's code.",
  },
  'csp-wildcard': {
    plain: 'Scripts from any site are allowed',
    means: 'The rule names no trusted sources, so it filters nothing.',
    todo: 'List the exact sites scripts come from instead of *.',
  },
  clickjacking: {
    plain: 'Other sites can show this page inside their own',
    means: 'A hostile page can lay this site, invisible, under something harmless and trick a logged-in visitor into clicking its buttons.',
    todo: "Send X-Frame-Options: DENY, or frame-ancestors 'none' in the Content-Security-Policy.",
  },
  'nosniff-missing': {
    plain: 'The browser may guess file types',
    means: 'A file uploaded as a picture could be run as a script.',
    todo: 'Send X-Content-Type-Options: nosniff',
  },
  'referrer-policy-missing': {
    plain: 'Full page addresses may be passed to other sites',
    means: 'When a visitor follows a link, or the page loads something from elsewhere, that other site can learn the exact page they were on.',
    todo: 'Send Referrer-Policy: strict-origin-when-cross-origin',
  },
  'referrer-policy-unsafe': {
    plain: 'Full page addresses are passed to other sites',
    means: 'Other sites learn the exact page a visitor was on, search words and tokens in the address included.',
    todo: 'Change Referrer-Policy to strict-origin-when-cross-origin',
  },
  'permissions-policy-missing': {
    plain: 'Camera, microphone and location are not switched off for embedded content',
    means: 'Usually harmless: embedded content can ask for them, and the browser still asks the visitor first.',
    todo: 'If the site does not use them, send Permissions-Policy: camera=(), microphone=(), geolocation=()',
  },
  'cookie-flags': {
    plain: 'A cookie is loosely protected',
    means: 'Depending on what is missing: a script can read the cookie, it can travel unencrypted, or other sites can make the browser send it.',
    todo: 'Set the cookie with Secure; HttpOnly; SameSite=Lax',
  },
  'cors-reflect-credentials': {
    plain: 'Any website can read this page as the logged-in visitor',
    means: 'A hostile site open in another tab can fetch a visitor\'s private pages here and read them.',
    todo: 'Answer only to a fixed list of trusted origins, and never repeat the Origin together with Allow-Credentials: true.',
  },
  'cors-reflect': {
    plain: 'Any website can read this page',
    means: 'Other sites can fetch and read the response, though without the visitor\'s cookies.',
    todo: 'Answer only to a fixed list of trusted origins.',
  },
  'cors-null': {
    plain: 'Local files and sandboxed frames can read this page',
    means: 'A downloaded HTML file, or a sandboxed frame on any site, counts as the origin "null" and is let in.',
    todo: 'Do not allow the origin "null".',
  },
  'cors-any': {
    plain: 'Any website may read this response',
    means: 'Fine for public data. A problem only if the response holds anything private.',
    todo: 'Nothing, if this is public.',
  },
  'version-disclosed': {
    plain: 'The site says which software version it runs',
    means: 'Attackers look up known flaws for exact versions, then try them.',
    todo: "Hide version numbers in the server's settings, and keep the software up to date.",
  },
};

/** The ten things the check-up looks at, in the order a person would ask about them. */
export const CHECKS = [
  { id: 'https', name: 'Encrypted connection', ids: ['no-https'], fine: 'The page is served over HTTPS.' },
  { id: 'hsts', name: 'Stays encrypted', ids: ['hsts-missing', 'hsts-short'], fine: 'Browsers are told to always use HTTPS here.', httpsOnly: true },
  { id: 'scripts', name: 'Rules for scripts', ids: ['csp-missing', 'csp-no-script-rule', 'csp-unsafe-inline', 'csp-unsafe-eval', 'csp-wildcard'], fine: 'A Content-Security-Policy limits which scripts run.' },
  { id: 'cors', name: 'Who else can read it', ids: ['cors-reflect-credentials', 'cors-reflect', 'cors-null', 'cors-any'], fine: 'Other websites cannot read this page.' },
  { id: 'cookies', name: 'Cookies', ids: ['cookie-flags'], fine: 'No loosely protected cookie was set by this page.' },
  { id: 'framing', name: 'Hidden framing', ids: ['clickjacking'], fine: 'Other sites cannot show this page inside their own.' },
  { id: 'sniff', name: 'File types', ids: ['nosniff-missing'], fine: 'The browser is told not to guess file types.' },
  { id: 'referrer', name: 'What other sites learn', ids: ['referrer-policy-missing', 'referrer-policy-unsafe'], fine: 'Full page addresses are not passed on.' },
  { id: 'devices', name: 'Camera, microphone, location', ids: ['permissions-policy-missing'], fine: 'Switched off, or limited, for embedded content.' },
  { id: 'versions', name: 'Software versions on show', ids: ['version-disclosed'], fine: 'The site does not give away version numbers.' },
];

const STATE_ORDER = ['high', 'medium', 'low', 'info', 'pass', 'skipped'];

/**
 * Every check with its state and what was found, worst first.
 * `https`: the audited address is HTTPS. Findings with an id nobody knows yet
 * land in one last row, "Other", so nothing the helper reports is dropped.
 */
export function checkup(findings, { https = true } = {}) {
  const left = [...(findings ?? [])];
  const explain = (f) => ({
    severity: String(f.severity).toLowerCase(),
    title: f.title,
    detail: f.detail || '',
    plain: ADVICE[f.id]?.plain ?? f.title,
    means: ADVICE[f.id]?.means ?? f.detail ?? '',
    todo: ADVICE[f.id]?.todo ?? '',
  });
  const worst = (items) => items.reduce((w, i) => (rank(i.severity) < rank(w) ? i.severity : w), 'info');
  const rows = CHECKS.map((c) => {
    const items = [];
    for (let i = left.length - 1; i >= 0; i--) if (c.ids.includes(left[i].id)) items.unshift(explain(left.splice(i, 1)[0]));
    if (items.length) return { id: c.id, name: c.name, state: worst(items), items };
    if (c.httpsOnly && !https) return { id: c.id, name: c.name, state: 'skipped', items: [], fine: 'Only applies to sites served over HTTPS.' };
    const fine = c.id === 'https' && !https ? 'Not encrypted, which is normal for a site on your own machine or network.' : c.fine;
    return { id: c.id, name: c.name, state: 'pass', items: [], fine };
  });
  if (left.length) {
    const items = left.map(explain);
    rows.push({ id: 'other', name: 'Other', state: worst(items), items });
  }
  return rows.map((r, i) => [r, i]).sort((a, b) => STATE_ORDER.indexOf(a[0].state) - STATE_ORDER.indexOf(b[0].state) || a[1] - b[1]).map(([r]) => r);
}

const things = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** The sentence at the top of a finished check-up, and how loud it is. */
export function verdict(rows) {
  const count = (s) => rows.filter((r) => r.state === s).length;
  const high = count('high');
  const medium = count('medium');
  const minor = count('low') + count('info');
  const judged = rows.filter((r) => r.state !== 'skipped').length;
  const sub = `${count('pass')} of ${judged} checks are fine.`;
  if (high) return { kind: 'bad', text: things(high, 'serious problem', 'serious problems') + (medium ? `, and ${things(medium, 'more thing', 'more things')} worth fixing` : ''), sub };
  if (medium) return { kind: 'warn', text: `${things(medium, 'thing', 'things')} worth fixing`, sub };
  if (minor) return { kind: '', text: `Nothing serious. ${things(minor, 'minor remark', 'minor remarks')}`, sub };
  return { kind: 'ok', text: 'Nothing to fix', sub };
}

const PORTS = {
  21: ['FTP file transfer', true], 22: ['SSH remote login', false], 23: ['Telnet remote login', true], 25: ['Mail (SMTP)', false],
  53: ['DNS', false], 80: ['Website (HTTP)', false], 110: ['Mail (POP3)', false], 143: ['Mail (IMAP)', false], 443: ['Website (HTTPS)', false],
  445: ['Windows file sharing', true], 1433: ['Microsoft SQL Server database', true], 3306: ['MySQL database', true], 3389: ['Remote Desktop', true],
  5432: ['PostgreSQL database', true], 5900: ['VNC remote screen', true], 6379: ['Redis database', true], 8080: ['Website (alternative port)', false],
  8443: ['Website (alternative HTTPS port)', false], 9200: ['Elasticsearch database', true], 11211: ['Memcached', true], 27017: ['MongoDB database', true],
};

/** What usually listens on a port, and whether it should be kept off the public internet. */
export function portInfo(port) {
  const [name, risky] = PORTS[Number(port)] ?? ['Unknown service', false];
  return { name, risky };
}

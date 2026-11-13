// The clean addresses, end to end, in a throwaway browser.
import fs from 'node:fs';
import path from 'node:path';
const { withBrave, sleep, winshot } = await import('./cdp.mjs');
const out = process.argv[2] ?? path.join(process.env.TEMP, 'gamblium-address-check');
fs.mkdirSync(out, { recursive: true });

const ID = 'pbgbdlkcienglhbfadbjolphinilbpia';

const results = [];
const check = (name, ok, detail = '') => { results.push(!!ok); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`); };
await withBrave({ presets: ['theme-moon-dark.json'], tag: 'addrc' }, async ({ b, pid }) => {
  await sleep(4000);
  await b.send('Target.createTarget', { url: 'https://example.com/' });
  await sleep(2000);
  const raw = await b.open(`chrome-extension://${ID}/ui/settings.html?raw`);
  await sleep(2500);
  const ext = (code) => b.evalIn(raw.sessionId, code);
  const tabs = () => ext(`chrome.tabs.query({}).then((ts) => ts.map((t) => ({ id: t.id, url: t.url, title: t.title })))`);
  check('?raw keeps a page at its own address', (await ext('location.href')).endsWith('/ui/settings.html?raw'));

  // 1. a page opened by itself moves under the new tab document
  const t = await b.open(`chrome-extension://${ID}/ui/settings.html#look`);
  const s = t.sessionId;
  await sleep(3500);
  const inner = (code) => b.evalIn(s, `(() => { const w = document.getElementById('shell')?.contentWindow; if (!w) return 'no frame at ' + location.href; return (${code})(w); })()`);
  const top1 = await b.evalIn(s, `({ href: location.href, title: document.title, route: 'route' in document.documentElement.dataset })`);
  check('settings opened by itself ends up in the frame', /\/newtab\/index\.html#\/settings#look$/.test(top1.href) && top1.route, top1.href);
  check('the tab carries the page\'s title', top1.title === 'Settings · Gamblium' || /Settings/.test(top1.title), top1.title);
  check('the framed page is the real one, on its Appearance area', await inner(`(w) => w.location.pathname + w.location.hash + ' ' + typeof w.chrome.storage + ' ' + !w.document.querySelector('section[data-area="look"]').hidden`) === '/ui/settings.html#look object true');
  const seen = (await tabs()).find((x) => /#\/settings/.test(x.url));
  check('the extension sees that tab under the new tab address', !!seen, seen?.url);
  await b.send('Target.activateTarget', { targetId: t.targetId }).catch(() => {});
  await sleep(900);
  console.log('     shot:', winshot(pid, path.join(out, 'clean-1-settings.png')));

  // 2. moving between our pages inside the frame keeps the address in step
  await inner(`(w) => { w.document.querySelector('.bar nav a[href="history.html"]').click(); return 1; }`);
  await sleep(2500);
  const top2 = await b.evalIn(s, `({ hash: location.hash, title: document.title })`);
  check('the sidebar link to History moves the frame and the route', top2.hash === '#/history' && /History/.test(top2.title), JSON.stringify(top2));
  await inner(`(w) => { w.location.hash = ''; return 1; }`);
  // 3. a link to the web leaves the frame and takes the tab
  const link = await inner(`(w) => { const a = w.document.querySelector('.visits a'); if (!a) return null; const href = a.href; a.click(); return href; }`);
  await sleep(3000);
  const after = (await b.send('Target.getTargets')).targetInfos.find((x) => x.targetId === t.targetId);
  check('a web link in History takes the whole tab there', !!link && after?.url.startsWith('https://example.com'), `${link} -> ${after?.url}`);

  // 4. the Back button returns to the frame
  await b.evalIn(s, `history.back()`).catch(() => {});
  await sleep(3000);
  const back = await b.evalIn(s, `location.hash + ' | ' + (document.getElementById('shell')?.contentWindow.location.pathname ?? 'no frame')`).catch((e) => String(e.message).slice(0, 100));
  check('Back returns to the framed History', back === '#/history | /ui/history.html', back);

  // 5. reload keeps it
  await b.send('Page.reload', {}, s).catch(() => {});
  await sleep(3000);
  const rl = await b.evalIn(s, `location.hash + ' | ' + (document.getElementById('shell')?.contentWindow.location.pathname ?? 'no frame')`).catch((e) => String(e.message).slice(0, 100));
  check('reload keeps the framed page', rl === '#/history | /ui/history.html', rl);
  await b.send('Target.activateTarget', { targetId: t.targetId }).catch(() => {});
  await sleep(900);
  console.log('     shot:', winshot(pid, path.join(out, 'clean-2-after-reload.png')));

  // 6. openPage goes to the clean address and does not open a second copy
  const before = (await tabs()).length;
  await ext(`import('./page.js').then((m) => m.openPage('ui/dashboard.html'))`);
  await sleep(3000);
  await ext(`import('./page.js').then((m) => m.openPage('ui/dashboard.html'))`);
  await sleep(1500);
  const list = await tabs();
  const dash = list.filter((x) => /#\/tabs/.test(x.url) || /dashboard\.html/.test(x.url));
  check('openPage opens Tabs and memory once, at the clean address', list.length === before + 1 && dash.length === 1 && /newtab/.test(dash[0].url), JSON.stringify(dash.map((x) => x.url)));

  // 7. gamblium:// addresses are sent on by the background
  for (const [typed, want] of [['gamblium://gpu', /^chrome:\/\/gpu/], ['gamblium://settings/look', /newtab.*#\/settings#look$/], ['gamblium://version', /^chrome:\/\/version/]]) {
    const made = await b.send('Target.createTarget', { url: typed });
    await sleep(3500);
    const info = (await b.send('Target.getTargets')).targetInfos.find((x) => x.targetId === made.targetId);
    check(`${typed} is sent on`, want.test(info?.url ?? ''), info?.url);
    if (typed.endsWith('look')) {
      await b.send('Target.activateTarget', { targetId: made.targetId }).catch(() => {});
      await sleep(900);
      console.log('     shot:', winshot(pid, path.join(out, 'clean-3-from-gamblium-address.png')));
    }
  }

  // 8. the new tab page is still the new tab page, and its search box knows gamblium://
  const nt = await b.open('chrome://newtab/');
  await sleep(3000);
  const offers = await b.evalIn(nt.sessionId, `(async () => { const q = document.getElementById('q'); q.focus(); q.value = 'gamblium://set'; q.dispatchEvent(new Event('input')); await new Promise((r) => setTimeout(r, 500)); return { pins: !!document.getElementById('pins'), frame: !!document.getElementById('shell'), offers: [...document.querySelectorAll('#suggest li')].map((l) => l.textContent) }; })()`);
  check('a plain new tab is the new tab page', offers.pins && !offers.frame);
  check('its search box offers gamblium:// names', offers.offers.length >= 2 && /Settings/.test(offers.offers.join(' ')), JSON.stringify(offers.offers));
  await b.evalIn(nt.sessionId, `document.querySelector('#suggest li').click()`).catch(() => {});
  await sleep(3000);
  const went = await b.evalIn(nt.sessionId, `location.hash + ' | ' + (document.getElementById('shell')?.contentWindow.location.pathname ?? 'no frame')`).catch((e) => String(e.message).slice(0, 100));
  check('choosing one shows that page in the same tab', /^#\/settings \| \/ui\/settings\.html$/.test(went), went);

  // 9. the opt-out
  await ext(`chrome.storage.local.set({ plainAddresses: true })`);
  const plain = await b.open(`chrome-extension://${ID}/ui/sessions.html`);
  await sleep(2500);
  check('plainAddresses keeps a page at its own address', (await b.evalIn(plain.sessionId, 'location.href')).endsWith('/ui/sessions.html'));
});
console.log(results.every(Boolean) ? `ALL ${results.length} OK` : `${results.filter((x) => !x).length} of ${results.length} FAILED`);

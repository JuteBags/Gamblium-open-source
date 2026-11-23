// Gamblium's own pop-out video window (extension/pipwin.js) in a real browser, on a throwaway
// profile: the playing video goes into the window and keeps playing; Captions shows the track's
// words sized by the window (about 5.6% of its height); Background (headphones) closes the window
// and the video is back in the page, still playing (sound only); the window's own close pauses.
// Usage: node tools/pip-check.mjs   (also run by tools/gate.mjs)
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const exe = join(process.env.LOCALAPPDATA, 'Gamblium', 'app', 'gamblium.exe');
const PORT = 9478;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function pipCheck() {
  const problems = [];
  const fx = join(repo, 'tools', 'fixtures');
  const server = createServer((req, res) => {
    if (req.url.startsWith('/v.mp4')) { res.writeHead(200, { 'content-type': 'video/mp4' }); return res.end(readFileSync(join(fx, 'pip-test.mp4'))); }
    if (req.url.startsWith('/c.vtt')) { res.writeHead(200, { 'content-type': 'text/vtt' }); return res.end(readFileSync(join(fx, 'pip-test.vtt'))); }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>pip</title><div id=box><video id=v src="/v.mp4" width=640 height=360 crossorigin><track kind=captions src="/c.vtt" srclang=en></video></div>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const site = `http://127.0.0.1:${server.address().port}/`;
  const profile = mkdtempSync(join(tmpdir(), 'gamblium-pip-'));
  const env = { ...process.env, GAMBLIUM_HOME: repo };
  try {
    spawnSync(exe, ['launch', '--user-data-dir', profile, '--debug-port', String(PORT), '--', '--autoplay-policy=no-user-gesture-required'], { env });
    for (let i = 0; i < 60; i++) { await sleep(500); if (await fetch(`http://127.0.0.1:${PORT}/json/version`).then((x) => x.ok, () => false)) break; }
    await sleep(2000);
    const t = await fetch(`http://127.0.0.1:${PORT}/json/new?${site}`, { method: 'PUT' }).then((r) => r.json());
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener('open', r));
    let n = 0;
    const waiting = new Map();
    ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); } });
    const ev = (expression, gesture = false) => new Promise((r) => { const id = ++n; waiting.set(id, (d) => r(d.result?.result?.value)); ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true, userGesture: gesture } })); });
    await sleep(1500);
    await ev(`document.getElementById('v').play().then(() => true, (e) => String(e))`, true);
    await sleep(1500);
    const src = readFileSync(join(repo, 'extension', 'pipwin.js'), 'utf8').replace(/export function/g, 'function');
    const opened = await ev(`(() => { ${src}; return pipMain(); })()`, true);
    await sleep(1000);
    const inWin = await ev(`(() => { const w = documentPictureInPicture.window; return !!(w && w.document.querySelector('video')); })()`);
    if (opened !== true || !inWin) return [`the video did not go into Gamblium's window (opened ${opened}, in window ${inWin})`];
    const playingIn = await ev(`!documentPictureInPicture.window.document.querySelector('video').paused`);
    if (!playingIn) problems.push('the video stopped when it went into the window');
    // Captions on: the track's words, sized by the window.
    await ev(`documentPictureInPicture.window.document.querySelector('button[title="Captions"]').click()`, true);
    await sleep(800);
    const cc = await ev(`(() => { const w = documentPictureInPicture.window; const s = w.document.querySelector('.cc span'); return s ? { text: s.textContent, font: parseFloat(w.getComputedStyle(s).fontSize), h: w.innerHeight } : null; })()`);
    if (!cc || !/Gamblium caption line/.test(cc.text)) problems.push(`captions not shown in the window (${JSON.stringify(cc)})`);
    else {
      const share = cc.font / cc.h;
      if (share < 0.04 || share > 0.075) problems.push(`captions are ${cc.font}px in a ${cc.h}px window (${(share * 100).toFixed(1)}%): not in proportion`);
    }
    // Background: window gone, video back in the page, still playing.
    await ev(`documentPictureInPicture.window.document.querySelector('button[title^="Keep playing"]').click()`, true);
    await sleep(1200);
    const back = await ev(`({ win: !!documentPictureInPicture.window, home: document.getElementById('box').contains(document.getElementById('v')), playing: !document.getElementById('v').paused })`);
    if (back.win) problems.push('Background left the window open');
    if (!back.home) problems.push('Background did not put the video back in the page');
    if (!back.playing) problems.push('Background stopped the sound');
    // Again, then the window's own close: paused, back home.
    await ev(`(() => { ${src}; return pipMain(); })()`, true);
    await sleep(800);
    await ev(`documentPictureInPicture.window && documentPictureInPicture.window.close()`);
    await sleep(800);
    const closed = await ev(`({ home: document.getElementById('box').contains(document.getElementById('v')), paused: document.getElementById('v').paused })`);
    if (!closed.home) problems.push('closing the window did not put the video back');
    if (!closed.paused) problems.push('closing the window did not pause (as the browser\'s own window does)');
    ws.close();
    return problems;
  } catch (e) {
    return [`the check itself failed: ${e.message}`];
  } finally {
    spawnSync(exe, ['close', '--user-data-dir', profile]);
    await sleep(1500);
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    server.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const p = await pipCheck();
  console.log(p.length ? `PIP CHECK FAILED:\n  ${p.join('\n  ')}` : 'PIP CHECK PASSED: the video plays in Gamblium\'s window, captions in proportion, Background keeps the sound, close pauses');
  process.exit(p.length ? 1 : 0);
}

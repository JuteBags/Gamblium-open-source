// End-to-end through the real launcher: `gamblium launch` on a fresh folder with
// the given presets, then window screenshots and a pref dump for verify.mjs.
//   node real.mjs <label> <outDir> [preset.json ...] [-- extra launcher args]
// Example extra args:  -- --theme burgundy-dark --force-dark
// Always closes the browser and removes the folder (see cdp.mjs for the rules).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GAMBLIUM, bravePidsOn, closeBrave, connect, winshot, sleep, splitArgs } from './cdp.mjs';

const [[label, outDir, ...presets], extra] = splitArgs(process.argv.slice(2));
fs.mkdirSync(outDir, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), `gamblium-design-${label}-`));
const port = 9400 + Math.floor(Math.random() * 400);
const args = [
  'launch',
  '--user-data-dir', profile,
  '--debug-port', String(port),
  ...presets.flatMap((p) => ['--preset-file', p]),
  ...extra,
  '--',
  '--disable-features=CalculateNativeWinOcclusion',
  '--window-size=1360,860',
  '--window-position=80,60',
];
let b;
let pid;
try {
  const t0 = Date.now();
  const r = spawnSync(GAMBLIUM, args, { encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  console.log('launcher exit', r.status, 'in', Date.now() - t0, 'ms');
  console.log(
    out
      .split(/\r?\n/)
      .filter((l) => l && !/^(profile )?prefs (changed|would)/.test(l))
      .join('\n'),
  );
  if (r.status !== 0 || /already running on this folder/i.test(out)) throw new Error('launcher did not start a new Brave');
  b = await connect(port);
  [pid] = bravePidsOn(profile);
  console.log('browser pid', pid);
  const shot = (name) => console.log(name, winshot(pid, path.join(outDir, `${label}-${name}.png`)));
  await sleep(6000);
  console.log('start tabs:', (await b.pages()).map((p) => p.url).join(' | '));
  const ntp = await b.open('brave://newtab/');
  await sleep(4000);
  shot('2-newtab');
  await b.send('Page.navigate', { url: 'https://en.wikipedia.org/wiki/Web_browser' }, ntp.sessionId);
  await sleep(7000);
  shot('3-article');
  for (const [url, file] of [
    ['brave://prefs-internals/', 'prefs.json'],
    ['brave://local-state/', 'local-state.json'],
  ]) {
    const t = await b.open(url);
    await sleep(2500);
    fs.writeFileSync(path.join(outDir, `${label}-${file}`), await b.evalIn(t.sessionId, 'document.body.innerText'));
    await b.send('Target.closeTarget', { targetId: t.targetId });
  }
} finally {
  const how = await closeBrave(b, pid, profile);
  console.log('browser', how);
  if (how === 'STILL RUNNING') process.exitCode = 1;
  else fs.rmSync(profile, { recursive: true, force: true });
}

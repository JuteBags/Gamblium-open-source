// What our new tab page costs while it is a hidden tab. Rule: nothing.
//   node idle.mjs <label> <outDir> [preset.json ...] [-- extra brave switches]
// Opens two of our new tab pages, hides them behind an ordinary page, lets the
// browser settle (SETTLE seconds, default 120), then reads every process's CPU
// time twice, WINDOW seconds apart (default 60). No debugger is attached to any
// tab while measuring. Afterwards it opens one more new tab page to see whether
// the visited sites show up under "Most visited".
// CONTROL=1 runs the same thing with blank tabs in place of our page, to tell the
// page's cost from the extension's background worker.
// PAGE=ui/dashboard.html measures another of our pages the same way.
// Always closes the browser and removes the folder (see cdp.mjs).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withBrave, winshot, sleep, splitArgs } from './cdp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(here, '../../../extension');
const ID = 'pbgbdlkcienglhbfadbjolphinilbpia';
const SETTLE = Number(process.env.SETTLE ?? 120);
const WINDOW = Number(process.env.WINDOW ?? 60);
const CONTROL = Boolean(process.env.CONTROL);
const PAGE = process.env.PAGE; // e.g. ui/dashboard.html: measure that page hidden, in place of the new tab page
const [[label, outDir, ...presets], extra] = splitArgs(process.argv.slice(2));
fs.mkdirSync(outDir, { recursive: true });

/** pid -> { ticks (100 ns of CPU time), kind, mb } for every Brave process on this folder. */
function sample(profile) {
  const needle = path.resolve(profile).replace(/'/g, "''");
  const out = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='brave.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${needle}') } | ForEach-Object { $k = 'browser'; if ($_.CommandLine -match '--type=([a-z-]+)') { $k = $Matches[1] }; if ($_.CommandLine -match '--utility-sub-type=([A-Za-z_.]+)') { $k = $k + ':' + $Matches[1] }; if ($_.CommandLine -like '*--extension-process*') { $k = 'extension page' }; '{0}|{1}|{2}|{3}' -f $_.ProcessId, ($_.KernelModeTime + $_.UserModeTime), $k, [int]($_.WorkingSetSize / 1MB) }`,
    ],
    { encoding: 'utf8' },
  );
  const map = new Map();
  for (const line of out.trim().split(/\r?\n/)) {
    const [pid, ticks, kind, mb] = line.trim().split('|');
    if (pid) map.set(Number(pid), { ticks: Number(ticks), kind, mb: Number(mb) });
  }
  return map;
}

await withBrave(
  { presets, tag: label, args: [`--load-extension=${EXT}`, '--disable-features=DisableLoadExtensionCommandLineSwitch', ...extra, ...(CONTROL ? ['about:blank'] : [])] },
  async ({ b, pid, profile }) => {
    await sleep(4000);
    // Ordinary pages first, visited the way a typed address is, so they count as
    // history for the tiles. The debugger lets go of the tab before measuring.
    const web = await b.open('about:blank');
    for (const url of ['https://en.wikipedia.org/wiki/Casino_token', 'https://www.iana.org/help/example-domains', 'https://en.wikipedia.org/wiki/Casino_token', 'https://example.com/']) {
      await b.send('Page.navigate', { url, transitionType: 'typed' }, web.sessionId);
      await sleep(3000);
    }
    await b.send('Target.detachFromTarget', { sessionId: web.sessionId });
    // CONTROL=1 opens a blank tab where the measured run opens our new tab page.
    await b.send('Target.createTarget', { url: CONTROL ? 'about:blank' : PAGE ? `chrome-extension://${ID}/${PAGE}` : 'brave://newtab/' });
    await sleep(2000);
    await b.send('Target.createTarget', { url: 'https://example.com/' });
    await sleep(2500);
    const tabs = (await b.pages()).map((t) => t.url);
    const ours = tabs.filter((u) => /newtab/.test(u)).length;
    console.log(`tabs: ${tabs.join('  ')}`);
    console.log(`new tab pages among them: ${ours} (hidden behind example.com)`);

    console.log(`settling ${SETTLE} s`);
    await sleep(SETTLE * 1000);
    const a = sample(profile);
    const t0 = Date.now();
    await sleep(WINDOW * 1000);
    const z = sample(profile);
    const secs = (Date.now() - t0) / 1000;

    const rows = [];
    let total = 0;
    for (const [p, end] of z) {
      const start = a.get(p);
      if (!start) continue;
      const pct = ((end.ticks - start.ticks) / 1e7 / secs) * 100;
      total += pct;
      rows.push({ pid: p, kind: end.kind, pct, mb: end.mb });
    }
    rows.sort((x, y) => y.pct - x.pct);
    const lines = [
      `${label}: ${rows.length} processes, ${SETTLE} s settle, ${secs.toFixed(0)} s window, ${ours} hidden new tab pages of ours`,
      `whole browser: ${total.toFixed(2)} % of one core`,
      ...rows.map((r) => `${r.pct.toFixed(2).padStart(6)} %  ${String(r.mb).padStart(5)} MB  ${r.kind}  (pid ${r.pid})`),
    ];
    fs.writeFileSync(path.join(outDir, `${label}-idle.txt`), lines.join('\n') + '\n');
    console.log(lines.join('\n'));

    // Measuring is over; now look at the tiles on a new tab page opened after some browsing.
    const ntp = await b.open('brave://newtab/');
    await sleep(3000);
    console.log('tiles:', JSON.stringify(await b.call(ntp.sessionId, () => ({
      url: location.href,
      sites: [...document.querySelectorAll('#top a .what')].map((s) => s.textContent.trim().slice(0, 40)),
      status: document.getElementById('status')?.textContent,
    }))));
    console.log('shot', winshot(pid, path.join(outDir, `${label}-tiles.png`)));
  },
);

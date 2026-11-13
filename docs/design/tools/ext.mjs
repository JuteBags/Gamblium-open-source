// Our own pages inside Brave: the new tab page and the security dashboard, with
// the extension loaded unpacked on a fresh throwaway folder.
//   node ext.mjs <label> <outDir> [preset.json ...] [-- extra brave switches]
// Also measures the new tab page's cost while hidden when STATS=1 (60 s).
// Always closes the browser and removes the folder (see cdp.mjs).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withBrave, winshot, sleep, splitArgs, GAMBLIUM } from './cdp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(here, '../../../extension');
const ID = 'pbgbdlkcienglhbfadbjolphinilbpia'; // fixed by the manifest "key"
const [[label, outDir, ...presets], extra] = splitArgs(process.argv.slice(2));
fs.mkdirSync(outDir, { recursive: true });

await withBrave(
  { presets, tag: label, args: [`--load-extension=${EXT}`, '--disable-features=DisableLoadExtensionCommandLineSwitch', ...extra] },
  async ({ b, pid, profile }) => {
    const shot = (name) => console.log(name, winshot(pid, path.join(outDir, `${label}-${name}.png`)));
    await sleep(4000);
    // Some history, so the new tab page has sites to show.
    const web = await b.open('https://en.wikipedia.org/wiki/Casino_token');
    await sleep(4000);
    await b.send('Page.navigate', { url: 'https://example.com/' }, web.sessionId);
    await sleep(2500);

    const ntp = await b.open('brave://newtab/');
    await sleep(3000);
    const info = await b.call(ntp.sessionId, () => ({
      url: location.href,
      title: document.title,
      sites: document.querySelectorAll('#sites .site').length,
      status: document.getElementById('status')?.textContent,
      bg: getComputedStyle(document.body).backgroundColor,
      errors: window.__errors ?? null,
    }));
    console.log('new tab:', JSON.stringify(info));
    shot('1-newtab');

    const sec = await b.open(`chrome-extension://${ID}/ui/security.html?raw&url=${encodeURIComponent('https://example.com/')}`);
    await sleep(3500);
    console.log('security:', JSON.stringify(await b.call(sec.sessionId, () => ({
      title: document.title,
      scope: document.getElementById('scope')?.textContent,
      scopeClass: document.getElementById('scope')?.className,
      capture: document.getElementById('capStatus')?.textContent,
      proxy: document.getElementById('proxyNow')?.textContent,
    }))));
    shot('2-security');

    if (process.env.STATS) {
      // The new tab page is now a hidden tab. Rule: it must cost nothing while idle.
      await sleep(5000);
      try {
        const out = execFileSync(GAMBLIUM, ['stats', '--marker', profile, '--duration', '60'], { encoding: 'utf8', timeout: 90000 });
        fs.writeFileSync(path.join(outDir, `${label}-stats.txt`), out);
        console.log(out);
      } catch (e) {
        console.log('stats failed:', e.message);
      }
    }
  },
);

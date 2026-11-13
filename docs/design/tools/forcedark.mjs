// How do web pages look with Chromium's forced dark mode? Page screenshots of a
// fixed set of sites, plus two CSS experiments on the first one.
//   node forcedark.mjs <label> <outDir> [preset.json ...] [-- extra brave switches]
// Forced dark on:  -- --enable-features=WebContentsForceDark
// Runs on a fresh throwaway folder and always closes it (see cdp.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { withBrave, sleep, splitArgs } from './cdp.mjs';

const [[label, outDir, ...presets], extra] = splitArgs(process.argv.slice(2));
const SITES = [
  ['light-only', 'https://news.ycombinator.com/'],
  ['news', 'https://www.bbc.com/news'],
  ['web-app', 'https://www.desmos.com/calculator'],
  ['images', 'https://commons.wikimedia.org/wiki/Commons:Featured_pictures'],
  ['own-dark', 'https://github.com/brave/brave-browser'],
];
const TINT = fs.readFileSync(new URL(`../../../extension/ui/tint-${process.env.SCHEME ?? 'burgundy'}.css`, import.meta.url), 'utf8');
const KEEP_LIGHT = fs.readFileSync(new URL('../../../extension/ui/keep-light.css', import.meta.url), 'utf8');
fs.mkdirSync(outDir, { recursive: true });

await withBrave({ presets, args: extra, tag: label }, async ({ b }) => {
  const addCss = (s, css) =>
    b.call(s, (text) => {
      const e = document.createElement('style');
      e.textContent = text;
      document.documentElement.append(e);
      return true;
    }, css);
  await sleep(3000);
  const t = await b.open('about:blank');
  for (const [name, url] of SITES) {
    await b.send('Page.navigate', { url }, t.sessionId);
    await sleep(name === 'light-only' ? 3500 : 8000);
    await b.pageShot(t.sessionId, path.join(outDir, `${label}-${name}.png`));
    console.log(name, '| prefers-color-scheme:', await b.evalIn(t.sessionId, "matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'"));
    if (name === 'light-only') {
      // 1. Tint: lift the darkest pixels to a dark theme colour, leave the rest alone.
      await addCss(t.sessionId, TINT);
      await sleep(700);
      await b.pageShot(t.sessionId, path.join(outDir, `${label}-light-only-tinted.png`));
      // 2. Opt-out: does a page that says "only light" escape forced dark?
      await b.send('Page.navigate', { url }, t.sessionId);
      await sleep(2500);
      await addCss(t.sessionId, KEEP_LIGHT);
      await sleep(700);
      await b.pageShot(t.sessionId, path.join(outDir, `${label}-light-only-optout.png`));
    }
  }
});

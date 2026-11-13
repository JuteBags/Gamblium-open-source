// Six views of one Brave setup, to judge a theme across the whole browser:
// window, new tab, address-bar dropdown, settings, app menu, context menu.
//   node tour.mjs <label> <outDir> [preset.json ...] [-- extra brave switches]
// QUICK=1 takes only the window, settings and app menu (for comparing variants).
// Runs on a fresh throwaway folder and always closes it (see cdp.mjs).
import path from 'node:path';
import { withBrave, winshot, uia, sleep, splitArgs } from './cdp.mjs';

const [[label, outDir, ...presets], extra] = splitArgs(process.argv.slice(2));
const QUICK = !!process.env.QUICK;

await withBrave({ presets, args: extra, tag: label }, async ({ b, pid }) => {
  const shot = (name) => console.log(name, winshot(pid, path.join(outDir, `${label}-${name}.png`)));
  await sleep(3500);
  const web = await b.open('https://en.wikipedia.org/wiki/Casino_token');
  await sleep(5000);
  shot('1-window');
  console.log('web pages see prefers-color-scheme:', await b.evalIn(web.sessionId, "matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'"));
  if (!QUICK) {
    await b.open('brave://newtab/');
    await sleep(3000);
    shot('2-newtab');
    console.log(uia(pid, 'omnibox', 'casino'));
    await sleep(1800);
    shot('3-omnibox');
  }
  await b.open('brave://settings/appearance');
  await sleep(4000);
  shot('4-settings');
  await b.open('about:blank');
  await sleep(1200);
  console.log(uia(pid, 'menu'));
  await sleep(1500);
  shot('5-menu');
  if (!QUICK) {
    console.log(uia(pid, 'menu')); // toggles the app menu shut again
    await sleep(600);
    await b.send('Target.activateTarget', { targetId: web.targetId });
    await sleep(1200);
    // A page menu only opens when the window is in front. This script never
    // brings a window to the front, so this shot shows a menu only when the
    // owner happens to have the test window active.
    await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 420, y: 380 }, web.sessionId);
    await b.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 420, y: 380, button: 'right', buttons: 2, clickCount: 1 }, web.sessionId);
    await b.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 420, y: 380, button: 'right', buttons: 0, clickCount: 1 }, web.sessionId);
    await sleep(1500);
    shot('6-context');
  }
});

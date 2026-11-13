// Inventory of Brave's own interface: toolbar controls and app-menu items as
// text (UI Automation), plus a screenshot with the menu open.
//   node menu.mjs <out.png> [preset.json ...] [-- extra brave switches]
// Runs on a fresh throwaway folder and always closes it (see cdp.mjs).
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withBrave, winshot, sleep, splitArgs } from './cdp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const [[out, ...presets], extra] = splitArgs(process.argv.slice(2));

await withBrave({ presets, args: extra, tag: 'menu' }, async ({ b, pid }) => {
  await sleep(4000);
  await b.open('about:blank');
  await sleep(1500);
  try {
    console.log(
      execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(here, 'uia.ps1'), '-ProcessId', String(pid)], {
        encoding: 'utf8',
        timeout: 60000,
      }),
    );
  } catch (e) {
    console.log('uia failed:', (e.stdout || '') + (e.stderr || e.message));
  }
  console.log(winshot(pid, out));
});

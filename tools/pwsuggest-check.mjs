// Right-click a password field -> "Suggest a strong password": both password fields get the
// same strong password and a card shows it. Throwaway profile, this checkout's extension.
// Also run by tools/gate.mjs. Usage: node tools/pwsuggest-check.mjs [shots dir]
import { spawnSync, execFileSync } from 'node:child_process';
import http from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 9385, SITE = 8785;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const winshot = join(repo, 'docs', 'design', 'tools', 'winshot.ps1');

async function connect(url) {
  const ws = new WebSocket(url); await new Promise((r) => (ws.onopen = r));
  let id = 0; const waiting = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d.result ?? d.error); waiting.delete(d.id); } };
  return { send: (method, params = {}) => new Promise((r) => { const n = ++id; waiting.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); }), close: () => ws.close() };
}
const ev = async (c, expression) => (await c.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }))?.result?.value;
function uia(pid, invoke = '') {
  const ps = `Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
$root=[Windows.Automation.AutomationElement]::RootElement
$c=New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ProcessIdProperty, ${pid})
$out=@()
foreach($w in $root.FindAll([Windows.Automation.TreeScope]::Children,$c)){ foreach($e in $w.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition)){ $n=$e.Current.Name; $t=$e.Current.ControlType.ProgrammaticName
  if($n -and $n.Length -lt 140){ $out+="$t|$n" }
  if('${invoke}' -ne '' -and $n -like '${invoke}*'){ foreach($pat in @([Windows.Automation.InvokePattern]::Pattern)){ try { $e.GetCurrentPattern($pat).Invoke(); $out+="INVOKED|$n" } catch {} } } } }
$out | Select-Object -Unique`;
  try { return execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', timeout: 60000 }).split(/\r?\n/).filter(Boolean); } catch { return ['uia failed']; }
}

export async function pwSuggestCheck(shots = null) {
  const problems = [];
  const server = http.createServer((q, r) => {
    if (q.method === 'POST') { r.writeHead(302, { location: '/welcome' }); return r.end(); }
    r.writeHead(200, { 'content-type': 'text/html' });
    r.end(q.url.startsWith('/signup') ? `<!doctype html><title>Sign up - Test Shop</title><body style="font:16px system-ui;margin:40px;background:#fff"><h1>Create account</h1><form method="post" action="/signup"><p><label>Email <input id="user" type="email" name="email" autocomplete="username"></label></p><p><label>Password <input id="pw" type="password" name="password" autocomplete="new-password"></label></p><p><label>Confirm password <input id="pw2" type="password" name="confirm_password" autocomplete="new-password"></label></p><button id="go">Create account</button></form>` : '<title>Welcome</title><h1>Welcome</h1>');
  }).listen(SITE, '127.0.0.1');
  const exe = join(process.env.LOCALAPPDATA, 'Gamblium', 'app', 'gamblium.exe');
  const profile = mkdtempSync(join(tmpdir(), 'gamblium-pws-'));
  try {
    spawnSync(exe, ['launch', '--user-data-dir', profile, '--debug-port', String(PORT), '--', '--window-size=1100,850'], { env: { ...process.env, GAMBLIUM_HOME: repo } });
    for (let i = 0; i < 60; i++) { await sleep(500); if (await fetch(`http://127.0.0.1:${PORT}/json/version`).then((x) => x.ok, () => false)) break; }
    await sleep(3000);
    const base = profile.split(/[\\/]/).pop();
    const pid = Number(execFileSync('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "Name='brave.exe'" | Where-Object { $_.CommandLine -like '*${base}*' -and $_.CommandLine -notlike '*--type=*' } | Select-Object -First 1).ProcessId`], { encoding: 'utf8' }).trim());
    const t = await fetch(`http://127.0.0.1:${PORT}/json/new?http://127.0.0.1:${SITE}/signup`, { method: 'PUT' }).then((r) => r.json());
    const c = await connect(t.webSocketDebuggerUrl);
    await c.send('Page.bringToFront');
    await sleep(3000);
    const user = await ev(c, `(() => { const r = document.getElementById('user').getBoundingClientRect(); return { x: r.x + 20, y: r.y + r.height / 2 }; })()`);
    for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, x: user.x, y: user.y, button: 'left', clickCount: 1 });
    await c.send('Input.insertText', { text: 'asha.test@example.com' });
    const at = await ev(c, `(() => { const r = document.getElementById('pw').getBoundingClientRect(); return { x: r.x + 20, y: r.y + r.height / 2 }; })()`);
    // Right-click until Gamblium's menu is open (its <gamblium-menu> element is on the page).
    let open = false;
    for (let n = 0; n < 4 && !open; n++) {
      await c.send('Page.bringToFront');
      await sleep(400);
      for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'right', clickCount: 1 });
      await sleep(1200);
      open = await ev(c, `!!document.querySelector('gamblium-menu')`);
    }
    if (!open) { problems.push('the Gamblium right-click menu did not open on the password field'); return { problems }; }
    if (shots) execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', winshot, '-ProcessId', String(pid), '-Out', join(shots, 'pw-1-menu.png')]);
    // The menu takes real keys only: past the four buttons of its top strip to the first entry.
    const key = async (k, code, vk) => { for (const type of ['rawKeyDown', 'keyUp']) await c.send('Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: vk }); };
    for (let n = 0; n < 5; n++) await key('ArrowDown', 'ArrowDown', 40);
    await key('Enter', 'Enter', 13);
    await sleep(1500);
    const v = await ev(c, `({ a: document.getElementById('pw').value, b: document.getElementById('pw2').value, card: !!document.getElementById('gamblium-pw-card') })`);
    if (v.a.length < 16) problems.push(`the password field holds ${v.a.length} characters`);
    if (v.a !== v.b) problems.push('the confirm field does not hold the same password');
    if (!/[A-Z]/.test(v.a) || !/[a-z]/.test(v.a) || !/[0-9]/.test(v.a) || !/[^A-Za-z0-9]/.test(v.a)) problems.push('the password lacks a kind of character');
    if (!v.card) problems.push('no card shows the new password');
    // The card must not cover the form's other fields or its button.
    const covers = await ev(c, `(() => { const card = document.getElementById('gamblium-pw-card').getBoundingClientRect(); const r = card; return ['pw2', 'go', 'user'].filter((id) => { const b = document.getElementById(id).getBoundingClientRect(); return !(b.right < r.left || b.left > r.left + 380 || b.bottom < r.top || b.top > r.top + 110); }); })()`);
    if (covers.length) problems.push(`the card covers ${covers.join(', ')}`);
    if (shots) execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', winshot, '-ProcessId', String(pid), '-Out', join(shots, 'pw-2-filled.png')]);
    // Sent: does the browser's own manager offer to save what we filled?
    const go = await ev(c, `(() => { const r = document.getElementById('go').getBoundingClientRect(); return { x: r.x + 10, y: r.y + r.height / 2 }; })()`);
    for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, x: go.x, y: go.y, button: 'left', clickCount: 1 });
    await sleep(3500);
    const after = uia(pid);
    const offered = after.some((l) => /Save password\?/.test(l));
    if (shots) execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', winshot, '-ProcessId', String(pid), '-Out', join(shots, 'pw-3-sent.png')]);
    c.close();
    return { problems, saveOffered: offered };
  } catch (e) {
    return { problems: [`the check itself failed: ${e.message}`] };
  } finally {
    spawnSync(exe, ['close', '--user-data-dir', profile]);
    await sleep(2500);
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    server.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const shots = process.argv[2] || null;
  if (shots) mkdirSync(shots, { recursive: true });
  const r = await pwSuggestCheck(shots);
  console.log(r.problems.length ? `PASSWORD SUGGEST CHECK FAILED:\n  ${r.problems.join('\n  ')}` : 'PASSWORD SUGGEST CHECK PASSED');
  console.log('browser offered to save the suggested password after sending:', r.saveOffered);
  process.exit(r.problems.length ? 1 : 0);
}

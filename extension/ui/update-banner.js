// "An update is ready" where people look (owner, Nov 14 2026: "people should know an update has
// come"): at the top of the Gamblium menu and across the top of the new tab page. Restart asks
// once, in place (every window closes; the tabs come back). On the new tab, "Later" hides it
// for that version.

const send = (msg) => new Promise((r) => chrome.runtime.sendMessage(msg, (a) => r(chrome.runtime.lastError ? null : a)));
const label = (v) => String(v || '').replace(/-beta\.(\d+)$/, ' beta $1');

export async function showUpdateBanner(where, { later = false } = {}) {
  const u = await send({ type: 'update-state' });
  if (!u || u.ok === false || !u.ready) return null;
  const version = u.update?.version || '';
  if (later) {
    const { updateLater } = await chrome.storage.local.get({ updateLater: '' });
    if (updateLater && updateLater === version) return null;
  }
  const host = document.createElement('div');
  host.className = 'gamblium-update';
  const root = host.attachShadow({ mode: 'open' });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
    .b { display: flex; align-items: center; gap: 10px; padding: 9px 12px; border-radius: 10px; margin: 8px;
      background: color-mix(in srgb, #3B82F6 22%, var(--surface, #1c1f26)); border: 1px solid color-mix(in srgb, #3B82F6 55%, transparent);
      color: var(--text, #e8eaf0); font: 13px/1.35 var(--font-ui, "Segoe UI", system-ui, sans-serif); }
    .i { width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center; background: #3B82F6; color: #fff; font-weight: 700; flex: none; }
    .t { flex: 1; min-width: 0; }
    .t b { font-weight: 600; }
    button { all: unset; cursor: pointer; padding: 5px 11px; border-radius: 7px; font-weight: 600; white-space: nowrap; }
    .go { background: #3B82F6; color: #fff; }
    .go:hover { background: #2563EB; }
    .later { color: var(--text-muted, #a3a9b7); }
    .later:hover { color: var(--text, #e8eaf0); }
  `);
  root.adoptedStyleSheets = [sheet];
  const b = document.createElement('div');
  b.className = 'b';
  b.setAttribute('role', 'status');
  const i = Object.assign(document.createElement('span'), { className: 'i', textContent: '↑' });
  const t = document.createElement('span');
  t.className = 't';
  t.append(Object.assign(document.createElement('b'), { textContent: `Gamblium ${label(version)} is ready.` }), ' Restart to update; your tabs come back.');
  const go = Object.assign(document.createElement('button'), { className: 'go', textContent: 'Restart to update' });
  go.addEventListener('click', async () => {
    if (!go.dataset.sure) {
      go.dataset.sure = '1';
      go.textContent = 'Close every window and update';
      return;
    }
    go.textContent = 'Restarting…';
    const r = await send({ type: 'update-restart' });
    if (!r || r.ok === false) {
      go.textContent = 'Restart to update';
      delete go.dataset.sure;
      t.textContent = r?.error || 'The update could not start.';
    }
  });
  b.append(i, t, go);
  if (later) {
    const l = Object.assign(document.createElement('button'), { className: 'later', textContent: 'Later' });
    l.addEventListener('click', async () => {
      await chrome.storage.local.set({ updateLater: version });
      host.remove();
    });
    b.append(l);
  }
  root.append(b);
  where.prepend(host);
  return host;
}

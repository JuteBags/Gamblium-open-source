// The command bar over the page (owner, Nov 15 2026: "see Zen's command bar, ours is so bad"):
// Alt+K puts it here instead of in a window of its own (which always had the system's frame).
// The page is dimmed and blurred behind it; the bar itself is our own page (ui/commandbar.html)
// in a frame, so the page cannot read it or restyle it. A click outside or Esc closes it.
// Injected on demand by background.js, and loaded by our new tab page for the same use.
(() => {
  const ID = 'gamblium-commandbar';
  const open = (windowId) => {
    const old = document.getElementById(ID);
    if (old) return old.remove(); // Alt+K again closes it
    const host = document.createElement('div');
    host.id = ID;
    const root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `
      :host { all: initial; position: fixed; inset: 0; z-index: 2147483647; }
      .shade { position: absolute; inset: 0; background: rgba(6, 7, 10, .42); backdrop-filter: blur(6px) saturate(.9);
        animation: fade .12s ease-out; }
      iframe { position: absolute; left: 50%; top: 14vh; transform: translateX(-50%); width: min(680px, calc(100vw - 32px));
        height: 120px; max-height: calc(100vh - 14vh - 16px); border: 0; border-radius: 16px; background: transparent; color-scheme: normal;
        animation: rise .14s ease-out; }
      @keyframes fade { from { opacity: 0; } }
      @keyframes rise { from { opacity: 0; transform: translate(-50%, -6px); } }
      @media (prefers-reduced-motion: reduce) { .shade, iframe { animation: none; } }
    `;
    const shade = document.createElement('div');
    shade.className = 'shade';
    const frame = document.createElement('iframe');
    frame.src = chrome.runtime.getURL(`ui/commandbar.html?overlay=1&w=${windowId ?? ''}`);
    frame.allow = 'clipboard-read; clipboard-write';
    frame.setAttribute('allowtransparency', 'true');
    root.append(style, shade, frame);
    const close = () => {
      host.remove();
      removeEventListener('message', onMessage);
      removeEventListener('keydown', onKey, true);
    };
    const onMessage = (e) => {
      if (e.source !== frame.contentWindow) return;
      if (e.data?.type === 'gamblium-commandbar-close') close();
      if (e.data?.type === 'gamblium-commandbar-size') frame.style.height = `${Math.min(560, Math.max(80, Number(e.data.height) || 0))}px`;
    };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
    shade.addEventListener('mousedown', close);
    addEventListener('message', onMessage);
    addEventListener('keydown', onKey, true);
    // The page hands the keyboard to the bar: a frame may not take it by itself.
    const give = () => {
      if (document.activeElement && document.activeElement !== host) document.activeElement.blur?.();
      frame.focus();
      frame.contentWindow?.postMessage({ type: 'gamblium-commandbar-focus' }, '*');
    };
    frame.addEventListener('load', () => { give(); setTimeout(give, 60); setTimeout(give, 250); });
    (document.body || document.documentElement).append(host);
  };
  globalThis.__gambliumCommandBar = open;
})();

// Peek (owner, Nov 14 2026, "like Zen's Glance"): Shift+click on a link opens it as a card over
// this page, the page behind dimmed; buttons beside the card close it or keep it as a tab. Esc
// or a click outside closes it. Registered by background.js only while Peek is on.
//
// The card is a frame. Sites that refuse to be framed say so in a header; background.js removes
// that header for this tab's frames while the card is open (a session rule for this tab only).
// The frame may not navigate this page. Inside it the site may look signed out: the browser
// keeps third-party cookies from frames; "Open as tab" shows it as usual.
(() => {
  if (window.__gambliumPeek) return;
  window.__gambliumPeek = true;
  // Inside the card (the frame is named for it): Esc there closes the card too.
  if (window.top !== window) {
    if (window.name === 'gamblium-peek') {
      addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          try {
            chrome.runtime.sendMessage({ type: 'peek-esc' });
          } catch {
            /* reloaded */
          }
        }
      }, true);
    }
    return;
  }

  const send = (msg) => new Promise((r) => {
    try {
      chrome.runtime.sendMessage(msg, (a) => r(chrome.runtime.lastError ? null : a));
    } catch {
      r(null);
    }
  });

  let open = null; // { host, url }

  function close() {
    if (!open) return;
    const { host } = open;
    open = null;
    host.dataset.state = 'out';
    setTimeout(() => host.remove(), 160);
    removeEventListener('keydown', onKey, true);
    send({ type: 'peek-done' });
  }
  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      close();
    }
  }

  async function peek(url) {
    if (open) close();
    // The header that forbids framing goes, for this tab, before the frame asks.
    await send({ type: 'peek-frame' });
    const host = document.createElement('div');
    host.id = 'gamblium-peek';
    host.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483647;';
    const root = host.attachShadow({ mode: 'closed' });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(`
      :host { all: initial; }
      .back { position: fixed; inset: 0; background: rgba(8, 10, 14, .48); backdrop-filter: blur(2px); opacity: 0; transition: opacity .16s ease; }
      .wrap { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; gap: 10px; pointer-events: none; }
      .card { pointer-events: auto; width: min(86vw, 1400px); height: 88vh; border-radius: 14px; overflow: hidden; background: #fff;
        box-shadow: 0 24px 80px rgba(0,0,0,.45), 0 0 0 1px rgba(255,255,255,.08); opacity: 0; transform: scale(.965) translateY(8px);
        transition: opacity .16s ease, transform .18s cubic-bezier(.2,.8,.2,1); }
      iframe { width: 100%; height: 100%; border: 0; display: block; background: #fff; }
      .side { pointer-events: auto; align-self: flex-start; margin-top: 6vh; display: grid; gap: 8px; opacity: 0; transition: opacity .16s ease; }
      button { all: unset; cursor: pointer; width: 38px; height: 38px; display: grid; place-items: center; border-radius: 10px;
        background: rgba(30, 33, 41, .92); color: #e8eaf0; font: 16px/1 "Segoe UI", system-ui, sans-serif; box-shadow: 0 4px 16px rgba(0,0,0,.35); }
      button:hover { background: rgba(60, 66, 80, .95); }
      :host([data-state="in"]) .back, :host([data-state="in"]) .side { opacity: 1; }
      :host([data-state="in"]) .card { opacity: 1; transform: none; }
    `);
    root.adoptedStyleSheets = [sheet];
    const back = document.createElement('div');
    back.className = 'back';
    const wrap = document.createElement('div');
    wrap.className = 'wrap';
    const card = document.createElement('div');
    card.className = 'card';
    const frame = document.createElement('iframe');
    // Scripts and forms work; it may not take over this page.
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads');
    frame.setAttribute('allow', 'fullscreen; clipboard-write; autoplay; picture-in-picture');
    frame.name = 'gamblium-peek';
    frame.src = url;
    card.append(frame);
    const side = document.createElement('div');
    side.className = 'side';
    const button = (text, title, fn) => {
      const b = document.createElement('button');
      b.textContent = text;
      b.title = title;
      b.setAttribute('aria-label', title);
      b.addEventListener('click', fn);
      return b;
    };
    side.append(
      button('✕', 'Close (Esc)', close),
      button('⤢', 'Open as tab', async () => {
        const u = open?.url || url;
        close();
        await send({ type: 'peek-open', url: u, active: true });
      }),
      button('⇱', 'Open in a background tab, keep reading here', async () => {
        await send({ type: 'peek-open', url: open?.url || url, active: false });
        close();
      }),
    );
    wrap.append(card, side);
    // A click on the dimmed page closes it; a click in the card does not.
    wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
    back.addEventListener('click', close);
    root.append(back, wrap);
    (document.body || document.documentElement).append(host);
    open = { host, url };
    // Where the card was led to inside (its own links), for "Open as tab".
    frame.addEventListener('load', () => {
      try {
        open && (open.url = frame.contentWindow.location.href || open.url);
      } catch {
        /* another site: its address is not ours to read; the first one is kept */
      }
    });
    addEventListener('keydown', onKey, true);
    requestAnimationFrame(() => requestAnimationFrame(() => (host.dataset.state = 'in')));
  }

  chrome.runtime.onMessage.addListener((m) => {
    if (m && m.type === 'peek-close') close();
  });

  document.addEventListener(
    'click',
    (e) => {
      if (!e.shiftKey || e.button !== 0 || e.ctrlKey || e.metaKey || e.altKey) return;
      const a = e.target instanceof Element ? e.target.closest('a[href]') : null;
      if (!a || !/^https?:/i.test(a.href)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      peek(a.href);
    },
    true,
  );
})();

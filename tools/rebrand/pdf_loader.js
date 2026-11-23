// Gamblium PDF loader. tools/rebrand/extra.py writes this over the start script (main.js) of the
// browser's own PDF viewer page in the rebranded copy, so every PDF (a website's, a file on this
// computer, one inside a page) opens in Gamblium PDF while the address bar keeps the PDF's own
// address. The viewer itself lives in the Gamblium extension (pdf/viewer.html, Rust engine);
// this page only gives it the PDF.
//
// Our viewer is asked first: it answers "ready" (or "off" when the person switched Gamblium PDF
// off), then gets the PDF's address and reads it itself (a website's again, with the person's
// cookies; a file through Gamblium's helper): the browser's stream is served only to its own
// viewer. No answer within a few seconds (the extension missing or disabled), "off", or a PDF
// our viewer could not read (made after a form was sent, a link that expires): the browser's own
// viewer starts with the stream it still has, as main.js did before.
const OURS = 'chrome-extension://pbgbdlkcienglhbfadbjolphinilbpia';
const WAIT_MS = 4000;

function streamInfo() {
  return new Promise((resolve) => {
    if (document.documentElement.hasAttribute('pdfOopifEnabled')) chrome.pdfViewerPrivate.getStreamInfo(resolve);
    else chrome.mimeHandlerPrivate.getStreamInfo(resolve);
  });
}

function nameOf(url) {
  try {
    const last = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
    return last || 'document.pdf';
  } catch {
    return 'document.pdf';
  }
}

// The browser's own viewer: what main.js did, with its imports loaded only now.
async function browserViewer() {
  document.getElementById('gamblium-pdf')?.remove();
  const pending = [];
  const keep = (m) => pending.push(m);
  window.addEventListener('message', keep, false);
  const [{ createBrowserApi }] = await Promise.all([import('./browser_api.js'), import('./pdf_viewer_wrapper.js')]);
  let api = await createBrowserApi();
  if (chrome.contentSettings) {
    api = await new Promise((resolve) => chrome.contentSettings.javascript.get({ primaryUrl: api.getStreamInfo().originalUrl, secondaryUrl: window.location.origin }, (r) => {
      api.getStreamInfo().javascript = r.setting;
      resolve(api);
    }));
  }
  window.removeEventListener('message', keep, false);
  const viewer = document.querySelector('pdf-viewer');
  viewer.init(api);
  while (pending.length) viewer.handleScriptingMessage(pending.shift());
  Object.assign(window, { viewer });
}

async function main() {
  const info = await streamInfo();
  const name = nameOf(info.originalUrl);
  if (!info.embedded) document.title = name;
  const frame = document.createElement('iframe');
  frame.id = 'gamblium-pdf';
  frame.src = `${OURS}/pdf/viewer.html?embed=1&name=${encodeURIComponent(name)}&url=${encodeURIComponent(info.originalUrl)}`;
  frame.allow = 'clipboard-read; clipboard-write';
  Object.assign(frame.style, { position: 'fixed', inset: '0', width: '100%', height: '100%', border: '0', background: '#1A1B1F' });
  document.body.append(frame);

  const answer = await new Promise((resolve) => {
    const t = setTimeout(() => resolve('none'), WAIT_MS);
    window.addEventListener('message', function on(e) {
      if (e.origin !== OURS || e.source !== frame.contentWindow) return;
      if (e.data?.type !== 'gamblium-pdf-ready') return;
      clearTimeout(t);
      window.removeEventListener('message', on);
      resolve(e.data.off ? 'off' : 'ready');
    });
  });
  if (answer !== 'ready') return browserViewer();
  window.addEventListener('message', (e) => {
    if (e.origin === OURS && e.source === frame.contentWindow && e.data?.type === 'gamblium-pdf-fallback') browserViewer();
  });
  frame.contentWindow.postMessage({ type: 'gamblium-pdf-url', url: info.originalUrl, name }, OURS);
  frame.focus();
}

main();

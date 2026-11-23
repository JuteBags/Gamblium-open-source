// Gamblium PDF: draws pages in a worker of its own (pdf/viewer.js keeps a small pool). Each worker
// has its own copy of the engine, so drawing spreads over cores, and when the pool is closed after
// a quiet spell the engine's memory goes with the worker (WebAssembly memory never shrinks).
import init, { Viewer } from './engine/gamblium_pdf.js';

const ready = init();
let viewer = null;
let version = -1;

self.onmessage = async (e) => {
  const { id, op } = e.data;
  try {
    await ready;
    if (op === 'load') {
      viewer?.free?.();
      viewer = new Viewer(e.data.bytes);
      version = e.data.version;
      return self.postMessage({ id, ok: true });
    }
    if (e.data.version !== version || !viewer) return self.postMessage({ id, stale: true });
    if (op === 'render') {
      const px = viewer.render(e.data.page, e.data.scale);
      // The page's words come with its pixels (the text layer), so the page itself never has to
      // read the page with its own engine while someone only reads.
      const words = e.data.words ? viewer.words(e.data.page) : null;
      // Raw pixels, put straight into a (lent) canvas by the page. Not an ImageBitmap: pictures
      // go through the browser's image caches, which kept one entry per page ever drawn, about
      // 500 MB after reading 60 pages (memory trace, Nov 16 2026).
      return self.postMessage({ id, px, words }, [px.buffer]);
    }
    self.postMessage({ id, error: `unknown op ${op}` });
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};

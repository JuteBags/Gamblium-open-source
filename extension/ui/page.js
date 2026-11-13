// What every Gamblium page and the popup share: talking to the background,
// building elements, and opening our own pages without stacking duplicates.

import { cleanUrl } from './address.js'; // also moves a page opened by itself under the clean address
import { routeOf } from '../routes.js';

export const $ = (id) => document.getElementById(id);

// The colour scheme lives in extension storage: picked in Settings, or taken
// from the theme the browser was started with. scheme.js applies its copy in
// localStorage before first paint; this brings that copy up to date, for this
// page now and for every page opened after it.
chrome.storage.local.get({ scheme: null, colours: null }).then(({ scheme, colours }) => {
  try {
    const text = colours ? JSON.stringify(colours) : null;
    if (localStorage.getItem('gamblium.colours') !== text) {
      if (text) localStorage.setItem('gamblium.colours', text);
      else localStorage.removeItem('gamblium.colours');
    }
  } catch {
    // Storage is blocked; the colours still apply to this page.
  }
  globalThis.gambliumColours?.(colours);
  if (!scheme) return;
  try {
    if (localStorage.getItem('gamblium.scheme') !== scheme) localStorage.setItem('gamblium.scheme', scheme);
  } catch {
    // Storage is blocked; the scheme still applies to this page.
  }
  document.documentElement.dataset.scheme = scheme;
});

// Every call answers with an object; a failure never throws past here.
export const send = async (msg) => {
  try {
    return (await chrome.runtime.sendMessage(msg)) ?? { ok: false, error: 'The extension did not answer.' };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
};
export const helper = (request) => send({ type: 'native', request });

export function el(tag, props = {}, children = []) {
  const e = Object.assign(document.createElement(tag), props);
  for (const c of [].concat(children)) e.append(c);
  return e;
}
export const td = (content, className = '') => el('td', { className }, content);
export const th = (text, className = '') => el('th', { className, textContent: text, scope: 'col' });
export const pill = (text, cls = '') => el('span', { className: `pill ${cls}`.trim(), textContent: text });
export const button = (text, onClick, className = '') => {
  const b = el('button', { type: 'button', className, textContent: text });
  b.addEventListener('click', onClick);
  return b;
};

/** A notice line: kind is '', ok, warn or bad. An empty text hides it. */
export function say(node, kind, text) {
  node.className = `notice ${kind}`.trim();
  node.textContent = text;
  node.hidden = !text;
}

/** Opens one of our pages. A tab already showing that page is brought forward instead. */
export async function openPage(file, query = '') {
  const url = chrome.runtime.getURL(file);
  const { plainAddresses } = await chrome.storage.local.get({ plainAddresses: false });
  if (!query) {
    const name = routeOf(file);
    const open = (await chrome.tabs.query({})).find((t) => pageOfTab(t.url) === name || (t.url || '').split(/[?#]/)[0] === url);
    if (open) {
      await chrome.tabs.update(open.id, { active: true });
      await chrome.windows.update(open.windowId, { focused: true });
      return;
    }
  }
  // Under the new tab document the address bar stays clean; see ui/address.js.
  await chrome.tabs.create({ url: (!plainAddresses && cleanUrl(file + query)) || url + query });
}

/** Which of our pages a tab shows ("settings", "tabs", ...), whether by itself or inside the new tab document. */
export function pageOfTab(tabUrl) {
  const u = String(tabUrl ?? '');
  const framed = /^(?:chrome:\/\/newtab\/|chrome-extension:\/\/[a-p]{32}\/newtab\/index\.html)#\/([a-z-]+)/.exec(u);
  if (framed) return framed[1];
  const own = /^chrome-extension:\/\/[a-p]{32}\/(ui\/[a-z-]+\.html)/.exec(u);
  return own ? routeOf(own[1]) : null;
}

/**
 * Runs `tick` now and then every `ms`, but only while the page is showing and
 * `wanted()` is true. A hidden page does nothing at all.
 */
export function whileVisible(tick, ms, wanted = () => true) {
  let timer = null;
  const stop = () => {
    clearTimeout(timer);
    timer = null;
  };
  const loop = async () => {
    stop();
    if (document.visibilityState !== 'visible') return;
    await tick();
    if (document.visibilityState === 'visible' && wanted()) timer = setTimeout(loop, ms);
  };
  document.addEventListener('visibilitychange', () => (document.visibilityState === 'visible' ? loop() : stop()));
  loop();
  return loop; // call it to refresh at once
}

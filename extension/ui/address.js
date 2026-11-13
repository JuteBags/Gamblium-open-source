// A page of ours opened as a tab by itself would show
// chrome-extension://<id>/ui/....html in the address bar. It moves its tab to
// the new tab document instead, which shows the same page under an address the
// browser keeps empty (see newtab/boot.js). Imported by every page; does
// nothing inside that frame, in the popup, or when asked not to:
//   ?raw in the address, or chrome.storage.local.plainAddresses = true
// (for tests and for anyone who wants the plain address).
import { routeOf } from '../routes.js';

/** The address that shows one of our files with a clean address bar, or null if it is not one of our pages. */
export function cleanUrl(file) {
  const route = routeOf(file);
  return route === null ? null : 'chrome://newtab/#/' + route;
}

const route = window.top === window.self && !new URLSearchParams(location.search).has('raw') ? routeOf(location.pathname + location.search + location.hash) : null;
// Coming back with the Back button must not bounce forward again.
const back = performance.getEntriesByType('navigation')[0]?.type === 'back_forward';
if (route !== null && !back) {
  Promise.all([chrome.storage.local.get({ plainAddresses: false }), chrome.tabs.getCurrent()]).then(([{ plainAddresses }, tab]) => {
    if (!plainAddresses && tab) chrome.tabs.update(tab.id, { url: 'chrome://newtab/#/' + route });
  }, () => {});
}

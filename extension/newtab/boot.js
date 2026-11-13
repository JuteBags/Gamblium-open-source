// The new tab document has one address the browser never shows. So it is two
// things: the new tab page, and, when its address ends in "#/<route>", the
// frame around one of our own pages (settings, history, ...), which then has
// a clean address bar instead of chrome-extension://<id>/ui/....
import { fileOf } from '../routes.js';

const route = location.hash.startsWith('#/') ? location.hash.slice(2) : '';
const file = route ? fileOf(route) : null;
if (file) {
  (await import('./shell.js')).show(file);
} else {
  if (route) history.replaceState(null, '', location.pathname); // a route nobody knows: just the new tab page
  delete document.documentElement.dataset.route;
  await import('./newtab.js');
}

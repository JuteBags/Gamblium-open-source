import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, routeOf, fileOf, pretty, suggestRoutes, PAGES, BROWSER, TITLES } from './routes.js';

const ID = 'pbgbdlkcienglhbfadbjolphinilbpia';

test('our pages resolve to a file and a route', () => {
  assert.deepEqual(resolve('gamblium://settings'), { kind: 'page', name: 'settings', file: 'ui/settings.html', rest: '', route: 'settings' });
  assert.deepEqual(resolve('Gamblium://Settings/look'), { kind: 'page', name: 'settings', file: 'ui/settings.html', rest: '#look', route: 'settings#look' });
  assert.equal(resolve('gamblium:downloads?demo').route, 'downloads?demo');
  assert.equal(resolve('gamblium://dashboard').file, 'ui/dashboard.html');
  assert.equal(resolve('gamblium://library').name, 'history');
  assert.equal(resolve('gamblium://security?url=https%3A%2F%2Fa.com%2F&panel=audit').rest, '?url=https%3A%2F%2Fa.com%2F&panel=audit');
});

test('the browser\'s pages: named ones, and everything else passes through', () => {
  assert.deepEqual(resolve('gamblium://gpu'), { kind: 'browser', name: 'gpu', url: 'chrome://gpu/' });
  assert.equal(resolve('gamblium://passwords').url, 'chrome://password-manager/passwords');
  assert.equal(resolve('gamblium://settings-reset').url, 'chrome://settings-reset/');
  assert.equal(resolve('gamblium://history/journeys').kind, 'page'); // history is ours
  assert.equal(resolve('gamblium://net-export/x?y=1').url, 'chrome://net-export/x?y=1');
  assert.equal(resolve('gamblium://').url, 'chrome://newtab/');
});

test('only gamblium addresses resolve, unless the box says a name is being typed', () => {
  assert.equal(resolve('settings'), null);
  assert.equal(resolve('https://gamblium.example/settings'), null);
  assert.equal(resolve('brave://gpu'), null);
  assert.equal(resolve('gamblium://bad name'), null);
  assert.equal(resolve('settings/look', { bare: true }).route, 'settings#look');
  assert.equal(resolve('gpu', { bare: true }).url, 'chrome://gpu/');
});

test('routes and files turn into each other', () => {
  assert.equal(routeOf('ui/settings.html#look'), 'settings#look');
  assert.equal(routeOf('/ui/security.html?url=x&panel='), 'security?url=x&panel=');
  assert.equal(routeOf('ui/dashboard.html'), 'tabs');
  assert.equal(routeOf('popup.html'), null);
  assert.equal(routeOf('ui/unknown.html'), null);
  assert.equal(fileOf('#/settings#look'), 'ui/settings.html#look');
  assert.equal(fileOf('tabs'), 'ui/dashboard.html');
  assert.equal(fileOf('/security?url=x'), 'ui/security.html?url=x');
  assert.equal(fileOf('gpu'), null);
  for (const [name, file] of Object.entries(PAGES)) assert.equal(fileOf(routeOf(file)), file, name);
});

test('pretty: how an address reads in our words', () => {
  assert.equal(pretty(`chrome-extension://${ID}/ui/settings.html#look`, ID), 'gamblium://settings#look');
  assert.equal(pretty(`chrome-extension://${ID}/newtab/index.html`), 'gamblium://newtab');
  assert.equal(pretty(`chrome-extension://${'a'.repeat(32)}/ui/settings.html`, ID), null);
  assert.equal(pretty('chrome://gpu/'), 'gamblium://gpu');
  assert.equal(pretty('brave://settings/search'), 'gamblium://search');
  assert.equal(pretty('chrome://settings/appearance'), 'gamblium://settings/appearance');
  assert.equal(pretty('https://example.com/'), null);
});

test('every name has a title, and suggestions narrow as you type', () => {
  for (const name of [...Object.keys(PAGES), ...Object.keys(BROWSER)]) assert.ok(TITLES[name], name);
  assert.deepEqual(suggestRoutes('gamblium://set').map((s) => s.name), ['settings', 'browser']);
  assert.equal(suggestRoutes('gamblium://gp')[0].address, 'gamblium://gpu');
  assert.equal(suggestRoutes('gamblium://').length, 6);
  assert.deepEqual(suggestRoutes('gamblium://zzz'), []);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gather, googleSignIn } from './ui/bring.js';

test('accounts and sites from every browser, each once, with where they came from', () => {
  const r = gather({ browsers: [
    { browser: 'Chrome', profiles: [
      { name: 'Work', accounts: [{ email: 'W@x.org', name: 'W' }], sites: [{ site: 'github.com', origin: 'https://github.com', users: ['me'] }] },
      { name: 'Chrome', accounts: [], sites: [] },
    ] },
    { browser: 'Edge', profiles: [
      { name: 'Profile 1', accounts: [{ email: 'w@x.org' }], sites: [{ site: 'github.com', origin: 'https://github.com', users: ['me', 'bot'] }, { site: 'a.org', origin: 'https://a.org', users: [] }] },
    ] },
  ] });
  assert.equal(r.accounts.length, 1);
  assert.deepEqual(r.accounts[0].from, ['Chrome · Work', 'Edge · Profile 1']);
  assert.equal(r.sites.length, 2);
  assert.deepEqual(r.sites[0].users, ['me', 'bot']);
  assert.deepEqual(r.sites[0].from, ['Chrome', 'Edge']);
  assert.deepEqual(gather(null), { accounts: [], sites: [] });
  assert.ok(googleSignIn('a+b@x.org').includes('Email=a%2Bb%40x.org'));
});

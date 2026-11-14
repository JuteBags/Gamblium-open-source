import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { OPS, readJwt, weakSecret } from './decode.js';

const b64u = (s) => Buffer.from(s).toString('base64url');
const sign = (h, p, secret) => {
  const signed = b64u(JSON.stringify(h)) + '.' + b64u(JSON.stringify(p));
  return signed + '.' + createHmac('sha256', secret).update(signed).digest('base64url');
};

test('encode and decode both ways, text with any letters', () => {
  for (const s of ['hello world', 'naïve ☕ 日本', '', 'a+b/c=d?e&f']) {
    assert.equal(OPS['base64-decode'](OPS['base64-encode'](s).out).out, s);
    assert.equal(OPS['base64-decode'](OPS['base64url-encode'](s).out).out, s);
    assert.equal(OPS['url-decode'](OPS['url-encode'](s).out).out, s);
    assert.equal(OPS['hex-decode'](OPS['hex-encode'](s).out).out, s);
    assert.equal(OPS['html-decode'](OPS['html-encode'](s).out).out, s);
  }
  assert.equal(OPS['base64-encode']('hi').out, 'aGk=');
  assert.equal(OPS['url-decode']('a+b%20c').out, 'a b c');
  assert.equal(OPS['html-decode']('&lt;b&gt; &#x41;&#66;').out, '<b> AB');
  assert.equal(OPS['hex-decode']('0x48 0x69').out, 'Hi');
  assert.equal(OPS['base64-decode']('/w==').note, 'Not text: shown as hex');
  assert.throws(() => OPS['base64-decode']('not base64!'), /not Base64/);
  assert.throws(() => OPS['url-decode']('%zz'), /not URL-encoded/);
  assert.throws(() => OPS['json-pretty']('{x'), /not JSON/);
  assert.equal(OPS['json-pretty']('{"a":1}').out, '{\n  "a": 1\n}');
});

test('a JWT is read, with its times and what is risky about it', () => {
  const t = sign({ alg: 'HS256', typ: 'JWT' }, { sub: '42', iat: 1700000000, exp: 1700003600 }, 'secret');
  const j = readJwt('Bearer ' + t, 1800000000000);
  assert.equal(j.alg, 'HS256');
  assert.equal(j.payload.sub, '42');
  assert.equal(j.times.expires, '2023-11-14 23:13:20 UTC');
  assert.equal(j.expired, true);
  assert.deepEqual(j.warnings, []);
  const none = readJwt(b64u('{"alg":"none"}') + '.' + b64u('{"admin":true}') + '.');
  assert.match(none.warnings.join(' '), /"none"/);
  assert.match(none.warnings.join(' '), /no expiry/);
  assert.equal(readJwt('a.b.c'), null);
  assert.equal(readJwt('hello'), null);
});

test('a token signed with a common secret is caught; a strong one is not', async () => {
  const weak = readJwt(sign({ alg: 'HS256' }, { u: 1, exp: 9e9 }, 'your-256-bit-secret'));
  assert.equal(await weakSecret(weak), 'your-256-bit-secret');
  const strong = readJwt(sign({ alg: 'HS256' }, { u: 1, exp: 9e9 }, 'f3A9#kq!long-random-' + Math.random()));
  assert.equal(await weakSecret(strong), null);
  assert.equal(await weakSecret(readJwt(b64u('{"alg":"RS256"}') + '.' + b64u('{}') + '.sig')), null);
});

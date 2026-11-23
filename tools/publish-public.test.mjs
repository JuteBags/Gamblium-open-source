// node --test tools/publish-public.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { refusals, FORBIDDEN_NAME, PRIVATE } from './publish-public.mjs';

test('keys, certificates and env files are refused by name', () => {
  for (const f of ['a/extension-key.pem', '.env', 'x/.env.local', 'sign.pfx', 'c.p12', 'id.key']) assert.ok(FORBIDDEN_NAME.test(f), f);
  for (const f of ['env.example', 'extension/manifest.json', 'docs/keys.md', 'tokens.css']) assert.ok(!FORBIDDEN_NAME.test(f), f);
});

test('a private key inside any file is refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'publish-test-'));
  try {
    writeFileSync(join(dir, 'ok.txt'), 'nothing here');
    // Built at run time: the literal header in this file would make the script refuse to publish it.
    const header = ['-----BEGIN', 'PRIVATE', 'KEY-----'].join(' ');
    writeFileSync(join(dir, 'oops.js'), `const k = '${header}';`);
    assert.deepEqual(refusals(dir, ['ok.txt', 'oops.js']), ['oops.js: holds a private key']);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  }
});

test('the internal files stay out', () => {
  for (const p of ['docs/KT-design-agent.md', 'CLAUDE.md', 'TASK.md', '.claude']) assert.ok(PRIVATE.includes(p), p);
});

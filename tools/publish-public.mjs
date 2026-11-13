// Publishes the development repository's main to the public repository as ONE new commit.
// The public history is its own: each publish adds a commit whose tree is the chosen dev commit
// minus PRIVATE paths, so no development history, author address or internal note leaks.
//
//   node tools/publish-public.mjs            dry run: what would change, nothing pushed
//   node tools/publish-public.mjs --push     publish
//   options: --ref <dev ref> (default origin/main), --public <url>, --author "Name <address>"
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const PUBLIC = 'https://github.com/JuteBags/Gamblium-open-source.git';
const AUTHOR = 'IsNoobgrammer <112808251+IsNoobgrammer@users.noreply.github.com>'; // GitHub noreply, not a mailbox
// Files the development repository may hold that are not for the public one.
export const PRIVATE = ['docs/KT-design-agent.md', 'CLAUDE.md', 'TASK.md', '.claude', '.env'];
// Never published, whatever the path: a private key, an env file or a certificate.
export const FORBIDDEN_NAME = /(^|\/)(\.env(\..*)?|.*\.(pem|pfx|p12|key))$/i;
export const FORBIDDEN_TEXT = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
}
function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout.trim();
}

/** The paths of the tree at `cwd` that may not be published, with the reason. */
export function refusals(cwd, files) {
  const bad = [];
  for (const f of files) {
    if (FORBIDDEN_NAME.test(f)) { bad.push(`${f}: a key, certificate or env file`); continue; }
    let text = '';
    try { text = readFileSync(join(cwd, f), 'latin1'); } catch { continue; }
    if (FORBIDDEN_TEXT.test(text)) bad.push(`${f}: holds a private key`);
  }
  return bad;
}

async function main() {
  const dev = resolve('.');
  const ref = arg('--ref', 'origin/main');
  const url = arg('--public', PUBLIC);
  const [name, email] = (arg('--author', AUTHOR).match(/^(.*?)\s*<(.+)>$/) || []).slice(1);
  if (!name || !email) throw new Error('--author must look like "Name <address>"');
  const push = process.argv.includes('--push');

  if (ref.startsWith('origin/')) git(dev, 'fetch', '-q', 'origin');
  const sha = git(dev, 'rev-parse', `${ref}^{commit}`);
  const short = sha.slice(0, 7);
  const tmp = mkdtempSync(join(tmpdir(), 'gamblium-publish-'));
  try {
    git(tmp, 'clone', '-q', '--depth=1', url, '.');
    // Bring the dev commit's objects into the throwaway clone (they stay there: only what the new
    // commit reaches is pushed, and the new commit's parent is the public history).
    git(dev, 'push', '-q', tmp, `${sha}:refs/heads/dev-snapshot`);
    git(tmp, 'read-tree', '--reset', '-u', sha);
    for (const p of PRIVATE) git(tmp, 'rm', '-r', '-q', '-f', '--ignore-unmatch', '--', p);
    const files = git(tmp, 'ls-files').split('\n').filter(Boolean);
    const bad = refusals(tmp, files);
    if (bad.length) throw new Error(`refused, nothing published:\n  ${bad.join('\n  ')}`);
    const changed = git(tmp, 'status', '--porcelain');
    if (!changed) return console.log(`Public repository already matches dev ${short}.`);
    console.log(`Dev ${short} -> public: ${files.length} files.\n${git(tmp, 'diff', '--cached', '--stat', 'HEAD').split('\n').slice(-12).join('\n')}`);
    if (!push) return console.log('Dry run: nothing pushed (add --push).');
    git(tmp, '-c', `user.name=${name}`, '-c', `user.email=${email}`, 'commit', '-q', '-m', `Sync with dev ${short}`);
    git(tmp, 'push', '-q', 'origin', 'HEAD:main');
    console.log(`Published: ${git(tmp, 'log', '--oneline', '-1')}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}

// Did every pref in the preset survive a launch?
//   node verify.mjs <preset.json> <outDir>/<label>     (reads <label>-prefs.json and <label>-local-state.json)
import fs from 'node:fs';
const [presetFile, label] = process.argv.slice(2);
const p = JSON.parse(fs.readFileSync(presetFile, 'utf8'));
const norm = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, norm(v[k])])) : v);
const same = (a, b) => JSON.stringify(norm(a)) === JSON.stringify(norm(b));
const get = (root, key) => key.split('.').reduce((n, part) => (n == null ? undefined : n[part]), root);
let ok = 0, miss = 0;
for (const [file, sect] of [[`${label}-prefs.json`, 'preferences'], [`${label}-local-state.json`, 'local_state']]) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const [k, v] of Object.entries(p[sect] ?? {})) {
    const n = get(j, k);
    if (n && same(n.value, v)) ok++;
    else { miss++; console.log('MISS', sect, k, '->', n ? JSON.stringify(n.value) + ' [' + n.metadata.filter((m) => !/modif/.test(m)) + ']' : 'not registered'); }
  }
}
console.log(`${ok} stuck, ${miss} did not`);

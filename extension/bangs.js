// !bangs (owner, Nov 14 2026): "!w moon" or "moon !w" typed in the address bar searches
// Wikipedia instead of the search engine. The address bar sends the text to the default search
// engine; background.js sees that search start and sends the tab on to the bang's site.
// No browser APIs here, so node --test can run it.

/** bang -> address, %s is the query. */
export const BANGS = {
  w: 'https://en.wikipedia.org/w/index.php?search=%s',
  wiki: 'https://en.wikipedia.org/w/index.php?search=%s',
  yt: 'https://www.youtube.com/results?search_query=%s',
  gh: 'https://github.com/search?q=%s&type=repositories',
  ghc: 'https://github.com/search?q=%s&type=code',
  g: 'https://www.google.com/search?q=%s',
  i: 'https://www.google.com/search?tbm=isch&q=%s',
  img: 'https://www.google.com/search?tbm=isch&q=%s',
  n: 'https://news.google.com/search?q=%s',
  news: 'https://news.google.com/search?q=%s',
  m: 'https://www.google.com/maps/search/%s',
  maps: 'https://www.google.com/maps/search/%s',
  t: 'https://translate.google.com/?sl=auto&tl=en&text=%s',
  tr: 'https://translate.google.com/?sl=auto&tl=en&text=%s',
  gs: 'https://scholar.google.com/scholar?q=%s',
  ddg: 'https://duckduckgo.com/?q=%s',
  b: 'https://www.bing.com/search?q=%s',
  brave: 'https://search.brave.com/search?q=%s',
  a: 'https://www.amazon.in/s?k=%s',
  amzn: 'https://www.amazon.com/s?k=%s',
  fk: 'https://www.flipkart.com/search?q=%s',
  r: 'https://www.reddit.com/search/?q=%s',
  so: 'https://stackoverflow.com/search?q=%s',
  mdn: 'https://developer.mozilla.org/en-US/search?q=%s',
  npm: 'https://www.npmjs.com/search?q=%s',
  crates: 'https://crates.io/search?q=%s',
  rs: 'https://docs.rs/releases/search?query=%s',
  pypi: 'https://pypi.org/search/?q=%s',
  hf: 'https://huggingface.co/search/full-text?q=%s',
  arxiv: 'https://arxiv.org/search/?searchtype=all&query=%s',
  hn: 'https://hn.algolia.com/?q=%s',
  imdb: 'https://www.imdb.com/find/?q=%s',
  x: 'https://x.com/search?q=%s',
  tw: 'https://x.com/search?q=%s',
  li: 'https://www.linkedin.com/search/results/all/?keywords=%s',
  wa: 'https://www.wolframalpha.com/input?i=%s',
  ud: 'https://www.urbandictionary.com/define.php?term=%s',
  d: 'https://www.merriam-webster.com/dictionary/%s',
  cl: 'https://claude.ai/new?q=%s',
  claude: 'https://claude.ai/new?q=%s',
  p: 'https://www.perplexity.ai/search?q=%s',
  ppl: 'https://www.perplexity.ai/search?q=%s',
  gpt: 'https://chatgpt.com/?q=%s',
  cve: 'https://www.cve.org/CVERecord/SearchResults?query=%s',
  shodan: 'https://www.shodan.io/search?query=%s',
};

/** Search engines whose result pages carry the typed text, and the parameter it is in. */
const ENGINES = [
  { host: /(^|\.)google\.[a-z.]+$/, path: /^\/search/, param: 'q' },
  { host: /(^|\.)bing\.com$/, path: /^\/search/, param: 'q' },
  { host: /(^|\.)duckduckgo\.com$/, path: /^\/$/, param: 'q' },
  { host: /^search\.brave\.com$/, path: /^\/search/, param: 'q' },
  { host: /(^|\.)search\.yahoo\.com$/, path: /^\/search/, param: 'p' },
  { host: /(^|\.)ecosia\.org$/, path: /^\/search/, param: 'q' },
  { host: /(^|\.)startpage\.com$/, path: /^\/(do\/)?search/, param: 'query' },
  { host: /(^|\.)perplexity\.ai$/, path: /^\/search/, param: 'q' },
];

/** The words and the bang in a typed text: "!w moon", "moon !w", or null without one. */
export function splitBang(text, bangs = BANGS) {
  const t = String(text ?? '').trim();
  const m = /^!(\S+)\s+([\s\S]+)$/.exec(t) || /^([\s\S]+?)\s+!(\S+)$/.exec(t);
  if (!m) {
    const only = /^!(\S+)$/.exec(t); // "!gh" alone opens the site's search page empty
    return only && bangs[only[1].toLowerCase()] ? { bang: only[1].toLowerCase(), query: '' } : null;
  }
  const [bang, query] = t.startsWith('!') ? [m[1], m[2]] : [m[2], m[1]];
  const key = bang.toLowerCase();
  return bangs[key] ? { bang: key, query: query.trim() } : null;
}

/** Where a search engine address should go instead, or null when it carries no known bang. */
export function bangTarget(url, own = {}) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const engine = ENGINES.find((e) => e.host.test(u.hostname) && e.path.test(u.pathname));
  if (!engine) return null;
  const bangs = { ...BANGS, ...own };
  const hit = splitBang(u.searchParams.get(engine.param), bangs);
  if (!hit) return null;
  const to = bangs[hit.bang].replace('%s', encodeURIComponent(hit.query));
  // Never back to the very same address (a bang for the engine it is already on, with nothing to change).
  return to === url ? null : to;
}

/** "jira https://x/?q=%s" per line -> { jira: 'https://x/?q=%s' }; lines without %s or not
 *  http(s) are left out. */
export function parseBangs(text) {
  const out = {};
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = /^\s*!?([^\s!]+)\s+(https?:\/\/\S*%s\S*)\s*$/i.exec(line);
    if (m) out[m[1].toLowerCase()] = m[2];
  }
  return out;
}

export function bangsText(own) {
  return Object.entries(own || {}).map(([k, v]) => `${k} ${v}`).join('\n');
}

// Redirect rules (declarativeNetRequest), so the search engine's page never loads: the request
// is rewritten before it leaves (owner, Nov 14 2026: the Google page flashed first). Engines whose
// text is in "q"; the others go through background.js's fallback.
// Kept lean: Chromium refuses a rule whose compiled pattern passes 2 KB (case-insensitive
// matching and long alternatives cost the most). The address bar writes a space as "+" and
// "!" as "%21"; other spellings ("!GH", "%20") are left to the fallback listener.
const RULE_ENGINES = String.raw`[^/]*(?:google\.[a-z.]+|bing\.com|duckduckgo\.com|brave\.com|ecosia\.org)/[a-z]*`;
const SPACE = String.raw`\+`;
const MARK = '%21';
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, (c) => '\\' + c);

/** The redirect rules for every bang (own ones win), ids from `firstId`. */
export function bangRules(own = {}, firstId = 9000) {
  const bangs = { ...BANGS, ...own };
  const rules = [];
  let id = firstId;
  for (const [bang, template] of Object.entries(bangs)) {
    // In a substitution a backslash is special: \1 is the words, \\ a backslash.
    const to = template.replace(/\\/g, '\\\\').replace('%s', '\\1');
    const head = String.raw`^https://${RULE_ENGINES}\?(?:.*&)?q=`;
    // Case-insensitive rules pass the 2 KB limit, so the usual spellings each get their own:
    // !gh, !GH, !Gh (owner, Nov 14 2026: capitals flashed the search page first).
    const spellings = [...new Set([bang, bang.toUpperCase(), bang[0].toUpperCase() + bang.slice(1)])];
    // The whole address must match: the match is what gets replaced.
    const forms = spellings.flatMap((b) => [
      `${head}${MARK}${esc(b)}${SPACE}([^&]*).*`, // "!w moon"
      `${head}([^&]*)${SPACE}${MARK}${esc(b)}(?:&.*)?$`, // "moon !w"
      `${head}${MARK}${esc(b)}()(?:&.*)?$`, // "!w" alone
    ]);
    for (const regexFilter of forms) {
      rules.push({ id: id++, priority: 2, action: { type: 'redirect', redirect: { regexSubstitution: to } }, condition: { regexFilter, isUrlFilterCaseSensitive: true, resourceTypes: ['main_frame'] } });
    }
  }
  return rules;
}

/** Whether one of `rules` (bangRules) already sends this address on; the fallback leaves it. */
export function coveredByRules(url, rules) {
  return rules.some((r) => new RegExp(r.condition.regexFilter).test(url));
}

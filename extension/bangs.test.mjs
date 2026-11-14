import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bangTarget, splitBang } from './bangs.js';

test('a bang before or after the words sends the search to that site', () => {
  assert.equal(bangTarget('https://www.google.com/search?q=!w+moon+landing'), 'https://en.wikipedia.org/w/index.php?search=moon%20landing');
  assert.equal(bangTarget('https://www.google.co.in/search?q=rust+tokio+!gh&oq=x'), 'https://github.com/search?q=rust%20tokio&type=repositories');
  assert.equal(bangTarget('https://www.bing.com/search?q=%21yt+lofi'), 'https://www.youtube.com/results?search_query=lofi');
  assert.equal(bangTarget('https://duckduckgo.com/?q=!a+usb+c+cable'), 'https://www.amazon.in/s?k=usb%20c%20cable');
  assert.equal(bangTarget('https://search.brave.com/search?q=!GH+gamblium'), 'https://github.com/search?q=gamblium&type=repositories');
  assert.equal(bangTarget('https://www.google.com/search?q=!gh'), 'https://github.com/search?q=&type=repositories');
});

test('no bang, an unknown one, or not a search: nothing happens', () => {
  assert.equal(bangTarget('https://www.google.com/search?q=moon'), null);
  assert.equal(bangTarget('https://www.google.com/search?q=!nosuchbang+moon'), null);
  assert.equal(bangTarget('https://www.google.com/search?q=hello!w'), null);
  assert.equal(bangTarget('https://github.com/search?q=!w+moon'), null);
  assert.equal(bangTarget('https://www.google.com/maps?q=!w+moon'), null);
  assert.equal(bangTarget('not a url'), null);
  assert.equal(splitBang('what is 5! factorial'), null);
});

test('own bangs, and they win over the built-in ones', () => {
  const own = { jira: 'https://acme.atlassian.net/issues/?jql=text~"%s"', w: 'https://de.wikipedia.org/w/index.php?search=%s' };
  assert.equal(bangTarget('https://www.google.com/search?q=!jira+login+bug', own), 'https://acme.atlassian.net/issues/?jql=text~"login%20bug"');
  assert.equal(bangTarget('https://www.google.com/search?q=!w+Mond', own), 'https://de.wikipedia.org/w/index.php?search=Mond');
});

test('own bangs are written one per line', async () => {
  const { parseBangs, bangsText } = await import('./bangs.js');
  const own = parseBangs('jira https://acme.atlassian.net/?q=%s\n!Docs https://docs.x.org/s?q=%s\nbroken https://x.org/\nfile file:///%s\n');
  assert.deepEqual(own, { jira: 'https://acme.atlassian.net/?q=%s', docs: 'https://docs.x.org/s?q=%s' });
  assert.deepEqual(parseBangs(bangsText(own)), own);
});

test('the redirect rules send the request straight to the bang site', async () => {
  const { bangRules } = await import('./bangs.js');
  const rules = bangRules({ jira: 'https://acme.atlassian.net/?q=%s' });
  // What the browser does with a rule: the first match, \1 replaced (RE2 and JS agree on these).
  const apply = (url) => {
    for (const r of rules) {
      const m = new RegExp(r.condition.regexFilter).exec(url);
      if (m) return r.action.redirect.regexSubstitution.replace(/\\1/g, () => m[1] ?? '').replace(/\\\\/g, '\\');
    }
    return null;
  };
  assert.equal(apply('https://www.google.com/search?q=%21w+moon+landing&sourceid=chrome&ie=UTF-8'), 'https://en.wikipedia.org/w/index.php?search=moon+landing');
  assert.equal(apply('https://www.google.co.in/search?q=rust+tokio+%21gh&oq=x'), 'https://github.com/search?q=rust+tokio&type=repositories');
  assert.equal(apply('https://www.bing.com/search?form=X&q=%21yt+lofi'), 'https://www.youtube.com/results?search_query=lofi');
  assert.equal(apply('https://www.bing.com/search?q=%21YT+lofi'), 'https://www.youtube.com/results?search_query=lofi');
  assert.equal(apply('https://www.google.com/search?q=rust+%21Gh'), 'https://github.com/search?q=rust&type=repositories');
  assert.equal(apply('https://www.google.com/search?q=%21gH+x'), null); // odd mixes: the fallback
  assert.ok(rules.length < 1000, String(rules.length));
  assert.equal(apply('https://search.brave.com/search?q=%21jira+login'), 'https://acme.atlassian.net/?q=login');
  assert.equal(apply('https://www.google.com/search?q=%21gh'), 'https://github.com/search?q=&type=repositories');
  assert.equal(apply('https://www.google.com/search?q=moon'), null);
  assert.equal(apply('https://www.google.com/search?q=what+is+5%21+x'), null);
  assert.equal(apply('https://www.google.com/search?q=%21wiki+x'), 'https://en.wikipedia.org/w/index.php?search=x'); // !wiki is not "!w" + "iki"
  assert.ok(rules.every((r) => r.condition.regexFilter.length < 400));
  assert.equal(new Set(rules.map((r) => r.id)).size, rules.length);
});

// Gamblium's own right-click menu for web pages. Put into pages by the background
// (chrome.scripting.registerContentScripts) while "ownRightClick" is on.
//
// - The everyday entries are at the top (open the link, copy, paste, ...); everything
//   else is one step down in a sub-menu, so the first look stays short.
// - Shift + right-click gives the browser's own menu (spell check, Inspect).
// - A page that shows a menu of its own (it cancels the event) is left alone.
// - Nothing runs until a right-click: one listener, no timers, the menu is built when asked for.
//
// A classic script (content scripts cannot be modules). The part that decides what the
// menu holds, menuFor(), touches no page and is tested from menu.test.mjs.
(() => {
  const short = (s, n = 28) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
  const isTorrentLink = (u) => /^magnet:/i.test(u) || /^https?:\/\/[^?#]+\.torrent([?#]|$)/i.test(u);
  const isWeb = (u) => /^https?:/i.test(u || '');
  const FILE = /\.(zip|7z|rar|gz|tgz|bz2|xz|tar|iso|img|exe|msi|dmg|pkg|deb|rpm|apk|pdf|epub|docx?|xlsx?|pptx?|csv|mp4|mkv|webm|mov|avi|mp3|flac|wav|ogg|m4a)$/i;
  const TRACKERS = /^(utm_\w+|fbclid|gclid|gclsrc|dclid|gbraid|wbraid|msclkid|mc_cid|mc_eid|igshid|igsh|yclid|twclid|ttclid|li_fat_id|_ga|_gl|_hsenc|_hsmi|mkt_tok|vero_id|oly_anon_id|oly_enc_id|s_cid|ref_src|ref_url|spm|si)$/i;

  /** A link without the parts that only follow people around (utm_..., fbclid, ...). Anything else is kept. */
  function cleanLink(url) {
    try {
      const u = new URL(url);
      if (!/^https?:$/.test(u.protocol)) return url;
      for (const k of [...u.searchParams.keys()]) if (TRACKERS.test(k)) u.searchParams.delete(k);
      return u.toString().replace(/\?$/, '');
    } catch {
      return url;
    }
  }
  /** Where a link really goes, short enough for one line: "site.example/path/to/page". */
  function destination(url, n = 44) {
    try {
      const u = new URL(cleanLink(url));
      if (!/^https?:$/.test(u.protocol)) return short(url, n);
      return short(u.hostname.replace(/^www\./, '') + (u.pathname === '/' ? '' : u.pathname) + u.search, n);
    } catch {
      return short(String(url), n);
    }
  }
  /** The page's address pointing at some of its text (the browser scrolls to it and marks it). */
  function highlightLink(page, text) {
    const words = text.trim().replace(/\s+/g, ' ').slice(0, 200);
    return page.replace(/#.*$/, '') + '#:~:text=' + encodeURIComponent(words).replace(/-/g, '%2D');
  }

  /**
   * What the menu holds for a right-click.
   * ctx: { link, image, imageSize, video, text (the selection), editable, page (address),
   *        state: { focused, pinned, muted, awakeTab, awakeSite, host, bookmarked, tools: [{ id, title }], sessions: [{ name, state }] } }
   * -> [{ strip: [{ id, label, icon, on }] } | { head, detail } | { sep: true } | { id, label, icon, keys, check } | { label, icon, sub: [...] }]
   * The first level holds the everyday things for what was clicked; the rest is one step down.
   */
  function menuFor(ctx) {
    if (ctx.ours) return ourPageMenu(ctx);
    const st = ctx.state || {};
    const out = [{ strip: [
      { id: 'back', label: 'Back', icon: 'back', disabled: ctx.canBack === false }, { id: 'forward', label: 'Forward', icon: 'forward', disabled: ctx.canForward === false }, { id: 'reload', label: 'Reload', icon: 'reload' },
      { id: 'bookmark', label: st.bookmarked ? 'Remove the bookmark' : 'Bookmark this page', icon: 'bookmark', on: !!st.bookmarked },
    ] }];
    const group = (head, detail, items) => { if (items.length) out.push({ sep: true }, { head, detail }, ...items); };
    const more = [];
    // An extension cannot open the developer tools on an element; the entry says how, in one line.
    const inspect = { id: 'inspect', label: 'Inspect', icon: 'inspect', keys: 'Ctrl+Shift+C' };

    if (ctx.link) {
      const items = [];
      const clean = cleanLink(ctx.link);
      if (isWeb(ctx.link)) items.push({ id: 'link-tab', label: 'Open in new tab', icon: 'tab' }, { id: 'link-window', label: 'Open in new window', icon: 'window' }, { id: 'link-private', label: 'Open in private window', icon: 'private' }, { id: 'link-tor', label: 'Open in a Tor window', icon: 'private' });
      // Named sessions (each a browser of its own): only when there are some, and one step down.
      if (isWeb(ctx.link) && st.sessions?.length) items.push({ label: 'Open in a session', icon: 'layers', sub: st.sessions.slice(0, 12).map((s) => ({ id: 'session:' + s.name, label: s.name, icon: 'layers', keys: s.state === 'stopped' ? 'stopped' : s.state === 'hidden' ? 'no window' : '' })) });
      if (isTorrentLink(ctx.link)) items.push({ id: 'link-torrent', label: 'Download this torrent', icon: 'download' });
      else if (isWeb(ctx.link) && FILE.test(new URL(ctx.link).pathname)) items.push({ id: 'link-download', label: 'Download link', icon: 'download' });
      if (clean !== ctx.link) {
        items.push({ id: 'link-copy-clean', label: 'Copy clean link', icon: 'copy' });
        more.push({ id: 'link-copy', label: 'Copy link with its tracking', icon: 'link' });
      } else items.push({ id: 'link-copy', label: 'Copy link', icon: 'copy' });
      if (ctx.linkText) more.push({ id: 'link-text', label: 'Copy link text', icon: 'copy' });
      if (isWeb(ctx.link)) more.push({ id: 'link-save', label: 'Save link as…', icon: 'download' });
      group('Link', destination(ctx.link), items);
    }
    if (ctx.image) {
      group('Picture', ctx.imageSize || '', [{ id: 'image-tab', label: 'Open in new tab', icon: 'tab' }, { id: 'image-save', label: 'Save picture', icon: 'download' }, { id: 'image-copy', label: 'Copy picture', icon: 'copy' }, { id: 'image-address', label: 'Copy picture address', icon: 'link' }]);
    }
    if (ctx.video) group('Video', '', [{ id: 'video-tab', label: 'Open in new tab', icon: 'tab' }, { id: 'video-copy', label: 'Copy video address', icon: 'link' }]);
    if (ctx.editable) {
      // The usual edit commands in their usual places; Cut and Copy stay, greyed, when nothing is selected.
      // A password field first offers a strong password (owner, Nov 15 2026: the browser's own
      // offer is missing).
      group(ctx.password ? 'Password field' : 'Text field', '', [
        ...(ctx.password ? [{ id: 'pw-suggest', label: 'Suggest a strong password', icon: 'key' }] : []),
        { id: 'undo', label: 'Undo', icon: 'undo', keys: 'Ctrl+Z' },
        { id: 'cut', label: 'Cut', icon: 'cut', keys: 'Ctrl+X', disabled: !ctx.text }, { id: 'copy', label: 'Copy', icon: 'copy', keys: 'Ctrl+C', disabled: !ctx.text },
        { id: 'paste', label: 'Paste', icon: 'paste', keys: 'Ctrl+V' }, { id: 'select-all', label: 'Select all', icon: 'select', keys: 'Ctrl+A' },
      ]);
    } else if (ctx.text) {
      group('Selection', `"${short(ctx.text.trim().replace(/\s+/g, ' '), 36)}"`, [
        { id: 'copy', label: 'Copy', icon: 'copy', keys: 'Ctrl+C' }, { id: 'search', label: 'Search the web for it', icon: 'search' },
        { id: 'translate', label: 'Translate with Google', icon: 'translate' },
        { id: 'highlight', label: 'Copy link to this text', icon: 'link' },
      ]);
    }

    out.push({ sep: true });
    // Keeping a tab running in the background is the everyday one (owner, Nov 13 2026): one click, at the
    // top. Focus is rarer, so it moves one step down into This tab. Nothing on this level is repeated below.
    out.push({ id: 'awake-tab', label: 'Keep this tab awake', check: !!st.awakeTab });
    // Screenshot: one entry; the overlay it opens picks Area, Visible or Whole page.
    out.push({ id: 'shot', label: 'Screenshot', icon: 'camera' });
    out.push({ label: 'This tab', icon: 'tab', sub: [
      // Focus: the tab alone in a bare window, nothing around it; the same entry brings it back.
      { id: 'focus', label: st.focused ? 'Leave focus' : 'Focus on this tab', icon: 'focus' },
      { sep: true },
      { id: 'tab-duplicate', label: 'Duplicate', icon: 'duplicate' },
      { id: 'tab-pin', label: st.pinned ? 'Unpin' : 'Pin', icon: 'pin' },
      { id: 'tab-mute', label: st.muted ? 'Unmute' : 'Mute', icon: 'mute' },
      { sep: true },
      // Sleep and waking, together: the whole site awake, the rest asleep.
      ...(st.host ? [{ id: 'awake-site', label: `Always keep ${short(st.host, 24)} awake`, check: !!st.awakeSite }] : []),
      { id: 'sleep-others', label: 'Put the other tabs to sleep', icon: 'moon' },
      // A tab in a group (a space): the whole group at once (owner's tab-group list, Nov 14 2026).
      ...(st.inSpace ? [{ id: 'group-sleep', label: 'Put this group to sleep', icon: 'moon' }, { id: 'group-awake', label: 'Keep this group awake', check: !!st.groupAwake }] : []),
      // Starting a space is rare: one line here, not an entry of its own in every menu.
      ...(st.spaces && !st.spaces.length ? [{ sep: true }, { id: 'space-new', label: 'Start a space with this tab', icon: 'layers' }] : []),
    ] });
    // Spaces: only once the window has one. The tab moves and you go with it.
    if (st.spaces?.length) out.push({ label: 'Move to space', icon: 'layers', sub: [
      ...st.spaces.filter((s) => !s.here).slice(0, 12).map((s) => ({ id: 'space:' + s.id, label: short(s.title, 28), icon: 'layers' })),
      ...(st.spaces.some((s) => !s.here) ? [{ sep: true }] : []),
      { id: 'space-new', label: 'New space', icon: 'tab' },
      ...(st.inSpace ? [{ id: 'space-leave', label: 'Take out of this space', icon: 'window' }] : []),
    ] });
    out.push({ label: 'Tools', icon: 'tools', sub: [
      ...(st.tools || []).map((x) => ({ id: 'tool:' + x.id, label: x.title, icon: 'shield' })),
      { sep: true },
      { id: 'open-dashboard', label: 'Tabs and memory', icon: 'grid' },
    ] });
    out.push({ label: 'More', icon: 'more', sub: [
      { id: 'page-copy', label: 'Copy page address', icon: 'copy' }, { id: 'page-markdown', label: 'Copy as Markdown link', icon: 'link' }, ...more,
      { sep: true },
      { id: 'page-print', label: 'Print', icon: 'print', keys: 'Ctrl+P' }, { id: 'page-save', label: 'Save page as', icon: 'download', keys: 'Ctrl+S' }, { id: 'page-source', label: 'View page source', icon: 'code', keys: 'Ctrl+U' },
      { sep: true },
      { id: 'open-settings', label: 'Gamblium settings', icon: 'ours' },
    ] });
    // Inspect on the first level, below everything (owner, Nov 13 2026), in every profile.
    out.push({ sep: true }, inspect);
    // No line of explanation at the foot (owner, Nov 12 2026: keep the text minimal). That Shift +
    // right-click gives the browser's own menu is said once, beside the switch in Settings.
    return out;
  }

  /**
   * The menu on Gamblium's own pages (New Tab, Settings, Downloads, ...): the same look, entries that
   * make sense there. ctx.ours is the page ('newtab', 'settings', ...); the page may add entries of its
   * own for what was clicked (ctx.extra: { head, detail, items }) and for the whole page (ctx.pageItems).
   * No bookmark, print, page source, focus or security tools: none of them means anything on these pages.
   */
  function ourPageMenu(ctx) {
    const st = ctx.state || {};
    const out = [{ strip: [{ id: 'back', label: 'Back', icon: 'back' }, { id: 'forward', label: 'Forward', icon: 'forward' }, { id: 'reload', label: 'Reload', icon: 'reload' }] }];
    const group = (head, detail, items) => { if (items.length) out.push({ sep: true }, ...(head ? [{ head, detail }] : []), ...items); };
    const extra = ctx.extra?.items?.length ? ctx.extra : null;
    if (ctx.link && (isWeb(ctx.link) || ctx.ownLink)) {
      const items = [{ id: 'link-tab', label: 'Open in new tab', icon: 'tab' }];
      if (isWeb(ctx.link)) {
        items.push({ id: 'link-window', label: 'Open in new window', icon: 'window' }, { id: 'link-private', label: 'Open in private window', icon: 'private' }, { id: 'link-tor', label: 'Open in a Tor window', icon: 'private' });
        if (st.sessions?.length) items.push({ label: 'Open in a session', icon: 'layers', sub: st.sessions.slice(0, 12).map((s) => ({ id: 'session:' + s.name, label: s.name, icon: 'layers', keys: s.state === 'stopped' ? 'stopped' : s.state === 'hidden' ? 'no window' : '' })) });
        items.push({ id: 'link-copy', label: 'Copy link', icon: 'copy' });
      }
      // What the page adds for this link (a tile: edit it, take it off) sits in the same group.
      if (extra && !extra.head) items.push(...extra.items);
      group('Link', isWeb(ctx.link) ? destination(ctx.link) : ctx.linkText || '', items);
    }
    if (extra && (extra.head || !ctx.link)) group(extra.head || '', extra.detail || '', extra.items);
    if (ctx.image && isWeb(ctx.image)) group('Picture', ctx.imageSize || '', [{ id: 'image-tab', label: 'Open in new tab', icon: 'tab' }, { id: 'image-copy', label: 'Copy picture', icon: 'copy' }]);
    if (ctx.editable) {
      // The usual edit commands in their usual places; Cut and Copy stay, greyed, when nothing is selected.
      group('Text field', '', [
        { id: 'undo', label: 'Undo', icon: 'undo', keys: 'Ctrl+Z' },
        { id: 'cut', label: 'Cut', icon: 'cut', keys: 'Ctrl+X', disabled: !ctx.text }, { id: 'copy', label: 'Copy', icon: 'copy', keys: 'Ctrl+C', disabled: !ctx.text },
        { id: 'paste', label: 'Paste', icon: 'paste', keys: 'Ctrl+V' }, { id: 'select-all', label: 'Select all', icon: 'select', keys: 'Ctrl+A' },
      ]);
    } else if (ctx.text) {
      group('Selection', `"${short(ctx.text.trim().replace(/\s+/g, ' '), 36)}"`, [{ id: 'copy', label: 'Copy', icon: 'copy', keys: 'Ctrl+C' }, { id: 'search', label: 'Search the web for it', icon: 'search' }]);
    }
    out.push({ sep: true }, ...(ctx.pageItems || []));
    // On our pages the entry answers in words (the browser refuses pictures of them); the page loads that card itself.
    out.push({ id: 'shot', label: 'Screenshot', icon: 'camera' });
    out.push({ label: 'This tab', icon: 'tab', sub: [
      { id: 'tab-duplicate', label: 'Duplicate', icon: 'duplicate' },
      { id: 'tab-pin', label: st.pinned ? 'Unpin' : 'Pin', icon: 'pin' },
      { id: 'tab-mute', label: st.muted ? 'Unmute' : 'Mute', icon: 'mute' },
    ] });
    if (ctx.ours !== 'settings') out.push({ id: 'open-settings', label: 'Gamblium settings', icon: 'gear' });
    return out;
  }

  // For the test: hand the pure part over and stop (there is no page there).
  if (typeof globalThis.__gambliumMenuTest === 'object') return void Object.assign(globalThis.__gambliumMenuTest, { menuFor, short, isTorrentLink, cleanLink, destination, highlightLink });
  if (typeof document === 'undefined' || globalThis.__gambliumMenu) return;
  globalThis.__gambliumMenu = true;
  // On our own pages the script is part of the page (extension pages take no content scripts):
  // which page it is, and whether the switch in Settings is on, are read here.
  const OURS = location.protocol === 'chrome-extension:' ? (location.pathname.match(/\/(?:ui|newtab)\/(\w+)\.html$/)?.[1] || 'page').replace(/^index$/, 'newtab') : '';
  // Screenshot on our own pages: the overlay comes in as a script of the page, on demand. A page that
  // holds another of our pages in its frame (the New Tab shell) leaves it to that page.
  function loadShot() {
    const s = Object.assign(document.createElement('script'), { src: chrome.runtime.getURL('content/shot.js') });
    s.onload = s.onerror = () => s.remove();
    document.head.append(s);
  }
  if (OURS) {
    chrome.runtime.onMessage.addListener((m) => {
      if (m?.type === 'gamblium-shot-start' && !document.getElementById('shell')) loadShot();
    });
  }
  let enabled = true;
  if (OURS) {
    chrome.storage.local.get({ ownRightClick: true }).then((v) => { enabled = v.ownRightClick !== false; }).catch(() => {});
    chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.ownRightClick) enabled = ch.ownRightClick.newValue !== false; });
  }

  const ICONS = {
    back: 'M9.500 3.500 5 8l4.500 4.500M5 8h7',
    forward: 'M6.500 3.500 11 8l-4.500 4.500M11 8H4',
    reload: 'M12.500 8a4.500 4.500 0 1 1-1.400-3.300M12.500 3v2.500H10',
    bookmark: 'M4.500 2.500h7a.500.500 0 0 1 .500.500v10.500L8 11l-4 2.500V3a.500.500 0 0 1 .500-.500z',
    chevron: 'M6 3.500 10.500 8 6 12.500',
    check: 'M3.500 8.500 6.500 11.500 12.500 4.500',
    tab: 'M2.500 5A1.500 1.500 0 0 1 4 3.500h8A1.500 1.500 0 0 1 13.500 5v6a1.500 1.500 0 0 1-1.500 1.500H4A1.500 1.500 0 0 1 2.500 11zM8 6v4M6 8h4',
    window: 'M2.500 5A1.500 1.500 0 0 1 4 3.500h8A1.500 1.500 0 0 1 13.500 5v6a1.500 1.500 0 0 1-1.500 1.500H4A1.500 1.500 0 0 1 2.500 11zM2.500 6.500h11',
    private: 'M2.500 7.500c1.600-1 3.200-1 4.400 0h2.200c1.200-1 2.800-1 4.400 0M4 5.500l.800-2.500h6.400l.800 2.500M7 10h2M5.200 12a1.800 1.800 0 1 0 0-3.600 1.800 1.800 0 0 0 0 3.600zM10.800 12a1.800 1.800 0 1 0 0-3.600 1.800 1.800 0 0 0 0 3.600z',
    copy: 'M6 5.500h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1zM3 10.500V4a1 1 0 0 1 1-1h6.500',
    link: 'M6.800 9.200a2.400 2.400 0 0 0 3.400 0l2.200-2.200a2.400 2.400 0 0 0-3.400-3.400l-.700.700M9.200 6.800a2.400 2.400 0 0 0-3.400 0L3.600 9a2.400 2.400 0 0 0 3.400 3.400l.700-.700',
    download: 'M8 2.500v7.500M5 7.200 8 10.200l3-3M3 13.500h10',
    search: 'M7 11.500a4.500 4.500 0 1 0 0-9 4.500 4.500 0 0 0 0 9zM10.300 10.300 13.500 13.500',
    cut: 'M5 12.500a1.500 1.500 0 1 0 0-3 1.500 1.500 0 0 0 0 3zM11 12.500a1.500 1.500 0 1 0 0-3 1.500 1.500 0 0 0 0 3zM6 9.800 11.500 2.500M10 9.800 4.500 2.500',
    paste: 'M5.500 3.500H4a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1.500M6 2.500h4v2H6zM5.500 8h5M5.500 10.500h3',
    select: 'M3 3h2M7 3h2M11 3h2M3 13h2M7 13h2M11 13h2M3 7v2M13 7v2M6 8h4',
    duplicate: 'M5.500 5.500h7v7h-7zM3.500 10.500v-7h7',
    pin: 'M9.500 2.500 13.500 6.500 11 7.500 8.500 10 9 12.500 3.500 7 6 7.500 8.500 5zM6 10 3 13',
    mute: 'M3 6.500h2L8 4v8L5 9.500H3zM10.500 6.500l3 3M13.500 6.500l-3 3',
    moon: 'M12.500 9.500A5 5 0 0 1 6.500 3.500a5 5 0 1 0 6 6z',
    layers: 'M2.500 5.500 8 2.500l5.500 3L8 8.500zM2.500 8.500 8 11.500l5.500-3M2.500 11 8 14l5.500-3',
    focus: 'M2.500 5.500v-3h3M10.500 2.500h3v3M13.500 10.500v3h-3M5.500 13.500h-3v-3M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
    tools: 'M9.500 3a3 3 0 0 0-2.700 4.300L3 11.100V13h1.900l3.800-3.800A3 3 0 0 0 13 6.500l-2 2-1.500-.500L9 6.500l2-2A3 3 0 0 0 9.500 3z',
    shield: 'M8 2.500 12.500 4v4c0 2.600-1.900 4.600-4.500 5.500C5.400 12.600 3.500 10.600 3.500 8V4z',
    key: 'M10.500 3.500a2.500 2.500 0 1 1-1.900 4.100L4 12.200V13.500h1.500v-1h1v-1h1l1.100-1.100A2.500 2.500 0 0 1 10.500 3.500zM11 5.500h.010',
    grid: 'M3 3h4v5H3zM9 3h4v3H9zM9 8h4v5H9zM3 10h4v3H3z',
    more: 'M4 8h.010M8 8h.010M12 8h.010',
    camera: 'M2.500 5.500A1 1 0 0 1 3.500 4.500h1.700l1-1.500h3.600l1 1.500h1.700a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1zM8 11a2.200 2.200 0 1 0 0-4.400A2.200 2.200 0 0 0 8 11z',
    print: 'M5 6V3h6v3M5 11H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1M5 9.500h6v3.500H5z',
    code: 'M6 5 3 8l3 3M10 5l3 3-3 3',
    edit: 'M10.500 3 13 5.500 6 12.500H3.500V10zM9 4.500l2.500 2.500',
    remove: 'M4.500 4.500l7 7M11.500 4.500l-7 7',
    hide: 'M2.500 8s2-3.500 5.500-3.500S13.500 8 13.500 8 11.500 11.500 8 11.500 2.500 8 2.500 8zM3.500 3.500l9 9',
    ours: 'M8 2 12.500 6.500 8 14 3.500 6.500zM3.500 6.500h9',
    inspect: 'M7 12.500H4a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h7.500a1 1 0 0 1 1 1V7M8.500 8.500l1.800 5 .900-2.100 2.100-.900z',
    undo: 'M5.500 4 3 6.500 5.500 9M3 6.500h6.500a3.500 3.500 0 0 1 0 7H7',
    translate: 'M2.500 4h6M5.500 2.500V4M4 4c.300 2.300 1.900 4.200 4 5M7.500 4c-.400 2.500-2.200 4.600-5 5.500M8.500 13.500l2.500-6 2.500 6M9.300 11.500h3.400',
    box: 'M4 3.500h8a.500.500 0 0 1 .500.500v8a.500.500 0 0 1-.500.500H4a.500.500 0 0 1-.500-.500V4a.500.500 0 0 1 .500-.500z',
    boxcheck: 'M4 3.500h8a.500.500 0 0 1 .500.500v8a.500.500 0 0 1-.500.500H4a.500.500 0 0 1-.500-.500V4a.500.500 0 0 1 .500-.500zM5.500 8.200 7.300 10l3.200-3.800',
    gear: 'M6.86 3.24L7.02 1.47L8.98 1.47L9.14 3.24A4.9 4.9 0 0 1 10.56 3.82L11.93 2.69L13.31 4.07L12.18 5.44A4.9 4.9 0 0 1 12.76 6.86L14.53 7.02L14.53 8.98L12.76 9.14A4.9 4.9 0 0 1 12.18 10.56L13.31 11.93L11.93 13.31L10.56 12.18A4.9 4.9 0 0 1 9.14 12.76L8.98 14.53L7.02 14.53L6.86 12.76A4.9 4.9 0 0 1 5.44 12.18L4.07 13.31L2.69 11.93L3.82 10.56A4.9 4.9 0 0 1 3.24 9.14L1.47 8.98L1.47 7.02L3.24 6.86A4.9 4.9 0 0 1 3.82 5.44L2.69 4.07L4.07 2.69L5.44 3.82A4.9 4.9 0 0 1 6.86 3.24ZM10.10 8.00A2.1 2.1 0 1 1 5.90 8.00A2.1 2.1 0 1 1 10.10 8.00Z',
  };
  const CSS = `
    :host { all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; }
    .m { --bg: rgba(20,21,26,.86); --text: #E9EBF0; --muted: #9DA1AA; --faint: #6F7480; --rim: rgba(255,255,255,.11); --hi: rgba(233,235,240,.14); --shade: 0 22px 60px rgba(0,0,0,.6), 0 3px 10px rgba(0,0,0,.45);
      position: fixed; min-width: 252px; max-width: 320px; padding: 6px; border-radius: 16px; background: var(--bg); color: var(--text);
      -webkit-backdrop-filter: blur(26px) saturate(1.4); backdrop-filter: blur(26px) saturate(1.4);
      box-shadow: var(--shade), inset 0 0 0 1px var(--rim), inset 0 1px 0 rgba(255,255,255,.06); font: 400 13px/1 'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif; pointer-events: auto; user-select: none; -webkit-user-select: none; }
    @media (prefers-color-scheme: light) { .m { --bg: rgba(250,250,252,.9); --text: #121316; --muted: #555B66; --faint: #8A909C; --rim: rgba(0,0,0,.10); --hi: rgba(18,19,22,.08); --shade: 0 22px 60px rgba(0,0,0,.2), 0 3px 10px rgba(0,0,0,.12); } }
    .strip { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; padding: 0 0 2px; }
    button { all: unset; box-sizing: border-box; display: grid; grid-template-columns: 16px minmax(0, 1fr) auto; align-items: center; gap: 11px; width: 100%; height: 32px; padding: 0 10px; border-radius: 10px; color: var(--text); font: inherit; cursor: default; white-space: nowrap; }
    .strip button { grid-template-columns: 1fr; justify-items: center; height: 34px; padding: 0; color: var(--muted); background: rgba(127,127,127,.09); }
    .strip button.on svg { fill: currentColor; }
    button .l { overflow: hidden; text-overflow: ellipsis; line-height: 1.5; }
    button .k { color: var(--faint); font-size: 11px; }
    button svg { color: var(--muted); }
    button.at, button.open { background: var(--hi); }
    button.at svg, button.open svg, .strip button.at { color: var(--text); }
    hr { height: 1px; margin: 6px 8px; border: 0; background: var(--rim); }
    .head { display: flex; align-items: baseline; gap: 8px; margin: 2px 10px 4px; font-size: 12px; line-height: 1.5; }
    .head b { flex: none; font-weight: 600; color: var(--muted); }
    button[aria-disabled="true"] { color: var(--faint); }
    button[aria-disabled="true"] svg { color: var(--faint); opacity: .55; }
    .strip button[aria-disabled="true"] { background: rgba(127,127,127,.04); }
    button[aria-disabled="true"].at { background: transparent; }
    .tip { position: fixed; max-width: 300px; padding: 9px 12px; border-radius: 12px; background: var(--bg); color: var(--text); box-shadow: var(--shade), inset 0 0 0 1px var(--rim); font: 400 13px/1.45 'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif; pointer-events: none; }
    .head span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); }
    @media (prefers-reduced-motion: no-preference) { .m { animation: in .1s ease-out; transform-origin: top left; } .m.settled { animation: none; } @keyframes in { from { opacity: 0; transform: scale(.97); } } }
  `;

  let host = null; // the element that holds the menu, while it is open
  let root = null;
  let ctx = null;
  let panels = []; // [the main menu, the open sub-menu]
  let at = null; // the entry the pointer or the arrow keys are on

  const NS = 'http://www.w3.org/2000/svg';
  function svg(name) {
    const s = document.createElementNS(NS, 'svg');
    for (const [k, v] of Object.entries({ width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.4, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) s.setAttribute(k, v);
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', ICONS[name]);
    s.append(p);
    return s;
  }
  const send = (what, more = {}) => chrome.runtime.sendMessage({ type: 'menu-do', what, ...more }).catch(() => ({ ok: false }));

  function close() {
    if (!host) return;
    host.remove();
    host = root = ctx = at = null;
    panels = [];
    removeEventListener('keydown', onKey, true);
    removeEventListener('pointerdown', onOutside, true);
    removeEventListener('scroll', close, true);
    removeEventListener('resize', close);
    removeEventListener('blur', close);
  }
  function onOutside(e) {
    if (!e.isTrusted || e.composedPath().includes(host)) return;
    close();
  }

  function place(panel, x, y, beside) {
    const r = { width: panel.offsetWidth, height: panel.offsetHeight }; // the laid-out size: the opening animation scales the box for a moment
    const W = innerWidth;
    const H = innerHeight;
    let left = x;
    let top = y;
    if (beside) {
      // A sub-menu sits to the right of its entry, or to the left when there is no room.
      left = beside.right + 4 + r.width <= W ? beside.right + 2 : Math.max(4, beside.left - r.width - 2);
      top = beside.top - 6;
    } else if (left + r.width > W - 4) left = Math.max(4, x - r.width);
    if (top + r.height > H - 4) top = Math.max(4, H - r.height - 4);
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
  }

  function setAt(b) {
    if (at === b) return;
    at?.classList.remove('at');
    at = b;
    b?.classList.add('at');
  }
  function closeSub() {
    if (panels.length < 2) return;
    panels.pop().remove();
    root.querySelector('button.open')?.classList.remove('open');
  }
  function openSub(b, items, viaKeys) {
    if (b.classList.contains('open')) return;
    closeSub();
    b.classList.add('open');
    const p = build(items);
    root.append(p);
    panels.push(p);
    place(p, 0, 0, b.getBoundingClientRect());
    if (viaKeys) setAt(p.querySelector('button'));
  }

  function build(items) {
    const m = document.createElement('div');
    m.className = 'm';
    m.setAttribute('role', 'menu');
    for (const it of items) {
      if (it.sep) {
        if (m.lastElementChild && m.lastElementChild.tagName !== 'HR') m.append(document.createElement('hr'));
        continue;
      }
      if (it.head) {
        const p = document.createElement('p');
        p.className = 'head';
        const b = document.createElement('b');
        b.textContent = it.head;
        const d = document.createElement('span');
        d.textContent = it.detail || '';
        p.append(b, d);
        m.append(p);
        continue;
      }
      if (it.strip) {
        const row = document.createElement('div');
        row.className = 'strip';
        row.style.gridTemplateColumns = `repeat(${it.strip.length}, 1fr)`;
        for (const s of it.strip) {
          const b = document.createElement('button');
          b.title = s.label;
          b.setAttribute('aria-label', s.label);
          b.setAttribute('role', 'menuitem');
          if (s.on) b.classList.add('on');
          if (s.disabled) b.setAttribute('aria-disabled', 'true');
          b.append(svg(s.icon));
          b.addEventListener('pointerenter', () => { setAt(b); closeSub(); });
          b._go = () => (s.disabled ? null : act(s.id));
          b.addEventListener('click', (e) => { if (e.isTrusted) b._go(); });
          row.append(b);
        }
        m.append(row);
        continue;
      }
      const b = document.createElement('button');
      b.setAttribute('role', it.check === undefined ? 'menuitem' : 'menuitemcheckbox');
      if (it.check !== undefined) b.setAttribute('aria-checked', String(it.check));
      if (it.disabled) b.setAttribute('aria-disabled', 'true');
      if (it.title) b.title = it.title;
      // A checkable entry always shows its box, ticked or empty, so "off" is visible too.
      const lead = it.check !== undefined ? svg(it.check ? 'boxcheck' : 'box') : it.icon ? svg(it.icon) : document.createElement('span');
      const l = document.createElement('span');
      l.className = 'l';
      l.textContent = it.label;
      const tail = it.sub ? svg('chevron') : document.createElement('span');
      if (!it.sub) { tail.className = 'k'; tail.textContent = it.keys || ''; }
      b.append(lead, l, tail);
      if (it.sub) {
        b.setAttribute('aria-haspopup', 'menu');
        b.addEventListener('pointerenter', () => { setAt(b); openSub(b, it.sub); });
        b.addEventListener('click', (e) => { if (e.isTrusted) openSub(b, it.sub); });
        b._sub = it.sub;
      } else {
        b.addEventListener('pointerenter', () => { setAt(b); if (m === panels[0]) closeSub(); });
        b._go = () => (it.disabled ? null : act(it.id, it));
        b.addEventListener('click', (e) => { if (e.isTrusted) b._go(); });
      }
      m.append(b);
    }
    // No stray rule at the start or the end.
    while (m.firstElementChild?.tagName === 'HR') m.firstElementChild.remove();
    while (m.lastElementChild?.tagName === 'HR') m.lastElementChild.remove();
    // Keep the page's focus and selection: the menu never takes them.
    m.addEventListener('mousedown', (e) => e.preventDefault());
    m.addEventListener('contextmenu', (e) => e.preventDefault());
    return m;
  }

  function onKey(e) {
    // Only the person's own keys steer the menu: a page can send key events of its own, and must
    // not be able to pick an entry (a download, a private window) after somebody opened the menu.
    if (!e.isTrusted) return;
    const panel = panels.at(-1);
    const list = [...panel.querySelectorAll('button')];
    const i = list.indexOf(at);
    const stop = () => { e.preventDefault(); e.stopPropagation(); };
    if (e.key === 'Escape') { stop(); return panels.length > 1 ? (closeSub(), setAt(root.querySelector('button.open') ?? at)) : close(); }
    if (e.key === 'ArrowDown') { stop(); return setAt(list[(i + 1) % list.length] ?? list[0]); }
    if (e.key === 'ArrowUp') { stop(); return setAt(list[(i - 1 + list.length) % list.length] ?? list.at(-1)); }
    if (e.key === 'ArrowRight' && at?._sub) { stop(); return openSub(at, at._sub, true); }
    if (e.key === 'ArrowLeft' && panels.length > 1) { stop(); const opener = root.querySelector('button.open'); closeSub(); return setAt(opener); }
    if (e.key === 'Enter' || e.key === ' ') { stop(); if (at) (at._sub ? openSub(at, at._sub, true) : at._go()); return; }
    if (e.key === 'Tab') return stop();
  }

  // ---- A strong password, filled in, with a small card to see or copy it --------------------
  // 20 characters from letters, digits and a few symbols sites accept, without the ones people
  // misread (0 O 1 l I); at least one of each kind. Random from the browser's crypto source.
  function strongPassword(n = 20) {
    const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '-_!@#$%*+=?'];
    const all = sets.join('');
    const pick = (s) => { const lim = 256 - (256 % s.length); for (;;) { const b = crypto.getRandomValues(new Uint8Array(1))[0]; if (b < lim) return s[b % s.length]; } };
    for (;;) {
      const p = Array.from({ length: n }, () => pick(all)).join('');
      if (sets.every((s) => [...p].some((ch) => s.includes(ch)))) return p;
    }
  }
  // As if typed: through the field's own value setter, so pages built with React and the like see it.
  function setTyped(field, value) {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    field.focus();
    set.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function suggestPassword(field) {
    if (!(field instanceof HTMLInputElement)) return;
    const pw = strongPassword();
    setTyped(field, pw);
    // Its twin: the "confirm password" field of the same form, if it is empty or asks to repeat.
    const scope = field.form || document;
    const others = [...scope.querySelectorAll('input[type=password]')].filter((f) => f !== field && !f.disabled);
    const twin = others.find((f) => !f.value || /confirm|repeat|again|verify|retype/i.test(`${f.name} ${f.id} ${f.placeholder} ${f.getAttribute('aria-label') || ''}`));
    if (twin) setTyped(twin, pw);
    field.focus();
    passwordCard(field, pw, !!twin);
  }
  function passwordCard(field, pw, twin) {
    document.getElementById('gamblium-pw-card')?.remove();
    const host = document.createElement('div');
    host.id = 'gamblium-pw-card';
    const r = field.getBoundingClientRect();
    // Beside the field when there is room, else above it: never over the form's next fields.
    const W = 380, H = 120;
    // Right of every field and button of the form, so none of them is hidden.
    const parts = [...(field.form || document).querySelectorAll('input:not([type=hidden]), select, textarea, button')].map((e) => e.getBoundingClientRect()).filter((b) => b.width && b.bottom > r.top - 200 && b.top < r.bottom + 300);
    const right = Math.max(r.right, ...parts.map((b) => b.right));
    const pos = right + 16 + W < innerWidth ? { left: right + 16, top: Math.max(8, r.top - 8) } : { left: Math.max(8, Math.min(r.left, innerWidth - W - 8)), top: Math.max(8, Math.min(...parts.map((b) => b.top), r.top) - H - 8) };
    Object.assign(host.style, { position: 'fixed', left: `${pos.left}px`, top: `${pos.top}px`, zIndex: 2147483647 });
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>
      .c{font:13px/1.35 'Segoe UI',system-ui,sans-serif;background:#17181B;color:#E4E6EB;border:1px solid #2B2D33;border-radius:12px;padding:10px 12px;box-shadow:0 10px 30px rgba(0,0,0,.35);display:flex;flex-direction:column;gap:8px;min-width:280px;max-width:380px}
      .t{display:flex;align-items:center;gap:8px;font-weight:600}.t i{width:8px;height:8px;border-radius:50%;background:#6CC48F;display:inline-block}
      .p{font:13px 'Cascadia Mono',Consolas,monospace;background:#0D0E10;border:1px solid #2B2D33;border-radius:8px;padding:6px 8px;letter-spacing:.5px;word-break:break-all}
      .r{display:flex;gap:6px;align-items:center}.s{color:#9DA1AA;font-size:12px;flex:1}
      button{font:inherit;color:inherit;background:#232428;border:1px solid #2B2D33;border-radius:8px;padding:4px 10px;cursor:pointer}button:hover{border-color:#9DA1AA}
      @media (prefers-color-scheme: light){.c{background:#fff;color:#121316;border-color:#CDD1D9}.p{background:#F7F8FA;border-color:#CDD1D9}button{background:#F2F3F5;border-color:#CDD1D9}.s{color:#555B66}}
    </style><div class="c" role="status"><div class="t"><i></i>Strong password filled${twin ? ' in both fields' : ''}</div><div class="p" id="p">${'•'.repeat(pw.length)}</div><div class="r"><span class="s">Gamblium offers to save it when you send the form.</span><button id="show">Show</button><button id="copy">Copy</button><button id="x" aria-label="Close">✕</button></div></div>`;
    let shown = false;
    root.getElementById('show').onclick = () => { shown = !shown; root.getElementById('p').textContent = shown ? pw : '•'.repeat(pw.length); root.getElementById('show').textContent = shown ? 'Hide' : 'Show'; };
    root.getElementById('copy').onclick = async () => { try { await navigator.clipboard.writeText(pw); root.getElementById('copy').textContent = 'Copied'; } catch { root.getElementById('copy').textContent = 'Not allowed'; } };
    root.getElementById('x').onclick = () => host.remove();
    document.documentElement.append(host);
    setTimeout(() => host.remove(), 30000);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const t = document.createElement('textarea');
      t.value = text;
      t.style.cssText = 'position:fixed;opacity:0';
      document.documentElement.append(t);
      t.select();
      document.execCommand('copy');
      t.remove();
    }
  }
  async function copyImage(url) {
    const r = await send('image-data', { url });
    if (!r?.data) return copyText(url);
    const img = await createImageBitmap(await (await fetch(r.data)).blob());
    const c = new OffscreenCanvas(img.width, img.height);
    c.getContext('2d').drawImage(img, 0, 0);
    const png = await c.convertToBlob({ type: 'image/png' });
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]).catch(() => copyText(url));
  }
  async function paste(target) {
    target?.focus?.();
    if (document.execCommand('paste')) return;
    const text = await navigator.clipboard.readText().catch(() => '');
    if (text) document.execCommand('insertText', false, text);
  }

  /** One line near the pointer, gone after a few seconds or at the next click (only after a choice in the menu). */
  function tip(x, y, text) {
    const h = document.createElement('gamblium-menu');
    const r = h.attachShadow({ mode: 'closed' });
    const st = document.createElement('style');
    st.textContent = CSS;
    const p = document.createElement('div');
    p.className = 'm tip';
    p.textContent = text;
    r.append(st, p);
    document.documentElement.append(h);
    p.style.left = Math.min(x, innerWidth - p.offsetWidth - 8) + 'px';
    p.style.top = Math.min(y, innerHeight - p.offsetHeight - 8) + 'px';
    const gone = () => { h.remove(); removeEventListener('pointerdown', gone, true); };
    setTimeout(gone, 4500);
    addEventListener('pointerdown', gone, true);
  }

  async function act(id, item) {
    const c = ctx;
    const md = (t, u) => `[${(t || u).trim().replace(/\s+/g, ' ').replace(/([\[\]\\])/g, '\\$1')}](${u.replace(/\(/g, '%28').replace(/\)/g, '%29')})`;
    close();
    switch (id) {
      case 'back': return history.back();
      case 'forward': return history.forward();
      case 'reload': try { return (c.ours ? top : window).location.reload(); } catch { return location.reload(); }
      case 'bookmark': return send('bookmark', { url: c.page, title: document.title });
      case 'link-tab': return send('open', { url: c.link, where: 'tab' });
      case 'link-window': return send('open', { url: c.link, where: 'window' });
      case 'link-private': return send('open', { url: c.link, where: 'private' });
      case 'link-tor': return send('open', { url: c.link, where: 'tor' });
      case 'link-torrent': return send('torrent', { url: c.link });
      case 'link-copy': return copyText(c.link);
      case 'link-copy-clean': return copyText(cleanLink(c.link));
      case 'link-download': return send('save', { url: c.link });
      case 'link-save': return send('save', { url: c.link, ask: true });
      case 'link-text': return copyText(c.linkText);
      case 'undo': c.target?.focus?.(); return document.execCommand('undo');
      case 'translate': return send('translate', { text: c.text });
      case 'inspect': return tip(c.x, c.y, "Inspect needs the browser's own menu: Shift + right-click, or Ctrl+Shift+C.");
      case 'highlight': return copyText(highlightLink(c.page, c.text));
      case 'image-tab': return send('open', { url: c.image, where: 'tab' });
      case 'image-save': return send('save', { url: c.image });
      case 'image-copy': return copyImage(c.image);
      case 'image-address': return copyText(c.image);
      case 'video-tab': return send('open', { url: c.video, where: 'tab' });
      case 'video-copy': return copyText(c.video);
      case 'cut': c.target?.focus?.(); return document.execCommand('cut');
      case 'copy': return c.editable ? (c.target?.focus?.(), document.execCommand('copy')) : copyText(c.text);
      case 'paste': return paste(c.target);
      case 'select-all': c.target?.focus?.(); return c.target?.select ? c.target.select() : document.execCommand('selectAll');
      case 'pw-suggest': return suggestPassword(c.target);
      case 'search': return send('search', { text: c.text });
      case 'page-save': return send('save', { url: c.page, ask: true });
      case 'page-print': return setTimeout(() => print(), 60);
      case 'page-copy': return copyText(c.page);
      case 'page-markdown': return copyText(md(document.title, c.page));
      case 'page-source': return send('source', { url: c.page });
      case 'shot': return OURS ? loadShot() : send('screenshot-start');
      case 'tab-duplicate': case 'tab-pin': case 'tab-mute': case 'sleep-others': case 'focus': case 'open-dashboard': case 'open-settings': return send(id);
      case 'awake-tab': return send('awake', { tab: !item.check });
      case 'group-sleep': return send('group-sleep');
      case 'group-awake': return send('group-awake', { on: !item.check });
      case 'awake-site': return send('awake', { site: !item.check });
      default:
        if (id.startsWith('page:')) return c.runs?.[Number(id.slice(5))]?.();
        if (id.startsWith('tool:')) return send('tool', { id: id.slice(5), link: c.link || '' });
        if (id.startsWith('session:')) return send('open-session', { url: c.link, name: id.slice(8) });
        if (id === 'space-new') return send('space-move', { groupId: null });
        if (id === 'space-leave') return send('space-leave');
        if (id.startsWith('space:')) return send('space-move', { groupId: Number(id.slice(6)) });
    }
  }

  function contextOf(e) {
    const el = e.composedPath()[0] instanceof Element ? e.composedPath()[0] : e.target;
    const a = el.closest?.('a[href], area[href]');
    const img = el instanceof HTMLImageElement ? el : null;
    const vid = el instanceof HTMLVideoElement ? el : null;
    const field = el.closest?.('textarea, input, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]');
    const typed = field && (!(field instanceof HTMLInputElement) || /^(text|search|url|email|tel|password|number|)$/i.test(field.getAttribute('type') || ''));
    let text = String(getSelection?.() ?? '');
    if (typed && field.value !== undefined && field.selectionStart != null) text = field.value.slice(field.selectionStart, field.selectionEnd);
    const base = {
      link: a ? a.href : '', image: img ? img.currentSrc || img.src : '', imageSize: img && img.naturalWidth ? `${img.naturalWidth} × ${img.naturalHeight}` : '', video: vid ? vid.currentSrc || vid.src : '',
      text: text.trim() ? text : '', editable: !!typed, target: typed ? field : null, page: location.href,
      password: !!(typed && field instanceof HTMLInputElement && (field.type === 'password' || /new-password|current-password/i.test(field.autocomplete || ''))),
      linkText: a ? short((a.textContent || '').trim().replace(/\s+/g, ' '), 36) : '',
      canBack: globalThis.navigation?.canGoBack, canForward: globalThis.navigation?.canGoForward, x: e.clientX, y: e.clientY,
    };
    if (!OURS) return base;
    // One of our own pages: it may add entries for what was clicked and for itself. Each entry the
    // page hands over runs its own function; the menu only shows its label and icon.
    const runs = [];
    const take = (list) => (Array.isArray(list) ? list : []).filter((x) => x && x.label && typeof x.run === 'function').slice(0, 8)
      .map((x) => (runs.push(x.run), { id: 'page:' + (runs.length - 1), label: String(x.label), icon: ICONS[x.icon] ? x.icon : 'more' }));
    let hook = null;
    try { hook = typeof globalThis.gambliumPageMenu === 'function' ? globalThis.gambliumPageMenu(el) : null; } catch {}
    const extra = hook?.about ? { head: hook.about.head || '', detail: hook.about.detail || '', items: take(hook.about.items) } : null;
    const ownLink = !!a && (a.href.startsWith(location.origin + '/') || /^chrome:\/\/newtab\//.test(a.href));
    return { ...base, ours: OURS, ownLink, extra, pageItems: take(hook?.page), runs };
  }

  // The last listener to hear the event: a page that handles right-clicks itself has already cancelled it.
  addEventListener('contextmenu', (e) => {
    if (host) close();
    if (e.shiftKey || e.defaultPrevented || !e.isTrusted || !enabled) return;
    if (!chrome.runtime?.id) return; // the extension was reloaded: this copy is orphaned, the browser's menu serves
    e.preventDefault();
    const x = e.clientX;
    const y = e.clientY;
    ctx = contextOf(e);
    host = document.createElement('gamblium-menu');
    root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = CSS;
    root.append(style);
    const first = build(menuFor({ ...ctx, state: {} }));
    root.append(first);
    panels = [first];
    document.documentElement.append(host);
    place(first, x, y);
    addEventListener('keydown', onKey, true);
    addEventListener('pointerdown', onOutside, true);
    addEventListener('scroll', close, true);
    addEventListener('resize', close);
    addEventListener('blur', close);
    // What only the background knows (pinned, muted, awake, bookmarked, the tools) arrives a moment
    // later; the menu is redrawn in place if it is still the same one and nothing was opened yet.
    const mine = host;
    chrome.runtime.sendMessage({ type: 'menu-open', url: ctx.page, link: isWeb(ctx.link) }).then((state) => {
      if (host !== mine || !state || state.ok === false || panels.length > 1) return;
      ctx.state = state;
      const hadAt = at ? [...panels[0].querySelectorAll('button')].indexOf(at) : -1;
      const next = build(menuFor(ctx));
      next.classList.add('settled'); // the same menu, filled in: no second fade-in (it read as a blink)
      panels[0].replaceWith(next);
      panels = [next];
      at = null;
      place(next, x, y);
      if (hadAt >= 0) setAt(next.querySelectorAll('button')[hadAt] ?? null);
    }).catch(() => {});
  }, false);
})();

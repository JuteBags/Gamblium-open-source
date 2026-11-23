// Floating lyrics (issue #242, owner Nov 20 2026): what runs in the playing tab.
// - lyricsWatch: in the extension's own world of the page. Reports the song (Media Session
//   metadata, else the tab title) and where it is (the media element's time, play / pause, speed)
//   on play, pause, seek, speed change and song change, plus every 5 s; nothing else.
// - ytCaptionLines: in the page's world on YouTube. The video's own timed captions (people's
//   before automatic ones): used as the lyrics when there are any.
// Both are passed to chrome.scripting.executeScript, so each may use nothing but itself.

export function lyricsWatch() {
  if (window.__gambliumLyrics) {
    window.__gambliumLyrics.report(true);
    return true;
  }
  const pick = () => [...document.querySelectorAll('video, audio')]
    .filter((m) => m.readyState > 0)
    .sort((a, b) => Number(!b.paused) - Number(!a.paused) || (b.duration || 0) - (a.duration || 0))[0] || null;
  let media = pick();
  const nameOf = () => (document.title || '').replace(/^\(\d+\)\s*/, '').replace(/\s+-\s+YouTube( Music)?$/, '');
  const track = () => {
    const md = navigator.mediaSession && navigator.mediaSession.metadata;
    return {
      title: (md && md.title) || nameOf(),
      artist: (md && md.artist) || '',
      album: (md && md.album) || '',
      duration: media && isFinite(media.duration) ? media.duration : 0,
      url: location.href,
      // The song's picture for the card: the page's own (largest), else YouTube's thumbnail.
      art: (() => {
        const list = (md && md.artwork) || [];
        const size = (a) => parseInt(String(a.sizes || '0').split('x')[0], 10) || 0;
        const best = [...list].sort((a, b) => size(b) - size(a))[0];
        if (best && /^https:/.test(best.src)) return best.src;
        const v = /(^|\.)youtube\.com$/.test(location.hostname) && new URLSearchParams(location.search).get('v');
        return v ? `https://i.ytimg.com/vi/${v}/hqdefault.jpg` : '';
      })(),
    };
  };
  let lastTrack = '';
  const report = (forceTrack) => {
    const m = media;
    const t = track();
    const key = t.title + '|' + t.artist + '|' + t.art;
    if (forceTrack || key !== lastTrack) {
      lastTrack = key;
      chrome.runtime.sendMessage({ type: 'lyrics-track', ...t }).catch(() => {});
    }
    if (m) chrome.runtime.sendMessage({ type: 'lyrics-clock', position: m.currentTime, paused: m.paused, rate: m.playbackRate || 1 }).catch(() => {});
  };
  const events = ['play', 'pause', 'seeked', 'ratechange', 'loadedmetadata', 'durationchange'];
  const on = () => report(false);
  const hook = (m) => { if (m) for (const e of events) m.addEventListener(e, on); };
  const unhook = (m) => { if (m) for (const e of events) m.removeEventListener(e, on); };
  hook(media);
  // The player swaps its element sometimes; the song's name changes with the title.
  const every = setInterval(() => {
    const now = pick();
    if (now && now !== media) { unhook(media); media = now; hook(media); }
    report(false);
  }, 5000);
  const titleEl = document.querySelector('title');
  const mo = titleEl ? new MutationObserver(() => setTimeout(() => report(false), 400)) : null;
  if (mo) mo.observe(titleEl, { childList: true, characterData: true, subtree: true });
  const stop = (msg) => {
    if (!msg || msg.type !== 'lyrics-unwatch') return;
    clearInterval(every);
    unhook(media);
    if (mo) mo.disconnect();
    chrome.runtime.onMessage.removeListener(stop);
    delete window.__gambliumLyrics;
  };
  chrome.runtime.onMessage.addListener(stop);
  window.__gambliumLyrics = { report };
  report(true);
  return true;
}

export async function ytCaptionLines() {
  if (!/(^|\.)youtube\.com$/.test(location.hostname)) return null;
  const player = document.querySelector('#movie_player');
  let resp = null;
  try { resp = player && player.getPlayerResponse && player.getPlayerResponse(); } catch { /* not ready */ }
  resp = resp || window.ytInitialPlayerResponse || null;
  const tracks = (resp && resp.captions && resp.captions.playerCaptionsTracklistRenderer && resp.captions.playerCaptionsTracklistRenderer.captionTracks) || [];
  if (!tracks.length) return { lines: [], why: 'this video has no captions' };
  const t = tracks.find((x) => x.kind !== 'asr') || tracks[0];
  const vid = resp.videoDetails && resp.videoDetails.videoId;
  const json3 = async (url) => {
    const u = new URL(url, location.href);
    u.searchParams.set('fmt', 'json3');
    try { const body = await (await fetch(u.toString(), { credentials: 'include' })).text(); return body ? JSON.parse(body) : null; } catch { return null; }
  };
  // YouTube now answers only requests carrying its player's token (owner, Nov 20 2026: the plain
  // caption address came back empty). So: the player's own caption request for this video, made
  // by switching its CC on for a moment (the tab is hidden; it is switched back off at once).
  const theirs = () => performance.getEntriesByType('resource').map((e) => e.name)
    // Only the player's (with its token): our own token-less try above is in this list too.
    .filter((n) => n.includes('/api/timedtext') && n.includes('pot=') && (!vid || n.includes('v=' + vid))).pop() || null;
  let j = await json3(t.baseUrl);
  let used = t;
  if (!j || !(j.events || []).length) {
    let url = theirs();
    if (!url) {
      const b = document.querySelector('.ytp-subtitles-button');
      const off = b && b.getAttribute('aria-pressed') === 'false';
      if (off) b.click();
      for (let i = 0; i < 30 && !url; i++) { await new Promise((r) => setTimeout(r, 200)); url = theirs(); }
      if (off && b.getAttribute('aria-pressed') === 'true') b.click();
    }
    if (!url) return { lines: [], why: 'YouTube sent no captions' };
    j = await json3(url);
    const u = new URL(url, location.href);
    used = tracks.find((x) => x.languageCode === u.searchParams.get('lang') && (x.kind || '') === (u.searchParams.get('kind') || '')) || { languageCode: u.searchParams.get('lang'), kind: u.searchParams.get('kind') };
  }
  if (!j) return { lines: [], why: 'captions in an unknown form' };
  const clean = (s) => s.replace(/\n/g, ' ').replace(/\[[^\]]*\]/g, '').replace(/[♪♫]/g, '').replace(/\s+/g, ' ').trim();
  const out = [];
  const ev = (j.events || []).filter((e) => e.segs && e.segs.length);
  ev.forEach((e, i) => {
    const text = clean(e.segs.map((s) => s.utf8 || '').join(''));
    if (!text) return;
    const at = e.tStartMs / 1000;
    out.push({ at, text });
    // A pause in the singing: the line goes once it is over.
    const end = (e.tStartMs + (e.dDurationMs || 0)) / 1000;
    const next = ev[i + 1] ? ev[i + 1].tStartMs / 1000 : Infinity;
    if (e.dDurationMs && next - end > 1.5) out.push({ at: end, text: '' });
  });
  const name = (used.name && (used.name.simpleText || (used.name.runs || []).map((r) => r.text).join(''))) || used.languageCode || '';
  // Automatic captions get the words wrong but the times right: they are the clock the looked-up
  // lyrics are moved onto. People's captions are the lyrics themselves.
  return { lines: out, kind: used.kind === 'asr' ? 'auto' : 'captions', source: `YouTube captions (${name}${used.kind === 'asr' ? ', automatic' : ''})`, video: vid };
}

/** The card's buttons, in the playing tab: previous, play / pause, next. */
export function lyricsControl(what, to) {
  const media = [...document.querySelectorAll('video, audio')].filter((m) => m.readyState > 0)
    .sort((a, b) => Number(!b.paused) - Number(!a.paused) || (b.duration || 0) - (a.duration || 0))[0];
  const click = (sel) => { const b = document.querySelector(sel); if (b && b.offsetParent !== null) { b.click(); return true; } return false; };
  if (what === 'seek' && media && Number.isFinite(to)) media.currentTime = Math.max(0, Math.min(to, isFinite(media.duration) ? media.duration - 0.5 : to));
  else if (what === 'toggle' && media) { if (media.paused) media.play().catch(() => {}); else media.pause(); }
  else if (what === 'next') { if (!click('.ytp-next-button, .next-button, [aria-label="Next"]') && media && isFinite(media.duration)) media.currentTime = media.duration - 0.5; }
  else if (what === 'prev') { if (!(media && media.currentTime > 4 ? false : click('.ytp-prev-button, .previous-button, [aria-label="Previous"]')) && media) media.currentTime = 0; }
  return true;
}

/** A compilation's songs (jukebox, "best of"): YouTube's own chapters, else the timestamps in the
 *  description ("0:00 Alag Aasmaan", "04:12 - Baarishein"). In the page's world on YouTube.
 *  At least 3, in order, the first near the start; else none. */
export function ytChapters() {
  if (!/(^|\.)youtube\.com$/.test(location.hostname)) return [];
  const player = document.querySelector('#movie_player');
  let resp = null;
  try { resp = player && player.getPlayerResponse && player.getPlayerResponse(); } catch { /* not ready */ }
  const vid = resp && resp.videoDetails && resp.videoDetails.videoId;
  const ok = (list) => list.length >= 3 && list[0].at <= 30 && list.every((c, i) => i === 0 || c.at > list[i - 1].at) ? list : null;
  // 1. The chapter markers on the seek bar (this video's: the page data may be an earlier video's).
  try {
    const d = window.ytInitialData;
    const same = d && JSON.stringify(d.currentVideoEndpoint || {}).includes(vid || '#');
    const maps = same && d.playerOverlays.playerOverlayRenderer.decoratedPlayerBarRenderer.decoratedPlayerBarRenderer.playerBar.multiMarkersPlayerBarRenderer.markersMap;
    for (const m of maps || []) {
      const ch = (m.value && m.value.chapters) || [];
      const list = ch.map((c) => c.chapterRenderer).filter(Boolean).map((c) => ({ at: c.timeRangeStartMillis / 1000, title: (c.title && (c.title.simpleText || (c.title.runs || []).map((r) => r.text).join(''))) || '' }));
      if (ok(list)) return list;
    }
  } catch { /* no markers */ }
  // 2. Timestamps in the description.
  const text = (resp && resp.videoDetails && resp.videoDetails.shortDescription) || '';
  const out = [];
  for (const raw of text.split('\n')) {
    const m = raw.match(/(?:^|[\s([])((?:\d{1,2}:)?\d{1,2}:\d{2})(?=$|[\s)\]\-–|:.])/);
    if (!m) continue;
    const parts = m[1].split(':').map(Number);
    const at = parts.reduce((s, x) => s * 60 + x, 0);
    const title = raw.replace(m[1], ' ').replace(/^[\s\d.)\]\-–|:•]+/, '').replace(/[\s(\[\-–|:•]+$/, '').replace(/\s{2,}/g, ' ').trim();
    if (title) out.push({ at, title });
  }
  return ok(out) || [];
}

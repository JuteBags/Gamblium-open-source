// Gamblium's own pop-out video window (owner, Nov 16 2026), Chrome's Document Picture-in-Picture:
// a small always-on-top window holding the page's real video (moved in, so it keeps playing, and
// moved back when the window closes), with Gamblium's own controls:
//   - Background (headphones): the window closes, the video goes back into its tab and its sound
//     keeps playing (a tab playing sound is never frozen; Chromium stops decoding the hidden
//     picture, so it costs less than the window).
//   - Captions: drawn in the window at a size that follows the window (about 5.5% of its height),
//     from the video's own text tracks, or on YouTube from YouTube's own captions (switched on).
//   - Play / pause, back and forward 10 s, previous / next (YouTube), seek bar, time, volume, and the video's own colours glowing behind it (owner, Nov 20 2026). Shown on opening and
//     on mouse movement. Back to the tab. The window's own close button pauses, as the browser's does.
// `pipMain` runs IN THE PAGE (debugger Runtime.evaluate with a user gesture: opening the window
// needs one), so it may use nothing from this file but itself. Where the window cannot be had
// (no Document Picture-in-Picture, a video that refuses), the browser's own video window is used.

export function pipMain() {
  // The video making the sound, then the largest (review 10, H23: a muted header loop came first).
  const area = (x) => x.clientWidth * x.clientHeight;
  const v = [...document.querySelectorAll('video')]
    .filter((x) => !x.paused && !x.ended && x.videoWidth > 0 && !x.disablePictureInPicture)
    .sort((a, b) => Number(!b.muted && b.volume > 0) - Number(!a.muted && a.volume > 0) || area(b) - area(a))[0];
  if (!v || document.pictureInPictureElement || (window.documentPictureInPicture && window.documentPictureInPicture.window)) return Promise.resolve(false);
  const native = () => v.requestPictureInPicture().then(() => true, () => false);
  if (!window.documentPictureInPicture) return native();
  const w0 = 420;
  const h0 = Math.max(140, Math.round((w0 * (v.videoHeight || 9)) / (v.videoWidth || 16)));
  return window.documentPictureInPicture.requestWindow({ width: w0, height: h0 }).then((pip) => {
    const doc = pip.document;
    // Nothing here may use innerHTML: YouTube's page enforces Trusted Types, the window inherits
    // it, and innerHTML threw after the video had moved in: a bare video, no buttons (owner, Nov
    // 20 2026). Everything is built with createElement / createElementNS.
    const E = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
    const NS = 'http://www.w3.org/2000/svg';
    const svg = (shapes) => {
      const s = doc.createElementNS(NS, 'svg');
      s.setAttribute('viewBox', '0 0 24 24');
      s.setAttribute('aria-hidden', 'true');
      for (const [tag, attrs] of shapes) {
        const p = doc.createElementNS(NS, tag);
        for (const k in attrs) p.setAttribute(k, attrs[k]);
        s.append(p);
      }
      return s;
    };
    const I = {
      play: [['path', { d: 'M7 5l12 7-12 7z', fill: 'currentColor' }]],
      pause: [['path', { d: 'M8 5v14M16 5v14' }]],
      back10: [['path', { d: 'M4 12a8 8 0 1 0 2.3-5.6' }], ['path', { d: 'M4 4v4h4' }], ['path', { d: 'M10.5 10v5M13.5 10h2v5h-2z' }]],
      fwd10: [['path', { d: 'M20 12a8 8 0 1 1-2.3-5.6' }], ['path', { d: 'M20 4v4h-4' }], ['path', { d: 'M9 10v5M12 10h2v5h-2z' }]],
      prev: [['path', { d: 'M6 5v14' }], ['path', { d: 'M19 5l-10 7 10 7z', fill: 'currentColor' }]],
      next: [['path', { d: 'M18 5v14' }], ['path', { d: 'M5 5l10 7-10 7z', fill: 'currentColor' }]],
      vol: [['path', { d: 'M4 9h4l5-4v14l-5-4H4z', fill: 'currentColor' }], ['path', { d: 'M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12' }]],
      mute: [['path', { d: 'M4 9h4l5-4v14l-5-4H4z', fill: 'currentColor' }], ['path', { d: 'M17 9l5 6M22 9l-5 6' }]],
      phones: [['path', { d: 'M4 15v-3a8 8 0 0 1 16 0v3' }], ['rect', { x: 3, y: 14, width: 4, height: 7, rx: 1.5 }], ['rect', { x: 17, y: 14, width: 4, height: 7, rx: 1.5 }]],
      cc: [['rect', { x: 3, y: 5, width: 18, height: 14, rx: 2.5 }], ['path', { d: 'M10 10.2a2.2 2.2 0 1 0 0 3.6M17 10.2a2.2 2.2 0 1 0 0 3.6' }]],
      back: [['path', { d: 'M4 4h16v16H4z' }], ['path', { d: 'M14 10l-5 5M9 10v5h5' }]],
      lyrics: [['path', { d: 'M4 6h10M4 11h10M4 16h6' }], ['path', { d: 'M18 5v10.5' }], ['circle', { cx: 16, cy: 16, r: 2.2 }]],
    };
    const btn = (label, shape, cls) => {
      const b = E('button', cls);
      b.type = 'button';
      b.title = label;
      b.setAttribute('aria-label', label);
      b.append(svg(shape));
      return b;
    };
    const setIcon = (b, shape) => b.replaceChildren(svg(shape));

    const was = { parent: v.parentNode, next: v.nextSibling, style: v.getAttribute('style') };
    // A stand-in keeps the page's layout while the video is away.
    const hold = document.createElement('div');
    hold.style.cssText = `width:${v.clientWidth}px;height:${v.clientHeight}px;background:#000`;
    was.parent.insertBefore(hold, v);
    const playing = () => !v.paused;
    const keepPlaying = (on) => { if (on) v.play().catch(() => {}); };

    const css = E('style');
    css.textContent = `
      html,body{margin:0;height:100%;background:#07090c;overflow:hidden;font:500 12px system-ui,'Segoe UI',sans-serif;color:#fff;user-select:none}
      .glow{position:absolute;inset:-12%;width:124%;height:124%;opacity:.9;image-rendering:auto}
      .frame{position:absolute;inset:6px;border-radius:12px;overflow:hidden;box-shadow:0 0 0 1px rgb(255 255 255/.06),0 0 24px color-mix(in srgb,var(--mood,#000) 70%,transparent)}
      video{position:absolute;inset:0;width:100%!important;height:100%!important;object-fit:contain;max-width:none!important;max-height:none!important;transform:none!important;left:0!important;top:0!important;background:transparent}
      .ui{position:absolute;inset:6px;border-radius:12px;opacity:0;transition:opacity .2s;pointer-events:none}
      body.show .ui,.ui:focus-within{opacity:1;pointer-events:auto}
      body.show{cursor:default} body:not(.show){cursor:none}
      .mid{position:absolute;left:0;right:0;top:50%;transform:translateY(-50%);display:flex;justify-content:center;align-items:center;gap:18px}
      .mid button{width:40px;height:40px;border-radius:50%;background:rgb(0 0 0/.58);box-shadow:0 2px 10px rgb(0 0 0/.35)}
      .mid button:hover{background:rgb(0 0 0/.68)}
      .mid .big{width:54px;height:54px}
      .mid .big svg{width:24px;height:24px}
      .low{position:absolute;left:8px;right:8px;bottom:8px;padding:6px 8px 4px;border-radius:12px;background:color-mix(in srgb,var(--mood,#0e1014) 30%,rgb(10 12 16/.74));box-shadow:inset 0 0 0 1px rgb(255 255 255/.08)}
      .seek{position:relative;height:14px;cursor:pointer;display:flex;align-items:center}
      .rail{position:relative;width:100%;height:4px;border-radius:4px;background:rgb(255 255 255/.22);overflow:hidden;transition:height .12s}
      .seek:hover .rail{height:6px}
      .buf,.done{position:absolute;left:0;top:0;bottom:0}
      .buf{background:rgb(255 255 255/.32)} .done{background:var(--tint,#fff)}
      .knob{position:absolute;top:50%;width:12px;height:12px;margin:-6px 0 0 -6px;border-radius:50%;background:#fff;box-shadow:0 1px 4px rgb(0 0 0/.5);transform:scale(0);transition:transform .12s}
      .seek:hover .knob{transform:scale(1)}
      .row{display:flex;align-items:center;gap:2px}
      .time{margin-left:6px;font-variant-numeric:tabular-nums;opacity:.9;white-space:nowrap}
      .grow{flex:1}
      .vol{display:flex;align-items:center}
      .vol input{width:0;opacity:0;transition:width .15s,opacity .15s;accent-color:#fff;margin:0}
      .vol:hover input,.vol:focus-within input{width:56px;opacity:1;margin:0 4px}
      button{all:unset;cursor:pointer;width:30px;height:30px;display:grid;place-items:center;border-radius:9px;color:#fff}
      button:hover,button:focus-visible{background:rgb(255 255 255/.18)}
      button[aria-pressed=true]{background:#fff;color:#000}
      svg{width:17px;height:17px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
      .cc{position:absolute;left:6%;right:6%;bottom:9%;text-align:center;pointer-events:none;transition:bottom .2s}
      .cc span{display:inline;padding:.1em .35em;line-height:1.35;font-size:5.6vh;color:#fff;background:rgb(0 0 0/.72);border-radius:.2em;box-decoration-break:clone;-webkit-box-decoration-break:clone;white-space:pre-line}
      body.show .cc{bottom:calc(9% + 64px)}
      .say{position:absolute;top:10px;left:50%;transform:translateX(-50%);padding:4px 10px;border-radius:8px;background:rgb(0 0 0/.75);opacity:0;transition:opacity .2s;pointer-events:none}
      .say.on{opacity:1}`;
    doc.head.append(css);

    // ---- ambience: the video's own colours, small and blurred, behind it (YouTube's ambient mode)
    const glow = E('canvas', 'glow');
    glow.width = 32;
    glow.height = 18;
    const g = glow.getContext('2d', { alpha: false });
    const frame = E('div', 'frame');
    v.removeAttribute('style');
    const was1 = playing();
    frame.append(v);
    doc.body.append(glow, frame);
    keepPlaying(was1);
    // Twice a second, on a 32 x 18 canvas: next to nothing for the processor.
    // The picture's average colour sets the mood: the seek bar's fill (brightened) and the panel's tint.
    const tint = () => {
      try {
        // Tinted and softened here (twice a second), not by a CSS filter on every video frame
        // (owner, Nov 23 2026: the pop-out cost more than the page itself).
        g.filter = 'saturate(1.6) brightness(0.85) blur(1.5px)';
        g.drawImage(v, 0, 0, 32, 18);
        g.filter = 'none';
        const px = g.getImageData(0, 0, 32, 18).data;
        let r = 0, gg = 0, b = 0;
        for (let i = 0; i < px.length; i += 4) { r += px[i]; gg += px[i + 1]; b += px[i + 2]; }
        const n = px.length / 4;
        [r, gg, b] = [r / n, gg / n, b / n];
        const top = Math.max(r, gg, b, 1);
        const lift = (c) => Math.round(Math.min(255, 90 + (c / top) * 165));
        doc.body.style.setProperty('--mood', `rgb(${Math.round(r)} ${Math.round(gg)} ${Math.round(b)})`);
        doc.body.style.setProperty('--tint', `rgb(${lift(r)} ${lift(gg)} ${lift(b)})`);
      } catch { /* a frame not ready yet, or a picture the page may not read */ }
    };
    tint();
    const glowTimer = pip.setInterval(tint, 500);

    // ---- controls
    const ui = E('div', 'ui');
    // No title in the window (owner, Nov 20 2026): the browser's own bar above it already names the site.
    const yt = /(^|\.)youtube\.com$/.test(location.hostname);
    const ytBtn = (sel) => (yt ? document.querySelector(sel) : null);
    const mid = E('div', 'mid');
    const bPrev = btn('Previous', I.prev);
    const b10 = btn('Back 10 seconds', I.back10);
    const bPlay = btn('Play or pause (Space)', playing() ? I.pause : I.play, 'big');
    const f10 = btn('Forward 10 seconds', I.fwd10);
    const bNext = btn('Next', I.next);
    // Previous / next only where the page has them (YouTube's player); else they are not drawn.
    if (ytBtn('.ytp-prev-button') && getComputedStyle(ytBtn('.ytp-prev-button')).display !== 'none') mid.append(bPrev);
    mid.append(b10, bPlay, f10);
    if (ytBtn('.ytp-next-button')) mid.append(bNext);

    const low = E('div', 'low');
    const seek = E('div', 'seek');
    const rail = E('div', 'rail');
    const buf = E('div', 'buf');
    const done = E('div', 'done');
    const knob = E('div', 'knob');
    rail.append(buf, done);
    seek.append(rail, knob);
    const row = E('div', 'row');
    const vol = E('div', 'vol');
    const bVol = btn('Mute (M)', v.muted ? I.mute : I.vol);
    const slider = E('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '1';
    slider.step = '0.02';
    slider.value = String(v.muted ? 0 : v.volume);
    slider.setAttribute('aria-label', 'Volume');
    vol.append(bVol, slider);
    const time = E('span', 'time');
    const bBack = btn('Keep playing in the background (sound only)', I.phones);
    const bCc = btn('Captions (C)', I.cc);
    bCc.setAttribute('aria-pressed', 'false');
    const bTab = btn('Back to the tab', I.back);
    // Lyrics only (issue #242): this window closes, the song keeps playing, and Gamblium's
    // floating lyrics take its place (it remembers the choice until Video is picked there).
    const bLyrics = btn('Lyrics only (floating lyrics)', I.lyrics);
    row.append(vol, time, E('span', 'grow'), bCc, bLyrics, bBack, bTab);
    low.append(seek, row);
    ui.append(mid, low);
    const cc = E('div', 'cc');
    cc.setAttribute('aria-live', 'polite');
    const say = E('div', 'say');
    doc.body.append(cc, ui, say);
    const tell = (t) => { say.textContent = t; say.classList.add('on'); pip.setTimeout(() => say.classList.remove('on'), 2200); };

    // Shown when the window opens and whenever the mouse moves; after 2 s without movement
    // everything goes, wherever the mouse is, so the picture is clear (owner, Nov 20 2026). Kept
    // only while the seek bar is dragged or the volume slider is being used.
    let hideTimer = 0;
    let dragging = false;
    const hide = () => { if (dragging || doc.activeElement === slider) return; doc.body.classList.remove('show'); };
    const wake = () => {
      doc.body.classList.add('show');
      pip.clearTimeout(hideTimer);
      hideTimer = pip.setTimeout(hide, 2000);
    };
    doc.addEventListener('mousemove', wake);
    doc.addEventListener('mousedown', wake);
    doc.documentElement.addEventListener('mouseleave', () => { pip.clearTimeout(hideTimer); if (!dragging) doc.body.classList.remove('show'); });
    wake();

    const fmt = (s) => {
      if (!isFinite(s)) return 'live';
      s = Math.max(0, Math.floor(s));
      const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = String(s % 60).padStart(2, '0');
      return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`;
    };
    const draw = () => {
      const d = v.duration;
      const at = v.currentTime;
      const pct = isFinite(d) && d > 0 ? (at / d) * 100 : 0;
      done.style.width = `${pct}%`;
      knob.style.left = `${pct}%`;
      let b = 0;
      try { for (let i = 0; i < v.buffered.length; i++) if (v.buffered.start(i) <= at) b = v.buffered.end(i); } catch { /* none yet */ }
      buf.style.width = isFinite(d) && d > 0 ? `${(b / d) * 100}%` : '0';
      time.textContent = isFinite(d) ? `${fmt(at)} / ${fmt(d)}` : 'Live';
    };
    const paint = () => setIcon(bPlay, playing() ? I.pause : I.play);
    const paintVol = () => { setIcon(bVol, v.muted || v.volume === 0 ? I.mute : I.vol); slider.value = String(v.muted ? 0 : v.volume); };
    const onEvents = [['play', paint], ['pause', paint], ['timeupdate', draw], ['progress', draw], ['durationchange', draw], ['volumechange', paintVol]];
    for (const [e, f] of onEvents) v.addEventListener(e, f);
    draw();

    const toggle = () => (playing() ? v.pause() : v.play().catch(() => {}));
    const jump = (s) => { v.currentTime = Math.max(0, Math.min((isFinite(v.duration) ? v.duration : Infinity), v.currentTime + s)); draw(); };
    bPlay.addEventListener('click', toggle);
    b10.addEventListener('click', () => jump(-10));
    f10.addEventListener('click', () => jump(10));
    bPrev.addEventListener('click', () => ytBtn('.ytp-prev-button')?.click());
    bNext.addEventListener('click', () => ytBtn('.ytp-next-button')?.click());
    bVol.addEventListener('click', () => { v.muted = !v.muted; if (!v.muted && v.volume === 0) v.volume = 0.5; });
    slider.addEventListener('input', () => { v.volume = Number(slider.value); v.muted = v.volume === 0; });
    const seekTo = (x) => {
      const r = rail.getBoundingClientRect();
      if (isFinite(v.duration)) v.currentTime = Math.max(0, Math.min(1, (x - r.left) / r.width)) * v.duration;
      draw();
    };
    seek.addEventListener('pointerdown', (e) => { dragging = true; seek.setPointerCapture(e.pointerId); seekTo(e.clientX); });
    seek.addEventListener('pointermove', (e) => { if (dragging) seekTo(e.clientX); });
    seek.addEventListener('pointerup', () => { dragging = false; wake(); });
    slider.addEventListener('change', () => { slider.blur(); wake(); });
    // A click on the picture plays / pauses, as on YouTube.
    frame.addEventListener('click', toggle);
    ui.addEventListener('click', (e) => { if (e.target === ui || e.target === mid) toggle(); });
    doc.addEventListener('keydown', (e) => {
      if (e.target && e.target.tagName === 'INPUT' && e.key !== ' ') return;
      const k = e.key.toLowerCase();
      if (k === ' ' || k === 'k') toggle();
      else if (k === 'arrowleft' || k === 'j') jump(k === 'j' ? -10 : -5);
      else if (k === 'arrowright' || k === 'l') jump(k === 'l' ? 10 : 5);
      else if (k === 'arrowup') { v.muted = false; v.volume = Math.min(1, v.volume + 0.05); }
      else if (k === 'arrowdown') v.volume = Math.max(0, v.volume - 0.05);
      else if (k === 'm') v.muted = !v.muted;
      else if (k === 'c') bCc.click();
      else return;
      e.preventDefault();
      wake();
    });

    // ---- captions
    let stopCc = null;
    const show = (text) => {
      cc.replaceChildren();
      if (!text) return;
      cc.append(E('span', '', text));
    };
    function startCc() {
      // The video's own text tracks.
      const tracks = [...(v.textTracks || [])].filter((t) => t.kind === 'subtitles' || t.kind === 'captions');
      if (tracks.length) {
        const t = tracks.find((x) => x.mode === 'showing') || tracks[0];
        const before = t.mode;
        // Hidden while ours are drawn, or a showing track is drawn twice (review 10, H22).
        t.mode = 'hidden';
        const on = () => show([...(t.activeCues || [])].map((c) => c.text || '').join('\n').replace(/<[^>]+>/g, ''));
        t.addEventListener('cuechange', on);
        on();
        return () => { t.removeEventListener('cuechange', on); t.mode = before; show(''); };
      }
      // YouTube draws its own: switched on in its player, their words copied here.
      if (yt) {
        const b = document.querySelector('.ytp-subtitles-button');
        const turnedOn = b && b.getAttribute('aria-pressed') === 'false';
        if (turnedOn) b.click();
        const read = () => {
          const lines = [...document.querySelectorAll('.ytp-caption-window-container .caption-visual-line')].map((l) => l.textContent.trim()).filter(Boolean);
          show(lines.join('\n'));
        };
        const mo = new MutationObserver(read);
        const box = document.querySelector('#movie_player') || document.body;
        mo.observe(box, { childList: true, subtree: true, characterData: true });
        read();
        if (!b) tell('This video has no captions');
        return () => { mo.disconnect(); if (turnedOn && b.getAttribute('aria-pressed') === 'true') b.click(); show(''); };
      }
      tell('This video has no captions Gamblium can show here');
      return null;
    }
    bCc.addEventListener('click', () => {
      if (stopCc) { stopCc(); stopCc = null; bCc.setAttribute('aria-pressed', 'false'); return; }
      stopCc = startCc();
      bCc.setAttribute('aria-pressed', String(!!stopCc));
    });

    // ---- leaving the window: the video goes home
    let leaveMode = 'pause'; // the window's own close button pauses, as the browser's window does
    const home = () => {
      pip.clearInterval(glowTimer);
      if (stopCc) { stopCc(); stopCc = null; }
      const on = playing();
      if (was.style != null) v.setAttribute('style', was.style);
      for (const [e, f] of onEvents) v.removeEventListener(e, f);
      // Back where it was. A player that rebuilt its page meanwhile (review 10, H8): next to its
      // old neighbour if that is still there, else at the end of its old parent while that is in
      // the page, else into the page's player box or the page itself; never lost with the window.
      try {
        if (hold.isConnected) hold.replaceWith(v);
        else if (was.parent && was.parent.isConnected) {
          if (was.next && was.next.parentNode === was.parent) was.parent.insertBefore(v, was.next);
          else was.parent.append(v);
        } else (document.querySelector('#movie_player, [class*=player i]') || document.body).append(v);
      } catch {
        try { document.body.append(v); } catch { /* the page is gone */ }
      }
      hold.remove();
      // Closed because the tab was shown again (pipCloseMain marks the window): it keeps playing.
      // The window's own close button pauses, as the browser's window does.
      if (leaveMode === 'pause' && pip.gambliumBackToTab === true) leaveMode = 'tab';
      if (leaveMode === 'pause') v.pause();
      else keepPlaying(on);
    };
    pip.addEventListener('pagehide', home, { once: true });
    bBack.addEventListener('click', () => { leaveMode = 'keep'; pip.close(); });
    bTab.addEventListener('click', () => { leaveMode = 'tab'; pip.close(); });
    bLyrics.addEventListener('click', () => { leaveMode = 'keep'; pip.close(); document.dispatchEvent(new CustomEvent('gamblium-lyrics')); });
    // Back to the tab from the browser (its tab shown again): pipCloseMain marks the pop-out
    // window and closes it, so the video comes home playing. Nothing is left on the page's own
    // window for a site to find (review 10, H21).
    return true;
  }, () => native());
}

/** In the page: the window is closed and the video comes home, still playing (the tab is shown). */
export function pipCloseMain() {
  const w = window.documentPictureInPicture && window.documentPictureInPicture.window;
  if (w) {
    w.gambliumBackToTab = true;
    w.close();
  }
  else if (document.pictureInPictureElement) document.exitPictureInPicture();
}

// A video tab put to sleep comes back where it was (owner, Nov 23 2026: a YouTube tab slept while
// its video was popped out reloaded at 0:00, and the place in the song was lost).
// While a video plays, its place is noted in the tab's own session storage, which a tab keeps
// through sleep; when the browser reloads a slept tab (document.wasDiscarded), the same video is
// put back there, paused if it was paused. Videos under 30 s are left alone.
(() => {
  if (window.__gambliumResume) return;
  window.__gambliumResume = true;
  const KEY = 'gamblium-video-at';
  const here = () => location.href.split('#')[0];
  const isVideo = (v) => v instanceof HTMLVideoElement && Number.isFinite(v.duration) && v.duration > 30;
  const save = (v) => {
    if (!isVideo(v)) return;
    try {
      sessionStorage.setItem(KEY, JSON.stringify({ url: here(), at: v.currentTime, dur: v.duration, paused: v.paused }));
    } catch { /* storage off */ }
  };
  let lastSave = 0;
  const tick = (e) => {
    const now = Date.now();
    if (now - lastSave < 3000) return; // a few writes a minute, not four a second
    lastSave = now;
    save(e.target);
  };
  // The listeners go on each video itself: the pop-out window moves the video into its own
  // document, where listeners on this page's document no longer hear it.
  const watch = (v) => {
    if (!(v instanceof HTMLVideoElement) || v.__gambliumWatched) return;
    v.__gambliumWatched = true;
    v.addEventListener('timeupdate', tick);
    v.addEventListener('pause', () => save(v));
    v.addEventListener('seeked', () => save(v));
  };
  for (const e of ['play', 'playing', 'loadedmetadata']) document.addEventListener(e, (ev) => watch(ev.target), true);
  for (const v of document.querySelectorAll('video')) watch(v);
  document.addEventListener('freeze', () => { for (const v of document.querySelectorAll('video')) save(v); });

  if (!document.wasDiscarded) return;
  let saved = null;
  try { saved = JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch { /* none */ }
  if (!saved || saved.url !== here() || !(saved.at > 3)) return;
  const until = Date.now() + 30000;
  let tries = 0;
  // The player starts playing by itself once it has loaded: a video that was paused is paused
  // again until the person clicks or presses a key.
  let acted = false;
  for (const e of ['pointerdown', 'keydown']) addEventListener(e, () => { acted = true; }, { capture: true, once: true });
  const put = (v) => {
    // An advert first, or another video: its length differs. Wait for the one that was playing.
    if (!isVideo(v) || Math.abs(v.duration - saved.dur) > 2 || saved.at > v.duration - 3) return false;
    // After the first time, only a player that went back to the start is moved again.
    if (tries === 0 ? Math.abs(v.currentTime - saved.at) > 2 : v.currentTime < saved.at - 5) v.currentTime = saved.at;
    if (saved.paused && !acted && !v.paused) v.pause();
    if (saved.paused && !v.__gambliumHeld) {
      v.__gambliumHeld = true;
      const holdUntil = Date.now() + 20000; // short: a media key or the pop-out's button is no click here
      v.addEventListener('play', () => { if (!acted && Date.now() < holdUntil) v.pause(); });
    }
    return true;
  };
  const look = () => {
    if (Date.now() > until) return;
    const v = [...document.querySelectorAll('video')].find((x) => isVideo(x));
    // The player may start from 0 once more after it loads: checked again a few times.
    if (v && put(v) && ++tries >= 6) return;
    setTimeout(look, tries ? 1500 : 500);
  };
  look();
})();

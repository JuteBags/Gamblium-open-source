// Runs while the page is still being parsed, so the first frame already has
// the chosen background and only the parts the user switched on. A classic
// script on purpose. newtab.js keeps "gamblium.newtab" up to date.
(() => {
  const root = document.documentElement;
  // "#/<route>": this document is only the frame around one of our pages (boot.js).
  if (location.hash.startsWith('#/')) root.dataset.route = '';
  let prefs = null;
  try {
    prefs = JSON.parse(localStorage.getItem('gamblium.newtab') || 'null');
  } catch {}
  const widgets = prefs?.widgets;
  // Off unless switched on; a part this copy has never heard of stays off too.
  const quiet = ['sessions', 'downloads', 'notes', 'todo', 'playing', 'heavy', 'recent', 'marks', 'calendar', 'zones'];
  const hide = quiet.filter((id) => widgets?.[id] !== true);
  for (const id of Object.keys(widgets || {})) if (widgets[id] === false && !hide.includes(id)) hide.push(id);
  root.dataset.hide = hide.join(' ');
  const backdrop = prefs?.backdrop || 'moon';
  root.dataset.backdrop = backdrop;
  if (backdrop === 'picture') {
    try {
      const picture = localStorage.getItem('gamblium.newtab.picture');
      if (picture) root.style.setProperty('--picture', `url("${picture}")`);
      else root.dataset.backdrop = 'moon';
    } catch {}
  }
})();

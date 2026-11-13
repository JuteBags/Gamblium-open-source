// Applies the chosen colour scheme and the user's own colours before first
// paint. A classic script on purpose: it must run while the page is still being
// parsed. The choices live in localStorage: "gamblium.scheme" (no value means
// the default scheme) and "gamblium.colours" ({accent, bg} as #rrggbb, either
// may be missing). ui/page.js keeps both up to date from extension storage.
(() => {
  const lum = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(n >> 16) + 0.7152 * f((n >> 8) & 255) + 0.0722 * f(n & 255);
  };
  const ok = (c) => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c);
  // A picked background decides the ink: light ink on a dark ground, dark on a light one.
  window.gambliumColours = (c) => {
    const s = document.documentElement.style;
    for (const p of ['--accent', '--accent-strong', '--on-accent', '--bg', '--text', '--text-muted']) s.removeProperty(p);
    if (!c) return;
    if (ok(c.accent)) {
      s.setProperty('--accent', c.accent);
      s.setProperty('--accent-strong', c.accent);
      s.setProperty('--on-accent', lum(c.accent) > 0.4 ? '#0b0b0c' : '#ffffff');
    }
    if (ok(c.bg)) {
      const dark = lum(c.bg) < 0.3;
      s.setProperty('--bg', c.bg);
      s.setProperty('--text', dark ? '#e6e8ec' : '#121316');
      s.setProperty('--text-muted', dark ? '#a3a7b0' : '#50555f');
      document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
    } else document.documentElement.style.removeProperty('color-scheme');
  };
  try {
    const scheme = localStorage.getItem('gamblium.scheme');
    if (scheme) document.documentElement.dataset.scheme = scheme;
    const colours = JSON.parse(localStorage.getItem('gamblium.colours') || 'null');
    if (colours) window.gambliumColours(colours);
  } catch {}
})();

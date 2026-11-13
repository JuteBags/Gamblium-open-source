# Rebrand a private copy of Brave

Puts Gamblium's mark and name into a **copy** of Brave's program folder. The
installed Brave is never changed: anything under Program Files is refused.
`brave.exe` is not touched or renamed; only resource packs (`.pak`) are rewritten.

The launcher makes the copy (`gamblium rebrand`); this tool patches it.

## Command

```
python tools/rebrand/rebrand.py <folder> [--branding DIR] [--name NAME]
                                         [--locales en-US,en-GB|all]
                                         [--check] [--undo] [--json]
```

- `<folder>`: the copied version folder (the one holding `resources.pak`), or a
  folder with exactly one such folder inside (a copied `Application` folder).
- `--branding`: where the art comes from. Default: this repository's `branding/`.
- `--name`: the browser's name in interface strings. Default `Gamblium`.
- `--locales`: which `Locales/<name>.pak` files get the name. Default
  `en-US,en-GB`. The keep-list below is English, so `all` is at your own risk.
- `--check`: report what would change and write nothing.
- `--undo`: put Brave's own images and strings back and remove our two files.
- `--json`: the report as one JSON object on stdout; progress goes to stderr.

Needs Python 3.10+ and Pillow. About 17 seconds on Brave 1.99.56.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Done (or, with `--check`, something would be changed). A rerun that changes nothing is also 0 |
| 1 | Unexpected failure. Packs are replaced one at a time, each in one step; run again, or `--undo` |
| 2 | Refused: bad arguments, not a Brave folder, a pack this tool cannot read, the installed Brave, or branding files missing. Nothing written |
| 3 | No lion found in any pack. Brave's art has changed; nothing written. The detector's references need relearning (`lion.py learn`) |

## What it writes, all inside `<folder>`'s version folder

- The packs it changed: `chrome_100_percent.pak`, `chrome_200_percent.pak`,
  `brave_100_percent.pak`, `brave_200_percent.pak`, `resources.pak`,
  `brave_resources.pak`, `Locales/en-US.pak`, `Locales/en-GB.pak`.
- `gamblium-rebrand.json`: the report. Brave version (the folder's name), a
  digest of the branding files, every image changed (pack, resource id, what it
  became), what was recognised but left alone and why, strings changed per locale.
- `gamblium-rebrand-undo.zip`: Brave's own bytes for every resource changed.

A rerun first puts Brave's own content back from the undo file and then patches
again, so the result depends only on Brave's files and `branding/`. Rerunning
with unchanged inputs writes byte-identical packs.

## One source for the art

Everything is read from `branding/`: `gamblium-mark.svg`,
`gamblium-mark-small.svg` (drawings up to 32 units), `gamblium-lockup-dark.svg`,
`gamblium-lockup-light.svg`, `png/gamblium-<size>.png`, `png/lockup-dark.png`,
`png/lockup-light.png`. To change the logo, regenerate that folder
(`branding/make_icons.py`) and run this tool again.

Where Brave uses a one-colour lion (icons painted through a stencil), the mark
is used without its disc in that one colour. To supply your own, add
`branding/gamblium-mark-mono.svg`.

## How it recognises things (no resource ids)

Resource ids move between Brave versions, and a table of ids kept by hand had
already gone wrong once (it listed the "page crashed" icon as a logo). So:

- **The lion** is found by its outline, in PNG pixels and in SVG paths
  (`lion.py`). An outline alone also fits a plain shield, so a second proof is
  needed: the face pattern in a PNG, the amount of path detail in an SVG.
- **The word "brave"** beside a lion is recognised by the shape of its letters.
  With it, the whole image becomes our lockup (light or dark letters to match).
  Without it ("rewards", "wallet", a lion inside an illustration or a ring),
  only the lion is replaced, in place.
- **The name**: "Brave" becomes the new name in interface strings, except
  - before a word on the keep-list in `rebrand.py` (Brave's own services and
    company: Search, Software, Shields, Rewards, Wallet, VPN, News, Talk, Leo,
    Sync and so on; its other channels; names Brave's build made from Google's),
  - inside addresses,
  - in any string that mentions a copyright or a licence, and in strings over
    3000 characters.

Measured on Brave 1.99.56: lions score 0.94 to 1.00 on outline and 0.68 to 1.00
on face; the nearest other shapes score 0.93 (shields) and 0.32 (a shield with
a letter). "brave" scores 0.87 to 1.00, "rewards" and "wallet" 0.51 to 0.54.

## Result on Brave 1.99.56

55 images and 2,544 strings (1,268 in en-US). Seen in the patched copy on a
throwaway profile (`docs/design/rebrand-patched.jpg`):

- our mark on the address chip of internal pages, on the Shields button in the
  address bar, in the tabs of internal pages, in the Settings header and menu;
- "About Gamblium" with our mark; "Welcome to Gamblium"; the app menu button.

Left alone, and listed in the report:

- the outline-only lion (`brave_*_percent.pak`, one image): its face does not
  pass the second proof;
- two SVGs where the lion sits inside `<defs>`;
- the 3D lion on the welcome page (different art);
- lions drawn inside scripts (nine script bundles carry inline SVG);
- "Brave 1.99.56 (Official Build)" on the About page, and the copyright line;
- "Search Brave or type a URL": that names the search engine, and is right.

Not seen yet: the Shields panel itself (the test could not open it).

Brave's settings pages are one script in `resources.pak`. `extra.py` changes four
places in it, each found by its text and left alone (and reported) when it is
not found exactly once: the Gamblide menu entry gets our mark instead of a stock
shield (in the text colour, each facet at its own strength, so it works on a
light and a dark menu); the menu's Downloads entry opens Gamblium's own Downloads
settings (`chrome://newtab/#/settings#downloads`); "On startup" no longer shows
the "Gamblium is controlling this setting" row; the Brave Origin menu entry is
hidden. Checked: the changed script still parses (`node --check`), and each
change was applied by hand to the live page of a test window (`docs/design/settings-menu-*.png`).
Not checked: the patched pack itself in a running browser; that needs `gamblium rebrand`.

What no pack can change: the window and taskbar icon, the name in Task Manager,
and `brave://` in addresses. Those live in `brave.exe`.

## Tests

```
python -m unittest tools/rebrand/test_rebrand.py
```

Brave's art is not in the repository; the tests draw a lion from the detector's
own reference bitmaps.

## Skin for Brave's own pages

Brave's Shields panel and other internal pages take their colours from one
shared stylesheet of design tokens (`--leo-color-*`). When `branding/skin.css`
exists (`branding/make_icons.py` writes it from the default scheme in
`palette.json`), the patcher appends it to that stylesheet and gives the
Shields panel page the scheme's background. Both are found by content, not by
id, and both are listed in the report.

`branding/gamblide-panel.css`, when it exists, goes into the panel's page as
well: our curves, the light from above, the blocked count as the headline. It
changes surfaces only (ground, radius, shadow, type size) and leaves the
panel's layout rules alone. The panel's own rules live in its script bundle
(`brave_shields_panel_new.bundle.js`, readable `.css` blocks); the class names
this file uses come from there.

Seen on Brave 1.99.56 with the Moonlight scheme, opened as a page
(`docs/design/gamblide-panel.png`): the "switched off" state only. A page
opened this way has no site behind it, so the blocked count, the switches and
the lists were styled from the bundle's rules and not seen. Not seen as the
real drop-down either.

The app menu (the three lines) is drawn by `brave.exe`, not by a page. It takes
the theme's colours and nothing else can be changed from outside.

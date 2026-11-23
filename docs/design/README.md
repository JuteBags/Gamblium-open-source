# docs/design

One current picture per finished surface, and the tools the design session tests with.
Pictures taken while testing are not kept here; a newer picture of a surface replaces the
older one. Earlier pictures, the logo proposals and the first prototypes are in the git
history (removed Nov 12 2026).

| Surface | Picture |
|---|---|
| New tab page | `newtab-all-widgets.png`, `newtab-customise.png`, `newtab-search.png`, `newtab-light.png` |
| Welcome | `welcome-1-name.png`, `welcome-2-look.png` |
| Popup | `popup-site-panel.png`, `popup-browser-view.png` |
| Tabs and memory | `tabs-and-memory.png` |
| Library | `library-history.png`, `library-downloads.png` |
| Sessions, with a search typed | `sessions.png` |
| Downloads, a job opened | `torrent-view-dark.png`, `torrent-view-light.png` |
| Settings | `settings-appearance.png`, `settings-downloads-one-place.png` |
| Keyboard shortcuts | `shortcuts-editor.png` |
| Security check-up | `security-checkup.png` |
| Vertical tabs (Brave's, on our build) | `vertical-tabs.png` |
| Rebranded copy | `rebrand-patched.jpg`, `gamblide-panel.png`, `settings-menu-dark.png`, `settings-menu-light.png` |
| Colour schemes of the mark | `brand/schemes.png` (written by `branding/make_icons.py`) |
| Debloat | `debloat/new-tab-before-after.jpg`, `debloat/policy-names-brave-1.99.56.txt` |

## tools/

All start the rebranded Gamblium through the installed launcher, on a fresh folder under
temp, one window at a time (`cdp.mjs`).

- `cdp.mjs`: start, connect, close; window screenshots (`winshot.ps1`) and toolbar inventory (`uia.ps1`, `uia-act.ps1`).
- `ext.mjs`: a page of the extension at a size, with a screenshot.
- `address-check.mjs`: clean addresses and `gamblium://` names.
- `idle.mjs`: what a hidden page of ours costs.
- `look_files.py`: save and restore the helper's look files around a run.
- `real.mjs`, `verify.mjs`, `tour.mjs`, `forcedark.mjs`, `menu.mjs`: the preset checks described in `presets/README.md`.

- `pdf-viewer-layouts.png`: where the tools sit in Acrobat (from Adobe's description), Chrome, Edge and Gamblium PDF (Nov 15 2026).

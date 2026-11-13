# Features from other browsers: candidates for Gamblium

For the owner to pick from (Nov 14 2026). Each line says where the idea comes from, whether
Gamblium already has it (often through Brave/Chromium underneath), and what it would take.
Numbers are only for picking. Sources: the browsers' own pages and recent reviews (Edge,
Chrome 146, Helium, Comet), plus what is in Brave 1.99 / Chromium 157 (`docs/brave-features.md`).

Legend: **Have** = works in Gamblium today. **Switch** = in our engine, needs a setting or a
small patch. **Build** = we write it (extension, helper or Rust).

## Tabs and windows

| # | Feature | From | Status in Gamblium | What it takes |
|---|---|---|---|---|
| 1 | Vertical tabs | Edge, Chrome 146, Brave, Helium | **Switch**: Brave's vertical and tree tabs work on our build | A switch in our Settings, default off |
| 2 | Split view (two tabs side by side) | Chrome, Brave | **Have** (and our freezer keeps both halves awake, #181) | - |
| 3 | Tab search (find any open tab by typing) | Chrome, Brave | **Have** (the ⌄ at the top right) | - |
| 4 | Saved tab groups on the bookmarks bar ("Create new tab group") | Chrome | **Have** in new profiles from #208; Ctrl+Shift+B in older ones | - |
| 5 | Tab groups that fold the others away | ours | **Have** (#204) | - |
| 6 | Sleeping tabs with a chosen delay (30 s to 12 h) | Edge | **Have**, stronger: freezing plus sleep, per-site levels | - |
| 7 | Named workspaces: a set of tabs you save, close and reopen, shareable | Edge | **Build**: our Spaces plus "save and close a Space" | Medium (extension) |
| 8 | Collections: save pages, notes and pictures into named lists | Edge (being retired) | **Build** | Medium; overlaps bookmarks |
| 9 | Tab hover preview (picture and memory of a tab) | Brave, Edge | **Have** (Brave's hover card) | - |
| 10 | Close duplicate tabs | Brave, Comet (AI) | **Switch/Build**: Brave has it in the tab menu; one click in our menu | Small |
| 11 | Pinned tab groups, custom group icons | Chrome (March 2026) | Partly: Chromium 157 has the base | Check, then a switch |

## Reading and pages

| # | Feature | From | Status | What it takes |
|---|---|---|---|---|
| 12 | Full-page reading mode with read-aloud | Chrome 146, Edge (Immersive Reader) | Brave Speedreader exists but is off by policy | Turn Speedreader on, or build ours |
| 13 | **PDF editor**: highlight, notes, draw, fill forms, sign, rotate/reorder pages, save | Edge (strongest), Chrome (highlights and notes) | Reader only | **Build**: the Rust engine below |
| 14 | Web capture: a picture of an area or the whole page, then mark it up | Edge | **Have** the capture (#155-#177); markup is missing | Small: pen, arrow, box, blur on the result card |
| 15 | Translate a page | Chrome, Edge | **Have** (Brave's translate, #137) | - |
| 16 | Math solver / Lens: select an area and search it | Chrome (Lens), Edge | No | Build on our screenshot area picker |

## Privacy and control

| # | Feature | From | Status | What it takes |
|---|---|---|---|---|
| 17 | !bangs in the address bar (`!w moon` searches Wikipedia) | Helium (10,700 bangs, offline) | No | **Build**: small, offline list in the extension |
| 18 | Fingerprinting noise (canvas, audio, hardware) | Helium, Brave | **Have** (Brave's farbling) | - |
| 19 | Built-in content blocker | Helium (uBlock Origin), Brave | **Have** (Brave Shields, our Gamblide panel) | - |
| 20 | Nothing contacts the maker unless opted in; services self-hostable | Helium | Partly: telemetry off, Brave still checks updates and lists | Larger: needs a fork for some parts |
| 21 | Setup asks privacy questions on first start | Helium | Partly: our Welcome page | Add 3-4 privacy choices to Welcome |
| 22 | Containers: tabs with separate cookies in one window | Brave (switch), Firefox | **Switch**: in this Brave, not enabled | Turn on and test |

## Assistant and agents

| # | Feature | From | Status | What it takes |
|---|---|---|---|---|
| 23 | Ask about all open tabs at once (compare, summarise) | Comet | No (agents control tabs, #ctl) | Build: our agent CLI can read the tabs; a page for it |
| 24 | Group related tabs automatically by topic | Comet (AI) | Rule-based grouping is next on our list | Build (rules first, then optional AI) |
| 25 | A side panel that stays beside the page | Edge (Copilot), Chrome (AI Mode), Comet | Brave's sidebar | Our own side panel (MV3 sidePanel) |

## The PDF engine (owner, Nov 14 2026)

A PDF reader and editor of our own, in pure Rust, aiming at what Acrobat and Edge's PDF tool
do: view, search, highlight, notes, drawing, forms, signatures, page operations, save. Plan:
- Engine in Rust (parse, render, edit, write), compiled to WebAssembly so it runs inside a page
  of ours, with the helper doing heavy jobs natively (big files, saving).
- Start from proven Rust crates where they fit (for example `lopdf` for reading and writing the
  file structure); rendering is the hard part and the largest piece of work.
- Opens instead of the browser's own PDF viewer for local and downloaded files.
This is a large project (months, not days); it comes after 1.0.0.

## Order the owner set

1. 0.8.1 goes to the tester for the full checks (downloads, 45 tabs, idle).
2. Before that, the owner checks screenshots on the installed build.
3. Pen-test flow: the owner sends a sample video; we shape the pen-test features around it.
4. 1.0.0 after the tester passes; the features picked from this list and the PDF engine come after.

Sources: [Edge sleeping tabs](https://explore.microsoft.com/en-us/edge/features/sleeping-tabs),
[Edge vertical tabs](https://www.windowslatest.com/2026/04/16/microsoft-edge-is-promoting-vertical-tabs-again-now-that-google-chrome-also-has-the-feature/),
[Chrome vertical tabs and reading mode](https://blog.google/products-and-platforms/products/chrome/new-chrome-productivity-features/),
[Chrome split view and PDF notes](https://chromeunboxed.com/chromes-latest-update-brings-native-split-view-and-pdf-annotations-to-the-desktop/),
[Helium features](https://www.mintlify.com/imputnet/helium/features/overview),
[Helium review](https://techlore.tech/helium-browser-review-a-truly-minimal-privacy-focused-chromium-browser/),
[Comet features](https://levelup.gitconnected.com/perplexity-makes-comet-ai-browser-free-for-all-features-and-benefits-explained-1f357009ec65),
[Comet vs Chrome](https://www.superchargebrowser.com/library/perplexity-comet-vs-chrome-extensions.md).

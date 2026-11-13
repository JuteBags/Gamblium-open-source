# Notice: what Gamblium ships of other people's work

## Brave and Chromium (MPL-2.0, BSD-3-Clause and others)

The Gamblium installer contains a copy of the **Brave** browser's program folder (Brave
Software, Inc., https://brave.com), built from Chromium (The Chromium Authors). It is Brave's
own signed release, version in `tools/brave-version.txt`, with these changes made by
`gamblium rebrand` while the installer is built:

- **Resource packs** (`*.pak`): pictures and interface strings show Gamblium's name and mark
  instead of Brave's (`tools/rebrand/rebrand.py`).
- **`chrome.dll`** (`tools/rebrand/extra.py`), each change found by content and written in
  place, with nothing in the file moved:
  - the lion drawings replaced by Gamblium's mark;
  - the menu button's drawing, and the button itself hidden;
  - the question shown when an extension supplies the new tab page, switched off;
  - Brave's purple and lavender colours replaced by Gamblium's;
- **`brave.exe`**: its icon and the words "Brave Browser" replaced in place.

After these changes the program files no longer carry Brave's code signature. The complete
source of every change is the `tools/rebrand` folder of this repository. Brave's and Chromium's
own source code is at https://github.com/brave/brave-core, https://github.com/brave/brave-browser
and https://chromium.googlesource.com/chromium/src, under the Mozilla Public License 2.0
(https://mozilla.org/MPL/2.0/), the BSD-3-Clause licence and the other licences listed in the
browser's own `chrome://credits` page, which ships unchanged in the copy.

**Trademarks.** "Brave", the Brave lion and Brave's other marks belong to Brave Software, Inc.
Gamblium is not made, endorsed or supported by Brave Software. The copy shows Gamblium's name
and mark instead of Brave's marks; `brave://` addresses and file names inside the program
folder remain because they cannot be changed without rebuilding the browser.

## Libraries in Gamblium's own programs

The Rust programs (`gamblium.exe`, `gamblium-dl.exe`, `gamblium-app.exe`) use crates listed in
`Cargo.lock`, under their own licences (mostly MIT or Apache-2.0), among them librqbit
(Apache-2.0) for torrents and rustls for TLS.

## Gamblium

Gamblium's own code is licensed under the GNU General Public License v3.0 (`LICENSE`).

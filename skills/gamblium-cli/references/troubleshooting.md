# Troubleshooting Gamblium (for people and agents)

Start with the version: `gamblium --version` (or `gamblium-cli version`).

## Installing and removing

| Problem | Fix |
|---|---|
| Windows warns "unknown publisher" | The installer is not code-signed yet: More info > Run anyway |
| Setup says it could not set up Gamblium | Gamblium is open: close every Gamblium window (and `gamblium-cli close` every session), run setup again |
| `gamblium-cli` / `gamblium` not found | Open a new terminal (setup adds the folder to the user's PATH), or use `%LOCALAPPDATA%\Gamblium\app\gamblium-cli.exe` |
| Uninstall | Windows Settings > Apps > Installed apps > Gamblium. The person's profile (`User Data`) is kept; delete `%LOCALAPPDATA%\Gamblium` by hand to remove everything |
| Brave's lion shows instead of Gamblium's mark | Settings > Appearance > "Show Brave's own name and logo" is on, or (developer setup) the private copy is out of date after a Brave update: `gamblium rebrand` |

## Idle CPU and memory

| Problem | Fix |
|---|---|
| A hidden tab keeps running | It is playing sound, marked "Keep this tab awake", on the "Always keep these sites awake" list, or its background level is 273 K. Check the Gamblium button on the toolbar > This site, on that tab |
| A chat or mail tab misses messages while hidden | Raise "Background level for this site" (Gamblium button > This site; e.g. 137 K wakes it a few seconds every 15 min) or add it to "Always keep these sites awake" (Settings > Tabs > Freezing tabs) |
| A tab reloads when shown | It was put to sleep because memory was short. Settings > Tabs > Sleeping tabs sets when; "Keep this tab awake" exempts one tab |
| Where does the CPU go? | `gamblium stats` (whole browser by process type) or the **Tabs and memory** page (per tab: `gamblium://tabs`, the New Tab "Right now" card, or right-click > Tools) |
| Video or music in a hidden tab | Keeps playing; tabs with sound are never frozen |

## Agents and sessions

| You see | Do |
|---|---|
| `No Gamblium is running` | `gamblium-cli <name> ...` starts its own; or `gamblium launch --agent --hidden` for `gamblium ctl` |
| `the browser started but does not take commands (45 s)` | The helper is not registered: run `gamblium install` again (or reinstall), then retry |
| `the session's browser is running but does not take commands` | `gamblium-cli close <name>`, retry |
| `there is no session '<name>'` | `gamblium-cli create <name>` |
| `the session '<name>' is already there` | Send it commands; `create` is once |
| `No tab with id` | 0.7.0 only: a tab put to sleep got a new id. `tabs q=<site>` finds it. 0.7.1 keeps ids |
| `the page did not answer` | `reload tab=<id> wait=true`, retry |
| `needsPermission: true, asked: true` | The person was asked in Gamblium; wait, run again |
| `needsPermission: true, asked: false` | The person's Gamblium is not open to ask: ask them to open it |
| `needsPageAccess: true` | This is a person's profile; use a named session, or the person switches on Settings > Agents > "Let command-line agents control this profile" |
| Answer has `wall: "cloudflare"` ("Just a moment...") | An automatic check that hidden browsers never pass. `gamblium-cli set <name> window=on` (an ordinary minimised window, no focus taken), then repeat with `wait=true`; it usually passes in 5-10 s |
| Answer has another `wall` | A check for people. The person runs `gamblium-cli open <name>`, passes it, then `gamblium-cli hide <name>` |
| Sign-in lost after `close` | Before closing, prove the login (account page, or `cookies url=...`); a login made seconds before a stop may not be on disk |
| Page text empty or missing parts | `wait selector=...`, or `full-reload tab=<id>` (pictures and late scripts) |
| Clicks do nothing | `real=true`, or `click x= y=` from a `screenshot`; check `elements` that the selector is right |
| `only web addresses (http, https)` | Agents cannot open files or browser pages, by design |
| A proxy with user and password | Cannot be stored; the browser asks for it in a window |

## Downloads

| Problem | Fix |
|---|---|
| A big download went to the browser, not `gamblium-dl` | It was in a private window, a `blob:`/`data:` address, of unknown size, or our downloader got nothing in 6 s (a one-time link) and handed it back |
| Logged-in download stops after a restart | Continuable for up to a day (sealed cookie). After that start it again from the page |
| Torrent has no incoming peers | Add a Windows Firewall inbound rule for `gamblium-dl.exe` (it downloads without one, just with fewer peers) |
| Magnet links open another program | Reinstall Gamblium (it registers itself for `magnet:` for this user) |

## Private and Tor windows

The extension works there (allowed once per profile at first start). The
new tab page of a private window stays the browser's own (Gamblium's mark, no widgets). Downloads in private windows
are never handed to `gamblium-dl`.

## Reporting a problem

Give: `gamblium --version`, what you ran, the JSON answer, and for idle CPU
the output of `gamblium stats`. Never paste cookies, tokens or the files in
`%LOCALAPPDATA%\Gamblium\keys`.

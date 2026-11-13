# How Gamblium works

Use this to explain Gamblium to a person, or to reason about why a tab or
page behaves as it does.

## Parts

| Part | What it is |
|---|---|
| The browser | A private copy of the official Brave (Chromium) program, shipped inside the installer, with Gamblium's mark and name in place of Brave's lion. Same engine, same speed (Speedometer 3.1 about level with Brave and Chrome) |
| The launcher (`gamblium.exe`) | Writes the profile's settings while the browser is closed (telemetry off, Brave's extras hidden, freezing set up, theme) and starts it |
| The extension | Freezing and sleeping, Gamblium's pages (New Tab, Settings, Downloads, Sessions, Tabs and memory, Security check-up), agent commands |
| The helper | Same program, started by the browser: per-tab memory and CPU, downloads, the agent bridge, the permission prompt |
| `gamblium-cli` | Named hidden sessions for agents |
| `gamblium-dl` | Downloader for links, mirrors, torrents and magnets |
| `gamblium-app.exe` | The windowless starter behind the shortcuts and magnet links |

Everything lives in `%LOCALAPPDATA%\Gamblium` (`app`, `browser`, `User Data`
for the person's profile, `sessions`, `agent-profile`, `downloads`, `keys`).
No admin rights, nothing outside that folder except shortcuts, a PATH entry
for the user, the helper registration and the magnet-link handler.

## Gamblide

Gamblide is Gamblium's name for the protection panel behind the mark in the
address bar: Brave's Shields (ad and tracker blocking with its Rust engine,
fingerprinting protection, per-site scripts off, upgrade to HTTPS), shown
with Gamblium's mark. Per-site switches are set there by the person. Agents
get the same blocking; there is no agent command to change Gamblide.

## Idle CPU: freezing

A browser doing nothing should use close to no CPU. Gamblium freezes a tab
that has been hidden for 30 s (no JavaScript, no timers, no drawing) and
thaws it the instant it is shown again, with its page as it was (tens of
milliseconds).

Never frozen: the tab showing in each window, tabs playing sound, tabs marked
**Keep this tab awake** (right-click > This tab, or the Gamblium button on
the toolbar), sites on the **Always keep these sites awake** list (Settings >
Tabs > Freezing tabs), and tabs with an upload in flight when
upload protection is on.

**Background level, 0 to 273 K** (the Gamblium button > This site > "Background level for this site"; Settings for the rest):
0 K is frozen solid, 273 K never frozen; between, a hidden tab stays frozen
but is woken for a few seconds on a schedule (the warmer, the more often),
so mail and chat can still check in.

Measured: 45 tabs in 3 windows idle at about 2.8% of one core against
Brave's 6.5%; 9 hidden tabs about 3-4% against 16-17%.

## Memory: sleeping

Frozen tabs keep their memory. When memory runs short, Gamblium puts hidden
tabs to sleep (page dropped, place and address kept; showing it loads it
again), ranked by memory times minutes hidden, only as many as needed.
Uploads, page-made downloads and always-awake sites are never put to sleep.
Settings > Tabs > Sleeping tabs sets when.

## Privacy

Telemetry, usage pings and Brave's web discovery are off. Brave's own
update, filter-list and Safe Browsing requests still happen. Rewards,
Wallet, VPN, News, AI chat and Playlist are hidden; Tor windows are kept.
Private and Tor windows run the extension too (set up once per profile).

## Looks

Themes colour the whole browser from one seed colour (moon-dark is the
default; Settings > Appearance). Light-only websites can be made dark
(forced dark; a keep-light list for exceptions). "Show Brave's own name and
logo" in Settings > Appearance goes back to Brave's look.

## Agents' permissions

An agent may change settings or the proxy only after the person allows it
in a prompt ("ask always", 30 min, 1, 2 or 6 h, "never ask"). Reading needs
no permission. Agents cannot add hosts to the security-testing scope.

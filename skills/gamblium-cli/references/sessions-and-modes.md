# Sessions and modes

## The ways to run Gamblium

| Mode | Start | Who it is for | Agent commands |
|---|---|---|---|
| **Normal** (the person's browser) | Start menu / desktop shortcut, or `gamblium launch` | A person browsing | Off. The person can switch it on in Settings > Agents > "Let command-line agents control this profile"; cookies and real input stay off |
| **Named session** | `gamblium-cli create <name>` | Agents, scripts, repeatable jobs | All. Hidden by default; one profile folder per name under `%LOCALAPPDATA%\Gamblium\sessions` |
| **Agent profile** | `gamblium launch --agent` (window) or `--agent --hidden` | One shared agent browser, driven with `gamblium ctl` | All. Folder `%LOCALAPPDATA%\Gamblium\agent-profile`. End it with `gamblium close --agent` |
| **Pen-test profile** | `gamblium launch --pentest [--proxy ...] [--tls-keylog ...]` | Authorised security testing | See security-testing.md |
| **Test window** | `gamblium launch --user-data-dir <new temp folder> --debug-port <n>` | Developers measuring Gamblium | Debugging port allowed here only; close with `gamblium close --user-data-dir <folder>` |

### Agent mode against normal browsing

- **Separate profile.** An agent never touches the person's own logins,
  history or tabs. Sign it in to what it needs, once, in its own window.
- **More reach.** The agent copy of the extension may read every page and
  its cookies, send real mouse and keyboard input (`real=true`, through a
  debugger attached to one tab for one command and detached again), run
  `eval` on sites that forbid it, and take pictures of tabs that are not
  showing.
- **Lean when hidden.** No pictures, no web fonts, one tab at work, pages
  frozen between commands. A person's window always gets the full page.
- **No welcome page, no questions.** Agent, pen-test and test profiles skip
  Gamblium's first-start page.
- **Same browser.** Same engine, ad blocking (Gamblide) and privacy settings
  as the person's Gamblium.

### Hidden, minimised or covered

| How | What works |
|---|---|
| Hidden (no window) | Everything. Pages behave as if showing, at 1280 x 800 |
| Minimised window | Everything except animation; point clicks and pictures borrow 1280 x 800 for that one command (answer carries `viewport`) |
| Window behind others | Everything |

The browser never comes to the front or takes the keyboard, except for
`activate` and `window-focus`, whose job that is.

## Named sessions in detail (`gamblium-cli`)

```
gamblium-cli create <name> [--window] [proxy=<address>]
gamblium-cli list                          stopped, hidden or window; `applies` shows proxy etc.
gamblium-cli <name> <command> [key=value ...] [--timeout <seconds>]
gamblium-cli open <name> | hide <name>     show / take away the window (restarts the browser)
gamblium-cli open-url <name> <address>     show the session on one address
gamblium-cli set <name> proxy=<address>|none
gamblium-cli set <name> images=on|off      pictures and web fonts while hidden
gamblium-cli set <name> keep-tabs=on|off   on: opening a page does not put the previous one to sleep
gamblium-cli set <name> window=on|off     on: an ordinary browser window, minimised, across restarts (sites whose automatic check refuses hidden browsers)
gamblium-cli close <name>                  stop; logins and tabs kept
gamblium-cli delete <name>                 stop and delete the folder (logins gone)
```

Names: letters, digits, `-` and `_`, at most 40, not a command word.

- **Load, then stop.** About 1.5 s after a page in a hidden session has
  loaded, it is frozen. Each command thaws it, acts, and it is frozen again.
  `wait` keeps it awake while it waits; `full-reload` leaves it running
  until your next command.
- **One tab at work.** `open` in front puts the tab that was showing to
  sleep. Add `keep=true` to that `open`, or `set <name> keep-tabs=on`.
- **Tab ids.** From 0.7.1 the id `open` returns is the tab's id for its whole
  life: through sleep (where the browser itself renumbers tabs), wake,
  reload and navigation; from 0.7.2 also through `open`, `hide`, `set` and
  stops, which restart the browser. `tabs` lists tabs under those ids. A sleeping tab
  wakes on the last page it was on.
- **Restarts.** A session started again brings its tabs back asleep; a
  command for one wakes only that one.
- **Proxy with a name and password** cannot be stored; the browser asks for
  it, which needs a window.
- **Extensions** installed in a session's window exist in that session only.

## `gamblium ctl` on a running browser

`gamblium ctl <command> key=value ...` talks to whichever Gamblium is
running. With more than one, add `--profile agent`, `--profile main`, a
browser process id, or part of the profile folder's path; `gamblium ctl
list` shows them. On the person's own profile, commands work only after
the person switches on Settings > Agents > "Let command-line agents control this profile"; settings changes always need their
yes.

How a command travels: CLI -> helper (127.0.0.1, random token in a file only
this Windows user can read) -> Gamblium extension -> browser. Nothing listens
on the network, and no debugger stays attached.

## Checkpoints (save and restore windows)

`session-save name=<n> [closeAfter=true]`, `session-restore name=<n>`,
`session-list`, `session-export name=<n> out=<file.json>`,
`session-import file=<file.json>`. Different from named sessions: a
checkpoint is a list of windows and tabs inside one profile; a named session
is a whole profile.

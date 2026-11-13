---
name: gamblium-cli
description: Drive the Gamblium browser from the command line and help people use it. Use whenever a task needs a real browser (open and read pages, fill forms, click, screenshots, logged-in sites, downloads, request capture, security checks on hosts you are authorised to test), when the user mentions Gamblium, gamblium-cli, gamblium ctl, gamblium-dl, Gamblide, named or hidden browser sessions, or asks how to install, fix or tune Gamblium (idle CPU, memory, frozen or sleeping tabs, downloads, torrents, magnet links, themes, private windows).
---

# Gamblium from the command line

Gamblium is a lean desktop browser for Windows, built on Brave (Chromium). It
uses close to no CPU when idle, sleeps and freezes tabs nobody is looking at,
and lets agents and scripts drive it **without a debugger and without a
window**. Two programs matter to you:

- `gamblium-cli`: **named sessions**, each its own browser profile that runs
  hidden. This is what an agent should use almost always.
- `gamblium ctl`: the same commands for a browser that is already running
  (the person's own Gamblium, or `gamblium launch --agent`).

Both answer in JSON with `"ok": true|false` and exit 1 when `ok` is false.

## Before you start

1. `gamblium-cli version`. Not found: Gamblium is not installed, or the
   terminal was opened before it was. Tell the person to install it
   (`Gamblium-Setup-<version>.exe` from the project's releases, no admin
   rights) and open a new terminal. The programs live in
   `%LOCALAPPDATA%\Gamblium\app`, so `"%LOCALAPPDATA%\Gamblium\app\gamblium-cli.exe"`
   works by full path too.
2. Pick a session name for the job (`research`, `shop-check`, `qa`...). Reuse
   the same name to keep logins between jobs.

## The five-line workflow

```
gamblium-cli create work                                  # new hidden session (once)
gamblium-cli work open url=https://example.com wait=true  # -> {"ok":true,"tab":{"id":123,...}}
gamblium-cli work text max=4000                           # read the page
gamblium-cli work click text="More information"           # act
gamblium-cli close work                                   # stop; logins and tabs are kept
```

A stopped session starts by itself, hidden, when you send it a command.
`gamblium-cli <name> help` lists every command with its arguments;
[references/commands.md](references/commands.md) is the same list with notes.

## Why Gamblium and not a plain browser or Playwright

| What you get | Why it matters to an agent |
|---|---|
| No debugger attached | Sites see an ordinary browser; tabs still sleep and freeze; no "being debugged" bar |
| No window needed | Works while the person uses their machine; never steals focus or the keyboard |
| Load, then stop | A hidden page is frozen once it has loaded; nothing runs or redraws between your commands, so 9 tabs idle at about 2% of one core |
| Lean pages | Hidden sessions skip pictures and web fonts: an 8-site job peaked at about 630 MB instead of 1.2 GB |
| Real logins | A session keeps its cookies on disk like a normal profile; the person can sign in once in a window |
| One tab id for life | The id `open` returns stays valid through sleep, wake and navigation (0.7.1 and later) |
| Real input when needed | `real=true` sends input a page cannot tell from a person's |
| Fast downloads | `gamblium-dl` splits downloads, follows mirrors, resumes, does torrents and magnets, and keeps logins (sealed cookies) |

## Rules that keep you out of trouble

- **Work hidden.** A window is for a person: to look, to sign in, or to pass
  a CAPTCHA. Show it with `gamblium-cli open <name>`, then `hide <name>`.
  Both restart the browser (logins stay, tabs come back, page memory is lost).
- **Never disguise the browser or solve a check for people** (CAPTCHA,
  checkbox, pictures, "verify you are human"). The answer then carries
  `"wall"` and a `hint`. Two cases:
  - **Automatic check** (`wall: "cloudflare"`, "Just a moment...", no
    puzzle): hidden browsers never pass it. **Best: set the session to a
    window before the first visit** to a site that checks (`gamblium-cli
    set <name> window=on`, then `open ... wait=true`): it then runs as an
    ordinary browser window, minimised, never taking focus, and the check
    passes by itself in about 6 s. Costs a little: about +5% CPU per task and
    +100 MB. If the site was already tried hidden, switching afterwards is
    slower and may not pass within 30 s: switch, then open the address in a
    new tab, and if it is still the check, hand it to the person.
  - **A check that wants a click or a picture:** a person's job. Ask them to
    `gamblium-cli open <name>`, pass it, and tell you; then `hide`.
- **Never type a person's password.** Ask them to sign in in the session's
  window. After a sign-in, prove it held (open an account page and read it,
  or `cookies url=...`) before `close` or `hide`.
- **Keep the tab id `open` gave you** and pass `tab=<id>` on every page
  command. Without `tab=` a command goes to the tab that is showing, which
  changes when you open another one.
- **Read before you act.** `forms`, `elements selector=...`, `find text=...`
  and `links` give you selectors; then `click`, `type`, `select`, `check`.
  Prefer these over `eval`.
- **Wait for things, not for time.** `open ... wait=true`, `navigate ...
  wait=true`, `wait selector=... ms=15000`, `wait-load`. No `sleep 5`.
- **Settings and proxy changes need the person's yes.** `settings-set` and
  `proxy-set` answer `needsPermission: true` and ask them inside Gamblium
  ("like UAC"). Tell the person, wait, run again. Never work around it.
- **Security tools only for authorised targets.** `audit`, `scan` and `cve`
  check scope; there is deliberately no command to add to it. If a target
  is refused, the person must add it to their scope file.
- **Agents open web addresses only** (http, https, about:blank). `file:` and
  browser pages are refused on purpose.
- **Close what you started.** `gamblium-cli close <name>` at the end of a
  job; `delete <name>` only for throwaway sessions (it deletes the logins).

## Sessions, tabs and states

A hidden session keeps **one tab at work**: `open url=...` puts the tab that
was showing to sleep (its memory freed). It keeps its place and its id; any
command naming it wakes it on the page it was left on.

| `tabs` shows | Meaning | What to do |
|---|---|---|
| `awake` | page loaded and running | nothing |
| `frozen` | loaded, paused between your commands | nothing: your next command wakes it |
| `asleep` | no page in memory | nothing: a command for it reloads it first (a few seconds) |

- Many tabs at once (compare 5 products): `open ... keep=true` on each, or
  `gamblium-cli set <name> keep-tabs=on`. Costs memory.
- A page needs pictures or late content: `full-reload tab=<id>` (pictures on,
  left running until your next command), or `set <name> images=on`.
- Background tab without switching: `open url=... background=true`.
- Several sessions run side by side; each has its own logins, proxy
  (`set <name> proxy=socks5://127.0.0.1:9050` or `none`) and extensions.

Details, the difference between agent mode and normal browsing, and
`gamblium ctl` on a running browser: [references/sessions-and-modes.md](references/sessions-and-modes.md).

## Recipes

Search and read:
```
gamblium-cli s open url=https://duckduckgo.com wait=true
gamblium-cli s type selector="input[name=q]" text="rust tcp listener" submit=true
gamblium-cli s wait selector="article" ms=15000
gamblium-cli s text max=4000
```

Fill an unknown form:
```
gamblium-cli s forms                       # every field with a selector and label
gamblium-cli s type tab=12 selector="#email" text="me@example.com"
gamblium-cli s select tab=12 selector="#country" value="India"
gamblium-cli s check tab=12 selector="#terms"
gamblium-cli s click tab=12 text="Sign up"
```

A site that ignores script clicks: add `real=true` to `click`, `type`,
`press`, or use `mouse x= y= action=click`.

Picture: `gamblium-cli s screenshot tab=12 full=true out=page.png`.

What did the page request? `capture-start`, act, `capture-list errors=true`,
`capture-get id=<n>` (headers and a ready curl command), `capture-stop`.

Download: `gamblium-cli s download url=https://example.com/f.zip wait=true`,
or straight from a terminal: `gamblium-dl <url> -d <folder>`. Torrents,
magnets, mirrors, logged-in files: [references/downloads.md](references/downloads.md).

Free memory and come back later: `session-save name=research closeAfter=true`,
later `session-restore name=research`.

## When something goes wrong

| You see | Do |
|---|---|
| `No Gamblium is running` (from `gamblium ctl`) | Use `gamblium-cli <name> ...` (starts by itself), or `gamblium launch --agent --hidden` |
| `there is no session 'x'` | `gamblium-cli create x` |
| `the session's browser is running but does not take commands` | `gamblium-cli close x`, then retry |
| `No tab with id` | On 0.7.0 a slept tab got a new id: `tabs q=<site>` to find it. Fixed in 0.7.1 |
| `the page did not answer` | `reload tab=<id> wait=true`, then retry |
| `needsPermission: true` | The person was asked in Gamblium; wait for their answer, run again |
| `needsPageAccess` | You are on a person's profile, not an agent one: use `gamblium-cli` |
| `wall: "cloudflare"` in the answer | `gamblium-cli set <name> window=on`, repeat with `wait=true` (see rules) |
| another `wall` | A check for people: hand it to the person (see rules) |
| Text is empty or partial | `wait selector=...` or `full-reload tab=<id>`; some content needs pictures or scripts that run late |

For people using Gamblium itself (installing, idle CPU, tabs that froze,
downloads, themes, private windows, uninstalling):
[references/troubleshooting.md](references/troubleshooting.md).
What Gamblium is made of (Gamblide, freezing, background level, sleeping,
rebranded Brave, privacy): [references/how-gamblium-works.md](references/how-gamblium-works.md).
Security testing (pen-test profile, proxy, TLS keys, audit, scan, CVE):
[references/security-testing.md](references/security-testing.md).

# Controlling Gamblium from the command line

For AI agents and scripts. `gamblium ctl` sends one command to a running
Gamblium and prints the answer as JSON.

```
gamblium launch --agent                       # start the agent profile
gamblium ctl open url=https://example.com wait=true
gamblium ctl text max=2000
gamblium ctl click text="More information"
gamblium ctl screenshot out=page.png
```

## How it works

```
gamblium ctl  ->  helper (local, token-protected)  ->  Gamblium extension  ->  browser
```

- **No debugger is held.** Commands go through the extension, so tabs still
  freeze and sleep as usual and no "being debugged" banner appears. Only the
  `real=true` commands of the agent profile attach one, to one tab, for the
  length of that one command.
- **Never in front.** No command needs the window to be showing, apart from
  `activate` and `window-focus`, whose job is to show it. See
  [Working in the background](#working-in-the-background).
- **Only on this machine.** The helper listens on 127.0.0.1 and needs a random
  token stored in your user folder.
- **On by default only in the agent profile** (`gamblium launch --agent`), which
  is a separate browser profile with its own logins. On any other profile the
  owner must switch it on in the Gamblium popup.

## Conventions

- **Form:** `gamblium ctl <command> key=value key=value ...`. Quote values with
  spaces: `text="hello world"`.
- **Answer:** JSON on stdout. Every answer has `"ok": true` or
  `"ok": false, "error": "..."`. The exit code is 0 for ok and 1 otherwise.
- **Which tab:** page commands take `tab=<id>` (ids come from `tabs` or `open`).
  Without it they use the tab that is showing in the window used last.
- **Lists:** `tabs=12,15,19`, `pids=4400,4412`, `bypass=localhost,10.0.0.1`.
- **Files:** `out=<file>` saves a screenshot (PNG) or a result (JSON) to a file
  instead of printing it. `file=<file>` reads one (session import).
- **Timeout:** `--timeout <seconds>` (default 30) is how long the command waits
  for the browser. Page commands give up after 10 seconds on a page that does
  not answer.
- **More than one Gamblium running:** add `--profile agent`, `--profile main`,
  a browser process id, or part of the profile folder's path.
  `gamblium ctl list` shows what is running.

## Working in the background

An agent does not need a window on screen. Three ways, from least to most hidden:

| How | Start it with | What works |
|---|---|---|
| Window covered by other windows | `gamblium launch --agent` | Everything. |
| Window minimised | `gamblium launch --agent`, then `gamblium ctl window-set window=<id> state=minimized` | Everything except animation: a minimised page does not redraw, so wait for content with `wait`, not for an animation to finish. |
| No window at all | `gamblium launch --agent --hidden` | Everything. Pages behave as if they were showing. End it with `gamblium close --agent`. |

In all three the browser never takes the keyboard or comes to the front.

- **By element:** `click selector=...`, `type`, `press`, `select`, `check`,
  `hover` work on any tab, showing or not.
- **By point:** `click x=<px> y=<px>` clicks whatever is at that point of the
  visible page, measured from its top left.
- **Real mouse and keyboard** (agent profile): add `real=true` to `click`,
  `type` or `press`, or use `mouse x= y= action=click|double|right|move|down|up`.
  The page sees input it cannot tell from a person's. Use it when a site
  ignores script-made clicks.
- **JavaScript:** `eval code=...` returns the value of the code. In the agent
  profile it also runs on sites that forbid `eval`, and with `real=true` it
  waits for a promise.
- **Pictures:** `screenshot` works on a tab that is not showing; `full=true`
  takes the whole page (agent profile).

A minimised window gives its page no area at all, so for point clicks and
pictures Gamblium lends the page a size of 1280 x 800 for the length of that
one command. The answer then carries a `viewport` note, and points are
measured in that size.

```
gamblium launch --agent --hidden
gamblium ctl open url=https://example.com wait=true
gamblium ctl click text="More information" real=true
gamblium ctl eval code="document.title"
gamblium ctl screenshot full=true out=page.png
gamblium close --agent
```

## What an agent can and cannot do

- **Sleeping and frozen tabs.** A sleeping tab has no page: `reload` or
  `activate` it first. A page frozen in the background may not answer; `activate`
  it. The agent profile uses the performance preset, so its tabs are not frozen.
- **Clicks and keys are made by script unless you add `real=true`.** Most
  sites accept script-made input; a few check for real input, which only the
  agent profile can send.
- **`eval` runs in the page.** Outside the agent profile it fails on sites
  whose security policy forbids `eval`. Prefer `text`, `elements`, `forms`,
  `click` and `type` where they do the job.
- **Screenshots** outside the agent profile show the visible part of the page
  and switch that window to the tab first (the window itself is not brought
  forward).
- **Security tools obey the scope rule.** `audit` and `scan` work on this
  machine and network, and on hosts the owner has listed in the scope file.
  An agent can read the scope (`scope-list`, `scope-check`) but cannot add to
  it: there is deliberately no command for that. If a target is refused, ask
  the owner to add it.
- **Only web addresses.** `open`, `navigate` and `window-open` take http and
  https addresses (and `about:blank`). Files on this computer and the
  browser's own pages are refused.
- **Cookies** can be read and set only in the agent profile.
- **Not available:** response bodies of captured requests (use a proxy with
  `gamblium launch --pentest --proxy ...`), a tab's back/forward list, the
  browser's own settings pages, file uploads, and anything in another profile.

## Recipes

Search and read:
```
gamblium ctl open url=https://duckduckgo.com wait=true
gamblium ctl type selector="input[name=q]" text="rust tcp listener" submit=true
gamblium ctl wait selector="article" ms=15000
gamblium ctl text max=4000
```

Fill a form you do not know yet:
```
gamblium ctl forms                      # every field with a selector and its label
gamblium ctl type selector="#email" text="me@example.com"
gamblium ctl select selector="#country" value="India"
gamblium ctl check selector="#terms"
gamblium ctl click text="Sign up"
```

Download a file and wait for it:
```
gamblium ctl download url=https://example.com/report.pdf wait=true
gamblium ctl downloads limit=5
```

Record what a page requests:
```
gamblium ctl capture-start
gamblium ctl navigate url=https://example.com wait=true
gamblium ctl capture-list errors=true
gamblium ctl capture-get id=<request id>   # full headers and a curl command
gamblium ctl capture-stop
```

Check a site you are authorised to test:
```
gamblium ctl scope-check host=staging.example.com
gamblium ctl audit url=https://staging.example.com/ cve=true
gamblium ctl scan target=staging.example.com ports=80,443,8080
```

Free memory, then come back later:
```
gamblium ctl session-save name="research" closeAfter=true
gamblium ctl session-restore name="research"
```

## Named sessions: `gamblium-cli`

`gamblium install` puts a second program beside `gamblium.exe` and the
folder on your PATH, so `gamblium-cli` works in any terminal opened
afterwards. It keeps named browser sessions that work with no window:

```
gamblium-cli create work                 a new session; it starts hidden
gamblium-cli work open url=https://example.com wait=true
gamblium-cli work text                   every command below works by name
gamblium-cli work screenshot out=page.png
gamblium-cli open work                   show the session in a window
gamblium-cli hide work                   take the window away, keep working
gamblium-cli list                        every session: stopped, hidden or window
gamblium-cli set work proxy=socks5://127.0.0.1:9050   (or proxy=none)
gamblium-cli close work                  stop it; logins and tabs are kept
gamblium-cli delete work                 stop it and delete its folder
```

- A session is a profile folder of its own (`Gamblium\sessions\<name>`
  under LOCALAPPDATA), started as an agent profile. Several run side by side.
- **Work hidden.** Everything except a CAPTCHA or a sign-in a person must
  do works with no window: reading, filling and sending forms, clicks,
  pictures of the page. Use `open` only to show something to a person, and
  `hide` again afterwards.
- **Before `close` or `hide` after signing in, make sure the login holds.**
  A hidden session is stopped, not closed, so a login made in the last
  seconds may not be on disk yet. Wait a little, then prove it: open a page
  that only works signed in (the account or inbox page) and read it, or
  look for the site's login cookie with `cookies url=<address>`. Close only
  after that.
- **Load, then stop.** In a hidden session a page is frozen as soon as it
  has loaded and settled. Every command wakes it, acts, and it is frozen
  again, so nothing runs, animates or is drawn between commands (`tabs`
  shows it as "frozen"; that is normal). What you read is the bare page:
  text and structure, no pictures. When a page needs everything a person
  would get (pictures, late content), `full-reload [tab=<id>]` loads it
  again with pictures on and leaves it running until your next command.
  `wait selector=...` keeps the page awake while it waits.
- **A hidden session is lean.** Pictures and web fonts are not loaded (an
  agent reads text and structure, which are untouched); `set work
  images=on` brings them back, and a session shown in a window always has
  them. One tab is at work: `open url=...` puts the tab that was showing to
  sleep; it keeps its place and a command for it wakes it. Add `keep=true`
  to one `open`, or `set work keep-tabs=on`, to leave it awake.
- A stopped session starts by itself, hidden, when a command is sent to it.
- When a session starts, its tabs come back asleep: nothing is loaded and
  they use no memory or CPU. A command for a tab (`text tab=<id>`, `click`,
  `screenshot` ...) wakes that one tab and waits for its page; the others
  stay asleep. `sleep tab=<id>` puts one back.
- A session brings its own environment every time it is used: its logins,
  the extensions installed in its window (they exist in that session only)
  and its proxy (`create work proxy=...` or `set`). `list` shows it under
  `applies`. A proxy that needs a name and password cannot be stored.
- `open` and `hide` stop the browser and start it again, because a running
  browser cannot be given a window. Logins stay; the open tabs are written
  down and opened again; what a page held in memory is lost.
- A hidden page is 1280 x 800.
- Answers are JSON and the exit code is 1 when `ok` is false, as with
  `gamblium ctl`.

## Changing settings needs the user's permission

`settings-set` and `proxy-set` answer `{ "ok": false, "needsPermission": true }`
until the user allows them. The first try puts a question in the user's own
Gamblium (`asked: true`; if it is not open, `asked: false`: ask them to open
it). They choose: not now, 30 minutes, 1, 2 or 6 hours, or never ask again.
Run the command again after they answer. The permission is one for this
Windows user and holds for every agent profile and named session. Reading
settings (`settings`, `proxy`) needs none.

<!-- commands:start (generated by tools/gen-agent-docs.mjs from extension/agent.js; do not edit by hand) -->
## Command reference

87 commands. `gamblium ctl help` prints the same list as JSON.

### The browser

| Command | Arguments | What it does |
|---|---|---|
| `help` |  | this list |
| `info` |  | versions, profile, what this profile lets an agent do |
| `lean` | `[on=false]` | pictures off for every page of this profile (set by hidden named sessions) |

### Tabs

| Command | Arguments | What it does |
|---|---|---|
| `tabs` | `[q=<text>]` | every tab (or those whose title or address contains q); state is awake, frozen or asleep |
| `open` | `url=<address> [background=true] [wait=true] [window=<id>]` | open a tab |
| `close` | `tab=<id> \| tabs=<id,id,...>` | close tabs |
| `activate` | `tab=<id>` | show a tab and bring its window forward |
| `navigate` | `[tab=<id>] url=<address> [wait=true]` | go to an address in a tab |
| `reload` | `[tab=<id>] [wait=true]` | reload; also wakes a sleeping tab |
| `full-reload` | `[tab=<id>]` | load the page again as a person would get it: pictures on, left running until the next command (an agent's page is bare and stopped by default) |
| `back` | `[tab=<id>]` | history back |
| `forward` | `[tab=<id>]` | history forward |
| `duplicate` | `[tab=<id>]` | open a copy of a tab |
| `pin` | `[tab=<id>] [on=false]` | pin or unpin |
| `mute` | `[tab=<id>] [on=false]` | mute or unmute |
| `move` | `tab=<id> [index=<n>] [window=<id>]` | move a tab |
| `zoom` | `[tab=<id>] [factor=<1.25>]` | read or set the zoom |
| `group` | `tabs=<id,id,...> [title=<name>] [color=<blue>]` | put tabs in a group |
| `ungroup` | `tabs=<id,id,...>` | take tabs out of their group |
| `sleep` | `tab=<id> \| tabs=<id,id,...>` | put tabs to sleep (frees their memory) |
| `sleep-others` |  | put every hidden tab to sleep now |
| `tab-ids-adopt` | `pairs=<old:new,...>` | after a restart, tabs answer to the ids they had before (gamblium-cli does this by itself) |

### Windows

| Command | Arguments | What it does |
|---|---|---|
| `windows` |  | every window with position, size and state |
| `window-open` | `[url=<address>] [left= top= width= height=]` | open a window |
| `window-close` | `window=<id>` | close a window |
| `window-focus` | `window=<id>` | bring a window forward |
| `window-set` | `window=<id> [left= top= width= height=] [state=normal\|maximized\|minimized\|fullscreen]` | move, resize or change state |

### Reading a page

| Command | Arguments | What it does |
|---|---|---|
| `page` | `[tab=<id>]` | address, title, load state, scroll position, counts of links and forms |
| `text` | `[tab=<id>] [selector=<css>] [max=<chars>]` | visible text of the page or of one element |
| `html` | `[tab=<id>] [selector=<css>] [max=<chars>]` | HTML of the page or of one element |
| `links` | `[tab=<id>] [max=<count>]` | links on the page |
| `elements` | `[tab=<id>] selector=<css> [max=<count>]` | matching elements with text, attributes and a selector for each |
| `forms` | `[tab=<id>]` | every form field with its label, type, value and a selector |
| `find` | `[tab=<id>] text=<text> [max=<count>]` | elements whose own text contains the text |
| `attr` | `[tab=<id>] selector=<css> name=<attribute>` | one attribute of one element |
| `storage` | `[tab=<id>] [kind=local\|session]` | the page's localStorage or sessionStorage |
| `screenshot` | `[tab=<id>] [full=true] [out=<file.png>]` | picture of the visible part of the page, or of all of it; in the agent profile the tab need not be showing |

### Acting on a page

| Command | Arguments | What it does |
|---|---|---|
| `click` | `[tab=<id>] selector=<css> \| text=<visible text> \| x=<px> y=<px> [real=true]` | click an element or a point of the page |
| `mouse` | `[tab=<id>] x=<px> y=<px> [action=click\|double\|right\|move\|down\|up]` | real mouse input at a point of the page (agent profile) |
| `type` | `[tab=<id>] selector=<css> text=<what to type> [submit=true] [real=true]` | fill a field |
| `press` | `[tab=<id>] key=<Enter\|Tab\|Escape\|ArrowDown\|a...> [selector=<css>] [real=true]` | send a key to an element or the focused one |
| `select` | `[tab=<id>] selector=<css> value=<option value or label>` | choose an option in a select |
| `check` | `[tab=<id>] selector=<css> [on=false]` | tick or untick a checkbox or radio |
| `hover` | `[tab=<id>] selector=<css>` | move the pointer over an element |
| `focus` | `[tab=<id>] selector=<css>` | focus an element |
| `submit` | `[tab=<id>] selector=<css>` | submit the form the element belongs to |
| `scroll` | `[tab=<id>] y=<pixels> \| by=<pixels> \| selector=<css> \| to=bottom\|top` | scroll the page |
| `wait` | `[tab=<id>] selector=<css> \| text=<text> [gone=true] [ms=<timeout>]` | wait until something appears (or is gone) |
| `wait-load` | `[tab=<id>] [ms=<timeout>]` | wait until the tab has finished loading |
| `eval` | `[tab=<id>] code=<javascript> [real=true]` | run code in the page and return its value; in the agent profile it also works on sites that forbid eval and waits for promises |

### Downloads

| Command | Arguments | What it does |
|---|---|---|
| `downloads` | `[limit=<n>] [state=in_progress\|complete\|interrupted]` | the download list |
| `download` | `url=<address> [filename=<relative path>] [wait=true]` | start a download |
| `download-wait` | `id=<download id> [ms=<timeout>]` | wait until a download finishes |
| `download-pause` | `id=<download id>` | pause |
| `download-resume` | `id=<download id>` | resume |
| `download-cancel` | `id=<download id>` | cancel |
| `download-erase` | `id=<download id>` | remove from the list (the file stays) |
| `download-delete` | `id=<download id>` | delete the downloaded file from disk and from the list |
| `download-rules` | `[enabled=true\|false]` | read the folder rules, or switch them on or off |

### Network capture

| Command | Arguments | What it does |
|---|---|---|
| `capture-start` |  | start recording requests (address, method, headers, status, timing) |
| `capture-stop` |  | stop recording |
| `capture-status` |  | is it recording, how many requests are kept |
| `capture-list` | `[q=<text>] [method=GET] [status=4] [errors=true] [tab=<id>] [limit=<n>]` | recorded requests, newest first |
| `capture-get` | `id=<request id>` | one request in full, with headers and a curl command |
| `capture-clear` |  | forget the recorded requests |

### Security tools

| Command | Arguments | What it does |
|---|---|---|
| `scope-list` |  | what the user has authorised for testing |
| `scope-check` | `host=<host>` | is this host in scope (own machine, own network, or listed) |
| `audit` | `url=<address> [cve=true]` | passive check of a page's security headers, cookies and CORS |
| `scan` | `target=<host> [ports=80,443,8000-8100]` | TCP port scan |
| `cve` | `product=<name> version=<version>` | known vulnerabilities for a software version |

### Settings

| Command | Arguments | What it does |
|---|---|---|
| `settings` |  | Gamblium's settings in this profile |
| `settings-set` | `<key>=<value> ...` | change settings: enabled, delaySec, lowMemoryDelaySec, lowMemoryMb, allowlist, lightSites, routingEnabled, profileLabel |
| `proxy` |  | the profile's proxy setting |
| `proxy-set` | `mode=direct\|system\|fixed [scheme=http\|https\|socks4\|socks5 host= port=] [bypass=<host,host>]` | change the proxy |

### Memory and CPU

| Command | Arguments | What it does |
|---|---|---|
| `stats` |  | memory and CPU per tab and per process type |
| `freeze` | `pids=<pid,pid,...>` | suspend page processes (experiment) |
| `thaw` | `pids=<pid,pid,...>` | resume suspended page processes |
| `trim` | `pids=<pid,pid,...>` | move page processes' memory out of RAM (experiment) |

### Sessions (checkpoints)

| Command | Arguments | What it does |
|---|---|---|
| `session-list` |  | saved checkpoints |
| `session-save` | `name=<name> [closeAfter=true] [withPages=false]` | save every window as a checkpoint |
| `session-restore` | `name=<name> [withSettings=true]` | reopen a checkpoint |
| `session-delete` | `name=<name>` | delete a checkpoint |
| `session-export` | `name=<name> [out=<file.json>]` | the checkpoint as JSON |
| `session-import` | `file=<file.json>` | add a checkpoint from a file |

### Cookies

| Command | Arguments | What it does |
|---|---|---|
| `cookies` | `url=<address> \| domain=<domain>` | cookies for a site (agent profile only) |
| `cookie-set` | `url=<address> name=<name> value=<value> [path= secure=true httpOnly=true]` | set a cookie (agent profile only) |
| `cookie-remove` | `url=<address> name=<name>` | remove a cookie (agent profile only) |
<!-- commands:end -->

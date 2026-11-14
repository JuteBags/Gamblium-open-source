# Downloads: `gamblium-dl`

Gamblium has its own downloader for ordinary links, torrents and magnet links.
It runs as its own program, so a download outlives the browser.

## From a terminal

```
gamblium-dl https://example.com/big.iso -d D:\Downloads
gamblium-dl https://mirror-a/f.iso https://mirror-b/f.iso      # same file, several sources
gamblium-dl "magnet:?xt=urn:btih:..." -d D:\Downloads
gamblium-dl https://example.com/f.torrent --seed-minutes 30
gamblium-dl <url> --json                                         # one JSON progress object per line
gamblium-dl <url> -H "Cookie: a=b" -H "Referer: https://site/"  # by hand; the browser does this for you
```

| Option | Meaning |
|---|---|
| `-d`, `-o` | folder, file name |
| `-x <n>` | most connections (default 16) |
| `--start-connections <n>` | connections at once (default: what this server came to last time, else 1) |
| `--give-up-after <s>` | give up after this long with no byte at all (default 60) |
| `--seed-minutes <n>` | torrents: share this long after finishing (default 0) |
| `--no-web-seed` | torrents: peers only |
| `-q`, `--json` | quiet, machine-readable |

How it behaves:
- Starts with one connection and doubles while doubling makes it at least
  8% faster (when 2k does not pay, k + k/2 is tried); a server that answers
  429 or 503 gets fewer. A try that did not pay is made again after 30 s,
  then 1, 2, 4 and 8 minutes, sooner when the speed drops by a quarter.
- The count each server came to is kept (`Gamblium\downloads\servers.json`);
  the next download starts there, a new server of a known site starts at that
  site's, any other at the count most servers came to.
- Every address of a server is tried at once and the first to answer is used,
  so a dead address costs nothing.
- Follows redirects itself: a login cookie goes only to the host it belongs
  to. A signed address (GitHub, Drive, S3) that runs out is fetched again
  from the link that led to it, also in the middle of a download.
- With several addresses, each piece goes to the source that is fastest per
  connection; a slow piece is taken over.
- **Resume:** an interrupted download keeps `name.part` and
  `name.part.state`; the same command continues it.
- Torrents (librqbit): a torrent's web address ("web seed") is used first and
  left for the peers when it is slow; every piece is checked. Incoming peers
  need a Windows Firewall rule for `gamblium-dl.exe`; it works without one.
- Measured: level with aria2 on fast mirrors and magnets; about 6x Brave's
  own downloader on a server that is slow per connection.

## From the browser

Every download goes to `gamblium-dl` (Settings > "Gamblium's downloader":
every download / none), private windows too. It is taken while the browser
is still choosing the file's name, so the browser never shows it; Gamblium's
own card shows instead (top right of the page, about 8 s: progress, Pause,
Show in folder, All downloads). Only `blob:` and `data:` addresses stay with
the browser. The file goes to the profile's download folder; agents'
sessions save to `Downloads\Gamblium agents\<session>`.

- **Logged-in downloads** (Drive-like sites): the extension passes the
  cookies of each host on the way (the link's and the file's), the browser's
  User-Agent and the referer; each host gets only its own.
- The cookie of an unfinished logged-in download is kept **sealed**
  (XChaCha20-Poly1305 with a key made on this machine and wrapped by Windows
  for this user; bound to that download, site and expiry; at most one day;
  deleted when done). It never appears on a command line or in plain text.
- If our downloader gets nothing within 6 s (a one-time link, a login it
  cannot use), the download goes back to the browser.
- Private windows: their own cookie store; the job is taken off the list once finished.
- A `.torrent` the browser saves starts by itself; a magnet link or a link to
  a `.torrent` starts from the right-click menu. Magnet links clicked anywhere
  in Windows open in Gamblium (`gamblium install` registers it and gives the
  old handler back on uninstall).

## From an agent

```
gamblium-cli s download url=https://example.com/report.pdf wait=true
gamblium-cli s downloads limit=5
gamblium-cli s download-wait id=<id> ms=600000
```
The answer's `id` is Gamblium's (16 hex characters) and `engine` is
`gamblium`; only a `blob:` / `data:` address goes to the browser (`engine:
"browser"`, a number id). Also `download-pause`, `download-resume`,
`download-cancel`, `download-erase` (list only), `download-delete` (the file
too), all with either kind of id. A file behind the session's login
downloads with that login.

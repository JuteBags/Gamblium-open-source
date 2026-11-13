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
| `--start-connections <n>` | connections at once (default 1; the browser asks for 4) |
| `--give-up-after <s>` | give up after this long with no byte at all (default 60) |
| `--seed-minutes <n>` | torrents: share this long after finishing (default 0) |
| `--no-web-seed` | torrents: peers only |
| `-q`, `--json` | quiet, machine-readable |

How it behaves:
- Starts with one connection and doubles while doubling makes it at least
  8% faster; a server that answers 429 or 503 gets fewer. A fast server stays
  on one connection; one that is slow per connection gets up to 16.
- With several addresses, each piece goes to the source that is fastest per
  connection; a slow piece is taken over.
- **Resume:** an interrupted download keeps `name.part` and
  `name.part.state`; the same command continues it.
- Torrents (librqbit): a torrent's web address ("web seed") is used first and
  left for the peers when it is slow; every piece is checked. Incoming peers
  need a Windows Firewall rule for `gamblium-dl.exe`; it works without one.
- Measured: level with aria2 on fast mirrors and magnets; about 6x Brave's
  own downloader on a server that is slow per connection.

## From the browser (hand-over)

Files of 64 MB or more (Settings > "Gamblium's downloader": big files only / every download / none, and
the size) are handed from the browser to `gamblium-dl`, and the browser's
own copy is cancelled. The Downloads page lists both kinds.

- **Logged-in downloads** (Drive-like sites): the extension passes the
  site's cookies, the browser's User-Agent and the referer. Such a download
  does not follow redirects to another site.
- The cookie of an unfinished logged-in download is kept **sealed**
  (XChaCha20-Poly1305 with a key made on this machine and wrapped by Windows
  for this user; bound to that download, site and expiry; at most one day;
  deleted when done). It never appears on a command line or in plain text.
- If our downloader gets nothing within 6 s (a one-time link, a login it
  cannot use), the download goes back to the browser.
- Not handed over: private windows, `blob:` and `data:` addresses, files of
  unknown size.
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
Also `download-pause`, `download-resume`, `download-cancel`,
`download-erase` (list only), `download-delete` (the file too). A file behind
the session's login downloads with that login.

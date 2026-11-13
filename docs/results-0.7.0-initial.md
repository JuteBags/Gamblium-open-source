# Gamblium vs Brave: initial results (for 0.7.0, Nov 13 2026)

Owner's laptop: Windows 11, i5-12450H (4P + 4E cores, 12 threads), 16 GB, on mains power.
Brave 1.99.56/57 (Chromium 157). CPU is % of one core. Sources: tester session and backend session runs.
Most rows are 1–3 runs, so read differences under ~10% as a tie.

## Idle (nothing playing)

| Test | Gamblium | Brave | Result |
|---|---|---|---|
| 9 hidden tabs, settled | 3.4–4.2% CPU, ~1.5 GB | 16.4–17.7% CPU, ~1.6 GB | **~4x less CPU** |
| 9 hidden tabs, memory short (tabs put to sleep) | 2.0–2.7% CPU, ~0.49 GB | 16.4–17.7% CPU, ~1.6 GB | **~7x less CPU, ~3x less RAM** |
| 45 tabs / 3 windows, idle at 2 / 4 / 5 min | 6.6 / 1.3 / 3.4% | 31.3 / 16.5 / 16.2% | **~5x less CPU** |
| 45 tabs: private memory at 5 min | 4.53 GB | 5.74 GB | **-1.2 GB** |
| 45 tabs: processes | 55 | 79 | **-24** |
| 45 tabs: graphics process at idle | 0.0–2% | 5–6% (Brave's own tab freezing on) | lower |
| Hidden agent session, 0–7 pages | 1.65–2.55% | n/a | |

## Loading 45 tabs (3 windows)

| Test | Gamblium | Brave | Result |
|---|---|---|---|
| CPU over first 120 s (3 rotated sets) | 295.5 core-s | 298.6 core-s | tie |
| Same, with hidden tabs loading 3 at a time | 230–271 core-s | 294 core-s | **-8 to -22%** |
| CPU peak (2 s samples) | 670–900% | ~1020% | **lower peak** |
| Peak private memory (load queue on) | 5.3 GB | 6.3 GB | **-1 GB** |
| Front tab LCP (apple.com/in) | 2.3–3.8 s | 2.7–3.6 s | tie (no slowdown) |

## Speed and downloads

| Test | Gamblium | Comparison | Result |
|---|---|---|---|
| Speedometer 3.1 | ~22–24 | Brave ~22–24, Chrome ~24.9 | tie |
| Logged-in download (Drive-like site) | 8.57 MiB/s | Brave 0.83 / 2.59 / 5.04 MiB/s | **1.7–10x faster** |
| HTTP download, 421 MiB, 16-conn mirror | 8.58 MiB/s | aria2 8.83 MiB/s | tie |
| Slow-per-connection mirror (JAIST) | 1.46 MiB/s | aria2 1.31 MiB/s | tie / slightly ahead |
| Server slow per connection, from the browser | 6.6 MiB/s (hand-over) | Brave 1 connection ~1 MiB/s | **~6x** |
| .torrent (with web seed), 421 MiB | 53.8 s | aria2 51.7 s | tie |
| Magnet link, 421 MiB | 168 s | aria2 162 s | tie |

## Agents (hidden, `gamblium-cli`)

| Test | Before | Now |
|---|---|---|
| 8-site agent job, memory peak | 1222 MB | 610–645 MB |
| Idle after the job | 8.7% | 1.65–2.55% |

## Known open issues at 0.7.0

- With the hidden-tab load queue on, a hidden tab sometimes reports itself visible and keeps drawing (seen on twitch, producthunt): costs a few % idle. Queue off by default until fixed (`loadAtOnce`).
- Speedometer not yet re-measured on a quiet machine with today's build.
- Brave comparisons above come from different builds of the night (each row from one build); a full side-by-side rerun on 0.7.0 is next.

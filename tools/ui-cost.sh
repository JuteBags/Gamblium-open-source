#!/usr/bin/env bash
# UI cost: what the extension's interface costs in idle CPU and memory, one build against another.
#
# Each side gets one fresh test window (installed gamblium.exe, the rebranded browser), six real
# sites behind New Tab in front (the page people look at most), 60 s to settle, then CPU and
# memory over 60 s. Then the same with a website in front. The two sides run one after the other
# on the same machine; run on mains power with nothing else busy.
#
# Usage: tools/ui-cost.sh <checkout-A> <checkout-B> [label-A] [label-B]
#   A checkout is a folder holding extension/ and presets/ (GAMBLIUM_HOME), e.g. a worktree of the
#   last release and the main checkout. Every UI pull request reports this table.
#
# Noise: a fresh profile spends its first minutes fetching Brave's components (filter lists,
# unzip service: seen in a trace), so one run differs by up to ~1.5 % of a core either way.
# Run it twice and report both. Nov 14 2026, v0.7.1 against main, two runs:
#   New Tab in front: 3.51 / 4.84 and 3.80 / 2.44; a website: 1.12 / 0.94 and 2.08 / 3.61;
#   memory main 22-45 MB lower with New Tab in front. No difference beyond the noise.
set -u
A=$1; B=$2; LA=${3:-A}; LB=${4:-B}
G="$LOCALAPPDATA/Gamblium/app/gamblium.exe"
SITES="https://en.wikipedia.org/wiki/Web_browser https://github.com/trending https://news.ycombinator.com https://developer.mozilla.org/en-US/ https://www.bbc.com/news https://docs.python.org/3/"
OUT=$(mktemp -d)

run() { # label home port front
  local label=$1 home=$2 port=$3 front=$4
  local dir; dir=$(cygpath -w "${TEMP:-/tmp}")\\gcost-$label-$front-$RANDOM
  GAMBLIUM_HOME="$(cygpath -w "$home")" "$G" launch --user-data-dir "$dir" --debug-port "$port" >/dev/null 2>&1
  trap '"$G" close --user-data-dir "$dir" >/dev/null 2>&1; sleep 3; rm -rf "$(cygpath -u "$dir")"' RETURN
  sleep 8
  for u in $SITES; do curl -s -X PUT "http://127.0.0.1:$port/json/new?$u" >/dev/null; sleep 1; done
  local url="chrome://newtab/"; [ "$front" = site ] && url="https://example.com/"
  local id; id=$(curl -s -X PUT "http://127.0.0.1:$port/json/new?$url" | python -c "import json,sys;print(json.load(sys.stdin)['id'])")
  curl -s "http://127.0.0.1:$port/json/activate/$id" >/dev/null
  sleep 60
  "$G" stats --marker "gcost-$label-$front" --duration 60 --interval 5 --json > "$OUT/$label-$front.json"
}

for front in newtab site; do
  run "$LA" "$A" 9611 "$front"
  run "$LB" "$B" 9612 "$front"
done

python - "$OUT" "$LA" "$LB" <<'PY'
import json, sys, os
out, la, lb = sys.argv[1:]
def row(label, front):
    d = json.load(open(os.path.join(out, f"{label}-{front}.json")))
    t, k = d["total"], d.get("by_kind", {})
    g = sum(v.get("cpu_pct", 0.0) for n, v in k.items() if "gpu" in n)
    b = k.get("browser", {}).get("cpu_pct", 0.0)
    return t["cpu_pct"], b, g, t["private_ws_mb"], t["commit_mb"]
print("| In front | Build | CPU (% of one core) | browser | graphics | private MB | commit MB |")
print("|---|---|---|---|---|---|---|")
for front in ("newtab", "site"):
    for label in (la, lb):
        c, b, g, p, m = row(label, front)
        print(f"| {'New Tab' if front == 'newtab' else 'a website'} | {label} | {c:.2f} | {b:.2f} | {g:.2f} | {p:.0f} | {m:.0f} |")
PY
rm -rf "$OUT"

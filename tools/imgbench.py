"""How much memory do oversized images cost in Brave?

Shows the same 12 pictures at 200 x 150 CSS px in a visible tab, once from
4000 x 3000 files and once from 400 x 300 files, per format, and reads the
browser's memory with `gamblium stats`. If the browser decoded at display size
the two would cost about the same. Fully decoded, 12 images of 4000 x 3000 are
12 x 48 MB = 576 MB.

    python tools/imgbench.py            # all cases, about 4 minutes
    python tools/imgbench.py big-jpg    # one case
    python tools/imgbench.py --peak     # highest memory seen during page load

Everything runs on a throwaway profile under target/imgbench.
"""

import json
import random
import shutil
import subprocess
import sys
import time
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
WORK = ROOT / "target" / "imgbench"
GAMBLIUM = ROOT / "target" / "release" / "gamblium.exe"
N = 12
BIG = (4000, 3000)
SMALL = (400, 300)
FORMATS = {"jpg": dict(format="JPEG", quality=85), "png": dict(format="PNG", compress_level=1),
           "webp": dict(format="WEBP", quality=80, method=0)}
SETTLE_SEC = (15, 40)  # read memory at these times after launch
PEAK = "--peak" in sys.argv  # instead: highest memory seen while the page loads
PEAK_SEC = 12


def make_images():
    """12 different smooth pictures, saved big and small in every format."""
    img_dir = WORK / "img"
    if (img_dir / "done").exists():
        return
    img_dir.mkdir(parents=True, exist_ok=True)
    rng = random.Random(7)
    for i in range(N):
        seed = Image.new("RGB", (40, 30))
        seed.putdata([(rng.randrange(256), rng.randrange(256), rng.randrange(256)) for _ in range(40 * 30)])
        big = seed.resize(BIG, Image.BICUBIC)
        small = big.resize(SMALL, Image.LANCZOS)
        for ext, opts in FORMATS.items():
            big.save(img_dir / f"big-{i}.{ext}", **opts)
            small.save(img_dir / f"small-{i}.{ext}", **opts)
    (img_dir / "done").write_text("ok")


def make_page(case):
    """case: blank, or <big|small>-<ext>."""
    imgs = ""
    if case != "blank":
        size, ext = case.split("-")
        imgs = "\n".join(f'<img src="img/{size}-{i}.{ext}" width="200" height="150">' for i in range(N))
    page = WORK / f"{case}.html"
    page.write_text(
        f"<!doctype html><meta charset=utf-8><title>{case}</title>"
        f"<style>body{{margin:8px;background:#fff}}img{{margin:4px}}</style>\n{imgs}\n",
        encoding="utf-8",
    )
    return page


def stats(marker):
    out = subprocess.run([str(GAMBLIUM), "stats", "--marker", marker, "--duration", "0", "--json", "--top", "60"],
                         capture_output=True, text=True)
    return json.loads(out.stdout) if out.returncode == 0 else None


def run_case(case):
    marker = f"imgbench-prof-{case}"
    prof = WORK / marker
    shutil.rmtree(prof, ignore_errors=True)
    page = make_page(case)
    subprocess.run([str(GAMBLIUM), "launch", "--preset", "performance", "--no-extension", "--user-data-dir", str(prof),
                    "--", "--window-size=1300,1000", page.as_uri()], capture_output=True, text=True, check=True)
    rows = []
    started = time.time()
    try:
        if PEAK:
            # Poll as fast as we can while the page loads: decoding can need far
            # more memory for a moment than the page keeps afterwards.
            peak_private = peak_commit = 0
            while time.time() - started < PEAK_SEC:
                r = stats(marker)
                if r:
                    peak_private = max(peak_private, round(r["total"]["private_ws_mb"]))
                    peak_commit = max(peak_commit, round(r["total"]["commit_mb"]))
                time.sleep(0.15)
            rows.append(dict(case=case, peak_within_sec=PEAK_SEC, peak_total_private_mb=peak_private,
                             peak_total_commit_mb=peak_commit))
            print(json.dumps(rows[-1]), flush=True)
            return rows
        for at in SETTLE_SEC:
            time.sleep(max(0, at - (time.time() - started)))
            r = stats(marker)
            if not r:
                raise RuntimeError("browser not found")
            kinds = r["by_kind"]
            rows.append(dict(
                case=case, at_sec=at,
                total_private_mb=round(r["total"]["private_ws_mb"]), total_commit_mb=round(r["total"]["commit_mb"]),
                renderer_private_mb=round(kinds.get("renderer", {}).get("private_ws_mb", 0)),
                gpu_private_mb=round(kinds.get("gpu", {}).get("private_ws_mb", 0)),
                renderer_commit_mb=round(kinds.get("renderer", {}).get("commit_mb", 0)),
                gpu_commit_mb=round(kinds.get("gpu", {}).get("commit_mb", 0)),
            ))
            print(json.dumps(rows[-1]), flush=True)
    finally:
        r = stats(marker)
        if r:
            pid = next(t["pid"] for t in r["top"] if t["kind"] == "browser")
            subprocess.run(["taskkill", "/T", "/F", "/PID", str(pid)], capture_output=True)
        time.sleep(1.5)
        shutil.rmtree(prof, ignore_errors=True)
    return rows


def main():
    WORK.mkdir(parents=True, exist_ok=True)
    make_images()
    sizes = {ext: round(sum((WORK / "img" / f"big-{i}.{ext}").stat().st_size for i in range(N)) / 1e6, 1) for ext in FORMATS}
    print("file size of the 12 big images, MB:", sizes, flush=True)
    cases = [a for a in sys.argv[1:] if not a.startswith("--")] or ["blank", "small-jpg", "big-jpg", "big-png", "big-webp"]
    rows = []
    for case in cases:
        rows += run_case(case)
    with open(WORK / "results.jsonl", "a", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row) + "\n")


if __name__ == "__main__":
    main()

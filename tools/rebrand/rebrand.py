"""Puts Gamblium's mark and name into a COPY of Brave's program folder.

    python rebrand.py <folder> [--branding DIR] [--name NAME] [--locales en-US,en-GB|all]
                               [--check] [--undo] [--json]

<folder> is a copy of Brave's version folder (the one that holds resources.pak),
or a folder with exactly one such folder inside. The installed Brave is refused.
See README.md for what is written and for the exit codes.
"""
import argparse
import colorsys
import gzip
import hashlib
import io
import json
import os
import re
import sys
import time
import zipfile
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
import lion as L  # noqa: E402
import pak as P  # noqa: E402

VERSION = 1
STAMP = "gamblium-rebrand.json"
UNDO = "gamblium-rebrand-undo.zip"
IMAGE_PACKS = ("chrome_100_percent.pak", "chrome_200_percent.pak", "brave_100_percent.pak", "brave_200_percent.pak", "resources.pak", "brave_resources.pak")

OK, FAILED, REFUSED, NOTHING_FOUND = 0, 1, 2, 3
# The lion is narrower than its box; a disc filling the same box would look larger than the lion did.
ROOM = 0.92

# "Brave" stays when one of these words follows: Brave's own services and company,
# its other release channels, and names Brave's build made by renaming Google's.
KEEP_BEFORE = (
    "Search Software Rewards Wallet VPN News Talk Leo Ads Origin Sync Shields AI Account Premium Translate "
    "Ocelot Authors Terms Verified Community Firewall API DNS Beta Dev Nightly Canary Enterprise Root Webstore "
    "Doc Docs Sheet Sheets Slides Forms Sites Keep Calendar Maps Workspace Drawings Jamboard Advanced Dashboard"
).split()
_BRAVE = re.compile(r"(?<![\w./@-])Brave(?![\w/@]|\.\w)(?!\s+(?:" + "|".join(KEEP_BEFORE) + r")\b)")
_LEGAL = re.compile(r"copyright|licen[sc]e", re.I)

# The empty address bar names no search engine (owner, Nov 13 2026: "Search Brave or type a URL" in
# private and Tor windows, whose engine is Brave Search; normal windows said "Search Google ...").
# Whole strings, matched exactly as Brave ships them in English; the engines themselves are unchanged.
ENGINE_FREE = {
    b"Search $1 or type a URL": b"Search the web or type a URL",
    b"Search Brave or type a URL": b"Search the web or type a URL",
    b"Search with Brave or type a URL": b"Search the web or type a URL",
}
# Brave's title case where our interface writes sentence case (critique, Nov 13 2026: the Gamblide panel's
# "Global Settings"). Whole strings, matched exactly in English.
WORDING = {
    b"Global Settings": b"Global settings",
    b"Private Window": b"Private window",  # the private page's badge and note
    b"Private Window with Tor connectivity": b"Private window with Tor",
    b"Browsing History": b"Browsing history",  # Appearance > autocomplete suggestions
    b"Recent download history": b"Recent downloads",  # the download bubble's title
    # The empty bookmarks bar's standing hint and link (owner, Nov 14 2026: "what is this, and no way
    # to close it"). Empty: the bar shows only the tab-groups button and any bookmarks.
    "For quick access, place your bookmarks here on the bookmarks bar.".encode(): b"",
    "Import bookmarks now…".encode(): b"",
    # The private New Tab's note: 50 words in a card (owner's Rule 11, Nov 13 2026: help is one short line).
    b"Brave never remembers what you do in a Private Window. Sites you visit won't show up in your history. "
    b"Cookies, form data, and site data vanish once you close all open private windows. Note that your activity "
    b"could still be visible to your internet service provider, passive network observers, or your employer "
    b"(if you're using a work machine or network).":
        b"Nothing is kept once you close it; your network can still see where you go.",
}
# Phrases inside longer strings, in sentence case; the browser's name is changed after these.
PHRASES = (
    (b"in a Private Window.", b"in a private window."),
    (b"from Private Windows.", b"from private windows."),
    ("Private Windows don’t".encode(), "Private windows don’t".encode()),
)
# The private New Tab's other note and the Tor window's note, one line each (Rule 11), in the words of the
# long private note's line in WORDING. Matched by their first sentence: en-US and en-GB differ after it.
SHORT_NOTES = (
    ("Brave doesn’t remember what you do in a Private Window.".encode(), b"Nothing is kept once you close it; your network can still see where you go."),
    (b"Brave doesn't remember what you do in a Private Window.", b"Nothing is kept once you close it; your network can still see where you go."),
    (b"Brave doesn't store browsing activity from ", b"Nothing is kept once you close it, and sites don't see your IP address. If your safety depends on staying anonymous, use Tor Browser."),
)


class Refused(Exception):
    pass


def rename(text, name):
    """The browser's name in one interface string. Legal text and very long strings are left alone."""
    if "Brave" not in text or len(text) > 3000 or _LEGAL.search(text):
        return text
    return _BRAVE.sub(name, text)


# ---- our art ---------------------------------------------------------------------

class Branding:
    """Everything comes from one folder (the repository's branding/), so a new logo is a new set of
    files there and a rerun."""

    def __init__(self, folder):
        self.dir = Path(folder)
        need = ["gamblium-mark.svg", "gamblium-mark-small.svg", "gamblium-lockup-dark.svg", "gamblium-lockup-light.svg", "png/lockup-dark.png", "png/lockup-light.png"]
        missing = [n for n in need if not (self.dir / n).is_file()]
        self.sizes = sorted(int(m.group(1)) for f in (self.dir / "png").glob("gamblium-*.png") if (m := re.fullmatch(r"gamblium-(\d+)\.png", f.name)))
        if missing or not self.sizes:
            raise Refused(f"branding folder {self.dir} is missing {', '.join(missing) or 'png/gamblium-<size>.png'}")
        self.svg = {n: (self.dir / f"gamblium-{n}.svg").read_text(encoding="utf8") for n in ("mark", "mark-small", "lockup-dark", "lockup-light")}
        skin = self.dir / "skin.css"
        self.skin = skin.read_text(encoding="utf8") if skin.is_file() else None
        panel = self.dir / "gamblide-panel.css"
        self.panel = panel.read_text(encoding="utf8") if panel.is_file() else ""
        mono = self.dir / "gamblium-mark-mono.svg"
        self.svg_mono = mono.read_text(encoding="utf8") if mono.is_file() else None
        self.lockup_png = {n: Image.open(self.dir / "png" / f"lockup-{n}.png").convert("RGBA") for n in ("dark", "light")}
        # Which lockup has the light letters (the one made for dark surfaces)? Measured, not assumed from the name.
        tone = {n: _tone(im, (im.width // 3, 0, im.width, im.height)) for n, im in self.lockup_png.items()}
        self.light_letters = max(tone, key=tone.get)
        self.dark_letters = min(tone, key=tone.get)
        h = hashlib.sha256()
        for f in sorted(p for p in self.dir.rglob("*") if p.is_file() and p.suffix in (".svg", ".png", ".css")):
            h.update(f.relative_to(self.dir).as_posix().encode())
            h.update(f.read_bytes())
        self.digest = h.hexdigest()[:16]

    def mark_png(self, side):
        n = next((s for s in self.sizes if s >= side), self.sizes[-1])
        im = Image.open(self.dir / "png" / f"gamblium-{n}.png").convert("RGBA")
        return im if im.size == (side, side) else im.resize((side, side), Image.LANCZOS)

    def lockup_for(self, letters_are_light):
        return self.light_letters if letters_are_light else self.dark_letters


def _tone(im, box):
    """Mean lightness (0..255) of the visible pixels in a box of an RGBA image."""
    px = [p for p in im.crop(tuple(int(v) for v in box)).getdata() if p[3] >= 128]
    return sum(0.299 * r + 0.587 * g + 0.114 * b for r, g, b, _ in px) / len(px) if px else 0.0


def _is_grey(im, box):
    px = [p for p in im.crop(box).getdata() if p[3] >= 128]
    if not px:
        return False
    return sum(colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)[1] for r, g, b, _ in px) / len(px) < 0.12


def _png_bytes(im):
    out = io.BytesIO()
    im.save(out, format="PNG", optimize=True)
    return out.getvalue()


# ---- PNG -------------------------------------------------------------------------

def patch_png(found, art):
    """-> (new PNG bytes, what was done)."""
    im = found["image"].copy()
    W, H = im.size
    x0, y0, x1, y1 = found["box"]
    if found["word"] >= L.WORD_MATCH and found["rest"] and x0 <= 0.1 * W:
        light = _tone(im, found["rest"]) > 128
        lock = art.lockup_png[art.lockup_for(light)].copy()
        lock.thumbnail((W, H), Image.LANCZOS)
        canvas = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        canvas.alpha_composite(lock, (0, (H - lock.height) // 2))
        return _png_bytes(canvas), "lockup"
    grey = _is_grey(im, found["box"])
    opaque = [p[3] for p in im.crop(found["box"]).getdata() if p[3] >= 128]
    strength = (sum(opaque) / len(opaque) / 255) if opaque else 1.0
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    side = int(min(max(x1 - x0, y1 - y0), 2 * min(cx, W - cx), 2 * min(cy, H - cy)))
    if side > 24:
        side = round(side * ROOM)  # small icons keep every pixel; they are drawn for their exact size
    mark = art.mark_png(side)
    if grey:
        a = mark.getchannel("A")
        mark = mark.convert("L").convert("RGBA")
        mark.putalpha(a)
    if strength < 0.97:
        mark.putalpha(mark.getchannel("A").point(lambda v: int(v * strength)))
    im.paste((0, 0, 0, 0), (x0, y0, x1, y1))
    im.alpha_composite(mark, (int(round(cx - side / 2)), int(round(cy - side / 2))))
    return _png_bytes(im), "grey mark" if grey else "mark"


# ---- SVG -------------------------------------------------------------------------

_ROOT = re.compile(r"<svg\b[^>]*>", re.S)
_HEX = re.compile(r"""\bfill\s*=\s*["'](#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?)["']""")
_DEFINITIONS = ("defs", "clipPath", "mask", "symbol", "pattern", "marker")


def nested(svg, x, y, w, h, tag, align="xMidYMid"):
    """Our SVG as an element placed at a box of the host drawing."""
    m = _ROOT.search(svg)
    root = re.sub(r"""\s(?:width|height|x|y|role|aria-label|preserveAspectRatio)\s*=\s*(["']).*?\1""", "", m.group(0))
    root = root[:-1] + f' x="{x:.4g}" y="{y:.4g}" width="{w:.4g}" height="{h:.4g}" preserveAspectRatio="{align} meet" data-gamblium="{tag}">'
    body = svg[m.end():svg.rindex("</svg>")]
    return root + body.strip() + "</svg>"


def mono_mark(svg, colour):
    """The mark as one flat colour, without its disc: for places that use the icon as a stencil."""
    m = _ROOT.search(svg)
    vb = re.search(r"""viewBox\s*=\s*["']([^"']+)""", m.group(0))
    size = max(float(v) for v in vb.group(1).replace(",", " ").split()[2:]) if vb else 0

    def drop_disc(c):
        r = re.search(r"""\br\s*=\s*["']([\d.]+)""", c.group(0))
        return "" if r and size and float(r.group(1)) >= 0.44 * size else c.group(0)

    out = re.sub(r"<circle\b[^>]*/>", drop_disc, svg, count=1)
    return re.sub(r"""\b(fill|stroke)\s*=\s*(["'])#[0-9a-fA-F]{3,8}\2""", lambda c: f'{c.group(1)}="{colour}"', out)


def _rgb(hex_colour):
    h = hex_colour.lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def _luminance(hex_colour):
    r, g, b = _rgb(hex_colour)
    return 0.299 * r + 0.587 * g + 0.114 * b


def _saturation(hex_colour):
    return colorsys.rgb_to_hsv(*(v / 255 for v in _rgb(hex_colour)))[1]


def _view(text, found):
    m = _ROOT.search(text)
    root = m.group(0) if m else ""
    vb = re.search(r"""viewBox\s*=\s*["']([^"']+)""", root)
    if vb:
        v = [float(n) for n in vb.group(1).replace(",", " ").split()]
        if len(v) == 4:
            return v
    w = re.search(r"""\bwidth\s*=\s*["']([\d.]+)""", root)
    h = re.search(r"""\bheight\s*=\s*["']([\d.]+)""", root)
    if w and h:
        return [0.0, 0.0, float(w.group(1)), float(h.group(1))]
    box = found["box"]
    rest = found["rest"] or box
    return [0.0, 0.0, max(box[2], rest[2]), max(box[3], rest[3])]


def patch_svg(text, found, art):
    """-> (new SVG text, what was done), or (None, why not)."""
    m = _ROOT.search(text)
    if not m or "</svg>" not in text:
        return None, "no svg root"
    vx, vy, vw, vh = _view(text, found)
    x0, y0, x1, y1 = found["box"]
    if found["word"] >= L.WORD_MATCH and found["rest"] and x0 - vx <= 0.1 * vw:
        fills = [f for s, e, b in found["others"] if b[0] >= x1 for f in _HEX.findall(text[s:e])]
        light = bool(fills) and sum(_luminance(f) for f in fills) / len(fills) > 128
        ours = nested(art.svg[f"lockup-{art.lockup_for(light)}"], vx, vy, vw, vh, "lockup", "xMinYMid")
        return text[:m.end()] + ours + "</svg>", "lockup"
    first = min(s for s, _ in found["parts"])
    before = text[:first]
    for tag in _DEFINITIONS:
        if len(re.findall(rf"<{tag}\b(?![^>]*/>)", before)) > before.count(f"</{tag}>"):
            return None, f"lion sits inside <{tag}>"
    lion_text = "".join(text[s:e] for s, e in found["parts"])
    fills = _HEX.findall(lion_text)
    coloured = "url(" in lion_text or any(_saturation(f) > 0.25 for f in fills)
    side = max(x1 - x0, y1 - y0) * ROOM
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    if coloured:
        ours, what = art.svg["mark-small" if max(vw, vh) <= 32 else "mark"], "mark"
    else:
        colour = fills[0] if fills else "currentColor"
        ours, what = art.svg_mono or mono_mark(art.svg["mark-small" if max(vw, vh) <= 32 else "mark"], colour), "one-colour mark"
    out = text
    for s, e in sorted(found["parts"], reverse=True):
        out = out[:s] + out[e:]
    return out[:first] + nested(ours, cx - side / 2, cy - side / 2, side, side, "mark") + out[first:], what


# ---- Brave's own pages -----------------------------------------------------------

SKIN_MARK = "/* Gamblium skin."
PANEL_STYLE = (
    "html, body { background: var(--leo-color-page-background) !important; color: var(--leo-color-text-primary); }"
    " body { border-radius: 18px; }"
)


def panel_page(page, css=""):
    """The Shields panel's page with our styles at the end of its own <style>: the ground
    always, and branding/gamblide-panel.css (shape, depth, type) when that file exists."""
    return page.replace("</style>", PANEL_STYLE + "\n" + css + " </style>", 1)


def is_token_sheet(text):
    """Brave's shared stylesheet of design tokens: hundreds of --leo-color-* definitions, plain CSS."""
    return text.lstrip().startswith("/*") and text.count("--leo-color-") > 200 and ":root" in text[:400]


def is_shields_panel(text):
    return "<title>Shields Panel</title>" in text and "</style>" in text


# ---- the folder ------------------------------------------------------------------

def find_version_folder(folder):
    folder = Path(folder)
    if not folder.is_dir():
        raise Refused(f"{folder} is not a folder")
    if (folder / "resources.pak").is_file():
        return folder
    inside = [d for d in folder.iterdir() if d.is_dir() and (d / "resources.pak").is_file()]
    if len(inside) != 1:
        raise Refused(f"{folder} holds no resources.pak, and not exactly one folder that does")
    return inside[0]


def refuse_installed(folder):
    real = str(folder.resolve()).lower()
    for var in ("ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"):
        base = os.environ.get(var)
        if base and real.startswith(str(Path(base).resolve()).lower()):
            raise Refused(f"{folder} is under {base}: this tool only changes a private copy, never the installed Brave")
    if "bravesoftware" in real and "program files" in real:
        raise Refused(f"{folder} looks like the installed Brave")


def write_atomic(path, data):
    tmp = path.with_name(path.name + ".gamblium-tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)


def load_undo(ver):
    """-> {pack path relative to the folder: {id: original bytes}} from an earlier run."""
    originals = {}
    path = ver / UNDO
    if path.is_file():
        with zipfile.ZipFile(path) as z:
            for name in z.namelist():
                rel, rid = name.rsplit("/", 1)
                originals.setdefault(rel, {})[int(rid)] = z.read(name)
    return originals


def run(folder, branding, name="Gamblium", locales=("en-US", "en-GB"), check=False, undo=False, log=print):
    """Does the work. -> (exit code, report dict)."""
    ver = find_version_folder(folder)
    refuse_installed(ver)
    art = None if undo else Branding(branding)
    originals = load_undo(ver)
    report = dict(tool=VERSION, folder=str(ver), brave=ver.name, name=name, branding=art.digest if art else None, images={}, left_alone={}, strings={}, seconds=0)
    started = time.time()
    packs = [n for n in IMAGE_PACKS if (ver / n).is_file()]
    loc_dir = ver / "Locales"
    if loc_dir.is_dir():
        wanted = sorted(p.stem for p in loc_dir.glob("*.pak")) if "all" in locales else [x for x in locales if (loc_dir / f"{x}.pak").is_file()]
        packs += [f"Locales/{x}.pak" for x in wanted]
    new_files, images_done, strings_done = {}, 0, 0
    for rel in packs:
        path = ver / rel
        try:
            pk = P.read(path)
        except Exception as e:  # an unknown pack format: stop before anything is written
            raise Refused(f"cannot read {rel}: {e}") from e
        before = dict(pk["res"])
        pk["res"].update(originals.get(rel, {}))  # start from Brave's own content, also on a rerun
        clean = dict(pk["res"])
        if not undo:
            if rel.startswith("Locales/"):
                n = 0
                for rid, raw in clean.items() if pk["encoding"] == 1 else ():  # 1 = UTF-8, the only kind Brave ships
                    plain = ENGINE_FREE.get(raw)
                    if plain is not None:
                        pk["res"][rid] = plain
                        n += 1
                        report.setdefault("address bar", []).append(f"{rel}:{rid}")
                        continue
                    worded = WORDING[raw] if raw in WORDING else next((new for old, new in SHORT_NOTES if raw.startswith(old)), None)
                    if worded is not None:
                        pk["res"][rid] = worded
                        n += 1
                        report.setdefault("wording", []).append(f"{rel}:{rid}")
                        continue
                    phrased = raw
                    for old, new in PHRASES:
                        phrased = phrased.replace(old, new)
                    if phrased != raw:
                        report.setdefault("wording", []).append(f"{rel}:{rid}")
                    if b"Brave" not in phrased or P.kind(phrased) != "other":
                        if phrased != raw:
                            pk["res"][rid] = phrased
                            n += 1
                        continue
                    try:
                        text = phrased.decode("utf8")
                    except UnicodeDecodeError:
                        continue
                    changed = rename(text, name)
                    if changed != raw.decode("utf8", "replace"):
                        pk["res"][rid] = changed.encode("utf8")
                        n += 1
                report["strings"][rel] = n
                strings_done += n
            else:
                done, alone = {}, {}
                for rid, raw in clean.items():
                    kind = P.kind(raw)
                    if kind == "png":
                        try:
                            found = L.find_in_png(raw)
                        except Exception:  # noqa: BLE001  an image Pillow cannot open is not ours to judge
                            continue
                        if not found:
                            continue
                        if found["near"]:
                            alone[rid] = "lion outline, but not its face"
                            continue
                        pk["res"][rid], done[rid] = patch_png(found, art)
                    elif kind == "gzip" and len(raw) < 120_000:
                        body = P.inflate(raw)
                        if P.kind(body) != "svg":
                            if art.skin and len(body) < 400_000:
                                page = body.decode("utf8", "replace")
                                if is_token_sheet(page):
                                    pk["res"][rid], done[rid] = gzip.compress((page + "\n" + art.skin).encode("utf8"), mtime=0), "skin on Brave's colour tokens"
                                elif is_shields_panel(page):
                                    pk["res"][rid], done[rid] = gzip.compress(panel_page(page, art.panel).encode("utf8"), mtime=0), "Shields panel in our look" if art.panel else "Shields panel background"
                            continue
                        text = body.decode("utf8", "replace")
                        found = L.find_in_svg(text)
                        if not found:
                            continue
                        if found["near"]:
                            alone[rid] = "lion outline, but not its detail"
                            continue
                        new, what = patch_svg(text, found, art)
                        if new is None:
                            alone[rid] = what
                            continue
                        pk["res"][rid], done[rid] = gzip.compress(new.encode("utf8"), mtime=0), what
                report["images"][rel] = done
                if alone:
                    report["left_alone"][rel] = alone
                images_done += len(done)
        changed_ids = [rid for rid in pk["res"] if pk["res"][rid] != clean[rid]]
        for rid in changed_ids:
            originals.setdefault(rel, {})[rid] = clean[rid]
        if pk["res"] != before:
            new_files[rel] = P.to_bytes(pk)
        log(f"{rel}: {len(changed_ids)} changed" if not undo else f"{rel}: {'restored' if rel in new_files else 'untouched'}")
    report["seconds"] = round(time.time() - started, 1)
    report["images_changed"], report["strings_changed"] = images_done, strings_done
    if not undo and images_done == 0:
        log("No lion found in any pack. Brave's art may have changed; nothing was written.")
        return NOTHING_FOUND, report
    if check:
        log(f"check only: would change {images_done} images and {strings_done} strings; nothing was written")
        return OK, report
    if undo:
        for rel, data in new_files.items():
            write_atomic(ver / rel, data)
        for leftover in (ver / STAMP, ver / UNDO):
            leftover.unlink(missing_ok=True)
        log("Brave's own images and strings are back.")
        return OK, report
    # The undo file goes first: if anything after it fails, a rerun still starts from Brave's own content.
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for rel in sorted(originals):
            for rid in sorted(originals[rel]):
                z.writestr(f"{rel}/{rid}", originals[rel][rid])
    write_atomic(ver / UNDO, buf.getvalue())
    for rel, data in new_files.items():
        write_atomic(ver / rel, data)
    report["written"] = sorted(new_files)
    report["when"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    write_atomic(ver / STAMP, json.dumps(report, indent=1).encode("utf8"))
    log(f"{images_done} images and {strings_done} strings changed in {ver}")
    log(f"address bar: names no search engine in {len(report.get('address bar', []))} string(s)")
    log(f"wording: {len(report.get('wording', []))} string(s) in sentence case")
    return OK, report


def main(argv=None):
    ap = argparse.ArgumentParser(description="Gamblium's mark and name in a copy of Brave's program folder.")
    ap.add_argument("folder")
    ap.add_argument("--branding", default=str(Path(__file__).resolve().parents[2] / "branding"), help="folder with the mark and lockup (default: the repository's branding/)")
    ap.add_argument("--name", default="Gamblium", help="the browser's name in interface strings")
    ap.add_argument("--locales", default="en-US,en-GB", help="comma-separated locale packs to rename in, or all")
    ap.add_argument("--check", action="store_true", help="report what would change; write nothing")
    ap.add_argument("--undo", action="store_true", help="put Brave's own images and strings back")
    ap.add_argument("--json", action="store_true", help="print the report as one JSON object on stdout")
    a = ap.parse_args(argv)
    log = (lambda *x: print(*x, file=sys.stderr)) if a.json else print
    try:
        code, report = run(a.folder, a.branding, a.name, tuple(x.strip() for x in a.locales.split(",") if x.strip()), a.check, a.undo, log)
    except Refused as e:
        print(f"refused: {e}", file=sys.stderr)
        return REFUSED
    except Exception as e:  # noqa: BLE001
        print(f"failed: {type(e).__name__}: {e}", file=sys.stderr)
        return FAILED
    if a.json:
        print(json.dumps(report))
    return code


if __name__ == "__main__":
    sys.exit(main())

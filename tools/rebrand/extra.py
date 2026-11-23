"""Two lions that rebrand.py does not reach, in a private COPY of Brave.

    python tools/rebrand/extra.py <folder> [--branding DIR] [--check] [--json]

1. The big 3D lion of the welcome page: a WebP in brave_resources.pak. It is
   recognised by its outline (lion.py) and its orange colour, not by its id,
   and replaced with our mark at the same size.
2. The small lion in the address-bar chip of internal pages (and wherever else
   Brave draws that icon). It is not in any pack: it is a vector drawing
   compiled into chrome.dll. The drawing is found by its content (a 24 or 32
   unit canvas that starts with Brave's orange, #FB542B) and overwritten in
   place with our mark, taken from branding/gamblium-mark-small.svg. The new
   drawing must fit in the old one's bytes; the rest is padded with empty
   paths. If our mark is not made of filled paths, or does not fit, the lion
   is made invisible instead.

3. The program's own icon and name (taskbar, Task Manager, title bar). They
   are resources inside brave.exe and are rewritten there with
   branding/gamblium.ico and the name. The file keeps its name, brave.exe.

4. The one-time question "Change back to ...?" about the new tab page: its
   title is reworded, and
5. in chrome.dll the question is switched off altogether (see the section
   below for how the place is found).

6. Brave's settings pages (brave://settings) are one script in resources.pak,
   templates included. Four places in it are changed, each found by its text:
   - the menu entry of the blocker (Brave's "Shields", our "Gamblide") shows
     a stock shield: it becomes our mark, in the text colour like the icons
     beside it;
   - the menu's Downloads entry opens Gamblium's own Downloads settings, so
     there is one place for them (Brave's page stays reachable from there
     for the save folder, until ours can set it);
   - "On startup" no longer says that an extension called Gamblium controls
     the new tab page, with Manage and Disable beside it;
   - the menu entry of Brave Origin, a paid offer, is hidden.

Like rebrand.py this refuses the installed Brave (anything under Program
Files) and never touches brave.exe. chrome.dll in the copy loses its digital
signature; Brave does not check it. The launcher rebuilds the copy from the
installed Brave on every `gamblium rebrand`, so there is no undo here.

Exit codes: 0 done (or nothing to do), 2 refused, 1 unexpected failure.
"""
import argparse
import colorsys
import gzip
import io
import json
import re
import struct
import sys
import time
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
import lion as L  # noqa: E402
import pak as P  # noqa: E402
from rebrand import Branding, Refused, find_version_folder, refuse_installed, write_atomic  # noqa: E402

# ---- 1. The welcome page's lion -------------------------------------------------


def _orange_share(im):
    opaque = [p for p in im.resize((48, 48)).getdata() if p[3] > 200]
    if not opaque:
        return 0.0
    n = 0
    for r, g, b, _ in opaque:
        h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
        if (h < 0.09 or h > 0.96) and s > 0.5 and v > 0.5:
            n += 1
    return n / len(opaque)


def is_big_lion(raw):
    """A WebP of at least 120 px whose outline is the lion's and which is mostly orange."""
    if P.kind(raw) != "webp":
        return False
    try:
        im = Image.open(io.BytesIO(raw)).convert("RGBA")
    except Exception:
        return False
    if min(im.size) < 120:
        return False
    mask = L.filled(im.getchannel("A"))
    box = mask.getbbox()
    return bool(box) and L.likeness(mask.crop(box)) >= 0.9 and _orange_share(im) >= 0.4


def mark_webp(raw, art):
    """Our mark, centred, on a transparent canvas of the original's size."""
    w, h = Image.open(io.BytesIO(raw)).size
    side = min(w, h)
    canvas = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    canvas.paste(art.mark_png(side), ((w - side) // 2, (h - side) // 2))
    out = io.BytesIO()
    canvas.save(out, "WEBP", lossless=True)
    return out.getvalue()


# ---- 1b. The private and Tor windows' new tab page: lion and "brave" wordmark -----
# One script serves both pages (private_new_tab.bundle.js). It draws the logo
# inline: one React element, an svg of 210 x 64 units filled with orange
# gradients. That element is found by its canvas and its colours, and replaced
# by an <img> of our lockup (light letters: the page is dark) of the same size.
# Everything else on the page, including its privacy text, is left as it is.

PRIVATE_LOGO = b'.createElement("svg",{xmlns:"http://www.w3.org/2000/svg",width:"210",height:"64"'
LION_ORANGES = (b"#ff5601", b"#ff4000", b"#ff1f01", b"#f73a1c")


def _call_end(js, open_at):
    """-> index just past the ')' closing the call whose '(' is at open_at (strings skipped)."""
    depth, i, quote = 0, open_at, None
    while i < len(js):
        c = js[i:i + 1]
        if quote:
            if c == b"\\":
                i += 2
                continue
            if c == quote:
                quote = None
        elif c in (b'"', b"'", b"`"):
            quote = c
        elif c == b"(":
            depth += 1
        elif c == b")":
            depth -= 1
            if depth == 0:
                return i + 1
        i += 1
    return -1


def private_logo(js, lockup_svg):
    """-> (new script, number of logos replaced). The call `X.createElement("svg", {210 x 64}, ...)`
    becomes `X.createElement("img", {src: our lockup, ...})`; only when the drawing holds the lion's oranges."""
    import base64

    src = b"data:image/svg+xml;base64," + base64.b64encode(lockup_svg.encode("utf8"))
    out, pos, n = bytearray(), 0, 0
    while True:
        at = js.find(PRIVATE_LOGO, pos)
        if at == -1:
            break
        open_at = at + len(b".createElement")
        end = _call_end(js, open_at)
        if end == -1 or not any(o in js[at:end].lower() for o in LION_ORANGES):
            out += js[pos:at + 1]
            pos = at + 1
            continue
        img = b'.createElement("img",{src:"' + src + b'",width:"210",height:"64",alt:"Gamblium",style:{objectFit:"contain"}})'
        out += js[pos:at] + img
        pos = end
        n += 1
    out += js[pos:]
    return bytes(out), n


# The same page's colours: the search box's magnifier is a pink-to-orange gradient, and the
# "Private Window" note is text on a 20 % purple wash over the page's waves. Both in our ink:
# a silver-to-steel magnifier, and the note on our raised surface. Exact strings, so a page that
# changed is left alone and the report says 0.
PRIVATE_COLOURS = (
    (b'stopColor:"#BF14A2"', b'stopColor:"#C9CED8"'),  # magnifier gradient, start
    (b'stopColor:"#F73A1C"', b'stopColor:"#8FA3C4"'),  # and end
    (b"background: rgba(12, 4, 30, 0.2);", b"background: rgba(23, 24, 27, 0.94); box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.08), 0 10px 30px rgba(0, 0, 0, 0.45);"),  # the note
    (b"border-radius: 8px 0px 0px 8px;", b"border-radius: 8px;"),  # its corners, all round (only the note has this)
    # The search box: our New Tab pill on the raised surface, not a flat grey slab.
    (b"--bg-color: rgba(255, 255, 255, 0.22);", b"--bg-color: rgba(23, 24, 27, 0.94); box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.1), 0 10px 30px rgba(0, 0, 0, 0.45);"),
    (b"background: var(--bg-color);\n  border-radius: 8px;\n  transition: box-shadow", b"background: var(--bg-color);\n  border-radius: 999px;\n  transition: box-shadow"),
    # its magnifier button's hover: a quiet light, not Brave's purple-pink-orange
    (b"linear-gradient(304.74deg, #6F4CD2 15.81%, #BF14A2 63.17%, #F73A1C 100%)", b"rgba(255, 255, 255, 0.12)"),
    # the "Private window" and Tor "connecting" badges: round like the note
    (b"border-radius: 4px;", b"border-radius: 8px;"),
    (b"background: rgba(12, 4, 30, 0.3);", b"background: rgba(0, 0, 0, 0.3);"),  # its scrollbar track
)
PRIVATE_PAGE_MARK = b"search_icon_gr"


def private_colours(js):
    """-> (new script, number of replacements). Only in the private page's script (it holds the magnifier)."""
    if PRIVATE_PAGE_MARK not in js:
        return js, 0
    n = 0
    for old, new in PRIVATE_COLOURS:
        n += js.count(old)
        js = js.replace(old, new)
    return js, n


# ---- 1c. The private tab's icon: a grey lion drawn in lines inside a shield --------
# The pack patcher wants a lion's outline AND its face; this icon has the outline
# (0.944 at 16 px, 0.948 at 32 px) but, drawn in thin grey lines, no face to find.
# So the second proof here is that: no colour, and mostly empty inside its outline.

def is_line_lion(raw):
    """A small grey PNG whose outline is the lion's and which is a line drawing (hollow inside)."""
    if P.kind(raw) != "png":
        return False
    try:
        im = Image.open(io.BytesIO(raw)).convert("RGBA")
    except Exception:
        return False
    if not (14 <= im.width <= 64 and im.width == im.height):
        return False
    mask = L.filled(im.getchannel("A"))
    box = mask.getbbox()
    if not box or L.likeness(mask.crop(box)) < L.MATCH_PNG:
        return False
    seen = [px for px in im.getdata() if px[3] > 128]
    grey = all(max(r, g, b) - min(r, g, b) <= 24 for r, g, b, _ in seen)
    inside = sum(1 for v in mask.getdata() if v)
    return grey and inside > 0 and len(seen) / inside < 0.7


def mark_png_bytes(raw, art):
    """Our mark at the size of the original, as a PNG."""
    w, _ = Image.open(io.BytesIO(raw)).size
    out = io.BytesIO()
    art.mark_png(w).save(out, "PNG")
    return out.getvalue()


# ---- 1d. Private and Tor windows' colours: Brave's purple ramps ----------------------
# Brave's palette sits in chrome.dll as code: one "mov dword ptr [reg+d8], 0xFFRRGGBB" per step, 17
# steps a ramp, 0x71 bytes apart, the first step black and the third white. The private window's ramp
# holds its frame colour (#1F1629), the Tor window's ramp its own (#221527). Each purple step is given
# our moon hue at low saturation (dark steps a little darker, so the frame is near black; vivid steps
# land near the facet light), in place, same length. The same purple values written as colour constants
# elsewhere (a second copy of the window colours) get the same swap.

RAMPS = {"private window": 0x1F1629, "Tor window": 0x221527}
RAMP_STEPS, RAMP_STRIDE = 17, 0x71
_COLOUR_WRITE = re.compile(rb"\xc7[\x40-\x47].(...)\xff", re.S)


def _is_purple(rgb):
    r, g, b = ((rgb >> 16) & 255) / 255, ((rgb >> 8) & 255) / 255, (rgb & 255) / 255
    h, sat, _ = colorsys.rgb_to_hsv(r, g, b)
    return 0.66 <= h <= 0.84 and sat > 0.15


def house_colour(rgb, hue=218 / 360):
    """A purple step of Brave's ramp in our look: the moon's blue-grey hue, little colour, dark steps darker."""
    r, g, b = ((rgb >> 16) & 255) / 255, ((rgb >> 8) & 255) / 255, (rgb & 255) / 255
    _, sat, val = colorsys.rgb_to_hsv(r, g, b)
    if val < 0.45:
        sat, val = sat * 0.18, max(0.012, val - 0.12)
    else:
        sat = min(0.31, sat * 0.35)
    nr, ng, nb = colorsys.hsv_to_rgb(hue, sat, val)
    return (round(nr * 255) << 16) | (round(ng * 255) << 8) | round(nb * 255)


def find_ramp(data, colour):
    """-> [(offset of the colour's 4 bytes, colour)] of the 17-step ramp holding `colour` as its second
    step, or [] when no ramp of that shape is there."""
    want = struct.pack("<I", 0xFF000000 | colour)
    pos = data.find(want)
    while pos != -1:
        start = pos - 3 - RAMP_STRIDE  # the ramp's first step, where its "mov" begins
        steps = []
        for k in range(RAMP_STEPS):
            m = _COLOUR_WRITE.match(data, start + k * RAMP_STRIDE)
            if not m:
                break
            steps.append((m.start(1), int.from_bytes(m.group(1), "little")))
        if len(steps) == RAMP_STEPS and steps[0][1] == 0 and steps[2][1] == 0xFFFFFF and steps[1][1] == colour:
            return steps
        pos = data.find(want, pos + 1)
    return []


def patch_private_colours(data):
    """-> (new bytes, [what was done]). Brave's private and Tor purple ramps in our look."""
    out = bytearray(data)
    notes, swap = [], {}
    for name, colour in RAMPS.items():
        steps = find_ramp(data, colour)
        if not steps:
            already = find_ramp(data, house_colour(colour))
            notes.append(f"{name} colours: {'already ours' if already else 'ramp not found (a different Brave); left alone'}")
            continue
        n = 0
        for at, rgb in steps:
            if _is_purple(rgb):
                new = house_colour(rgb)
                out[at:at + 3] = new.to_bytes(3, "little")
                swap[rgb] = new
                n += 1
        notes.append(f"{name} colours: {n} steps in our look (frame #{colour:06X} -> #{house_colour(colour):06X})")
    # The same purple values written as colour constants elsewhere.
    extra = 0
    for m in _COLOUR_WRITE.finditer(out):
        rgb = int.from_bytes(m.group(1), "little")
        if rgb in swap:
            out[m.start(1):m.start(1) + 3] = swap[rgb].to_bytes(3, "little")
            extra += 1
    if swap:
        notes.append(f"private window colours: {extra} more constant(s) with the same values")
    # The Tor button's text: lavender, set by one "mov eax, 0xFFE3B3FF"; it takes the facet light.
    lavender, ours = b"\xb8" + struct.pack("<I", 0xFFE3B3FF), b"\xb8" + struct.pack("<I", 0xFF8FA3C4)
    if out.count(lavender) == 1:
        at = out.find(lavender)
        out[at:at + 5] = ours
        notes.append("Tor button text: the facet light")
    else:
        notes.append("Tor button text: " + ("already ours" if out.count(ours) else f"not found once ({out.count(lavender)} places); left alone"))
    return bytes(out), notes


# ---- 1e. Brave's primary colours: the lavender of buttons, focus rings and selections ----------
# Native pop-ups (the bookmark bubble's Done, a permission prompt's Allow / Block, the address bar's
# selected row) take Brave's "primary" ramp, written into chrome.dll as runs of colour stores like the
# private ramps above: #101322 ... #3A2ECD #5B67E8 #96A5F1 #BCC6F3 ... #FBFBFD, with an indigo ramp
# beside it. Neither the theme seed nor its variant reaches them (six seeds and variants tried, Nov 13
# 2026). A run is found by its Done fill (#BCC6F3); in it, every step of lavender or indigo hue keeps its
# lightness and takes the facet light's hue and a low chroma. Blue, orange and other ramps in the same
# run are left alone.

PRIMARY_KEY = 0xBCC6F3
_PRIMARY_HUE = (0.62, 0.72)


def _is_primary(rgb):
    r, g, b = ((rgb >> 16) & 255) / 255, ((rgb >> 8) & 255) / 255, (rgb & 255) / 255
    h, _, sat = colorsys.rgb_to_hls(r, g, b)
    # Real colour, not a near-white whose tiny tint reads as high saturation.
    return _PRIMARY_HUE[0] <= h <= _PRIMARY_HUE[1] and sat > 0.12 and max(r, g, b) - min(r, g, b) >= 0.06


def primary_colour(rgb, hue=218 / 360):
    """A lavender step in our look: the same lightness, the facet light's hue, a low chroma."""
    r, g, b = ((rgb >> 16) & 255) / 255, ((rgb >> 8) & 255) / 255, (rgb & 255) / 255
    _, light, sat = colorsys.rgb_to_hls(r, g, b)
    nr, ng, nb = colorsys.hls_to_rgb(hue, light, min(0.32, sat * 0.4))
    return (round(nr * 255) << 16) | (round(ng * 255) << 8) | round(nb * 255)


def colour_runs(data, colour):
    """-> one list of (offset of the colour's 3 bytes, colour) per run of colour stores (each 0x60 to
    0x80 bytes after the last) that holds `colour`."""
    runs, want = [], struct.pack("<I", 0xFF000000 | colour)
    pos = data.find(want)
    while pos != -1:
        m = _COLOUR_WRITE.match(data, pos - 3)
        if m:
            steps = {m.start(1): int.from_bytes(m.group(1), "little")}
            for direction in (-1, 1):
                at = m.start()
                while True:
                    nxt = next((_COLOUR_WRITE.match(data, at + direction * d) for d in range(0x60, 0x81)
                                if _COLOUR_WRITE.match(data, at + direction * d)), None)
                    if not nxt:
                        break
                    steps[nxt.start(1)] = int.from_bytes(nxt.group(1), "little")
                    at = nxt.start()
            if len(steps) >= 8 and not any(min(steps) in r[0] for r in runs):
                runs.append((sorted(steps), steps))
        pos = data.find(want, pos + 1)
    return [[(at, steps[at]) for at in order] for order, steps in runs]


def patch_primary_colours(data):
    """-> (new bytes, [what was done]). Brave's lavender primary colours in our look."""
    runs = colour_runs(data, PRIMARY_KEY)
    if not runs:
        ours = colour_runs(data, primary_colour(PRIMARY_KEY))
        return data, ["primary colours: " + ("already ours" if ours else "not found (a different Brave); left alone")]
    out, n = bytearray(data), 0
    for run in runs:
        for at, rgb in run:
            if _is_primary(rgb):
                out[at:at + 3] = primary_colour(rgb).to_bytes(3, "little")
                n += 1
    return bytes(out), [f"primary colours: {n} steps in our look in {len(runs)} run(s) (#{PRIMARY_KEY:06X} -> #{primary_colour(PRIMARY_KEY):06X})"]


# Chromium picks some accents (the address bar's URL text and selected-row bar among them) from a table of
# Google's colours kept as data, one ARGB word each; its blue ramp, 50 to 900, takes the same treatment.
GOOGLE_BLUE = [0xE8F0FE, 0xD2E3FC, 0xAECBFA, 0x8AB4F8, 0x669DF6, 0x4285F4, 0x1A73E8, 0x1967D2, 0x185ABC, 0x174EA6]


def patch_google_blue(data):
    """-> (new bytes, [what was done]). The Google blue ramp in Chromium's colour table in our look."""
    pack = lambda cs: b"".join(struct.pack("<I", 0xFF000000 | c) for c in cs)  # noqa: E731
    theirs, ours = pack(GOOGLE_BLUE), pack([primary_colour(c) for c in GOOGLE_BLUE])
    notes, out = [], bytearray(data)
    n = data.count(theirs)
    if n == 1:
        at = data.find(theirs)
        out[at:at + len(ours)] = ours
        notes.append(f"Google blue: 10 table steps in our look (#8AB4F8 -> #{primary_colour(0x8AB4F8):06X})")
    else:
        notes.append("Google blue: " + ("table already ours" if data.count(ours) else f"table not found once ({n}); left alone"))
    # The address bar's URL text is drawn from Google Blue 500 (#4285F4), written as colour stores.
    stores = 0
    for m in _COLOUR_WRITE.finditer(data):
        if int.from_bytes(m.group(1), "little") == 0x4285F4:
            out[m.start(1):m.start(1) + 3] = primary_colour(0x4285F4).to_bytes(3, "little")
            stores += 1
    notes.append(f"Google blue 500: {stores} colour store(s) in our look" if stores else "Google blue 500: no colour store left (already ours or a different Brave)")
    return bytes(out), notes


def is_tor_frame_art(raw):
    """The picture drawn into the Tor window's frame: a wide strip (about 5.5 : 1) of purple circles."""
    if P.kind(raw) != "png":
        return False
    try:
        im = Image.open(io.BytesIO(raw)).convert("RGBA")
    except Exception:
        return False
    if im.height < 20 or not 4.5 <= im.width / im.height <= 6.5:
        return False
    seen = [px for px in im.resize((60, 11)).getdata() if px[3] > 60]
    purple = sum(1 for r, g, b, _ in seen if _is_purple((r << 16) | (g << 8) | b))
    return len(seen) > 20 and purple / len(seen) > 0.9


def house_art(raw, hue=218 / 360):
    """A purple picture in our look: the moon's hue, little colour, dimmer; transparency kept."""
    im = Image.open(io.BytesIO(raw)).convert("RGBA")
    px = []
    for r, g, b, a in im.getdata():
        _, sat, val = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
        nr, ng, nb = colorsys.hsv_to_rgb(hue, sat * 0.2, val * 0.6)
        px.append((round(nr * 255), round(ng * 255), round(nb * 255), a))
    im.putdata(px)
    out = io.BytesIO()
    im.save(out, "PNG")
    return out.getvalue()


# ---- 2. The vector lion in chrome.dll --------------------------------------------
# A vector icon is a run of 4-byte elements: a command number, then its
# arguments as floats. Numbers as found in Chromium 157:
NEW_PATH, COLOR_ARGB, MOVE_TO, LINE_TO, CLOSE, CANVAS = 0, 3, 7, 11, 27, 28
ARGS = {0: 0, 2: 1, 3: 4, 4: 0, 5: 1, 6: 0, 7: 2, 8: 2, 9: 7, 10: 7, 11: 2, 12: 2, 13: 1, 14: 1, 15: 1, 16: 1, 17: 6, 18: 6, 19: 4, 20: 4, 21: 4, 22: 3, 24: 5, 27: 0, 28: 1}
ORANGE = struct.pack("<i4f", COLOR_ARGB, 255.0, 251.0, 84.0, 43.0)


def find_lions(data):
    """-> [(offset, canvas size, length in bytes)] of drawings that open with Brave's orange."""
    found = []
    pos = data.find(ORANGE)
    while pos != -1:
        start = pos - 8
        if start >= 0 and start % 4 == 0 and struct.unpack_from("<i", data, start)[0] == CANVAS:
            size = struct.unpack_from("<f", data, start + 4)[0]
            o = start
            while o + 4 <= len(data):
                cmd = struct.unpack_from("<i", data, o)[0]
                if cmd not in ARGS or (cmd == CANVAS and o != start):
                    break
                o += 4 + 4 * ARGS[cmd]
            if size in (16.0, 20.0, 24.0, 32.0, 48.0) and 200 <= o - start <= 20000:
                found.append((start, size, o - start))
        pos = data.find(ORANGE, pos + 1)
    return found


def mark_polygons(svg):
    """Our small mark as [(r, g, b, [(x, y), ...])] in its own units, plus its view box.
    None when it is not made only of filled paths (then it cannot be drawn this way)."""
    box = re.search(r'viewBox="([-\d.\s]+)"', svg)
    if not box:
        return None
    vx, vy, vw, vh = (float(v) for v in box.group(1).split())
    shapes = []
    body = re.sub(r"<svg[^>]*>|</svg>", "", svg)
    for tag in re.findall(r"<(\w+)\b[^>]*>", body):
        if tag != "path":
            return None
    for el in re.findall(r"<path\b[^>]*>", body):
        d = re.search(r'\bd="([^"]+)"', el)
        fill = re.search(r'\bfill="#([0-9a-fA-F]{6})"', el)
        if not d or not fill or re.search(r'\bstroke="(?!none)', el):
            return None
        rgb = tuple(int(fill.group(1)[i:i + 2], 16) for i in (0, 2, 4))
        for poly in L.path_polygons(d.group(1)):
            if len(poly) >= 3:
                shapes.append((*rgb, poly))
    return (shapes, (vx, vy, vw, vh)) if shapes else None


def outline_points(data, start):
    """A drawing's subpaths as rough polygons (curves by their control points), and its length in
    bytes, its number of commands, and whether it sets any colour itself."""
    o, polys, cur, x, y, n, coloured = start, [], [], 0.0, 0.0, 0, False
    while o + 4 <= len(data) and n < 800:
        cmd = struct.unpack_from("<i", data, o)[0]
        if cmd not in ARGS or (cmd == CANVAS and o != start):
            break
        a = struct.unpack_from(f"<{ARGS[cmd]}f", data, o + 4) if ARGS[cmd] else ()
        if cmd in (7, 8):  # move, relative move: a new subpath
            if cur:
                polys.append(cur)
            x, y = (a[0], a[1]) if cmd == 7 else (x + a[0], y + a[1])
            cur = [(x, y)]
        elif cmd == 11:
            x, y = a
            cur.append((x, y))
        elif cmd == 12:
            x, y = x + a[0], y + a[1]
            cur.append((x, y))
        elif cmd in (13, 14):
            x = a[0] if cmd == 13 else x + a[0]
            cur.append((x, y))
        elif cmd in (15, 16):
            y = a[0] if cmd == 15 else y + a[0]
            cur.append((x, y))
        elif cmd == 17:
            cur += [(a[0], a[1]), (a[2], a[3]), (a[4], a[5])]
            x, y = a[4], a[5]
        elif cmd == 18:
            cur += [(x + a[0], y + a[1]), (x + a[2], y + a[3]), (x + a[4], y + a[5])]
            x, y = x + a[4], y + a[5]
        elif cmd in (9, 10):
            x, y = (a[5], a[6]) if cmd == 9 else (x + a[5], y + a[6])
            cur.append((x, y))
        elif cmd == COLOR_ARGB:
            coloured = True
        o += 4 + 4 * ARGS[cmd]
        n += 1
    if cur:
        polys.append(cur)
    return [q for q in polys if len(q) >= 3], o - start, n, coloured


def find_plain_lions(data):
    """-> [(offset, canvas size, length)] of one-colour lions: drawings with no colour of their own
    whose outline is the lion's. Brave uses them where an icon takes the colour of the text around
    it (the "About" entry of the menu). A plain shield scores up to 0.93 on outline, so the bar is
    0.96, and a lion has far more detail than a shield."""
    found = []
    mark = struct.pack("<i", CANVAS)
    pos = data.find(mark)
    while pos != -1:
        if pos % 4 == 0 and struct.unpack_from("<f", data, pos + 4)[0] in (16.0, 20.0, 24.0, 32.0):
            polys, length, count, coloured = outline_points(data, pos)
            if not coloured and count >= 60 and polys:
                try:
                    score = L.polygons_likeness(polys)
                except Exception:
                    score = 0.0
                if score >= 0.96:
                    found.append((pos, struct.unpack_from("<f", data, pos + 4)[0], length))
        pos = data.find(mark, pos + 1)
    return found


def drawing(shapes, view, size, coloured=True):
    """The elements of a vector icon that draws `shapes` on a canvas of `size` units.
    coloured=False leaves the colour to whoever draws the icon (one-colour icons)."""
    vx, vy, vw, vh = view
    scale = size / max(vw, vh)
    out = [struct.pack("<if", CANVAS, size)]
    for n, (r, g, b, poly) in enumerate(shapes):
        if n:
            out.append(struct.pack("<i", NEW_PATH))
        if coloured:
            out.append(struct.pack("<i4f", COLOR_ARGB, 255.0, float(r), float(g), float(b)))
        for i, (x, y) in enumerate(poly):
            out.append(struct.pack("<i2f", MOVE_TO if i == 0 else LINE_TO, (x - vx) * scale, (y - vy) * scale))
        out.append(struct.pack("<i", CLOSE))
    return b"".join(out)


def invisible(old):
    """The old drawing with every colour's opacity set to nothing."""
    out = bytearray(old)
    o = 0
    while o + 4 <= len(out):
        cmd = struct.unpack_from("<i", out, o)[0]
        if cmd not in ARGS:
            break
        if cmd == COLOR_ARGB:
            struct.pack_into("<f", out, o + 4, 0.0)
        o += 4 + 4 * ARGS[cmd]
    return bytes(out)


# ---- 2b. The menu button: four pips instead of three lines (owner, Nov 12 2026) ---
# The button at the right end of the toolbar is a one-colour drawing of three
# flat bars of equal length. It is found by that shape, not by a name, and
# overwritten in place by four small diamonds set as a diamond (like the pips
# of a card), which need fewer bytes than the bars with their rounded ends.

def find_menu_bars(data):
    """-> [(offset, canvas size, length)] of one-colour drawings that are three flat bars of
    about the same length, one above the other, each most of the canvas wide."""
    found = []
    mark = struct.pack("<i", CANVAS)
    pos = data.find(mark)
    while pos != -1:
        if pos % 4 == 0 and pos + 8 <= len(data):
            size = struct.unpack_from("<f", data, pos + 4)[0]
            if size in (16.0, 20.0, 24.0):
                polys, length, count, coloured = outline_points(data, pos)
                if not coloured and len(polys) == 3 and count <= 80:
                    boxes = [(min(p[0] for p in q), min(p[1] for p in q), max(p[0] for p in q), max(p[1] for p in q)) for q in polys]
                    wide = all(b[2] - b[0] >= size * 0.7 and b[3] - b[1] <= size * 0.2 for b in boxes)
                    mids = sorted((b[1] + b[3]) / 2 for b in boxes)
                    apart = mids[1] - mids[0] >= size * 0.15 and mids[2] - mids[1] >= size * 0.15
                    if wide and apart:
                        found.append((pos, size, length))
        pos = data.find(mark, pos + 1)
    return found


def pips(size):
    """Four small diamonds set as a diamond, as a one-colour drawing on a canvas of `size` units."""
    c, reach, r = size / 2, size * 0.2875, size * 0.13125
    out = [struct.pack("<if", CANVAS, size)]
    for cx, cy in ((c, c - reach), (c + reach, c), (c, c + reach), (c - reach, c)):
        for i, (x, y) in enumerate(((cx, cy - r), (cx + r, cy), (cx, cy + r), (cx - r, cy))):
            out.append(struct.pack("<i2f", MOVE_TO if i == 0 else LINE_TO, x, y))
        out.append(struct.pack("<i", CLOSE))
    return b"".join(out)


def patch_menu_button(data, blank=False):
    """-> (new bytes, [what was done]). Every three-bar menu drawing becomes the four pips, in place,
    or, with blank=True, a drawing of nothing: the button is still there and still opens Brave's
    menu, but shows no picture."""
    out = bytearray(data)
    notes = []
    for start, size, length in find_menu_bars(data):
        new = struct.pack("<if", CANVAS, size) if blank else pips(size)
        if len(new) <= length:
            new += struct.pack("<i", NEW_PATH) * ((length - len(new)) // 4)
            out[start:start + length] = new
            notes.append(f"{int(size)}-unit menu button at {start:#x}: {'blank' if blank else 'four pips'}")
        else:
            notes.append(f"{int(size)}-unit menu button at {start:#x}: left (the pips do not fit)")
    if not notes:
        already = data.count(pips(24.0)) + data.count(pips(20.0)) + data.count(pips(16.0))
        notes.append(f"menu button: already the four pips ({already})" if already else "menu button: the three bars were not found (already blank, or a different Brave); left alone")
    return bytes(out), notes


# ---- 2c. Brave's menu button hidden: Gamblium's menu is the one menu (owner, Nov 14 2026) ---
# The owner wants one menu, ours, at the right of the toolbar. Brave's button cannot be taken out
# from outside, so its theme-changed handler, which runs as soon as the button is on a window, is
# rewritten to call the views base handler and then View::SetVisible(false): the button is
# gone and takes no space. Its keys (Alt+F, Alt+E) still open Brave's menu, which holds what
# an extension cannot do (find, print, developer tools).
#
# Found by content, no names (checked with Brave's symbols on 1.99.57):
# - the handler: push rsi; sub rsp,0x20; mov rsi,rcx; call +0x13 (UpdateThemeBasedState, right
#   after it); mov rcx,rsi; add rsp,0x20; pop rsi; jmp <base>. 26 functions look like that; the
#   one whose callee reads two neighbouring fields (the icon's type and severity) twice is ours.
# - View::SetVisible: its prologue, then `mov dil,[rcx+X]; cmp dil,dl; jne` (visible already?).

_THEME_HANDLER = re.compile(re.escape(bytes.fromhex("564883ec204889cee8130000004889f14883c4205ee9")) + b"(....)" + re.escape(bytes.fromhex("cc")), re.S)
_FIELD_PAIR = re.compile(re.escape(bytes.fromhex("8b96")) + b"(....)" + re.escape(bytes.fromhex("448b86")) + b"(....)", re.S)
# Chromium 158 (Brave 1.100.58) saves one register fewer (no `push r15`) and keeps a bigger frame
# (sub rsp,0x48; the cookie at [rsp+0x40]); the pattern takes both.
_SET_VISIBLE = re.compile(
    b"(?:" + re.escape(bytes.fromhex("4157")) + b")?" + re.escape(bytes.fromhex("41565657534883ec")) + b"[@H]" + re.escape(bytes.fromhex("89d34889ce488b05")) + b"...."
    + re.escape(bytes.fromhex("4831e048894424")) + b"[8@]" + re.escape(bytes.fromhex("408ab9")) + b"...." + re.escape(bytes.fromhex("4038d775")),
    re.S,
)


def _rva(data, off):
    return next((va + off - rp for _, _, va, rs, rp in pe_sections(data) if rp <= off < rp + rs), None)


def hide_menu_button(data):
    """-> (new bytes, [notes]). Rewrites the menu button's theme handler to hide the button."""
    found = []
    for m in _THEME_HANDLER.finditer(data):
        body = data[m.start() + 0x20:m.start() + 0x120]
        pairs = [(struct.unpack("<i", a)[0], struct.unpack("<i", b)[0]) for a, b in _FIELD_PAIR.findall(body)]
        pairs = [p for p in pairs if p[1] == p[0] + 4]
        if len(pairs) >= 2 and pairs[0] == pairs[1]:
            found.append(m)
    hidden = [m.start() for m in re.finditer(re.escape(bytes.fromhex("564883ec204889ce4889f1e8")), data)]
    vis = [m.start() for m in _SET_VISIBLE.finditer(data)]
    if len(found) != 1 or len(vis) != 1:
        if not found and hidden:
            return data, ["menu button: already hidden"]
        return data, [f"menu button: not hidden (handler {len(found)}, SetVisible {len(vis)} found; a different Brave); left alone"]
    m = found[0]
    start = m.start()
    at = _rva(data, start + 8)
    base_target = _rva(data, m.start(1)) + 4 + struct.unpack("<i", m.group(1))[0]
    set_visible = _rva(data, vis[0])
    code = bytearray(bytes.fromhex("4889f1"))  # mov rcx, rsi
    code += bytes.fromhex("e8") + struct.pack("<i", base_target - (at + len(code) + 5))  # call the base handler
    code += bytes.fromhex("4889f131d24883c4205e")  # mov rcx, rsi; xor edx, edx; add rsp, 0x20; pop rsi
    code += bytes.fromhex("e9") + struct.pack("<i", set_visible - (at + len(code) + 5))  # jmp View::SetVisible
    out = bytearray(data)
    out[start + 8:start + 8 + len(code)] = code
    out[start + 8 + len(code):start + 0x20] = bytes.fromhex("cc") * (0x20 - 8 - len(code))
    return bytes(out), [f"menu button: hidden (handler at {start:#x})"]


# ---- 2d. The extensions button (puzzle) first, so Gamblium's button is the rightmost (owner, Nov 14 2026) ---
# Everything of Brave's toolbar stays (the puzzle lists every extension), but Gamblium's button
# must be at the right end. The extensions area places its pinned buttons first and the puzzle
# last (ExtensionsToolbarDesktop::ReorderAllChildViews: ReorderChildView(puzzle, count - 1 or -2)).
# The index for the puzzle becomes 0 (`movsxd r8, edi` -> `xor r8, r8`, 3 bytes), so the puzzle
# leads and the pinned buttons follow; the launcher pins Gamblium's button last.
# Found by content (checked with Brave's symbols on 1.99.57): the block that counts the children,
# moves the request-access button to the end if there is one, then the puzzle.

_PUZZLE_ORDER = re.compile(
    re.escape(bytes.fromhex("8b9e")) + b".." + re.escape(bytes(2)) + re.escape(bytes.fromhex("8d7bff488b96")) + b".." + re.escape(bytes(2))
    + re.escape(bytes.fromhex("4885d2741083c3fe4c63c74889f1e8")) + b"...." + re.escape(bytes.fromhex("89df4c63c7488b96")) + b".." + re.escape(bytes(2))
    + re.escape(bytes.fromhex("4889f1e8")),
    re.S,
)
_PUZZLE_FIRST = re.compile(
    re.escape(bytes.fromhex("8b9e")) + b".." + re.escape(bytes(2)) + re.escape(bytes.fromhex("8d7bff488b96")) + b".." + re.escape(bytes(2))
    + re.escape(bytes.fromhex("4885d2741083c3fe4c63c74889f1e8")) + b"...." + re.escape(bytes.fromhex("89df4d31c0488b96")),
    re.S,
)


def puzzle_first(data):
    """-> (new bytes, [notes]). The puzzle is put first in the extensions area, not last."""
    found = [m.start() for m in _PUZZLE_ORDER.finditer(data)]
    if len(found) != 1:
        if not found and _PUZZLE_FIRST.search(data):
            return data, ["extensions button: already first"]
        return data, [f"extensions button: order not changed ({len(found)} places found; a different Brave); left alone"]
    at = found[0] + 0x25
    out = bytearray(data)
    out[at:at + 3] = bytes.fromhex("4d31c0")
    return bytes(out), [f"extensions button: first in the extensions area (at {at:#x})"]


def patch_dll(data, art_svg, plain_svg=None):
    """-> (new bytes, [what was done per lion]). plain_svg: the mark to use where the icon has one
    colour only (its facets should be drawn apart, or it becomes a plain kite)."""
    made = mark_polygons(art_svg)
    plain = mark_polygons(plain_svg) if plain_svg else made
    out = bytearray(data)
    notes = []
    for start, size, length in find_plain_lions(data):
        new = drawing(*plain, size, coloured=False) if plain else None
        if new and len(new) <= length:
            new += struct.pack("<i", NEW_PATH) * ((length - len(new)) // 4)
            out[start:start + length] = new
            notes.append(f"{int(size)}-unit one-colour lion at {start:#x}: our mark")
        else:
            notes.append(f"{int(size)}-unit one-colour lion at {start:#x}: left (our mark cannot be drawn there)")
    for start, size, length in find_lions(data):
        new = drawing(*made, size) if made else None
        if new and len(new) <= length:
            # Empty paths draw nothing; they only fill the space the lion took.
            new += struct.pack("<i", NEW_PATH) * ((length - len(new)) // 4)
            notes.append(f"{int(size)}-unit lion at {start:#x}: our mark")
        else:
            new = invisible(data[start:start + length])
            notes.append(f"{int(size)}-unit lion at {start:#x}: made invisible ({'our mark is not made of filled paths' if not made else 'our mark does not fit'})")
        out[start:start + length] = new
    return bytes(out), notes


# ---- 5. The "this page was changed by an extension" question ------------------------
# When an extension supplies the new tab page, Brave asks once per profile
# whether to keep it. Gamblium's new tab page IS the product, so the question
# makes no sense, and Brave offers no setting to answer it in advance (the
# answer is kept in a protected file and anything written there beforehand is
# thrown away; tried). In the copy the question is therefore never raised.
#
# How: one function prepares the question. It names the setting that records
# the answer ("ack_ntp_bubble"), builds the question, and then marks its
# result as present with a single instruction, `mov byte ptr [reg+N], 1`.
# Writing 0 there instead makes the function answer "nothing to ask".
# The place is found by content: the only instruction that loads that name's
# address (`lea reg, [rip + name]`), and the first such `mov` within 160
# bytes after it. Any four bytes of code can happen to equal the name's
# distance (Brave 1.99.57 has one such, inside `test ecx, ecx; je`), so only
# a real address load counts.

ACK_NAME = b"ack_ntp_bubble\x00"
MARK_PRESENT = re.compile(rb"\xc6[\x80-\x87](?s:.)[\x00-\x0f]\x00\x00\x01")  # mov byte ptr [reg + small], 1


def pe_sections(data):
    pe = struct.unpack_from("<I", data, 0x3C)[0]
    n, opt_size = struct.unpack_from("<H", data, pe + 6)[0], struct.unpack_from("<H", data, pe + 20)[0]
    table = pe + 24 + opt_size
    return [struct.unpack_from("<8sIIII", data, table + 40 * i) for i in range(n)]  # name, vsize, vaddr, rawsize, rawptr


def references(data, target_offset):
    """File offsets of the 4-byte fields in the code that point (relative to what follows them) at target_offset."""
    import numpy as np

    secs = pe_sections(data)
    target = next((va + target_offset - rp for _, _, va, rs, rp in secs if rp <= target_offset < rp + rs), None)
    code = next((x for x in secs if x[0].rstrip(b"\0") == b".text"), None)
    if target is None or code is None:
        return []
    _, _, va, rs, rp = code
    out = []
    for shift in range(4):
        usable = (rs - shift) // 4 * 4
        arr = np.frombuffer(data, dtype="<i4", count=usable // 4, offset=rp + shift).astype(np.int64)
        pos = shift + 4 * np.arange(len(arr), dtype=np.int64)
        out += [rp + int(shift + 4 * i) for i in np.nonzero(va + pos + 4 + arr == target)[0]]
    return sorted(out)


def loads_address(data, field):
    """True if the 4 bytes at `field` are the target of `lea reg64, [rip + x]`."""
    if field < 3:
        return False
    rex, op, modrm = data[field - 3], data[field - 2], data[field - 1]
    return rex in (0x48, 0x4C) and op == 0x8D and (modrm & 0xC7) == 0x05


def silence_question(data):
    """-> (new bytes, note). The bytes are unchanged when the place is not found for certain."""
    at = data.find(ACK_NAME)
    if at < 0 or data.find(ACK_NAME, at + 1) >= 0:
        return data, "new-tab question: the setting's name was not found exactly once; left alone"
    try:
        refs = references(data, at)
    except ImportError:
        return data, "new-tab question: left alone (this step needs the numpy package)"
    refs = [r for r in refs if loads_address(data, r)]
    if len(refs) != 1:
        return data, f"new-tab question: {len(refs)} instructions load the setting's name, expected 1; left alone"
    m = MARK_PRESENT.search(data, refs[0], refs[0] + 160)
    if not m:
        return data, "new-tab question: already silenced, or Brave's code has changed; left alone"
    out = bytearray(data)
    out[m.end() - 1] = 0
    return bytes(out), f"new-tab question: silenced at {m.start():#x}"


# ---- 3. The program's own icon and name ---------------------------------------------
# The taskbar button, Task Manager and the window's title-bar icon all come from
# resources inside brave.exe: its icon images and its version block ("Brave
# Browser"). They are overwritten where they lie, byte for byte, so nothing in
# the file moves. (Letting Windows rebuild the resources with UpdateResource
# was tried first: the program then refused to start.) The file keeps its name
# and loses its digital signature, which nothing checks when it is started
# from this computer.

RT_ICON, RT_GROUP_ICON, RT_VERSION = 3, 14, 16
PNG_SIG = b"\x89PNG\r\n\x1a\n"


def pe_resources(data):
    """-> [(type, name, file offset, size)] for every resource of a Windows program.
    Type and name are numbers, or text for named ones."""
    pe = struct.unpack_from("<I", data, 0x3C)[0]
    if data[pe:pe + 4] != b"PE\0\0":
        raise ValueError("not a Windows program")
    sections_n, opt_size = struct.unpack_from("<H", data, pe + 6)[0], struct.unpack_from("<H", data, pe + 20)[0]
    opt = pe + 24
    magic = struct.unpack_from("<H", data, opt)[0]
    dirs = opt + (112 if magic == 0x20B else 96)
    res_rva = struct.unpack_from("<I", data, dirs + 2 * 8)[0]
    sections = [struct.unpack_from("<8sIIII", data, opt + opt_size + 40 * i) for i in range(sections_n)]

    def at(rva):
        for _, vsize, vaddr, rawsize, rawptr in sections:
            if vaddr <= rva < vaddr + max(vsize, rawsize):
                return rawptr + rva - vaddr
        raise ValueError("address outside the file")

    base = at(res_rva)

    def entries(offset):
        named, ids = struct.unpack_from("<HH", data, offset + 12)
        for i in range(named + ids):
            name, target = struct.unpack_from("<II", data, offset + 16 + 8 * i)
            if name & 0x80000000:
                o = base + (name & 0x7FFFFFFF)
                n = struct.unpack_from("<H", data, o)[0]
                name = data[o + 2:o + 2 + 2 * n].decode("utf-16-le")
            yield name, target

    out = []
    for kind, t1 in entries(base):
        if not t1 & 0x80000000:
            continue
        for name, t2 in entries(base + (t1 & 0x7FFFFFFF)):
            if not t2 & 0x80000000:
                continue
            for _, t3 in entries(base + (t2 & 0x7FFFFFFF)):
                rva, size = struct.unpack_from("<II", data, base + t3)
                out.append((kind, name, at(rva), size))
    return out


def icon_dib(im):
    """A picture as Windows keeps a small icon: 32-bit pixels bottom-up, then an (empty) mask."""
    w, h = im.size
    rows = [im.crop((0, y, w, y + 1)).tobytes("raw", "BGRA") for y in range(h - 1, -1, -1)]
    mask = bytes(((w + 31) // 32) * 4) * h
    return struct.pack("<IiiHHIIiiII", 40, w, h * 2, 1, 32, 0, w * h * 4, 0, 0, 0, 0) + b"".join(rows) + mask


def icon_picture(raw):
    """One stored icon image as an RGBA picture, or None."""
    try:
        if raw[:8] == PNG_SIG:
            return Image.open(io.BytesIO(raw)).convert("RGBA")
        size, w, h2, _, bits = struct.unpack_from("<IiiHH", raw, 0)
        if bits != 32 or w <= 0:
            return None
        h = h2 // 2
        return Image.frombuffer("RGBA", (w, h), raw[size:size + w * h * 4], "raw", "BGRA", 0, -1)
    except Exception:
        return None


def shows_lion(im):
    """Is this icon Brave's lion: its outline, and mostly orange?"""
    if im is None or min(im.size) < 24:
        return False
    mask = L.filled(im.getchannel("A"))
    box = mask.getbbox()
    return bool(box) and L.likeness(mask.crop(box)) >= 0.85 and _orange_share(im) >= 0.4


def patch_exe(data, mark_png, name, old_name="Brave Browser", lions_only=False):
    """-> (new bytes, icon images replaced, icon images left, names replaced).
    `mark_png(side)` gives our mark as an RGBA picture of that size.
    lions_only: replace an icon only if it shows the lion (for chrome.dll, which
    also holds icons that are not the product's: documents, the private window)."""
    out = bytearray(data)
    res = pe_resources(data)
    where = {rname: (off, size) for kind, rname, off, size in res if kind == RT_ICON}
    wanted, kept = {}, set()  # icon id -> (width, bits)
    for kind, rname, off, size in res:
        if kind != RT_GROUP_ICON:
            continue
        count = struct.unpack_from("<H", data, off + 4)[0]
        skip = isinstance(rname, str) and any(w in rname for w in ("INCOGNITO", "FILE"))  # private window, documents
        if lions_only:
            # Judge the group by its largest picture.
            members = [struct.unpack_from("<BBBBHHIH", data, off + 6 + 14 * i) for i in range(count)]
            best = max(members, key=lambda m: m[0] or 256, default=None)
            at = where.get(best[7]) if best else None
            skip = not (at and shows_lion(icon_picture(data[at[0]:at[0] + at[1]])))
        for i in range(count):
            w, _, _, _, _, bits, _, icon_id = struct.unpack_from("<BBBBHHIH", data, off + 6 + 14 * i)
            (kept.add(icon_id) if skip else wanted.__setitem__(icon_id, (w or 256, bits)))
    done = left = 0
    for kind, rname, off, size in res:
        if kind != RT_ICON or rname not in wanted or rname in kept:
            continue
        side, bits = wanted[rname]
        old = data[off:off + size]
        if old[:8] == PNG_SIG:
            buf = io.BytesIO()
            mark_png(side).save(buf, "PNG", optimize=True)
            new = buf.getvalue()
        elif bits == 32:
            new = icon_dib(mark_png(side))
        else:
            new = None  # 16- and 256-colour variants: modern Windows never picks them
        if new is None or len(new) > size:
            left += 1
            continue
        out[off:off + size] = new + bytes(size - len(new))
        done += 1
    names = 0
    a = old_name.encode("utf-16-le")
    b = (name + "\0" * (len(old_name) - len(name))).encode("utf-16-le") if len(name) <= len(old_name) else None
    for kind, rname, off, size in res:
        if kind == RT_VERSION and b:
            block = bytes(out[off:off + size])
            names += block.count(a)
            out[off:off + size] = block.replace(a, b)
    return bytes(out), done, left, names


# Not "your organization's ..." (straight or curly apostrophe, whose first byte is E2) or "organization unit".
# The blocker of trackers and ads is Brave's "Shields". Here it carries the name of
# Gamblium's diamond, "Gamblide" (the owner's name for the mark and for this guard).
SHIELDS = [
    (re.compile(rb"Brave Shields"), b"%s"),
    (re.compile(rb"Shields are UP"), b"%s is ON"),
    (re.compile(rb"Shields are DOWN"), b"%s is OFF"),
    (re.compile(rb"try Shields down\b"), b"try switching %s off"),  # "try Gamblide off" read oddly (critique)
    (re.compile(rb"Shields (\$1)?[Uu]p\b"), b"%s \\1on"),
    (re.compile(rb"Shields (\$1)?[Dd]own\b"), b"%s \\1off"),
    (re.compile(rb"Shields to DOWN"), b"%s to OFF"),
    (re.compile(rb"Shields options are"), b"%s options are"),
    (re.compile(rb"\bShields can\b"), b"%s can"),
    (re.compile(rb"\bShields\b"), b"%s"),
]


def shields_name(raw, guard):
    """An interface string with Brave's "Shields" called by our guard's name."""
    if b"Shields" not in raw or len(raw) > 2000:
        return raw
    out = raw
    for pattern, to in SHIELDS:
        out = pattern.sub(to.replace(b"%s", guard.encode()), out)
    return out


# ---- 6. The settings menu's icon for the guard -----------------------------------
#
# The menu draws its icons as stencils in the text colour, so a selected or hovered entry can
# recolour them. Our mark is four facets in four greys; as a stencil it would be a flat kite.
# So each facet keeps the text colour and gets its own strength instead: the lightest facet
# is solid, the darker ones fainter. It reads as the mark on a dark and on a light menu.

MENU_ICON = re.compile(rb'<cr-icon icon="shield-done"></cr-icon>(\s*<span class="menu-label">\$i18n\{braveShieldsTitle\}</span>)')
MENU_MARK = b'data-gamblium="menu"'
MENU_SIZE, MENU_GAP = 20, 16  # the stock icons' box in that menu and their distance to the label, in px (measured, Brave 1.99.56)
_SHAPE = re.compile(r"""<path\b[^>]*?\bd\s*=\s*(["'])(?P<d>[^"']+)\1[^>]*?/>""")
_FILL = re.compile(r"""\bfill\s*=\s*(["'])#(?P<hex>[0-9a-fA-F]{6})\1""")


def facet_mark(svg, size=MENU_SIZE, gap=MENU_GAP):
    """The mark as inline SVG in the text colour, each filled path as strong as it is light.
    None when the mark is not made of filled paths (then the stock icon stays)."""
    box = re.search(r"""viewBox\s*=\s*["']([^"']+)""", svg)
    shapes = []
    for m in _SHAPE.finditer(svg):
        fill = _FILL.search(m.group(0))
        if not fill:
            return None
        r, g, b = (int(fill.group("hex")[i:i + 2], 16) / 255 for i in (0, 2, 4))
        shapes.append((m.group("d"), 0.2126 * r + 0.7152 * g + 0.0722 * b))
    if not box or not shapes or re.search(r"[`$\\]", svg):
        return None
    top = max(light for _, light in shapes) or 1
    paths = "".join(f'<path d="{" ".join(d.split())}" fill-opacity="{0.4 + 0.6 * light / top:.2f}"/>' for d, light in shapes)
    style = f"width:{size}px;height:{size}px;flex-shrink:0;margin-inline-end:{gap}px;pointer-events:none;vertical-align:top"
    return f'<svg {MENU_MARK.decode()} viewBox="{box.group(1)}" fill="currentColor" aria-hidden="true" style="{style}">{paths}</svg>'


OWN_DOWNLOADS = "chrome://newtab/#/settings#downloads"  # our Settings page, Downloads area, by its clean address

# (what, the text as Brave ships it, what it becomes, how the changed text is recognised)
SETTINGS_CHANGES = [
    ("menu icon", MENU_ICON, None, MENU_MARK),
    # The menu moves between pages inside the settings; one entry leaves them instead.
    ("downloads entry", re.compile(rb"(onIronActivate_\(event\)\{const path=event\.detail\.selected;)(?!if\(path===)"),
     b'\\1if(path==="/downloads"){window.location.href="%s";return}' % OWN_DOWNLOADS.encode(), b'if(path==="/downloads"){window.location.href='),
    # Drawn for any extension that supplies the new tab page. Ours is part of the browser.
    ("startup row", re.compile(rb"\$\{this\.ntpExtension_\?(html[$\w]*`\s*<extension-controlled-indicator)"),
     b"${false&&this.ntpExtension_?\\1", b"${false&&this.ntpExtension_?"),
    # Appearance > Theme: "Reset to default" took our theme off in one click (the shortcut puts it
    # back at the next start). Gamblium's own Settings > Appearance is where the look changes. Only
    # for our themes ("Gamblium <scheme>", branding/make_icons.py): a store theme keeps its way back.
    ("theme reset", re.compile(rb'\$\{this\.themeIdPref_\?\.value\?(html[$\w]*`\s*<div class="separator"></div>\s*<cr-button id="useDefault")'),
     b"${this.themeIdPref_?.value&&!/^Gamblium /.test(this.themeSublabel_)?\\1", b"!/^Gamblium /.test(this.themeSublabel_)?"),
    ("origin entry", re.compile(rb'(<a role="menuitem" id="origin" href="/origin" class="cr-nav-menu-item") \?hidden="\$\{[^"]*\}"'),
     b"\\1 hidden", b'<a role="menuitem" id="origin" href="/origin" class="cr-nav-menu-item" hidden>'),
]


GAMBLIUM_MARK = b"<!--gamblium-->"  # set into every change below, so a rerun knows it is done


def version_changes(version):
    """Changes that need Gamblium's own version (owner, Nov 13 2026): it is the version people see,
    Brave's sits under it, small. No Gamblium account exists, so its card goes. The private copy never
    updates itself, so the About page does not check for updates; it says how updates come."""
    v = re.sub(rb"[^0-9A-Za-z.+ -]", b"", version.encode()).strip()[:20]  # "1.0.0 beta 2", spaces kept
    small = b'style="font-size:11px;opacity:.7"'
    return [
        ("account card", re.compile(rb'(<template is="dom-if" if="\[\[accountState_\.loggedOut\]\]">)\s*<brave-account-row></brave-account-row>\s*(</template>)'),
         b"\\1" + GAMBLIUM_MARK + b"\\2", b'loggedOut]]">' + GAMBLIUM_MARK),
        ("sidebar version", re.compile(rb"v \$i18n\{braveProductVersion\}</span>"),
         b"Gamblium " + v + b"</span>" + GAMBLIUM_MARK + b'<span class="brave-about-item" ' + small + b">Brave $i18n{braveProductVersion}</span>",
         b"</span>" + GAMBLIUM_MARK + b'<span class="brave-about-item" ' + small),
        ("about page, update check", re.compile(rb'<div id="updateStatusMessage" \?hidden="\$\{!this\.showUpdateStatus_\}">'),
         b'<div id="updateStatusMessage" hidden>' + GAMBLIUM_MARK, b'<div id="updateStatusMessage" hidden>' + GAMBLIUM_MARK),
        ("about page, update icon", re.compile(rb'<div class="icon-container"(\s+)\?hidden="\$\{!this\.shouldShowIcons_\(\)\}">'),
         b'<div class="icon-container"\\1hidden><!--gamblium:icon-->', b"hidden><!--gamblium:icon-->"),
        ("about page, version", re.compile(rb'<div class="secondary">\$i18n\{aboutBrowserVersion\}</div>'),
         GAMBLIUM_MARK + b'<div style="font-size:15px;font-weight:600;line-height:1.5">Gamblium ' + v + b"</div>"
         # Not "secondary": Brave's own script turns the first .secondary after the update message into
         # its "Brave x.y.z" link and "Chromium: ..." line; those two are then drawn small.
         b'<div style="color:var(--cr-secondary-text-color)">Updates come with new Gamblium releases.</div>'
         b"<style>#release-notes,#release-notes~.secondary{font-size:11px;opacity:.75}</style>"
         b'<div class="secondary">$i18n{aboutBrowserVersion}</div>',
         GAMBLIUM_MARK + b'<div style="font-size:15px;font-weight:600;line-height:1.5">Gamblium '),
    ]


def gamblium_version(branding):
    """Gamblium's version: the extension's manifest beside branding/ (in the repository and in the
    installed app folder alike). None when it is not there."""
    try:
        m = json.loads((Path(branding).parent / "extension" / "manifest.json").read_text(encoding="utf8"))
        return m.get("version_name") or m["version"]
    except Exception:
        return None


def is_settings_script(body):
    return b"braveShieldsTitle" in body and b"onIronActivate_" in body and b"cr-nav-menu-item" in body


def settings_script(body, svg, version=None):
    """Brave's settings script with our changes. -> (new body, {what: "done" | "already ours" | why not})."""
    said = {}
    mark = facet_mark(svg)
    for what, pattern, to, changed in SETTINGS_CHANGES + (version_changes(version) if version else []):
        if changed in body:
            said[what] = "already ours"
        elif what == "menu icon" and mark is None:
            said[what] = "the mark is not made of filled paths; the stock icon stays"
        elif len(pattern.findall(body)) != 1:
            said[what] = f"not found once ({len(pattern.findall(body))} places); left as it is"
        else:
            body = pattern.sub((lambda m: mark.encode() + m.group(1)) if to is None else to, body)
            said[what] = "done"
    return body, said


BY_ORG = re.compile(rb"by your organization(?![\w'\xe2]| unit)")


def managed_by(raw, name):
    """An interface string with "by your organization" turned into "by <name>". Phrases such as
    "your organization's policies" and longer texts are left as they are."""
    if len(raw) > 70 or b"by your organization" not in raw:
        return raw
    return BY_ORG.sub(b"by " + name.encode(), raw)


def forget_old_name(programs, name, log=print):
    """Windows remembers a program's display name and icon by its path the first time it runs.
    Task Manager shows that memory, not the file. Write the new name there and tell the shell the
    icons changed. Per user, no admin rights. -> number of names set."""
    if sys.platform != "win32":
        return 0
    import ctypes
    import winreg

    n = 0
    key = r"Software\Classes\Local Settings\Software\Microsoft\Windows\Shell\MuiCache"
    try:
        with winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER, key, 0, winreg.KEY_SET_VALUE) as k:
            for exe in programs:
                winreg.SetValueEx(k, f"{exe}.FriendlyAppName", 0, winreg.REG_SZ, name)
                n += 1
    except OSError as e:
        log(f"the name Windows remembers could not be changed ({e})")
    shell = ctypes.windll.shell32
    for exe in programs:
        shell.SHChangeNotify(0x00002000, 0x0005, ctypes.c_wchar_p(str(exe)), None)  # this file changed
    shell.SHChangeNotify(0x08000000, 0x0000, None, None)  # icons may have changed everywhere
    log(f"Windows told to forget the old name and icon of {n} program(s)")
    return n


# ---- main ---------------------------------------------------------------------------


def run(folder, branding, check=False, log=print, name="Gamblium", guard="Gamblide"):
    ver = find_version_folder(folder)
    refuse_installed(ver)
    art = Branding(branding)
    report = dict(folder=str(ver), welcome=[], vector=[], program=[])

    pack_path = ver / "brave_resources.pak"
    if pack_path.is_file():
        pk = P.read(pack_path)
        for rid, raw in sorted(pk["res"].items()):
            if is_big_lion(raw):
                pk["res"][rid] = mark_webp(raw, art)
                report["welcome"].append(rid)
        # The private and Tor windows' page: its script is packed with gzip.
        report["private page"] = []
        report["private page colours"] = 0
        for rid, raw in sorted(pk["res"].items()):
            if P.kind(raw) != "gzip":
                continue
            body = P.inflate(raw)
            if PRIVATE_LOGO not in body and PRIVATE_PAGE_MARK not in body:
                continue
            changed, n = private_logo(body, art.svg["lockup-" + art.light_letters])
            changed, c = private_colours(changed)
            if n or c:
                pk["res"][rid] = gzip.compress(changed, mtime=0)
            if n:
                report["private page"].append(rid)
            report["private page colours"] += c
        if (report["welcome"] or report["private page"] or report["private page colours"]) and not check:
            write_atomic(pack_path, P.to_bytes(pk))
    log(f"welcome page lion: {len(report['welcome'])} image(s)")

    report["private tab icon"] = []
    for scale in ("brave_100_percent.pak", "brave_200_percent.pak"):
        path = ver / scale
        if not path.is_file():
            continue
        pk = P.read(path)
        hits = [rid for rid, raw in sorted(pk["res"].items()) if is_line_lion(raw)]
        for rid in hits:
            pk["res"][rid] = mark_png_bytes(pk["res"][rid], art)
            report["private tab icon"].append(f"{scale}:{rid}")
        art_hits = [rid for rid, raw in sorted(pk["res"].items()) if is_tor_frame_art(raw)]
        for rid in art_hits:
            pk["res"][rid] = house_art(pk["res"][rid])
            report.setdefault("Tor frame art", []).append(f"{scale}:{rid}")
        hits += art_hits
        if hits and not check:
            write_atomic(path, P.to_bytes(pk))
    log(f"private tab icon: {len(report['private tab icon'])} picture(s)")
    log(f"Tor frame art: {len(report.get('Tor frame art', []))} picture(s) in our look")
    log(f"private and Tor page logo: {len(report.get('private page', []))} replaced" if report.get("private page") else "private and Tor page logo: not found (already ours, or a different Brave); left alone")
    log(f"private and Tor page colours (magnifier, note): {report.get('private page colours', 0)} replaced")

    dll = ver / "chrome.dll"
    if dll.is_file():
        data = dll.read_bytes()
        new, notes = patch_dll(data, art.svg["mark-small"], art.svg["mark"])
        # Brave's own three-line button wears our four pips and is THE menu (owner, Nov 13 2026:
        # the empty square of Nov 12 read as a broken button). It cannot be taken out from outside,
        # and its menu holds what ours cannot (find, print, developer tools). Our own toolbar button
        # shows Gamblium's mark instead and opens on the site in front of you.
        new, menu_notes = patch_menu_button(new)
        report["vector"] = notes
        new, hide_notes = hide_menu_button(new)
        new, puzzle_notes = puzzle_first(new)
        hide_notes += puzzle_notes
        report["menu button"] = menu_notes + hide_notes
        for line in hide_notes:
            log(line)
        new, report["private colours"] = patch_private_colours(new)
        for line in report["private colours"]:
            log(line)
        new, report["primary colours"] = patch_primary_colours(new)
        new, google = patch_google_blue(new)
        report["primary colours"] += google
        for line in report["primary colours"]:
            log(line)
        new, report["question"] = silence_question(new)
        log(report["question"])
        if new != data and not check:
            write_atomic(dll, new)
    # brave.exe sits one folder up, beside the version folder. The window's own
    # icon (and so the taskbar button) comes from a second set inside chrome.dll.
    programs = [ver.parent / "brave.exe", ver.parent / "chrome_proxy.exe", ver / "chrome.dll", *sorted(ver.glob("*.exe"))]
    for exe in programs:
        if not exe.is_file():
            continue
        try:
            new, done, left, names = patch_exe(exe.read_bytes(), art.mark_png, name, lions_only=exe.parent == ver)
        except (ValueError, struct.error) as e:
            log(f"{exe.name}: icon and name not changed ({e})")
            continue
        report["program"].append(dict(file=exe.name, icons=done, icons_left=left, names=names))
        log(f"{exe.name}: {done} icon image(s) and {names} name(s) now ours ({left} low-colour image(s) left)")
        if (done or names) and not check:
            # A virus scanner often holds a freshly copied program for a moment; try a few times.
            for attempt in range(8):
                try:
                    write_atomic(exe, new)
                    break
                except OSError:
                    if attempt == 7:
                        raise
                    time.sleep(1.5)
    if not check:
        report["remembered"] = forget_old_name([p for p in programs if p.suffix == ".exe" and p.is_file()], name, log)

    # 4. Brave asks once per profile whether to keep an extension's new tab page.
    # After the renaming its title read "Change back to Gamblium?", which makes
    # no sense when the page in question is Gamblium's own.
    asked = f"Change back to {name}?".encode()
    better = f"Keep {name}'s new tab page?".encode()
    for pack in sorted((ver / "Locales").glob("en-*.pak")) if (ver / "Locales").is_dir() else []:
        pk = P.read(pack)
        hits = [rid for rid, raw in pk["res"].items() if raw == asked]
        for rid in hits:
            pk["res"][rid] = better
        # "Managed by your organization": the settings that switch Brave's extras off were set by
        # Gamblium, not by an employer, so say that.
        for rid, raw in list(pk["res"].items()):
            new = shields_name(managed_by(raw, name), guard)
            if new != raw:
                pk["res"][rid] = new
                hits.append(rid)
        if hits and not check:
            write_atomic(pack, P.to_bytes(pk))
        if hits:
            report["reworded"] = report.get("reworded", 0) + len(hits)
    log(f"new-tab question reworded in {report.get('reworded', 0)} place(s)")

    # 6. Brave's settings pages.
    report["settings"] = {}
    pack_path = ver / "resources.pak"
    if pack_path.is_file():
        pk = P.read(pack_path)
        for rid, raw in sorted(pk["res"].items()):
            if P.kind(raw) != "gzip" or len(raw) < 100_000:
                continue
            body = P.inflate(raw)
            if not is_settings_script(body):
                continue
            new, report["settings"] = settings_script(body, art.svg["mark-small"], gamblium_version(branding))
            if new != body and not check:
                pk["res"][rid] = gzip.compress(new, mtime=0)
                write_atomic(pack_path, P.to_bytes(pk))
            break
    # 7. The browser's own PDF viewer page starts Gamblium PDF (pdf_loader.js); the address bar
    #    keeps the PDF's address and the browser's viewer stays as the fallback.
    report["pdf"] = builtin_pdf(ver, check, log)

    for what, said in report["settings"].items():
        log(f"settings, {what}: {said}")
    if not report["settings"]:
        log("settings script not found in resources.pak")
    for n in report["vector"]:
        log(n)
    if not report["vector"]:
        log("vector lion: none found (already replaced, or Brave's drawing has changed)")
    return 0, report


PDF_LOADER = Path(__file__).with_name("pdf_loader.js")
PDF_MARK = b"Gamblium PDF loader"
BUILTIN_PDF = "gamblium-pdf-builtin"


def is_pdf_main(body):
    """The PDF viewer page's start script (main.js), as Brave ships it or as we wrote it."""
    return PDF_MARK in body or (b"import './pdf_viewer_wrapper.js';" in body and b"createBrowserApi" in body and b"function main()" in body and b"Print Preview" not in body)


def pdf_index(body):
    """The viewer page without its own start of the browser's viewer (the loader imports it
    when it steps aside)."""
    return body.replace(b'<script type="module" src="pdf_viewer_wrapper.js"></script>\n', b"").replace(b'<script type="module" src="pdf_viewer_wrapper.js"></script>', b"")


def builtin_pdf(ver, check=False, log=print):
    """Points the browser's PDF viewer page at Gamblium PDF. Found by content, not by number
    (numbers change with every Brave version). Leaves BUILTIN_PDF in the version folder."""
    pack_path = ver / "resources.pak"
    if not pack_path.is_file():
        log("PDF viewer: resources.pak not found")
        return "no pack"
    pk = P.read(pack_path)
    main_id = index_id = None
    for rid, raw in pk["res"].items():
        if P.kind(raw) != "gzip" or len(raw) > 20_000:
            continue
        body = P.inflate(raw)
        if is_pdf_main(body):
            main_id = rid
        elif b'<pdf-viewer id="viewer"></pdf-viewer>' in body:
            index_id = rid
    if main_id is None or index_id is None:
        log("PDF viewer: its page was not found (Brave changed it?); PDFs go through the extension")
        (ver / BUILTIN_PDF).unlink(missing_ok=True) if not check else None
        return "not found"
    loader = PDF_LOADER.read_bytes().replace(b"\r\n", b"\n")
    index = pdf_index(P.inflate(pk["res"][index_id]))
    changed = P.inflate(pk["res"][main_id]) != loader or P.inflate(pk["res"][index_id]) != index
    if not check:
        if changed:
            pk["res"][main_id] = gzip.compress(loader, mtime=0)
            pk["res"][index_id] = gzip.compress(index, mtime=0)
            write_atomic(pack_path, P.to_bytes(pk))
        (ver / BUILTIN_PDF).write_text("the PDF viewer page starts Gamblium PDF (tools/rebrand/pdf_loader.js)\n", encoding="utf-8")
    log(f"PDF viewer: {'Gamblium PDF built in' if changed else 'already Gamblium PDF'} (resources {main_id}, {index_id})")
    return "built in" if changed else "already"


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("folder")
    ap.add_argument("--branding", default=str(Path(__file__).resolve().parents[2] / "branding"))
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--json", action="store_true")
    # For packages (release builds): every chrome.dll change must have been made, or the run fails.
    # A package built on another Brave once shipped with Brave's menu showing and our button in the
    # wrong place, because two changes found nothing and were left out quietly (Nov 14 2026).
    ap.add_argument("--strict", action="store_true")
    a = ap.parse_args(argv)
    log = (lambda *x: print(*x, file=sys.stderr)) if a.json else print
    try:
        code, report = run(Path(a.folder), Path(a.branding), check=a.check, log=log)
    except Refused as e:
        print(f"refused: {e}", file=sys.stderr)
        return 2
    if a.json:
        print(json.dumps(report))
    if a.strict and code == 0:
        missed = strict_misses(report)
        if missed:
            for m in missed:
                print(f"strict: not done: {m}", file=sys.stderr)
            return 4
    return code


def strict_misses(report):
    """The chrome.dll changes a package must have, that this run did not make."""
    missed = [n for n in report.get("menu button", []) if "left alone" in n or "not hidden" in n]
    q = report.get("question", "")
    if q and "silenced at" not in q:
        missed.append(q)
    if not any(": our mark" in n for n in report.get("vector", [])):
        missed.append("toolbar lion drawings: none replaced")
    return missed


if __name__ == "__main__":
    sys.exit(main())

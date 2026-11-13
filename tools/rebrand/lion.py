"""Recognises Brave's lion by its outline, in PNG pixels and in SVG paths.

Nothing here knows a resource id. A shape is reduced to its filled outline,
stretched to a GRID x GRID bitmap, and compared with the reference outline
below (overlap divided by union). The colour lion and the grey lion have the
same filled outline, so one reference finds both.

An outline alone is not enough: a plain shield icon scores up to 0.93 and the
lion at 16 px only 0.94. So each match needs a second proof:
  - PNG: the light parts inside the outline must look like the lion's face;
  - SVG: the paths inside the outline must carry the face's detail (a plain
    shield is a few hundred characters of path data, the lion thousands).
Next to a lion, the letters "brave" are recognised the same way, so that a
lockup can be told from "rewards" or "wallet" set beside the lion.

    python lion.py learn <lion.png>        prints REFERENCE and FACE for the art in that PNG
    python lion.py learn-word <lockup.png> prints WORD for the letters right of the lion
"""
import io
import math
import re
import sys

from PIL import Image, ImageDraw

GRID = 24
# Filled outline of Brave's lion head: GRID rows of GRID bits, as hex, plus width / height.
REFERENCE = "01ff8003ffc03ffffc7ffffeffffff7fffffffffffffffffffffffffffff7fffff7ffffe7ffffe3ffffc3ffffc3ffffc3ffffc1ffff81ffff80ffff007ffe001ff80007e00003800"
REFERENCE_ASPECT = 0.84
# Face of the lion: the light cells inside the outline, same grid.
FACE = "00000000000000000000000007ffe00ffff01e3c781fb9f81ffff80fbdf007bde00383c003e7c003e7c003c3c0003c0000ff00007e00001800000000000000000000000000000000"
# The letters "brave" with their holes filled: WORD_H rows of WORD_W bits. Set by `learn-word`.
WORD_W, WORD_H = 48, 16
WORD = "e00000000000e00000000000e00000000000e00000000000ef1d9f6e0c7cff9fbfe61dfeffdfbfe71dfeffdc7fe71bffffdc7fe73bffffdc7fe33bffffdc7fe3b3ffffdc7fe3b380ffdc7fe1f187ffdc3fe1e1feff9c1fe1e0fcce1c0e60e078"
MATCH_PNG = 0.935  # outline overlap / union needed in pixels (16 px lions reach 0.94, shields 0.93 at most elsewhere)
MATCH_SVG = 0.945  # in paths, lions score 0.957 and up, shields 0.934 and below
FACE_MATCH = 0.60  # lions 0.68 and up; a shield with a letter in it 0.32
SVG_DETAIL = 1500  # characters of path data inside the outline; lions 1900 and up
WORD_MATCH = 0.75
ASPECT_SLACK = 0.16


def _bits(mask, size=(GRID, GRID)):
    """A cropped 'L' mask -> bits as an int, row by row."""
    small = mask.resize(size, Image.BOX)
    n = 0
    for v in small.getdata():
        n = (n << 1) | (1 if v >= 128 else 0)
    return n


def likeness(mask):
    """How much a cropped filled mask looks like the lion, 0..1. 0 when the proportions are off."""
    w, h = mask.size
    if w < 8 or h < 8 or abs(w / h - REFERENCE_ASPECT) > ASPECT_SLACK:
        return 0.0
    a, b = _bits(mask), int(REFERENCE, 16)
    union = (a | b).bit_count()
    return (a & b).bit_count() / union if union else 0.0


def filled(alpha):
    """Alpha channel -> 'L' mask of everything that is not reachable from outside: shapes with their holes filled."""
    w, h = alpha.size
    solid = alpha.point(lambda v: 255 if v >= 96 else 0)
    padded = Image.new("L", (w + 2, h + 2), 0)
    padded.paste(solid, (1, 1))
    ImageDraw.floodfill(padded, (0, 0), 128)
    return padded.point(lambda v: 0 if v == 128 else 255).crop((1, 1, w + 1, h + 1))


def blobs(mask):
    """Boxes of the separate shapes in a filled mask, split where a whole column is empty."""
    w, h = mask.size
    out, start = [], None
    cols = mask.resize((w, 1), Image.BOX).tobytes() if h > 1 else mask.tobytes()
    # BOX averaging can round a single faint pixel to 0, so confirm empties with getbbox.
    for x in range(w + 1):
        used = x < w and (cols[x] > 0 or mask.crop((x, 0, x + 1, h)).getbbox() is not None)
        if used and start is None:
            start = x
        elif not used and start is not None:
            box = mask.crop((start, 0, x, h)).getbbox()
            out.append((start, box[1], x, box[3]))
            start = None
    return out


def _overlap(a, b):
    union = (a | b).bit_count()
    return (a & b).bit_count() / union if union else 0.0


def face_bits(im, box):
    """Inside the filled outline of `box`: the cells lighter than the middle of the shape's own range."""
    crop = im.crop(box)
    white = Image.new("RGBA", crop.size, (255, 255, 255, 255))
    white.alpha_composite(crop)
    lum = list(white.convert("L").getdata())
    inside = list(filled(crop.getchannel("A")).getdata())
    vals = [v for v, m in zip(lum, inside) if m]
    if not vals:
        return 0
    mid = (min(vals) + max(vals)) / 2
    light = Image.new("L", crop.size, 0)
    light.putdata([255 if (m and v > mid) else 0 for v, m in zip(lum, inside)])
    return _bits(light)


def word_likeness(mask):
    """How much a cropped filled mask looks like the letters "brave", 0..1."""
    if not WORD or mask.width < 12 or mask.height < 5:
        return 0.0
    return _overlap(_bits(mask, (WORD_W, WORD_H)), int(WORD, 16))


def find_in_png(png_bytes):
    """-> None, or dict(box=(x0, y0, x1, y1) of the lion, score, face, word (likeness of what stands
    right of it to "brave"), rest=(box of everything right of it, or None), near (True when only the
    outline matched), size, image)."""
    im = Image.open(io.BytesIO(png_bytes))
    if im.width * im.height > 1_200_000 or im.width < 10 or im.height < 10:
        return None
    im = im.convert("RGBA")
    mask = filled(im.getchannel("A"))
    best = None
    for box in blobs(mask):
        s = likeness(mask.crop(box))
        if s >= MATCH_PNG and (best is None or s > best[1]):
            best = (box, s)
    if not best:
        return None
    box, score = best
    face = _overlap(face_bits(im, box), int(FACE, 16))
    out = dict(box=box, score=score, face=face, word=0.0, rest=None, near=face < FACE_MATCH, size=im.size, image=im)
    right = mask.crop((box[2], 0, im.width, im.height))
    rb = right.getbbox()
    if rb:
        out["rest"] = (box[2] + rb[0], rb[1], box[2] + rb[2], rb[3])
        out["word"] = word_likeness(right.crop(rb))
    return out


# ---- SVG paths -----------------------------------------------------------------

_NUM = re.compile(r"[\s,]*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)")
_CMD = re.compile(r"[\s,]*([MmLlHhVvCcSsQqTtAaZz])")
_FLAG = re.compile(r"[\s,]*([01])")


def _arc(x1, y1, rx, ry, phi, large, sweep, x2, y2, steps=12):
    """Points along an SVG arc (endpoint form), end point included."""
    if rx == 0 or ry == 0 or (x1 == x2 and y1 == y2):
        return [(x2, y2)]
    rx, ry, phi = abs(rx), abs(ry), math.radians(phi)
    c, s = math.cos(phi), math.sin(phi)
    dx, dy = (x1 - x2) / 2, (y1 - y2) / 2
    xp, yp = c * dx + s * dy, -s * dx + c * dy
    lam = xp * xp / (rx * rx) + yp * yp / (ry * ry)
    if lam > 1:
        rx, ry = rx * math.sqrt(lam), ry * math.sqrt(lam)
    num = rx * rx * ry * ry - rx * rx * yp * yp - ry * ry * xp * xp
    den = rx * rx * yp * yp + ry * ry * xp * xp
    k = math.sqrt(max(0.0, num / den)) if den else 0.0
    if large == sweep:
        k = -k
    cxp, cyp = k * rx * yp / ry, -k * ry * xp / rx
    cx, cy = c * cxp - s * cyp + (x1 + x2) / 2, s * cxp + c * cyp + (y1 + y2) / 2
    a1 = math.atan2((yp - cyp) / ry, (xp - cxp) / rx)
    a2 = math.atan2((-yp - cyp) / ry, (-xp - cxp) / rx)
    da = a2 - a1
    if sweep and da < 0:
        da += 2 * math.pi
    elif not sweep and da > 0:
        da -= 2 * math.pi
    pts = []
    for i in range(1, steps + 1):
        a = a1 + da * i / steps
        pts.append((cx + rx * math.cos(a) * c - ry * math.sin(a) * s, cy + rx * math.cos(a) * s + ry * math.sin(a) * c))
    pts[-1] = (x2, y2)
    return pts


def path_polygons(d):
    """An SVG path's `d` -> list of subpaths, each a list of (x, y). Curves are flattened."""
    pos = 0

    def num():
        nonlocal pos
        m = _NUM.match(d, pos)
        if not m:
            raise ValueError("number expected")
        pos = m.end()
        return float(m.group(1))

    def flag():
        nonlocal pos
        m = _FLAG.match(d, pos)
        if not m:
            raise ValueError("flag expected")
        pos = m.end()
        return int(m.group(1))

    subs, cur = [], []
    x = y = sx = sy = 0.0
    last_ctrl, last_cmd, cmd = None, "", ""
    try:
        while True:
            m = _CMD.match(d, pos)
            if m:
                cmd = m.group(1)
                pos = m.end()
            elif not _NUM.match(d, pos):
                break
            elif cmd in "Mm":
                cmd = "L" if cmd == "M" else "l"  # extra pairs after a move are lines
            elif cmd in "Zz" or not cmd:
                break
            rel = cmd.islower()
            c = cmd.upper()
            ox, oy = (x, y) if rel else (0.0, 0.0)
            if c == "M":
                if cur:
                    subs.append(cur)
                x, y = ox + num(), oy + num()
                sx, sy, cur = x, y, [(x, y)]
            elif c == "Z":
                x, y = sx, sy
                if cur:
                    subs.append(cur)
                cur = [(x, y)]
            elif c == "L":
                x, y = ox + num(), oy + num()
                cur.append((x, y))
            elif c == "H":
                x = ox + num()
                cur.append((x, y))
            elif c == "V":
                y = oy + num()
                cur.append((x, y))
            elif c in "CS":
                if c == "C":
                    x1, y1 = ox + num(), oy + num()
                else:
                    x1, y1 = (2 * x - last_ctrl[0], 2 * y - last_ctrl[1]) if last_cmd in "CS" and last_ctrl else (x, y)
                x2, y2, x3, y3 = ox + num(), oy + num(), ox + num(), oy + num()
                for i in range(1, 9):
                    t = i / 8
                    u = 1 - t
                    cur.append((u * u * u * x + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3, u * u * u * y + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3))
                last_ctrl, x, y = (x2, y2), x3, y3
            elif c in "QT":
                if c == "Q":
                    x1, y1 = ox + num(), oy + num()
                else:
                    x1, y1 = (2 * x - last_ctrl[0], 2 * y - last_ctrl[1]) if last_cmd in "QT" and last_ctrl else (x, y)
                x2, y2 = ox + num(), oy + num()
                for i in range(1, 7):
                    t = i / 6
                    u = 1 - t
                    cur.append((u * u * x + 2 * u * t * x1 + t * t * x2, u * u * y + 2 * u * t * y1 + t * t * y2))
                last_ctrl, x, y = (x1, y1), x2, y2
            elif c == "A":
                rx, ry, phi = num(), num(), num()
                large, sweep = flag(), flag()
                x2, y2 = ox + num(), oy + num()
                cur.extend(_arc(x, y, rx, ry, phi, large, sweep, x2, y2))
                x, y = x2, y2
            last_cmd = c
    except ValueError:
        pass  # a path we cannot read simply ends where it broke
    if len(cur) > 1:
        subs.append(cur)
    return [s for s in subs if len(s) >= 3]


def polygons_box(polys):
    xs = [p[0] for poly in polys for p in poly]
    ys = [p[1] for poly in polys for p in poly]
    return min(xs), min(ys), max(xs), max(ys)


def polygons_mask(polys, height):
    """Every subpath filled (holes too), drawn `height` px high at its own proportions. -> 'L' mask or None."""
    if not polys:
        return None
    x0, y0, x1, y1 = polygons_box(polys)
    w, h = x1 - x0, y1 - y0
    if w <= 0 or h <= 0:
        return None
    W = max(8, min(4096, round(height * w / h)))
    im = Image.new("L", (W, height), 0)
    draw = ImageDraw.Draw(im)
    for poly in polys:
        draw.polygon([((px - x0) / w * (W - 1), (py - y0) / h * (height - 1)) for px, py in poly], fill=255)
    return im


def polygons_likeness(polys):
    """Likeness of a path's filled outline to the lion, 0..1."""
    mask = polygons_mask(polys, GRID * 3)
    return likeness(mask) if mask else 0.0


_PATH = re.compile(r"<path\b[^>]*?(?:/>|>\s*</path>)", re.S)
_D = re.compile(r"""\bd\s*=\s*(["'])(.*?)\1""", re.S)


def find_in_svg(text):
    """-> None, or dict(box=(x0, y0, x1, y1) of the lion in user units, score, detail (characters of
    path data inside it), parts=[(start, end) spans of the lion's own <path> elements],
    others=[(start, end, box) of the remaining paths], word (likeness of the paths right of the
    lion to "brave"), rest=(box of those paths, or None), near (True when only the outline matched))."""
    paths = []
    for m in _PATH.finditer(text):
        d = _D.search(m.group(0))
        if not d:
            continue
        polys = path_polygons(d.group(2))
        if polys:
            paths.append((m.start(), m.end(), polys, polygons_box(polys)))
    best = None
    for start, end, polys, box in paths:
        s = polygons_likeness(polys)
        if s >= MATCH_SVG and (best is None or s > best[0]):
            best = (s, box)
    if not best:
        return None
    score, (x0, y0, x1, y1) = best
    pad = 0.02 * max(x1 - x0, y1 - y0)
    inside = lambda b: b[0] >= x0 - pad and b[1] >= y0 - pad and b[2] <= x1 + pad and b[3] <= y1 + pad  # noqa: E731
    parts = [(s, e) for s, e, _, b in paths if inside(b)]
    others = [(s, e, b) for s, e, _, b in paths if not inside(b)]
    detail = sum(len(_D.search(text[s:e]).group(2)) for s, e in parts)
    out = dict(box=(x0, y0, x1, y1), score=score, detail=detail, parts=parts, others=others, word=0.0, rest=None, near=detail < SVG_DETAIL)
    right = [polys for _, _, polys, b in paths if b[0] >= x1 - pad and not inside(b)]
    if right:
        flat = [poly for polys in right for poly in polys]
        out["rest"] = polygons_box(flat)
        mask = polygons_mask(flat, WORD_H * 4)
        if mask:
            out["word"] = word_likeness(mask)
    return out


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "learn":
        img = Image.open(sys.argv[2]).convert("RGBA")
        m = filled(img.getchannel("A"))
        box = m.getbbox()
        crop = m.crop(box)
        print(f'REFERENCE = "{_bits(crop):0{GRID * GRID // 4}x}"')
        print(f"REFERENCE_ASPECT = {crop.width / crop.height:.2f}")
        print(f'FACE = "{face_bits(img, box):0{GRID * GRID // 4}x}"')
    elif len(sys.argv) == 3 and sys.argv[1] == "learn-word":
        img = Image.open(sys.argv[2]).convert("RGBA")
        m = filled(img.getchannel("A"))
        lion_box = max(blobs(m), key=lambda b: likeness(m.crop(b)))
        right = m.crop((lion_box[2], 0, img.width, img.height))
        print(f'WORD = "{_bits(right.crop(right.getbbox()), (WORD_W, WORD_H)):0{WORD_W * WORD_H // 4}x}"')
    else:
        print(__doc__)

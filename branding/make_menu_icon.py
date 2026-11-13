"""Draws the toolbar's menu button from branding/menu-button.svg into extension/ui/icons.

The button is ours to design: change the SVG (filled straight-edged paths only), run
`python branding/make_menu_icon.py`, and the extension shows the new drawing. Three inks are
made, because a toolbar can be dark, light, or follow the system: light ink for dark
toolbars, dark ink for light ones, and a middle grey that reads on both.
Needs Pillow.
"""
import pathlib
import re

from PIL import Image, ImageDraw

HERE = pathlib.Path(__file__).resolve().parent
OUT = HERE.parent / "extension" / "ui" / "icons"
INKS = {"light": (228, 230, 235), "dark": (27, 29, 34), "mid": (132, 140, 156)}
SIZES = (16, 32)
OVER = 8  # drawn this many times bigger, then scaled down, for smooth edges


def polygons(svg):
    """-> ([[(x, y), ...], ...], view box side). Only M/L/Z paths are understood."""
    box = [float(v) for v in re.search(r'viewBox="([-\d.\s]+)"', svg).group(1).split()]
    shapes = []
    for d in re.findall(r'<path\b[^>]*\bd="([^"]+)"', svg):
        if re.search(r"[^MLZmlz\d\s.,-]", d) or re.search(r"[ml]", d):
            raise SystemExit(f"menu-button.svg: only absolute M, L and Z are understood, not: {d}")
        nums = [float(n) for n in re.findall(r"-?\d+(?:\.\d+)?", d)]
        shapes.append([(nums[i] - box[0], nums[i + 1] - box[1]) for i in range(0, len(nums), 2)])
    return shapes, max(box[2], box[3])


def draw(shapes, side, size, ink):
    big = size * OVER
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    pen = ImageDraw.Draw(img)
    for poly in shapes:
        pen.polygon([(x * big / side, y * big / side) for x, y in poly], fill=(*ink, 255))
    return img.resize((size, size), Image.LANCZOS)


def facets(svg):
    """-> one strength (0..1) per path of the mark: its fill's brightness, so the one-ink drawing keeps the facets."""
    fills = re.findall(r'<path\b[^>]*\bfill="#([0-9A-Fa-f]{6})"', svg)
    light = [sum(int(f[i:i + 2], 16) for i in (0, 2, 4)) / 765 for f in fills]
    top = max(light)
    return [0.35 + 0.65 * (v / top) for v in light]


def draw_mark(shapes, strengths, side, size, ink):
    big = size * OVER
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    for poly, k in zip(shapes, strengths):
        layer = Image.new("RGBA", (big, big), (0, 0, 0, 0))
        ImageDraw.Draw(layer).polygon([(x * big / side, y * big / side) for x, y in poly], fill=(*ink, round(255 * k)))
        img = Image.alpha_composite(img, layer)
    return img.resize((size, size), Image.LANCZOS)


def main():
    shapes, side = polygons((HERE / "menu-button.svg").read_text(encoding="utf-8"))
    for name, ink in INKS.items():
        for size in SIZES:
            draw(shapes, side, size, ink).save(OUT / f"menu-{name}-{size}.png")
    print(f"menu button: {len(shapes)} shapes, {len(INKS) * len(SIZES)} pictures in {OUT}")
    # Our own toolbar button (since Nov 13 2026): Gamblium's mark in one ink, facets kept by strength.
    svg = (HERE / "gamblium-mark-small.svg").read_text(encoding="utf-8")
    shapes, side = polygons(svg)
    strengths = facets(svg)
    for name, ink in INKS.items():
        for size in SIZES:
            draw_mark(shapes, strengths, side, size, ink).save(OUT / f"mark-{name}-{size}.png")
    print(f"toolbar mark: {len(shapes)} facets, {len(INKS) * len(SIZES)} pictures in {OUT}")


if __name__ == "__main__":
    main()

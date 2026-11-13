"""Builds the whole Gamblium identity from one colour file.

    python branding/make_icons.py

Reads   branding/palette.json               every colour, per scheme
Writes  for the default scheme
          branding/gamblium-mark.svg         full mark, 48 px and larger
          branding/gamblium-mark-small.svg   simplified mark, 16-32 px
          branding/gamblium-wordmark-{dark,light}.svg
          branding/gamblium-lockup-{dark,light}.svg   mark + wordmark
          branding/png/                      icons 16-512, lockups, contact sheet
          branding/gamblium.ico              16-256 in one file
          extension/ui/icons/                the extension's icons
          extension/ui/brand/                mark and lockups for our pages
        for every other scheme the same set in branding/schemes/<name>/
        for all schemes
          extension/ui/tokens.css            CSS variables for our pages
          extension/ui/tint-<scheme>.css     experimental tint for forced-dark sites
          presets/theme-<scheme>-<mode>.json whole-browser theme (prefs only)
          docs/design/brand/schemes.png      the schemes side by side

The mark is a cut diamond: four facets with thin gaps, like cut glass (the
owner's choice, Nov 12 2026). Every shape is a polygon, an arc, a bar or a disc,
described once (`mark_shapes`, `word_shapes`) and then written as SVG and drawn
with Pillow, so the vector and raster versions cannot drift apart.

"dark" and "light" always name the background the artwork sits on.
"""

import json
from math import cos, radians, sin
from pathlib import Path

from PIL import Image, ImageDraw

HERE = Path(__file__).parent
ROOT = HERE.parent
PALETTE = json.loads((HERE / "palette.json").read_text(encoding="utf-8"))
SCHEMES = PALETTE["schemes"]
DEFAULT = PALETTE["default"]
MODES = ("dark", "light")
TOKENS = ("bg", "surface", "surface-raised", "border", "text", "text-muted", "accent", "accent-strong", "on-accent", "highlight", "danger")


def colour(scheme, name):
    """A raw colour of a scheme by name; hex values pass through."""
    return SCHEMES[scheme]["color"].get(name, name)


def token(scheme, mode, name):
    """A semantic token ("text", "accent") of a scheme as a hex colour."""
    return colour(scheme, SCHEMES[scheme][mode][name])


# ---------------------------------------------------------------- shapes
# A shape is one of:
#   ("disc", cx, cy, r, colour)
#   ("arc",  cx, cy, r, a0, a1, width, colour)   r = centre-line radius; angles in
#                                                degrees, clockwise from 3 o'clock
#   ("bar",  x0, y0, x1, y1, colour)             axis-aligned rectangle

#   ("poly", [(x, y), ...], colour)             filled polygon

# The mark is a cut diamond: four facets with thin gaps between them, like cut
# glass. Chosen by the owner (Nov 12 2026) from the second sheet of proposals, D6 (the sheets are in the git history under branding/proposals).
# top / side / bottom are the kite's corners on the 256 grid; gap is half the
# width of the cut between facets (0 for the small sizes, where it would blur).
MARKS = {
    "full": dict(top=5, bottom=251, left=31, right=225, waist=108, gap=4.0),
    "small": dict(top=2, bottom=254, left=22, right=234, waist=108, gap=0.0),
}
MARK_W = MARKS["full"]["right"] - MARKS["full"]["left"]


def mark_shapes(scheme, v, ox=0, oy=0, k=1.0):
    """The mark in a scheme's colours, optionally moved and scaled (for the lockup)."""
    m = {part: colour(scheme, name) for part, name in SCHEMES[scheme]["mark"].items()}
    t, b, l, r, w, g = v["top"], v["bottom"], v["left"], v["right"], v["waist"], v["gap"]
    cx = (l + r) / 2
    shapes = [
        ("poly", [(cx - g, t + 2.2 * g), (cx - g, w - g), (l + 2.4 * g, w - g)], m["tl"]),
        ("poly", [(cx + g, t + 2.2 * g), (r - 2.4 * g, w - g), (cx + g, w - g)], m["tr"]),
        ("poly", [(l + 1.6 * g, w + g), (cx - g, w + g), (cx - g, b - 3 * g)], m["bl"]),
        ("poly", [(cx + g, w + g), (r - 1.6 * g, w + g), (cx + g, b - 3 * g)], m["br"]),
    ]
    return [place(s, ox, oy, k) for s in shapes]


def place(s, ox, oy, k):
    kind = s[0]
    if kind == "poly":
        return ("poly", [(ox + x * k, oy + y * k) for x, y in s[1]], s[2])
    if kind == "disc":
        return ("disc", ox + s[1] * k, oy + s[2] * k, s[3] * k, s[4])
    if kind == "arc":
        return ("arc", ox + s[1] * k, oy + s[2] * k, s[3] * k, s[4], s[5], s[6] * k, s[7])
    return ("bar", ox + s[1] * k, oy + s[2] * k, ox + s[3] * k, oy + s[4] * k, s[5])


# Wordmark: monoline letters on a grid. X = x-height, ASC = cap and ascender
# height, W = stroke. Letters are built only from stems, bowls and arches.
X, ASC, W, GAP = 96, 148, 20, 17
BOWL = (X - W) / 2      # centre-line radius of a, b
ARCH = 31               # centre-line radius of the arches of m and u
CAP = (ASC - W) / 2     # centre-line radius of the G


def word_shapes(fg, dot, x=0, base=ASC):
    """'Gamblium'. Returns (shapes, width). `base` is the baseline's y."""
    out = []
    top = base - X

    def stem(x0, y0, y1):
        out.append(("bar", x0, y0, x0 + W, y1, fg))

    def letter_G(x0):
        cx, cy = x0 + W / 2 + CAP, base - ASC / 2
        out.append(("arc", cx, cy, CAP, 0, 316, W, fg))
        out.append(("bar", cx + 3, cy, cx + CAP + W / 2, cy + W, fg))
        return 2 * CAP + W

    def letter_a(x0):
        out.append(("arc", x0 + W / 2 + BOWL, base - X / 2, BOWL, 0, 360, W, fg))
        stem(x0 + 2 * BOWL, top, base)
        return 2 * BOWL + W

    def letter_b(x0):
        stem(x0, base - ASC, base)
        out.append(("arc", x0 + W / 2 + BOWL, base - X / 2, BOWL, 0, 360, W, fg))
        return 2 * BOWL + W

    def letter_l(x0):
        stem(x0, base - ASC, base)
        return W

    def letter_i(x0):
        stem(x0, top, base)
        out.append(("disc", x0 + W / 2, top - 27, 14, dot))
        return W

    def letter_m(x0):
        cy = top + W / 2 + ARCH
        stem(x0, top, base)
        for n in (0, 1):
            out.append(("arc", x0 + W / 2 + ARCH * (2 * n + 1), cy, ARCH, 180, 360, W, fg))
            stem(x0 + 2 * ARCH * (n + 1), cy, base)
        return 4 * ARCH + W

    def letter_u(x0):
        cy = base - W / 2 - ARCH
        stem(x0, top, cy)
        out.append(("arc", x0 + W / 2 + ARCH, cy, ARCH, 0, 180, W, fg))
        stem(x0 + 2 * ARCH, top, base)
        return 2 * ARCH + W

    letters = {"G": letter_G, "a": letter_a, "m": letter_m, "b": letter_b, "l": letter_l, "i": letter_i, "u": letter_u}
    for ch in "Gamblium":
        x += letters[ch](x) + GAP
    return out, x - GAP


LOCKUP_H = ASC + 44  # the mark is as tall as the capitals plus a little


def lockup_shapes(scheme, mode):
    fg = token(scheme, mode, "text")
    dot = colour(scheme, SCHEMES[scheme]["coin"][mode])
    k = LOCKUP_H / 256
    word, width = word_shapes(fg, dot, x=MARK_W * k + 30, base=22 + ASC)
    return mark_shapes(scheme, MARKS["full"], -MARKS["full"]["left"] * k, 0, k) + word, width


# ---------------------------------------------------------------- writers
def point(cx, cy, r, a):
    return cx + r * cos(radians(a)), cy + r * sin(radians(a))


def to_svg(shapes, width, height, label):
    rows = []
    for s in shapes:
        if s[0] == "poly":
            rows.append(f'<path d="M {" L ".join(f"{x:.2f} {y:.2f}" for x, y in s[1])} Z" fill="{s[2]}"/>')
        elif s[0] == "disc":
            rows.append(f'<circle cx="{s[1]:.2f}" cy="{s[2]:.2f}" r="{s[3]:.2f}" fill="{s[4]}"/>')
        elif s[0] == "bar":
            rows.append(f'<rect x="{s[1]:.2f}" y="{s[2]:.2f}" width="{s[3] - s[1]:.2f}" height="{s[4] - s[2]:.2f}" fill="{s[5]}"/>')
        else:
            _, cx, cy, r, a0, a1, w, col = s
            if a1 - a0 >= 360:
                rows.append(f'<circle cx="{cx:.2f}" cy="{cy:.2f}" r="{r:.2f}" fill="none" stroke="{col}" stroke-width="{w:.2f}"/>')
            else:
                (x0, y0), (x1, y1) = point(cx, cy, r, a0), point(cx, cy, r, a1)
                large = 1 if a1 - a0 > 180 else 0
                rows.append(
                    f'<path d="M {x0:.2f} {y0:.2f} A {r:.2f} {r:.2f} 0 {large} 1 {x1:.2f} {y1:.2f}" '
                    f'fill="none" stroke="{col}" stroke-width="{w:.2f}"/>'
                )
    body = "\n  ".join(rows)
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width:g} {height:g}" role="img" aria-label="{label}">\n'
        f"  {body}\n</svg>\n"
    )


def draw(shapes, width, height, out_w, scale=8):
    """Rasterises shapes drawn on a width x height grid to `out_w` pixels wide."""
    k = out_w * scale / width
    img = Image.new("RGBA", (round(width * k), round(height * k)), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    for s in shapes:
        if s[0] == "poly":
            d.polygon([(x * k, y * k) for x, y in s[1]], fill=s[2])
        elif s[0] == "disc":
            _, cx, cy, r, col = s
            d.ellipse([(cx - r) * k, (cy - r) * k, (cx + r) * k, (cy + r) * k], fill=col)
        elif s[0] == "bar":
            d.rectangle([s[1] * k, s[2] * k, s[3] * k - 1, s[4] * k - 1], fill=s[5])
        else:
            _, cx, cy, r, a0, a1, w, col = s
            ro = r + w / 2
            box = [(cx - ro) * k, (cy - ro) * k, (cx + ro) * k, (cy + ro) * k]
            if a1 - a0 >= 360:
                d.ellipse(box, outline=col, width=round(w * k))
            else:
                d.arc(box, a0, a1, fill=col, width=round(w * k))
    return img.resize((out_w, round(height * out_w / width)), Image.LANCZOS)


def write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8", newline="\n")


# ---------------------------------------------------------------- colour maths
def rgb(hex_colour):
    h = hex_colour.lstrip("#")
    return [int(h[i : i + 2], 16) for i in (0, 2, 4)]


def luminance(hex_colour):
    def lin(c):
        c /= 255
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4

    r, g, b = (lin(c) for c in rgb(hex_colour))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a, b):
    la, lb = sorted((luminance(a), luminance(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)


def seed_int(hex_colour):
    """A colour as Chromium stores it in prefs: opaque ARGB as a signed 32-bit integer."""
    r, g, b = rgb(hex_colour)
    value = (0xFF << 24) | (r << 16) | (g << 8) | b
    return value - (1 << 32) if value >= (1 << 31) else value


# ---------------------------------------------------------------- outputs
def theme_preset(scheme, mode):
    """Whole-browser theme, prefs only. Chromium derives the frame, toolbar, menus
    and internal pages from one seed colour; an installed theme extension would
    override the frame, so the preset clears it."""
    s = SCHEMES[scheme]
    return {
        "name": f"theme-{scheme}-{mode}",
        # On a profile's first start Brave copies its old dark-mode setting over
        # color_scheme2. Marking that as done, and setting the old value to match
        # (1 dark, 2 light), keeps the choice on a brand-new profile.
        # "auto" follows Windows: 0 in both settings, and the dark ground for the first paint.
        "local_state": {"brave.dark_mode": {"dark": 1, "light": 2, "auto": 0}[mode]},
        "preferences": {
            "brave.dark_mode_migrated": True,
            "extensions.theme.id": "",
            "extensions.theme.pack": "",
            "browser.theme.user_color2": seed_int(s["seed"]),
            "browser.theme.color_variant2": s["variant"],
            "browser.theme.color_scheme2": {"dark": 2, "light": 1, "auto": 0}[mode],
            "brave.new_tab_page.show_background_image": True,
            "brave.new_tab_page.background": {"type": "color", "selected_value": token(scheme, "dark" if mode == "auto" else mode, "bg"), "random": False},
        },
    }


def tokens_css():
    def block(scheme, mode, indent):
        pad = " " * indent
        rows = [f"{pad}--{name}: {token(scheme, mode, name)};" for name in TOKENS]
        # Brand artwork for this scheme and background; root-relative so every page can use it.
        rows.append(f'{pad}--lockup: url("/ui/brand/{scheme}/lockup-{mode}.svg");')
        rows.append(f'{pad}--mark: url("/ui/brand/{scheme}/mark.svg");')
        return "\n".join(rows)

    font, radius = PALETTE["font"], PALETTE["radius"]
    out = [
        "/* Generated by branding/make_icons.py from branding/palette.json. Do not edit. */",
        ":root {",
        "  color-scheme: dark light;",
        block(DEFAULT, "dark", 2),
        f"  --font-ui: {font['ui']};",
        f"  --font-display: {font['display']};",
        f"  --font-mono: {font['mono']};",
        *(f"  --radius-{k}: {v}px;" for k, v in radius.items()),
        "}",
        "@media (prefers-color-scheme: light) {",
        "  :root {",
        block(DEFAULT, "light", 4),
        "  }",
        "}",
    ]
    for scheme in SCHEMES:
        if scheme == DEFAULT:
            continue
        out += [
            f':root[data-scheme="{scheme}"] {{',
            block(scheme, "dark", 2),
            "}",
            "@media (prefers-color-scheme: light) {",
            f'  :root[data-scheme="{scheme}"] {{',
            block(scheme, "light", 4),
            "  }",
            "}",
        ]
    return "\n".join(out) + "\n"


def skin_css():
    """Brave's own pages (Shields panel, parts of Settings) take their colours from
    one shared stylesheet of design tokens. This is the block tools/rebrand appends
    to that stylesheet in the private copy, so those pages wear the default scheme."""
    def block(mode):
        t = lambda name: token(DEFAULT, mode, name)  # noqa: E731
        rows = {
            "--leo-color-page-background": t("bg"),
            "--leo-color-container-background": t("surface"),
            "--leo-color-container-highlight": t("surface-raised"),
            "--leo-color-container-interactive": f"color-mix(in srgb, {t('text')} 10%, transparent)",
            "--leo-color-divider-subtle": f"color-mix(in srgb, {t('text')} 11%, transparent)",
            "--leo-color-divider-strong": f"color-mix(in srgb, {t('text')} 22%, transparent)",
            "--leo-color-divider-interactive": t("accent"),
            "--leo-color-text-primary": t("text"),
            "--leo-color-text-secondary": t("text-muted"),
            "--leo-color-text-interactive": t("accent"),
            "--leo-color-icon-default": t("text-muted"),
            "--leo-color-icon-interactive": t("accent"),
            "--leo-color-button-background": t("accent-strong"),
            "--leo-color-schemes-primary": t("accent-strong"),
            "--leo-color-schemes-on-primary": t("on-accent"),
            "--leo-color-schemes-on-surface": t("text"),
            "--leo-color-schemes-on-surface-variant": t("text-muted"),
            "--leo-color-schemes-surface": t("surface"),
            "--leo-color-schemes-background": t("bg"),
        }
        return "".join(f"  {k}: {v};\n" for k, v in rows.items())

    def chromium(mode):
        # Chromium's own page tokens, set on the same element by the browser's colour sheet;
        # "html:root" outranks it whichever loads last. The focus ring is the facet light
        # (owner's critique, Nov 13 2026: Settings opens with its search field focused, and a
        # pale 2 px ring made it look stuck that way).
        t = lambda name: token(DEFAULT, mode, name)  # noqa: E731
        rows = {
            "--cr-focus-outline-color": f"color-mix(in srgb, {t('highlight')} 75%, transparent)",
            "--cr-card-background-color": t("surface"),
            "--cr-separator-color": f"color-mix(in srgb, {t('text')} 11%, transparent)",
            "--cr-primary-text-color": t("text"),
            "--cr-secondary-text-color": t("text-muted"),
        }
        return "".join(f"  {k}: {v};\n" for k, v in rows.items())

    dark, light = block("dark"), block("light")
    cdark, clight = chromium("dark"), chromium("light")
    return (
        "/* Gamblium skin. Built by branding/make_icons.py from palette.json; do not edit. */\n"
        f"@media (prefers-color-scheme: dark) {{\n:root {{\n{dark}}}\nhtml:root {{\n{cdark}}}\n}}\n"
        f"[data-theme=\"dark\"] {{\n{dark}}}\n"
        f"@media (prefers-color-scheme: light) {{\n:root {{\n{light}}}\nhtml:root {{\n{clight}}}\n}}\n"
        f"[data-theme=\"light\"] {{\n{light}}}\n"
    )


def theme_extension(scheme):
    """A theme extension for a scheme's dark look: exact colours for the window frame and tabs, which
    the seed colour cannot give (owner's critique, Nov 13 2026: the frame the deepest black, the active
    tab the page's surface so it lifts out of the frame, inactive titles at 60 % ink). The launcher loads
    theme/<scheme>-dark beside the seed preset (main.rs, --theme). Private windows keep Brave's own
    colours; light and auto stay on the seed."""
    t = lambda name: token(scheme, "dark", name)  # noqa: E731
    rgb = lambda h: [int(h.lstrip("#")[i:i + 2], 16) for i in (0, 2, 4)]  # noqa: E731

    def mix(a, b, k):  # k of a over b
        return [round(x * k + y * (1 - k)) for x, y in zip(rgb(a), rgb(b))]

    return {
        "manifest_version": 3,
        "name": f"Gamblium {SCHEMES[scheme].get('label', scheme.title())}",
        "version": PALETTE["version"] if isinstance(PALETTE.get("version"), str) and PALETTE["version"].count(".") <= 3 else "1.0",
        "description": "Gamblium's window colours. Generated by branding/make_icons.py from palette.json.",
        "theme": {
            "colors": {
                "frame": rgb(t("bg")),
                "frame_inactive": rgb(t("bg")),
                "toolbar": rgb(t("surface")),
                "tab_text": rgb(t("text")),
                "tab_background_text": mix(t("text"), t("bg"), 0.6),
                "tab_background_text_inactive": mix(t("text"), t("bg"), 0.45),
                "bookmark_text": rgb(t("text-muted")),
                "toolbar_button_icon": mix(t("text"), t("bg"), 0.82),  # ink, never the accent: the felt is the ground, not the icons
                "toolbar_text": rgb(t("text")),
                # The address field and its dropdown: the raised surface, so the list reads as a panel over
                # the page and not as part of the black frame (review pass 1, J).
                "omnibox_background": rgb(t("surface-raised")),
                "omnibox_text": rgb(t("text")),
                "ntp_background": rgb(t("bg")),
                "ntp_text": rgb(t("text")),
            }
        },
    }


def build_scheme(scheme, folder):
    """Mark, wordmark, lockups, icons and contact sheet of one scheme into `folder`."""
    png = folder / "png"
    png.mkdir(parents=True, exist_ok=True)
    for old in png.glob("*.png"):
        old.unlink()

    for name, file in (("full", "gamblium-mark.svg"), ("small", "gamblium-mark-small.svg")):
        write(folder / file, to_svg(mark_shapes(scheme, MARKS[name]), 256, 256, "Gamblium"))
    icons = {}
    for size in (16, 20, 24, 32, 48, 64, 128, 256, 512):
        v = MARKS["small"] if size <= 32 else MARKS["full"]
        icons[size] = draw(mark_shapes(scheme, v), 256, 256, size)
        icons[size].save(png / f"gamblium-{size}.png")
    ico = [16, 20, 24, 32, 48, 64, 128, 256]
    icons[256].save(folder / "gamblium.ico", format="ICO", sizes=[(s, s) for s in ico], append_images=[icons[s] for s in ico if s != 256])

    lockups = {}
    for mode in MODES:
        fg, dot = token(scheme, mode, "text"), colour(scheme, SCHEMES[scheme]["coin"][mode])
        shapes, width = word_shapes(fg, dot, base=ASC)
        write(folder / f"gamblium-wordmark-{mode}.svg", to_svg(shapes, width, ASC, "Gamblium"))
        both, lock_w = lockup_shapes(scheme, mode)
        lockups[mode] = (both, lock_w)
        write(folder / f"gamblium-lockup-{mode}.svg", to_svg(both, lock_w, LOCKUP_H, "Gamblium"))
        draw(both, lock_w, LOCKUP_H, 640).save(png / f"lockup-{mode}.png")

    # Contact sheet: every size on dark and light, small sizes again at 6x.
    half_w, h = 760, 470
    sheet = Image.new("RGBA", (half_w * 2, h), token(scheme, "dark", "surface"))
    ImageDraw.Draw(sheet).rectangle([half_w, 0, half_w * 2, h], fill=token(scheme, "light", "bg"))
    for i, mode in enumerate(MODES):
        left = i * half_w + 20
        x = left
        for size in (256, 128, 64, 48, 32, 24, 20, 16):
            sheet.alpha_composite(icons[size], (x, 20))
            x += size + 12
        x = left + 280
        for size in (32, 24, 16):
            big = icons[size].resize((size * 6, size * 6), Image.NEAREST)
            sheet.alpha_composite(big, (x, 160 + (192 - size * 6)))
            x += size * 6 + 14
        both, lock_w = lockups[mode]
        sheet.alpha_composite(draw(both, lock_w, LOCKUP_H, 440), (left, 372))
    sheet.save(png / "contact-sheet.png")
    return icons, lockups


def schemes_sheet(built):
    """Every scheme side by side: mark, small sizes, lockup and its tokens, dark and light."""
    cell_w, cell_h, pad = 620, 300, 18
    sheet = Image.new("RGBA", (pad + 2 * (cell_w + pad), pad + len(built) * (cell_h + pad)), "#2A2A2C")
    d = ImageDraw.Draw(sheet)
    for row, (scheme, (icons, lockups)) in enumerate(built.items()):
        for col, mode in enumerate(MODES):
            x0, y0 = pad + col * (cell_w + pad), pad + row * (cell_h + pad)
            d.rounded_rectangle([x0, y0, x0 + cell_w, y0 + cell_h], 14, fill=token(scheme, mode, "bg"))
            sheet.alpha_composite(icons[128], (x0 + 24, y0 + 24))
            x = x0 + 172
            for size in (48, 32, 24, 16):
                sheet.alpha_composite(icons[size], (x, y0 + 24 + (48 - size)))
                x += size + 14
            both, lock_w = lockups[mode]
            sheet.alpha_composite(draw(both, lock_w, LOCKUP_H, 330), (x0 + 172, y0 + 92))
            # Swatches of the tokens pages use, in reading order.
            sx = x0 + 24
            for name in ("surface", "surface-raised", "border", "text", "text-muted", "accent", "accent-strong", "highlight", "danger"):
                d.rounded_rectangle([sx, y0 + 196, sx + 54, y0 + 250], 8, fill=token(scheme, mode, name), outline=token(scheme, mode, "border"))
                sx += 64
            # A filled button and a line of text, to see the accent pair at work.
            d.rounded_rectangle([x0 + 24, y0 + 262, x0 + 150, y0 + 288], 13, fill=token(scheme, mode, "accent-strong"))
            d.rectangle([x0 + 52, y0 + 273, x0 + 122, y0 + 277], fill=token(scheme, mode, "on-accent"))
            d.rectangle([x0 + 172, y0 + 273, x0 + 360, y0 + 277], fill=token(scheme, mode, "text"))
            d.rectangle([x0 + 372, y0 + 273, x0 + 470, y0 + 277], fill=token(scheme, mode, "accent"))
            d.rectangle([x0 + 482, y0 + 273, x0 + 590, y0 + 277], fill=token(scheme, mode, "text-muted"))
    out = ROOT / "docs" / "design" / "brand" / "schemes.png"
    out.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(out)


def main():
    built = {}
    for scheme in SCHEMES:
        folder = HERE if scheme == DEFAULT else HERE / "schemes" / scheme
        built[scheme] = build_scheme(scheme, folder)

    # The extension's own copies, default scheme.
    icons, _ = built[DEFAULT]
    ui = ROOT / "extension" / "ui"
    (ui / "icons").mkdir(parents=True, exist_ok=True)
    for size in (16, 32, 48, 128):
        icons[size].save(ui / "icons" / f"icon-{size}.png")
    for scheme in SCHEMES:
        src = HERE if scheme == DEFAULT else HERE / "schemes" / scheme
        for file in ("gamblium-mark.svg", "gamblium-lockup-dark.svg", "gamblium-lockup-light.svg"):
            write(ui / "brand" / scheme / file.replace("gamblium-", ""), (src / file).read_text(encoding="utf-8"))
    write(ui / "tokens.css", tokens_css())
    write(HERE / "skin.css", skin_css())
    # Experimental page tint for forced-dark sites: lifts only the darkest pixels
    # to a dark theme colour. Not wired in until its paint cost is measured.
    for scheme in SCHEMES:
        rule = 'html::after { content: ""; position: fixed; inset: 0; background: %s; mix-blend-mode: lighten; pointer-events: none; z-index: 2147483647; }'
        note = "/* Generated by branding/make_icons.py. Experimental, not loaded by default. */"
        write(ui / f"tint-{scheme}.css", note + "\n" + rule % SCHEMES[scheme]["tint"] + "\n")

    for scheme in SCHEMES:
        for mode in (*MODES, "auto"):
            write(ROOT / "presets" / f"theme-{scheme}-{mode}.json", json.dumps(theme_preset(scheme, mode), indent=2) + "\n")
        (ROOT / "theme" / f"{scheme}-dark").mkdir(parents=True, exist_ok=True)
        write(ROOT / "theme" / f"{scheme}-dark" / "manifest.json", json.dumps(theme_extension(scheme), indent=2) + "\n")

    schemes_sheet(built)

    # Text and accent contrast, so a palette change cannot quietly break reading.
    print("contrast (4.5 needed for text, 3 for large text and icons)")
    failed = 0
    pairs = (("text", "bg"), ("text", "surface"), ("text", "surface-raised"), ("text-muted", "bg"), ("text-muted", "surface"), ("accent", "bg"), ("accent", "surface"), ("on-accent", "accent-strong"), ("highlight", "bg"), ("danger", "surface"))
    for scheme in SCHEMES:
        for mode in MODES:
            for fg, bg in pairs:
                c = contrast(token(scheme, mode, fg), token(scheme, mode, bg))
                if c < 4.5:
                    failed += 1
                    print(f"  {scheme:9} {mode:5} {fg:10} on {bg:14} {c:5.2f}  <-- below 4.5")
    print(f"  {len(SCHEMES) * len(MODES) * len(pairs)} pairs checked, {failed} below 4.5")
    m = SCHEMES
    for scheme in SCHEMES:
        mk = {p: colour(scheme, n) for p, n in m[scheme]["mark"].items()}
        for mode in MODES:
            bg = token(scheme, mode, "bg")
            print(f"  mark {scheme:9} on {mode:5} page: " + ", ".join(f"{part} {contrast(c, bg):.2f}" for part, c in mk.items()))
    print("built", ", ".join(SCHEMES), "| default:", DEFAULT)
    return failed


if __name__ == "__main__":
    raise SystemExit(1 if main() else 0)

"""python -m unittest tools/rebrand/test_rebrand.py

Brave's art is not in the repository, so the lion used here is drawn from the
detector's own reference bitmaps. The last test reads the installed Brave when
there is one (read-only) and is skipped otherwise.
"""
import io
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import lion as L  # noqa: E402
import pak as P  # noqa: E402
import rebrand as R  # noqa: E402

BRANDING = HERE.parents[1] / "branding"


def lion_png(scale=8, pad=(0, 0)):
    """An orange lion with a white face, built from REFERENCE and FACE."""
    g = L.GRID
    w, h = round(g * scale * L.REFERENCE_ASPECT), g * scale
    ref, face = int(L.REFERENCE, 16), int(L.FACE, 16)
    small = Image.new("RGBA", (g, g), (0, 0, 0, 0))
    for i in range(g * g):
        bit = 1 << (g * g - 1 - i)
        if ref & bit:
            small.putpixel((i % g, i // g), (255, 255, 255, 255) if face & bit else (255, 80, 0, 255))
    im = Image.new("RGBA", (w + pad[0], h + pad[1]), (0, 0, 0, 0))
    im.paste(small.resize((w, h), Image.NEAREST), (0, 0))
    out = io.BytesIO()
    im.save(out, format="PNG")
    return out.getvalue()


def shape_png(draw_fn, size=96):
    im = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw_fn(ImageDraw.Draw(im), size)
    out = io.BytesIO()
    im.save(out, format="PNG")
    return out.getvalue()


class Packs(unittest.TestCase):
    def test_round_trip(self):
        pk = dict(encoding=1, res={5: b"five", 9: b"", 300: b"x" * 1000}, alias=[(7, 0)])
        with tempfile.TemporaryDirectory() as d:
            P.write(pk, Path(d) / "a.pak")
            back = P.read(Path(d) / "a.pak")
        self.assertEqual(back, pk)


class Names(unittest.TestCase):
    def test_browser_name_changes(self):
        for before, after in [
            ("About Brave", "About Gamblium"),
            ("Brave is up to date", "Gamblium is up to date"),
            ("Make Brave your default browser", "Make Gamblium your default browser"),
            ("Brave's settings", "Gamblium's settings"),
            ("$1 - Brave", "$1 - Gamblium"),
        ]:
            self.assertEqual(R.rename(before, "Gamblium"), after)

    def test_services_company_addresses_and_legal_text_stay(self):
        for same in [
            "Brave Search", "Brave Software Inc", "Brave Shields", "Brave Rewards", "Brave VPN", "Brave Nightly",
            "Visit https://Brave.com/help", "support@Brave.com", "BraveSoftware",
            "Copyright 2026 The Brave Authors. All rights reserved.", "Brave is under the Mozilla Public License",
        ]:
            self.assertEqual(R.rename(same, "Gamblium"), same)

    def test_mixed_sentence(self):
        self.assertEqual(R.rename("Brave uses Brave Search by default", "Gamblium"), "Gamblium uses Brave Search by default")


class Paths(unittest.TestCase):
    def test_relative_and_closed(self):
        self.assertEqual(L.path_polygons("M0 0h10v10h-10z"), [[(0, 0), (10, 0), (10, 10), (0, 10)]])

    def test_packed_arc_flags(self):
        polys = L.path_polygons("M0 5a5 5 0 0110 0a5 5 0 01-10 0z")  # "0110" is flags 0 and 1, then 10
        x0, y0, x1, y1 = L.polygons_box(polys)
        self.assertAlmostEqual(x1 - x0, 10, delta=0.2)
        self.assertAlmostEqual(y1 - y0, 10, delta=0.2)


class Detector(unittest.TestCase):
    def test_finds_the_lion(self):
        for scale in (8, 2):
            found = L.find_in_png(lion_png(scale))
            self.assertIsNotNone(found)
            self.assertFalse(found["near"])

    def test_plain_shapes_are_not_lions(self):
        circle = shape_png(lambda d, s: d.ellipse((4, 4, s - 4, s - 4), fill=(255, 80, 0, 255)))
        square = shape_png(lambda d, s: d.rectangle((8, 8, s - 8, s - 8), fill=(255, 80, 0, 255)))
        shield = shape_png(lambda d, s: d.polygon([(12, 6), (s - 12, 6), (s - 12, s * 0.55), (s / 2, s - 4), (12, s * 0.55)], fill=(90, 110, 125, 255)))
        for png in (circle, square, shield):
            found = L.find_in_png(png)
            self.assertTrue(found is None or found["near"])

    def test_a_blank_lion_outline_is_only_a_near_miss(self):
        g = L.GRID
        ref = int(L.REFERENCE, 16)
        im = Image.new("RGBA", (g, g), (0, 0, 0, 0))
        for i in range(g * g):
            if ref & (1 << (g * g - 1 - i)):
                im.putpixel((i % g, i // g), (90, 110, 125, 255))
        out = io.BytesIO()
        im.resize((round(g * 6 * L.REFERENCE_ASPECT), g * 6), Image.NEAREST).save(out, format="PNG")
        found = L.find_in_png(out.getvalue())
        self.assertTrue(found is not None and found["near"])


class PrivateNote(unittest.TestCase):
    def test_private_note_is_one_short_line(self):
        note = [new for old, new in R.WORDING.items() if old.startswith(b"Brave never remembers what you do")]
        self.assertEqual(len(note), 1)
        self.assertLessEqual(len(note[0].split()), 16)
        self.assertNotIn(b"Brave", note[0])


class Folder(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="gamblium-rebrand-test-"))
        self.ver = self.tmp / "1.2.3.4"
        (self.ver / "Locales").mkdir(parents=True)
        self.lion = lion_png(4)
        for name in ("resources.pak", "chrome_100_percent.pak"):
            P.write(dict(encoding=1, res={10: b"not an image", 11: self.lion}, alias=[]), self.ver / name)
        P.write(dict(encoding=1, res={1: b"About Brave", 2: b"Brave Search", 3: b"Search $1 or type a URL", 4: b"Search Brave or type a URL", 5: b"Global Settings", 6: b"Brave forgets everything in a Private Window.", 7: b"Private Windows don\xe2\x80\x99t make you anonymous.", 8: b"Browsing History", 9: b"Brave doesn't remember what you do in a Private Window. Sites you visit won't show up.", 10: b"Brave doesn't store browsing activity from private windows. With Tor..."}, alias=[]), self.ver / "Locales" / "en-US.pak")
        self.before = {p.relative_to(self.ver).as_posix(): p.read_bytes() for p in self.ver.rglob("*.pak")}

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_tool(self, *args):
        with open(os.devnull, "w") as quiet:
            old = sys.stdout
            sys.stdout = quiet
            try:
                return R.main([str(self.tmp), "--branding", str(BRANDING), *args])
            finally:
                sys.stdout = old

    def test_patch_rerun_and_undo(self):
        self.assertEqual(self.run_tool("--check"), R.OK)
        self.assertEqual({p.relative_to(self.ver).as_posix(): p.read_bytes() for p in self.ver.rglob("*.pak")}, self.before)
        self.assertEqual(self.run_tool(), R.OK)
        strings = P.read(self.ver / "Locales" / "en-US.pak")["res"]
        self.assertEqual(strings, {1: b"About Gamblium", 2: b"Brave Search", 3: b"Search the web or type a URL", 4: b"Search the web or type a URL", 5: b"Global settings",
                                   6: b"Gamblium forgets everything in a private window.",
                                   7: b"Private windows don\xe2\x80\x99t make you anonymous.", 8: b"Browsing history",
                                   9: b"Nothing is kept once you close it; your network can still see where you go.",
                                   10: b"Nothing is kept once you close it, and sites don't see your IP address. If your safety depends on staying anonymous, use Tor Browser."})
        res = P.read(self.ver / "chrome_100_percent.pak")["res"]
        self.assertEqual(res[10], b"not an image")
        self.assertNotEqual(res[11], self.lion)
        self.assertIsNone(L.find_in_png(res[11]))  # no lion left
        self.assertTrue((self.ver / R.STAMP).is_file() and (self.ver / R.UNDO).is_file())
        patched = {p.relative_to(self.ver).as_posix(): p.read_bytes() for p in self.ver.rglob("*.pak")}
        self.assertEqual(self.run_tool(), R.OK)  # a rerun starts from Brave's own content and lands in the same place
        self.assertEqual({p.relative_to(self.ver).as_posix(): p.read_bytes() for p in self.ver.rglob("*.pak")}, patched)
        self.assertEqual(self.run_tool("--undo"), R.OK)
        self.assertEqual({p.relative_to(self.ver).as_posix(): p.read_bytes() for p in self.ver.rglob("*.pak")}, self.before)
        self.assertFalse((self.ver / R.STAMP).exists() or (self.ver / R.UNDO).exists())

    def test_no_lion_writes_nothing(self):
        for name in ("resources.pak", "chrome_100_percent.pak"):
            P.write(dict(encoding=1, res={10: b"not an image"}, alias=[]), self.ver / name)
        self.assertEqual(self.run_tool(), R.NOTHING_FOUND)
        self.assertEqual(P.read(self.ver / "Locales" / "en-US.pak")["res"][1], b"About Brave")

    def test_refusals(self):
        self.assertEqual(R.main([str(self.tmp / "missing")]), R.REFUSED)
        self.assertEqual(R.main([str(self.tmp), "--branding", str(self.tmp)]), R.REFUSED)
        installed = Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "BraveSoftware" / "Brave-Browser" / "Application"
        if installed.is_dir():
            self.assertEqual(R.main([str(installed), "--check"]), R.REFUSED)



class PanelPage(unittest.TestCase):
    PAGE = "<html><head><title>Shields Panel</title><style>\n body { width: 388px; }\n </style></head><body><div id=\"root\"></div></body></html>"

    def test_found_by_its_title(self):
        self.assertTrue(R.is_shields_panel(self.PAGE))
        self.assertFalse(R.is_shields_panel(self.PAGE.replace("Shields Panel", "Wallet")))

    def test_our_styles_go_inside_its_own_style_once(self):
        out = R.panel_page(self.PAGE, "#root .count { font-size: 34px; }")
        self.assertEqual(out.count("</style>"), 1)
        self.assertIn("body { width: 388px; }", out)
        self.assertLess(out.index("--leo-color-page-background"), out.index("#root .count"))
        self.assertLess(out.index("#root .count"), out.index("</style>"))

    def test_without_the_file_only_the_ground_is_set(self):
        out = R.panel_page(self.PAGE)
        self.assertIn(R.PANEL_STYLE, out)
        self.assertNotIn("#root", out.split("</style>")[0].split(R.PANEL_STYLE)[1])

if __name__ == "__main__":
    unittest.main()

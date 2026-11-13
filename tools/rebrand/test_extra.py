"""python -m unittest tools/rebrand/test_extra.py"""
import struct
import sys
import io
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import extra as X  # noqa: E402

DIAMOND = '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
  <path d="M 128 2 L 128 108 L 22 108 Z" fill="#6FE0B5"/>
  <path d="M 128 108 L 234 108 L 128 254 Z" fill="#F4C95D"/>
</svg>'''
STROKED = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><circle cx="128" cy="128" r="128" fill="#0B1210"/></svg>'


def lion(size=24.0, points=60):
    """A stand-in for Brave's drawing: canvas, orange, a long outline, close."""
    body = struct.pack("<if", X.CANVAS, size) + X.ORANGE + struct.pack("<i2f", X.MOVE_TO, 1.0, 1.0)
    body += b"".join(struct.pack("<i2f", X.LINE_TO, float(i % 20), float(i % 7)) for i in range(points))
    return body + struct.pack("<i", X.CLOSE)


class Extra(unittest.TestCase):
    def test_the_lion_is_found_by_its_content_and_measured(self):
        old = lion()
        data = b"\x99" * 64 + old + struct.pack("<if", X.CANVAS, 16.0) + b"\x99" * 64
        self.assertEqual(X.find_lions(data), [(64, 24.0, len(old))])
        self.assertEqual(X.find_lions(b"\x99" * 400), [])

    def test_our_mark_overwrites_it_in_place_and_keeps_the_length(self):
        old = lion()
        data = b"\x99" * 64 + old + struct.pack("<if", X.CANVAS, 16.0)
        new, notes = X.patch_dll(data, DIAMOND)
        self.assertEqual(len(new), len(data))
        self.assertIn("our mark", notes[0])
        self.assertEqual(new[:64], data[:64])
        self.assertEqual(new[64 + len(old):], data[64 + len(old):])
        self.assertNotIn(X.ORANGE, new)
        # The first colour is now the mark's, scaled to the 24-unit canvas.
        self.assertEqual(struct.unpack_from("<i4f", new, 72), (X.COLOR_ARGB, 255.0, 0x6F, 0xE0, 0xB5))
        self.assertEqual(struct.unpack_from("<i2f", new, 92), (X.MOVE_TO, 12.0, 2 * 24 / 256))
        self.assertEqual(X.find_lions(new), [])  # a second run finds nothing to do

    def test_a_mark_that_cannot_be_drawn_or_does_not_fit_hides_the_lion(self):
        data = lion()
        new, notes = X.patch_dll(data, STROKED)
        self.assertIn("made invisible", notes[0])
        self.assertEqual(struct.unpack_from("<f", new, 12)[0], 0.0)  # the orange's opacity
        small = lion(points=4)
        new, notes = X.patch_dll(small + b"\x99" * 400, DIAMOND) if len(small) >= 200 else (None, ["made invisible"])
        self.assertIn("made invisible", notes[0])

    def test_a_one_colour_drawing_carries_no_colour_of_its_own(self):
        shapes, view = X.mark_polygons(DIAMOND)
        plain = X.drawing(shapes, view, 24.0, coloured=False)
        self.assertNotIn(struct.pack("<i", X.COLOR_ARGB) + struct.pack("<f", 255.0), plain)
        polys, length, count, coloured = X.outline_points(plain, 0)
        self.assertEqual((len(polys), length, coloured), (2, len(plain), False))
        self.assertTrue(X.outline_points(X.drawing(shapes, view, 24.0), 0)[3])

    def test_the_three_bar_menu_button_becomes_four_pips_in_place(self):
        def bars(size, rows, widths):
            out = [struct.pack("<if", X.CANVAS, size)]
            for y, (x0, x1) in zip(rows, widths):
                for i, (x, yy) in enumerate(((x0, y), (x1, y), (x1, y + 1.6), (x0, y + 1.6))):
                    out.append(struct.pack("<i2f", X.MOVE_TO if i == 0 else X.LINE_TO, x, yy))
                # rounded ends cost bytes in the real one: stand-ins that draw nothing
                out.append(struct.pack("<i7f", 10, 0.8, 0.8, 0.0, 0.0, 1.0, 0.0, 0.0))
                out.append(struct.pack("<i", X.CLOSE))
            return b"".join(out)
        menu = bars(24.0, (4.0, 11.2, 18.4), ((2.0, 21.2),) * 3)
        listing = bars(24.0, (6.0, 11.0, 16.0), ((3.0, 21.0), (3.0, 21.0), (3.0, 15.0)))  # a "sort" icon: one short bar
        tail = struct.pack("<if", X.CANVAS, 16.0)
        data = b"\x99" * 32 + menu + tail + listing + tail
        self.assertEqual([(o, s) for o, s, _ in X.find_menu_bars(data)], [(32, 24.0)])
        new, notes = X.patch_menu_button(data)
        self.assertEqual(len(new), len(data))
        self.assertIn("four pips", notes[0])
        self.assertEqual(new[:32], data[:32])
        self.assertEqual(new[32 + len(menu):], data[32 + len(menu):])  # the other icon is untouched
        polys, length, count, coloured = X.outline_points(new, 32)
        self.assertEqual((len(polys), coloured), (4, False))
        self.assertEqual(length, len(menu))  # padded with empty paths to the old length
        for q in polys:
            self.assertTrue(all(1.0 <= x <= 23.0 and 1.0 <= y <= 23.0 for x, y in q))
        self.assertEqual(polys[0][0][0], 12.0)
        self.assertAlmostEqual(polys[0][0][1], 12.0 - 24 * 0.2875 - 24 * 0.13125, places=4)
        again, notes = X.patch_menu_button(new)
        self.assertEqual(again, new)
        self.assertIn("already", notes[0])
        # blank: same place, same length, nothing drawn, the other icon untouched
        gone, notes = X.patch_menu_button(data, blank=True)
        self.assertIn("blank", notes[0])
        self.assertEqual(len(gone), len(data))
        self.assertEqual(gone[32 + len(menu):], data[32 + len(menu):])
        polys, length, count, coloured = X.outline_points(gone, 32)
        self.assertEqual((polys, length), ([], len(menu)))
        self.assertEqual(struct.unpack_from("<if", gone, 32), (X.CANVAS, 24.0))
        self.assertIn("not found", X.patch_menu_button(b"\x00" * 64)[1][0])

    def test_managed_by_your_organization_names_gamblium(self):
        self.assertEqual(X.managed_by(b"Managed by your organization", "Gamblium"), b"Managed by Gamblium")
        self.assertEqual(X.managed_by(b"This setting is managed by your organization", "Gamblium"), b"This setting is managed by Gamblium")
        self.assertEqual(X.managed_by(b"Your <a href=\"$1\">browser is managed</a> by your organization", "Gamblium"), b"Your <a href=\"$1\">browser is managed</a> by Gamblium")
        for same in (b"due to your organization's policies", "blocked by your organization’s policy".encode(), b"your organization unit has reached", b"Help center"):
            self.assertEqual(X.managed_by(same, "Gamblium"), same)

    MENU = (b'<a role="menuitem" id="origin" href="/origin" class="cr-nav-menu-item" ?hidden="${this.shouldHideMenuItem_(this.pageVisibility_?.origin)}">x</a>'
            b'<a role="menuitem" id="shields" href="/shields" class="cr-nav-menu-item">\n     <cr-icon icon="shield-done"></cr-icon>\n'
            b'     <span class="menu-label">$i18n{braveShieldsTitle}</span>\n   </a>'
            b'<settings-safety-hub-module header-icon="shield-done-filled"></settings-safety-hub-module><cr-icon icon="shield-done"></cr-icon>'
            b'onIronActivate_(event){const path=event.detail.selected;this.setSelectedPath_(path)}'
            b'${this.ntpExtension_?html$2`\n   <extension-controlled-indicator .extensionId="${this.ntpExtension_.id}"></extension-controlled-indicator>`:""}'
            b'${this.startupUrlsPref_?.extensionId?html$2`<extension-controlled-indicator></extension-controlled-indicator>`:""}'
            b'${this.themeIdPref_?.value?html$2`\n        <div class="separator"></div>\n        <cr-button id="useDefault" @click="${this.onUseDefaultClick_}">x</cr-button>`:""}')

    def test_the_settings_script_gets_our_changes(self):
        self.assertTrue(X.is_settings_script(self.MENU))
        self.assertFalse(X.is_settings_script(b"const a = 1;"))
        new, said = X.settings_script(self.MENU, DIAMOND)
        self.assertEqual(said, {"menu icon": "done", "downloads entry": "done", "startup row": "done", "theme reset": "done", "origin entry": "done"})
        self.assertIn(b'<svg data-gamblium="menu" viewBox="0 0 256 256" fill="currentColor"', new)
        self.assertIn(b'</svg>\n     <span class="menu-label">$i18n{braveShieldsTitle}</span>', new)
        # only the icon in front of that label: other uses of the stock shield stay
        self.assertEqual(new.count(b'<cr-icon icon="shield-done"></cr-icon>'), 1)
        self.assertIn(b'header-icon="shield-done-filled"', new)
        self.assertIn(b'const path=event.detail.selected;if(path==="/downloads"){window.location.href="chrome://newtab/#/settings#downloads";return}this.setSelectedPath_(path)', new)
        self.assertIn(b"${false&&this.ntpExtension_?html$2`", new)
        self.assertIn(b"${this.startupUrlsPref_?.extensionId?html$2`", new)  # an extension that sets start pages is still named
        self.assertIn(b'id="origin" href="/origin" class="cr-nav-menu-item" hidden>x</a>', new)
        # Appearance: no "Reset to default" for our themes; a store theme keeps it
        self.assertIn(b"${this.themeIdPref_?.value&&!/^Gamblium /.test(this.themeSublabel_)?html$2`", new)
        # a second run changes nothing
        again, said = X.settings_script(new, DIAMOND)
        self.assertEqual(again, new)
        self.assertEqual(set(said.values()), {"already ours"})

    def test_a_place_that_moved_is_left_alone_and_said(self):
        moved = self.MENU.replace(b"onIronActivate_(event){const path=", b"onIronActivate_(e){const p=")
        new, said = X.settings_script(moved, DIAMOND)
        self.assertTrue(said["downloads entry"].startswith("not found once"))
        self.assertEqual(said["menu icon"], "done")
        self.assertNotIn(b"window.location.href", new)
        new, said = X.settings_script(self.MENU, STROKED)
        self.assertIn(b'<cr-icon icon="shield-done"></cr-icon>\n     <span', new)
        self.assertIn("stock icon stays", said["menu icon"])

    def test_the_menu_mark_follows_the_text_colour_and_keeps_its_facets(self):
        mark = X.facet_mark(DIAMOND)
        self.assertNotIn("#", mark)  # no colour of its own
        self.assertEqual(mark.count("<path"), 2)
        self.assertIn('fill-opacity="1.00"', mark)  # the lightest facet is solid
        self.assertRegex(mark, r'fill-opacity="0\.[4-9]\d"')  # the other is fainter, still visible
        self.assertIn("width:20px;height:20px", mark)
        for bad in "`$\\":  # nothing that would end or open the script's template
            self.assertNotIn(bad, mark)
        self.assertIsNone(X.facet_mark(STROKED))

    def test_shields_is_called_gamblide(self):
        f = lambda s: X.shields_name(s.encode(), "Gamblide").decode()
        self.assertEqual(f("Brave Shields blocked 4 trackers on $1"), "Gamblide blocked 4 trackers on $1")
        self.assertEqual(f("Click the Gamblium icon to view Brave Shields."), "Click the Gamblium icon to view Gamblide.")
        self.assertEqual(f("Shields $1up/$1 for this site"), "Gamblide $1on/$1 for this site")
        self.assertEqual(f("$1Shields are DOWN/$1 for this site"), "$1Gamblide is OFF/$1 for this site")
        self.assertEqual(f("If this site seems broken, try Shields down."), "If this site seems broken, try switching Gamblide off.")
        self.assertEqual(f("Shields settings"), "Gamblide settings")
        self.assertEqual(f("Shields"), "Gamblide")
        self.assertEqual(f("Help center"), "Help center")

    def test_only_filled_paths_count_as_a_drawable_mark(self):
        shapes, view = X.mark_polygons(DIAMOND)
        self.assertEqual(len(shapes), 2)
        self.assertEqual(view, (0.0, 0.0, 256.0, 256.0))
        self.assertIsNone(X.mark_polygons(STROKED))

    def test_brave_menu_button_is_hidden_only_when_both_places_are_certain(self):
        # A tiny program: the button's theme handler, its callee reading two neighbouring fields
        # twice, a decoy handler whose callee does not, and View::SetVisible.
        text_rva, text_off = 0x1000, 0x400
        code = bytearray(bytes.fromhex("cc") * 0x400)
        handler = bytes.fromhex("564883ec204889cee8130000004889f14883c4205ee9") + struct.pack("<i", 0x100) + bytes.fromhex("cc")
        callee = bytes.fromhex("8b9648080000448b864c080000") * 2
        code[0x40:0x40 + len(handler)] = handler
        code[0x60:0x60 + len(callee)] = callee
        code[0x100:0x100 + len(handler)] = handler  # decoy: its callee is plain
        setvis = bytes.fromhex("415741565657534883ec4089d34889ce488b05") + bytes(4) + bytes.fromhex("4831e04889442438408ab9") + bytes(4) + bytes.fromhex("4038d775")
        code[0x200:0x200 + len(setvis)] = setvis
        head = bytearray(0x400)
        struct.pack_into("<I", head, 0x3C, 0x80)
        head[0x80:0x84] = b"PE" + bytes(2)
        struct.pack_into("<H", head, 0x80 + 6, 1)
        struct.pack_into("<H", head, 0x80 + 20, 0xF0)
        struct.pack_into("<8sIIII", head, 0x80 + 24 + 0xF0, b".text", 0x400, text_rva, 0x400, text_off)
        data = bytes(head + code)
        new, notes = X.hide_menu_button(data)
        self.assertIn("hidden", notes[0])
        at = text_off + 0x40
        self.assertEqual(new[at + 8:at + 11], bytes.fromhex("4889f1"))
        call_to = text_rva + 0x40 + 11 + 5 + struct.unpack_from("<i", new, at + 12)[0]
        self.assertEqual(call_to, text_rva + 0x40 + 0x16 + 4 + 0x100)  # the old jump's target, now a call
        jmp_at = at + 8 + 3 + 5 + 10
        self.assertEqual(new[jmp_at], 0xE9)
        self.assertEqual(text_rva + (jmp_at - text_off) + 5 + struct.unpack_from("<i", new, jmp_at + 1)[0], text_rva + 0x200)
        self.assertEqual(new[text_off + 0x100:text_off + 0x100 + len(handler)], handler)  # the decoy is untouched
        self.assertEqual(X.hide_menu_button(new)[1], ["menu button: already hidden"])
        self.assertIn("left alone", X.hide_menu_button(bytes(64))[1][0])

    def test_the_new_tab_question_is_silenced_only_when_the_place_is_certain(self):
        # A tiny program: headers, a .text section with one instruction pointing at the name, then the mov.
        code = bytearray(b"\x90" * 0x200)
        text_rva, text_off, name_off = 0x1000, 0x400, 0x400 + 0x180
        struct.pack_into("<3sI", code, 0x10, b"\x4c\x8d\x0d", (text_rva + 0x180) - (text_rva + 0x10 + 7))  # lea r9, [rip + name]
        code[0x30:0x37] = b"\xc6\x86\x88\x01\x00\x00\x01"  # mov byte ptr [rsi + 0x188], 1
        # Four bytes of other code that happen to equal the distance to the name (as in Brave 1.99.57).
        struct.pack_into("<2sI", code, 0x60, b"\x85\xc9", (text_rva + 0x180) - (text_rva + 0x62 + 4))
        code[0x180:0x180 + len(X.ACK_NAME)] = X.ACK_NAME
        head = bytearray(0x400)
        struct.pack_into("<I", head, 0x3C, 0x80)
        head[0x80:0x84] = b"PE\0\0"
        struct.pack_into("<H", head, 0x80 + 6, 1)
        struct.pack_into("<H", head, 0x80 + 20, 0xF0)
        struct.pack_into("<8sIIII", head, 0x80 + 24 + 0xF0, b".text", 0x200, text_rva, 0x200, text_off)
        data = bytes(head + code)
        self.assertEqual(X.references(data, name_off), [text_off + 0x13, text_off + 0x62])
        new, note = X.silence_question(data)
        self.assertIn("silenced", note)
        self.assertEqual(new[text_off + 0x36], 0)
        self.assertEqual(sum(a != b for a, b in zip(new, data)), 1)  # exactly one byte differs
        again, note = X.silence_question(new)
        self.assertEqual(again, new)
        self.assertIn("left alone", note)
        self.assertIn("left alone", X.silence_question(b"no such name here")[1])

    def test_a_small_icon_is_stored_bottom_up_with_a_mask(self):
        from PIL import Image
        im = Image.new("RGBA", (16, 16), (10, 20, 30, 255))
        im.putpixel((0, 15), (1, 2, 3, 4))  # bottom-left comes first
        dib = X.icon_dib(im)
        self.assertEqual(len(dib), 40 + 16 * 16 * 4 + 4 * 16)
        self.assertEqual(struct.unpack_from("<IiiHH", dib, 0), (40, 16, 32, 1, 32))
        self.assertEqual(dib[40:44], bytes((3, 2, 1, 4)))  # blue, green, red, alpha

    @unittest.skipUnless(Path(r"C:\Windows\System32\notepad.exe").is_file(), "needs a Windows program to read")
    def test_a_real_program_is_read_and_its_length_never_changes(self):
        from PIL import Image
        data = Path(r"C:\Windows\System32\notepad.exe").read_bytes()
        kinds = {k for k, _, _, _ in X.pe_resources(data)}
        self.assertIn(X.RT_VERSION, kinds)
        new, done, left, names = X.patch_exe(data, lambda side: Image.new("RGBA", (side, side), (0, 128, 0, 255)), "Gamblium", old_name="No Such Name")
        self.assertEqual(len(new), len(data))
        self.assertEqual(names, 0)


class PrivatePageLogo(unittest.TestCase):
    JS = (b'a(),r.createElement("svg",{xmlns:"http://www.w3.org/2000/svg",width:"210",height:"64",fill:"none"},'
          b'r.createElement("path",{fill:"url(#a)",d:"m1 2 (3)"}),r.createElement("stop",{stopColor:"#FF5601"})),b()')
    SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 2"><rect width="10" height="2"/></svg>'

    def test_the_lion_becomes_our_lockup(self):
        new, n = X.private_logo(self.JS, self.SVG)
        self.assertEqual(n, 1)
        self.assertTrue(new.startswith(b'a(),r.createElement("img",{src:"data:image/svg+xml;base64,'))
        self.assertTrue(new.endswith(b'style:{objectFit:"contain"}}),b()'))
        self.assertNotIn(b"#FF5601", new)

    def test_another_drawing_of_that_size_is_left(self):
        other = self.JS.replace(b"#FF5601", b"#123456")
        self.assertEqual(X.private_logo(other, self.SVG), (other, 0))


class PrivatePageColours(unittest.TestCase):
    JS = (b'createElement("linearGradient",{id:"search_icon_gr"},e.createElement("stop",{stopColor:"#BF14A2"}),'
          b'e.createElement("stop",{offset:"1",stopColor:"#F73A1C"})),Xn=dn.div`  background: rgba(12, 4, 30, 0.2);  max-width: 285px;  border-radius: 8px 0px 0px 8px;`')

    def test_magnifier_and_note_take_our_ink(self):
        new, n = X.private_colours(self.JS)
        self.assertEqual(n, 4)
        for old in (b"#BF14A2", b"#F73A1C", b"12, 4, 30"):
            self.assertNotIn(old, new)
        self.assertIn(b'stopColor:"#C9CED8"', new)
        self.assertIn(b"rgba(23, 24, 27, 0.94)", new)

    def test_another_script_is_left(self):
        other = self.JS.replace(b"search_icon_gr", b"other_gr")
        self.assertEqual(X.private_colours(other), (other, 0))


class PrivateTabIcon(unittest.TestCase):
    def png(self, im):
        out = io.BytesIO()
        im.save(out, "PNG")
        return out.getvalue()

    def test_a_filled_or_coloured_square_is_not_the_lion(self):
        from PIL import Image
        self.assertFalse(X.is_line_lion(self.png(Image.new("RGBA", (16, 16), (128, 128, 128, 255)))))
        self.assertFalse(X.is_line_lion(self.png(Image.new("RGBA", (16, 16), (255, 80, 0, 255)))))
        self.assertFalse(X.is_line_lion(b"not a picture"))



class SettingsWithVersion(unittest.TestCase):
    PAGE = (b'<template is="dom-if" if="[[accountState_.loggedOut]]">\n     <brave-account-row></brave-account-row>\n   </template>'
            b'<span class="brave-about-item brave-about-menu-version">\n           v $i18n{braveProductVersion}</span>'
            b'<div class="icon-container"\n        ?hidden="${!this.shouldShowIcons_()}">'
            b'<div id="updateStatusMessage" ?hidden="${!this.showUpdateStatus_}">'
            b'<div class="secondary">$i18n{aboutBrowserVersion}</div>')

    def test_gamblium_version_first_brave_small_no_account_no_update_check(self):
        new, said = X.settings_script(self.PAGE, DIAMOND, "0.7.1")
        for what in ("account card", "sidebar version", "about page, update check", "about page, update icon", "about page, version"):
            self.assertEqual(said[what], "done", what)
        self.assertNotIn(b"<brave-account-row>", new)
        self.assertIn(b"Gamblium 0.7.1</span>", new)
        self.assertIn(b">Brave $i18n{braveProductVersion}</span>", new)
        self.assertIn(b"Updates come with new Gamblium releases.", new)
        # Brave's own script still finds its version line (the first .secondary) and draws it small
        self.assertIn(b'releases.</div><style>#release-notes,#release-notes~.secondary{font-size:11px;opacity:.75}</style><div class="secondary">$i18n{aboutBrowserVersion}</div>', new)
        self.assertNotIn(b"showUpdateStatus_", new)
        again, said = X.settings_script(new, DIAMOND, "0.7.1")
        self.assertEqual(again, new)

    def test_the_version_comes_from_the_extension_manifest(self):
        self.assertRegex(X.gamblium_version(Path(__file__).resolve().parents[2] / "branding"), r"^\d+\.\d+\.\d+$")
        self.assertIsNone(X.gamblium_version("Z:/nowhere/branding"))


class PrivateColours(unittest.TestCase):
    @staticmethod
    def ramp(colours, filler=b"\x90"):
        """17 colour writes "mov dword ptr [rax+0x24], 0xFFRRGGBB", 0x71 bytes apart."""
        out = b""
        for c in colours:
            step = b"\xc7\x40\x24" + struct.pack("<I", 0xFF000000 | c)
            out += step + filler * (X.RAMP_STRIDE - len(step))
        return out

    COLOURS = [0x000000, 0x1F1629, 0xFFFFFF, 0x281C35, 0x322443, 0x3B2A4F, 0x493461, 0x6116C0, 0x6F1BDB, 0x181120, 0x8747F7, 0x9973F8, 0xB098FA, 0xCBC0F8, 0xE5E1F9, 0xF6F0FD, 0xFBFAFD]

    def test_the_private_ramp_takes_our_colours_and_a_rerun_changes_nothing(self):
        data = b"\x00" * 16 + self.ramp(self.COLOURS) + b"\xc7\x40\x24" + struct.pack("<I", 0xFF1F1629) + b"\x00" * 8
        steps = X.find_ramp(data, 0x1F1629)
        self.assertEqual([c for _, c in steps], self.COLOURS)
        new, notes = X.patch_private_colours(data)
        self.assertEqual(len(new), len(data))
        self.assertIn("12 steps in our look", notes[0])
        self.assertIn("1 more constant", notes[2])
        self.assertIn("Tor button text: not found once", notes[3])
        self.assertNotIn(struct.pack("<I", 0xFF1F1629), new)
        self.assertEqual(X.patch_private_colours(new)[0], new)
        self.assertIn("already ours", X.patch_private_colours(new)[1][0])

    def test_the_house_colours_are_dark_and_nearly_grey(self):
        frame = X.house_colour(0x1F1629)
        self.assertLess(max((frame >> 16) & 255, (frame >> 8) & 255, frame & 255), 16)
        self.assertFalse(X._is_purple(X.house_colour(0x6116C0)))

    def test_the_tor_button_text_takes_the_facet_light_once(self):
        data = b"\x00" * 8 + b"\xb8" + struct.pack("<I", 0xFFE3B3FF) + b"\x00" * 8
        new, notes = X.patch_private_colours(data)
        self.assertIn(b"\xb8" + struct.pack("<I", 0xFF8FA3C4), new)
        self.assertEqual(notes[-1], "Tor button text: the facet light")
        self.assertEqual(X.patch_private_colours(new)[1][-1], "Tor button text: already ours")

    def test_no_ramp_no_change(self):
        data = b"\x00" * 256
        self.assertEqual(X.patch_private_colours(data)[0], data)


class PrimaryColours(unittest.TestCase):
    # Brave's primary ramp around the Done fill, with a blue step and a near-white in the same run.
    COLOURS = [0x000000, 0x101322, 0x3A2ECD, 0x5B67E8, 0x96A5F1, 0xBCC6F3, 0xDFE4F6, 0xFBFBFD, 0xFFFFFF, 0x488CFF, 0xFF4724]

    def test_lavender_steps_take_our_hue_blue_and_white_stay_and_a_rerun_changes_nothing(self):
        data = b"\x00" * 64 + PrivateColours.ramp(self.COLOURS, b"\x90") + b"\x00" * 64
        new, notes = X.patch_primary_colours(data)
        self.assertEqual(len(new), len(data))
        self.assertIn("6 steps in our look in 1 run", notes[0])
        for kept in (0x488CFF, 0xFFFFFF, 0xFBFBFD, 0xFF4724):
            self.assertIn(struct.pack("<I", 0xFF000000 | kept), new)
        self.assertNotIn(struct.pack("<I", 0xFFBCC6F3), new)
        self.assertIn(struct.pack("<I", 0xFF000000 | X.primary_colour(0xBCC6F3)), new)
        again, notes2 = X.patch_primary_colours(new)
        self.assertEqual(again, new)
        self.assertEqual(notes2, ["primary colours: already ours"])

    def test_the_new_colours_keep_their_lightness_and_lose_the_lavender(self):
        for c in (0x101322, 0x3A2ECD, 0xBCC6F3):
            new = X.primary_colour(c)
            self.assertFalse(X._is_primary(new))
            lum = lambda v: ((v >> 16) & 255) + ((v >> 8) & 255) + (v & 255)  # noqa: E731
            self.assertLess(abs(lum(new) - lum(c)), 60)

    def test_no_run_no_change(self):
        data = b"\x00" * 256
        self.assertEqual(X.patch_primary_colours(data)[0], data)


class GoogleBlue(unittest.TestCase):
    def test_the_blue_table_and_blue_500_stores_take_our_hue_once(self):
        table = b"".join(struct.pack("<I", 0xFF000000 | c) for c in X.GOOGLE_BLUE)
        store = b"\xc7\x40\x24" + struct.pack("<I", 0xFF4285F4)
        data = b"\x00" * 32 + struct.pack("<I", 0xFF202124) + table + b"\x00" * 32 + store + b"\x00" * 16
        new, notes = X.patch_google_blue(data)
        self.assertEqual(len(new), len(data))
        self.assertNotIn(table, new)
        self.assertNotIn(struct.pack("<I", 0xFF4285F4), new)
        self.assertIn("10 table steps", notes[0])
        self.assertIn("1 colour store", notes[1])
        again, notes2 = X.patch_google_blue(new)
        self.assertEqual(again, new)
        self.assertIn("already ours", notes2[0])


if __name__ == "__main__":
    unittest.main()

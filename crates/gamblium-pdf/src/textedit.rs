//! Edit text in place (owner, Nov 16 2026): the words of a page are changed inside the page's own
//! text-showing operations, so everything that is not changed keeps its bytes: the font, the
//! size, the colour, the spacing, the baseline, the kerning between the letters that stay.
//!
//! - `text_lines`: what can be edited, as lines of characters with their place and look.
//! - `edit_text`: replaces ranges of characters of those lines.
//!
//! New characters are written in the run's own font when it has them (also by adding a glyph the
//! embedded TrueType program holds but the file did not use yet). A character the font does not
//! have is written in the standard font of the same family, weight and slant, never plain.
//! What follows on the line moves by exactly the change in width; nothing else on the page moves
//! (checked by reading the page again after the change).

use super::{apply, json_str, mul, num, standard_name, Mx, ID};
use lopdf::content::Operation;
use lopdf::{dictionary, Dictionary, Document, Object, ObjectId, Stream, StringFormat};
use std::collections::{HashMap, HashSet};
use wasm_bindgen::prelude::*;

// ---------------------------------------------------------------- fonts

/// How a font looks: its real family name when the file tells ("Arial"), the nearest standard
/// family ("Helvetica", "Times", "Courier"), bold, italic.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct Look {
    pub family: String,
    pub ps: String, // the PostScript name ("Arial-BoldMT"): names one face exactly
    pub generic: &'static str,
    pub bold: bool,
    pub italic: bool,
}

/// An embedded TrueType program of a composite font whose codes are glyph numbers: a glyph it
/// holds can be used even if the file never showed it.
struct Grow {
    program: Vec<u8>,
    font: Option<ObjectId>,
    to_unicode: Option<ObjectId>,
}

/// The descendant font's dictionary, to change it, wherever the file keeps it (an object of its
/// own, or written inside the font).
fn descendant_mut(doc: &mut Document, font: ObjectId) -> Option<&mut Dictionary> {
    let held = doc.get_dictionary(font).ok()?.get(b"DescendantFonts").ok()?.clone();
    let (array_at, first) = match &held {
        Object::Reference(r) => (Some(*r), doc.get_object(*r).ok()?.as_array().ok()?.first()?.clone()),
        Object::Array(a) => (None, a.first()?.clone()),
        _ => return None,
    };
    if let Object::Reference(c) = first {
        return doc.get_dictionary_mut(c).ok();
    }
    let array = match array_at {
        Some(r) => doc.get_object_mut(r).ok()?,
        None => doc.get_dictionary_mut(font).ok()?.get_mut(b"DescendantFonts").ok()?,
    };
    match array {
        Object::Array(a) => a.first_mut()?.as_dict_mut().ok(),
        _ => None,
    }
}

struct FontInfo {
    wide: bool,     // two bytes per character (composite font, Identity-H)
    readable: bool, // its characters and widths are known
    to_uni: HashMap<u32, String>,
    from_uni: HashMap<char, u32>, // characters that can be written with it
    widths: HashMap<u32, f64>,
    default_w: f64,
    look: Look,
    grow: Option<Grow>,
    added: Vec<(u32, char, f64)>, // glyphs taken into use by this edit
    base: String,
}

fn resolve<'a>(doc: &'a Document, mut o: &'a Object) -> &'a Object {
    for _ in 0..16 {
        match o {
            Object::Reference(r) => match doc.get_object(*r) {
                Ok(x) => o = x,
                Err(_) => return o,
            },
            _ => return o,
        }
    }
    o
}

fn dict_of<'a>(doc: &'a Document, o: &'a Object) -> Option<&'a Dictionary> {
    match resolve(doc, o) {
        Object::Dictionary(d) => Some(d),
        Object::Stream(s) => Some(&s.dict),
        _ => None,
    }
}

fn stream_bytes(doc: &Document, o: &Object) -> Option<Vec<u8>> {
    match resolve(doc, o) {
        Object::Stream(s) => Some(if s.dict.has(b"Filter") { s.decompressed_content().ok()? } else { s.content.clone() }),
        _ => None,
    }
}

fn name_of(d: &Dictionary, key: &[u8]) -> String {
    d.get(key).ok().and_then(|o| o.as_name().ok()).map(|n| String::from_utf8_lossy(n).into_owned()).unwrap_or_default()
}

/// The descendant font of a composite font (its dictionary and, when it is an object, its id).
fn descendant(doc: &Document, font: &Dictionary) -> Option<(Option<ObjectId>, Dictionary)> {
    let kids = match resolve(doc, font.get(b"DescendantFonts").ok()?) {
        Object::Array(a) => a,
        _ => return None,
    };
    let first = kids.first()?;
    let id = first.as_reference().ok();
    Some((id, dict_of(doc, first)?.clone()))
}

/// The font program stored with a font, if it is one skrifa reads (TrueType, OpenType).
fn program_of(doc: &Document, font: &Dictionary) -> Option<Vec<u8>> {
    let holder = descendant(doc, font).map(|d| d.1).unwrap_or_else(|| font.clone());
    let desc = dict_of(doc, holder.get(b"FontDescriptor").ok()?)?;
    for key in [&b"FontFile2"[..], b"FontFile3"] {
        if let Ok(o) = desc.get(key) {
            if let Some(b) = stream_bytes(doc, o) {
                if skrifa::FontRef::new(&b).is_ok() {
                    return Some(b);
                }
            }
        }
    }
    None
}

fn family_from_name(name: &str) -> String {
    let n = name.to_lowercase().replace([' ', '-', '_'], "");
    let known: [(&str, &str); 22] = [
        ("timesnewroman", "Times New Roman"),
        ("arialnarrow", "Arial Narrow"),
        ("arialblack", "Arial Black"),
        ("arial", "Arial"),
        ("helveticaneue", "Helvetica Neue"),
        ("helvetica", "Helvetica"),
        ("couriernew", "Courier New"),
        ("courier", "Courier New"),
        ("calibri", "Calibri"),
        ("cambria", "Cambria"),
        ("georgia", "Georgia"),
        ("verdana", "Verdana"),
        ("tahoma", "Tahoma"),
        ("segoeui", "Segoe UI"),
        ("consolas", "Consolas"),
        ("garamond", "Garamond"),
        ("palatino", "Palatino Linotype"),
        ("bookantiqua", "Book Antiqua"),
        ("trebuchet", "Trebuchet MS"),
        ("comicsans", "Comic Sans MS"),
        ("roboto", "Roboto"),
        ("times", "Times New Roman"),
    ];
    known.iter().find(|(k, _)| n.contains(k)).map(|(_, v)| (*v).to_owned()).unwrap_or_default()
}

/// The look of a font read from its embedded program (name, weight, slant, serif or not), when
/// there is one. Printer drivers name fonts "CIDFont+F2" and leave the descriptor empty; the
/// program still says Arial Bold.
pub(crate) fn program_look(doc: &Document, font: &Dictionary) -> Option<Look> {
    look_of_program(&program_of(doc, font)?)
}

fn look_of_program(data: &[u8]) -> Option<Look> {
    use skrifa::raw::TableProvider;
    use skrifa::MetadataProvider;
    let f = skrifa::FontRef::new(data).ok()?;
    let family = f
        .localized_strings(skrifa::string::StringId::FAMILY_NAME)
        .english_or_first()
        .map(|s| s.chars().collect::<String>())
        .unwrap_or_default();
    let os2 = f.os2().ok();
    let head_style = f.head().ok().map(|h| h.mac_style().bits()).unwrap_or(0);
    if family.is_empty() && os2.is_none() {
        return None; // a stripped subset says nothing: the caller reads the dictionary instead
    }
    let attrs = f.attributes();
    let bold = attrs.weight.value() >= 600.0 || head_style & 1 != 0;
    let italic = attrs.style != skrifa::attribute::Style::Normal || head_style & 2 != 0;
    let panose: Vec<u8> = os2.as_ref().map(|o| o.panose_10().to_vec()).unwrap_or_default();
    let fixed = f.post().ok().map(|p| p.is_fixed_pitch() != 0).unwrap_or(false) || (panose.len() > 3 && panose[0] == 2 && panose[3] == 9);
    let low = family.to_lowercase();
    let serif_by_name = ["times", "georgia", "garamond", "cambria", "palatino", "antiqua", "bookman", "century", "minion", "serif", "roman"].iter().any(|k| low.contains(k)) && !low.contains("sans");
    let serif = if panose.len() > 1 && panose[0] == 2 && panose[1] >= 2 { panose[1] < 11 } else { serif_by_name };
    let generic = if fixed || low.contains("mono") || low.contains("courier") || low.contains("consol") {
        "Courier"
    } else if serif {
        "Times"
    } else {
        "Helvetica"
    };
    let ps = f.localized_strings(skrifa::string::StringId::POSTSCRIPT_NAME).english_or_first().map(|s| s.chars().collect::<String>()).unwrap_or_default();
    // "Demi", "Heavy", "Black" faces say so in their name when their weight number does not.
    let named = format!("{low} {}", ps.to_lowercase());
    let bold = bold || ["bold", "black", "heavy", "semibold", "demi"].iter().any(|k| named.contains(k));
    let italic = italic || named.contains("italic") || named.contains("oblique");
    Some(Look { family, ps, generic, bold, italic })
}

fn look_of(doc: &Document, font: &Dictionary) -> Look {
    if let Some(l) = program_look(doc, font) {
        return l;
    }
    let (generic, bold, italic) = super::font_style(doc, font);
    // "ABCDEF+ComicSansMS-Bold" names the face; a printer driver's "CIDFont+F2" names nothing.
    // A font drawn by the file itself (Type3) has its name in its descriptor only.
    let desc = dict_of(doc, font.get(b"FontDescriptor").unwrap_or(&Object::Null));
    let mut base = name_of(font, b"BaseFont");
    if base.is_empty() {
        base = desc.map(|d| name_of(d, b"FontName")).unwrap_or_default();
    }
    let ps = match base.split_once('+') {
        Some((tag, _)) if tag.len() != 6 => String::new(),
        Some((_, rest)) => rest.to_owned(),
        None => base.clone(),
    };
    let mut family = family_from_name(&base);
    if family.is_empty() {
        if let Some(Ok(Object::String(b, _))) = desc.map(|d| d.get(b"FontFamily")) {
            family = String::from_utf8_lossy(b).into_owned();
        }
    }
    Look { family, ps, generic, bold, italic }
}

const WIN_HIGH: [u16; 32] = [
    0x20AC, 0, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0, 0x017D, 0, 0, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014, 0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0,
    0x017E, 0x0178,
];

fn win_ansi(code: u32) -> Option<char> {
    match code {
        32..=126 | 160..=255 => char::from_u32(code),
        128..=159 => char::from_u32(WIN_HIGH[(code - 128) as usize] as u32).filter(|c| *c != '\0'),
        _ => None,
    }
}

fn win_ansi_code(c: char) -> Option<u8> {
    let u = c as u32;
    if (32..=126).contains(&u) || (160..=255).contains(&u) {
        return Some(u as u8);
    }
    WIN_HIGH.iter().position(|h| *h as u32 == u && u != 0).map(|p| 128 + p as u8)
}

fn base_encoding(name: &str, code: u32) -> Option<char> {
    match name {
        "WinAnsiEncoding" => win_ansi(code),
        // Standard and Mac Roman: the ASCII part is what matters here; the rest stays unknown
        // (shown as it is, kept as it is, just not typed).
        "StandardEncoding" => match code {
            0x27 => Some('\u{2019}'),
            0x60 => Some('\u{2018}'),
            32..=126 => char::from_u32(code),
            _ => None,
        },
        _ => match code {
            32..=126 => char::from_u32(code),
            _ => None,
        },
    }
}

fn glyph_name_char(n: &str) -> Option<char> {
    if n.len() == 1 && n.as_bytes()[0].is_ascii_alphabetic() {
        return n.chars().next();
    }
    if let Some(h) = n.strip_prefix("uni") {
        if h.len() >= 4 {
            return u32::from_str_radix(&h[..4], 16).ok().and_then(char::from_u32);
        }
    }
    if let Some(h) = n.strip_prefix('u') {
        if (4..=6).contains(&h.len()) && h.bytes().all(|b| b.is_ascii_hexdigit()) {
            return u32::from_str_radix(h, 16).ok().and_then(char::from_u32);
        }
    }
    const T: [(&str, char); 86] = [
        ("space", ' '), ("exclam", '!'), ("quotedbl", '"'), ("numbersign", '#'), ("dollar", '$'), ("percent", '%'), ("ampersand", '&'), ("quotesingle", '\''),
        ("parenleft", '('), ("parenright", ')'), ("asterisk", '*'), ("plus", '+'), ("comma", ','), ("hyphen", '-'), ("minus", '\u{2212}'), ("period", '.'), ("slash", '/'),
        ("zero", '0'), ("one", '1'), ("two", '2'), ("three", '3'), ("four", '4'), ("five", '5'), ("six", '6'), ("seven", '7'), ("eight", '8'), ("nine", '9'),
        ("colon", ':'), ("semicolon", ';'), ("less", '<'), ("equal", '='), ("greater", '>'), ("question", '?'), ("at", '@'), ("bracketleft", '['), ("backslash", '\\'),
        ("bracketright", ']'), ("asciicircum", '^'), ("underscore", '_'), ("grave", '`'), ("braceleft", '{'), ("bar", '|'), ("braceright", '}'), ("asciitilde", '~'),
        ("quoteleft", '\u{2018}'), ("quoteright", '\u{2019}'), ("quotedblleft", '\u{201C}'), ("quotedblright", '\u{201D}'), ("endash", '\u{2013}'), ("emdash", '\u{2014}'),
        ("bullet", '\u{2022}'), ("ellipsis", '\u{2026}'), ("fi", '\u{FB01}'), ("fl", '\u{FB02}'), ("degree", '\u{B0}'), ("copyright", '\u{A9}'), ("registered", '\u{AE}'),
        ("trademark", '\u{2122}'), ("section", '\u{A7}'), ("paragraph", '\u{B6}'), ("sterling", '\u{A3}'), ("yen", '\u{A5}'), ("Euro", '\u{20AC}'), ("cent", '\u{A2}'),
        ("eacute", '\u{E9}'), ("egrave", '\u{E8}'), ("ecircumflex", '\u{EA}'), ("aacute", '\u{E1}'), ("agrave", '\u{E0}'), ("acircumflex", '\u{E2}'), ("adieresis", '\u{E4}'),
        ("odieresis", '\u{F6}'), ("udieresis", '\u{FC}'), ("ntilde", '\u{F1}'), ("ccedilla", '\u{E7}'), ("oacute", '\u{F3}'), ("uacute", '\u{FA}'), ("iacute", '\u{ED}'),
        ("germandbls", '\u{DF}'), ("multiply", '\u{D7}'), ("divide", '\u{F7}'), ("plusminus", '\u{B1}'), ("periodcentered", '\u{B7}'), ("guillemotleft", '\u{AB}'),
        ("guillemotright", '\u{BB}'), ("nbspace", '\u{A0}'),
    ];
    T.iter().find(|(k, _)| *k == n).map(|(_, c)| *c)
}

/// A ToUnicode map: character code to text.
fn parse_to_unicode(data: &[u8]) -> HashMap<u32, String> {
    enum Tok {
        Hex(Vec<u8>),
        Open,
        Close,
        Word(Vec<u8>),
    }
    let mut toks = Vec::new();
    let mut i = 0;
    while i < data.len() {
        let c = data[i];
        if c == b'<' && data.get(i + 1) != Some(&b'<') {
            let mut j = i + 1;
            let mut nib = Vec::new();
            while j < data.len() && data[j] != b'>' {
                if let Some(v) = (data[j] as char).to_digit(16) {
                    nib.push(v as u8);
                }
                j += 1;
            }
            if nib.len() % 2 == 1 {
                nib.push(0);
            }
            toks.push(Tok::Hex(nib.chunks(2).map(|p| p[0] << 4 | p[1]).collect()));
            i = j + 1;
        } else if c == b'[' {
            toks.push(Tok::Open);
            i += 1;
        } else if c == b']' {
            toks.push(Tok::Close);
            i += 1;
        } else if c.is_ascii_alphabetic() {
            let mut j = i;
            while j < data.len() && data[j].is_ascii_alphanumeric() {
                j += 1;
            }
            toks.push(Tok::Word(data[i..j].to_vec()));
            i = j;
        } else {
            i += 1;
        }
    }
    let code = |b: &[u8]| b.iter().fold(0u32, |a, x| a << 8 | *x as u32);
    let text = |b: &[u8], add: u32| -> String {
        let mut units: Vec<u16> = b.chunks(2).map(|p| if p.len() == 2 { (p[0] as u16) << 8 | p[1] as u16 } else { p[0] as u16 }).collect();
        if let Some(last) = units.last_mut() {
            *last = last.wrapping_add(add as u16);
        }
        String::from_utf16_lossy(&units)
    };
    let mut map = HashMap::new();
    let mut k = 0;
    while k < toks.len() {
        match &toks[k] {
            Tok::Word(w) if w == b"beginbfchar" => {
                k += 1;
                while k + 1 < toks.len() {
                    match (&toks[k], &toks[k + 1]) {
                        (Tok::Hex(a), Tok::Hex(b)) => {
                            map.insert(code(a), text(b, 0));
                            k += 2;
                        }
                        _ => break,
                    }
                }
            }
            Tok::Word(w) if w == b"beginbfrange" => {
                k += 1;
                while k + 2 < toks.len() {
                    let (Tok::Hex(lo), Tok::Hex(hi)) = (&toks[k], &toks[k + 1]) else { break };
                    let (lo, hi) = (code(lo), code(hi));
                    if hi < lo || hi - lo > 0xFFFF {
                        break;
                    }
                    match &toks[k + 2] {
                        Tok::Hex(dst) => {
                            for c in lo..=hi {
                                map.insert(c, text(dst, c - lo));
                            }
                            k += 3;
                        }
                        Tok::Open => {
                            let mut j = k + 3;
                            let mut c = lo;
                            while j < toks.len() {
                                match &toks[j] {
                                    Tok::Hex(d) => {
                                        map.insert(c, text(d, 0));
                                        c += 1;
                                    }
                                    _ => break,
                                }
                                j += 1;
                            }
                            k = j + 1;
                        }
                        _ => break,
                    }
                }
            }
            _ => k += 1,
        }
    }
    map
}

struct CodeDevice {
    seen: Vec<(u32, f64, f64)>,
}
impl<'a> hayro::hayro_interpret::Device<'a> for CodeDevice {
    fn draw_path(&mut self, _: &hayro::kurbo::BezPath, _: hayro::hayro_interpret::DrawProps<'a>, _: &hayro::hayro_interpret::DrawMode) {}
    fn push_clip_path(&mut self, _: &hayro::hayro_interpret::ClipPath) {}
    fn push_transparency_group(&mut self, _: f32, _: Option<hayro::hayro_interpret::SoftMask<'a>>, _: hayro::hayro_interpret::BlendMode) {}
    fn draw_glyph_run(&mut self, run: &hayro::hayro_interpret::font::GlyphRun<'_, 'a>, props: hayro::hayro_interpret::DrawProps<'a>, _: &hayro::hayro_interpret::DrawMode) {
        for g in run.glyphs() {
            let o = (props.transform * g.transform()) * hayro::kurbo::Point::new(0.0, 0.0);
            self.seen.push((g.char_code(), o.x, o.y));
        }
    }
    fn draw_image(&mut self, _: hayro::hayro_interpret::Image<'a, '_>, _: hayro::hayro_interpret::ImageDrawProps<'a>) {}
    fn pop_clip(&mut self) {}
    fn pop_transparency_group(&mut self) {}
}

/// Every character of a page as the renderer places it: (code, x, y) as shown. For the standard
/// fonts' widths and for checking this module's own reading of a page against the renderer.
pub(crate) fn renderer_glyphs(bytes: Vec<u8>, index: usize) -> Vec<(u32, f64, f64)> {
    use hayro::hayro_interpret::util::TransformExt;
    let Ok(pdf) = hayro::hayro_syntax::Pdf::new(bytes) else { return Vec::new() };
    let pages = pdf.pages();
    let Some(page) = pages.get(index) else { return Vec::new() };
    let (w, h) = page.render_dimensions();
    let cache = hayro::hayro_interpret::InterpreterCache::new();
    let mut ctx = hayro::hayro_interpret::Context::new(
        page.initial_transform(true).to_kurbo(),
        hayro::kurbo::Rect::new(0.0, 0.0, w as f64, h as f64),
        &cache,
        page.xref(),
        hayro::hayro_interpret::InterpreterSettings::default(),
    );
    let mut dev = CodeDevice { seen: Vec::new() };
    hayro::hayro_interpret::interpret_page(page, &mut ctx, &mut dev);
    dev.seen
}

thread_local! {
    static STANDARD_WIDTHS: std::cell::RefCell<HashMap<(String, String), HashMap<u32, f64>>> = std::cell::RefCell::new(HashMap::new());
}

/// The widths of a font that is not in the file and brings no width table (the 14 standard
/// fonts): asked of the renderer once, by showing every code next to a full stop.
fn standard_widths(base: &str, encoding: &str) -> HashMap<u32, f64> {
    let key = (base.to_owned(), encoding.to_owned());
    if let Some(w) = STANDARD_WIDTHS.with(|c| c.borrow().get(&key).cloned()) {
        return w;
    }
    let mut doc = Document::with_version("1.7");
    let pages_id = doc.new_object_id();
    let mut font = dictionary! { "Type" => "Font", "Subtype" => "Type1", "BaseFont" => base };
    if !encoding.is_empty() {
        font.set("Encoding", encoding);
    }
    let font = doc.add_object(font);
    let mut ops = String::from("BT /F 100 Tf");
    for code in 32u32..=255 {
        ops.push_str(&format!(" 1 0 0 1 10 {} Tm <{:02X}2E> Tj", 10 + (code - 31) * 150, code));
    }
    ops.push_str(" ET");
    let c = doc.add_object(Stream::new(dictionary! {}, ops.into_bytes()));
    let page = doc.add_object(dictionary! { "Type" => "Page", "Parent" => pages_id, "Contents" => c, "MediaBox" => vec![0.into(), 0.into(), 400.into(), 34000.into()], "Resources" => dictionary! { "Font" => dictionary! { "F" => font } } });
    doc.objects.insert(pages_id, Object::Dictionary(dictionary! { "Type" => "Pages", "Kids" => vec![page.into()], "Count" => 1 }));
    let cat = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
    doc.trailer.set("Root", cat);
    let mut v = vec![];
    let mut out = HashMap::new();
    if doc.save_to(&mut v).is_ok() {
        let seen = renderer_glyphs(v, 0);
        for pair in seen.windows(2) {
            let (a, b) = (pair[0], pair[1]);
            if b.0 == 0x2E && (a.2 - b.2).abs() < 1.0 && b.1 > a.1 - 0.001 {
                // The page is 34000 high and shown top-down: the row tells the code.
                let row = ((34000.0 - a.2 - 10.0) / 150.0).round() as i64 + 31;
                if row == a.0 as i64 || a.0 != 0x2E {
                    out.entry(a.0).or_insert((b.1 - a.1) * 10.0);
                }
            }
        }
    }
    STANDARD_WIDTHS.with(|c| c.borrow_mut().insert(key, out.clone()));
    out
}

fn load_font(doc: &Document, id: Option<ObjectId>, font: &Dictionary) -> FontInfo {
    let subtype = name_of(font, b"Subtype");
    let base = name_of(font, b"BaseFont");
    let mut f = FontInfo { wide: false, readable: false, to_uni: HashMap::new(), from_uni: HashMap::new(), widths: HashMap::new(), default_w: 0.0, look: look_of(doc, font), grow: None, added: Vec::new(), base: base.clone() };
    if f.base.is_empty() {
        f.base = dict_of(doc, font.get(b"FontDescriptor").unwrap_or(&Object::Null)).map(|d| name_of(d, b"FontName")).unwrap_or_default();
    }
    let tu_obj = font.get(b"ToUnicode").ok();
    let tu = tu_obj.and_then(|o| stream_bytes(doc, o)).map(|b| parse_to_unicode(&b));
    let embedded = |d: &Dictionary| dict_of(doc, d.get(b"FontDescriptor").unwrap_or(&Object::Null)).map(|fd| fd.has(b"FontFile") || fd.has(b"FontFile2") || fd.has(b"FontFile3")).unwrap_or(false);
    match subtype.as_str() {
        "Type0" => {
            f.wide = true;
            let Some((_, cid)) = descendant(doc, font) else { return f };
            let enc = name_of(font, b"Encoding");
            let Some(tu) = tu else { return f };
            if enc != "Identity-H" {
                return f;
            }
            f.default_w = cid.get(b"DW").map(num).unwrap_or(1000.0);
            if let Ok(Object::Array(w)) = cid.get(b"W").map(|o| resolve(doc, o)) {
                let mut k = 0;
                while k + 1 < w.len() {
                    let c = num(resolve(doc, &w[k])) as u32;
                    match resolve(doc, &w[k + 1]) {
                        Object::Array(list) => {
                            for (n, x) in list.iter().enumerate() {
                                f.widths.insert(c + n as u32, num(resolve(doc, x)));
                            }
                            k += 2;
                        }
                        other => {
                            if k + 2 >= w.len() {
                                break;
                            }
                            let (c2, width) = (num(other) as u32, num(resolve(doc, &w[k + 2])));
                            for c in c..=c2.min(c + 0xFFFF) {
                                f.widths.insert(c, width);
                            }
                            k += 3;
                        }
                    }
                }
            }
            f.to_uni = tu;
            let mut codes: Vec<u32> = f.to_uni.keys().copied().collect();
            codes.sort_unstable();
            for c in codes {
                let t = &f.to_uni[&c];
                let mut it = t.chars();
                if let (Some(ch), None) = (it.next(), it.next()) {
                    f.from_uni.entry(ch).or_insert(c);
                }
            }
            f.readable = true;
            let identity_gids = match cid.get(b"CIDToGIDMap").map(|o| resolve(doc, o)) {
                Err(_) => true,
                Ok(Object::Name(n)) => n == b"Identity",
                _ => false,
            };
            if name_of(&cid, b"Subtype") == "CIDFontType2" && identity_gids {
                if let Some(program) = program_of(doc, font) {
                    f.grow = Some(Grow { program, font: id, to_unicode: tu_obj.and_then(|o| o.as_reference().ok()) });
                }
            }
        }
        "Type1" | "TrueType" | "MMType1" => {
            let low = base.to_lowercase();
            if tu.is_none() && (low.contains("symbol") || low.contains("dingbat")) {
                return f;
            }
            let is_embedded = embedded(font);
            let mut table: Vec<Option<char>> = vec![None; 256];
            let enc_obj = font.get(b"Encoding").ok().map(|o| resolve(doc, o));
            let mut enc_name = String::new();
            match enc_obj {
                Some(Object::Name(n)) => enc_name = String::from_utf8_lossy(n).into_owned(),
                Some(Object::Dictionary(d)) => enc_name = name_of(d, b"BaseEncoding"),
                _ => {}
            }
            let effective = if !enc_name.is_empty() {
                enc_name.clone()
            } else if subtype == "TrueType" || is_embedded {
                "WinAnsiEncoding".to_owned()
            } else {
                "StandardEncoding".to_owned()
            };
            for (c, slot) in table.iter_mut().enumerate() {
                *slot = base_encoding(&effective, c as u32);
            }
            if let Some(Object::Dictionary(d)) = enc_obj {
                if let Ok(Object::Array(diff)) = d.get(b"Differences").map(|o| resolve(doc, o)) {
                    let mut at = 0usize;
                    for o in diff {
                        match resolve(doc, o) {
                            Object::Name(n) => {
                                if at < 256 {
                                    table[at] = glyph_name_char(&String::from_utf8_lossy(n));
                                }
                                at += 1;
                            }
                            x => at = num(x) as usize,
                        }
                    }
                }
            }
            for (c, ch) in table.iter().enumerate() {
                if let Some(ch) = ch {
                    f.to_uni.insert(c as u32, ch.to_string());
                }
            }
            let mut from_file: HashSet<u32> = HashSet::new();
            if let Some(tu) = &tu {
                for (c, t) in tu {
                    if *c < 256 {
                        f.to_uni.insert(*c, t.clone());
                        from_file.insert(*c);
                    }
                }
            }
            let mut have_widths = false;
            if let Ok(Object::Array(w)) = font.get(b"Widths").map(|o| resolve(doc, o)) {
                let first = font.get(b"FirstChar").map(|o| num(resolve(doc, o))).unwrap_or(0.0) as u32;
                for (n, x) in w.iter().enumerate() {
                    f.widths.insert(first + n as u32, num(resolve(doc, x)));
                }
                have_widths = !w.is_empty();
                f.default_w = dict_of(doc, font.get(b"FontDescriptor").unwrap_or(&Object::Null)).and_then(|d| d.get(b"MissingWidth").ok()).map(num).unwrap_or(0.0);
            }
            if !have_widths {
                if is_embedded {
                    return f; // no width table and a program of its own: not something to guess at
                }
                f.widths = standard_widths(&base, &enc_name);
                if f.widths.is_empty() {
                    return f;
                }
            }
            // What can be typed with it. Not embedded: everything its encoding names. Embedded:
            // only what the file is known to hold glyphs for (its ToUnicode list; else, for a
            // whole font, what has a width; for a subset, only what the page already shows).
            let subset = base.contains('+');
            let mut codes: Vec<u32> = f.to_uni.keys().copied().collect();
            codes.sort_unstable();
            for c in codes {
                let ok = if !is_embedded {
                    true
                } else if tu.is_some() {
                    from_file.contains(&c)
                } else {
                    !subset && f.widths.get(&c).copied().unwrap_or(0.0) > 0.0
                };
                let mut it = f.to_uni[&c].chars();
                if let (true, Some(ch), None) = (ok, it.next(), it.next()) {
                    f.from_uni.entry(ch).or_insert(c);
                }
            }
            f.readable = true;
        }
        "Type3" => {
            // Glyphs drawn by the file itself (browsers write fonts they may not embed this
            // way): widths are in the font's own units, scaled by its matrix.
            let Some(tu) = tu else { return f };
            let scale = match font.get(b"FontMatrix").map(|o| resolve(doc, o)) {
                Ok(Object::Array(a)) if a.len() == 6 => num(resolve(doc, &a[0])).abs(),
                _ => 0.001,
            };
            if let Ok(Object::Array(w)) = font.get(b"Widths").map(|o| resolve(doc, o)) {
                let first = font.get(b"FirstChar").map(|o| num(resolve(doc, o))).unwrap_or(0.0) as u32;
                for (n, x) in w.iter().enumerate() {
                    f.widths.insert(first + n as u32, num(resolve(doc, x)) * scale * 1000.0);
                }
            }
            if f.widths.is_empty() {
                return f;
            }
            let mut codes: Vec<u32> = tu.keys().copied().filter(|c| *c < 256).collect();
            codes.sort_unstable();
            for c in codes {
                let t = tu[&c].clone();
                let mut it = t.chars();
                if let (Some(ch), None) = (it.next(), it.next()) {
                    f.from_uni.entry(ch).or_insert(c);
                }
                f.to_uni.insert(c, t);
            }
            f.readable = true;
        }
        _ => {}
    }
    f
}

/// The fonts of one page, read when first used.
struct Fonts {
    page: ObjectId,
    list: Vec<FontInfo>,
    names: Vec<Vec<u8>>,
    by_name: HashMap<Vec<u8>, Option<usize>>,
}

fn page_font_entry(doc: &Document, page: ObjectId, name: &[u8]) -> Option<(Option<ObjectId>, Dictionary)> {
    let res = dict_of(doc, doc.get_dictionary(page).ok()?.get(b"Resources").ok()?)?;
    let fonts = dict_of(doc, res.get(b"Font").ok()?)?;
    let entry = fonts.get(name).ok()?;
    Some((entry.as_reference().ok(), dict_of(doc, entry)?.clone()))
}

impl Fonts {
    fn new(page: ObjectId) -> Self {
        Fonts { page, list: Vec::new(), names: Vec::new(), by_name: HashMap::new() }
    }
    fn get(&mut self, doc: &Document, name: &[u8]) -> Option<usize> {
        if let Some(i) = self.by_name.get(name) {
            return *i;
        }
        let found = page_font_entry(doc, self.page, name).map(|(id, d)| {
            self.list.push(load_font(doc, id, &d));
            self.names.push(name.to_vec());
            self.list.len() - 1
        });
        self.by_name.insert(name.to_vec(), found);
        found
    }
}

// ---------------------------------------------------------------- reading a page

/// One shown character: where it is in the page's operations and where it is on the page.
#[derive(Clone, Debug)]
pub(crate) struct Glyph {
    op: usize,
    el: usize,  // which element of the TJ array (0 for Tj)
    at: usize,  // byte offset in that string
    len: usize, // bytes
    pub code: u32,
    font: usize,
    size: f64, // the Tf size
    pub text: String,
    pub x: f64, // as shown: points from the top-left of the page
    pub y: f64,
    dx: f64, // the way the line runs, as shown
    dy: f64,
    adv: f64,   // how far the pen moves after it, as shown
    esize: f64, // font size as shown
    k: f64,     // how far a TJ number of 1 moves the pen back, as shown
    color: [u8; 3],
    hidden: bool,
    loose: bool, // follows text whose width is unknown: its place is a guess
    upright: bool,
}

#[derive(Clone)]
struct Gs {
    ctm: Mx,
    tc: f64,
    tw: f64,
    th: f64,
    tl: f64,
    rise: f64,
    font: Option<usize>,
    font_name: Vec<u8>,
    size: f64,
    tr: i64,
    fill: [u8; 3],
}

fn to_byte(v: f64) -> u8 {
    (v.clamp(0.0, 1.0) * 255.0).round() as u8
}

fn interpret(doc: &Document, fonts: &mut Fonts, ops: &[Operation], p: &Mx) -> Vec<Glyph> {
    let mut out = Vec::new();
    let mut gs = Gs { ctm: ID, tc: 0.0, tw: 0.0, th: 1.0, tl: 0.0, rise: 0.0, font: None, font_name: Vec::new(), size: 0.0, tr: 0, fill: [0, 0, 0] };
    let mut stack: Vec<Gs> = Vec::new();
    let (mut tm, mut tlm) = (ID, ID);
    let mut loose = false;
    for (oi, op) in ops.iter().enumerate() {
        let o = &op.operands;
        let n = |i: usize| o.get(i).map(num).unwrap_or(0.0);
        match op.operator.as_str() {
            "q" => stack.push(gs.clone()),
            "Q" => {
                if let Some(s) = stack.pop() {
                    gs = s;
                }
            }
            "cm" if o.len() == 6 => gs.ctm = mul(&[n(0), n(1), n(2), n(3), n(4), n(5)], &gs.ctm),
            "BT" => {
                tm = ID;
                tlm = ID;
                loose = false;
            }
            "Tf" if o.len() == 2 => {
                gs.font_name = o[0].as_name().map(|x| x.to_vec()).unwrap_or_default();
                gs.font = fonts.get(doc, &gs.font_name);
                gs.size = n(1);
            }
            "Tc" => gs.tc = n(0),
            "Tw" => gs.tw = n(0),
            "Tz" => gs.th = n(0) / 100.0,
            "TL" => gs.tl = n(0),
            "Ts" => gs.rise = n(0),
            "Tr" => gs.tr = n(0) as i64,
            "g" if o.len() == 1 => gs.fill = [to_byte(n(0)); 3],
            "rg" if o.len() == 3 => gs.fill = [to_byte(n(0)), to_byte(n(1)), to_byte(n(2))],
            "k" if o.len() == 4 => gs.fill = [to_byte((1.0 - n(0)) * (1.0 - n(3))), to_byte((1.0 - n(1)) * (1.0 - n(3))), to_byte((1.0 - n(2)) * (1.0 - n(3)))],
            "sc" | "scn" => {
                let all_numbers = o.iter().all(|x| matches!(x, Object::Integer(_) | Object::Real(_)));
                match (all_numbers, o.len()) {
                    (true, 1) => gs.fill = [to_byte(n(0)); 3],
                    (true, 3) => gs.fill = [to_byte(n(0)), to_byte(n(1)), to_byte(n(2))],
                    (true, 4) => gs.fill = [to_byte((1.0 - n(0)) * (1.0 - n(3))), to_byte((1.0 - n(1)) * (1.0 - n(3))), to_byte((1.0 - n(2)) * (1.0 - n(3)))],
                    _ => {}
                }
            }
            "Td" | "TD" if o.len() == 2 => {
                if op.operator == "TD" {
                    gs.tl = -n(1);
                }
                tlm = mul(&[1.0, 0.0, 0.0, 1.0, n(0), n(1)], &tlm);
                tm = tlm;
                loose = false;
            }
            "Tm" if o.len() == 6 => {
                tlm = [n(0), n(1), n(2), n(3), n(4), n(5)];
                tm = tlm;
                loose = false;
            }
            "T*" | "'" | "\"" | "Tj" | "TJ" => {
                if op.operator == "\"" && o.len() == 3 {
                    gs.tw = n(0);
                    gs.tc = n(1);
                }
                if matches!(op.operator.as_str(), "T*" | "'" | "\"") {
                    tlm = mul(&[1.0, 0.0, 0.0, 1.0, 0.0, -gs.tl], &tlm);
                    tm = tlm;
                    loose = false;
                }
                if op.operator == "T*" {
                    continue;
                }
                let single;
                let elements: &[Object] = match (op.operator.as_str(), o.last()) {
                    ("TJ", Some(Object::Array(a))) => a,
                    (_, Some(s @ Object::String(..))) => {
                        single = [s.clone()];
                        &single
                    }
                    _ => continue,
                };
                for (ei, e) in elements.iter().enumerate() {
                    match e {
                        Object::String(bytes, _) => {
                            let Some(fi) = gs.font else {
                                loose = true;
                                continue;
                            };
                            let f = &fonts.list[fi];
                            if !f.readable {
                                loose = true;
                                continue;
                            }
                            let step = if f.wide { 2 } else { 1 };
                            let mut at = 0;
                            while at + step <= bytes.len() {
                                let code = if f.wide { (bytes[at] as u32) << 8 | bytes[at + 1] as u32 } else { bytes[at] as u32 };
                                let w0 = f.widths.get(&code).copied().unwrap_or(f.default_w) / 1000.0;
                                let full = mul(&mul(&tm, &gs.ctm), p);
                                let (x, y) = apply(&full, 0.0, gs.rise);
                                let unit = (full[0] * full[0] + full[1] * full[1]).sqrt();
                                let up = (full[2] * full[2] + full[3] * full[3]).sqrt();
                                let tx = (w0 * gs.size + gs.tc + if !f.wide && code == 32 { gs.tw } else { 0.0 }) * gs.th;
                                if unit > 1e-9 {
                                    let (dx, dy) = (full[0] / unit, full[1] / unit);
                                    out.push(Glyph {
                                        op: oi,
                                        el: ei,
                                        at,
                                        len: step,
                                        code,
                                        font: fi,
                                        size: gs.size,
                                        text: f.to_uni.get(&code).cloned().filter(|t| !t.is_empty()).unwrap_or_else(|| "\u{FFFD}".into()),
                                        x,
                                        y,
                                        dx,
                                        dy,
                                        adv: tx * unit,
                                        esize: (gs.size * up).abs(),
                                        k: gs.size * gs.th * unit / 1000.0,
                                        color: gs.fill,
                                        hidden: gs.tr == 3 || gs.tr == 7,
                                        loose,
                                        // Reads left to right with its top up, as shown.
                                        upright: dx > 0.985 && full[3] * gs.size < 0.0 && gs.size * gs.th > 0.0,
                                    });
                                }
                                tm = mul(&[1.0, 0.0, 0.0, 1.0, tx, 0.0], &tm);
                                at += step;
                            }
                        }
                        Object::Integer(_) | Object::Real(_) => {
                            let tx = -num(e) / 1000.0 * gs.size * gs.th;
                            tm = mul(&[1.0, 0.0, 0.0, 1.0, tx, 0.0], &tm);
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
    out
}

// ---------------------------------------------------------------- lines

#[derive(Clone)]
struct Item {
    g: Option<usize>, // the glyph, or None for a gap that reads as a space
    x: f64,
    text: String,
}

struct Line {
    items: Vec<Item>,
    base: f64,
    size: f64,
    end: f64,
    block: usize,
}

/// Lines as a person sees them: characters on one baseline with no wide gap between them. A
/// gap of a column or a tab starts another line, so what is edited never pushes a table's next
/// column. Small raised or lowered text (6th, H2O) stays in its line.
fn build_lines(glyphs: &[Glyph]) -> Vec<Line> {
    struct Seg {
        ids: Vec<usize>,
        base: f64,
        size: f64,
    }
    let end = |g: &Glyph| g.x + g.adv;
    let mut segs: Vec<Seg> = Vec::new();
    for (i, g) in glyphs.iter().enumerate() {
        if g.hidden || g.loose || !g.upright || g.esize < 0.5 {
            continue;
        }
        let joins = segs.last().is_some_and(|s| {
            let p = &glyphs[*s.ids.last().unwrap()];
            let big = s.size.max(g.esize);
            let gap = g.x - end(p);
            (g.y - s.base).abs() < 0.5 * big && gap > -0.5 * big && gap < 1.5 * big
        });
        if joins {
            let s = segs.last_mut().unwrap();
            s.ids.push(i);
            if g.esize > s.size * 1.05 {
                // The line's baseline is that of its biggest letters.
                s.size = g.esize;
                s.base = g.y;
            }
        } else {
            segs.push(Seg { ids: vec![i], base: g.y, size: g.esize });
        }
    }
    // Pieces written at different moments that sit side by side are one line too.
    let mut merged = true;
    while merged && segs.len() < 4000 {
        merged = false;
        'outer: for a in 0..segs.len() {
            for b in 0..segs.len() {
                if a == b {
                    continue;
                }
                let (sa, sb) = (&segs[a], &segs[b]);
                let big = sa.size.max(sb.size);
                if (sa.base - sb.base).abs() > 0.2 * big || (sa.size - sb.size).abs() > 0.5 * big {
                    continue;
                }
                let gap = glyphs[sb.ids[0]].x - end(&glyphs[*sa.ids.last().unwrap()]);
                if gap > -0.2 * big && gap < 1.5 * big {
                    let tail = segs[b].ids.clone();
                    segs[a].ids.extend(tail);
                    segs.remove(b);
                    merged = true;
                    break 'outer;
                }
            }
        }
    }
    let mut lines: Vec<Line> = Vec::new();
    for s in segs {
        let mut items: Vec<Item> = Vec::new();
        for (n, id) in s.ids.iter().enumerate() {
            let g = &glyphs[*id];
            if n > 0 {
                let p = &glyphs[s.ids[n - 1]];
                let gap = g.x - end(p);
                let blank = |t: &str| t.chars().all(char::is_whitespace);
                if gap > 0.2 * s.size && !blank(&p.text) && !blank(&g.text) {
                    items.push(Item { g: None, x: end(p), text: " ".into() });
                }
            }
            items.push(Item { g: Some(*id), x: g.x, text: g.text.clone() });
        }
        let last = &glyphs[*s.ids.last().unwrap()];
        lines.push(Line { items, base: s.base, size: s.size, end: end(last), block: 0 });
    }
    // Blocks: lines of one paragraph (same size, one under the other).
    let mut block = 0;
    for i in 0..lines.len() {
        if i > 0 {
            let (p, l) = (&lines[i - 1], &lines[i]);
            let step = l.base - p.base;
            let same = (l.size - p.size).abs() < 0.15 * p.size && step > 0.7 * p.size && step < 1.9 * p.size && l.items[0].x < p.end && p.items[0].x < l.end;
            if !same {
                block += 1;
            }
        }
        lines[i].block = block;
    }
    lines
}

/// Where each operation of a page's drawing lies in its bytes: (start, end, operator). None when
/// the bytes are not understood with certainty.
fn scan_operations(raw: &[u8]) -> Option<Vec<(usize, usize, Vec<u8>)>> {
    let space = |c: u8| matches!(c, 0 | 9 | 10 | 12 | 13 | 32);
    let delim = |c: u8| matches!(c, b'(' | b')' | b'<' | b'>' | b'[' | b']' | b'{' | b'}' | b'/' | b'%');
    let mut out = Vec::new();
    let (mut i, mut start, mut depth) = (0usize, None::<usize>, 0i32);
    while i < raw.len() {
        let c = raw[i];
        if space(c) {
            i += 1;
            continue;
        }
        if c == b'%' {
            while i < raw.len() && raw[i] != b'\n' && raw[i] != b'\r' {
                i += 1;
            }
            continue;
        }
        if start.is_none() {
            start = Some(i);
        }
        match c {
            b'(' => {
                let mut nest = 0;
                while i < raw.len() {
                    match raw[i] {
                        b'\\' => i += 1,
                        b'(' => nest += 1,
                        b')' => {
                            nest -= 1;
                            if nest == 0 {
                                break;
                            }
                        }
                        _ => {}
                    }
                    i += 1;
                }
                i += 1;
            }
            b'<' if raw.get(i + 1) == Some(&b'<') => {
                depth += 1;
                i += 2;
            }
            b'>' if raw.get(i + 1) == Some(&b'>') => {
                depth -= 1;
                i += 2;
            }
            b'<' => {
                while i < raw.len() && raw[i] != b'>' {
                    i += 1;
                }
                i += 1;
            }
            b'[' => {
                depth += 1;
                i += 1;
            }
            b']' => {
                depth -= 1;
                i += 1;
            }
            b'/' => {
                i += 1;
                while i < raw.len() && !space(raw[i]) && !delim(raw[i]) {
                    i += 1;
                }
            }
            b')' | b'>' | b'{' | b'}' => return None,
            _ => {
                let from = i;
                while i < raw.len() && !space(raw[i]) && !delim(raw[i]) {
                    i += 1;
                }
                let word = &raw[from..i];
                let number = word.iter().all(|b| b.is_ascii_digit() || matches!(b, b'+' | b'-' | b'.'));
                if depth != 0 || number || matches!(word, b"true" | b"false" | b"null") {
                    continue;
                }
                if word == b"BI" {
                    // A picture written into the drawing: everything up to its EI is one operation.
                    let id = (i..raw.len().saturating_sub(2)).find(|k| &raw[*k..*k + 2] == b"ID" && space(raw[*k + 2]) && (*k == 0 || space(raw[*k - 1])))?;
                    let ei = (id + 3..raw.len().saturating_sub(1)).find(|k| &raw[*k..*k + 2] == b"EI" && space(raw[*k - 1]) && raw.get(*k + 2).is_none_or(|b| space(*b)))?;
                    i = ei + 2;
                }
                out.push((start.take()?, i, word.to_vec()));
            }
        }
        if depth < 0 {
            return None;
        }
    }
    if start.is_some() || depth != 0 {
        return None;
    }
    Some(out)
}

/// A font of this computer, handed over by the viewer for letters the file's own fonts lack.
struct LocalFont {
    data: Vec<u8>,
    look: Look,
    used: Option<usize>, // its place in the page's fonts once it is in the file
}

/// Only the glyphs in `keep` (and the parts they are built of) stay in a TrueType program; the
/// tables a PDF does not read go. What a file carries for a few typed letters is then a few
/// kilobytes, not the whole font.
fn subset_truetype(data: &[u8], keep: &HashSet<u32>) -> Option<Vec<u8>> {
    let be16 = |d: &[u8], o: usize| -> Option<usize> { Some(u16::from_be_bytes(d.get(o..o + 2)?.try_into().ok()?) as usize) };
    let be32 = |d: &[u8], o: usize| -> Option<usize> { Some(u32::from_be_bytes(d.get(o..o + 4)?.try_into().ok()?) as usize) };
    let mut tables: HashMap<[u8; 4], (usize, usize)> = HashMap::new();
    for i in 0..be16(data, 4)? {
        let r = 12 + 16 * i;
        tables.insert(data.get(r..r + 4)?.try_into().ok()?, (be32(data, r + 8)?, be32(data, r + 12)?));
    }
    let table = |tag: &[u8; 4]| -> Option<&[u8]> {
        let (o, l) = *tables.get(tag)?;
        data.get(o..o.checked_add(l)?)
    };
    let (head, maxp, loca, glyf) = (table(b"head")?, table(b"maxp")?, table(b"loca")?, table(b"glyf")?);
    let long = be16(head, 50)? == 1;
    let count = be16(maxp, 4)?;
    let off = |g: usize| -> Option<usize> { if long { be32(loca, g * 4) } else { Some(be16(loca, g * 2)? * 2) } };
    let mut want = vec![false; count];
    let mut todo: Vec<usize> = keep.iter().map(|g| *g as usize).filter(|g| *g < count).collect();
    todo.push(0);
    while let Some(g) = todo.pop() {
        if want[g] {
            continue;
        }
        want[g] = true;
        let (a, b) = (off(g)?, off(g + 1)?);
        let Some(d) = glyf.get(a..b) else { continue };
        if d.len() >= 10 && i16::from_be_bytes([d[0], d[1]]) < 0 {
            // Built of other glyphs: they stay too.
            let mut at = 10;
            while at + 4 <= d.len() {
                let (flags, part) = (be16(d, at)?, be16(d, at + 2)?);
                if part < count {
                    todo.push(part);
                }
                at += 4 + if flags & 1 != 0 { 4 } else { 2 };
                at += if flags & 8 != 0 { 2 } else if flags & 0x40 != 0 { 4 } else if flags & 0x80 != 0 { 8 } else { 0 };
                if flags & 0x20 == 0 {
                    break;
                }
            }
        }
    }
    let (mut new_glyf, mut new_loca) = (Vec::new(), Vec::with_capacity((count + 1) * 4));
    for (g, wanted) in want.iter().enumerate() {
        new_loca.extend((new_glyf.len() as u32).to_be_bytes());
        if *wanted {
            if let Some(d) = glyf.get(off(g)?..off(g + 1)?) {
                new_glyf.extend_from_slice(d);
                while new_glyf.len() % 4 != 0 {
                    new_glyf.push(0);
                }
            }
        }
    }
    new_loca.extend((new_glyf.len() as u32).to_be_bytes());
    let mut new_head = head.to_vec();
    new_head.get_mut(8..12)?.fill(0);
    new_head.get_mut(50..52)?.copy_from_slice(&[0, 1]);
    let mut parts: Vec<([u8; 4], Vec<u8>)> = Vec::new();
    for tag in [b"OS/2", b"cvt ", b"fpgm", b"gasp", b"glyf", b"head", b"hhea", b"hmtx", b"loca", b"maxp", b"name", b"prep"] {
        let d = match tag {
            b"glyf" => new_glyf.clone(),
            b"loca" => new_loca.clone(),
            b"head" => new_head.clone(),
            _ => match table(tag) {
                Some(d) => d.to_vec(),
                None => continue,
            },
        };
        parts.push((*tag, d));
    }
    let sum = |d: &[u8]| d.chunks(4).fold(0u32, |a, c| a.wrapping_add(u32::from_be_bytes([c[0], *c.get(1).unwrap_or(&0), *c.get(2).unwrap_or(&0), *c.get(3).unwrap_or(&0)])));
    let n = parts.len() as u16;
    let pow = 15 - n.leading_zeros() as u16;
    let mut out = data.get(0..4)?.to_vec();
    for v in [n, (1u16 << pow) * 16, pow, n * 16 - (1u16 << pow) * 16] {
        out.extend(v.to_be_bytes());
    }
    let (mut at, mut head_at) = (12 + 16 * parts.len(), 0);
    for (tag, d) in &parts {
        if tag == b"head" {
            head_at = at;
        }
        out.extend(tag);
        out.extend(sum(d).to_be_bytes());
        out.extend((at as u32).to_be_bytes());
        out.extend((d.len() as u32).to_be_bytes());
        at += (d.len() + 3) & !3;
    }
    for (_, d) in &parts {
        out.extend_from_slice(d);
        while out.len() % 4 != 0 {
            out.push(0);
        }
    }
    let whole = 0xB1B0AFBAu32.wrapping_sub(sum(&out));
    out.get_mut(head_at + 8..head_at + 12)?.copy_from_slice(&whole.to_be_bytes());
    Some(out)
}

/// Puts a font of this computer into the file as a font of this page, empty for now: glyphs are
/// taken into use as letters are typed, and the program is cut down to them when the file is
/// written. Only TrueType outlines (most fonts on Windows); others are left to the stand-in.
fn embed_local(t: &mut PageText, which: usize) -> Option<usize> {
    use skrifa::raw::TableProvider;
    use skrifa::MetadataProvider;
    let data = t.local[which].data.clone();
    let look = t.local[which].look.clone();
    let font = skrifa::FontRef::new(&data).ok()?;
    font.glyf().ok()?;
    let m = font.metrics(skrifa::instance::Size::unscaled(), skrifa::instance::LocationRef::default());
    let k = 1000.0 / (m.units_per_em.max(1) as f32);
    let bounds = m.bounds.map(|b| vec![Object::Real(b.x_min * k), Object::Real(b.y_min * k), Object::Real(b.x_max * k), Object::Real(b.y_max * k)]).unwrap_or_else(|| vec![0.into(), (-250).into(), 1000.into(), 1000.into()]);
    let file = t.doc.add_object(Stream::new(dictionary! { "Length1" => data.len() as i64 }, data));
    // Six letters and a plus before the name say "part of a font", as every writer of PDFs does.
    let tag: String = (0..6).map(|n| (b'A' + ((file.0 / 26u32.pow(n)) % 26) as u8) as char).collect();
    let clean: String = look.ps.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_')).collect();
    let name = format!("{tag}+{}", if clean.is_empty() { "Font" } else { &clean });
    let cmap = b"/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /Adobe-Identity-UCS def /CMapType 2 def 1 begincodespacerange <0000> <FFFF> endcodespacerange\nendcmap CMapName currentdict /CMap defineresource pop end end".to_vec();
    let to_unicode = t.doc.add_object(Stream::new(dictionary! {}, cmap));
    let flags = 32 | if look.generic == "Times" { 2 } else { 0 } | if look.generic == "Courier" { 1 } else { 0 } | if look.italic { 64 } else { 0 };
    let desc = t.doc.add_object(dictionary! {
        "Type" => "FontDescriptor", "FontName" => name.as_str(), "Flags" => flags, "FontBBox" => bounds, "ItalicAngle" => Object::Real(m.italic_angle),
        "Ascent" => Object::Real(m.ascent * k), "Descent" => Object::Real(m.descent * k), "CapHeight" => Object::Real(m.cap_height.unwrap_or(m.ascent * 0.7) * k),
        "StemV" => if look.bold { 140 } else { 80 }, "FontWeight" => if look.bold { 700 } else { 400 }, "FontFile2" => file,
    });
    let cid = t.doc.add_object(dictionary! {
        "Type" => "Font", "Subtype" => "CIDFontType2", "BaseFont" => name.as_str(),
        "CIDSystemInfo" => dictionary! { "Registry" => Object::string_literal("Adobe"), "Ordering" => Object::string_literal("Identity"), "Supplement" => 0 },
        "FontDescriptor" => desc, "DW" => 1000, "W" => Object::Array(Vec::new()), "CIDToGIDMap" => "Identity",
    });
    let id = t.doc.add_object(dictionary! { "Type" => "Font", "Subtype" => "Type0", "BaseFont" => name.as_str(), "Encoding" => "Identity-H", "DescendantFonts" => vec![Object::Reference(cid)], "ToUnicode" => to_unicode });
    let res = format!("GmbL{}", id.0);
    super::add_resource(&mut t.doc, t.page, "Font", &res, Object::Reference(id)).ok()?;
    t.fonts.by_name.remove(res.as_bytes());
    let fi = t.fonts.get(&t.doc, res.as_bytes())?;
    t.fonts.list[fi].grow.as_ref()?;
    t.local_files.push((fi, file));
    Some(fi)
}

/// A letter from a font of this computer that is the run's own typeface: (font, code).
fn local(t: &mut PageText, look: &Look, ch: char) -> Option<(usize, u32)> {
    // The same face, and as heavy and as slanted as the line (one file of a variable font is
    // only its regular weight: a bold line must not get thin letters from it).
    let same = |l: &Look| l.bold == look.bold && l.italic == look.italic && if !look.ps.is_empty() && !l.ps.is_empty() { l.ps == look.ps } else { !look.family.is_empty() && l.family.eq_ignore_ascii_case(&look.family) };
    let which = t.local.iter().position(|l| same(&l.look))?;
    let fi = match t.local[which].used {
        Some(fi) => fi,
        None => {
            let fi = embed_local(t, which)?;
            t.local[which].used = Some(fi);
            fi
        }
    };
    let f = &mut t.fonts.list[fi];
    if let Some(code) = f.from_uni.get(&ch) {
        return Some((fi, *code));
    }
    let (code, w) = glyph_in_program(f, ch)?;
    f.to_uni.insert(code, ch.to_string());
    f.from_uni.insert(ch, code);
    f.widths.insert(code, w);
    f.added.push((code, ch, w));
    Some((fi, code))
}

/// The programs of this computer's fonts that were put into the file are cut down to the
/// glyphs in use.
fn finish_local(t: &mut PageText) {
    for (fi, file) in t.local_files.clone() {
        let f = &t.fonts.list[fi];
        let keep: HashSet<u32> = f.to_uni.keys().copied().collect();
        let Some(small) = f.grow.as_ref().and_then(|g| subset_truetype(&g.program, &keep)) else { continue };
        if skrifa::FontRef::new(&small).is_err() {
            continue;
        }
        if let Ok(Object::Stream(s)) = t.doc.get_object_mut(file) {
            s.dict.set("Length1", small.len() as i64);
            s.dict.remove(b"Filter");
            s.set_content(small);
            let _ = s.compress();
        }
    }
}

struct PageText {
    local: Vec<LocalFont>,
    local_files: Vec<(usize, ObjectId)>,
    doc: Document,
    page: ObjectId,
    raw: Vec<u8>,
    // For each operation, where its bytes are in `raw` while it is as the file had it: written
    // back as they were (the very digits), so nothing that was not edited changes at all.
    src: Vec<Option<(usize, usize)>>,
    ops: Vec<Operation>,
    p: Mx,
    fonts: Fonts,
    // Every font of the file that says what its codes read as: the characters it can write.
    // Filled when a character is first missing.
    all_fonts: Option<Vec<(ObjectId, HashSet<char>)>>,
    looked: HashMap<ObjectId, Option<usize>>,
}

/// The file last opened, parsed once (owner, Nov 16 2026: with Edit text on, each page of a 60-page
/// report took long to show: every call unlocked, saved and parsed the whole file three times).
/// Kept for the same bytes (a hash of them), dropped when another file or version comes.
struct Parsed {
    key: (u64, usize),
    doc: Document,
    transforms: Vec<Mx>,
}
thread_local! {
    static PARSED: std::cell::RefCell<Option<Parsed>> = const { std::cell::RefCell::new(None) };
}
fn key_of(bytes: &[u8]) -> (u64, usize) {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut h);
    (h.finish(), bytes.len())
}
fn parsed(bytes: &[u8]) -> Result<(Document, Vec<Mx>), String> {
    use hayro::hayro_interpret::util::TransformExt;
    let key = key_of(bytes);
    if let Some(hit) = PARSED.with(|c| c.borrow().as_ref().filter(|p| p.key == key).map(|p| (p.doc.clone(), p.transforms.clone()))) {
        return Ok(hit);
    }
    let plain = super::unlock_doc(bytes, "")?;
    let transforms: Vec<Mx> = {
        let pdf = hayro::hayro_syntax::Pdf::new(plain.clone()).map_err(|e| format!("this PDF cannot be read ({e:?})"))?;
        let pages = pdf.pages();
        pages.iter().map(|page| page.initial_transform(true).to_kurbo().as_coeffs()).collect()
    };
    let mut doc = Document::load_mem(&plain).map_err(|e| format!("this PDF cannot be edited ({e})"))?;
    super::flatten_inherited(&mut doc);
    PARSED.with(|c| *c.borrow_mut() = Some(Parsed { key, doc: doc.clone(), transforms: transforms.clone() }));
    Ok((doc, transforms))
}

fn open(bytes: &[u8], index: u32) -> Result<PageText, String> {
    let (mut doc, transforms) = parsed(bytes)?;
    let p: Mx = *transforms.get(index as usize).ok_or("there is no such page")?;
    let _ = &mut doc;
    let page = *super::page_ids(&doc).get(index as usize).ok_or("there is no such page")?;
    let raw = doc.get_page_content(page).map_err(|e| format!("the page's drawing could not be read ({e})"))?;
    let content = lopdf::content::Content::decode(&raw).map_err(|e| format!("the page's drawing could not be read ({e})"))?;
    let src = match scan_operations(&raw) {
        Some(found) if found.len() == content.operations.len() && found.iter().zip(&content.operations).all(|(f, o)| f.2 == o.operator.as_bytes()) => found.iter().map(|f| Some((f.0, f.1))).collect(),
        _ => vec![None; content.operations.len()],
    };
    Ok(PageText { local: Vec::new(), local_files: Vec::new(), doc, page, raw, src, ops: content.operations, p, fonts: Fonts::new(page), all_fonts: None, looked: HashMap::new() })
}

/// The text of a page that can be edited in place, as JSON:
/// `{"styles":[{"family","ps","generic","bold","italic","size","rise","color","font"}], "lines":[{"block","x0","y0",
/// "x1","y1","base","size","chars":[[text, x, style], ...]}]}`. Places are in points as shown,
/// from the page's top-left. A character with style -1 is a gap that reads as a space.
#[wasm_bindgen]
pub fn text_lines(bytes: &[u8], index: u32) -> String {
    text_lines_inner(bytes, index).unwrap_or_else(|_| "{\"styles\":[],\"lines\":[]}".into())
}

fn text_lines_inner(bytes: &[u8], index: u32) -> Result<String, String> {
    let mut t = open(bytes, index)?;
    let glyphs = interpret(&t.doc, &mut t.fonts, &t.ops, &t.p);
    let lines = build_lines(&glyphs);
    let r = |v: f64| (v * 100.0).round() / 100.0;
    let mut styles: Vec<String> = Vec::new();
    let mut style_ix: HashMap<(usize, i64, [u8; 3], i64), usize> = HashMap::new();
    let mut out = Vec::new();
    for l in &lines {
        let mut chars = Vec::new();
        for it in &l.items {
            let s: i64 = match it.g {
                None => -1,
                Some(id) => {
                    let g = &glyphs[id];
                    let rise = ((l.base - g.y) * 100.0).round() as i64;
                    let key = (g.font, (g.esize * 100.0).round() as i64, g.color, rise);
                    *style_ix.entry(key).or_insert_with(|| {
                        let look = &t.fonts.list[g.font].look;
                        let generic = match look.generic {
                            "Times" => "serif",
                            "Courier" => "mono",
                            _ => "sans",
                        };
                        styles.push(format!(
                            "{{\"family\":{},\"ps\":{},\"generic\":\"{generic}\",\"bold\":{},\"italic\":{},\"size\":{},\"rise\":{},\"color\":\"#{:02x}{:02x}{:02x}\",\"font\":{}}}",
                            json_str(&look.family),
                            json_str(&look.ps),
                            look.bold,
                            look.italic,
                            r(g.esize),
                            rise as f64 / 100.0,
                            g.color[0],
                            g.color[1],
                            g.color[2],
                            json_str(&t.fonts.list[g.font].base)
                        ));
                        styles.len() - 1
                    }) as i64
                }
            };
            chars.push(format!("[{},{},{}]", json_str(&it.text), r(it.x), s));
        }
        out.push(format!(
            "{{\"block\":{},\"x0\":{},\"y0\":{},\"x1\":{},\"y1\":{},\"base\":{},\"size\":{},\"chars\":[{}]}}",
            l.block,
            r(l.items[0].x),
            r(l.base - l.size * 0.92),
            r(l.end),
            r(l.base + l.size * 0.28),
            r(l.base),
            r(l.size),
            chars.join(",")
        ));
    }
    Ok(format!("{{\"styles\":[{}],\"lines\":[{}]}}", styles.join(","), out.join(",")))
}

// ---------------------------------------------------------------- changing a line

enum Piece {
    Own(Vec<u8>, usize),              // bytes in the run's own font, how many characters
    Other(usize, Vec<u8>, usize),     // another font of the page (by its place in the list), bytes, characters
}

/// Makes the operation at `at` a TJ with an array, whatever it was (Tj, ', "). Returns where the
/// TJ is afterwards (the quote operators become several operations).
fn make_tj(ops: &mut Vec<Operation>, src: &mut Vec<Option<(usize, usize)>>, at: usize) -> usize {
    let op = ops[at].clone();
    if op.operator != "TJ" {
        src[at] = None;
        let more = match op.operator.as_str() {
            "'" => 1,
            "\"" => 3,
            _ => 0,
        };
        for _ in 0..more {
            src.insert(at, None);
        }
    }
    let string = |o: &Operation| o.operands.last().cloned().unwrap_or(Object::String(Vec::new(), StringFormat::Literal));
    match op.operator.as_str() {
        "Tj" => {
            ops[at] = Operation::new("TJ", vec![Object::Array(vec![string(&op)])]);
            at
        }
        "'" => {
            ops[at] = Operation::new("TJ", vec![Object::Array(vec![string(&op)])]);
            ops.insert(at, Operation::new("T*", vec![]));
            at + 1
        }
        "\"" => {
            ops[at] = Operation::new("TJ", vec![Object::Array(vec![string(&op)])]);
            ops.insert(at, Operation::new("T*", vec![]));
            ops.insert(at, Operation::new("Tc", vec![op.operands.get(1).cloned().unwrap_or(Object::Integer(0))]));
            ops.insert(at, Operation::new("Tw", vec![op.operands.first().cloned().unwrap_or(Object::Integer(0))]));
            at + 3
        }
        _ => at,
    }
}

fn tj_array(ops: &mut [Operation], at: usize) -> Result<&mut Vec<Object>, String> {
    match ops[at].operands.first_mut() {
        Some(Object::Array(a)) if ops[at].operator == "TJ" => Ok(a),
        _ => Err("this text could not be changed in place".into()),
    }
}

/// Puts a pen movement (a TJ number) just before byte `at` of element `el`.
fn nudge(arr: &mut Vec<Object>, el: usize, at: usize, n: f64) {
    if at > 0 {
        if let Some(Object::String(bytes, fmt)) = arr.get(el).cloned() {
            let at = at.min(bytes.len());
            arr[el] = Object::String(bytes[..at].to_vec(), fmt);
            arr.insert(el + 1, Object::Real(n as f32));
            arr.insert(el + 2, Object::String(bytes[at..].to_vec(), fmt));
        }
        return;
    }
    if el > 0 {
        if let Some(prev) = arr.get(el - 1) {
            if matches!(prev, Object::Integer(_) | Object::Real(_)) {
                arr[el - 1] = Object::Real((num(prev) + n) as f32);
                return;
            }
        }
    }
    arr.insert(el.min(arr.len()), Object::Real(n as f32));
}

/// A standard font of the same family, weight and slant on this page, for characters the run's
/// own font does not have. Made once per page and look; its widths are written into the file so
/// every reader spaces it alike.
fn stand_in(t: &mut PageText, look: &Look) -> Result<usize, String> {
    let base = standard_name(look.generic, look.bold, look.italic);
    let existing: Vec<Vec<u8>> = dict_of(&t.doc, t.doc.get_dictionary(t.page).map_err(|e| e.to_string())?.get(b"Resources").unwrap_or(&Object::Null))
        .and_then(|r| r.get(b"Font").ok())
        .and_then(|f| dict_of(&t.doc, f))
        .map(|f| f.iter().filter(|(k, v)| k.starts_with(b"GmbE") && dict_of(&t.doc, v).is_some_and(|d| name_of(d, b"BaseFont") == base)).map(|(k, _)| k.clone()).collect())
        .unwrap_or_default();
    if let Some(name) = existing.first() {
        if let Some(i) = t.fonts.get(&t.doc, name) {
            return Ok(i);
        }
    }
    let widths = standard_widths(&base, "WinAnsiEncoding");
    let list: Vec<Object> = (32u32..=255).map(|c| Object::Real(widths.get(&c).copied().unwrap_or(0.0) as f32)).collect();
    let fid = t.doc.add_object(dictionary! { "Type" => "Font", "Subtype" => "Type1", "BaseFont" => base.as_str(), "Encoding" => "WinAnsiEncoding", "FirstChar" => 32, "LastChar" => 255, "Widths" => list });
    let name = format!("GmbE{}", fid.0);
    super::add_resource(&mut t.doc, t.page, "Font", &name, Object::Reference(fid)).map_err(|_| "the page's fonts could not be changed".to_string())?;
    t.fonts.by_name.remove(name.as_bytes());
    t.fonts.get(&t.doc, name.as_bytes()).ok_or_else(|| "the stand-in font could not be read".to_string())
}

struct Counter(usize);
impl skrifa::outline::OutlinePen for Counter {
    fn move_to(&mut self, _: f32, _: f32) {
        self.0 += 1;
    }
    fn line_to(&mut self, _: f32, _: f32) {
        self.0 += 1;
    }
    fn quad_to(&mut self, _: f32, _: f32, _: f32, _: f32) {
        self.0 += 1;
    }
    fn curve_to(&mut self, _: f32, _: f32, _: f32, _: f32, _: f32, _: f32) {
        self.0 += 1;
    }
    fn close(&mut self) {}
}

/// A glyph the embedded program holds for `ch` though the file never showed it: (code, width).
fn glyph_in_program(f: &FontInfo, ch: char) -> Option<(u32, f64)> {
    use skrifa::raw::TableProvider;
    use skrifa::MetadataProvider;
    let grow = f.grow.as_ref()?;
    grow.font?;
    grow.to_unicode?; // both must be writable: the width and what it reads as
    let font = skrifa::FontRef::new(&grow.program).ok()?;
    let gid = font.charmap().map(ch)?;
    let code = gid.to_u32();
    if code == 0 || code > 0xFFFF || f.to_uni.contains_key(&code) {
        return None;
    }
    let size = skrifa::instance::Size::unscaled();
    let loc = skrifa::instance::LocationRef::default();
    if !ch.is_whitespace() {
        let mut pen = Counter(0);
        let glyph = font.outline_glyphs().get(gid)?;
        glyph.draw(skrifa::outline::DrawSettings::unhinted(size, loc), &mut pen).ok()?;
        if pen.0 == 0 {
            return None; // a subset: the outline was taken out
        }
    }
    let upem = font.head().ok()?.units_per_em() as f64;
    let adv = font.glyph_metrics(size, loc).advance_width(gid)? as f64;
    Some((code, adv * 1000.0 / upem.max(1.0)))
}

/// Writes the glyphs taken into use into the fonts: their widths and what they read as.
fn write_added(t: &mut PageText) {
    for f in &mut t.fonts.list {
        if f.added.is_empty() {
            continue;
        }
        let Some(grow) = &f.grow else { continue };
        let mut extra: Vec<Object> = Vec::new();
        for (code, _, w) in &f.added {
            extra.push(Object::Integer(*code as i64));
            extra.push(Object::Array(vec![Object::Real(*w as f32)]));
        }
        let w_ref = grow.font.and_then(|id| descendant_mut(&mut t.doc, id)).and_then(|d| {
            if !d.has(b"W") {
                d.set("W", Object::Array(Vec::new()));
            }
            d.get(b"W").ok().and_then(|o| o.as_reference().ok())
        });
        let target = match w_ref {
            Some(r) => t.doc.get_object_mut(r).ok(),
            None => grow.font.and_then(|id| descendant_mut(&mut t.doc, id)).and_then(|d| d.get_mut(b"W").ok()),
        };
        if let Some(Object::Array(a)) = target {
            a.extend(extra);
        }
        if let Some(tu) = grow.to_unicode {
            if let Some(mut data) = t.doc.get_object(tu).ok().and_then(|o| stream_bytes(&t.doc, o)) {
                let mut block = format!("{} beginbfchar\n", f.added.len().min(100));
                for (code, ch, _) in f.added.iter().take(100) {
                    let mut units = [0u16; 2];
                    let hex: String = ch.encode_utf16(&mut units).iter().map(|u| format!("{u:04X}")).collect();
                    block.push_str(&format!("<{code:04X}> <{hex}>\n"));
                }
                block.push_str("endbfchar\n");
                let at = data.windows(7).rposition(|w| w == b"endcmap").unwrap_or(data.len());
                data.splice(at..at, block.into_bytes());
                if let Ok(Object::Stream(s)) = t.doc.get_object_mut(tu) {
                    s.dict.remove(b"Filter");
                    s.dict.remove(b"DecodeParms");
                    s.set_content(data);
                    let _ = s.compress();
                }
            }
        }
        f.added.clear();
    }
}

/// A font anywhere in the file that is the same typeface as `font` (same family name, weight and
/// slant, read from the font programs) and can write `ch`: (its place in the page's list, the
/// code). It is made a font of this page if it is not one yet.
fn sibling(t: &mut PageText, font: usize, ch: char) -> Option<(usize, u32)> {
    let look = t.fonts.list[font].look.clone();
    if look.family.is_empty() && look.ps.is_empty() {
        return None;
    }
    if t.all_fonts.is_none() {
        let mut all = Vec::new();
        for (id, o) in &t.doc.objects {
            let Object::Dictionary(d) = o else { continue };
            if name_of(d, b"Type") != "Font" || !d.has(b"ToUnicode") || !matches!(name_of(d, b"Subtype").as_str(), "Type0" | "TrueType" | "Type1") {
                continue;
            }
            let Some(tu) = d.get(b"ToUnicode").ok().and_then(|x| stream_bytes(&t.doc, x)) else { continue };
            let one = |v: &String| {
                let mut it = v.chars();
                match (it.next(), it.next()) {
                    (Some(c), None) => Some(c),
                    _ => None,
                }
            };
            let chars: HashSet<char> = parse_to_unicode(&tu).values().filter_map(one).collect();
            all.push((*id, chars));
        }
        all.sort_by_key(|x| x.0);
        t.all_fonts = Some(all);
    }
    let candidates: Vec<ObjectId> = t.all_fonts.as_ref()?.iter().filter(|(_, chars)| chars.contains(&ch)).map(|(id, _)| *id).collect();
    for id in candidates {
        let known = match t.looked.get(&id) {
            Some(k) => *k,
            None => {
                // On this page already, under whatever name? Else it gets one.
                let on_page: Option<Vec<u8>> = t
                    .doc
                    .get_dictionary(t.page)
                    .ok()
                    .and_then(|pg| pg.get(b"Resources").ok())
                    .and_then(|r| dict_of(&t.doc, r))
                    .and_then(|r| r.get(b"Font").ok())
                    .and_then(|f| dict_of(&t.doc, f))
                    .and_then(|f| f.iter().find(|(_, v)| v.as_reference().ok() == Some(id)).map(|(k, _)| k.clone()));
                let same = t.doc.get_dictionary(id).ok().map(|d| look_of(&t.doc, d)).is_some_and(|o| if !o.ps.is_empty() && !look.ps.is_empty() { o.ps == look.ps } else { o.family == look.family && o.bold == look.bold && o.italic == look.italic });
                let k = if !same {
                    None
                } else {
                    let name = match on_page {
                        Some(n) => Some(n),
                        None => {
                            let n = format!("GmbS{}", id.0);
                            super::add_resource(&mut t.doc, t.page, "Font", &n, Object::Reference(id)).ok().map(|_| n.into_bytes())
                        }
                    };
                    name.and_then(|n| {
                        t.fonts.by_name.remove(&n);
                        t.fonts.get(&t.doc, &n)
                    })
                };
                t.looked.insert(id, k);
                k
            }
        };
        if let Some(fi) = known {
            if fi != font && t.fonts.list[fi].readable {
                if let Some(code) = t.fonts.list[fi].from_uni.get(&ch) {
                    return Some((fi, *code));
                }
            }
        }
    }
    None
}

/// The new text as bytes: in the run's own font where it can be, else in a stand-in.
fn encode(t: &mut PageText, glyphs: &[Glyph], font: usize, text: &str) -> Result<Vec<Piece>, String> {
    // Codes this page already shows for a character come first: they are certainly drawable.
    let mut shown: HashMap<char, u32> = HashMap::new();
    for g in glyphs.iter().filter(|g| g.font == font) {
        let mut it = g.text.chars();
        if let (Some(c), None) = (it.next(), it.next()) {
            if c != '\u{FFFD}' {
                shown.entry(c).or_insert(g.code);
            }
        }
    }
    let wide = t.fonts.list[font].wide;
    let look = t.fonts.list[font].look.clone();
    let mut pieces: Vec<Piece> = Vec::new();
    let mut other: Option<usize> = None;
    for ch in text.chars() {
        let ch = if ch == '\u{A0}' && !shown.contains_key(&ch) { ' ' } else { ch };
        let own = shown.get(&ch).copied().or_else(|| t.fonts.list[font].from_uni.get(&ch).copied()).or_else(|| {
            let f = &mut t.fonts.list[font];
            let (code, w) = glyph_in_program(f, ch)?;
            f.to_uni.insert(code, ch.to_string());
            f.from_uni.insert(ch, code);
            f.widths.insert(code, w);
            f.added.push((code, ch, w));
            Some(code)
        });
        match own {
            Some(code) => {
                let b: Vec<u8> = if wide { vec![(code >> 8) as u8, code as u8] } else { vec![code as u8] };
                match pieces.last_mut() {
                    Some(Piece::Own(bytes, n)) => {
                        bytes.extend(b);
                        *n += 1;
                    }
                    _ => pieces.push(Piece::Own(b, 1)),
                }
            }
            None => {
                // The same typeface elsewhere in the file (another page's copy of Arial Bold
                // holds other letters) comes before a standard font of the same look.
                // Then the font itself, if this computer has it and the viewer handed it over.
                let (fi, b) = match sibling(t, font, ch).or_else(|| local(t, &look, ch)) {
                    Some((fi, code)) => (fi, if t.fonts.list[fi].wide { vec![(code >> 8) as u8, code as u8] } else { vec![code as u8] }),
                    None => {
                        if other.is_none() {
                            other = Some(stand_in(t, &look)?);
                        }
                        (other.unwrap(), vec![win_ansi_code(ch).unwrap_or(b'?')])
                    }
                };
                match pieces.last_mut() {
                    Some(Piece::Other(f, bytes, n)) if *f == fi => {
                        bytes.extend(b);
                        *n += 1;
                    }
                    _ => pieces.push(Piece::Other(fi, b, 1)),
                }
            }
        }
    }
    Ok(pieces)
}

/// Something flat drawn beside the text that belongs to it: an underline or a strike-through
/// line (a thin filled rectangle or a stroked straight line), or a gap cut out of an underline
/// where a letter reaches below the line (browsers write those as holes in a clipping path).
struct Rule {
    ops: Vec<usize>, // the `re`; or the operations holding its points (`m`, `l`)
    xs: Vec<f64>,    // where each of those points is, as shown (for `re`: its two sides)
    x0: f64,         // as shown
    x1: f64,
    y: f64,
    thick: f64,
    sx: f64, // how wide one unit of its own space is, as shown
    hole: bool,
}

/// The flat rules and clip holes of a page, in the order they are drawn.
fn rules(ops: &[Operation], p: &Mx) -> Vec<Rule> {
    let mut out = Vec::new();
    let mut ctm = ID;
    let mut stack: Vec<Mx> = Vec::new();
    let mut rects: Vec<usize> = Vec::new(); // `re` of the current path
    let mut subs: Vec<Vec<usize>> = Vec::new(); // its other pieces: an `m` and the `l` after it
    let mut curved = false;
    let mut clips = false;
    for (i, op) in ops.iter().enumerate() {
        let o = &op.operands;
        let n = |k: usize| o.get(k).map(num).unwrap_or(0.0);
        match op.operator.as_str() {
            "q" => stack.push(ctm),
            "Q" => ctm = stack.pop().unwrap_or(ID),
            "cm" if o.len() == 6 => ctm = mul(&[n(0), n(1), n(2), n(3), n(4), n(5)], &ctm),
            "re" => rects.push(i),
            "m" => subs.push(vec![i]),
            "l" => match subs.last_mut() {
                Some(sub) => sub.push(i),
                None => curved = true,
            },
            "h" => {}
            "c" | "v" | "y" => curved = true,
            "W" | "W*" => clips = true,
            "f" | "F" | "f*" | "S" | "B" | "B*" | "b" | "b*" | "s" | "n" => {
                let full = mul(&ctm, p);
                let flat = full[1].abs() < 1e-6 && full[2].abs() < 1e-6 && full[0] > 1e-9;
                let point = |at: usize| apply(&full, num(&ops[at].operands[0]), num(&ops[at].operands[1]));
                let two = |at: usize| ops[at].operands.len() == 2;
                if flat && !curved {
                    match op.operator.as_str() {
                        "f" | "F" | "f*" | "B" | "B*" if !clips => {
                            for at in &rects {
                                let r = &ops[*at].operands;
                                if r.len() != 4 || num(&r[2]) <= 0.0 {
                                    continue;
                                }
                                let (ax, ay) = apply(&full, num(&r[0]), num(&r[1]));
                                let (bx, by) = apply(&full, num(&r[0]) + num(&r[2]), num(&r[1]) + num(&r[3]));
                                out.push(Rule { ops: vec![*at], xs: vec![ax, bx], x0: ax.min(bx), x1: ax.max(bx), y: (ay + by) / 2.0, thick: (ay - by).abs(), sx: full[0], hole: false });
                            }
                        }
                        "S" if !clips && rects.is_empty() && subs.len() == 1 && subs[0].len() == 2 && subs[0].iter().all(|at| two(*at)) => {
                            let ((ax, ay), (bx, by)) = (point(subs[0][0]), point(subs[0][1]));
                            if (ay - by).abs() < 0.01 && bx > ax {
                                out.push(Rule { ops: subs[0].clone(), xs: vec![ax, bx], x0: ax, x1: bx, y: ay, thick: 0.0, sx: full[0], hole: false });
                            }
                        }
                        "n" if clips => {
                            // Boxes in a clipping path: the page-sized one is the clip itself, the
                            // small ones are where an underline is interrupted.
                            for sub in subs.iter().filter(|sub| (4..=5).contains(&sub.len()) && sub.iter().all(|at| two(*at))) {
                                let pts: Vec<(f64, f64)> = sub.iter().map(|at| point(*at)).collect();
                                let (x0, x1) = (pts.iter().map(|q| q.0).fold(f64::MAX, f64::min), pts.iter().map(|q| q.0).fold(f64::MIN, f64::max));
                                let (y0, y1) = (pts.iter().map(|q| q.1).fold(f64::MAX, f64::min), pts.iter().map(|q| q.1).fold(f64::MIN, f64::max));
                                let boxed = pts.iter().all(|q| ((q.0 - x0).abs() < 0.01 || (q.0 - x1).abs() < 0.01) && ((q.1 - y0).abs() < 0.01 || (q.1 - y1).abs() < 0.01));
                                if boxed {
                                    out.push(Rule { ops: sub.clone(), xs: pts.iter().map(|q| q.0).collect(), x0, x1, y: (y0 + y1) / 2.0, thick: y1 - y0, sx: full[0], hole: true });
                                }
                            }
                        }
                        _ => {}
                    }
                }
                rects.clear();
                subs.clear();
                curved = false;
                clips = false;
            }
            _ => {}
        }
    }
    out
}

/// Replaces items `a..b` of line `line` by `text`. Text typed between two letters takes the
/// look of the letter before it, or of the letter after it when `after_first` says so (the
/// caret stood at the start of a bold word and the editor showed the typing bold).
fn replace(t: &mut PageText, line: usize, a: usize, b: usize, after_first: bool, text: &str) -> Result<(), String> {
    let stale = || "the text on this page changed: try again".to_string();
    let g0 = interpret(&t.doc, &mut t.fonts, &t.ops, &t.p);
    let lines = build_lines(&g0);
    let l = lines.get(line).ok_or_else(stale)?;
    let n = l.items.len();
    let (a, b) = (a.min(n), b.min(n));
    if a > b {
        return Err(stale());
    }
    if a == b && text.is_empty() {
        return Ok(());
    }
    let pos = |k: usize| if k < n { l.items[k].x } else { l.end };
    let removed: HashSet<usize> = l.items[a..b].iter().filter_map(|i| i.g).collect();
    let shifted: HashSet<usize> = l.items[b..].iter().filter_map(|i| i.g).collect();
    // Whose look the new text takes: of what it replaces; typed between letters, of the letter
    // before it; at the start of a line, of the first letter.
    let first_removed = l.items[a..b].iter().find_map(|i| i.g);
    let before = l.items[..a].iter().rev().find_map(|i| i.g);
    let after = l.items[b..].iter().find_map(|i| i.g);
    let (anchor, put_before) = match (first_removed, before, after) {
        (Some(g), _, _) => (g, true),
        (None, _, Some(g)) if after_first => (g, true),
        (None, Some(g), _) => (g, false),
        (None, None, Some(g)) => (g, true),
        _ => return Err(stale()),
    };
    let anchor_g = g0[anchor].clone();
    // The underlines and strike-through lines of this line, as they are now: they are drawn
    // apart from the text and must follow it.
    let (line_x0, line_end, line_base, line_size) = (l.items[0].x, l.end, l.base, l.size);
    let rules_before = rules(&t.ops, &t.p);
    let pieces = if text.is_empty() { Vec::new() } else { encode(t, &g0, anchor_g.font, text)? };
    let inserted: usize = pieces.iter().map(|p| match p { Piece::Own(_, n) | Piece::Other(_, _, n) => *n }).sum();

    // Every operation touched becomes a TJ with an array (from the last one back, so the places
    // of the earlier ones stay), then the page is read again for the places after that.
    let mut touched: Vec<usize> = removed.iter().map(|g| g0[*g].op).chain(std::iter::once(anchor_g.op)).collect();
    touched.sort_unstable();
    touched.dedup();
    for at in touched.iter().rev() {
        make_tj(&mut t.ops, &mut t.src, *at);
    }
    let g1 = interpret(&t.doc, &mut t.fonts, &t.ops, &t.p);
    if g1.len() != g0.len() {
        return Err(stale());
    }
    // Take the replaced characters out, last first.
    let mut cuts: Vec<(usize, usize, usize, usize)> = removed.iter().map(|g| (g1[*g].op, g1[*g].el, g1[*g].at, g1[*g].len)).collect();
    cuts.sort_unstable();
    // A kerning number belongs to the two characters around it: it goes when one of them goes.
    let mut edge: HashSet<(usize, usize, bool)> = HashSet::new(); // (operation, element, its first / its last character went)
    for (op, el, at, len) in &cuts {
        if let Some(Object::String(bytes, _)) = tj_array(&mut t.ops, *op)?.get(*el) {
            if *at == 0 {
                edge.insert((*op, *el, true));
            }
            if at + len == bytes.len() {
                edge.insert((*op, *el, false));
            }
        }
    }
    let cut_ops: HashSet<usize> = cuts.iter().map(|c| c.0).collect();
    for op in cut_ops {
        t.src[op] = None;
        let arr = tj_array(&mut t.ops, op)?;
        let strings: Vec<usize> = (0..arr.len()).filter(|i| matches!(&arr[*i], Object::String(b, _) if !b.is_empty())).collect();
        for i in 0..arr.len() {
            if !matches!(arr[i], Object::Integer(_) | Object::Real(_)) {
                continue;
            }
            let prev = strings.iter().rev().find(|s| **s < i);
            let next = strings.iter().find(|s| **s > i);
            if prev.is_some_and(|s| edge.contains(&(op, *s, false))) || next.is_some_and(|s| edge.contains(&(op, *s, true))) {
                arr[i] = Object::Integer(0);
            }
        }
    }
    for (op, el, at, len) in cuts.iter().rev() {
        if let Some(Object::String(bytes, _)) = tj_array(&mut t.ops, *op)?.get_mut(*el) {
            if at + len <= bytes.len() {
                bytes.drain(*at..*at + *len);
            }
        }
    }
    // Put the new ones in.
    if inserted > 0 {
        let ag = &g1[anchor];
        let mut at = if put_before { ag.at } else { ag.at + ag.len };
        at -= cuts.iter().filter(|c| c.0 == ag.op && c.1 == ag.el && c.2 < at).map(|c| c.3).sum::<usize>();
        let all_own = pieces.iter().all(|p| matches!(p, Piece::Own(..)));
        t.src[ag.op] = None;
        let arr = tj_array(&mut t.ops, ag.op)?;
        let Some(Object::String(bytes, fmt)) = arr.get(ag.el).cloned() else { return Err(stale()) };
        let at = at.min(bytes.len());
        if all_own {
            let mut nb = bytes[..at].to_vec();
            for p in &pieces {
                if let Piece::Own(b, _) = p {
                    nb.extend_from_slice(b);
                }
            }
            nb.extend_from_slice(&bytes[at..]);
            arr[ag.el] = Object::String(nb, fmt);
        } else {
            let mut head: Vec<Object> = arr[..ag.el].to_vec();
            head.push(Object::String(bytes[..at].to_vec(), fmt));
            let mut tail: Vec<Object> = vec![Object::String(bytes[at..].to_vec(), fmt)];
            tail.extend_from_slice(&arr[ag.el + 1..]);
            let own_name = t.fonts.names[ag.font].clone();
            let size = Object::Real(ag.size as f32);
            let mut new_ops = vec![Operation::new("TJ", vec![Object::Array(head)])];
            for p in &pieces {
                match p {
                    Piece::Own(b, _) => new_ops.push(Operation::new("TJ", vec![Object::Array(vec![Object::String(b.clone(), fmt)])])),
                    Piece::Other(fi, b, _) => {
                        let form = if t.fonts.list[*fi].wide { StringFormat::Hexadecimal } else { StringFormat::Literal };
                        new_ops.push(Operation::new("Tf", vec![Object::Name(t.fonts.names[*fi].clone()), size.clone()]));
                        new_ops.push(Operation::new("TJ", vec![Object::Array(vec![Object::String(b.clone(), form)])]));
                        new_ops.push(Operation::new("Tf", vec![Object::Name(own_name.clone()), size.clone()]));
                    }
                }
            }
            new_ops.push(Operation::new("TJ", vec![Object::Array(tail)]));
            let op = ag.op;
            t.src.splice(op..op + 1, std::iter::repeat_n(None, new_ops.len()));
            t.ops.splice(op..op + 1, new_ops);
        }
    }
    // Which character of the page as it is now is which one of before.
    #[derive(Clone, Copy, PartialEq)]
    enum Was {
        Old(usize),
        New(usize),
    }
    let put_at = if put_before { anchor } else { anchor + 1 };
    let mut was: Vec<Was> = Vec::with_capacity(g0.len() + inserted);
    for i in 0..=g0.len() {
        if i == put_at {
            was.extend((0..inserted).map(Was::New));
        }
        if i < g0.len() && !removed.contains(&i) {
            was.push(Was::Old(i));
        }
    }
    // Everything goes where it belongs: the new text starts where the replaced text started,
    // what follows on the line moves by the change in width, the rest of the page stays.
    let mut fixed: HashSet<usize> = HashSet::new();
    let mut settled = false;
    for _ in 0..600 {
        let now = interpret(&t.doc, &mut t.fonts, &t.ops, &t.p);
        if now.len() != was.len() {
            return Err("this text could not be changed in place".into());
        }
        let first_new = was.iter().position(|w| *w == Was::New(0));
        let width = match first_new {
            Some(i) => {
                let last = &now[i + inserted - 1];
                (last.x + last.adv - now[i].x) * now[i].dx + (last.y - now[i].y) * now[i].dy
            }
            None => 0.0,
        };
        let delta = width - (pos(b) - pos(a));
        let mut hit: Option<(usize, f64)> = None;
        for (i, g) in now.iter().enumerate() {
            if fixed.contains(&i) {
                continue;
            }
            let want = match was[i] {
                Was::New(0) => Some((pos(a), g.y)),
                Was::New(_) => None,
                Was::Old(o) => Some(if shifted.contains(&o) { (g0[o].x + delta * g0[o].dx, g0[o].y + delta * g0[o].dy) } else { (g0[o].x, g0[o].y) }),
            };
            let Some((wx, wy)) = want else { continue };
            let d = (wx - g.x) * g.dx + (wy - g.y) * g.dy;
            if d.abs() > 0.004 && g.k.abs() > 1e-9 {
                hit = Some((i, d));
                break;
            }
        }
        let Some((i, d)) = hit else {
            settled = true;
            break;
        };
        fixed.insert(i);
        let g = now[i].clone();
        let op = make_tj(&mut t.ops, &mut t.src, g.op);
        t.src[op] = None;
        nudge(tj_array(&mut t.ops, op)?, g.el, g.at, -d / g.k);
    }
    if !settled {
        return Err("this text could not be changed in place".into());
    }
    // Underlines and strike-through lines follow: what lies after the change moves with the
    // text, what lies across it grows or shrinks with it, what lies before it stays.
    {
        let now = interpret(&t.doc, &mut t.fonts, &t.ops, &t.p);
        let width = match was.iter().position(|w| *w == Was::New(0)) {
            Some(i) => now[i + inserted - 1].x + now[i + inserted - 1].adv - now[i].x,
            None => 0.0,
        };
        let delta = width - (pos(b) - pos(a));
        let rules_now = rules(&t.ops, &t.p);
        let eps = 0.12 * line_size;
        // Typed between two letters, the text joined the one before it: a line ending there
        // grows. Otherwise it took the look of what stood at the start of the range.
        let joins_before = a == b && !put_before;
        let limit = pos(a) + if joins_before { -eps } else { eps };
        let moved = |x: f64| if x > limit { x.max(pos(b)) + delta } else { x };
        if delta.abs() > 0.004 && rules_now.len() == rules_before.len() {
            for (r0, r1) in rules_before.iter().zip(&rules_now) {
                let across = r0.x0 > line_x0 - 0.3 * line_size && r0.x1 < line_end + 0.3 * line_size;
                let on_line = if r0.hole {
                    across && r0.thick < 0.7 * line_size && r0.y > line_base - 0.3 * line_size && r0.y < line_base + 0.5 * line_size
                } else {
                    across && r0.thick < 0.2 * line_size && r0.y > line_base - 0.85 * line_size && r0.y < line_base + 0.35 * line_size && r0.x1 - r0.x0 > 0.2 * line_size
                };
                if !on_line || r0.ops.len() != r1.ops.len() {
                    continue;
                }
                if r1.ops.len() == 1 {
                    // A rectangle: its left side and its width.
                    let (n0, n1) = (moved(r0.x0), moved(r0.x1).max(moved(r0.x0)));
                    if (n0 - r0.x0).abs() < 1e-6 && (n1 - r0.x1).abs() < 1e-6 {
                        continue;
                    }
                    let (d0, d1) = ((n0 - r0.x0) / r0.sx, (n1 - r0.x1) / r0.sx);
                    t.src[r1.ops[0]] = None;
                    let o = &mut t.ops[r1.ops[0]].operands;
                    o[0] = Object::Real((num(&o[0]) + d0) as f32);
                    o[2] = Object::Real((num(&o[2]) + d1 - d0) as f32);
                } else {
                    // Points: each goes where the text under it went.
                    for (at, x) in r1.ops.iter().zip(&r0.xs) {
                        let d = (moved(*x) - x) / r0.sx;
                        if d.abs() > 1e-9 {
                            t.src[*at] = None;
                            let o = &mut t.ops[*at].operands;
                            o[0] = Object::Real((num(&o[0]) + d) as f32);
                        }
                    }
                }
            }
        }
    }
    // Leftovers of what was taken out: empty strings, movements of nothing, movements in a row.
    for (at, op) in t.ops.iter_mut().enumerate().filter(|(_, o)| o.operator == "TJ") {
        if t.src[at].is_some() {
            continue; // as the file had it
        }
        let Some(Object::Array(arr)) = op.operands.first_mut() else { continue };
        let is_zero = |o: &Object| matches!(o, Object::Integer(0)) || matches!(o, Object::Real(v) if *v == 0.0);
        if !arr.iter().any(|o| is_zero(o) || matches!(o, Object::String(b, _) if b.is_empty())) {
            continue;
        }
        let mut tidy: Vec<Object> = Vec::with_capacity(arr.len());
        for o in arr.drain(..) {
            match &o {
                Object::String(b, _) if b.is_empty() => {}
                x if is_zero(x) => {}
                Object::Integer(_) | Object::Real(_) => match tidy.last_mut() {
                    Some(last) if matches!(last, Object::Integer(_) | Object::Real(_)) => *last = Object::Real((num(last) + num(&o)) as f32),
                    _ => tidy.push(o),
                },
                _ => tidy.push(o),
            }
        }
        *arr = tidy;
    }
    Ok(())
}

/// The page's drawing as bytes: operations that were not touched as the file had them, the
/// others written anew.
fn written(t: &PageText) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(t.raw.len() + 256);
    for (op, src) in t.ops.iter().zip(&t.src) {
        match src {
            Some((a, b)) => out.extend_from_slice(&t.raw[*a..*b]),
            None => out.extend(lopdf::content::Content { operations: vec![op.clone()] }.encode().map_err(|e| e.to_string())?),
        }
        out.push(b'\n');
    }
    Ok(out)
}

/// Splits what the viewer handed over into fonts: `sizes` holds the length of each file in `data`.
fn local_fonts(data: &[u8], sizes: &[u32]) -> Vec<LocalFont> {
    let mut out = Vec::new();
    let mut at = 0usize;
    for len in sizes {
        let Some(d) = data.get(at..at + *len as usize) else { break };
        at += *len as usize;
        if let Some(look) = look_of_program(d) {
            out.push(LocalFont { data: d.to_vec(), look, used: None });
        }
    }
    out
}

/// The letters of these changes that no font of the file can write, by the font they would be
/// written in: `[{"ps","family","bold","italic","chars"}]`. The viewer may then hand over that
/// font from this computer.
fn missing_inner(bytes: &[u8], index: u32, spans: &[u32], texts: &str) -> Result<String, String> {
    let mut t = open(bytes, index)?;
    let texts: Vec<&str> = texts.split('\n').collect();
    let g0 = interpret(&t.doc, &mut t.fonts, &t.ops, &t.p);
    let lines = build_lines(&g0);
    let mut found: Vec<(Look, String)> = Vec::new();
    for (s, text) in spans.chunks(4).zip(texts) {
        if s.len() < 4 {
            break;
        }
        let Some(l) = lines.get(s[0] as usize) else { continue };
        let n = l.items.len();
        let (a, b) = ((s[1] as usize).min(n), (s[2] as usize).min(n));
        if a > b {
            continue;
        }
        let first_removed = l.items[a..b].iter().find_map(|i| i.g);
        let before = l.items[..a].iter().rev().find_map(|i| i.g);
        let after = l.items[b..].iter().find_map(|i| i.g);
        let Some(anchor) = first_removed.or(if s[3] == 1 { after.or(before) } else { before.or(after) }) else { continue };
        let font = g0[anchor].font;
        let look = t.fonts.list[font].look.clone();
        for ch in text.chars() {
            let ch = if ch == '\u{A0}' { ' ' } else { ch };
            let shown = g0.iter().any(|g| g.font == font && g.text.chars().eq(std::iter::once(ch)));
            if shown || t.fonts.list[font].from_uni.contains_key(&ch) || glyph_in_program(&t.fonts.list[font], ch).is_some() || sibling(&mut t, font, ch).is_some() {
                continue;
            }
            match found.iter_mut().find(|(l, _)| *l == look) {
                Some((_, chars)) => {
                    if !chars.contains(ch) {
                        chars.push(ch);
                    }
                }
                None => found.push((look.clone(), ch.to_string())),
            }
        }
    }
    let items: Vec<String> = found.iter().map(|(l, c)| format!("{{\"ps\":{},\"family\":{},\"bold\":{},\"italic\":{},\"chars\":{}}}", json_str(&l.ps), json_str(&l.family), l.bold, l.italic, json_str(c))).collect();
    Ok(format!("[{}]", items.join(",")))
}

/// See `missing_inner`. "[]" when nothing is missing or the page cannot be read.
#[wasm_bindgen]
pub fn missing_glyphs(bytes: &[u8], index: u32, spans: Vec<u32>, texts: &str) -> String {
    missing_inner(bytes, index, &spans, texts).unwrap_or_else(|_| "[]".into())
}

/// `edit_text` with fonts of this computer for the letters `missing_glyphs` named: `fonts` holds
/// the font files one after the other, `sizes` the length of each. A letter is then written in
/// the very typeface of its line, and only the glyphs used go into the file.
#[wasm_bindgen]
pub fn edit_text_fonts(bytes: &[u8], index: u32, spans: Vec<u32>, texts: &str, fonts: &[u8], sizes: Vec<u32>) -> Result<Vec<u8>, JsError> {
    edit_text_inner(bytes, index, &spans, texts, local_fonts(fonts, &sizes)).map_err(|e| JsError::new(&e))
}

fn edit_text_inner(bytes: &[u8], index: u32, spans: &[u32], texts: &str, local: Vec<LocalFont>) -> Result<Vec<u8>, String> {
    let mut t = open(bytes, index)?;
    t.local = local;
    let texts: Vec<&str> = texts.split('\n').collect();
    if spans.is_empty() || spans.len() % 4 != 0 || spans.len() / 4 != texts.len() {
        return Err("nothing to change".into());
    }
    // From the last line and the end of each line backwards: a change never moves the place of
    // one still to be made.
    let mut edits: Vec<(usize, usize, usize, bool, &str)> = spans.chunks(4).zip(texts).map(|(s, x)| (s[0] as usize, s[1] as usize, s[2] as usize, s[3] == 1, x)).collect();
    edits.sort_by(|x, y| (y.0, y.1).cmp(&(x.0, x.1)));
    for (line, a, b, after_first, text) in edits {
        replace(&mut t, line, a, b, after_first, text)?;
    }
    write_added(&mut t);
    finish_local(&mut t);
    let mut stream = Stream::new(dictionary! {}, written(&t)?);
    let _ = stream.compress();
    let id = t.doc.add_object(stream);
    t.doc.get_dictionary_mut(t.page).map_err(|e| e.to_string())?.set("Contents", id);
    t.doc.prune_objects();
    let mut out = Vec::new();
    t.doc.save_to(&mut out).map_err(|e| format!("could not write the PDF ({e})"))?;
    Ok(out)
}

/// Changes text in place. `spans` holds (line, from, to, side) for each change, counted in the
/// lines and characters `text_lines` gave for this very file; `texts` holds the new text of each
/// change, one per line of the string. Characters outside the ranges keep their bytes. `side`:
/// 0, text typed between two letters looks like the one before it; 1, like the one after it.
#[wasm_bindgen]
pub fn edit_text(bytes: &[u8], index: u32, spans: Vec<u32>, texts: &str) -> Result<Vec<u8>, JsError> {
    edit_text_inner(bytes, index, &spans, texts, Vec::new()).map_err(|e| JsError::new(&e))
}

/// The font resource and look of each character of a line, for checks: "F1:Arial:bold:12.00" per
/// character, joined by "|".
#[wasm_bindgen]
pub fn line_fonts(bytes: &[u8], index: u32, line: u32) -> String {
    let Ok(mut t) = open(bytes, index) else { return String::new() };
    let glyphs = interpret(&t.doc, &mut t.fonts, &t.ops, &t.p);
    let lines = build_lines(&glyphs);
    let Some(l) = lines.get(line as usize) else { return String::new() };
    l.items
        .iter()
        .filter_map(|i| i.g)
        .map(|g| {
            let g = &glyphs[g];
            let f = &t.fonts.list[g.font];
            format!("{}:{}:{}{}:{:.2}", String::from_utf8_lossy(&t.fonts.names[g.font]), f.base, if f.look.bold { "bold" } else { "regular" }, if f.look.italic { "-italic" } else { "" }, g.esize)
        })
        .collect::<Vec<_>>()
        .join("|")
}

#[cfg(test)]
pub(crate) mod testkit {
    use super::*;

    /// What a page reads as, line by line.
    pub fn lines_of(bytes: &[u8], index: u32) -> Vec<String> {
        let mut t = open(bytes, index).unwrap();
        let glyphs = interpret(&t.doc, &mut t.fonts, &t.ops, &t.p);
        build_lines(&glyphs).iter().map(|l| l.items.iter().map(|i| i.text.as_str()).collect()).collect()
    }

    /// Every character this module reads: (code, x, y, font resource name).
    pub fn glyphs_of(bytes: &[u8], index: u32) -> Vec<(u32, f64, f64, String, String)> {
        let mut t = open(bytes, index).unwrap();
        let glyphs = interpret(&t.doc, &mut t.fonts, &t.ops, &t.p);
        glyphs.iter().map(|g| (g.code, g.x, g.y, String::from_utf8_lossy(&t.fonts.names[g.font]).into_owned(), g.text.clone())).collect()
    }

    /// `spans`: (line, from, to) for each change.
    pub fn edit(bytes: &[u8], index: u32, spans: &[u32], texts: &str) -> Result<Vec<u8>, String> {
        let four: Vec<u32> = spans.chunks(3).flat_map(|s| [s[0], s[1], s[2], 0]).collect();
        edit_text_inner(bytes, index, &four, texts, Vec::new())
    }

    /// As `edit`, with font files of this computer at hand.
    pub fn edit_with_fonts(bytes: &[u8], index: u32, spans: &[u32], texts: &str, fonts: &[Vec<u8>]) -> Result<Vec<u8>, String> {
        let four: Vec<u32> = spans.chunks(3).flat_map(|s| [s[0], s[1], s[2], 0]).collect();
        let sizes: Vec<u32> = fonts.iter().map(|f| f.len() as u32).collect();
        edit_text_inner(bytes, index, &four, texts, local_fonts(&fonts.concat(), &sizes))
    }

    pub fn missing(bytes: &[u8], index: u32, spans: &[u32], texts: &str) -> String {
        let four: Vec<u32> = spans.chunks(3).flat_map(|s| [s[0], s[1], s[2], 0]).collect();
        missing_inner(bytes, index, &four, texts).unwrap()
    }

    /// `spans`: (line, from, to, side) for each change, as the viewer sends them.
    pub fn edit_sided(bytes: &[u8], index: u32, spans: &[u32], texts: &str) -> Result<Vec<u8>, String> {
        edit_text_inner(bytes, index, spans, texts, Vec::new())
    }

    pub fn widths_of(base: &str, encoding: &str) -> HashMap<u32, f64> {
        standard_widths(base, encoding)
    }

    pub fn content(bytes: &[u8], index: u32) -> String {
        let t = open(bytes, index).unwrap();
        String::from_utf8_lossy(&written(&t).unwrap()).into_owned()
    }
}

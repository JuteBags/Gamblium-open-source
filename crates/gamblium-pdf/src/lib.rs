//! Gamblium's own PDF engine (proof of concept, owner Nov 15 2026): everything people go to
//! iLovePDF / Smallpdf / Acrobat for, done inside the browser, on the user's machine, in Rust
//! compiled to WebAssembly. Nothing is uploaded anywhere.
//!
//! - Viewing: `Viewer` renders pages with hayro (pure Rust).
//! - Organising: delete, reorder, rotate pages; merge files.
//! - Marking: watermark, text, highlight / box, freehand ink, a signature image.
//! - Making: a PDF from JPEG images.
//!
//! Editing functions take the PDF's bytes and return new bytes, so the page can keep an undo
//! history of whole files. Coordinates are PDF points from the page's lower-left corner, on the
//! page as stored (before /Rotate): the viewer converts what was clicked on screen.

use lopdf::{dictionary, Document, Object, ObjectId, Stream};
use wasm_bindgen::prelude::*;

mod textedit;
pub use textedit::{edit_text, edit_text_fonts, line_fonts, missing_glyphs, text_lines};
#[cfg(test)]
mod textedit_tests;

// ---------------------------------------------------------------- viewing

#[wasm_bindgen]
pub struct Viewer {
    pdf: hayro::hayro_syntax::Pdf,
}

#[wasm_bindgen]
impl Viewer {
    #[wasm_bindgen(constructor)]
    pub fn new(bytes: Vec<u8>) -> Result<Viewer, JsError> {
        let pdf = hayro::hayro_syntax::Pdf::new(bytes).map_err(|e| JsError::new(&format!("this file is not a PDF Gamblium can read ({e:?})")))?;
        Ok(Viewer { pdf })
    }

    pub fn page_count(&self) -> u32 {
        self.pdf.pages().len() as u32
    }

    /// [width, height] in points as shown (rotation applied).
    pub fn page_size(&self, index: u32) -> Vec<f32> {
        match self.pdf.pages().get(index as usize) {
            Some(p) => {
                let (w, h) = p.render_dimensions();
                vec![w, h]
            }
            None => vec![0.0, 0.0],
        }
    }

    /// RGBA pixels of one page at `scale` (1.0 = 1 pixel per point). The first 8 bytes are the
    /// width and height (u32, little-endian), then the pixels.
    pub fn render(&self, index: u32, scale: f32) -> Vec<u8> {
        let pages = self.pdf.pages();
        let Some(page) = pages.get(index as usize) else { return vec![0; 8] };
        let cache = hayro::RenderCache::new();
        let settings = hayro::hayro_interpret::InterpreterSettings::default();
        let pix = hayro::render(
            page,
            &cache,
            &settings,
            &hayro::RenderSettings::default(),
            &hayro::PixmapSettings { x_scale: scale, y_scale: scale, bg_color: hayro::vello_cpu::color::palette::css::WHITE },
        );
        let (w, h) = (pix.width() as u32, pix.height() as u32);
        // A white background: every pixel is opaque, so premultiplied and straight are the same.
        let mut out = Vec::with_capacity(8 + (w * h * 4) as usize);
        out.extend_from_slice(&w.to_le_bytes());
        out.extend_from_slice(&h.to_le_bytes());
        out.extend_from_slice(pix.data_as_u8_slice());
        out
    }
}

// ---------------------------------------------------------------- text: where every word is

use hayro::hayro_interpret::font::GlyphRun;
use hayro::hayro_interpret::{BlendMode, ClipPath, Context, Device, DrawMode, DrawProps, Image, ImageDrawProps, SoftMask};
use hayro::kurbo::{Affine, BezPath, Point};

/// One drawn character: its text, where its baseline starts, which way it runs, its size.
struct Ch {
    text: String,
    origin: Point,
    dir: (f64, f64),
    size: f64,
}

/// A device that draws nothing and writes down every character (hayro calls it as it reads the page).
struct TextDevice {
    chars: Vec<Ch>,
}

impl<'a> Device<'a> for TextDevice {
    fn draw_path(&mut self, _: &BezPath, _: DrawProps<'a>, _: &DrawMode) {}
    fn push_clip_path(&mut self, _: &ClipPath) {}
    fn push_transparency_group(&mut self, _: f32, _: Option<SoftMask<'a>>, _: BlendMode) {}
    fn draw_glyph_run(&mut self, run: &GlyphRun<'_, 'a>, props: DrawProps<'a>, _: &DrawMode) {
        for g in run.glyphs() {
            let t: Affine = props.transform * g.transform();
            let o = t * Point::new(0.0, 0.0);
            let right = t * Point::new(1000.0, 0.0) - o; // glyph space is in 1/1000 em
            let up = t * Point::new(0.0, 1000.0) - o;
            let size = up.hypot();
            let len = right.hypot().max(1e-9);
            let text = match g.as_unicode() {
                Some(hayro::hayro_interpret::hayro_cmap::BfString::Char(c)) => c.to_string(),
                Some(hayro::hayro_interpret::hayro_cmap::BfString::String(s)) => s,
                None => continue,
            };
            self.chars.push(Ch { text, origin: o, dir: (right.x / len, right.y / len), size });
        }
    }
    fn draw_image(&mut self, _: Image<'a, '_>, _: ImageDrawProps<'a>) {}
    fn pop_clip(&mut self) {}
    fn pop_transparency_group(&mut self) {}
}

/// Words of a page as shown (rotation applied, points from the top-left): text, x0, y0, x1, y1,
/// the font size, and the baseline. Characters are joined while they sit on one line close
/// together; a space or a gap ends a word.
fn page_words(page: &hayro::hayro_syntax::page::Page<'_>) -> Vec<(String, f64, f64, f64, f64, f64, f64)> {
    use hayro::hayro_interpret::util::TransformExt;
    let (w, h) = page.render_dimensions();
    let cache = hayro::hayro_interpret::InterpreterCache::new();
    let transform = page.initial_transform(true).to_kurbo();
    let mut ctx = Context::new(transform, hayro::kurbo::Rect::new(0.0, 0.0, w as f64, h as f64), &cache, page.xref(), hayro::hayro_interpret::InterpreterSettings::default());
    let mut dev = TextDevice { chars: Vec::new() };
    hayro::hayro_interpret::interpret_page(page, &mut ctx, &mut dev);
    // Character widths: the distance to the next character on the same line, else about half
    // the font size.
    let n = dev.chars.len();
    let mut words = Vec::new();
    let mut cur: Option<(String, f64, f64, f64, f64, f64, f64)> = None;
    for i in 0..n {
        let c = &dev.chars[i];
        let next = dev.chars.get(i + 1);
        let same_line = |a: &Ch, b: &Ch| (a.origin.y - b.origin.y).abs() < a.size.max(1.0) * 0.35 && b.origin.x >= a.origin.x - a.size * 0.1;
        let adv = match next {
            Some(nx) if same_line(c, nx) && nx.origin.x - c.origin.x < c.size * 1.2 => (nx.origin.x - c.origin.x).max(c.size * 0.15),
            _ => c.size * 0.5 * c.text.chars().count().max(1) as f64,
        };
        let blank = c.text.trim().is_empty();
        let horizontal = c.dir.0 > 0.9;
        let (x0, x1) = (c.origin.x, c.origin.x + if horizontal { adv } else { c.size * 0.6 });
        let (y0, y1) = (c.origin.y - c.size * 0.8, c.origin.y + c.size * 0.22);
        let joins = match &cur {
            Some(w) => !blank && (c.origin.y - w.6).abs() < c.size.max(1.0) * 0.35 && c.origin.x - w.3 < c.size * 0.3 && c.origin.x >= w.1 - 1.0,
            None => false,
        };
        if joins {
            let w = cur.as_mut().unwrap();
            w.0.push_str(&c.text);
            w.3 = w.3.max(x1);
            w.2 = w.2.min(y0);
            w.4 = w.4.max(y1);
        } else {
            if let Some(w) = cur.take() {
                words.push(w);
            }
            if !blank {
                cur = Some((c.text.clone(), x0, y0, x1, y1, c.size, c.origin.y));
            }
        }
    }
    if let Some(w) = cur {
        words.push(w);
    }
    words
}

fn json_str(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 2);
    o.push('"');
    for ch in s.chars() {
        match ch {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

#[wasm_bindgen]
impl Viewer {
    /// The words of a page as JSON: [[text, x0, y0, x1, y1, size, baseline], ...] in points as
    /// shown, from the top-left. For the selectable text layer, search and Edit text.
    pub fn words(&self, index: u32) -> String {
        let pages = self.pdf.pages();
        let Some(page) = pages.get(index as usize) else { return "[]".into() };
        let r = |v: f64| (v * 100.0).round() / 100.0;
        let items: Vec<String> = page_words(page)
            .into_iter()
            .map(|(t, x0, y0, x1, y1, s, b)| format!("[{},{},{},{},{},{},{}]", json_str(&t), r(x0), r(y0), r(x1), r(y1), r(s), r(b)))
            .collect();
        format!("[{}]", items.join(","))
    }
}

// ---------------------------------------------------------------- helpers

fn load(bytes: &[u8]) -> Result<Document, JsError> {
    let mut doc = Document::load_mem(bytes).map_err(|e| JsError::new(&format!("this PDF cannot be edited ({e})")))?;
    if doc.trailer.get(b"Encrypt").is_ok() {
        // Locked only against changes (an owner password): opened with the empty password while
        // loading; it is edited and saved without the lock. A reader password: unlock() first.
        if doc.authenticate_password("").is_err() {
            return Err(JsError::new("this PDF needs its password: unlock it first"));
        }
        if let Ok(id) = doc.trailer.get(b"Encrypt").and_then(Object::as_reference) {
            doc.objects.remove(&id);
        }
        doc.trailer.remove(b"Encrypt");
        doc.encryption_state = None;
    }
    flatten_inherited(&mut doc);
    Ok(doc)
}

fn save(doc: &mut Document) -> Result<Vec<u8>, JsError> {
    let mut out = Vec::new();
    doc.save_to(&mut out).map_err(|e| JsError::new(&format!("could not write the PDF ({e})")))?;
    Ok(out)
}

/// Page ids in reading order.
fn page_ids(doc: &Document) -> Vec<ObjectId> {
    doc.get_pages().values().copied().collect()
}

/// Copies what a page inherits from its page tree (MediaBox, CropBox, Resources, Rotate) onto the
/// page itself, so pages can be moved, merged and re-parented without losing anything.
fn flatten_inherited(doc: &mut Document) {
    for id in page_ids(doc) {
        for key in [b"MediaBox".as_slice(), b"CropBox", b"Resources", b"Rotate"] {
            let has = doc.get_dictionary(id).map(|d| d.has(key)).unwrap_or(true);
            if has {
                continue;
            }
            // Walk up the Parent chain.
            let mut cur = doc.get_dictionary(id).ok().and_then(|d| d.get(b"Parent").ok()).and_then(|p| p.as_reference().ok());
            let mut found: Option<Object> = None;
            let mut hops = 0;
            while let (Some(pid), true) = (cur, hops < 64) {
                hops += 1;
                let Ok(pd) = doc.get_dictionary(pid) else { break };
                if let Ok(v) = pd.get(key) {
                    found = Some(v.clone());
                    break;
                }
                cur = pd.get(b"Parent").ok().and_then(|p| p.as_reference().ok());
            }
            if let Some(v) = found {
                if let Ok(d) = doc.get_dictionary_mut(id) {
                    d.set(key, v);
                }
            }
        }
    }
}

/// Puts the pages, in this order, directly under the root page tree node.
fn set_page_order(doc: &mut Document, order: &[ObjectId]) -> Result<(), JsError> {
    let root = doc.catalog().map_err(|e| JsError::new(&e.to_string()))?.get(b"Pages").and_then(Object::as_reference).map_err(|e| JsError::new(&e.to_string()))?;
    for id in order {
        if let Ok(d) = doc.get_dictionary_mut(*id) {
            d.set("Parent", root);
        }
    }
    let pages = doc.get_dictionary_mut(root).map_err(|e| JsError::new(&e.to_string()))?;
    pages.set("Kids", order.iter().map(|id| Object::Reference(*id)).collect::<Vec<_>>());
    pages.set("Count", order.len() as i64);
    Ok(())
}

/// The page's own Resources dictionary (made direct on the page, so it can be added to).
fn resources_mut(doc: &mut Document, page: ObjectId) -> Result<&mut lopdf::Dictionary, JsError> {
    let current = doc.get_dictionary(page).map_err(|e| JsError::new(&e.to_string()))?.get(b"Resources").cloned().ok();
    let resolved = match current {
        Some(Object::Reference(r)) => doc.get_dictionary(r).cloned().unwrap_or_default(),
        Some(Object::Dictionary(d)) => d,
        _ => lopdf::Dictionary::new(),
    };
    let d = doc.get_dictionary_mut(page).map_err(|e| JsError::new(&e.to_string()))?;
    d.set("Resources", Object::Dictionary(resolved));
    match d.get_mut(b"Resources") {
        Ok(Object::Dictionary(r)) => Ok(r),
        _ => Err(JsError::new("page resources")),
    }
}

/// Adds a named entry to one category of the page's resources (Font, XObject, ExtGState).
fn add_resource(doc: &mut Document, page: ObjectId, category: &str, name: &str, value: Object) -> Result<(), JsError> {
    let res = resources_mut(doc, page)?;
    let mut cat = match res.get(category.as_bytes()) {
        Ok(Object::Dictionary(d)) => d.clone(),
        _ => lopdf::Dictionary::new(),
    };
    // A category given by reference is copied in, so it can be changed for this page only.
    if let Ok(Object::Reference(_)) = res.get(category.as_bytes()) {
        cat = lopdf::Dictionary::new();
    }
    cat.set(name, value);
    res.set(category, Object::Dictionary(cat));
    Ok(())
}

/// Appends drawing operators to a page. The page's own drawing is wrapped in q/Q first, so a
/// state it leaves behind (a transform, a colour) cannot bend what is added.
fn append_content(doc: &mut Document, page: ObjectId, ops: String) -> Result<(), JsError> {
    let before = doc.add_object(Stream::new(dictionary! {}, b"q\n".to_vec()));
    let after = doc.add_object(Stream::new(dictionary! {}, format!("\nQ\nq\n{ops}\nQ\n").into_bytes()));
    let d = doc.get_dictionary_mut(page).map_err(|e| JsError::new(&e.to_string()))?;
    let mut list: Vec<Object> = vec![Object::Reference(before)];
    match d.get(b"Contents") {
        Ok(Object::Array(a)) => list.extend(a.iter().cloned()),
        Ok(o) => list.push(o.clone()),
        Err(_) => {}
    }
    list.push(Object::Reference(after));
    d.set("Contents", list);
    Ok(())
}

fn page_at(doc: &Document, index: u32) -> Result<ObjectId, JsError> {
    page_ids(doc).get(index as usize).copied().ok_or_else(|| JsError::new("no such page"))
}

/// The page's box as stored: [x0, y0, x1, y1].
fn media_box(doc: &Document, page: ObjectId) -> [f32; 4] {
    let mb = doc.get_dictionary(page).ok().and_then(|d| d.get(b"CropBox").or_else(|_| d.get(b"MediaBox")).ok()).and_then(|o| o.as_array().ok());
    let num = |o: &Object| o.as_float().or_else(|_| o.as_i64().map(|i| i as f32)).unwrap_or(0.0);
    match mb {
        Some(a) if a.len() == 4 => [num(&a[0]), num(&a[1]), num(&a[2]), num(&a[3])],
        _ => [0.0, 0.0, 612.0, 792.0],
    }
}

/// Text for a Helvetica string: only what WinAnsi can show, brackets escaped.
fn pdf_text(t: &str) -> String {
    t.chars()
        .map(|c| if (' '..='~').contains(&c) { c } else { '?' })
        .collect::<String>()
        .replace('\\', "\\\\")
        .replace('(', "\\(")
        .replace(')', "\\)")
}

fn helvetica(doc: &mut Document, page: ObjectId, bold: bool) -> Result<&'static str, JsError> {
    let (name, base) = if bold { ("GmbHB", "Helvetica-Bold") } else { ("GmbH", "Helvetica") };
    let font = doc.add_object(dictionary! { "Type" => "Font", "Subtype" => "Type1", "BaseFont" => base, "Encoding" => "WinAnsiEncoding" });
    add_resource(doc, page, "Font", name, Object::Reference(font))?;
    Ok(name)
}

fn opacity(doc: &mut Document, page: ObjectId, alpha: f32, multiply: bool) -> Result<String, JsError> {
    let name = format!("GmbA{}{}", (alpha * 100.0).round() as u32, if multiply { "m" } else { "" });
    let mut gs = dictionary! { "Type" => "ExtGState", "ca" => alpha, "CA" => alpha };
    if multiply {
        gs.set("BM", "Multiply");
    }
    let id = doc.add_object(gs);
    add_resource(doc, page, "ExtGState", &name, Object::Reference(id))?;
    Ok(name)
}

// ---------------------------------------------------------------- organising

#[wasm_bindgen]
pub fn page_boxes(bytes: &[u8]) -> Result<Vec<f32>, JsError> {
    let doc = load(bytes)?;
    let mut out = Vec::new();
    for id in page_ids(&doc) {
        let b = media_box(&doc, id);
        let rot = doc.get_dictionary(id).ok().and_then(|d| d.get(b"Rotate").ok()).and_then(|o| o.as_i64().ok()).unwrap_or(0);
        out.extend_from_slice(&[b[0], b[1], b[2], b[3], (((rot % 360) + 360) % 360) as f32]);
    }
    Ok(out)
}

#[wasm_bindgen]
pub fn delete_pages(bytes: &[u8], indices: Vec<u32>) -> Result<Vec<u8>, JsError> {
    let mut doc = load(bytes)?;
    let ids = page_ids(&doc);
    let keep: Vec<ObjectId> = ids.iter().enumerate().filter(|(i, _)| !indices.contains(&(*i as u32))).map(|(_, id)| *id).collect();
    if keep.is_empty() {
        return Err(JsError::new("a PDF needs at least one page"));
    }
    set_page_order(&mut doc, &keep)?;
    doc.prune_objects();
    save(&mut doc)
}

/// `order` lists the current page indices in their new order (it may also leave pages out).
#[wasm_bindgen]
pub fn reorder_pages(bytes: &[u8], order: Vec<u32>) -> Result<Vec<u8>, JsError> {
    let mut doc = load(bytes)?;
    let ids = page_ids(&doc);
    let new: Vec<ObjectId> = order.iter().filter_map(|i| ids.get(*i as usize).copied()).collect();
    if new.is_empty() {
        return Err(JsError::new("no pages in that order"));
    }
    set_page_order(&mut doc, &new)?;
    doc.prune_objects();
    save(&mut doc)
}

#[wasm_bindgen]
pub fn rotate_pages(bytes: &[u8], indices: Vec<u32>, degrees: i32) -> Result<Vec<u8>, JsError> {
    let mut doc = load(bytes)?;
    for (i, id) in page_ids(&doc).into_iter().enumerate() {
        if indices.is_empty() || indices.contains(&(i as u32)) {
            let d = doc.get_dictionary_mut(id).map_err(|e| JsError::new(&e.to_string()))?;
            let cur = d.get(b"Rotate").ok().and_then(|o| o.as_i64().ok()).unwrap_or(0);
            d.set("Rotate", ((cur + degrees as i64) % 360 + 360) % 360);
        }
    }
    save(&mut doc)
}

/// Appends the pages of `b` after those of `a`.
#[wasm_bindgen]
pub fn merge(a: &[u8], b: &[u8]) -> Result<Vec<u8>, JsError> {
    let mut first = load(a)?;
    let mut second = load(b)?;
    second.renumber_objects_with(first.max_id + 1);
    let second_pages = page_ids(&second);
    let mut order = page_ids(&first);
    // Every object of the second file except its catalog and page-tree nodes comes over.
    for (id, obj) in second.objects.iter() {
        let t = obj.type_name().unwrap_or(b"");
        if t == b"Catalog" || t == b"Pages" || t == b"Outlines" || t == b"Outline" {
            continue;
        }
        first.objects.insert(*id, obj.clone());
    }
    first.max_id = first.max_id.max(second.max_id);
    order.extend(second_pages);
    set_page_order(&mut first, &order)?;
    first.prune_objects();
    first.renumber_objects();
    save(&mut first)
}

// ---------------------------------------------------------------- marking

/// Diagonal text across every page, see-through.
#[wasm_bindgen]
pub fn watermark(bytes: &[u8], text: &str, alpha: f32, r: f32, g: f32, b: f32) -> Result<Vec<u8>, JsError> {
    let mut doc = load(bytes)?;
    for id in page_ids(&doc) {
        let font = helvetica(&mut doc, id, true)?;
        let gs = opacity(&mut doc, id, alpha.clamp(0.05, 1.0), false)?;
        let [x0, y0, x1, y1] = media_box(&doc, id);
        let (w, h) = (x1 - x0, y1 - y0);
        let size = (w.min(h) / (text.chars().count().max(4) as f32) * 1.6).clamp(18.0, 140.0);
        let width = text.chars().count() as f32 * size * 0.55;
        let (cx, cy) = (x0 + w / 2.0, y0 + h / 2.0);
        let (c, s) = (std::f32::consts::FRAC_1_SQRT_2, std::f32::consts::FRAC_1_SQRT_2);
        let ops = format!(
            "/{gs} gs {r} {g} {b} rg BT /{font} {size} Tf {c} {s} {ns} {c} {cx} {cy} cm {dx} {dy} Td ({t}) Tj ET",
            ns = -s,
            dx = -width / 2.0,
            dy = -size / 3.0,
            t = pdf_text(text)
        );
        append_content(&mut doc, id, ops)?;
    }
    save(&mut doc)
}

/// Text at (x, y), the baseline's left end.
#[wasm_bindgen]
pub fn add_text(bytes: &[u8], index: u32, x: f32, y: f32, size: f32, r: f32, g: f32, b: f32, text: &str) -> Result<Vec<u8>, JsError> {
    let mut doc = load(bytes)?;
    let id = page_at(&doc, index)?;
    let font = helvetica(&mut doc, id, false)?;
    let mut ops = format!("{r} {g} {b} rg BT /{font} {size} Tf {lead} TL {x} {y} Td", lead = size * 1.25);
    for (i, line) in text.lines().enumerate() {
        if i > 0 {
            ops.push_str(" T*");
        }
        ops.push_str(&format!(" ({}) Tj", pdf_text(line)));
    }
    ops.push_str(" ET");
    append_content(&mut doc, id, ops)?;
    save(&mut doc)
}

/// A filled box: a highlight (see-through, multiplied) or a cover-up box (opaque). A cover-up
/// only hides what is under it on screen and on paper; the text underneath stays in the file.
#[wasm_bindgen]
pub fn add_box(bytes: &[u8], index: u32, x: f32, y: f32, w: f32, h: f32, r: f32, g: f32, b: f32, alpha: f32) -> Result<Vec<u8>, JsError> {
    let mut doc = load(bytes)?;
    let id = page_at(&doc, index)?;
    let gs = opacity(&mut doc, id, alpha.clamp(0.05, 1.0), alpha < 0.99)?;
    append_content(&mut doc, id, format!("/{gs} gs {r} {g} {b} rg {x} {y} {w} {h} re f"))?;
    save(&mut doc)
}

/// A freehand line through `points` (x0, y0, x1, y1, ...).
#[wasm_bindgen]
pub fn add_ink(bytes: &[u8], index: u32, points: Vec<f32>, r: f32, g: f32, b: f32, width: f32) -> Result<Vec<u8>, JsError> {
    if points.len() < 4 {
        return Err(JsError::new("a line needs two points"));
    }
    let mut doc = load(bytes)?;
    let id = page_at(&doc, index)?;
    let mut ops = format!("{r} {g} {b} RG {width} w 1 J 1 j {} {} m", points[0], points[1]);
    for p in points[2..].chunks(2) {
        if p.len() == 2 {
            ops.push_str(&format!(" {} {} l", p[0], p[1]));
        }
    }
    ops.push_str(" S");
    append_content(&mut doc, id, ops)?;
    save(&mut doc)
}

/// An image (a signature, a stamp) from RGBA pixels, placed in the box (x, y, w, h). Its
/// transparency is kept (a soft mask), so a signature on white looks like ink.
#[wasm_bindgen]
pub fn add_image(bytes: &[u8], index: u32, x: f32, y: f32, w: f32, h: f32, rgba: &[u8], iw: u32, ih: u32) -> Result<Vec<u8>, JsError> {
    if rgba.len() != (iw * ih * 4) as usize {
        return Err(JsError::new("the image's size does not match its pixels"));
    }
    let mut doc = load(bytes)?;
    let id = page_at(&doc, index)?;
    let mut rgb = Vec::with_capacity((iw * ih * 3) as usize);
    let mut alpha = Vec::with_capacity((iw * ih) as usize);
    for px in rgba.chunks(4) {
        rgb.extend_from_slice(&px[..3]);
        alpha.push(px[3]);
    }
    let mut mask = Stream::new(dictionary! { "Type" => "XObject", "Subtype" => "Image", "Width" => iw, "Height" => ih, "ColorSpace" => "DeviceGray", "BitsPerComponent" => 8 }, alpha);
    let _ = mask.compress();
    let mask_id = doc.add_object(mask);
    let mut img = Stream::new(dictionary! { "Type" => "XObject", "Subtype" => "Image", "Width" => iw, "Height" => ih, "ColorSpace" => "DeviceRGB", "BitsPerComponent" => 8, "SMask" => mask_id }, rgb);
    let _ = img.compress();
    let img_id = doc.add_object(img);
    let name = format!("GmbI{}", img_id.0);
    add_resource(&mut doc, id, "XObject", &name, Object::Reference(img_id))?;
    append_content(&mut doc, id, format!("{w} 0 0 {h} {x} {y} cm /{name} Do"))?;
    save(&mut doc)
}

// ---------------------------------------------------------------- arranging pictures already on a page

/// A 2D transform as PDF writes it: [a b c d e f], points as rows (p' = p x M).
type Mx = [f64; 6];
const ID: Mx = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];
fn mul(m: &Mx, n: &Mx) -> Mx {
    [
        m[0] * n[0] + m[1] * n[2],
        m[0] * n[1] + m[1] * n[3],
        m[2] * n[0] + m[3] * n[2],
        m[2] * n[1] + m[3] * n[3],
        m[4] * n[0] + m[5] * n[2] + n[4],
        m[4] * n[1] + m[5] * n[3] + n[5],
    ]
}
fn inv(m: &Mx) -> Option<Mx> {
    let det = m[0] * m[3] - m[1] * m[2];
    if det.abs() < 1e-12 {
        return None;
    }
    Some([m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det])
}
fn apply(m: &Mx, x: f64, y: f64) -> (f64, f64) {
    (x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5])
}
fn num(o: &Object) -> f64 {
    o.as_float().map(|f| f as f64).or_else(|_| o.as_i64().map(|i| i as f64)).unwrap_or(0.0)
}

/// The page's XObjects by name: 1 = a picture, 2 = a drawn group (form).
fn xobject_kinds(doc: &Document, page: ObjectId) -> std::collections::HashMap<Vec<u8>, u8> {
    let mut out = std::collections::HashMap::new();
    let res = doc.get_dictionary(page).ok().and_then(|d| d.get(b"Resources").ok()).and_then(|r| match r {
        Object::Reference(id) => doc.get_dictionary(*id).ok(),
        Object::Dictionary(d) => Some(d),
        _ => None,
    });
    let xo = res.and_then(|r| r.get(b"XObject").ok()).and_then(|x| match x {
        Object::Reference(id) => doc.get_dictionary(*id).ok(),
        Object::Dictionary(d) => Some(d),
        _ => None,
    });
    if let Some(xo) = xo {
        for (name, v) in xo.iter() {
            let sub = v.as_reference().ok().and_then(|id| doc.get_object(id).ok()).and_then(|o| o.as_stream().ok()).and_then(|s| s.dict.get(b"Subtype").ok()).and_then(|s| s.as_name().ok());
            let kind = match sub {
                Some(b"Image") => 1,
                Some(b"Form") => 2,
                _ => 0,
            };
            if kind > 0 {
                out.insert(name.clone(), kind);
            }
        }
    }
    out
}

/// Each picture (and drawn group) the page shows: (operation index, kind, transform at that point).
fn placed_objects(doc: &Document, page: ObjectId) -> Result<(lopdf::content::Content, Vec<(usize, u8, Mx)>), JsError> {
    let content = doc.get_and_decode_page_content(page).map_err(|e| JsError::new(&format!("the page's drawing could not be read ({e})")))?;
    let kinds = xobject_kinds(doc, page);
    let mut stack: Vec<Mx> = Vec::new();
    let mut ctm = ID;
    let mut found = Vec::new();
    for (i, op) in content.operations.iter().enumerate() {
        match op.operator.as_str() {
            "q" => stack.push(ctm),
            "Q" => ctm = stack.pop().unwrap_or(ID),
            "cm" if op.operands.len() == 6 => {
                let m: Mx = [num(&op.operands[0]), num(&op.operands[1]), num(&op.operands[2]), num(&op.operands[3]), num(&op.operands[4]), num(&op.operands[5])];
                ctm = mul(&m, &ctm);
            }
            "Do" => {
                if let Some(Ok(name)) = op.operands.first().map(|o| o.as_name()) {
                    if let Some(k) = kinds.get(name) {
                        found.push((i, *k, ctm));
                    }
                }
            }
            _ => {}
        }
    }
    Ok((content, found))
}

fn unit_box(m: &Mx) -> [f64; 4] {
    let pts = [apply(m, 0.0, 0.0), apply(m, 1.0, 0.0), apply(m, 0.0, 1.0), apply(m, 1.0, 1.0)];
    let xs = pts.iter().map(|p| p.0);
    let ys = pts.iter().map(|p| p.1);
    [xs.clone().fold(f64::MAX, f64::min), ys.clone().fold(f64::MAX, f64::min), xs.fold(f64::MIN, f64::max), ys.fold(f64::MIN, f64::max)]
}

/// The pictures on a page: [operation index, kind (1 picture, 2 drawn group), x0, y0, x1, y1] in
/// PDF points, for each one, in drawing order. (A drawn group's box is its unit square only when
/// it was drawn that way; pictures are exact.)
#[wasm_bindgen]
pub fn page_objects(bytes: &[u8], index: u32) -> Result<Vec<f32>, JsError> {
    let doc = load(bytes)?;
    let page = page_at(&doc, index)?;
    let (_, found) = placed_objects(&doc, page)?;
    let mut out = Vec::new();
    for (i, k, m) in found {
        if k != 1 {
            continue; // pictures only for now: a form's own box needs its BBox
        }
        let b = unit_box(&m);
        out.extend_from_slice(&[i as f32, k as f32, b[0] as f32, b[1] as f32, b[2] as f32, b[3] as f32]);
    }
    Ok(out)
}

/// Moves and resizes one picture (by the operation index `page_objects` gave) so that it fills
/// the box (x0, y0, x1, y1) on the page; or deletes it when `remove` is set. Only where it is
/// drawn changes: the picture itself is untouched.
#[wasm_bindgen]
pub fn place_object(bytes: &[u8], index: u32, op: u32, x0: f32, y0: f32, x1: f32, y1: f32, remove: bool) -> Result<Vec<u8>, JsError> {
    let mut doc = load(bytes)?;
    let page = page_at(&doc, index)?;
    let (mut content, found) = placed_objects(&doc, page)?;
    let Some((at, _, ctm)) = found.into_iter().find(|f| f.0 == op as usize) else { return Err(JsError::new("that picture is not on the page any more")) };
    if remove {
        content.operations.remove(at);
    } else {
        let old = unit_box(&ctm);
        let (ow, oh) = (old[2] - old[0], old[3] - old[1]);
        if ow.abs() < 1e-6 || oh.abs() < 1e-6 {
            return Err(JsError::new("this picture has no size"));
        }
        let (sx, sy) = ((x1 - x0) as f64 / ow, (y1 - y0) as f64 / oh);
        // In page space: from the old box to the new one.
        let a: Mx = [sx, 0.0, 0.0, sy, x0 as f64 - old[0] * sx, y0 as f64 - old[1] * sy];
        // The same change expressed in the space the picture is drawn in: M = CTM x A x CTM^-1.
        let ci = inv(&ctm).ok_or_else(|| JsError::new("this picture is drawn flat and cannot be moved"))?;
        let m = mul(&mul(&ctm, &a), &ci);
        let cm = lopdf::content::Operation::new("cm", m.iter().map(|v| Object::Real(*v as f32)).collect());
        content.operations.insert(at + 1, lopdf::content::Operation::new("Q", vec![]));
        content.operations.insert(at, cm);
        content.operations.insert(at, lopdf::content::Operation::new("q", vec![]));
    }
    let bytes_out = content.encode().map_err(|e| JsError::new(&e.to_string()))?;
    // One stream for the page from now on.
    let stream = doc.add_object(Stream::new(dictionary! {}, bytes_out));
    doc.get_dictionary_mut(page).map_err(|e| JsError::new(&e.to_string()))?.set("Contents", stream);
    doc.prune_objects();
    save(&mut doc)
}

// ---------------------------------------------------------------- compress, unlock

/// Smaller: unused objects go, every stream is compressed, objects are packed into object streams.
/// (Pictures keep their quality; shrinking them is a later step.)
#[wasm_bindgen]
pub fn compress(bytes: &[u8]) -> Result<Vec<u8>, JsError> {
    let mut doc = load(bytes)?;
    doc.prune_objects();
    doc.delete_zero_length_streams();
    doc.compress();
    let mut out = Vec::new();
    let opts = lopdf::SaveOptions::builder().use_object_streams(true).use_xref_streams(true).build();
    doc.save_with_options(&mut out, opts).map_err(|e| JsError::new(&format!("could not write the PDF ({e})")))?;
    // Never hand back something bigger.
    Ok(if out.len() < bytes.len() { out } else { bytes.to_vec() })
}

/// Locked with a password that the reader needs (not only an owner password, which Gamblium
/// opens by itself).
#[wasm_bindgen]
pub fn needs_password(bytes: &[u8]) -> bool {
    match Document::load_mem(bytes) {
        Ok(doc) => doc.is_encrypted() && doc.trailer.get(b"Encrypt").is_ok() && doc.authenticate_password("").is_err(),
        Err(_) => false,
    }
}

/// Locked by its author against changes only (an owner password; it opens without one): any edit
/// saves it without that lock, so the viewer says so once first (review 2, 2.5).
#[wasm_bindgen]
pub fn owner_locked(bytes: &[u8]) -> bool {
    match Document::load_mem(bytes) {
        // Only when the lock forbids something (printing, changing, copying, notes): a lock that
        // allows everything is not worth a word (review 9, G20).
        Ok(doc) => {
            let enc = doc.trailer.get(b"Encrypt").ok().and_then(|e| match e {
                Object::Reference(id) => doc.get_object(*id).ok().and_then(|o| o.as_dict().ok()).cloned(),
                Object::Dictionary(d) => Some(d.clone()),
                _ => None,
            });
            let Some(enc) = enc else { return false };
            let p = enc.get(b"P").ok().and_then(|p| p.as_i64().ok()).unwrap_or(-1);
            let all = 4 | 8 | 16 | 32;
            doc.authenticate_password("").is_ok() && (p & all) != all
        }
        Err(_) => false,
    }
}

/// The same PDF without its lock: decrypted with the password (empty for owner-only locks) and
/// saved without encryption, so it can be viewed and edited.
#[wasm_bindgen]
pub fn unlock(bytes: &[u8], password: &str) -> Result<Vec<u8>, JsError> {
    unlock_doc(bytes, password).map_err(|e| JsError::new(&e))
}

fn unlock_doc(bytes: &[u8], password: &str) -> Result<Vec<u8>, String> {
    let mut doc = Document::load_mem(bytes).map_err(|e| format!("this PDF cannot be read ({e})"))?;
    if doc.trailer.get(b"Encrypt").is_err() {
        return Ok(bytes.to_vec());
    }
    if doc.authenticate_password(password).is_err() {
        return Err("that password is not right".into());
    }
    if doc.encryption_state.is_none() {
        // lopdf only tries the empty password while loading and keeps none of the objects
        // otherwise: read them still encrypted, straight from the file, then decrypt them.
        let enc = doc.trailer.get(b"Encrypt").and_then(Object::as_reference).ok();
        let ids: Vec<ObjectId> = doc
            .reference_table
            .entries
            .iter()
            .filter_map(|(n, e)| match e {
                lopdf::xref::XrefEntry::Normal { generation, .. } => Some((*n, *generation)),
                _ => None,
            })
            .filter(|id| Some(*id) != enc)
            .collect();
        let reader = lopdf::Reader { buffer: bytes, document: doc.clone(), encryption_state: None, raw_objects: Default::default() };
        let mut found = Vec::new();
        for id in ids {
            let mut seen = std::collections::HashSet::new();
            if let Ok(obj) = reader.get_object(id, &mut seen) {
                // Cross-reference streams are never encrypted and are rebuilt on saving.
                if obj.as_stream().map(|s| s.dict.has_type(b"XRef")).unwrap_or(false) {
                    continue;
                }
                found.push((id, obj));
            }
        }
        doc.objects.extend(found);
        doc.decrypt(password).map_err(|e| format!("could not open the lock ({e})"))?;
    }
    if let Ok(id) = doc.trailer.get(b"Encrypt").and_then(Object::as_reference) {
        doc.objects.remove(&id);
    }
    doc.trailer.remove(b"Encrypt");
    doc.encryption_state = None;
    let mut out = Vec::new();
    doc.save_to(&mut out).map_err(|e| format!("could not write the PDF ({e})"))?;
    Ok(out)
}

/// Locks the PDF with AES-256 (PDF 2.0's standard security handler). `user_password` is needed
/// to open it; `owner_password` (or the same one when empty) to lift the lock. `key` is 32 random
/// bytes from the caller (the browser's crypto source), so the engine needs no randomness of its own.
#[wasm_bindgen]
pub fn protect(bytes: &[u8], user_password: &str, owner_password: &str, key: &[u8]) -> Result<Vec<u8>, JsError> {
    protect_doc(bytes, user_password, owner_password, key).map_err(|e| JsError::new(&e))
}

fn protect_doc(bytes: &[u8], user_password: &str, owner_password: &str, key: &[u8]) -> Result<Vec<u8>, String> {
    use lopdf::encryption::crypt_filters::{Aes256CryptFilter, CryptFilter};
    use lopdf::{EncryptionState, EncryptionVersion, Permissions};
    use std::collections::BTreeMap;
    use std::sync::Arc;
    if key.len() != 32 {
        return Err("the lock needs 32 random bytes".into());
    }
    if user_password.is_empty() {
        return Err("type a password".into());
    }
    // An already locked file is opened first (owner-only locks open by themselves). One that needs
    // its own password says so, not "that password is not right" about the new one (review 2, 2.5).
    if needs_password(bytes) {
        return Err("this PDF already has a password: open it with that password first, then lock it again".into());
    }
    let plain = unlock_doc(bytes, "")?;
    let mut doc = Document::load_mem(&plain).map_err(|e| format!("this PDF cannot be read ({e})"))?;
    if doc.trailer.get(b"ID").is_err() {
        // Not the key itself: the ID is stored in the clear, and its first 16 bytes were half the
        // file key (review 2, 2.4). A hash of the key with a label reveals nothing of it.
        let id = {
            use sha2::Digest;
            let mut h = sha2::Sha256::new();
            h.update(b"gamblium pdf file id");
            h.update(key);
            Object::String(h.finalize()[..16].to_vec(), lopdf::StringFormat::Hexadecimal)
        };
        doc.trailer.set("ID", vec![id.clone(), id]);
    }
    let owner = if owner_password.is_empty() { user_password } else { owner_password };
    let filter: Arc<dyn CryptFilter> = Arc::new(Aes256CryptFilter);
    let version = EncryptionVersion::V5 {
        encrypt_metadata: true,
        crypt_filters: BTreeMap::from([(b"StdCF".to_vec(), filter)]),
        file_encryption_key: key,
        stream_filter: b"StdCF".to_vec(),
        string_filter: b"StdCF".to_vec(),
        owner_password: owner,
        user_password,
        permissions: Permissions::all(),
    };
    let state = EncryptionState::try_from(version).map_err(|e| format!("could not lock it ({e})"))?;
    doc.encrypt(&state).map_err(|e| format!("could not lock it ({e})"))?;
    let mut out = Vec::new();
    doc.save_to(&mut out).map_err(|e| format!("could not write the PDF ({e})"))?;
    Ok(out)
}

// ---------------------------------------------------------------- true redaction

/// Redacts boxes on one page for good. `rects` are [x0, y0, x1, y1, ...] in points as shown,
/// from the top-left (the same space as `Viewer.words`). The page is drawn as a picture with the
/// boxes burned in black and that picture replaces everything the page had (text, fonts' use,
/// pictures, links and form fields on it); the words outside the boxes come back as invisible
/// text, so the page can still be searched and selected. Whatever nothing refers to any more is
/// dropped from the file, so the hidden words are not in it at all.
#[wasm_bindgen]
pub fn redact(bytes: &[u8], index: u32, rects: Vec<f32>) -> Result<Vec<u8>, JsError> {
    redact_doc(bytes, index, &rects).map_err(|e| JsError::new(&e))
}

fn redact_doc(bytes: &[u8], index: u32, rects: &[f32]) -> Result<Vec<u8>, String> {
    const SCALE: f32 = 2.0; // 144 pixels per inch
    if rects.len() < 4 || rects.len() % 4 != 0 {
        return Err("no box to redact".into());
    }
    let plain = unlock_doc(bytes, "")?;
    let pdf = hayro::hayro_syntax::Pdf::new(plain.clone()).map_err(|e| format!("this PDF cannot be read ({e:?})"))?;
    let pages = pdf.pages();
    let page = pages.get(index as usize).ok_or("there is no such page")?;
    let (pw, ph) = page.render_dimensions();
    let (pw, ph) = (pw as f64, ph as f64);
    let boxes: Vec<[f64; 4]> = rects
        .chunks(4)
        .map(|r| {
            let (a, b, c, d) = (r[0] as f64, r[1] as f64, r[2] as f64, r[3] as f64);
            [a.min(c), b.min(d), a.max(c), b.max(d)]
        })
        .collect();
    // A word touching a box goes entirely.
    let hit = |x0: f64, y0: f64, x1: f64, y1: f64| boxes.iter().any(|b| x0 < b[2] && x1 > b[0] && y0 < b[3] && y1 > b[1]);
    let kept: Vec<_> = page_words(page).into_iter().filter(|w| !hit(w.1, w.2, w.3, w.4)).collect();

    let cache = hayro::RenderCache::new();
    let settings = hayro::hayro_interpret::InterpreterSettings::default();
    let pix = hayro::render(
        page,
        &cache,
        &settings,
        &hayro::RenderSettings::default(),
        &hayro::PixmapSettings { x_scale: SCALE, y_scale: SCALE, bg_color: hayro::vello_cpu::color::palette::css::WHITE },
    );
    let (w, h) = (pix.width() as usize, pix.height() as usize);
    let mut rgb = Vec::with_capacity(w * h * 3);
    for px in pix.data_as_u8_slice().chunks(4) {
        rgb.extend_from_slice(&px[..3]);
    }
    for b in &boxes {
        let s = SCALE as f64;
        let (x0, x1) = (((b[0] * s).floor().max(0.0) as usize).min(w), ((b[2] * s).ceil().max(0.0) as usize).min(w));
        let (y0, y1) = (((b[1] * s).floor().max(0.0) as usize).min(h), ((b[3] * s).ceil().max(0.0) as usize).min(h));
        for y in y0..y1 {
            rgb[(y * w + x0) * 3..(y * w + x1) * 3].fill(0);
        }
    }

    let mut doc = Document::load_mem(&plain).map_err(|e| format!("this PDF cannot be edited ({e})"))?;
    flatten_inherited(&mut doc);
    let pid = *page_ids(&doc).get(index as usize).ok_or("there is no such page")?;
    let mut img = Stream::new(dictionary! { "Type" => "XObject", "Subtype" => "Image", "Width" => w as i64, "Height" => h as i64, "ColorSpace" => "DeviceRGB", "BitsPerComponent" => 8 }, rgb);
    let _ = img.compress();
    let img_id = doc.add_object(img);
    let font = doc.add_object(dictionary! { "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica", "Encoding" => "WinAnsiEncoding" });
    let mut ops = format!("q {pw:.2} 0 0 {ph:.2} 0 0 cm /GmbRd Do Q");
    if !kept.is_empty() {
        ops.push_str("\nBT 3 Tr");
        for (t, x0, _, x1, _, size, base) in &kept {
            let size = size.max(1.0);
            let guess = 0.5 * size * t.chars().count().max(1) as f64;
            let tz = ((x1 - x0) / guess * 100.0).clamp(20.0, 400.0);
            ops.push_str(&format!("\n/GmbRdF {size:.2} Tf {tz:.1} Tz 1 0 0 1 {x0:.2} {:.2} Tm ({} ) Tj", ph - base, pdf_text(t)));
        }
        ops.push_str("\nET");
    }
    let mut content = Stream::new(dictionary! {}, ops.into_bytes());
    let _ = content.compress();
    let content_id = doc.add_object(content);

    // The page's annotations go with it (links, comments, form fields on this page).
    let gone: std::collections::HashSet<ObjectId> = doc
        .get_dictionary(pid)
        .ok()
        .and_then(|d| d.get(b"Annots").ok())
        .and_then(|a| match a {
            Object::Array(v) => Some(v.clone()),
            Object::Reference(r) => doc.get_object(*r).ok().and_then(|o| o.as_array().ok().cloned()),
            _ => None,
        })
        .unwrap_or_default()
        .iter()
        .filter_map(|o| o.as_reference().ok())
        .collect();
    {
        let d = doc.get_dictionary_mut(pid).map_err(|e| e.to_string())?;
        for k in [&b"CropBox"[..], b"BleedBox", b"TrimBox", b"ArtBox", b"Rotate", b"Annots", b"Thumb", b"PieceInfo", b"StructParents", b"Group", b"UserUnit"] {
            d.remove(k);
        }
        d.set("MediaBox", vec![0.into(), 0.into(), Object::Real(pw as f32), Object::Real(ph as f32)]);
        d.set("Contents", content_id);
        d.set("Resources", dictionary! { "XObject" => dictionary! { "GmbRd" => img_id }, "Font" => dictionary! { "GmbRdF" => font } });
    }
    // Form fields whose box was on this page leave the form too (their values are text).
    if !gone.is_empty() {
        let ids: Vec<ObjectId> = doc.objects.keys().copied().collect();
        for id in ids {
            if let Ok(d) = doc.get_dictionary_mut(id) {
                for key in [&b"Fields"[..], b"Kids"] {
                    if let Ok(Object::Array(a)) = d.get_mut(key) {
                        a.retain(|o| o.as_reference().map(|r| !gone.contains(&r)).unwrap_or(true));
                    }
                }
                // A field whose widgets were all removed keeps no value: the value can sit on the
                // parent field, not on the widget (review 2, 2.3).
                let emptied = matches!(d.get(b"Kids"), Ok(Object::Array(a)) if a.is_empty());
                if emptied && (d.has(b"T") || d.has(b"FT")) {
                    d.remove(b"V");
                    d.remove(b"DV");
                }
            }
        }
    }
    // The tagged-text tree can repeat a page's words (alternate text); it no longer matches.
    if let Ok(root) = doc.trailer.get(b"Root").and_then(Object::as_reference) {
        if let Ok(cat) = doc.get_dictionary_mut(root) {
            cat.remove(b"StructTreeRoot");
            cat.remove(b"MarkInfo");
            // What can repeat the hidden words elsewhere in the file (review 2, 2.3): the document's
            // XMP metadata, bookmark titles, attached files and named JavaScript, and an XFA form's
            // own copy of the field data.
            cat.remove(b"Metadata");
            cat.remove(b"Outlines");
            cat.remove(b"Names");
            cat.remove(b"PieceInfo");
        }
        let form = doc.get_dictionary(root).ok().and_then(|c| c.get(b"AcroForm").ok().cloned());
        match form {
            Some(Object::Reference(f)) => {
                if let Ok(d) = doc.get_dictionary_mut(f) {
                    d.remove(b"XFA");
                }
            }
            Some(Object::Dictionary(_)) => {
                if let Ok(Object::Dictionary(d)) = doc.get_dictionary_mut(root).and_then(|c| c.get_mut(b"AcroForm")) {
                    d.remove(b"XFA");
                }
            }
            _ => {}
        }
    }
    // The document information (title, subject, keywords, author) may name what was hidden.
    doc.trailer.remove(b"Info");
    doc.prune_objects();
    let mut out = Vec::new();
    doc.save_to(&mut out).map_err(|e| format!("could not write the PDF ({e})"))?;
    Ok(out)
}

// ---------------------------------------------------------------- form fields

fn field_name(doc: &Document, mut id: ObjectId) -> String {
    let mut parts = Vec::new();
    for _ in 0..32 {
        let Ok(d) = doc.get_dictionary(id) else { break };
        if let Ok(t) = d.get(b"T").and_then(Object::as_str) {
            parts.push(String::from_utf8_lossy(t).into_owned());
        }
        match d.get(b"Parent").and_then(Object::as_reference) {
            Ok(p) => id = p,
            Err(_) => break,
        }
    }
    parts.reverse();
    parts.join(".")
}
fn inherited<'a>(doc: &'a Document, mut id: ObjectId, key: &[u8]) -> Option<&'a Object> {
    for _ in 0..32 {
        let d = doc.get_dictionary(id).ok()?;
        if let Ok(v) = d.get(key) {
            return Some(v);
        }
        id = d.get(b"Parent").and_then(Object::as_reference).ok()?;
    }
    None
}

/// Every fillable field (its widgets), as JSON:
/// [{name, kind: "text"|"check"|"choice", value, on, options, page, rect: [x0,y0,x1,y1]}].
#[wasm_bindgen]
pub fn form_fields(bytes: &[u8]) -> Result<String, JsError> {
    let doc = load(bytes)?;
    let mut out = Vec::new();
    for (pi, page) in page_ids(&doc).into_iter().enumerate() {
        let annots: Vec<ObjectId> = match doc.get_dictionary(page).ok().and_then(|d| d.get(b"Annots").ok()) {
            Some(Object::Array(a)) => a.iter().filter_map(|o| o.as_reference().ok()).collect(),
            Some(Object::Reference(r)) => doc.get_object(*r).ok().and_then(|o| o.as_array().ok()).map(|a| a.iter().filter_map(|o| o.as_reference().ok()).collect()).unwrap_or_default(),
            _ => vec![],
        };
        for w in annots {
            let Ok(d) = doc.get_dictionary(w) else { continue };
            if d.get(b"Subtype").and_then(Object::as_name).ok() != Some(b"Widget") {
                continue;
            }
            let ft = inherited(&doc, w, b"FT").and_then(|o| o.as_name().ok()).unwrap_or(b"");
            let flags = inherited(&doc, w, b"Ff").and_then(|o| o.as_i64().ok()).unwrap_or(0);
            let kind = match ft {
                b"Tx" => "text",
                b"Btn" if flags & (1 << 16) == 0 => "check", // not a push button
                b"Ch" => "choice",
                _ => continue,
            };
            let value = match inherited(&doc, w, b"V") {
                Some(Object::String(s, _)) => String::from_utf8_lossy(s).into_owned(),
                Some(Object::Name(n)) => String::from_utf8_lossy(n).into_owned(),
                _ => String::new(),
            };
            // A check box's "on" name: the appearance other than Off.
            let on = d.get(b"AP").ok().and_then(|ap| ap.as_dict().ok()).and_then(|ap| ap.get(b"N").ok()).and_then(|n| match n {
                Object::Dictionary(nd) => Some(nd.clone()),
                Object::Reference(r) => doc.get_dictionary(*r).ok().cloned(),
                _ => None,
            }).and_then(|nd| nd.iter().map(|(k, _)| String::from_utf8_lossy(k).into_owned()).find(|k| k != "Off")).unwrap_or_else(|| "Yes".into());
            let options: Vec<String> = inherited(&doc, w, b"Opt").and_then(|o| o.as_array().ok()).map(|a| a.iter().filter_map(|x| match x {
                Object::String(s, _) => Some(String::from_utf8_lossy(s).into_owned()),
                Object::Array(p) => p.get(1).and_then(|s| s.as_str().ok()).map(|s| String::from_utf8_lossy(s).into_owned()),
                _ => None,
            }).collect()).unwrap_or_default();
            let r = d.get(b"Rect").ok().and_then(|o| o.as_array().ok()).map(|a| a.iter().map(num).collect::<Vec<_>>()).unwrap_or_default();
            if r.len() != 4 {
                continue;
            }
            let opts = options.iter().map(|o| json_str(o)).collect::<Vec<_>>().join(",");
            out.push(format!(
                "{{\"name\":{},\"kind\":\"{kind}\",\"value\":{},\"on\":{},\"options\":[{opts}],\"page\":{pi},\"rect\":[{},{},{},{}]}}",
                json_str(&field_name(&doc, w)), json_str(&value), json_str(&on), r[0].min(r[2]), r[1].min(r[3]), r[0].max(r[2]), r[1].max(r[3])
            ));
        }
    }
    Ok(format!("[{}]", out.join(",")))
}

/// Fills a field by its full name: text and choices get the text, check boxes "on"/"off". Each
/// widget gets an appearance of its own, so the value shows in every PDF reader.
#[wasm_bindgen]
pub fn fill_field(bytes: &[u8], name: &str, value: &str) -> Result<Vec<u8>, JsError> {
    let mut doc = load(bytes)?;
    let mut widgets = Vec::new();
    for page in page_ids(&doc) {
        if let Some(Object::Array(a)) = doc.get_dictionary(page).ok().and_then(|d| d.get(b"Annots").ok()).cloned() {
            for w in a.iter().filter_map(|o| o.as_reference().ok()) {
                if field_name(&doc, w) == name {
                    widgets.push(w);
                }
            }
        }
    }
    if widgets.is_empty() {
        return Err(JsError::new("no such field"));
    }
    let font = doc.add_object(dictionary! { "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica", "Encoding" => "WinAnsiEncoding" });
    for w in widgets {
        let ft = inherited(&doc, w, b"FT").and_then(|o| o.as_name().ok()).unwrap_or(b"").to_vec();
        // The value lives on the field (the widget itself or its parent).
        let holder = if doc.get_dictionary(w).map(|d| d.has(b"T")).unwrap_or(false) { w } else { doc.get_dictionary(w).ok().and_then(|d| d.get(b"Parent").ok()).and_then(|p| p.as_reference().ok()).unwrap_or(w) };
        if ft == b"Btn" {
            let on_name = doc.get_dictionary(w).ok().and_then(|d| d.get(b"AP").ok()).and_then(|ap| ap.as_dict().ok()).and_then(|ap| ap.get(b"N").ok()).and_then(|n| match n {
                Object::Dictionary(nd) => Some(nd.clone()),
                Object::Reference(r) => doc.get_dictionary(*r).ok().cloned(),
                _ => None,
            }).and_then(|nd| nd.iter().map(|(k, _)| k.clone()).find(|k| k != b"Off")).unwrap_or_else(|| b"Yes".to_vec());
            let state = if matches!(value, "on" | "true" | "yes" | "1") { on_name } else { b"Off".to_vec() };
            if let Ok(h) = doc.get_dictionary_mut(holder) {
                h.set("V", Object::Name(state.clone()));
            }
            if let Ok(d) = doc.get_dictionary_mut(w) {
                d.set("AS", Object::Name(state));
            }
            continue;
        }
        let r = doc.get_dictionary(w).ok().and_then(|d| d.get(b"Rect").ok()).and_then(|o| o.as_array().ok()).map(|a| a.iter().map(num).collect::<Vec<_>>()).unwrap_or_default();
        if r.len() != 4 {
            continue;
        }
        let (bw, bh) = ((r[2] - r[0]).abs(), (r[3] - r[1]).abs());
        let size = (bh * 0.62).clamp(6.0, 14.0);
        let multiline = inherited(&doc, w, b"Ff").and_then(|o| o.as_i64().ok()).unwrap_or(0) & (1 << 12) != 0;
        let mut ops = format!("/Tx BMC q 1 1 {} {} re W n BT /Helv {size} Tf 0 g", bw - 2.0, bh - 2.0);
        if multiline {
            ops.push_str(&format!(" {} TL 2 {} Td", size * 1.2, bh - size - 2.0));
            for (i, line) in value.lines().enumerate() {
                ops.push_str(&format!("{} ({}) Tj", if i > 0 { " T*" } else { "" }, pdf_text(line)));
            }
        } else {
            ops.push_str(&format!(" 2 {} Td ({}) Tj", (bh - size) / 2.0 + size * 0.22, pdf_text(value)));
        }
        ops.push_str(" ET Q EMC");
        let ap = doc.add_object(Stream::new(dictionary! { "Type" => "XObject", "Subtype" => "Form", "BBox" => vec![0.into(), 0.into(), bw.into(), bh.into()], "Resources" => dictionary! { "Font" => dictionary! { "Helv" => font } } }, ops.into_bytes()));
        if let Ok(h) = doc.get_dictionary_mut(holder) {
            h.set("V", Object::string_literal(value));
        }
        if let Ok(d) = doc.get_dictionary_mut(w) {
            d.set("AP", dictionary! { "N" => ap });
        }
    }
    save(&mut doc)
}

// ---------------------------------------------------------------- the font a line was written in

/// One of the 14 standard fonts closest to the font that drew `text` on a page (by its name:
/// bold, italic, serif, mono), so an edited line keeps its look. "Helvetica" when unknown.
#[wasm_bindgen]
pub fn font_for_text(bytes: &[u8], index: u32, text: &str) -> String {
    let fallback = "Helvetica".to_owned();
    let Ok(doc) = load(bytes) else { return fallback };
    let Ok(page) = page_at(&doc, index) else { return fallback };
    let Ok(content) = doc.get_and_decode_page_content(page) else { return fallback };
    let fonts = doc.get_page_fonts(page).unwrap_or_default();
    let first = text.split_whitespace().next().unwrap_or("").as_bytes().to_vec();
    if first.is_empty() {
        return fallback;
    }
    let mut cur: Option<Vec<u8>> = None;
    for op in &content.operations {
        match op.operator.as_str() {
            "Tf" => cur = op.operands.first().and_then(|o| o.as_name().ok()).map(|n| n.to_vec()),
            "Tj" | "TJ" | "'" | "\"" => {
                let mut shown = Vec::new();
                for o in &op.operands {
                    match o {
                        Object::String(s, _) => shown.extend_from_slice(s),
                        Object::Array(a) => a.iter().for_each(|x| if let Object::String(s, _) = x { shown.extend_from_slice(s) }),
                        _ => {}
                    }
                }
                if shown.windows(first.len()).any(|w| w == first.as_slice()) {
                    let base = cur.as_ref().and_then(|n| fonts.get(n)).and_then(|f| f.get(b"BaseFont").ok()).and_then(|b| b.as_name().ok()).map(|b| String::from_utf8_lossy(b).to_lowercase()).unwrap_or_default();
                    let bold = ["bold", "black", "heavy", "semibold", "demi"].iter().any(|k| base.contains(k));
                    let italic = base.contains("italic") || base.contains("oblique");
                    let family = if base.contains("times") || base.contains("serif") && !base.contains("sans") || base.contains("georgia") || base.contains("garamond") {
                        "Times"
                    } else if base.contains("courier") || base.contains("mono") || base.contains("consol") {
                        "Courier"
                    } else {
                        "Helvetica"
                    };
                    return match (family, bold, italic) {
                        ("Times", false, false) => "Times-Roman".into(),
                        ("Times", true, false) => "Times-Bold".into(),
                        ("Times", false, true) => "Times-Italic".into(),
                        ("Times", true, true) => "Times-BoldItalic".into(),
                        (f, false, false) => f.to_owned(),
                        (f, true, false) => format!("{f}-Bold"),
                        (f, false, true) => format!("{f}-Oblique"),
                        (f, true, true) => format!("{f}-BoldOblique"),
                    };
                }
            }
            _ => {}
        }
    }
    fallback
}

/// The style of a font dictionary as one of the standard fonts' families: (family, bold, italic).
/// Reads the name (subset prefixes like "ABCDEF+" do not matter) and the font descriptor
/// (weight, the serif and italic flags), also of a composite font's descendant.
fn font_style(doc: &Document, font: &lopdf::Dictionary) -> (&'static str, bool, bool) {
    let deref = |o: &Object| -> Option<lopdf::Dictionary> {
        match o {
            Object::Reference(r) => doc.get_dictionary(*r).ok().cloned(),
            Object::Dictionary(d) => Some(d.clone()),
            _ => None,
        }
    };
    // The embedded program says it best (a printer driver's "CIDFont+F2" with an empty
    // descriptor is still Arial Bold inside).
    if let Some(l) = textedit::program_look(doc, font) {
        return (l.generic, l.bold, l.italic);
    }
    let mut dict = font.clone();
    if let Ok(Object::Array(kids)) = font.get(b"DescendantFonts").map(|o| match o {
        Object::Reference(r) => doc.get_object(*r).cloned().unwrap_or(Object::Null),
        x => x.clone(),
    }) {
        if let Some(d) = kids.first().and_then(deref) {
            dict = d;
        }
    }
    let desc = dict.get(b"FontDescriptor").ok().and_then(deref);
    // A font drawn by the file itself (Type3) is named in its descriptor only.
    let name = font.get(b"BaseFont").or_else(|_| dict.get(b"BaseFont")).or_else(|e| desc.as_ref().map(|d| d.get(b"FontName")).unwrap_or(Err(e))).and_then(|b| b.as_name()).map(|b| String::from_utf8_lossy(b).to_lowercase()).unwrap_or_default();
    let flags = desc.as_ref().and_then(|d| d.get(b"Flags").ok()).and_then(|f| f.as_i64().ok()).unwrap_or(0);
    let weight = desc.as_ref().and_then(|d| d.get(b"FontWeight").ok()).map(num).unwrap_or(0.0);
    let angle = desc.as_ref().and_then(|d| d.get(b"ItalicAngle").ok()).map(num).unwrap_or(0.0);
    let bold = ["bold", "black", "heavy", "semibold", "demi"].iter().any(|k| name.contains(k)) || weight >= 600.0 || flags & 0x40000 != 0;
    let italic = name.contains("italic") || name.contains("oblique") || flags & 0x40 != 0 || angle.abs() > 1.0;
    let serif_name = ["times", "georgia", "garamond", "cambria", "palatino", "book antiqua", "bookman", "century", "minion", "roman", "serif"].iter().any(|k| name.contains(k)) && !name.contains("sans");
    let family = if name.contains("courier") || name.contains("mono") || name.contains("consol") || flags & 0x1 != 0 {
        "Courier"
    } else if serif_name || (flags & 0x2 != 0 && !name.contains("sans") && !name.contains("arial") && !name.contains("helvetica") && !name.contains("calibri")) {
        "Times"
    } else {
        "Helvetica"
    };
    (family, bold, italic)
}

fn standard_name(family: &str, bold: bool, italic: bool) -> String {
    match (family, bold, italic) {
        ("Times", false, false) => "Times-Roman".into(),
        ("Times", true, false) => "Times-Bold".into(),
        ("Times", false, true) => "Times-Italic".into(),
        ("Times", true, true) => "Times-BoldItalic".into(),
        (f, false, false) => f.to_owned(),
        (f, true, false) => format!("{f}-Bold"),
        (f, false, true) => format!("{f}-Oblique"),
        (f, true, true) => format!("{f}-BoldOblique"),
    }
}

/// The standard font closest to the one that draws the text starting at (x, y) on the page
/// (user space, on the baseline): the text showing nearest to the left on that baseline. Works
/// for embedded and subset fonts, where the text in the file is glyph numbers.
#[wasm_bindgen]
pub fn font_at(bytes: &[u8], index: u32, x: f32, y: f32) -> String {
    let fallback = "Helvetica".to_owned();
    let Ok(doc) = load(bytes) else { return fallback };
    let Ok(page) = page_at(&doc, index) else { return fallback };
    let Ok(content) = doc.get_and_decode_page_content(page) else { return fallback };
    let fonts = doc.get_page_fonts(page).unwrap_or_default();
    let (x, y) = (x as f64, y as f64);
    let mut ctm = ID;
    let mut stack: Vec<Mx> = Vec::new();
    let (mut tm, mut tlm) = (ID, ID);
    let (mut font, mut size, mut leading, mut rise) = (Vec::<u8>::new(), 0.0f64, 0.0f64, 0.0f64);
    let mut best: Option<(f64, Vec<u8>)> = None; // (distance to the left, font)
    let nums = |ops: &[Object]| -> Vec<f64> { ops.iter().map(num).collect() };
    for op in &content.operations {
        let o = &op.operands;
        match op.operator.as_str() {
            "q" => stack.push(ctm),
            "Q" => ctm = stack.pop().unwrap_or(ID),
            "cm" if o.len() == 6 => {
                let n = nums(o);
                ctm = mul(&[n[0], n[1], n[2], n[3], n[4], n[5]], &ctm);
            }
            "BT" => {
                tm = ID;
                tlm = ID;
            }
            "Tf" if o.len() == 2 => {
                font = o[0].as_name().map(|n| n.to_vec()).unwrap_or_default();
                size = num(&o[1]);
            }
            "TL" if o.len() == 1 => leading = num(&o[0]),
            "Ts" if o.len() == 1 => rise = num(&o[0]),
            "Td" | "TD" if o.len() == 2 => {
                let n = nums(o);
                if op.operator == "TD" {
                    leading = -n[1];
                }
                tlm = mul(&[1.0, 0.0, 0.0, 1.0, n[0], n[1]], &tlm);
                tm = tlm;
            }
            "Tm" if o.len() == 6 => {
                let n = nums(o);
                tlm = [n[0], n[1], n[2], n[3], n[4], n[5]];
                tm = tlm;
            }
            "T*" | "'" | "\"" | "Tj" | "TJ" => {
                if matches!(op.operator.as_str(), "T*" | "'" | "\"") {
                    tlm = mul(&[1.0, 0.0, 0.0, 1.0, 0.0, -leading], &tlm);
                    tm = tlm;
                }
                if op.operator == "T*" {
                    continue;
                }
                let m = mul(&tm, &ctm);
                let (ox, oy) = apply(&m, 0.0, rise);
                let scale = (m[2] * m[2] + m[3] * m[3]).sqrt().max(1e-6);
                let eff = (size * scale).abs().max(1.0);
                if (oy - y).abs() < eff * 0.4 && ox <= x + eff * 0.3 {
                    let d = x - ox;
                    if best.as_ref().is_none_or(|(bd, _)| d <= *bd) {
                        best = Some((d, font.clone()));
                    }
                }
            }
            _ => {}
        }
    }
    let Some((_, name)) = best else { return fallback };
    let Some(dict) = fonts.get(&name) else { return fallback };
    let (family, bold, italic) = font_style(&doc, dict);
    standard_name(family, bold, italic)
}

/// `add_text` in one of the 14 standard fonts (Helvetica-Bold, Times-Roman, Courier ...).
#[wasm_bindgen]
pub fn add_text_font(bytes: &[u8], index: u32, x: f32, y: f32, size: f32, r: f32, g: f32, b: f32, text: &str, font: &str) -> Result<Vec<u8>, JsError> {
    const STANDARD: [&str; 12] = ["Helvetica", "Helvetica-Bold", "Helvetica-Oblique", "Helvetica-BoldOblique", "Times-Roman", "Times-Bold", "Times-Italic", "Times-BoldItalic", "Courier", "Courier-Bold", "Courier-Oblique", "Courier-BoldOblique"];
    let base = if STANDARD.contains(&font) { font } else { "Helvetica" };
    let mut doc = load(bytes)?;
    let id = page_at(&doc, index)?;
    let fid = doc.add_object(dictionary! { "Type" => "Font", "Subtype" => "Type1", "BaseFont" => base, "Encoding" => "WinAnsiEncoding" });
    let name = format!("GmbF{}", fid.0);
    add_resource(&mut doc, id, "Font", &name, Object::Reference(fid))?;
    let mut ops = format!("{r} {g} {b} rg BT /{name} {size} Tf {lead} TL {x} {y} Td", lead = size * 1.25);
    for (i, line) in text.lines().enumerate() {
        if i > 0 {
            ops.push_str(" T*");
        }
        ops.push_str(&format!(" ({}) Tj", pdf_text(line)));
    }
    ops.push_str(" ET");
    append_content(&mut doc, id, ops)?;
    save(&mut doc)
}

// ---------------------------------------------------------------- making

/// A one-page PDF holding a JPEG (from a photo, a scan, a screenshot converted by the page),
/// the page sized to the image at 72 dpi, or fitted to A4 when `a4` is set.
#[wasm_bindgen]
pub fn jpeg_to_pdf(jpeg: Vec<u8>, w: u32, h: u32, a4: bool) -> Result<Vec<u8>, JsError> {
    let mut doc = Document::with_version("1.7");
    let pages_id = doc.new_object_id();
    let img = doc.add_object(Stream::new(dictionary! { "Type" => "XObject", "Subtype" => "Image", "Width" => w, "Height" => h, "ColorSpace" => "DeviceRGB", "BitsPerComponent" => 8, "Filter" => "DCTDecode" }, jpeg));
    let (pw, ph, dx, dy, dw, dh) = if a4 {
        let (pw, ph) = if w > h { (842.0f32, 595.0f32) } else { (595.0, 842.0) };
        let k = ((pw - 48.0) / w as f32).min((ph - 48.0) / h as f32);
        let (dw, dh) = (w as f32 * k, h as f32 * k);
        (pw, ph, (pw - dw) / 2.0, (ph - dh) / 2.0, dw, dh)
    } else {
        (w as f32, h as f32, 0.0, 0.0, w as f32, h as f32)
    };
    let content = doc.add_object(Stream::new(dictionary! {}, format!("q {dw} 0 0 {dh} {dx} {dy} cm /Im0 Do Q").into_bytes()));
    let page = doc.add_object(dictionary! {
        "Type" => "Page", "Parent" => pages_id, "MediaBox" => vec![0.into(), 0.into(), pw.into(), ph.into()],
        "Resources" => dictionary! { "XObject" => dictionary! { "Im0" => img } }, "Contents" => content,
    });
    doc.objects.insert(pages_id, Object::Dictionary(dictionary! { "Type" => "Pages", "Kids" => vec![page.into()], "Count" => 1 }));
    let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
    doc.trailer.set("Root", catalog);
    save(&mut doc)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Vec<u8> {
        // Two pages, each with a line of text.
        let mut doc = Document::with_version("1.7");
        let pages_id = doc.new_object_id();
        let font = doc.add_object(dictionary! { "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica" });
        let mut kids = vec![];
        for n in 1..=2 {
            let c = doc.add_object(Stream::new(dictionary! {}, format!("BT /F1 24 Tf 72 700 Td (Page {n}) Tj ET").into_bytes()));
            kids.push(Object::Reference(doc.add_object(dictionary! { "Type" => "Page", "Parent" => pages_id, "Contents" => c })));
        }
        doc.objects.insert(pages_id, Object::Dictionary(dictionary! { "Type" => "Pages", "Kids" => kids, "Count" => 2, "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()], "Resources" => dictionary! { "Font" => dictionary! { "F1" => font } } }));
        let cat = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
        doc.trailer.set("Root", cat);
        let mut v = vec![];
        doc.save_to(&mut v).unwrap();
        v
    }
    fn count(b: &[u8]) -> usize {
        Document::load_mem(b).unwrap().get_pages().len()
    }

    #[test]
    fn organise() {
        let s = sample();
        assert_eq!(count(&merge(&s, &s).unwrap()), 4);
        assert_eq!(count(&delete_pages(&s, vec![0]).unwrap()), 1);
        let r = reorder_pages(&s, vec![1, 0]).unwrap();
        let d = Document::load_mem(&r).unwrap();
        let first = d.get_pages()[&1];
        let text = d.get_page_content(first).unwrap();
        assert!(String::from_utf8_lossy(&text).contains("Page 2"));
        let rot = rotate_pages(&s, vec![1], 90).unwrap();
        assert_eq!(page_boxes(&rot).unwrap()[9], 90.0);
        // Inherited MediaBox and Resources survive a merge (they live on the page tree node).
        let m = merge(&s, &s).unwrap();
        assert_eq!(&page_boxes(&m).unwrap()[15..19], &[0.0, 0.0, 612.0, 792.0]);
    }

    #[test]
    fn marking_keeps_a_valid_file() {
        let s = sample();
        let w = watermark(&s, "CONFIDENTIAL", 0.2, 0.8, 0.1, 0.1).unwrap();
        let t = add_text(&w, 0, 72.0, 100.0, 14.0, 0.0, 0.0, 0.0, "Signed by Asha (test)").unwrap();
        let b = add_box(&t, 1, 70.0, 690.0, 120.0, 30.0, 1.0, 0.9, 0.0, 0.4).unwrap();
        let i = add_ink(&b, 1, vec![100.0, 100.0, 150.0, 140.0, 200.0, 100.0], 0.0, 0.2, 0.8, 2.0).unwrap();
        let px = vec![0u8, 0, 0, 255, 255, 255, 255, 0];
        let im = add_image(&i, 0, 300.0, 100.0, 120.0, 40.0, &px, 2, 1).unwrap();
        assert_eq!(count(&im), 2);
        let content = Document::load_mem(&im).unwrap();
        let p1 = content.get_pages()[&1];
        assert!(String::from_utf8_lossy(&content.get_page_content(p1).unwrap()).contains("CONFIDENTIAL"));
    }
}

#[cfg(test)]
mod text_tests {
    #[test]
    fn words_of_the_sample() {
        let b = std::fs::read(std::env::var("GMB_SAMPLE_PDF").unwrap_or_default()).unwrap_or_default();
        if b.is_empty() {
            return;
        }
        let v = super::Viewer::new(b).ok().unwrap();
        let w = v.words(0);
        println!("WORDS {}", &w[..w.len().min(600)]);
        assert!(w.contains("Quarterly"));
    }
}

#[cfg(test)]
mod lock_tests {
    use super::*;
    use lopdf::{EncryptionState, EncryptionVersion, Permissions};

    pub(super) fn page_with(text: &str) -> Vec<u8> {
        let mut doc = Document::with_version("1.7");
        let pages_id = doc.new_object_id();
        let font = doc.add_object(dictionary! { "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica" });
        let c = doc.add_object(Stream::new(dictionary! {}, format!("BT /F1 24 Tf 72 700 Td ({text}) Tj ET").into_bytes()));
        let page = doc.add_object(dictionary! { "Type" => "Page", "Parent" => pages_id, "Contents" => c });
        doc.objects.insert(pages_id, Object::Dictionary(dictionary! { "Type" => "Pages", "Kids" => vec![page.into()], "Count" => 1, "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()], "Resources" => dictionary! { "Font" => dictionary! { "F1" => font } } }));
        let cat = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
        doc.trailer.set("Root", cat);
        let mut v = vec![];
        doc.save_to(&mut v).unwrap();
        v
    }

    /// RC4 128-bit, the lock most older PDFs (bank statements, payslips) carry.
    fn rc4_locked(user: &str, owner: &str) -> Vec<u8> {
        let mut doc = Document::load_mem(&page_with("Secret salary 4200")).unwrap();
        doc.trailer.set("ID", vec![Object::string_literal(b"0123456789abcdef".to_vec()), Object::string_literal(b"0123456789abcdef".to_vec())]);
        let state = EncryptionState::try_from(EncryptionVersion::V2 { document: &doc, owner_password: owner, user_password: user, key_length: 128, permissions: Permissions::PRINTABLE }).unwrap();
        doc.encrypt(&state).unwrap();
        let mut v = vec![];
        doc.save_to(&mut v).unwrap();
        v
    }

    #[test]
    fn a_reader_password_is_asked_and_opens_it() {
        let locked = rc4_locked("open sesame", "boss");
        assert!(!String::from_utf8_lossy(&locked).contains("Secret salary"), "the text is encrypted in the file");
        assert!(needs_password(&locked));
        assert!(unlock_doc(&locked, "wrong").is_err());
        let open = unlock_doc(&locked, "open sesame").unwrap();
        assert!(!needs_password(&open));
        let v = Viewer::new(open.clone()).ok().unwrap();
        assert!(v.words(0).contains("Secret"), "{}", v.words(0));
        // Locked for the reader: not "owner only"; protect() says it has a password already.
        assert!(!owner_locked(&rc4_locked("u", "o")));
        assert!(owner_locked(&rc4_locked("", "o")));
        assert!(protect_doc(&rc4_locked("u", "o"), "new", "", &[7u8; 32]).unwrap_err().contains("already has a password"));
        // The owner password opens it too.
        assert!(unlock_doc(&locked, "boss").is_ok());
        // Once open it edits like any PDF.
        assert!(add_text(&open, 0, 72.0, 100.0, 12.0, 0.0, 0.0, 0.0, "noted").is_ok());
    }

    /// tools/fixtures/locked-rc4.pdf for pdf-check: `GMB_FIXTURE_DIR=tools/fixtures cargo test write_fixture`.
    #[test]
    fn write_fixture() {
        if let Ok(dir) = std::env::var("GMB_FIXTURE_DIR") {
            std::fs::write(std::path::Path::new(&dir).join("locked-rc4.pdf"), rc4_locked("open sesame", "boss")).unwrap();
        }
    }

    #[test]
    fn a_lock_against_changes_only_opens_by_itself() {
        let locked = rc4_locked("", "boss");
        assert!(!needs_password(&locked));
        let open = unlock_doc(&locked, "").unwrap();
        assert!(Viewer::new(open).ok().unwrap().words(0).contains("Secret"));
        // The editing functions open it on their own as well.
        assert!(watermark(&locked, "COPY", 0.2, 0.5, 0.5, 0.5).is_ok());
    }

    #[test]
    fn protect_locks_with_aes_256_and_unlock_reverses_it() {
        let plain = page_with("Board minutes");
        let key = [7u8; 32];
        let locked = protect_doc(&plain, "tiger lily", "", &key).unwrap();
        assert!(String::from_utf8_lossy(&locked).contains("/AESV3"), "AES-256 crypt filter");
        assert!(!String::from_utf8_lossy(&locked).contains("Board minutes"));
        assert!(needs_password(&locked));
        assert!(unlock_doc(&locked, "tiger").is_err());
        let open = unlock_doc(&locked, "tiger lily").unwrap();
        assert!(Viewer::new(open).ok().unwrap().words(0).contains("Board"));
    }
}

#[cfg(test)]
mod arrange_tests {
    use super::*;
    #[test]
    fn a_picture_moves_resizes_and_goes() {
        let one = jpeg_to_pdf(vec![0xFF, 0xD8, 0xFF, 0xD9], 400, 200, true).unwrap();
        let objs = page_objects(&one, 0).unwrap();
        assert_eq!(objs.len(), 6, "one picture: {objs:?}");
        let op = objs[0] as u32;
        let moved = place_object(&one, 0, op, 100.0, 100.0, 300.0, 200.0, false).unwrap();
        let after = page_objects(&moved, 0).unwrap();
        assert_eq!(after.len(), 6);
        for (got, want) in after[2..6].iter().zip([100.0f32, 100.0, 300.0, 200.0]) {
            assert!((got - want).abs() < 0.5, "{after:?}");
        }
        let gone = place_object(&moved, 0, after[0] as u32, 0.0, 0.0, 0.0, 0.0, true).unwrap();
        assert!(page_objects(&gone, 0).unwrap().is_empty());
    }
}

#[cfg(test)]
mod form_tests {
    use super::*;
    /// One page with a text field and a check box.
    fn form_pdf() -> Vec<u8> {
        let mut doc = Document::with_version("1.7");
        let pages_id = doc.new_object_id();
        let page_id = doc.new_object_id();
        let off = doc.add_object(Stream::new(dictionary! { "Type" => "XObject", "Subtype" => "Form", "BBox" => vec![0.into(), 0.into(), 12.into(), 12.into()] }, b"".to_vec()));
        let yes = doc.add_object(Stream::new(dictionary! { "Type" => "XObject", "Subtype" => "Form", "BBox" => vec![0.into(), 0.into(), 12.into(), 12.into()] }, b"0 g 2 2 8 8 re f".to_vec()));
        let name = doc.add_object(dictionary! { "Type" => "Annot", "Subtype" => "Widget", "FT" => "Tx", "T" => Object::string_literal("name"), "Rect" => vec![100.into(), 600.into(), 300.into(), 620.into()], "P" => page_id });
        let agree = doc.add_object(dictionary! { "Type" => "Annot", "Subtype" => "Widget", "FT" => "Btn", "T" => Object::string_literal("agree"), "Rect" => vec![100.into(), 560.into(), 112.into(), 572.into()], "AS" => "Off", "AP" => dictionary! { "N" => dictionary! { "Off" => off, "Yes" => yes } }, "P" => page_id });
        let content = doc.add_object(Stream::new(dictionary! {}, b"".to_vec()));
        doc.objects.insert(page_id, Object::Dictionary(dictionary! { "Type" => "Page", "Parent" => pages_id, "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()], "Contents" => content, "Annots" => vec![name.into(), agree.into()] }));
        doc.objects.insert(pages_id, Object::Dictionary(dictionary! { "Type" => "Pages", "Kids" => vec![page_id.into()], "Count" => 1 }));
        let cat = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id, "AcroForm" => dictionary! { "Fields" => vec![name.into(), agree.into()] } });
        doc.trailer.set("Root", cat);
        let mut v = vec![];
        doc.save_to(&mut v).unwrap();
        v
    }
    #[test]
    fn fields_are_found_and_filled() {
        let f = form_pdf();
        let list = form_fields(&f).unwrap();
        assert!(list.contains("\"name\":\"name\"") && list.contains("\"kind\":\"check\"") && list.contains("\"on\":\"Yes\""), "{list}");
        let a = fill_field(&f, "name", "Asha Verma").unwrap();
        let b = fill_field(&a, "agree", "on").unwrap();
        let after = form_fields(&b).unwrap();
        assert!(after.contains("\"value\":\"Asha Verma\"") && after.contains("\"value\":\"Yes\""), "{after}");
        // The filled value is drawn: the text is in the page's words.
        let v = Viewer::new(b.clone()).ok().unwrap();
        assert!(v.words(0).contains("Asha"), "{}", v.words(0));
        assert!(compress(&b).unwrap().len() <= b.len());
        assert!(!needs_password(&b));
        assert_eq!(unlock(&b, "").unwrap().len() > 0, true);
    }
    #[test]
    fn the_font_of_a_line_is_found() {
        let mut doc = Document::with_version("1.7");
        let pages_id = doc.new_object_id();
        let fb = doc.add_object(dictionary! { "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica-Bold" });
        let c = doc.add_object(Stream::new(dictionary! {}, b"BT /F2 24 Tf 72 700 Td (Quarterly Report) Tj ET".to_vec()));
        let p = doc.add_object(dictionary! { "Type" => "Page", "Parent" => pages_id, "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()], "Contents" => c, "Resources" => dictionary! { "Font" => dictionary! { "F2" => fb } } });
        doc.objects.insert(pages_id, Object::Dictionary(dictionary! { "Type" => "Pages", "Kids" => vec![p.into()], "Count" => 1 }));
        let cat = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
        doc.trailer.set("Root", cat);
        let mut v = vec![];
        doc.save_to(&mut v).unwrap();
        assert_eq!(font_for_text(&v, 0, "Quarterly Report"), "Helvetica-Bold");
        let t = add_text_font(&v, 0, 72.0, 600.0, 24.0, 0.0, 0.0, 0.0, "Annual Summary", "Helvetica-Bold").unwrap();
        assert_eq!(font_for_text(&t, 0, "Annual Summary"), "Helvetica-Bold");
    }
}

#[cfg(test)]
mod redact_tests {
    use super::*;

    fn statement() -> Vec<u8> {
        let mut doc = Document::with_version("1.7");
        let pages_id = doc.new_object_id();
        let font = doc.add_object(dictionary! { "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica" });
        let mut kids = vec![];
        for n in 1..=2 {
            let text = format!("BT /F1 20 Tf 72 700 Td (Name Asha Verma) Tj 0 -40 Td (Account 99887766 page {n}) Tj ET");
            let c = doc.add_object(Stream::new(dictionary! {}, text.into_bytes()));
            kids.push(Object::Reference(doc.add_object(dictionary! { "Type" => "Page", "Parent" => pages_id, "Contents" => c })));
        }
        doc.objects.insert(pages_id, Object::Dictionary(dictionary! { "Type" => "Pages", "Kids" => kids, "Count" => 2, "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()], "Resources" => dictionary! { "Font" => dictionary! { "F1" => font } } }));
        let cat = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
        doc.trailer.set("Root", cat);
        let mut v = vec![];
        doc.save_to(&mut v).unwrap();
        v
    }

    /// Every stream of the file, decompressed, as text: what anyone could pull out of it.
    fn everything(b: &[u8]) -> String {
        let d = Document::load_mem(b).unwrap();
        let mut all = String::from_utf8_lossy(b).into_owned();
        for o in d.objects.values() {
            if let Ok(s) = o.as_stream() {
                all.push_str(&String::from_utf8_lossy(&s.decompressed_content().unwrap_or_else(|_| s.content.clone())));
            }
        }
        all
    }

    #[test]
    fn the_hidden_words_are_gone_from_the_file() {
        let s = statement();
        assert!(everything(&s).contains("99887766"));
        let words = Viewer::new(s.clone()).ok().unwrap().words(0);
        // The account number's box, from the page's own words.
        let at = words.find("\"99887766\"").expect("the number is a word");
        let nums: Vec<f32> = words[at..].split(',').skip(1).take(4).map(|n| n.trim_matches(|c| c == ']' || c == '[').parse().unwrap()).collect();
        let r = redact_doc(&s, 0, &[nums[0] - 1.0, nums[1] - 1.0, nums[2] + 1.0, nums[3] + 1.0]).unwrap();
        // Page 1: the number is nowhere in the file; the other words can still be found.
        let v = Viewer::new(r.clone()).ok().unwrap();
        let p1 = v.words(0);
        assert!(!p1.contains("99887766"), "{p1}");
        assert!(p1.contains("Asha") && p1.contains("Account"), "{p1}");
        // Words stay separate words (not run together).
        assert!(p1.contains("\"Asha\"") && p1.contains("\"Verma\""), "{p1}");
        assert_eq!(v.page_count(), 2);
        // Page 2 is untouched: its own number is still there.
        assert!(v.words(1).contains("99887766"));
        let only_page1 = everything(&r).matches("99887766").count();
        let before = everything(&s).matches("99887766").count();
        assert!(only_page1 < before, "page 1's number must have left the file ({only_page1} vs {before})");
        // The box is black on the page picture.
        let px = v.render(0, 1.0);
        let pw = u32::from_le_bytes(px[0..4].try_into().unwrap()) as usize;
        let (cx, cy) = (((nums[0] + nums[2]) / 2.0) as usize, ((nums[1] + nums[3]) / 2.0) as usize);
        let i = 8 + (cy * pw + cx) * 4;
        assert!(px[i] < 40 && px[i + 1] < 40 && px[i + 2] < 40, "black under the box: {:?}", &px[i..i + 4]);
    }

    #[test]
    fn a_page_with_only_the_number_redacted_keeps_nothing_of_it() {
        // A one-page file: after redaction the number must not exist anywhere at all.
        let mut doc = Document::load_mem(&statement()).unwrap();
        let second = doc.get_pages()[&2];
        let pages = doc.catalog().unwrap().get(b"Pages").unwrap().as_reference().unwrap();
        doc.delete_object(second);
        let first = doc.get_pages()[&1];
        let d = doc.get_dictionary_mut(pages).unwrap();
        d.set("Kids", vec![Object::Reference(first)]);
        d.set("Count", 1);
        doc.prune_objects();
        let mut one = vec![];
        doc.save_to(&mut one).unwrap();
        let words = Viewer::new(one.clone()).ok().unwrap().words(0);
        let at = words.find("\"99887766\"").unwrap();
        let nums: Vec<f32> = words[at..].split(',').skip(1).take(4).map(|n| n.trim_matches(|c| c == ']' || c == '[').parse().unwrap()).collect();
        let r = redact_doc(&one, 0, &[nums[0] - 1.0, nums[1] - 1.0, nums[2] + 1.0, nums[3] + 1.0]).unwrap();
        assert!(!everything(&r).contains("99887766"), "the number is still in the file");
        assert!(everything(&r).contains("Asha"), "the rest stays searchable");
    }
}

#[cfg(test)]
mod font_at_tests {
    use super::*;

    /// Like Word's output: subset fonts, text as glyph numbers (no readable bytes), a flipped
    /// coordinate system and lines placed with Tm.
    fn word_like() -> Vec<u8> {
        let mut doc = Document::with_version("1.7");
        let pages_id = doc.new_object_id();
        let desc_bold = doc.add_object(dictionary! { "Type" => "FontDescriptor", "FontName" => "ABCDEF+TimesNewRomanPS-BoldMT", "Flags" => 34, "FontWeight" => 700, "ItalicAngle" => 0 });
        let desc_reg = doc.add_object(dictionary! { "Type" => "FontDescriptor", "FontName" => "GHIJKL+Calibri", "Flags" => 32, "FontWeight" => 400, "ItalicAngle" => 0 });
        let bold = doc.add_object(dictionary! { "Type" => "Font", "Subtype" => "TrueType", "BaseFont" => "ABCDEF+TimesNewRomanPS-BoldMT", "FontDescriptor" => desc_bold });
        let reg = doc.add_object(dictionary! { "Type" => "Font", "Subtype" => "TrueType", "BaseFont" => "GHIJKL+Calibri", "FontDescriptor" => desc_reg });
        // Flipped: y grows downward, as Word writes it. Title at y=100 from the top (692 up),
        // body at y=140 (652 up), body text beside a bold word on one line at y=180 (612 up).
        let ops = "1 0 0 -1 0 792 cm\n\
            BT /F1 18 Tf 1 0 0 -1 72 100 Tm <00120013> Tj ET\n\
            BT /F2 11 Tf 1 0 0 -1 72 140 Tm <0021> Tj ET\n\
            BT /F2 11 Tf 1 0 0 -1 72 180 Tm <0021> Tj /F1 11 Tf 1 0 0 -1 200 180 Tm <0012> Tj ET";
        let c = doc.add_object(Stream::new(dictionary! {}, ops.as_bytes().to_vec()));
        let page = doc.add_object(dictionary! { "Type" => "Page", "Parent" => pages_id, "Contents" => c, "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()], "Resources" => dictionary! { "Font" => dictionary! { "F1" => bold, "F2" => reg } } });
        doc.objects.insert(pages_id, Object::Dictionary(dictionary! { "Type" => "Pages", "Kids" => vec![page.into()], "Count" => 1 }));
        let cat = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
        doc.trailer.set("Root", cat);
        let mut v = vec![];
        doc.save_to(&mut v).unwrap();
        v
    }

    #[test]
    fn the_font_comes_from_where_the_text_is() {
        let b = word_like();
        assert_eq!(font_at(&b, 0, 72.0, 692.0), "Times-Bold");
        assert_eq!(font_at(&b, 0, 80.0, 652.0), "Helvetica");
        // Same line, two fonts: each word gets its own.
        assert_eq!(font_at(&b, 0, 72.0, 612.0), "Helvetica");
        assert_eq!(font_at(&b, 0, 205.0, 612.0), "Times-Bold");
        // Nothing there: the plain fallback.
        assert_eq!(font_at(&b, 0, 72.0, 300.0), "Helvetica");
    }
}

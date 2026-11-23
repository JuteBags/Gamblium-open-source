//! Our own right-click menu and the gear's quick settings panel (Moonstone spec section 5),
//! replacing Windows' plain menu (owner, Nov 23 2026: "why is the menu so bad looking"). Both are
//! a dark sheet like the browser's own right-click menu: a deep shadow, a near-opaque body, a faint
//! corner tint of the song's colour, a light top edge. Adjusters (looks, choices, steppers, chips,
//! switches, sliders) change the lyrics live and keep the sheet open; actions close it.

use crate::card::{circle, fill, from_px, shade, stroke, to_px, BLUE, GREEN, INK, MOON, RED};
use crate::icons;
use crate::render::{layer, paint_text, rounded, Item, Renderer};
use crate::style::{self, Style, PRESETS};
use cosmic_text::Align;
use serde_json::{json, Value};
use tiny_skia::{Color, GradientStop, LinearGradient, Paint, Pixmap, Point, RadialGradient, SpreadMode, Transform};

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Kind {
    Menu,
    Panel,
}

#[derive(Clone, Debug)]
pub enum Ctl {
    Swatch(&'static str),
    Seg { key: &'static str, value: Value },
    Step { key: &'static str, delta: f64, min: f64, max: f64 },
    /// Click the value to put it back to 0 (timing).
    Zero(&'static str),
    Toggle(&'static str),
    Slider { key: &'static str, min: f32, max: f32 },
    Action(&'static str),
}

/// What the pointer is doing on the sheet.
#[derive(Default, Clone)]
pub struct View {
    pub pointer: Option<(f32, f32)>,
    pub pressed: Option<usize>,
    /// The look swatch under the pointer (its name shows in the head).
    pub hover_look: Option<&'static str>,
}

pub type SheetHits = Vec<([f32; 4], Ctl)>;

const SHEET: (u8, u8, u8) = (0x14, 0x15, 0x1a);
const CTL: (u8, u8, u8) = (0x7f, 0x7f, 0x7f);
const MUTED: (u8, u8, u8) = (0x9d, 0xa1, 0xaa);
const FAINT: (u8, u8, u8) = (0x6f, 0x74, 0x80);
const DARK_INK: (u8, u8, u8) = (0x0d, 0x0e, 0x10);
const GREEN_INK: (u8, u8, u8) = (0xa6, 0xeb, 0xc8);

/// A piece of text to draw once the shapes are done.
struct Text {
    s: String,
    x: f32,
    cy: f32,
    size: f32,
    weight: u16,
    rgb: (u8, u8, u8),
    alpha: f32,
    align: Align,
    width: f32,
    font: &'static str,
}

fn name_of(p: &str) -> String {
    let mut n = p.to_string();
    if let Some(f) = n.get_mut(..1) {
        f.make_ascii_uppercase();
    }
    n
}

/// The key a size / background control drives in this shape.
pub fn size_key(st: &Style) -> &'static str {
    if st.layout == "card" { "card_text_size" } else { "size" }
}
pub fn bg_key(st: &Style) -> &'static str {
    if st.layout == "words" { "halo" } else { "background_opacity" }
}

fn value(st: &Style, key: &str) -> Value {
    serde_json::to_value(st).ok().and_then(|v| v.get(key).cloned()).unwrap_or(Value::Null)
}

/// The sheet's size (before scale) for a kind.
pub fn size(kind: Kind) -> (f32, f32) {
    match kind {
        Kind::Menu => (300.0, 506.0),
        Kind::Panel => (304.0, 400.0),
    }
}

/// Margins round the sheet for its shadow: left / right / top 44, bottom 64.
pub const SIDE: f32 = 44.0;
pub const BOTTOM: f32 = 64.0;

impl Renderer {
    pub fn draw_sheet(&mut self, kind: Kind, st: &Style, mood: Option<(u8, u8, u8)>, view: &View, s: f32) -> (Pixmap, SheetHits) {
        let (sw, sh) = size(kind);
        let (w, h) = (sw * s, sh * s);
        let (m, mb) = (SIDE * s, BOTTOM * s);
        let (pw, ph) = ((w + 2.0 * m) as u32, (h + m + mb) as u32);
        let mut pm = Pixmap::new(pw, ph).expect("size");
        let (uw, uh) = (pw as usize, ph as usize);
        let body = rounded(m, m, w, h, 16.0 * s).expect("sheet");
        // Shadow, body, corner tint, top light, rim.
        let mut px = to_px(&pm);
        shade(&mut px, uw, uh, &body, 30.0 * s, 22.0 * s, (0, 0, 0), 0.60);
        shade(&mut px, uw, uh, &body, 5.0 * s, 3.0 * s, (0, 0, 0), 0.45);
        from_px(&mut pm, &px);
        fill(&mut pm, &body, SHEET, 0.97);
        let tint = mood.unwrap_or(BLUE);
        if let Some(shader) = RadialGradient::new(
            Point::from_xy(m, m),
            Point::from_xy(m, m),
            w * 1.2,
            vec![GradientStop::new(0.0, Color::from_rgba8(tint.0, tint.1, tint.2, 41)), GradientStop::new(0.7, Color::from_rgba8(tint.0, tint.1, tint.2, 0))],
            SpreadMode::Pad,
            Transform::from_row(1.0, 0.0, 0.0, 0.5, 0.0, m * 0.5),
        ) {
            let paint = Paint { shader, anti_alias: true, ..Default::default() };
            pm.fill_path(&body, &paint, tiny_skia::FillRule::Winding, Transform::identity(), None);
        }
        if let Some(shader) = LinearGradient::new(
            Point::from_xy(0.0, m),
            Point::from_xy(0.0, m + 48.0 * s),
            vec![GradientStop::new(0.0, Color::from_rgba8(255, 255, 255, 13)), GradientStop::new(1.0, Color::from_rgba8(255, 255, 255, 0))],
            SpreadMode::Pad,
            Transform::identity(),
        ) {
            let paint = Paint { shader, anti_alias: true, ..Default::default() };
            pm.fill_path(&body, &paint, tiny_skia::FillRule::Winding, Transform::identity(), None);
        }
        if let Some(rim) = rounded(m + 0.5, m + 0.5, w - 1.0, h - 1.0, 15.5 * s) {
            stroke(&mut pm, &rim, (255, 255, 255), 0.11, 1.0, None);
        }

        let mut hits: SheetHits = Vec::new();
        let mut texts: Vec<Text> = Vec::new();
        let mut swatches: Vec<(&'static str, f32, f32, f32)> = Vec::new();
        let hov = |r: [f32; 4]| view.pointer.is_some_and(|(x, y)| x >= r[0] && x < r[0] + r[2] && y >= r[1] && y < r[1] + r[3]);
        let pad = if kind == Kind::Menu { 6.0 } else { 10.0 } * s;
        let x0 = m + pad;
        let inner = w - 2.0 * pad;
        let mut y = m + pad;
        let look_name = view.hover_look.unwrap_or(match PRESETS.iter().find(|p| **p == st.preset) {
            Some(p) => p,
            None => "glass",
        });

        // ---- head
        if kind == Kind::Menu {
            texts.push(Text { s: "Look".into(), x: x0 + 10.0 * s, cy: y + 14.0 * s, size: 12.0 * s, weight: 600, rgb: MUTED, alpha: 1.0, align: Align::Left, width: 60.0 * s, font: "Segoe UI Variable Text" });
            texts.push(Text { s: name_of(look_name), x: x0 + 46.0 * s, cy: y + 14.0 * s, size: 12.0 * s, weight: 600, rgb: INK, alpha: 1.0, align: Align::Left, width: 120.0 * s, font: "Segoe UI Variable Text" });
            texts.push(Text { s: "Ctrl+Alt+P next".into(), x: x0 + inner - 130.0 * s, cy: y + 14.0 * s, size: 11.0 * s, weight: 400, rgb: FAINT, alpha: 1.0, align: Align::Right, width: 120.0 * s, font: "Segoe UI Variable Text" });
            y += 28.0 * s;
        } else {
            texts.push(Text { s: "Quick look".into(), x: x0 + 2.0 * s, cy: y + 15.0 * s, size: 13.5 * s, weight: 600, rgb: INK, alpha: 1.0, align: Align::Left, width: 120.0 * s, font: "Segoe UI Variable Text" });
            texts.push(Text { s: name_of(look_name), x: x0 + 82.0 * s, cy: y + 15.0 * s, size: 12.0 * s, weight: 400, rgb: MUTED, alpha: 1.0, align: Align::Left, width: 120.0 * s, font: "Segoe UI Variable Text" });
            let r = [x0 + inner - 24.0 * s, y + 3.0 * s, 24.0 * s, 24.0 * s];
            if hov(r) {
                if let Some(c) = rounded(r[0], r[1], r[2], r[3], 8.0 * s) {
                    fill(&mut pm, &c, INK, 0.14);
                }
            }
            icons::draw(&mut pm, "close", r[0] + 12.0 * s, r[1] + 12.0 * s, 13.0 * s, MUTED, 1.0);
            hits.push((r, Ctl::Action("dismiss")));
            y += 30.0 * s;
        }

        // ---- swatches
        let tile = if kind == Kind::Menu { 36.0 } else { 35.0 } * s;
        let tgap = (inner - 7.0 * tile) / 6.0;
        for (i, p) in PRESETS.iter().enumerate() {
            let tx = x0 + i as f32 * (tile + tgap);
            let r = [tx, y, tile, tile];
            let look: Style = serde_json::from_value(style::preset(p)).unwrap_or_default();
            let path = rounded(tx, y, tile, tile, 10.0 * s).expect("tile");
            let (a, b) = (style::rgb(&look.swatch_from), style::rgb(&look.swatch_to));
            if let Some(shader) = LinearGradient::new(
                Point::from_xy(tx, y),
                Point::from_xy(tx + tile, y + tile),
                vec![GradientStop::new(0.0, Color::from_rgba8(a.0, a.1, a.2, 255)), GradientStop::new(1.0, Color::from_rgba8(b.0, b.1, b.2, 255))],
                SpreadMode::Pad,
                Transform::identity(),
            ) {
                let paint = Paint { shader, anti_alias: true, ..Default::default() };
                pm.fill_path(&path, &paint, tiny_skia::FillRule::Winding, Transform::identity(), None);
            }
            stroke(&mut pm, &path, (255, 255, 255), if hov(r) { 0.30 } else { 0.12 }, 1.0, None);
            if st.preset == *p {
                if let Some(ring) = rounded(tx - 3.5 * s, y - 3.5 * s, tile + 7.0 * s, tile + 7.0 * s, 13.0 * s) {
                    stroke(&mut pm, &ring, INK, 1.0, 1.5 * s, None);
                }
            }
            swatches.push((p, tx, y, tile));
            hits.push((r, Ctl::Swatch(p)));
        }
        y += tile + if kind == Kind::Menu { 2.0 } else { 4.0 } * s;
        let rule = |pm: &mut Pixmap, y: f32| {
            if let Some(r) = tiny_skia::Rect::from_xywh(x0 + 8.0 * s, y, inner - 16.0 * s, 1.0) {
                fill(pm, &tiny_skia::PathBuilder::from_rect(r), (255, 255, 255), 0.11);
            }
        };
        rule(&mut pm, y + 6.0 * s);
        y += 13.0 * s;

        // ---- rows
        let row_h = if kind == Kind::Menu { 32.0 } else { 34.0 } * s;
        let label_x = if kind == Kind::Menu { x0 + 10.0 * s + 16.0 * s + 11.0 * s } else { x0 + 2.0 * s };
        let ctl_right = x0 + inner - if kind == Kind::Menu { 4.0 } else { 0.0 } * s;
        let mut row = |pm: &mut Pixmap, texts: &mut Vec<Text>, y: &mut f32, icon: &str, label: &str| -> f32 {
            let cy = *y + row_h / 2.0;
            if kind == Kind::Menu && !icon.is_empty() {
                icons::draw(pm, icon, x0 + 10.0 * s + 8.0 * s, cy, 16.0 * s, MUTED, 1.0);
            }
            texts.push(Text { s: label.into(), x: label_x, cy, size: 13.0 * s, weight: 400, rgb: INK, alpha: 1.0, align: Align::Left, width: 160.0 * s, font: "Segoe UI Variable Text" });
            *y += row_h;
            cy
        };

        // Segmented control, right-aligned; returns nothing (hits pushed).
        let seg = |pm: &mut Pixmap, texts: &mut Vec<Text>, hits: &mut SheetHits, cy: f32, key: &'static str, opts: &[(Value, &str, bool)], cur: &Value| {
            let widths: Vec<f32> = opts.iter().map(|(_, l, icon)| if *icon { 34.0 * s } else { (l.chars().count() as f32 * 6.6 * s + 18.0 * s).max(34.0 * s) }).collect();
            let total: f32 = widths.iter().sum::<f32>() + 4.0 * s;
            let tx0 = ctl_right - total;
            if let Some(t) = rounded(tx0, cy - 12.0 * s, total, 24.0 * s, 8.0 * s) {
                fill(pm, &t, CTL, 0.12);
            }
            let mut x = tx0 + 2.0 * s;
            for ((v, label, icon), sw) in opts.iter().zip(widths) {
                let on = v == cur;
                let r = [x, cy - 10.0 * s, sw, 20.0 * s];
                if on {
                    if let Some(t) = rounded(x, cy - 10.0 * s, sw, 20.0 * s, 6.0 * s) {
                        fill(pm, &t, INK, 0.92);
                    }
                } else if hov(r) {
                    if let Some(t) = rounded(x, cy - 10.0 * s, sw, 20.0 * s, 6.0 * s) {
                        fill(pm, &t, INK, 0.10);
                    }
                }
                if *icon {
                    icons::draw(pm, label, x + sw / 2.0, cy, 14.0 * s, if on { DARK_INK } else { MUTED }, 1.0);
                } else {
                    let deva = label.chars().any(|c| ('\u{0900}'..='\u{097F}').contains(&c));
                    texts.push(Text { s: label.to_string(), x, cy, size: 12.0 * s, weight: if on { 600 } else { 400 }, rgb: if on { DARK_INK } else { MUTED }, alpha: 1.0, align: Align::Center, width: sw, font: if deva { "Nirmala UI" } else { "Segoe UI Variable Text" } });
                }
                hits.push((r, Ctl::Seg { key, value: v.clone() }));
                x += sw;
            }
        };
        // Stepper: - value +.
        let step = |pm: &mut Pixmap, texts: &mut Vec<Text>, hits: &mut SheetHits, cy: f32, key: &'static str, delta: f64, min: f64, max: f64, shown: String, zero: bool| {
            let bx1 = ctl_right - 24.0 * s;
            let vx = bx1 - 54.0 * s;
            let bx0 = vx - 24.0 * s;
            for (bx, icon, d) in [(bx0, "minus", -delta), (bx1, "plus", delta)] {
                let r = [bx, cy - 12.0 * s, 24.0 * s, 24.0 * s];
                if let Some(b) = rounded(bx, cy - 12.0 * s, 24.0 * s, 24.0 * s, 8.0 * s) {
                    fill(pm, &b, if hov(r) { INK } else { CTL }, if hov(r) { 0.26 } else { 0.12 });
                }
                icons::draw(pm, icon, bx + 12.0 * s, cy, 12.0 * s, INK, 0.9);
                hits.push((r, Ctl::Step { key, delta: d, min, max }));
            }
            if zero && shown != "0.0 s" {
                // Timing moved: a blue chip, click it to go back to 0.
                if let Some(c) = rounded(vx + 4.0 * s, cy - 10.0 * s, 46.0 * s, 20.0 * s, 10.0 * s) {
                    fill(pm, &c, BLUE, 0.22);
                }
                hits.push(([vx, cy - 10.0 * s, 54.0 * s, 20.0 * s], Ctl::Zero(key)));
                texts.push(Text { s: shown, x: vx, cy, size: 12.0 * s, weight: 500, rgb: (0xc9, 0xd6, 0xec), alpha: 1.0, align: Align::Center, width: 54.0 * s, font: "Segoe UI Variable Text" });
            } else {
                texts.push(Text { s: shown, x: vx, cy, size: 12.0 * s, weight: 500, rgb: if zero { MUTED } else { INK }, alpha: 1.0, align: Align::Center, width: 54.0 * s, font: "Segoe UI Variable Text" });
            }
        };
        // Chips (effects), right-aligned in a row.
        let chips = |pm: &mut Pixmap, texts: &mut Vec<Text>, hits: &mut SheetHits, cy: f32, list: &[(&'static str, &str, bool)], start_x: Option<f32>| {
            let widths: Vec<f32> = list.iter().map(|(_, l, _)| l.chars().count() as f32 * 6.6 * s + 30.0 * s).collect();
            let total: f32 = widths.iter().sum::<f32>() + 6.0 * s * (list.len() as f32 - 1.0);
            let mut x = start_x.unwrap_or(ctl_right - total);
            for ((key, label, on), cw) in list.iter().zip(widths) {
                let r = [x, cy - 13.0 * s, cw, 26.0 * s];
                if let Some(c) = rounded(x, cy - 13.0 * s, cw, 26.0 * s, 13.0 * s) {
                    if *on {
                        fill(pm, &c, GREEN, if hov(r) { 0.24 } else { 0.16 });
                    } else {
                        fill(pm, &c, CTL, if hov(r) { 0.18 } else { 0.10 });
                    }
                }
                if let Some(d) = circle(x + 12.0 * s, cy, 3.0 * s) {
                    if *on {
                        fill(pm, &d, GREEN, 1.0);
                    } else {
                        stroke(pm, &d, FAINT, 1.0, 1.2 * s, None);
                    }
                }
                texts.push(Text { s: label.to_string(), x: x + 20.0 * s, cy, size: 12.0 * s, weight: 500, rgb: if *on { GREEN_INK } else { MUTED }, alpha: 1.0, align: Align::Left, width: cw, font: "Segoe UI Variable Text" });
                hits.push((r, Ctl::Toggle(key)));
                x += cw + 6.0 * s;
            }
        };
        // Switch.
        let switch = |pm: &mut Pixmap, hits: &mut SheetHits, cy: f32, x: f32, key: &'static str, on: bool| {
            let r = [x, cy - 9.0 * s, 30.0 * s, 18.0 * s];
            if let Some(t) = rounded(x, cy - 9.0 * s, 30.0 * s, 18.0 * s, 9.0 * s) {
                fill(pm, &t, if on { GREEN } else { CTL }, if on { 0.38 } else { 0.24 });
            }
            if let Some(k) = circle(x + 9.0 * s + if on { 12.0 * s } else { 0.0 }, cy, 7.0 * s) {
                fill(pm, &k, if on { (0xea, 0xfb, 0xf2) } else { MUTED }, 1.0);
            }
            hits.push((r, Ctl::Toggle(key)));
        };
        // Slider.
        let slider = |pm: &mut Pixmap, hits: &mut SheetHits, cy: f32, x: f32, wdt: f32, key: &'static str, min: f32, max: f32, v: f32, enabled: bool| {
            let f = ((v - min) / (max - min)).clamp(0.0, 1.0);
            let a = if enabled { 1.0 } else { 0.4 };
            if let Some(t) = rounded(x, cy - 2.0 * s, wdt, 4.0 * s, 2.0 * s) {
                fill(pm, &t, CTL, 0.24 * a);
            }
            if let Some(t) = rounded(x, cy - 2.0 * s, wdt * f, 4.0 * s, 2.0 * s) {
                fill(pm, &t, MOON, a);
            }
            let kx = x + wdt * f;
            let mut px = to_px(pm);
            let (uw, uh) = (pm.width() as usize, pm.height() as usize);
            if let Some(k) = circle(kx, cy, 7.0 * s) {
                shade(&mut px, uw, uh, &k, 2.0 * s, 1.0 * s, (0, 0, 0), 0.5 * a);
            }
            from_px(pm, &px);
            if let Some(k) = circle(kx, cy, 11.0 * s) {
                fill(pm, &k, INK, 0.10 * a);
            }
            if let Some(k) = circle(kx, cy, 7.0 * s) {
                fill(pm, &k, (255, 255, 255), a);
            }
            if enabled {
                hits.push(([x - 7.0 * s, cy - 11.0 * s, wdt + 14.0 * s, 22.0 * s], Ctl::Slider { key, min, max }));
            }
        };

        let skey = size_key(st);
        let bkey = bg_key(st);
        let size_v = value(st, skey).as_f64().unwrap_or(24.0);
        let bg_v = value(st, bkey).as_f64().unwrap_or(50.0);
        let hindi = [(json!("hinglish"), "Hinglish", false), (json!("original"), "हिंदी", false), (json!("both"), "Both", false)];
        let lines = [(json!(1), "1", false), (json!(2), "2", false), (json!(3), "3", false)];
        let timing = format!("{:+.1} s", st.offset_ms as f64 / 1000.0).replace("+0.0", "0.0");

        match kind {
            Kind::Menu => {
                let cy = row(&mut pm, &mut texts, &mut y, "card", "Shape");
                seg(&mut pm, &mut texts, &mut hits, cy, "layout", &[(json!("card"), "card", true), (json!("words"), "lyrics", true), (json!("strip"), "box", true)], &json!(st.layout));
                let cy = row(&mut pm, &mut texts, &mut y, "translate", "Hindi songs");
                seg(&mut pm, &mut texts, &mut hits, cy, "script", &hindi, &json!(st.script));
                let cy = row(&mut pm, &mut texts, &mut y, "lines", "Lines");
                seg(&mut pm, &mut texts, &mut hits, cy, "lines", &lines, &json!(st.lines));
                let cy = row(&mut pm, &mut texts, &mut y, "seekbar", "Seek bar under the words");
                switch(&mut pm, &mut hits, cy, ctl_right - 30.0 * s, "words_seek_bar", st.words_seek_bar);
                rule(&mut pm, y + 6.0 * s);
                y += 13.0 * s;
                let cy = row(&mut pm, &mut texts, &mut y, "textsize", "Text size");
                step(&mut pm, &mut texts, &mut hits, cy, skey, 2.0, 14.0, 60.0, format!("{} px", size_v.round()), false);
                let cy = row(&mut pm, &mut texts, &mut y, "background", if bkey == "halo" { "Halo" } else { "Background" });
                step(&mut pm, &mut texts, &mut hits, cy, bkey, 5.0, 0.0, 100.0, format!("{}%", bg_v.round()), false);
                let cy = row(&mut pm, &mut texts, &mut y, "timing", "Timing");
                step(&mut pm, &mut texts, &mut hits, cy, "offset_ms", 500.0, -30000.0, 30000.0, timing, true);
                let cy = y + row_h / 2.0;
                y += row_h;
                chips(&mut pm, &mut texts, &mut hits, cy, &[("glass", "Glass letters", st.glass), ("shine", "Shine", st.shine), ("sparkle", "Sparkles", st.sparkle)], Some(x0 + 10.0 * s));
                rule(&mut pm, y + 6.0 * s);
                y += 13.0 * s;
                // Action rows: hover fill; close turns red.
                for (icon, label, hint, act) in [
                    (if st.click_through { "box_on" } else { "box_off" }, "Click-through", "Ctrl+Alt+L", "through"),
                    ("gear", "All settings", "", "settings"),
                    ("hide", "Hide", "Ctrl+Alt+K", "hide"),
                    ("close", "Close", "", "quit"),
                ] {
                    let r = [x0, y, inner, row_h];
                    let hovered = hov(r);
                    let red = act == "quit" && hovered;
                    if hovered {
                        if let Some(p) = rounded(x0, y, inner, row_h, 10.0 * s) {
                            if red { fill(&mut pm, &p, RED, 0.16) } else { fill(&mut pm, &p, INK, 0.14) }
                        }
                    }
                    let cy = y + row_h / 2.0;
                    icons::draw(&mut pm, icon, x0 + 18.0 * s, cy, 16.0 * s, if red { (0xff, 0x9a, 0xa5) } else if hovered { INK } else { MUTED }, 1.0);
                    texts.push(Text { s: label.into(), x: label_x, cy, size: 13.0 * s, weight: 400, rgb: if red { (0xff, 0xc9, 0xcf) } else { INK }, alpha: 1.0, align: Align::Left, width: 160.0 * s, font: "Segoe UI Variable Text" });
                    if !hint.is_empty() {
                        texts.push(Text { s: hint.into(), x: ctl_right - 120.0 * s, cy, size: 11.0 * s, weight: 400, rgb: FAINT, alpha: 1.0, align: Align::Right, width: 112.0 * s, font: "Segoe UI Variable Text" });
                    }
                    hits.push((r, Ctl::Action(act)));
                    y += row_h;
                }
            }
            Kind::Panel => {
                let label = |texts: &mut Vec<Text>, cy: f32, l: &str| texts.push(Text { s: l.into(), x: label_x, cy, size: 13.0 * s, weight: 400, rgb: INK, alpha: 1.0, align: Align::Left, width: 86.0 * s, font: "Segoe UI Variable Text" });
                let sx = x0 + 96.0 * s;
                let val_w = 40.0 * s;
                let sl_w = inner - 96.0 * s - val_w - 8.0 * s;
                let mut cy = y + row_h / 2.0;
                label(&mut texts, cy, "Text size");
                slider(&mut pm, &mut hits, cy, sx, sl_w, skey, 16.0, 44.0, size_v as f32, true);
                texts.push(Text { s: format!("{} px", size_v.round()), x: ctl_right - val_w, cy, size: 12.0 * s, weight: 500, rgb: MUTED, alpha: 1.0, align: Align::Right, width: val_w, font: "Segoe UI Variable Text" });
                y += row_h;
                cy = y + row_h / 2.0;
                label(&mut texts, cy, if bkey == "halo" { "Halo" } else { "Background" });
                slider(&mut pm, &mut hits, cy, sx, sl_w, bkey, 0.0, 100.0, bg_v as f32, true);
                texts.push(Text { s: format!("{}%", bg_v.round()), x: ctl_right - val_w, cy, size: 12.0 * s, weight: 500, rgb: MUTED, alpha: 1.0, align: Align::Right, width: val_w, font: "Segoe UI Variable Text" });
                y += row_h;
                cy = y + row_h / 2.0;
                label(&mut texts, cy, "Glass letters");
                slider(&mut pm, &mut hits, cy, sx, sl_w - 8.0 * s, "glass_strength", 0.0, 100.0, st.glass_strength, st.glass);
                switch(&mut pm, &mut hits, cy, ctl_right - 30.0 * s, "glass", st.glass);
                y += row_h;
                cy = y + row_h / 2.0;
                label(&mut texts, cy, "Lines");
                seg(&mut pm, &mut texts, &mut hits, cy, "lines", &lines, &json!(st.lines));
                y += row_h;
                cy = y + row_h / 2.0;
                label(&mut texts, cy, "Hindi songs");
                seg(&mut pm, &mut texts, &mut hits, cy, "script", &hindi, &json!(st.script));
                y += row_h;
                cy = y + row_h / 2.0;
                label(&mut texts, cy, "Timing");
                step(&mut pm, &mut texts, &mut hits, cy, "offset_ms", 500.0, -30000.0, 30000.0, timing, true);
                y += row_h;
                cy = y + row_h / 2.0;
                label(&mut texts, cy, "Effects");
                chips(&mut pm, &mut texts, &mut hits, cy, &[("shine", "Shine", st.shine), ("sparkle", "Sparkles", st.sparkle)], None);
                y += row_h + 8.0 * s;
                // Foot: Reset look (quiet) and All settings (primary).
                let bw = (inner - 8.0 * s) / 2.0;
                for (i, (label_s, act)) in [("Reset look", "reset"), ("All settings", "settings")].iter().enumerate() {
                    let bx = x0 + i as f32 * (bw + 8.0 * s);
                    let r = [bx, y, bw, 32.0 * s];
                    if let Some(b) = rounded(bx, y, bw, 32.0 * s, 10.0 * s) {
                        if i == 0 {
                            fill(&mut pm, &b, CTL, if hov(r) { 0.20 } else { 0.12 });
                            stroke(&mut pm, &b, (255, 255, 255), 0.11, 1.0, None);
                        } else {
                            fill(&mut pm, &b, if hov(r) { (255, 255, 255) } else { INK }, 1.0);
                        }
                    }
                    let ink = if i == 0 { INK } else { DARK_INK };
                    texts.push(Text { s: label_s.to_string(), x: bx, cy: y + 16.0 * s - 0.5, size: 13.0 * s, weight: if i == 0 { 500 } else { 600 }, rgb: ink, alpha: 1.0, align: Align::Center, width: bw - if i == 1 { 14.0 * s } else { 0.0 }, font: "Segoe UI Variable Text" });
                    if i == 1 {
                        icons::draw(&mut pm, "out", bx + bw - 26.0 * s, y + 16.0 * s, 13.0 * s, DARK_INK, 1.0);
                    }
                    hits.push((r, Ctl::Action(act)));
                }
            }
        }

        // ---- texts, then the swatches' "Aa" in each look
        let mut px = to_px(&pm);
        for t in texts {
            let st_t = Style { weight: t.weight, italic: false, font: t.font.into(), ..Style::default() };
            let m = self.text_mask_aligned(&t.s, t.size, &st_t, t.width, 0, t.align);
            layer(&mut px, uw, uh, &m, t.x as i64, (t.cy - m.h as f32 / 2.0).round() as i64, |_, _| [t.rgb.0, t.rgb.1, t.rgb.2], t.alpha);
        }
        for (p, tx, ty, tile) in swatches {
            let mut look: Style = serde_json::from_value(style::preset(p)).unwrap_or_default();
            look.glow_radius = look.glow_radius.min(6.0);
            look.outline_width = look.outline_width.min(1.5);
            look.shadow_opacity = look.shadow_opacity.min(50.0);
            look.shadow_blur = look.shadow_blur.min(3.0);
            let pad = 10usize;
            let m = self.text_mask("Aa", 15.0 * s, &look, tile, pad);
            let it = Item { text: String::new(), scale: 1.0, opacity: 1.0, current: false, dy: 0.0 };
            paint_text(&mut px, uw, uh, &m, tx as i64 - pad as i64, (ty + tile / 2.0 - (m.h - 2 * pad) as f32 / 2.0) as i64 - pad as i64, pad, &look, &it, -1.0, s);
        }
        from_px(&mut pm, &px);
        (pm, hits)
    }
}

/// What a click on a control does: the style changes to write, and whether the sheet closes.
pub struct Effect {
    pub changes: Vec<(&'static str, Value)>,
    pub preset: Option<&'static str>,
    pub action: Option<&'static str>,
    pub closes: bool,
}

pub fn apply(ctl: &Ctl, st: &Style, slider_frac: Option<f32>) -> Effect {
    let none = Effect { changes: vec![], preset: None, action: None, closes: false };
    match ctl {
        Ctl::Swatch(p) => Effect { preset: Some(p), ..none },
        Ctl::Seg { key, value } => Effect { changes: vec![(key, value.clone())], ..none },
        Ctl::Step { key, delta, min, max } => {
            let v = value(st, key).as_f64().unwrap_or(0.0);
            let nv = (v + delta).clamp(*min, *max);
            let nv = if *key == "offset_ms" { json!(nv as i64) } else { json!(nv) };
            Effect { changes: vec![(key, nv)], ..none }
        }
        Ctl::Zero(key) => Effect { changes: vec![(key, json!(0))], ..none },
        Ctl::Toggle(key) => {
            let v = value(st, key).as_bool().unwrap_or(false);
            Effect { changes: vec![(key, json!(!v))], ..none }
        }
        Ctl::Slider { key, min, max } => {
            let f = slider_frac.unwrap_or(0.0).clamp(0.0, 1.0);
            Effect { changes: vec![(key, json!((min + (max - min) * f).round()))], ..none }
        }
        Ctl::Action(a) => Effect { action: Some(a), closes: true, ..none },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn both_sheets_draw_and_their_controls_work() {
        let mut r = Renderer::new();
        let st = Style::default();
        for kind in [Kind::Menu, Kind::Panel] {
            let (pm, hits) = r.draw_sheet(kind, &st, Some((200, 120, 90)), &View::default(), 1.0);
            assert!(pm.width() > 300 && hits.len() > 15, "{kind:?}: {} hits", hits.len());
            assert!(hits.iter().any(|(_, c)| matches!(c, Ctl::Swatch("crystal"))));
        }
        let e = apply(&Ctl::Step { key: "offset_ms", delta: 500.0, min: -30000.0, max: 30000.0 }, &st, None);
        assert_eq!(e.changes, vec![("offset_ms", json!(500))]);
        let e = apply(&Ctl::Toggle("glass"), &st, None);
        assert_eq!(e.changes, vec![("glass", json!(true))]);
        let e = apply(&Ctl::Slider { key: "halo", min: 0.0, max: 100.0 }, &st, Some(0.25));
        assert_eq!(e.changes, vec![("halo", json!(25.0))]);
    }
}

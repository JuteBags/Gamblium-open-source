//! The mini player card, "Moonstone" (owner, Nov 23 2026; spec: lyrics-design/SPEC.md section 2).
//! A slab of dark glass lit by the song: the art blurred inside, a light rim on top, a dark hairline
//! outside, a soft glow of the song's colour under it. Three bands: who (art, song, artist, status)
//! / the words / the player bar (transport, rail, times). Window buttons sit in one capsule over
//! the top-right corner while the mouse is over the card; nothing reflows.

use crate::icons;
use crate::render::{blur, layer, over, paint_text, rounded, Item, Mask, Renderer};
use crate::style::{colour_or_mood, rgb, Style};
use cosmic_text::Align;
use tiny_skia::{
    Color, FillRule, FilterQuality, GradientStop, LinearGradient, Mask as Clip, Paint, Pixmap, PixmapPaint, Point, Rect, SpreadMode,
    Stroke, Transform,
};

/// What the card shows in its middle band.
#[derive(Clone, Copy, PartialEq)]
pub enum Stage {
    Lyrics,
    Looking,
    None,
}

pub struct Card<'a> {
    pub title: &'a str,
    pub artist: &'a str,
    pub art: Option<&'a Pixmap>,
    /// A key for the art (its address): the slab is rebuilt when it changes.
    pub art_key: &'a str,
    /// The art's average colour.
    pub mood: Option<(u8, u8, u8)>,
    pub playing: bool,
    pub position_s: f64,
    pub duration_s: f64,
    /// 0-1: how far the hover reveal is (capsule, title fade, rail).
    pub hover: f32,
    /// The mouse, in window pixels, while it is over the window.
    pub pointer: Option<(f32, f32)>,
    /// The button being pressed.
    pub pressed: Option<&'a str>,
    /// The gear's quick settings panel is open.
    pub panel_open: bool,
    pub stage: Stage,
    /// Seconds since the search began (the "looking" sweep).
    pub looking_s: f32,
    /// A compilation: (song number, songs, its name), and its chapter starts as 0-1 of the video.
    pub compilation: Option<(usize, usize, &'a str)>,
    pub notches: &'a [f32],
    /// The shine's position across the current line (-1 = none).
    pub shine: f32,
    /// 0-1 through a sparkle burst, or None.
    pub sparkle: Option<f32>,
}

/// Clickable areas: (x, y, w, h) and what they do.
pub type Hits = Vec<([f32; 4], &'static str)>;

pub(crate) const INK: (u8, u8, u8) = (0xe9, 0xeb, 0xf0);
pub(crate) const MOON: (u8, u8, u8) = (0xc9, 0xce, 0xd8);
pub(crate) const GREEN: (u8, u8, u8) = (0x5a, 0xd6, 0x9a);
pub(crate) const BLUE: (u8, u8, u8) = (0x8f, 0xa3, 0xc4);
pub(crate) const BLUE_INK: (u8, u8, u8) = (0xa9, 0xb9, 0xd6);
pub(crate) const RED: (u8, u8, u8) = (0xff, 0x6b, 0x7a);

pub(crate) fn to_px(pm: &Pixmap) -> Vec<[f32; 4]> {
    pm.data().chunks(4).map(|c| [c[0] as f32 / 255.0, c[1] as f32 / 255.0, c[2] as f32 / 255.0, c[3] as f32 / 255.0]).collect()
}

pub(crate) fn from_px(pm: &mut Pixmap, px: &[[f32; 4]]) {
    for (d, s) in pm.data_mut().chunks_mut(4).zip(px.iter()) {
        for k in 0..4 {
            d[k] = (s[k].clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
        }
    }
}

pub(crate) fn clip_of(w: u32, h: u32, path: &tiny_skia::Path) -> Option<Clip> {
    let mut c = Clip::new(w, h)?;
    c.fill_path(path, FillRule::Winding, true, Transform::identity());
    Some(c)
}

fn mask_of(pm: &Pixmap) -> Mask {
    Mask { w: pm.width() as usize, h: pm.height() as usize, a: pm.data().chunks(4).map(|q| q[3] as f32 / 255.0).collect() }
}

pub(crate) fn time(s: f64) -> String {
    if !s.is_finite() || s < 0.0 {
        return "0:00".into();
    }
    let s = s as u64;
    if s >= 3600 { format!("{}:{:02}:{:02}", s / 3600, (s / 60) % 60, s % 60) } else { format!("{}:{:02}", s / 60, s % 60) }
}

pub(crate) fn fill(pm: &mut Pixmap, path: &tiny_skia::Path, c: (u8, u8, u8), a: f32) {
    let mut paint = Paint::default();
    paint.set_color_rgba8(c.0, c.1, c.2, (a.clamp(0.0, 1.0) * 255.0) as u8);
    paint.anti_alias = true;
    pm.fill_path(path, &paint, FillRule::Winding, Transform::identity(), None);
}

pub(crate) fn stroke(pm: &mut Pixmap, path: &tiny_skia::Path, c: (u8, u8, u8), a: f32, width: f32, clip: Option<&Clip>) {
    let mut paint = Paint::default();
    paint.set_color_rgba8(c.0, c.1, c.2, (a.clamp(0.0, 1.0) * 255.0) as u8);
    paint.anti_alias = true;
    pm.stroke_path(path, &paint, &Stroke { width, ..Default::default() }, Transform::identity(), clip);
}

pub(crate) fn circle(cx: f32, cy: f32, r: f32) -> Option<tiny_skia::Path> {
    tiny_skia::PathBuilder::from_circle(cx, cy, r)
}

/// `art` drawn to cover a w x h box at (x, y), clipped; `soft` shrinks it to a few pixels and
/// stretches it back (a smooth blur).
#[allow(clippy::too_many_arguments)]
fn cover(pm: &mut Pixmap, art: &Pixmap, x: f32, y: f32, w: f32, h: f32, opacity: f32, clip: Option<&Clip>, soft: bool) {
    let src = if soft {
        let (sw, sh) = (14u32, ((14.0 * art.height() as f32 / art.width() as f32).round() as u32).max(6));
        let Some(mut small) = Pixmap::new(sw, sh) else { return };
        let p = PixmapPaint { quality: FilterQuality::Bicubic, ..Default::default() };
        small.draw_pixmap(0, 0, art.as_ref(), &p, Transform::from_scale(sw as f32 / art.width() as f32, sh as f32 / art.height() as f32), None);
        small
    } else {
        art.clone()
    };
    let k = (w / src.width() as f32).max(h / src.height() as f32);
    let dx = x + (w - src.width() as f32 * k) / 2.0;
    let dy = y + (h - src.height() as f32 * k) / 2.0;
    let p = PixmapPaint { opacity, quality: FilterQuality::Bicubic, ..Default::default() };
    pm.draw_pixmap(0, 0, src.as_ref(), &p, Transform::from_row(k, 0.0, 0.0, k, dx, dy), clip);
}

/// Blurs a whole pixmap (all four channels, three box passes), in place.
fn blur_rgba(pm: &mut Pixmap, r: f32) {
    let (w, h) = (pm.width() as usize, pm.height() as usize);
    let mut px = to_px(pm);
    for c in 0..4 {
        let m = Mask { w, h, a: px.iter().map(|p| p[c]).collect() };
        let b = blur(&m, r);
        for (p, v) in px.iter_mut().zip(b.a) {
            p[c] = v;
        }
    }
    from_px(pm, &px);
}

/// A shadow / glow layer from a shape: the shape's mask blurred, moved down by `dy`, in `c` at `a`.
#[allow(clippy::too_many_arguments)]
pub(crate) fn shade(px: &mut [[f32; 4]], w: usize, h: usize, shape: &tiny_skia::Path, r: f32, dy: f32, c: (u8, u8, u8), a: f32) {
    // Only the shape's own neighbourhood is drawn and blurred (a whole-window blur for a small
    // button's shadow made every hover frame costly).
    let b = shape.bounds();
    let reach = (r * 2.0).ceil() + 2.0;
    let (x0, y0) = ((b.left() - reach).floor().max(0.0), (b.top() - reach).floor().max(0.0));
    let (x1, y1) = ((b.right() + reach).ceil().min(w as f32), (b.bottom() + reach).ceil().min(h as f32));
    if x1 <= x0 || y1 <= y0 {
        return;
    }
    let Some(mut sh) = Pixmap::new((x1 - x0) as u32, (y1 - y0) as u32) else { return };
    let mut paint = Paint::default();
    paint.set_color_rgba8(0, 0, 0, 255);
    paint.anti_alias = true;
    sh.fill_path(shape, &paint, FillRule::Winding, Transform::from_translate(-x0, -y0), None);
    let bl = blur(&mask_of(&sh), r);
    layer(px, w, h, &bl, x0 as i64, (y0 + dy).round() as i64, |_, _| [c.0, c.1, c.2], a);
}

/// A mask drawn straight into the picture (premultiplied), touching only its own pixels: the
/// small things drawn every frame (times, chips, the time bubble) no longer convert the whole
/// picture (owner, Nov 23 2026: the overlay must cost next to nothing).
pub(crate) fn layer_pm(pm: &mut Pixmap, m: &Mask, ox: i64, oy: i64, rgb: (u8, u8, u8), a: f32) {
    let (w, h) = (pm.width() as i64, pm.height() as i64);
    let data = pm.data_mut();
    for y in 0..m.h as i64 {
        let ty = oy + y;
        if ty < 0 || ty >= h {
            continue;
        }
        for x in 0..m.w as i64 {
            let tx = ox + x;
            if tx < 0 || tx >= w {
                continue;
            }
            let al = (m.a[(y as usize) * m.w + x as usize] * a).clamp(0.0, 1.0);
            if al <= 0.002 {
                continue;
            }
            let i = ((ty * w + tx) * 4) as usize;
            let inv = 1.0 - al;
            data[i] = (rgb.0 as f32 * al + data[i] as f32 * inv + 0.5) as u8;
            data[i + 1] = (rgb.1 as f32 * al + data[i + 1] as f32 * inv + 0.5) as u8;
            data[i + 2] = (rgb.2 as f32 * al + data[i + 2] as f32 * inv + 0.5) as u8;
            data[i + 3] = (255.0 * al + data[i + 3] as f32 * inv + 0.5) as u8;
        }
    }
}

/// A soft shadow of a shape, drawn straight into the picture (its neighbourhood only).
pub(crate) fn shade_pm(pm: &mut Pixmap, shape: &tiny_skia::Path, r: f32, dy: f32, c: (u8, u8, u8), a: f32) {
    let b = shape.bounds();
    let reach = (r * 2.0).ceil() + 2.0;
    let (x0, y0) = ((b.left() - reach).floor().max(0.0), (b.top() - reach).floor().max(0.0));
    let (x1, y1) = ((b.right() + reach).ceil().min(pm.width() as f32), (b.bottom() + reach).ceil().min(pm.height() as f32));
    if x1 <= x0 || y1 <= y0 {
        return;
    }
    let Some(mut sh) = Pixmap::new((x1 - x0) as u32, (y1 - y0) as u32) else { return };
    let mut paint = Paint::default();
    paint.set_color_rgba8(0, 0, 0, 255);
    paint.anti_alias = true;
    sh.fill_path(shape, &paint, FillRule::Winding, Transform::from_translate(-x0, -y0), None);
    let bl = blur(&mask_of(&sh), r);
    layer_pm(pm, &bl, x0 as i64, (y0 + dy).round() as i64, c, a);
}

/// The rail drawn into the picture: only its own rows are converted.
#[allow(clippy::too_many_arguments)]
pub(crate) fn rail_pm(pm: &mut Pixmap, x0: f32, y0: f32, bw: f32, th: f32, p: f32, from: (u8, u8, u8), to: (u8, u8, u8), track_a: f32, notches: &[f32], s: f32) {
    let (w, h) = (pm.width() as usize, pm.height() as usize);
    let (r0, r1) = ((y0 - 2.0).max(0.0) as usize, ((y0 + th + 2.0) as usize).min(h));
    if r1 <= r0 {
        return;
    }
    let data = pm.data_mut();
    let mut strip: Vec<[f32; 4]> = data[r0 * w * 4..r1 * w * 4].chunks(4).map(|q| [q[0] as f32 / 255.0, q[1] as f32 / 255.0, q[2] as f32 / 255.0, q[3] as f32 / 255.0]).collect();
    rail(&mut strip, w, r1 - r0, x0, y0 - r0 as f32, bw, th, p, from, to, track_a);
    for n in notches {
        let nx = x0 + bw * n;
        for yy in 0..(r1 - r0) {
            for xx in (nx.max(0.0) as usize)..((nx + 2.0 * s) as usize).min(w) {
                over(&mut strip[yy * w + xx], [0.03, 0.04, 0.06], 0.75);
            }
        }
    }
    for (d, q) in data[r0 * w * 4..r1 * w * 4].chunks_mut(4).zip(strip.iter()) {
        for k in 0..4 {
            d[k] = (q[k].clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
        }
    }
}

/// The text's real ink extent: (left, right) columns that hold ink.
pub(crate) fn ink_span(m: &Mask) -> (f32, f32) {
    let (mut lo, mut hi) = (m.w, 0usize);
    for y in 0..m.h {
        for x in 0..m.w {
            if m.a[y * m.w + x] > 0.05 {
                lo = lo.min(x);
                hi = hi.max(x);
            }
        }
    }
    if hi < lo { (0.0, 0.0) } else { (lo as f32, hi as f32) }
}

fn ink_right(m: &Mask) -> f32 {
    ink_span(m).1
}

/// A round button: rest / hover / pressed fills, an icon.
#[allow(clippy::too_many_arguments)]
fn round_button(pm: &mut Pixmap, cx: f32, cy: f32, r: f32, icon: &str, icon_px: f32, fills: (f32, f32, f32), rim: f32, hovered: bool, pressed: bool, s: f32) {
    let r = if pressed { r * 0.92 } else { r };
    if let Some(c) = circle(cx, cy, r) {
        let a = if pressed { fills.2 } else if hovered { fills.1 } else { fills.0 };
        fill(pm, &c, (255, 255, 255), a);
        if rim > 0.0 {
            stroke(pm, &c, (255, 255, 255), rim, 1.0 * s, None);
        }
    }
    icons::draw(pm, icon, cx, cy, icon_px, (255, 255, 255), 0.95);
}

impl Renderer {
    /// The slab and the art: everything that only changes with the song, size or look.
    #[allow(clippy::too_many_arguments)]
    fn slab_layers(&mut self, st: &Style, c: &Card, pw: u32, ph: u32, m: f32, w: f32, h: f32, s: f32) -> Pixmap {
        let key = format!(
            "{pw}x{ph}|{}|{}|{:?}|{}|{}|{}|{}|{}|{}|{}|{}",
            c.art_key,
            c.art.is_some(),
            c.mood,
            st.background,
            st.background_opacity,
            st.art_opacity,
            st.mood_tint,
            st.aura,
            st.aura_color,
            st.corner_radius,
            s
        );
        if let Some((k, pm)) = &self.slab {
            if *k == key {
                return pm.clone();
            }
        }
        let mut pm = Pixmap::new(pw, ph).expect("size");
        let (uw, uh) = (pw as usize, ph as usize);
        let radius = st.corner_radius * s;
        let body = rounded(m, m, w, h, radius).expect("slab");
        let clip = clip_of(pw, ph, &body);
        // 1-3: ambient shadow, contact shadow, the song's colour glowing under it.
        let mut px = to_px(&pm);
        shade(&mut px, uw, uh, &body, 22.0 * s, 18.0 * s, (0, 0, 0), 0.50);
        shade(&mut px, uw, uh, &body, 6.0 * s, 4.0 * s, (0, 0, 0), 0.34);
        if st.aura > 0.0 {
            let aura = if st.aura_color == "mood" { c.mood.unwrap_or(BLUE) } else { rgb(&st.aura_color) };
            if let Some(inner) = rounded(m + 8.0 * s, m + 8.0 * s, w - 16.0 * s, h - 16.0 * s, radius) {
                shade(&mut px, uw, uh, &inner, 27.0 * s, 16.0 * s, aura, st.aura / 100.0);
            }
        }
        from_px(&mut pm, &px);
        // 4-6: base, frost (the art blurred across the slab), the art's colour.
        fill(&mut pm, &body, rgb(&st.background), st.background_opacity / 100.0);
        if let (Some(a), true) = (c.art, st.art_opacity > 0.0) {
            let bleed = 60.0 * s;
            if let Some(mut frost) = Pixmap::new(pw, ph) {
                cover(&mut frost, a, m - bleed, m - bleed, w + 2.0 * bleed, h + 2.0 * bleed, 1.0, None, true);
                blur_rgba(&mut frost, 12.0 * s);
                let p = PixmapPaint { opacity: st.art_opacity / 100.0, ..Default::default() };
                pm.draw_pixmap(0, 0, frost.as_ref(), &p, Transform::identity(), clip.as_ref());
            }
        }
        if let Some(mood) = c.mood {
            fill(&mut pm, &body, mood, st.mood_tint / 100.0 * 0.5);
        }
        // 7-8: sheen from above, footing below (keeps the player bar readable on bright art).
        for (y0, y1, col, a) in [(m, m + h * 0.52, (255u8, 255u8, 255u8), 0.13f32), (m + h, m + h * 0.54, (4, 6, 12), 0.30)] {
            if let Some(shader) = LinearGradient::new(
                Point::from_xy(0.0, y0),
                Point::from_xy(0.0, y1),
                vec![GradientStop::new(0.0, Color::from_rgba8(col.0, col.1, col.2, (a * 255.0) as u8)), GradientStop::new(1.0, Color::from_rgba8(col.0, col.1, col.2, 0))],
                SpreadMode::Pad,
                Transform::identity(),
            ) {
                let paint = Paint { shader, anti_alias: true, ..Default::default() };
                pm.fill_path(&body, &paint, FillRule::Winding, Transform::identity(), None);
            }
        }
        // 9-10: inner rim with a brighter top edge; dark hairline outside.
        if let Some(inner) = rounded(m + 0.5, m + 0.5, w - 1.0, h - 1.0, radius - 0.5) {
            stroke(&mut pm, &inner, (255, 255, 255), 0.13, 1.0, None);
            if let Some(top) = Rect::from_xywh(0.0, 0.0, pw as f32, m + 20.0 * s).and_then(|r| clip_of(pw, ph, &tiny_skia::PathBuilder::from_rect(r))) {
                stroke(&mut pm, &inner, (255, 255, 255), 0.24, 1.0, Some(&top));
            }
        }
        if let Some(outer) = rounded(m - 0.5, m - 0.5, w + 1.0, h + 1.0, radius + 0.5) {
            stroke(&mut pm, &outer, (0, 0, 0), 0.38, 1.0, None);
        }
        // The art: a glow of itself under it, a drop shadow, a fine rim.
        let (ax, ay, asz) = (m + 16.0 * s, m + 16.0 * s, 56.0 * s);
        let art_path = rounded(ax, ay, asz, asz, 12.0 * s).expect("art");
        let mut px = to_px(&pm);
        shade(&mut px, uw, uh, &art_path, 7.0 * s, 6.0 * s, (0, 0, 0), 0.35);
        from_px(&mut pm, &px);
        match c.art {
            Some(a) => {
                if let Some(mut glow) = Pixmap::new(pw, ph) {
                    cover(&mut glow, a, ax - 3.0 * s, ay + 8.0 * s, asz + 6.0 * s, asz + 1.0 * s, 1.0, None, false);
                    blur_rgba(&mut glow, 11.0 * s);
                    pm.draw_pixmap(0, 0, glow.as_ref(), &PixmapPaint { opacity: 0.6, ..Default::default() }, Transform::identity(), None);
                }
                let cl = clip_of(pw, ph, &art_path);
                cover(&mut pm, a, ax, ay, asz, asz, 1.0, cl.as_ref(), false);
            }
            None => {
                fill(&mut pm, &art_path, c.mood.unwrap_or(BLUE), 0.55);
                icons::draw(&mut pm, "note", ax + asz / 2.0, ay + asz / 2.0, 18.0 * s, (255, 255, 255), 0.6);
            }
        }
        if let Some(rim) = rounded(ax + 0.5, ay + 0.5, asz - 1.0, asz - 1.0, 12.0 * s) {
            stroke(&mut pm, &rim, (255, 255, 255), 0.16, 1.0, None);
        }
        self.slab = Some((key, pm.clone()));
        pm
    }

    pub fn draw_card(&mut self, st: &Style, c: &Card, items: &[Item], s: f32) -> (Pixmap, Hits) {
        let m = (44.0 * s).round();
        let w = (st.card_width * s).round().max(320.0 * s);
        let inner = w - 32.0 * s;
        let fx = (st.glow_radius * 2.0 + st.outline_width + st.shadow_blur * 2.0 + st.shadow_x.abs().max(st.shadow_y.abs()) + 10.0) * s;
        let pad = fx.ceil() as usize + 2;
        let size = st.card_text_size * s;
        // Only the current line carries the look; the others are plain.
        let plain = plain_of(st);
        // Glass letters need mass: weight 700 at least (Glass and Minimal are lighter).
        let look = Style { weight: if st.glass { st.weight.max(700) } else { st.weight }, ..st.clone() };
        let masks: Vec<(Mask, &Item)> = if c.stage == Stage::Lyrics {
            items
                .iter()
                .filter(|it| !it.text.trim().is_empty())
                .map(|it| {
                    let style = if it.current { &look } else { &plain };
                    (self.fit_mask(&it.text, size * it.scale, style, inner, pad), it)
                })
                .collect()
        } else {
            Vec::new()
        };
        let gap = 4.0 * s;
        // The stage's height comes from how many lines there are, so the card does not jump.
        let row = |k: f32| (size * k * 1.30).ceil();
        let fixed = match st.lines {
            1 => row(1.0),
            3 => row(0.60) + row(1.0) + row(0.72) + 2.0 * gap,
            _ => row(1.0) + row(0.72) + gap,
        } + if st.script == "both" { row(0.62) } else { 0.0 };
        let stage_h = match c.stage {
            Stage::Lyrics => fixed.max(masks.iter().map(|(mm, _)| (mm.h - 2 * pad) as f32).sum::<f32>() + gap * masks.len().saturating_sub(1) as f32),
            Stage::Looking => 48.0 * s,
            Stage::None => 0.0,
        };
        let h = if c.stage == Stage::None { (72.0 + 12.0 + 36.0 + 14.0) * s } else { 86.0 * s + stage_h + (12.0 + 36.0 + 14.0) * s }.round();
        let (pw, ph) = ((w + 2.0 * m) as u32, (h + 2.0 * m) as u32);
        let (uw, uh) = (pw as usize, ph as usize);
        // The card itself (not its shadow margin): what the mouse must be over for the hover UI.
        let mut hits: Hits = vec![([m, m, w, h], "_body")];
        let hov = |r: [f32; 4]| c.pointer.is_some_and(|(x, y)| x >= r[0] && x < r[0] + r[2] && y >= r[1] && y < r[1] + r[3]);

        // The slab, who and the words change only with the text, the look or an animation: kept,
        // so the once-a-second repaint redraws only the player bar (owner, Nov 23 2026: only the
        // bar and the lyrics change; the rest must cost nothing).
        let skey = format!(
            "{pw}x{ph}|{}|{}|{:?}|{}|{}|{:.2}|{:?}|{:?}|{}|{:.2}|{}|{}|{}",
            c.title,
            c.artist,
            c.stage as u8,
            c.art_key,
            c.art.is_some(),
            c.shine,
            c.sparkle.map(|v| (v * 100.0) as i32),
            c.compilation,
            c.playing,
            c.hover,
            if c.stage == Stage::Looking { (c.looking_s * 30.0) as i32 } else { 0 },
            items.iter().map(|i| format!("{}/{:.2}/{:.1}/{}", i.text, i.opacity, i.dy, i.current)).collect::<Vec<_>>().join("|"),
            serde_json::to_string(st).unwrap_or_default()
        );
        let cached = self.card_static.as_ref().filter(|(k, _)| *k == skey).map(|(_, p)| p.clone());
        let mut pm = match cached {
            Some(p) => p,
            None => {
                let mut pm = self.slab_layers(st, c, pw, ph, m, w, h, s);
                // ---- who: title, artist, status
                let (tx, title_y) = (m + 84.0 * s, m + 20.0 * s);
                let text_end = m + w - 16.0 * s;
                let title_st = Style { weight: 600, italic: false, font: "Segoe UI Variable Display".into(), ..st.clone() };
                let t = self.text_mask_aligned(c.title, 15.5 * s, &title_st, 2000.0 * s, 0, Align::Left);
                // Faded out under the capsule while it shows, and at the card's edge.
                let fade_from = text_end - 24.0 * s - 172.0 * s * c.hover;
                let fade_to = fade_from + 24.0 * s + 16.0 * s * c.hover;
                let sub_st = Style { weight: 500, italic: false, font: "Segoe UI Variable Text".into(), ..st.clone() };
                let a = self.text_mask_aligned(c.artist, 12.5 * s, &sub_st, 2000.0 * s, 0, Align::Left);
                let artist_y = m + 42.0 * s;
                let mut px = to_px(&pm);
                layer(&mut px, uw, uh, &faded_from(&t, tx, fade_from, fade_to), tx as i64, title_y as i64, |_, _| [255, 255, 255], 1.0);
                layer(&mut px, uw, uh, &faded_from(&a, tx, fade_from, fade_to), tx as i64, artist_y as i64, |_, _| [255, 255, 255], 0.68);
                from_px(&mut pm, &px);
                let mut rx = tx + if c.artist.is_empty() { 0.0 } else { ink_right(&a) + 7.0 * s };
                let row_cy = artist_y + a.h as f32 / 2.0;
                // Status dot: green in sync, blue looking, a hollow ring when there are none.
                if let Some(dot) = circle(rx + 3.0 * s, row_cy, 3.0 * s) {
                    match c.stage {
                        Stage::Lyrics => fill(&mut pm, &dot, GREEN, 1.0),
                        Stage::Looking => fill(&mut pm, &dot, BLUE, 1.0),
                        Stage::None => stroke(&mut pm, &dot, (255, 255, 255), 0.4, 1.2 * s, None),
                    }
                }
                rx += 13.0 * s;
                if c.stage == Stage::None {
                    let n = self.text_mask_aligned("no lyrics for this one", 12.5 * s, &sub_st, 400.0 * s, 0, Align::Left);
                    let mut px = to_px(&pm);
                    layer(&mut px, uw, uh, &faded_from(&n, rx, fade_from, fade_to), rx as i64, artist_y as i64, |_, _| [255, 255, 255], 0.45);
                    from_px(&mut pm, &px);
                }
                if let Some((n, of, name)) = c.compilation {
                    rx = self.chip(&mut pm, &format!("{n} of {of}"), rx, row_cy, (255, 255, 255), 0.12, (255, 255, 255), 0.86, s);
                    let nm = self.text_mask_aligned(name, 12.0 * s, &sub_st, 600.0 * s, 0, Align::Left);
                    let mut px = to_px(&pm);
                    layer(&mut px, uw, uh, &faded_from(&nm, rx + 6.0 * s, fade_from, fade_to), (rx + 6.0 * s) as i64, (row_cy - nm.h as f32 / 2.0) as i64, |_, _| [255, 255, 255], 0.45);
                    from_px(&mut pm, &px);
                    rx += 6.0 * s + ink_right(&nm) + 8.0 * s;
                }
                if st.offset_ms != 0 && rx < fade_from - 50.0 * s {
                    let label = format!("{:+.1} s", st.offset_ms as f32 / 1000.0);
                    self.chip(&mut pm, &label, rx, row_cy, BLUE, 0.22, (0xc9, 0xd6, 0xec), 1.0, s);
                }

                // ---- the words
                let stage_y = m + 86.0 * s;
                match c.stage {
                    Stage::Lyrics => {
                        let mut px = to_px(&pm);
                        let mut y = stage_y;
                        let mut current_box = None;
                        for (mm, it) in &masks {
                            let ox = (m + 16.0 * s) as i64 - pad as i64;
                            let oy = (y + it.dy) as i64 - pad as i64;
                            // Paused: the words dim, and nothing moves.
                            let it2 = Item { text: String::new(), scale: it.scale, opacity: it.opacity * if c.playing { 1.0 } else { 0.62 }, current: it.current && c.playing, dy: it.dy };
                            let st_line = if it.current { &look } else { &plain };
                            paint_text(&mut px, uw, uh, mm, ox, oy, pad, st_line, &it2, c.shine, s);
                            if it.current && current_box.is_none() {
                                let (l, r) = ink_span(mm);
                                current_box = Some([ox as f32 + l, y + it.dy, r - l, (mm.h - 2 * pad) as f32]);
                            }
                            y += (mm.h - 2 * pad) as f32 + gap;
                        }
                        if let (true, Some(t), Some(bx), true) = (st.sparkle, c.sparkle, current_box, c.playing) {
                            sparkles(&mut px, uw, uh, bx, st, t, s);
                        }
                        from_px(&mut pm, &px);
                    }
                    Stage::Looking => {
                        // A skeleton bar and a caption; a light sweeps across it (3 passes, then still).
                        let bw = inner * 0.58;
                        let bx = m + 16.0 * s + (inner - bw) / 2.0;
                        let by = stage_y + 2.0 * s;
                        if let Some(bar) = rounded(bx, by, bw, 9.0 * s, 5.0 * s) {
                            fill(&mut pm, &bar, (255, 255, 255), 0.10);
                            let pass = c.looking_s / 1.4;
                            if pass < 3.0 && pass.fract() < 0.64 {
                                let t = pass.fract() / 0.64;
                                let band = bw * 0.32;
                                let centre = bx - band + t * (bw + 2.0 * band);
                                let cl = clip_of(pw, ph, &bar);
                                if let Some(shader) = LinearGradient::new(
                                    Point::from_xy(centre - band / 2.0, 0.0),
                                    Point::from_xy(centre + band / 2.0, 0.0),
                                    vec![
                                        GradientStop::new(0.0, Color::from_rgba8(0xc9, 0xd6, 0xec, 0)),
                                        GradientStop::new(0.5, Color::from_rgba8(0xc9, 0xd6, 0xec, 107)),
                                        GradientStop::new(1.0, Color::from_rgba8(0xc9, 0xd6, 0xec, 0)),
                                    ],
                                    SpreadMode::Pad,
                                    Transform::identity(),
                                ) {
                                    let paint = Paint { shader, anti_alias: true, ..Default::default() };
                                    pm.fill_path(&bar, &paint, FillRule::Winding, Transform::identity(), cl.as_ref());
                                }
                            }
                        }
                        let cap = self.text_mask_aligned("Looking for the words…", 12.0 * s, &sub_st, inner, 0, Align::Center);
                        let mut px = to_px(&pm);
                        layer(&mut px, uw, uh, &cap, (m + 16.0 * s) as i64, (by + 18.0 * s) as i64, |_, _| [BLUE_INK.0, BLUE_INK.1, BLUE_INK.2], 1.0);
                        from_px(&mut pm, &px);
                    }
                    Stage::None => {}
                }

                self.card_static = Some((skey, pm.clone()));
                pm
            }
        };
        // ---- the player bar
        let bar_y = m + h - 50.0 * s;
        let cy = bar_y + 18.0 * s;
        let mut x = m + 16.0 * s;
        for (what, r, hit) in [("prev", 14.0, "prev"), (if c.playing { "pause" } else { "play" }, 18.0, "toggle"), ("next", 14.0, "next")] {
            let rr = r * s;
            let cx = x + rr;
            let rect = [cx - rr, cy - rr, rr * 2.0, rr * 2.0];
            let (hovered, pressed) = (hov(rect), c.pressed == Some(hit));
            if hit == "toggle" && !c.playing {
                // Paused: a solid light pill with a dark play icon.
                let r2 = if pressed { rr * 0.92 } else { rr };
                if let Some(ci) = circle(cx, cy, r2) {
                    shade_pm(&mut pm, &ci, 5.0 * s, 2.0 * s, (0, 0, 0), 0.35);
                }
                if let Some(ci) = circle(cx, cy, r2) {
                    let col = if pressed { (0xd9, 0xdc, 0xe3) } else if hovered { (255, 255, 255) } else { (0xf2, 0xf4, 0xf8) };
                    fill(&mut pm, &ci, col, 1.0);
                }
                icons::draw(&mut pm, "play", cx + 0.5 * s, cy, 15.0 * s, (0x0d, 0x0e, 0x10), 1.0);
            } else if hit == "toggle" {
                round_button(&mut pm, cx, cy, rr, what, 15.0 * s, (0.18, 0.26, 0.32), 0.16, hovered, pressed, s);
            } else {
                round_button(&mut pm, cx, cy, rr, what, 13.0 * s, (0.09, 0.16, 0.24), 0.08, hovered, pressed, s);
            }
            hits.push((rect, hit));
            x = cx + rr + 8.0 * s;
        }
        // Times and rail.
        let ui = Style { weight: 600, italic: false, font: "Segoe UI Variable Text".into(), ..st.clone() };
        let elapsed_x = x - 2.0 * s;
        let total_w = 34.0 * s;
        let rail_x0 = elapsed_x + 30.0 * s + 8.0 * s;
        let rail_x1 = m + w - 16.0 * s - total_w - 8.0 * s;
        let rail_w = (rail_x1 - rail_x0).max(40.0 * s);
        let frac = if c.duration_s > 0.0 { (c.position_s / c.duration_s).clamp(0.0, 1.0) as f32 } else { 0.0 };
        let rail_rect = [rail_x0, cy - 9.0 * s, rail_w, 18.0 * s];
        let over_rail = hov(rail_rect);
        let el = self.text_mask_aligned(&time(c.position_s), 11.5 * s, &ui, 34.0 * s, 0, Align::Right);
        layer_pm(&mut pm, &el, (elapsed_x - 4.0 * s) as i64, (cy - el.h as f32 / 2.0) as i64, (255, 255, 255), 0.80);
        let tot = self.text_mask_aligned(&time(c.duration_s), 11.5 * s, &ui, total_w, 0, Align::Right);
        layer_pm(&mut pm, &tot, (m + w - 16.0 * s - total_w) as i64, (cy - tot.h as f32 / 2.0) as i64, (255, 255, 255), 0.52);
        let th = if over_rail || c.hover > 0.5 { 5.0 * s } else { 3.0 * s };
        let from = if c.playing { colour_or_mood(&st.progress_color, c.mood) } else { MOON };
        let to = if c.playing { colour_or_mood(&st.progress_to, c.mood) } else { MOON };
        rail_pm(&mut pm, rail_x0, cy - th / 2.0, rail_w, th, frac, from, to, 0.18, c.notches, s);
        // The knob only while the mouse is over the card (owner: a plain bar otherwise).
        if over_rail || c.hover > 0.5 {
            if let Some(k) = self.knob(st, s) {
                composite(&mut pm, &k, rail_x0 + rail_w * frac, cy);
            }
        }
        hits.push((rail_rect, "seek"));
        if over_rail {
            if let (Some((px_, _)), true) = (c.pointer, c.duration_s > 0.0) {
                let t = ((px_ - rail_x0) / rail_w).clamp(0.0, 1.0) as f64 * c.duration_s;
                self.bubble(&mut pm, &time(t), px_, cy - 22.0 * s, s);
            }
        }

        // ---- the window buttons: one capsule over the top-right corner
        if c.hover > 0.01 {
            let (cw, chh) = (144.0 * s, 32.0 * s);
            let (cx0, cy0) = (m + w - 12.0 * s - cw, m + 12.0 * s - (1.0 - c.hover) * 4.0 * s);
            // Drawn on a picture its own size (with room for its shadow), then laid on.
            let room = 20.0 * s;
            let mut lp = Pixmap::new((cw + 2.0 * room) as u32, (chh + 2.0 * room) as u32).expect("size");
            let local_ptr = c.pointer.map(|(x, y)| (x - cx0 + room, y - cy0 + room));
            let tools = [("gear", "settings"), (if st.layout == "card" { "lyrics" } else { "card" }, "shape"), ("video", "pip"), ("tab", "tab"), ("close", "close")];
            for (r, h) in self.capsule(&mut lp, room, room, &tools, local_ptr, c.pressed, c.panel_open, s) {
                hits.push(([r[0] + cx0 - room, r[1] + cy0 - room, r[2], r[3]], h));
            }
            pm.draw_pixmap((cx0 - room).round() as i32, (cy0 - room).round() as i32, lp.as_ref(), &PixmapPaint { opacity: c.hover.clamp(0.0, 1.0), ..Default::default() }, Transform::identity(), None);
        }
        (pm, hits)
    }

    /// A dark capsule of round tool buttons at (x0, y0); returns their hit areas.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn capsule(&mut self, pm: &mut Pixmap, x0: f32, y0: f32, tools: &[(&str, &'static str)], pointer: Option<(f32, f32)>, pressed: Option<&str>, panel_open: bool, s: f32) -> Hits {
        let chh = 32.0 * s;
        let cw = 6.0 * s + tools.len() as f32 * 26.0 * s + (tools.len().saturating_sub(1)) as f32 * 2.0 * s;
        let (uw, uh) = (pm.width() as usize, pm.height() as usize);
        if let Some(cap) = rounded(x0, y0, cw, chh, chh / 2.0) {
            shade_pm(pm, &cap, 6.0 * s, 4.0 * s, (0, 0, 0), 0.35);
            fill(pm, &cap, (0x08, 0x0a, 0x10), 0.64);
            stroke(pm, &cap, (255, 255, 255), 0.12, 1.0, None);
        }
        let mut hits = Vec::new();
        let mut bx = x0 + 3.0 * s;
        for (icon, hit) in tools {
            let r = 13.0 * s;
            let (bcx, bcy) = (bx + r, y0 + chh / 2.0);
            let rect = [bcx - r, bcy - r, 2.0 * r, 2.0 * r];
            let hovered = pointer.is_some_and(|(x, y)| x >= rect[0] && x < rect[0] + rect[2] && y >= rect[1] && y < rect[1] + rect[3]);
            let is_pressed = pressed == Some(*hit);
            let active = *hit == "settings" && panel_open;
            if let Some(ci) = circle(bcx, bcy, if is_pressed { r * 0.92 } else { r }) {
                if active {
                    fill(pm, &ci, INK, 0.92);
                } else if *hit == "close" && (hovered || is_pressed) {
                    fill(pm, &ci, RED, if is_pressed { 0.42 } else { 0.30 });
                } else if hovered || is_pressed {
                    fill(pm, &ci, (255, 255, 255), if is_pressed { 0.26 } else { 0.16 });
                }
            }
            let ic = if active { (0x0d, 0x0e, 0x10) } else if *hit == "close" && hovered { (0xff, 0xd9, 0xdd) } else { (255, 255, 255) };
            icons::draw(pm, icon, bcx, bcy, 14.0 * s, ic, if active { 1.0 } else { 0.88 });
            hits.push((rect, *hit));
            bx += 2.0 * r + 2.0 * s;
        }
        hits
    }

    /// A chip: rounded pill with a label; returns the x after it.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn chip(&mut self, pm: &mut Pixmap, label: &str, x: f32, cy: f32, bg: (u8, u8, u8), bga: f32, ink: (u8, u8, u8), inka: f32, s: f32) -> f32 {
        let st = Style { weight: 600, italic: false, font: "Segoe UI Variable Text".into(), ..Style::default() };
        let t = self.text_mask_aligned(label, 11.0 * s, &st, 300.0 * s, 0, Align::Left);
        let tw = ink_right(&t) + 1.0;
        let (cw, chh) = (tw + 14.0 * s, 18.0 * s);
        if let Some(p) = rounded(x, cy - chh / 2.0, cw, chh, chh / 2.0) {
            fill(pm, &p, bg, bga);
        }
        layer_pm(pm, &t, (x + 7.0 * s) as i64, (cy - t.h as f32 / 2.0) as i64, ink, inka);
        x + cw
    }

    /// The time bubble: a small dark pill centred on (cx, cy).
    pub(crate) fn bubble(&mut self, pm: &mut Pixmap, label: &str, cx: f32, cy: f32, s: f32) {
        let st = Style { weight: 500, italic: false, font: "Segoe UI Variable Text".into(), ..Style::default() };
        let t = self.text_mask_aligned(label, 11.0 * s, &st, 200.0 * s, 0, Align::Left);
        let tw = ink_right(&t) + 1.0;
        let (bw, bh) = (tw + 16.0 * s, 20.0 * s);
        let x = (cx - bw / 2.0).max(2.0).min(pm.width() as f32 - bw - 2.0);
        if let Some(p) = rounded(x, cy - bh / 2.0, bw, bh, bh / 2.0) {
            fill(pm, &p, (0x0e, 0x0f, 0x14), 0.94);
            stroke(pm, &p, (255, 255, 255), 0.12, 1.0, None);
        }
        layer_pm(pm, &t, (x + 8.0 * s) as i64, (cy - t.h as f32 / 2.0) as i64, INK, 1.0);
    }
}

/// The plain style of the lines that are not being sung (and of the card's own text).
pub(crate) fn plain_of(st: &Style) -> Style {
    Style {
        glass: false,
        glow_radius: 0.0,
        outline_width: 0.0,
        shine: false,
        weight: 600,
        italic: false,
        gradient_to: None,
        font: "Segoe UI Variable Text".into(),
        shadow_x: 0.0,
        shadow_y: 1.0,
        shadow_blur: 3.0,
        shadow_opacity: 50.0,
        color: "#ffffff".into(),
        ..st.clone()
    }
}

/// A mask that starts at x `at`, faded out between `fade_from` and `fade_to` (window x).
fn faded_from(mm: &Mask, at: f32, fade_from: f32, fade_to: f32) -> Mask {
    Mask {
        w: mm.w,
        h: mm.h,
        a: mm
            .a
            .iter()
            .enumerate()
            .map(|(i, v)| {
                let gx = at + (i % mm.w) as f32;
                v * if gx < fade_from { 1.0 } else if gx > fade_to { 0.0 } else { 1.0 - (gx - fade_from) / (fade_to - fade_from) }
            })
            .collect(),
    }
}

/// The rail: a light track, the played part as a gradient from `from` to `to`, round ends.
#[allow(clippy::too_many_arguments)]
pub(crate) fn rail(px: &mut [[f32; 4]], w: usize, h: usize, x0: f32, y0: f32, bw: f32, th: f32, p: f32, from: (u8, u8, u8), to: (u8, u8, u8), track_a: f32) {
    let r = th / 2.0;
    for yy in (y0.floor().max(0.0) as usize)..((y0 + th).ceil().max(0.0) as usize).min(h) {
        for xx in (x0.floor().max(0.0) as usize)..((x0 + bw).ceil().max(0.0) as usize).min(w) {
            let fx = xx as f32 + 0.5;
            let fy = yy as f32 + 0.5;
            let ex = if fx < x0 + r { x0 + r - fx } else if fx > x0 + bw - r { fx - (x0 + bw - r) } else { 0.0 };
            let ey = (fy - (y0 + r)).abs();
            let cov = (r + 0.5 - (ex * ex + ey * ey).sqrt()).clamp(0.0, 1.0);
            if cov <= 0.0 {
                continue;
            }
            let t = (fx - x0) / bw;
            if t <= p {
                let k = if p > 0.0 { t / p } else { 0.0 };
                let c = [
                    (from.0 as f32 + (to.0 as f32 - from.0 as f32) * k) / 255.0,
                    (from.1 as f32 + (to.1 as f32 - from.1 as f32) * k) / 255.0,
                    (from.2 as f32 + (to.2 as f32 - from.2 as f32) * k) / 255.0,
                ];
                over(&mut px[yy * w + xx], c, cov * 0.96);
            } else {
                over(&mut px[yy * w + xx], [1.0, 1.0, 1.0], cov * track_a);
            }
        }
    }
}

/// A premultiplied picture centred on (cx, cy).
pub(crate) fn composite(pm: &mut Pixmap, k: &Pixmap, cx: f32, cy: f32) {
    let x = (cx - k.width() as f32 / 2.0).round() as i32;
    let y = (cy - k.height() as f32 / 2.0).round() as i32;
    pm.draw_pixmap(x, y, k.as_ref(), &PixmapPaint::default(), Transform::identity(), None);
}

/// A burst of twinkles in a band round the line being sung (never on the letters), at `t` 0-1.
pub(crate) fn sparkles(px: &mut [[f32; 4]], w: usize, h: usize, bx: [f32; 4], st: &Style, t: f32, s: f32) {
    let sc = rgb(&st.sparkle_color);
    let col = [sc.0 as f32 / 255.0, sc.1 as f32 / 255.0, sc.2 as f32 / 255.0];
    let n = (st.sparkle_amount / 2).clamp(2, 12);
    let [x0, y0, bw, bh] = bx;
    for i in 0..n {
        let hsh = |k: u32| ((i.wrapping_mul(2654435761).wrapping_add(k.wrapping_mul(40503))) % 1000) as f32 / 1000.0;
        let side = (hsh(1) * 4.0) as u32;
        let along = hsh(2);
        let out = 3.0 * s + 7.0 * s * hsh(3);
        let (x, y) = match side {
            0 => (x0 + bw * (0.05 + 0.9 * along), y0 - out),
            1 => (x0 + bw * (0.05 + 0.9 * along), y0 + bh + out),
            2 => (x0 - out, y0 + bh * along),
            _ => (x0 + bw + out, y0 + bh * along),
        };
        let start = hsh(4) * 0.3;
        let life = 0.45 + 0.25 * hsh(5);
        let k = ((t - start) / life).clamp(0.0, 1.0);
        let a = (k * std::f32::consts::PI).sin().powi(6);
        if a < 0.02 {
            continue;
        }
        let r = if hsh(6) > 0.5 { 2.6 } else { 1.4 } * s * (0.6 + 0.4 * a);
        let reach = (r * 3.2).ceil() as i64;
        for dy in -reach..=reach {
            for dx in -reach..=reach {
                let (xx, yy) = (x as i64 + dx, y as i64 + dy);
                if xx < 0 || yy < 0 || xx as usize >= w || yy as usize >= h {
                    continue;
                }
                let (fx, fy) = (dx as f32, dy as f32);
                let d = (fx * fx + fy * fy).sqrt();
                let core = (1.0 - d / r).clamp(0.0, 1.0);
                let halo = (1.0 - d / (r * 2.2)).clamp(0.0, 1.0).powi(2) * 0.35;
                let arm = |along: f32, across: f32| if across.abs() < 0.9 { (1.0 - along.abs() / (r * 3.2)).clamp(0.0, 1.0) * 0.8 } else { 0.0 };
                let kk = core.max(halo).max(arm(fx, fy)).max(arm(fy, fx));
                if kk > 0.01 {
                    over(&mut px[yy as usize * w + xx as usize], col, kk * a);
                }
            }
        }
    }
}

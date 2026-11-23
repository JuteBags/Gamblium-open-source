//! Draws the lyrics strip into a see-through picture: background, then per line its shadow,
//! glow, outline and fill (solid or gradient, with an optional shine sweep), then the progress bar.
//! Text is laid out by cosmic-text (any script, with font fallback), so Hindi works too.

use crate::style::{rgb, Style};
use cosmic_text::{Align, Attrs, Buffer, Color, Family, FontSystem, Metrics, Shaping, Style as FStyle, SwashCache, Weight};
use tiny_skia::{FillRule, Paint, PathBuilder, Pixmap, Rect, Transform};

pub struct Item {
    pub text: String,
    /// 1.0 for the current line, smaller for the others.
    pub scale: f32,
    /// 0-1.
    pub opacity: f32,
    /// The line being sung: it gets the shine.
    pub current: bool,
    /// Moved down by this many pixels (a line coming in).
    pub dy: f32,
}

pub struct Renderer {
    fonts: FontSystem,
    cache: SwashCache,
    pending_labels: Vec<(f32, f32, Mask)>,
    /// The person's knob picture and the file time it was read at.
    custom_knob: Option<(Option<std::time::SystemTime>, Option<Pixmap>)>,
    /// The card's slab (shadows, aura, frosted art, rims, the art itself), kept until the song,
    /// size or look changes: its blurs are the costly part of a repaint.
    pub(crate) slab: Option<(String, Pixmap)>,
    masks: Vec<(String, Mask)>,
    /// The card without its player bar, and the words without their bar (see card.rs, words.rs).
    pub(crate) card_static: Option<(String, Pixmap)>,
    pub(crate) words_static: Option<(String, Pixmap)>,
}

#[derive(Clone)]
pub(crate) struct Mask {
    pub(crate) w: usize,
    pub(crate) h: usize,
    pub(crate) a: Vec<f32>,
}

impl Renderer {
    pub fn new() -> Self {
        Renderer { fonts: FontSystem::new(), cache: SwashCache::new(), pending_labels: Vec::new(), custom_knob: None, slab: None, masks: Vec::new(), card_static: None, words_static: None }
    }

    /// One line of text as coverage (0-1), centred in `width`, with `pad` empty pixels all round.
    /// The knob for this look: a built-in shape, or the person's picture (re-read when its file changes).
    pub(crate) fn knob(&mut self, st: &Style, scale: f32) -> Option<Pixmap> {
        let size = st.knob_size.clamp(6.0, 40.0) * scale;
        let custom = if st.knob == "custom" {
            let seen = crate::knob::custom_file().and_then(|f| std::fs::metadata(f).ok()).and_then(|m| m.modified().ok());
            if self.custom_knob.as_ref().map(|c| c.0) != Some(seen) {
                self.custom_knob = Some((seen, crate::knob::load_custom()));
            }
            self.custom_knob.as_ref().and_then(|c| c.1.clone())
        } else {
            None
        };
        crate::knob::draw(&st.knob, size, rgb(&st.knob_color), custom.as_ref()).or_else(|| crate::knob::draw("dot", size, rgb(&st.knob_color), None))
    }

    /// A line kept on one row: drawn smaller (down to 70%) when it would not fit `width`.
    pub(crate) fn fit_mask(&mut self, text: &str, size: f32, st: &Style, width: f32, pad: usize) -> Mask {
        let probe = self.text_mask_aligned(text, size, st, width * 4.0, 0, Align::Left);
        let mut hi = 0usize;
        for y in 0..probe.h {
            for x in (0..probe.w).rev() {
                if probe.a[y * probe.w + x] > 0.05 {
                    hi = hi.max(x);
                    break;
                }
            }
        }
        let k = if hi as f32 > width * 0.98 { (width * 0.98 / hi as f32).max(0.70) } else { 1.0 };
        self.text_mask(text, size * k, st, width, pad)
    }

    pub(crate) fn text_mask(&mut self, text: &str, size: f32, st: &Style, width: f32, pad: usize) -> Mask {
        self.text_mask_aligned(text, size, st, width, pad, Align::Center)
    }

    /// As `text_mask`, aligned left, centre or right in `width`.
    pub(crate) fn text_mask_aligned(&mut self, text: &str, size: f32, st: &Style, width: f32, pad: usize, align: Align) -> Mask {
        // The same lines are drawn every frame: their layouts are kept (a few dozen).
        let key = format!("{text}\u{1}{size}\u{1}{}\u{1}{}\u{1}{}\u{1}{width}\u{1}{pad}\u{1}{:?}", st.font, st.weight, st.italic, align);
        if let Some((_, m)) = self.masks.iter().find(|(k, _)| *k == key) {
            return m.clone();
        }
        let m = self.layout_mask(text, size, st, width, pad, align);
        if self.masks.len() >= 32 {
            self.masks.drain(..16);
        }
        self.masks.push((key, m.clone()));
        m
    }

    fn layout_mask(&mut self, text: &str, size: f32, st: &Style, width: f32, pad: usize, align: Align) -> Mask {
        // Hindi (spec section 8): Nirmala UI chosen outright (Segoe UI Black, Georgia and Cambria
        // have no Devanagari), bold for weights from 600, a little larger, taller lines so the
        // vowel marks and the top line are not clipped, never italic.
        let deva = text.chars().any(|c| ('\u{0900}'..='\u{097F}').contains(&c));
        let (size, lh) = if deva { (size * 1.04, 1.50) } else { (size, 1.28) };
        let (family, weight) = if deva { ("Nirmala UI", if st.weight >= 600 { 700 } else { 400 }) } else { (st.font.as_str(), st.weight) };
        let metrics = Metrics::new(size, size * lh);
        let mut buf = Buffer::new(&mut self.fonts, metrics);
        buf.set_size(&mut self.fonts, Some(width), None);
        let attrs = Attrs::new()
            .family(Family::Name(family))
            .weight(Weight(weight))
            // Italic only for Latin text: the fallback fonts for Indian scripts have no italic, and
            // asking for one left empty boxes.
            .style(if st.italic && !deva && text.chars().all(|c| !c.is_alphabetic() || c.is_ascii_alphabetic() || ('\u{00C0}'..='\u{024F}').contains(&c)) { FStyle::Italic } else { FStyle::Normal });
        buf.set_text(&mut self.fonts, text, attrs, Shaping::Advanced);
        for line in buf.lines.iter_mut() {
            line.set_align(Some(align));
        }
        buf.shape_until_scroll(&mut self.fonts, false);
        let runs = buf.layout_runs().count().max(1);
        let w = width.ceil() as usize + 2 * pad;
        let h = (runs as f32 * size * lh).ceil() as usize + 2 * pad;
        let mut a = vec![0f32; w * h];
        buf.draw(&mut self.fonts, &mut self.cache, Color::rgb(255, 255, 255), |x, y, rw, rh, c| {
            let alpha = c.a() as f32 / 255.0;
            if alpha <= 0.0 {
                return;
            }
            for yy in 0..rh as i32 {
                for xx in 0..rw as i32 {
                    let px = x + xx + pad as i32;
                    let py = y + yy + pad as i32;
                    if px >= 0 && py >= 0 && (px as usize) < w && (py as usize) < h {
                        let i = py as usize * w + px as usize;
                        if alpha > a[i] {
                            a[i] = alpha;
                        }
                    }
                }
            }
        });
        Mask { w, h, a }
    }

    /// The whole strip. `progress` 0-1 (None: no bar); `shine` 0-1 is where the sweep is.
    /// `buttons`: labels drawn as a toolbar row on top (while the mouse is over the strip); their
    /// rectangles (x, y, w, h in pixels) come back with the picture.
    pub fn draw(&mut self, st: &Style, items: &[Item], progress: Option<f32>, shine: f32, scale: f32, buttons: &[&str]) -> (Pixmap, Vec<[f32; 4]>) {
        let pad_in = (18.0 * scale).round();
        let width = (st.width * scale).round().max(200.0);
        let text_w = width - 2.0 * pad_in;
        let fx = (st.glow_radius * 2.0 + st.outline_width + st.shadow_blur * 2.0 + st.shadow_x.abs().max(st.shadow_y.abs())) * scale;
        let pad = fx.ceil() as usize + 2;
        let masks: Vec<(Mask, &Item)> = items
            .iter()
            .filter(|it| !it.text.trim().is_empty())
            .map(|it| (self.text_mask(&it.text, st.size * scale * it.scale, st, text_w, pad), it))
            .collect();
        let gap = 4.0 * scale;
        let content_h: f32 = masks.iter().map(|(m, _)| (m.h - 2 * pad) as f32).sum::<f32>() + gap * (masks.len().saturating_sub(1)) as f32;
        let bar_h = if progress.is_some() { 10.0 * scale } else { 0.0 };
        let tool_h = if buttons.is_empty() { 0.0 } else { 34.0 * scale };
        let height = (content_h + 2.0 * pad_in * 0.75 + bar_h + tool_h).ceil().max(40.0 * scale);
        let mut pm = Pixmap::new(width as u32, height as u32).expect("size");

        // Background.
        // While the toolbar shows, the panel is at least half solid so the buttons read.
        let bg_op = if buttons.is_empty() { st.background_opacity } else { st.background_opacity.max(55.0) };
        if bg_op > 0.0 {
            let (r, g, b) = rgb(&st.background);
            let mut paint = Paint::default();
            paint.set_color_rgba8(r, g, b, (bg_op.clamp(0.0, 100.0) * 2.55) as u8);
            paint.anti_alias = true;
            if let Some(path) = rounded(0.5, 0.5, width - 1.0, height - 1.0, st.corner_radius * scale) {
                pm.fill_path(&path, &paint, FillRule::Winding, Transform::identity(), None);
            }
        }

        // Toolbar: pills along the top right.
        let mut rects = Vec::new();
        if !buttons.is_empty() {
            let bh = 24.0 * scale;
            let mut x = width - 10.0 * scale;
            let mut lab = Vec::new();
            for b in buttons.iter().rev() {
                let m = self.text_mask(b, 13.0 * scale, &Style { weight: 600, italic: false, font: "Segoe UI".into(), ..st.clone() }, 400.0 * scale, 0);
                // The text's real width: the columns that hold ink.
                let (mut lo, mut hi) = (m.w, 0);
                for yy in 0..m.h {
                    for xx in 0..m.w {
                        if m.a[yy * m.w + xx] > 0.05 {
                            lo = lo.min(xx);
                            hi = hi.max(xx);
                        }
                    }
                }
                let tw = if hi >= lo { (hi - lo + 1) as f32 } else { 10.0 };
                let bw = tw + 22.0 * scale;
                x -= bw;
                lab.push((x, bw, m, lo, tw));
                x -= 6.0 * scale;
            }
            for (bx, bw, _, _, _) in &lab {
                let mut paint = Paint::default();
                paint.set_color_rgba8(255, 255, 255, 38);
                paint.anti_alias = true;
                if let Some(path) = rounded(*bx, 8.0 * scale, *bw, bh, bh / 2.0) {
                    pm.fill_path(&path, &paint, FillRule::Winding, Transform::identity(), None);
                }
                rects.push([*bx, 8.0 * scale, *bw, bh]);
            }
            rects.reverse();
            self.pending_labels = lab.into_iter().map(|(bx, bw, m, lo, tw)| (bx + (bw - tw) / 2.0 - lo as f32, 8.0 * scale + (bh - m.h as f32) / 2.0, m)).collect();
        }

        // Lines.
        let mut y = pad_in * 0.75 + tool_h;
        let (w, h) = (pm.width() as usize, pm.height() as usize);
        let mut px: Vec<[f32; 4]> = pm.data().chunks(4).map(|c| [c[0] as f32 / 255.0, c[1] as f32 / 255.0, c[2] as f32 / 255.0, c[3] as f32 / 255.0]).collect();
        for (lx, ly, m) in std::mem::take(&mut self.pending_labels) {
            layer(&mut px, w, h, &m, lx.round() as i64, ly.round() as i64, |_, _| [255, 255, 255], 0.95);
        }
        for (m, it) in &masks {
            let ox = pad_in as i64 - pad as i64;
            let oy = y as i64 - pad as i64;
            paint_text(&mut px, w, h, m, ox, oy, pad, st, it, shine, scale);
            y += (m.h - 2 * pad) as f32 + gap;
        }

        // Progress bar.
        if let Some(p) = progress {
            let inset = (st.corner_radius * scale * 0.8).max(10.0 * scale);
            let bw = width - 2.0 * inset;
            let by = height - 6.0 * scale;
            let knob = if buttons.is_empty() { None } else { self.knob(st, scale) };
            seek_bar(&mut px, w, h, inset, by, bw, p, rgb(&st.progress_color), scale, knob.as_ref());
            // Clickable: the bar and a little around it (the last of the rectangles).
            rects.push([inset, by - 8.0 * scale, bw, 3.0 * scale + 16.0 * scale]);
        }

        for (d, s) in pm.data_mut().chunks_mut(4).zip(px.iter()) {
            for k in 0..4 {
                d[k] = (s[k].clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
            }
        }
        (pm, rects)
    }
}

/// One line of text with the look's effects: shadow, glow, outline, fill (solid or gradient),
/// and the shine band when it is the current line. `m` has `pad` empty pixels all round.
#[allow(clippy::too_many_arguments)]
pub(crate) fn paint_text(px: &mut [[f32; 4]], w: usize, h: usize, m: &Mask, ox: i64, oy: i64, pad: usize, st: &Style, it: &Item, shine: f32, scale: f32) {
    if st.glass && st.weight >= 700 {
        paint_glass(px, w, h, m, ox, oy, pad, st, it, shine, scale);
        return;
    }
    let op = it.opacity * (st.text_opacity / 100.0).clamp(0.0, 1.0);
    // Shadow.
    if st.shadow_opacity > 0.0 {
        let s = blur(m, st.shadow_blur * scale);
        let (r, g, b) = rgb(&st.shadow_color);
        layer(px, w, h, &s, ox + (st.shadow_x * scale) as i64, oy + (st.shadow_y * scale) as i64, |_, _| [r, g, b], op * st.shadow_opacity / 100.0);
    }
    // Glow: two blurs, wide and tight, for a soft bright halo.
    if st.glow_radius > 0.0 && st.glow_strength > 0.0 {
        let (r, g, b) = rgb(&st.glow_color);
        for (rad, k) in [(st.glow_radius, 0.65), (st.glow_radius * 0.4, 0.5)] {
            let mut gm = blur(m, rad * scale);
            for v in gm.a.iter_mut() {
                *v = (*v * st.glow_strength * k * 1.6).min(1.0);
            }
            layer(px, w, h, &gm, ox, oy, |_, _| [r, g, b], op);
        }
    }
    // Outline.
    if st.outline_width > 0.0 {
        let o = dilate(m, (st.outline_width * scale).round() as usize);
        let (r, g, b) = rgb(&st.outline_color);
        layer(px, w, h, &o, ox, oy, |_, _| [r, g, b], op);
    }
    // Fill: solid or a top-to-bottom gradient, plus the shine band on the current line.
    let top = rgb(&st.color);
    let bottom = st.gradient_to.as_deref().map(rgb).unwrap_or(top);
    let shine_rgb = rgb(&st.shine_color);
    let mh = m.h as f32;
    let mw = m.w as f32;
    let band = mw * 0.16;
    let centre = -band + shine * (mw + 2.0 * band);
    let shining = st.shine && it.current && shine >= 0.0;
    layer(px, w, h, m, ox, oy, |x, yy| {
        let t = ((yy as f32 - pad as f32) / (mh - 2.0 * pad as f32)).clamp(0.0, 1.0);
        let mut c = [lerp(top.0, bottom.0, t), lerp(top.1, bottom.1, t), lerp(top.2, bottom.2, t)];
        if shining {
            // Slanted band: x shifted by y, soft edges.
            let d = ((x as f32 + yy as f32 * 0.35) - centre).abs() / band;
            let k = (1.0 - d).clamp(0.0, 1.0);
            let k = k * k * (3.0 - 2.0 * k) * 0.85;
            c = [lerp(c[0], shine_rgb.0, k), lerp(c[1], shine_rgb.1, k), lerp(c[2], shine_rgb.2, k)];
        }
        c
    }, op);
}

/// Glass letters (owner, Nov 23 2026: "the text itself glassy, translucent, glassmorphism with
/// shadows and highlights"). Inside each letter what lies behind it is frosted (blurred and
/// lightened) and tinted with the text colour, so on the card the letters are panes of glass over
/// the song's art; over the desktop they are see-through tinted glass. Then the light: a highlight
/// fading down each letter, a bright rim along its top edges, a soft shade along its bottom edges, a
/// faint outer edge, and a soft drop shadow under it all.
#[allow(clippy::too_many_arguments)]
fn paint_glass(px: &mut [[f32; 4]], w: usize, h: usize, m: &Mask, ox: i64, oy: i64, pad: usize, st: &Style, it: &Item, shine: f32, scale: f32) {
    // Moonstone glass (spec section 4): light from the top-left; the glass has mass.
    let op = it.opacity * (st.text_opacity / 100.0).clamp(0.0, 1.0);
    let k = (st.glass_strength / 100.0).clamp(0.0, 1.0);
    let at = |x: i64, y: i64| -> f32 { if x < 0 || y < 0 || x as usize >= m.w || y as usize >= m.h { 0.0 } else { m.a[y as usize * m.w + x as usize] } };
    // Two drop shadows: contact and ambient.
    layer(px, w, h, &blur(m, 2.0 * scale), ox, oy + (1.0 * scale) as i64, |_, _| [0, 0, 0], op * 0.45);
    layer(px, w, h, &blur(m, 10.0 * scale), ox, oy + (6.0 * scale) as i64, |_, _| [0, 0, 0], op * 0.34);
    // Frost: what lies behind each letter, blurred (each channel, three box passes).
    let (bw, bh) = (m.w, m.h);
    let mut chans: Vec<Vec<f32>> = (0..4).map(|_| vec![0f32; bw * bh]).collect();
    for y in 0..bh {
        for x in 0..bw {
            let (tx, ty) = (ox + x as i64, oy + y as i64);
            if tx >= 0 && ty >= 0 && (tx as usize) < w && (ty as usize) < h {
                let p = px[ty as usize * w + tx as usize];
                for c in 0..4 {
                    chans[c][y * bw + x] = p[c];
                }
            }
        }
    }
    // Nothing behind the letters (lyrics alone over the desktop): no frost to make.
    let (mut raw_cover, mut raw_n) = (0f32, 0f32);
    for i in (0..bw * bh).step_by(3) {
        if m.a[i] > 0.3 {
            raw_cover += chans[3][i];
            raw_n += 1.0;
        }
    }
    // Lyrics alone: milk glass (its own halo ink is under the letters, so the backdrop looks
    // covered but is not something to frost).
    let bare = st.layout == "words" || (raw_n > 0.0 && raw_cover / raw_n < 0.15);
    let r = ((9.0 * scale) / 2.0).round().max(1.0) as usize;
    let mut tmp = vec![0f32; bw * bh];
    if !bare {
        for ch in chans.iter_mut() {
            for _ in 0..3 {
                box_pass(ch, &mut tmp, bw, bh, r, true);
                box_pass(&tmp, ch, bw, bh, r, false);
            }
        }
    }
    // How bright, and how present, the backdrop is under the line (one number each per line).
    let (mut lum, mut cover, mut n) = (0f32, 0f32, 0f32);
    for i in 0..bw * bh {
        if m.a[i] > 0.3 {
            let a = chans[3][i].max(1e-3);
            lum += (0.2126 * chans[0][i] + 0.7152 * chans[1][i] + 0.0722 * chans[2][i]) / a * chans[3][i];
            cover += chans[3][i];
            n += 1.0;
        }
    }
    let (lum, cover) = if n > 0.0 { (lum / n, cover / n) } else { (0.0, 0.0) };
    // Nothing behind it (lyrics alone over the desktop): "milk glass", nearly opaque.
    let milk = bare || cover < 0.3;
    let body = if milk { 0.92 } else { (0.46 + 0.24 * k + (lum - 0.35) * 0.6).clamp(0.40, 0.90) } * op;
    let lift = (0.10 + 0.10 * k) * op;
    // A dark halo hugging the letters on the card (lyrics alone has its own halo ink).
    if !milk {
        let halo = blur(&dilate(m, (1.5 * scale).round().max(1.0) as usize), 5.0 * scale);
        layer(px, w, h, &halo, ox, oy, |_, _| [0, 0, 0], op * 0.34);
    }
    if st.glow_radius > 0.0 && st.glow_strength > 0.0 {
        let (r, g, b) = rgb(&st.glow_color);
        let mut gm = blur(m, st.glow_radius * scale);
        for v in gm.a.iter_mut() {
            *v = (*v * st.glow_strength * 0.9).min(1.0);
        }
        layer(px, w, h, &gm, ox, oy, |_, _| [r, g, b], op * 0.8);
    }
    // The body's colour down the letter, with the gloss line at 0.45-0.48.
    let c0 = rgb(&st.color);
    let c1 = st.gradient_to.as_deref().map(rgb).unwrap_or(c0);
    let mix = |a: (u8, u8, u8), b: (u8, u8, u8), t: f32| (lerp(a.0, b.0, t), lerp(a.1, b.1, t), lerp(a.2, b.2, t));
    let dark = |a: (u8, u8, u8), f: f32| ((a.0 as f32 * f) as u8, (a.1 as f32 * f) as u8, (a.2 as f32 * f) as u8);
    let stops: [(f32, (u8, u8, u8)); 6] = [
        (0.0, (255, 255, 255)),
        (0.30, c0),
        (0.45, mix(c0, c1, 0.35)),
        (0.48, dark(c1, 0.92)),
        (0.80, c1),
        (1.0, mix(c1, (255, 255, 255), 0.4)),
    ];
    let colour_at = |t: f32| {
        for win in stops.windows(2) {
            let ((t0, a), (t1, b)) = (win[0], win[1]);
            if t <= t1 {
                let u = ((t - t0) / (t1 - t0).max(1e-3)).clamp(0.0, 1.0);
                return mix(a, b, u);
            }
        }
        stops[5].1
    };
    let smooth = |e0: f32, e1: f32, x: f32| {
        let u = ((x - e0) / (e1 - e0)).clamp(0.0, 1.0);
        u * u * (3.0 - 2.0 * u)
    };
    let e = 1.2 * scale;
    let (rx, ry) = ((-0.7 * e).round() as i64, (-e).round().min(-1.0) as i64);
    let shade_c = dark(c1, 0.25);
    let mh = m.h as f32;
    let band = m.w as f32 * 0.16;
    let centre = -band + shine * (m.w as f32 + 2.0 * band);
    for y in 0..bh {
        for x in 0..bw {
            let a = m.a[y * bw + x];
            if a <= 0.003 {
                continue;
            }
            let (tx, ty) = (ox + x as i64, oy + y as i64);
            if tx < 0 || ty < 0 || tx as usize >= w || ty as usize >= h {
                continue;
            }
            let d = &mut px[ty as usize * w + tx as usize];
            let i = y * bw + x;
            if !milk {
                let fz = [chans[0][i], chans[1][i], chans[2][i], chans[3][i]];
                for c in 0..4 {
                    d[c] = d[c] * (1.0 - a * op) + fz[c] * a * op;
                }
                over(d, [1.0, 1.0, 1.0], a * lift);
            }
            let t = ((y as f32 - pad as f32) / (mh - 2.0 * pad as f32)).clamp(0.0, 1.0);
            let col = colour_at(t);
            over(d, [col.0 as f32 / 255.0, col.1 as f32 / 255.0, col.2 as f32 / 255.0], a * body);
            // Gloss on the upper part, a faint bounce of light at the bottom.
            let gloss = 0.30 * k * (1.0 - smooth(0.44, 0.50, t));
            let bounce = 0.10 * k * smooth(0.82, 1.0, t);
            over(d, [1.0, 1.0, 1.0], a * (gloss + bounce) * op);
            // Rim of light on the top-left edges; a coloured shade on the bottom-right ones.
            let (xi, yi) = (x as i64, y as i64);
            let rim = (a - at(xi + rx, yi + ry)).clamp(0.0, 1.0);
            let shd = (a - at(xi - rx, yi - ry)).clamp(0.0, 1.0);
            if rim > 0.0 {
                over(d, [1.0, 1.0, 1.0], rim * 0.95 * op);
            }
            if shd > 0.0 {
                over(d, [shade_c.0 as f32 / 255.0, shade_c.1 as f32 / 255.0, shade_c.2 as f32 / 255.0], shd * 0.42 * op);
            }
            if st.shine && it.current && shine >= 0.0 {
                let dd = ((x as f32 + y as f32 * 0.35) - centre).abs() / band;
                let sv = (1.0 - dd).clamp(0.0, 1.0);
                let sv = sv * sv * (3.0 - 2.0 * sv);
                if sv > 0.0 {
                    let sc = rgb(&st.shine_color);
                    over(d, [sc.0 as f32 / 255.0, sc.1 as f32 / 255.0, sc.2 as f32 / 255.0], a * sv * 0.55 * op);
                }
            }
        }
    }
    // The glass's dark outer edge (a white one vanished on light backdrops).
    let grown = dilate(m, 1);
    let ring = Mask { w: m.w, h: m.h, a: grown.a.iter().zip(m.a.iter()).map(|(g, a)| (g - a).max(0.0)).collect() };
    layer(px, w, h, &ring, ox, oy, |_, _| [0x06, 0x08, 0x10], if milk { 0.80 } else { 0.50 } * op);
}

/// The strip's seek bar: a dark edge round a light track, the played part in the look's colour;
/// `knob` (only while the mouse is over the window) centred where the song is.
#[allow(clippy::too_many_arguments)]
pub(crate) fn seek_bar(px: &mut [[f32; 4]], w: usize, h: usize, x0: f32, y0: f32, bw: f32, p: f32, c: (u8, u8, u8), scale: f32, knob: Option<&tiny_skia::Pixmap>) {
    let p = p.clamp(0.0, 1.0);
    let th = (3.0 * scale).max(2.0);
    let col = [c.0 as f32 / 255.0, c.1 as f32 / 255.0, c.2 as f32 / 255.0];
    let (ya, yb) = ((y0 - 1.0).max(0.0) as usize, ((y0 + th + 1.0) as usize).min(h));
    for yy in ya..yb {
        let edge = (yy as f32) < y0 || (yy as f32) >= y0 + th;
        for xx in (x0.max(0.0) as usize)..((x0 + bw) as usize).min(w) {
            let d = &mut px[yy * w + xx];
            if edge {
                over(d, [0.0, 0.0, 0.0], 0.28);
            } else if (xx as f32 - x0) / bw <= p {
                over(d, col, 0.96);
            } else {
                over(d, [1.0, 1.0, 1.0], 0.26);
            }
        }
    }
    if let Some(k) = knob {
        let (kx, ky) = (x0 + bw * p, y0 + th / 2.0);
        let (ox, oy) = ((kx - k.width() as f32 / 2.0).round() as i64, (ky - k.height() as f32 / 2.0).round() as i64);
        for (i, q) in k.data().chunks(4).enumerate() {
            if q[3] == 0 {
                continue;
            }
            let (x, y) = (ox + (i as u32 % k.width()) as i64, oy + (i as u32 / k.width()) as i64);
            if x < 0 || y < 0 || x as usize >= w || y as usize >= h {
                continue;
            }
            let d = &mut px[y as usize * w + x as usize];
            let a = q[3] as f32 / 255.0;
            for ch in 0..3 {
                d[ch] = q[ch] as f32 / 255.0 + d[ch] * (1.0 - a);
            }
            d[3] = a + d[3] * (1.0 - a);
        }
    }
}

pub(crate) fn lerp(a: u8, b: u8, t: f32) -> u8 {
    (a as f32 + (b as f32 - a as f32) * t).round() as u8
}

/// Premultiplied "over".
pub(crate) fn over(dst: &mut [f32; 4], rgb: [f32; 3], a: f32) {
    let a = a.clamp(0.0, 1.0);
    for k in 0..3 {
        dst[k] = rgb[k] * a + dst[k] * (1.0 - a);
    }
    dst[3] = a + dst[3] * (1.0 - a);
}

pub(crate) fn layer(px: &mut [[f32; 4]], w: usize, h: usize, m: &Mask, ox: i64, oy: i64, colour: impl Fn(usize, usize) -> [u8; 3], op: f32) {
    for yy in 0..m.h {
        let ty = oy + yy as i64;
        if ty < 0 || ty as usize >= h {
            continue;
        }
        for xx in 0..m.w {
            let a = m.a[yy * m.w + xx] * op;
            if a <= 0.002 {
                continue;
            }
            let tx = ox + xx as i64;
            if tx < 0 || tx as usize >= w {
                continue;
            }
            let c = colour(xx, yy);
            over(&mut px[ty as usize * w + tx as usize], [c[0] as f32 / 255.0, c[1] as f32 / 255.0, c[2] as f32 / 255.0], a);
        }
    }
}

/// Three box blurs: close to a Gaussian of about `r` pixels.
/// A cheap fingerprint of a mask's contents (size and a sample of its pixels).
fn fingerprint(m: &Mask, salt: u64) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325 ^ salt;
    let mut mix = |v: u64| {
        h ^= v;
        h = h.wrapping_mul(0x100000001b3);
    };
    mix(m.w as u64);
    mix(m.h as u64);
    let step = (m.a.len() / 4096).max(1);
    for (i, v) in m.a.iter().enumerate().step_by(step) {
        mix(((*v * 4096.0) as u64) ^ i as u64);
    }
    mix(m.a.iter().map(|v| (*v * 255.0) as u64).sum::<u64>());
    h
}

thread_local! {
    /// Blurs and dilations of text that has not changed are reused from frame to frame
    /// (lyrics-only redid every halo each frame: 13-48 ms a frame, Nov 23 2026).
    static MEMO: std::cell::RefCell<Vec<(u64, Mask)>> = const { std::cell::RefCell::new(Vec::new()) };
}

fn memo(key: u64, make: impl FnOnce() -> Mask) -> Mask {
    if let Some(m) = MEMO.with(|c| c.borrow().iter().find(|(k, _)| *k == key).map(|(_, m)| m.clone())) {
        return m;
    }
    let m = make();
    MEMO.with(|c| {
        let mut c = c.borrow_mut();
        if c.len() >= 16 {
            c.drain(..8);
        }
        c.push((key, m.clone()));
    });
    m
}

pub(crate) fn blur(m: &Mask, r: f32) -> Mask {
    // Small masks are quicker to blur than to look up.
    if m.a.len() < 20_000 {
        return blur_now(m, r);
    }
    memo(fingerprint(m, 0x6b1 ^ (r * 64.0) as u64), || blur_now(m, r))
}

fn blur_now(m: &Mask, r: f32) -> Mask {
    let mut out = Mask { w: m.w, h: m.h, a: m.a.clone() };
    let k = (r / 2.0).round() as usize;
    if k == 0 {
        return out;
    }
    let mut tmp = vec![0f32; out.a.len()];
    for _ in 0..3 {
        box_pass(&out.a, &mut tmp, m.w, m.h, k, true);
        box_pass(&tmp, &mut out.a, m.w, m.h, k, false);
    }
    out
}

fn box_pass(src: &[f32], dst: &mut [f32], w: usize, h: usize, k: usize, horizontal: bool) {
    let (n, lines) = if horizontal { (w, h) } else { (h, w) };
    let at = |line: usize, i: usize| if horizontal { line * w + i } else { i * w + line };
    let div = (2 * k + 1) as f32;
    for line in 0..lines {
        let mut sum = 0f32;
        for i in 0..=k.min(n - 1) {
            sum += src[at(line, i)];
        }
        for i in 0..n {
            dst[at(line, i)] = sum / div;
            if i + k + 1 < n {
                sum += src[at(line, i + k + 1)];
            }
            if i >= k {
                sum -= src[at(line, i - k)];
            }
        }
    }
}

pub(crate) fn dilate_pub(m: &Mask, r: usize) -> Mask {
    dilate(m, r)
}

/// Grows the text by `r` pixels (for the outline).
fn dilate(m: &Mask, r: usize) -> Mask {
    if m.a.len() < 20_000 {
        return dilate_now(m, r);
    }
    memo(fingerprint(m, 0xd11 ^ (r as u64) << 8), || dilate_now(m, r))
}

fn dilate_now(m: &Mask, r: usize) -> Mask {
    let (w, h) = (m.w, m.h);
    let mut tmp = vec![0f32; w * h];
    for y in 0..h {
        for x in 0..w {
            let mut v = 0f32;
            for xx in x.saturating_sub(r)..(x + r + 1).min(w) {
                v = v.max(m.a[y * w + xx]);
            }
            tmp[y * w + x] = v;
        }
    }
    let mut out = vec![0f32; w * h];
    for y in 0..h {
        for x in 0..w {
            let mut v = 0f32;
            for yy in y.saturating_sub(r)..(y + r + 1).min(h) {
                v = v.max(tmp[yy * w + x]);
            }
            out[y * w + x] = v;
        }
    }
    Mask { w, h, a: out }
}

pub(crate) fn rounded(x: f32, y: f32, w: f32, h: f32, r: f32) -> Option<tiny_skia::Path> {
    let r = r.min(w / 2.0).min(h / 2.0).max(0.0);
    if r == 0.0 {
        return Some(PathBuilder::from_rect(Rect::from_xywh(x, y, w, h)?));
    }
    let mut p = PathBuilder::new();
    p.move_to(x + r, y);
    p.line_to(x + w - r, y);
    p.quad_to(x + w, y, x + w, y + r);
    p.line_to(x + w, y + h - r);
    p.quad_to(x + w, y + h, x + w - r, y + h);
    p.line_to(x + r, y + h);
    p.quad_to(x, y + h, x, y + h - r);
    p.line_to(x, y + r);
    p.quad_to(x, y, x + r, y);
    p.close();
    p.finish()
}

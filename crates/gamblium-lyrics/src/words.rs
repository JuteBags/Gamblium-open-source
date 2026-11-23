//! The lyrics-only shape, Moonstone (spec section 3): the words and a seek bar, nothing else.
//! "Halo ink" keeps them readable on any desktop without seeing it: a wide soft halo, a tight halo,
//! a grounding shadow and a dark hairline under the look's own letters. While the mouse is over
//! them: a faint box shows the drag area, a control pill sits above, the bar grows, shows its knob
//! (only then: owner, Nov 23 2026), the times, and a time bubble at the pointer.

use crate::card::{circle, composite, fill, from_px, ink_span, layer_pm, plain_of, rail, stroke, time, to_px, Hits, Stage, INK, MOON, RED};
use crate::icons;
use crate::render::{blur, dilate_pub, layer, paint_text, rounded, Item, Mask, Renderer};
use crate::style::{colour_or_mood, Style};
use cosmic_text::Align;
use tiny_skia::{Pixmap, PixmapPaint, Transform};

pub struct Words<'a> {
    pub title: &'a str,
    pub playing: bool,
    pub position_s: f64,
    pub duration_s: f64,
    /// 0-1 hover reveal.
    pub hover: f32,
    pub pointer: Option<(f32, f32)>,
    pub pressed: Option<&'a str>,
    /// The knob's place (0-1) while it is being dragged.
    pub dragging: Option<f32>,
    pub panel_open: bool,
    pub stage: Stage,
    pub mood: Option<(u8, u8, u8)>,
    pub shine: f32,
    pub sparkle: Option<f32>,
    pub click_through: bool,
}

/// The halo-ink layers under a line of text (`h` = halo strength, 1.0 normal).
#[allow(clippy::too_many_arguments)]
fn halo_ink(px: &mut [[f32; 4]], w: usize, h: usize, m: &Mask, ox: i64, oy: i64, k: f32, op: f32, s: f32) {
    let wide = blur(m, 18.0 * s);
    layer(px, w, h, &wide, ox, oy, |_, _| [0, 0, 0], 0.32 * k * op);
    let tight = blur(&dilate_pub(m, (2.0 * s).round().max(1.0) as usize), 7.0 * s);
    layer(px, w, h, &tight, ox, oy, |_, _| [0, 0, 0], 0.60 * k * op);
    let ground = blur(m, 3.0 * s);
    layer(px, w, h, &ground, ox, oy + (2.0 * s) as i64, |_, _| [0, 0, 0], 0.55 * k * op);
    let grown = dilate_pub(m, (1.3 * s).round().max(1.0) as usize);
    let ring = Mask { w: m.w, h: m.h, a: grown.a.iter().zip(m.a.iter()).map(|(g, a)| (g - a).max(0.0)).collect() };
    layer(px, w, h, &ring, ox, oy, |_, _| [0x05, 0x07, 0x0c], 0.74 * op);
}

/// The bar's played colour must read as light: brightened until its luma is at least 0.70.
fn bright(c: (u8, u8, u8)) -> (u8, u8, u8) {
    let l = (0.2126 * c.0 as f32 + 0.7152 * c.1 as f32 + 0.0722 * c.2 as f32) / 255.0;
    if l >= 0.70 {
        return c;
    }
    let k = ((0.70 - l) / (1.0 - l)).clamp(0.0, 1.0);
    let up = |v: u8| (v as f32 + (255.0 - v as f32) * k) as u8;
    (up(c.0), up(c.1), up(c.2))
}

impl Renderer {
    pub fn draw_words(&mut self, st: &Style, c: &Words, items: &[Item], s: f32) -> (Pixmap, Hits) {
        let halo = (st.halo / 60.0).clamp(0.0, 1.7);
        let side = 40.0 * s; // room for the halo
        let top_room = 54.0 * s; // the control pill sits above the words
        let bottom_room = 40.0 * s; // the time bubble under the bar
        let width = (st.width * s).round().max(320.0 * s);
        let pw = (width + 2.0 * side) as u32;
        // Words: weight at least 700 in this shape (thin letters lose their core).
        let look = Style { weight: st.weight.max(700), ..st.clone() };
        let other = Style { weight: 700, ..plain_of(st) };
        let fx = (st.glow_radius * 2.0 + st.outline_width + st.shadow_blur * 2.0 + 40.0) * s;
        let pad = fx.ceil() as usize + 2;
        let size = st.size * s;
        let lines: Vec<(Mask, &Item)> = match c.stage {
            Stage::Lyrics => items
                .iter()
                .filter(|it| !it.text.trim().is_empty())
                .map(|it| (self.text_mask(&it.text, size * it.scale, if it.current { &look } else { &other }, width, pad), it))
                .collect(),
            // Nothing to sing yet: the song's name, so there is something to hold.
            _ => {
                let t = Style { weight: 700, ..plain_of(st) };
                vec![(self.text_mask(c.title, 18.0 * s, &t, width, pad), &items[0])]
            }
        };
        let gap = 4.0 * s;
        let text_h: f32 = lines.iter().map(|(m, _)| (m.h - 2 * pad) as f32).sum::<f32>() + gap * lines.len().saturating_sub(1) as f32;
        let seek = st.words_seek_bar && c.duration_s > 0.0;
        let bar_block = if seek { 14.0 * s + 6.0 * s } else { 0.0 };
        let ph = (top_room + text_h + bar_block + bottom_room).ceil() as u32;
        let mut pm = Pixmap::new(pw, ph).expect("size");
        let (uw, uh) = (pw as usize, ph as usize);
        let mut hits: Hits = Vec::new();
        let hov = |r: [f32; 4]| c.pointer.is_some_and(|(x, y)| x >= r[0] && x < r[0] + r[2] && y >= r[1] && y < r[1] + r[3]);

        // The text block's ink extent (for the ghost box and the bar's width).
        let mut ink_l = f32::MAX;
        let mut ink_r = 0f32;
        let mut cur_w = 0f32;
        for (m, it) in &lines {
            let (l, r) = ink_span(m);
            if r > l {
                ink_l = ink_l.min(side - pad as f32 + l);
                ink_r = ink_r.max(side - pad as f32 + r);
                if it.current || lines.len() == 1 {
                    cur_w = cur_w.max(r - l);
                }
            }
        }
        if ink_l > ink_r {
            ink_l = side + width * 0.3;
            ink_r = side + width * 0.7;
        }
        let centre = (ink_l + ink_r) / 2.0;
        let bar_w = (cur_w.max(ink_r - ink_l) * 0.62).clamp(220.0 * s, 520.0 * s);
        let bar_x = centre - bar_w / 2.0;
        let bar_y = top_room + text_h + 14.0 * s;

        // The words' own area (the ghost box): what the mouse must be over for the hover UI.
        let (gx, gy) = (ink_l - 26.0 * s, top_room - 14.0 * s);
        let gw = (ink_r - ink_l) + 52.0 * s;
        let gh = text_h + 14.0 * s + bar_block + 16.0 * s;
        hits.push(([gx, gy, gw, gh], "_body"));
        let grown = (c.hover > 0.5 && !c.click_through) || c.dragging.is_some();
        let th = if grown { 5.0 * s } else { 3.0 * s };
        // The words, the hover box and the bar's track change only with the text, the look or an
        // animation: kept, so each second's repaint draws only the played part, the knob and the
        // times (owner, Nov 23 2026: only the bar and the lyrics change).
        let skey = format!(
            "{pw}x{ph}|{:.2}|{:.2}|{:?}|{}|{}|{}|{}|{}|{}",
            c.hover,
            c.shine,
            c.sparkle.map(|v| (v * 100.0) as i32),
            c.playing,
            c.stage as u8,
            grown,
            c.title,
            items.iter().map(|i| format!("{}/{:.2}/{:.1}/{}", i.text, i.opacity, i.dy, i.current)).collect::<Vec<_>>().join("|"),
            serde_json::to_string(st).unwrap_or_default()
        );
        if let Some(p) = self.words_static.as_ref().filter(|(k, _)| *k == skey).map(|(_, p)| p.clone()) {
            pm = p;
        } else {
            // Hover: the ghost box (the drag area) under everything.
            if c.hover > 0.01 && !c.click_through {
                let mut lp = Pixmap::new(pw, ph).expect("size");
                if let Some(g) = rounded(gx.max(1.0), gy, gw.min(pw as f32 - 2.0), gh, 18.0 * s) {
                    fill(&mut lp, &g, (0x0a, 0x0c, 0x12), 0.30);
                    stroke(&mut lp, &g, (255, 255, 255), 0.14, 1.0, None);
                }
                pm.draw_pixmap(0, 0, lp.as_ref(), &PixmapPaint { opacity: c.hover, ..Default::default() }, Transform::identity(), None);
            }
            // The words.
            let mut px = to_px(&pm);
            let mut y = top_room;
            let mut current_box = None;
            for (m, it) in &lines {
                let ox = side as i64 - pad as i64;
                let oy = (y + it.dy) as i64 - pad as i64;
                let op = it.opacity * if c.playing || c.stage != Stage::Lyrics { 1.0 } else { 0.62 };
                halo_ink(&mut px, uw, uh, m, ox, oy, halo, if it.current { 1.0 } else { 0.85 } * op.max(0.3), s);
                let it2 = Item { text: String::new(), scale: it.scale, opacity: op * if it.current || c.stage != Stage::Lyrics { 1.0 } else { 0.62 / 0.46 }, current: it.current && c.playing, dy: it.dy };
                let st_line = if it.current { &look } else { &other };
                paint_text(&mut px, uw, uh, m, ox, oy, pad, st_line, &it2, c.shine, s);
                if it.current && current_box.is_none() {
                    let (l, r) = ink_span(m);
                    current_box = Some([ox as f32 + l, y + it.dy, r - l, (m.h - 2 * pad) as f32]);
                }
                y += (m.h - 2 * pad) as f32 + gap;
            }
            if let (true, Some(t), Some(bx), true) = (st.sparkle, c.sparkle, current_box, c.playing) {
                crate::card::sparkles(&mut px, uw, uh, bx, st, t, s);
            }
            // The bar's halo, dark edge and track.
            if seek {
                if let Some(track) = rounded(bar_x - 1.0, bar_y - th / 2.0 - 1.0, bar_w + 2.0, th + 2.0, th / 2.0 + 1.0) {
                    // Only the bar's own neighbourhood is blurred, not the whole window.
                    let (bx0, by0) = ((bar_x - 24.0 * s).max(0.0) as usize, (bar_y - 24.0 * s).max(0.0) as usize);
                    let (bw0, bh0) = (((bar_w + 48.0 * s) as usize).min(uw - bx0), ((48.0 * s) as usize).min(uh - by0));
                    if let Some(mut local) = Pixmap::new(bw0 as u32, bh0 as u32) {
                        let t = Transform::from_translate(-(bx0 as f32), -(by0 as f32));
                        let mut paint = tiny_skia::Paint::default();
                        paint.set_color_rgba8(0, 0, 0, 255);
                        paint.anti_alias = true;
                        local.fill_path(&track, &paint, tiny_skia::FillRule::Winding, t, None);
                        let lm = Mask { w: bw0, h: bh0, a: local.data().chunks(4).map(|q| q[3] as f32 / 255.0).collect() };
                        layer(&mut px, uw, uh, &blur(&lm, 7.0 * s), bx0 as i64, by0 as i64, |_, _| [0, 0, 0], 0.45 * halo);
                        layer(&mut px, uw, uh, &lm, bx0 as i64, by0 as i64, |_, _| [0x05, 0x07, 0x0c], 0.72);
                    }
                }
                rail(&mut px, uw, uh, bar_x, bar_y - th / 2.0, bar_w, th, 0.0, MOON, MOON, 0.44);
            }
            from_px(&mut pm, &px);
            self.words_static = Some((skey, pm.clone()));
        }

        // The seek bar: the played part, the knob, the times.
        if seek {
            let over_bar = hov([bar_x, bar_y - 9.0 * s, bar_w, 18.0 * s]) && !c.click_through;
            let frac = c.dragging.unwrap_or(if c.duration_s > 0.0 { (c.position_s / c.duration_s).clamp(0.0, 1.0) as f32 } else { 0.0 });
            let (from, to) = if c.playing { (bright(colour_or_mood(&st.progress_color, c.mood)), (255, 255, 255)) } else { (MOON, MOON) };
            // Only the bar's strip of the picture is touched.
            let (sy0, sy1) = ((bar_y - th).max(0.0) as usize, ((bar_y + th) as usize + 1).min(uh));
            let mut strip: Vec<[f32; 4]> = pm.data()[sy0 * uw * 4..sy1 * uw * 4].chunks(4).map(|q| [q[0] as f32 / 255.0, q[1] as f32 / 255.0, q[2] as f32 / 255.0, q[3] as f32 / 255.0]).collect();
            rail(&mut strip, uw, sy1 - sy0, bar_x, bar_y - th / 2.0 - sy0 as f32, bar_w, th, frac, from, to, 0.0);
            for (d, q) in pm.data_mut()[sy0 * uw * 4..sy1 * uw * 4].chunks_mut(4).zip(strip.iter()) {
                for k in 0..4 {
                    d[k] = (q[k].clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
                }
            }
            if grown {
                if let Some(k) = self.knob(&Style { knob_size: if c.dragging.is_some() { st.knob_size + 2.0 } else { st.knob_size }, ..st.clone() }, s) {
                    let kx = bar_x + bar_w * frac;
                    if c.dragging.is_some() {
                        if let Some(ring) = circle(kx, bar_y, 6.5 * s + 5.0 * s) {
                            fill(&mut pm, &ring, (255, 255, 255), 0.20);
                        }
                    }
                    composite(&mut pm, &k, kx, bar_y);
                }
                // The times either side, in halo ink.
                let ui = Style { weight: 600, italic: false, font: "Segoe UI Variable Text".into(), ..st.clone() };
                let el = self.text_mask_aligned(&time(frac as f64 * c.duration_s), 11.0 * s, &ui, 60.0 * s, 4, Align::Right);
                let tot = self.text_mask_aligned(&time(c.duration_s), 11.0 * s, &ui, 60.0 * s, 4, Align::Left);
                for (m, x) in [(&el, bar_x - 10.0 * s - 60.0 * s - 4.0), (&tot, bar_x + bar_w + 10.0 * s - 4.0)] {
                    let (ox, oy) = (x as i64, (bar_y - m.h as f32 / 2.0) as i64);
                    layer_pm(&mut pm, &blur(m, 5.0 * s), ox, oy, (0, 0, 0), 0.6);
                    layer_pm(&mut pm, &dilate_pub(m, (2.0 * s).round() as usize), ox, oy, (0x05, 0x07, 0x0c), 0.7);
                    layer_pm(&mut pm, m, ox, oy, (255, 255, 255), 0.95);
                }
            }
            // The time under the pointer (or the knob, while dragging), just under the bar.
            if over_bar || c.dragging.is_some() {
                let at = match (c.dragging, c.pointer) {
                    (Some(f), _) => Some(f),
                    (None, Some((x, _))) => Some(((x - bar_x) / bar_w).clamp(0.0, 1.0)),
                    _ => None,
                };
                if let Some(f) = at {
                    self.bubble(&mut pm, &time(f as f64 * c.duration_s), bar_x + bar_w * f, bar_y + 20.0 * s, s);
                }
            }
            if !c.click_through {
                hits.push(([bar_x, bar_y - 9.0 * s, bar_w, 18.0 * s], "seek"));
            }
        }

        // Hover: the control pill above the words.
        if c.hover > 0.01 && !c.click_through {
            let tools: [(&str, &'static str); 5] = [("gear", "settings"), ("card", "shape"), ("video", "pip"), ("tab", "tab"), ("close", "close")];
            let pill_w = 8.0 * s + 18.0 * s + 3.0 * 26.0 * s + 9.0 * s + 5.0 * 26.0 * s + 4.0 * 2.0 * s;
            let (px0, py0) = (centre - pill_w / 2.0, top_room - 14.0 * s - 8.0 * s - 34.0 * s + (1.0 - c.hover) * 4.0 * s);
            // Drawn on a picture its own size (with room for its shadow), then laid on.
            let room = 24.0 * s;
            let (lx, ly) = (px0.max(1.0) - room, py0.max(1.0) - room);
            let mut lp = Pixmap::new((pill_w + 2.0 * room) as u32, (34.0 * s + 2.0 * room) as u32).expect("size");
            if let Some(p) = rounded(px0.max(1.0) - lx, py0.max(1.0) - ly, pill_w, 34.0 * s, 17.0 * s) {
                crate::card::shade_pm(&mut lp, &p, 11.0 * s, 8.0 * s, (0, 0, 0), 0.5);
                fill(&mut lp, &p, (0x0e, 0x0f, 0x14), 0.92);
                stroke(&mut lp, &p, (255, 255, 255), 0.12, 1.0, None);
            }
            hits.push(([px0.max(1.0), py0.max(1.0) - 6.0 * s, pill_w, 34.0 * s + 6.0 * s + 22.0 * s], "_body"));
            let cy = py0.max(1.0) + 17.0 * s;
            let mut x = px0.max(1.0) + 4.0 * s;
            icons::draw(&mut lp, "grip", x + 9.0 * s - lx, cy - ly, 14.0 * s, (255, 255, 255), 0.4);
            x += 18.0 * s;
            for (icon, hit) in [("prev", "prev"), (if c.playing { "pause" } else { "play" }, "toggle"), ("next", "next")] {
                let r = 13.0 * s;
                let rect = [x, cy - r, 2.0 * r, 2.0 * r];
                let (hovered, pressed) = (hov(rect), c.pressed == Some(hit));
                if let Some(ci) = circle(x + r - lx, cy - ly, if pressed { r * 0.92 } else { r }) {
                    if hovered || pressed {
                        fill(&mut lp, &ci, (255, 255, 255), if pressed { 0.26 } else { 0.16 });
                    }
                }
                icons::draw(&mut lp, icon, x + r - lx, cy - ly, 13.0 * s, (255, 255, 255), 0.95);
                hits.push((rect, hit));
                x += 2.0 * r + 2.0 * s;
            }
            // Divider.
            if let Some(d) = tiny_skia::Rect::from_xywh(x + 3.0 * s - lx, cy - 8.0 * s - ly, 1.0 * s, 16.0 * s) {
                fill(&mut lp, &tiny_skia::PathBuilder::from_rect(d), (255, 255, 255), 0.14);
            }
            x += 9.0 * s;
            for (icon, hit) in tools {
                let r = 13.0 * s;
                let rect = [x, cy - r, 2.0 * r, 2.0 * r];
                let (hovered, pressed) = (hov(rect), c.pressed == Some(hit));
                let active = hit == "settings" && c.panel_open;
                if let Some(ci) = circle(x + r - lx, cy - ly, if pressed { r * 0.92 } else { r }) {
                    if active {
                        fill(&mut lp, &ci, INK, 0.92);
                    } else if hit == "close" && (hovered || pressed) {
                        fill(&mut lp, &ci, RED, if pressed { 0.42 } else { 0.30 });
                    } else if hovered || pressed {
                        fill(&mut lp, &ci, (255, 255, 255), if pressed { 0.26 } else { 0.16 });
                    }
                }
                let ic = if active { (0x0d, 0x0e, 0x10) } else if hit == "close" && hovered { (0xff, 0xd9, 0xdd) } else { (255, 255, 255) };
                icons::draw(&mut lp, icon, x + r - lx, cy - ly, 14.0 * s, ic, 0.88);
                hits.push((rect, hit));
                x += 2.0 * r + 2.0 * s;
            }
            pm.draw_pixmap(lx.round() as i32, ly.round() as i32, lp.as_ref(), &PixmapPaint { opacity: c.hover, ..Default::default() }, Transform::identity(), None);
        }
        (pm, hits)
    }
}

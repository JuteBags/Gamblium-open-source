//! The seek bar's knob (owner, Nov 23 2026: "some good presets, and let them upload something as
//! the icon"): a dot, heart, star, music note, moon, sparkle or diamond, drawn as shapes in the
//! knob colour with a soft shadow; or the person's own picture (`Gamblium\lyrics\knob.png`,
//! uploaded in Settings), scaled to the knob.

use tiny_skia::{BlendMode, FillRule, FilterQuality, Paint, PathBuilder, Pixmap, PixmapPaint, Transform};

pub const SHAPES: [&str; 7] = ["dot", "heart", "star", "note", "moon", "sparkle", "diamond"];

pub fn custom_file() -> Option<std::path::PathBuf> {
    crate::style::dir().map(|d| d.join("knob.png"))
}

/// The person's picture, decoded (premultiplied), or None.
pub fn load_custom() -> Option<Pixmap> {
    let bytes = std::fs::read(custom_file()?).ok()?;
    let img = image::load_from_memory(&bytes).ok()?.thumbnail(128, 128).to_rgba8();
    let (w, h) = img.dimensions();
    let mut pm = Pixmap::new(w, h)?;
    for (d, s) in pm.data_mut().chunks_mut(4).zip(img.pixels()) {
        let a = s[3] as u16;
        d[0] = (s[0] as u16 * a / 255) as u8;
        d[1] = (s[1] as u16 * a / 255) as u8;
        d[2] = (s[2] as u16 * a / 255) as u8;
        d[3] = s[3];
    }
    Some(pm)
}

fn polygon(pb: &mut PathBuilder, points: &[(f32, f32)]) {
    for (i, (x, y)) in points.iter().enumerate() {
        if i == 0 { pb.move_to(*x, *y) } else { pb.line_to(*x, *y) }
    }
    pb.close();
}

fn star(pb: &mut PathBuilder, cx: f32, cy: f32, outer: f32, inner: f32, points: usize) {
    let pts: Vec<(f32, f32)> = (0..points * 2)
        .map(|i| {
            let a = -std::f32::consts::FRAC_PI_2 + i as f32 * std::f32::consts::PI / points as f32;
            let r = if i % 2 == 0 { outer } else { inner };
            (cx + a.cos() * r, cy + a.sin() * r)
        })
        .collect();
    polygon(pb, &pts);
}

/// The shape's outline, centred on (cx, cy), about `r` from centre to edge.
fn shape(name: &str, cx: f32, cy: f32, r: f32) -> Option<tiny_skia::Path> {
    let mut pb = PathBuilder::new();
    match name {
        "heart" => {
            pb.move_to(cx, cy + r * 0.92);
            pb.cubic_to(cx - r * 1.35, cy + r * 0.05, cx - r * 0.62, cy - r * 1.1, cx, cy - r * 0.42);
            pb.cubic_to(cx + r * 0.62, cy - r * 1.1, cx + r * 1.35, cy + r * 0.05, cx, cy + r * 0.92);
            pb.close();
        }
        "star" => star(&mut pb, cx, cy + r * 0.08, r * 1.1, r * 0.48, 5),
        "sparkle" => star(&mut pb, cx, cy, r * 1.15, r * 0.3, 4),
        "diamond" => polygon(&mut pb, &[(cx, cy - r * 1.05), (cx + r * 0.78, cy), (cx, cy + r * 1.05), (cx - r * 0.78, cy)]),
        "note" => {
            pb.push_circle(cx - r * 0.32, cy + r * 0.5, r * 0.45);
            if let Some(rr) = tiny_skia::Rect::from_xywh(cx + r * 0.02, cy - r * 0.98, r * 0.2, r * 1.5) {
                pb.push_rect(rr);
            }
            pb.move_to(cx + r * 0.02, cy - r * 0.98);
            pb.quad_to(cx + r * 0.95, cy - r * 0.7, cx + r * 0.7, cy - r * 0.05);
            pb.quad_to(cx + r * 0.62, cy - r * 0.45, cx + r * 0.22, cy - r * 0.55);
            pb.close();
        }
        "moon" | "dot" | _ => pb.push_circle(cx, cy, if name == "moon" { r } else { r * 0.82 }),
    }
    pb.finish()
}

/// The knob as a small picture, `size` px across (plus room for its shadow), centred.
pub fn draw(name: &str, size: f32, colour: (u8, u8, u8), custom: Option<&Pixmap>) -> Option<Pixmap> {
    let room = (size * 0.5).max(4.0);
    let side = (size + 2.0 * room).ceil() as u32;
    let mut pm = Pixmap::new(side, side)?;
    let c = side as f32 / 2.0;
    let r = size / 2.0;
    if name == "custom" {
        let img = custom?;
        // A soft round shadow, then the picture fitted in the knob's square.
        let mut sh = Paint::default();
        sh.set_color_rgba8(0, 0, 0, 70);
        sh.anti_alias = true;
        if let Some(p) = PathBuilder::from_circle(c, c + 1.0, r * 0.95) {
            pm.fill_path(&p, &sh, FillRule::Winding, Transform::identity(), None);
        }
        let k = size / img.width().max(img.height()) as f32;
        let (dx, dy) = (c - img.width() as f32 * k / 2.0, c - img.height() as f32 * k / 2.0);
        let paint = PixmapPaint { quality: FilterQuality::Bicubic, ..Default::default() };
        pm.draw_pixmap(0, 0, img.as_ref(), &paint, Transform::from_row(k, 0.0, 0.0, k, dx, dy), None);
        return Some(pm);
    }
    let path = shape(name, c, c, r)?;
    // Shadow: the shape a little larger and lower, faint.
    let mut sh = Paint::default();
    sh.set_color_rgba8(0, 0, 0, 90);
    sh.anti_alias = true;
    let grow = Transform::from_translate(-c, -c).post_scale(1.18, 1.18).post_translate(c, c + 1.2);
    pm.fill_path(&path, &sh, FillRule::Winding, grow, None);
    let mut paint = Paint::default();
    paint.set_color_rgba8(colour.0, colour.1, colour.2, 255);
    paint.anti_alias = true;
    pm.fill_path(&path, &paint, FillRule::Winding, Transform::identity(), None);
    if name == "moon" {
        // The bite out of the moon.
        let mut cut = Paint::default();
        cut.set_color_rgba8(0, 0, 0, 255);
        cut.anti_alias = true;
        cut.blend_mode = BlendMode::Clear;
        if let Some(p) = PathBuilder::from_circle(c + r * 0.5, c - r * 0.32, r * 0.82) {
            pm.fill_path(&p, &cut, FillRule::Winding, Transform::identity(), None);
        }
    }
    Some(pm)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_shape_draws_something() {
        for s in SHAPES {
            let pm = draw(s, 14.0, (255, 255, 255), None).expect(s);
            let ink = pm.data().chunks(4).filter(|p| p[3] > 200).count();
            assert!(ink > 20, "{s}: {ink}");
        }
        assert!(draw("custom", 14.0, (255, 255, 255), None).is_none());
    }
}

//! Icons (Moonstone spec section 9): SVG path data on a 16-unit grid, stroke 1.4, round caps and
//! joins, the same notation as the browser menu's icons (content/menu.js). A small SVG path reader
//! (M L H V C S Q T A Z, relative and absolute, the compact number form ".5.5") turns them into
//! tiny-skia paths.

use tiny_skia::{FillRule, LineCap, LineJoin, Paint, PathBuilder, Pixmap, Stroke, Transform};

#[derive(Clone, Copy, PartialEq)]
enum Mode {
    Stroke,
    Fill,
}

/// The parts of an icon: path data and how it is drawn.
fn parts(name: &str) -> &'static [(&'static str, Mode)] {
    use Mode::*;
    match name {
        "gear" => &[("M6.86 3.24L7.02 1.47L8.98 1.47L9.14 3.24A4.9 4.9 0 0 1 10.56 3.82L11.93 2.69L13.31 4.07L12.18 5.44A4.9 4.9 0 0 1 12.76 6.86L14.53 7.02L14.53 8.98L12.76 9.14A4.9 4.9 0 0 1 12.18 10.56L13.31 11.93L11.93 13.31L10.56 12.18A4.9 4.9 0 0 1 9.14 12.76L8.98 14.53L7.02 14.53L6.86 12.76A4.9 4.9 0 0 1 5.44 12.18L4.07 13.31L2.69 11.93L3.82 10.56A4.9 4.9 0 0 1 3.24 9.14L1.47 8.98L1.47 7.02L3.24 6.86A4.9 4.9 0 0 1 3.82 5.44L2.69 4.07L4.07 2.69L5.44 3.82A4.9 4.9 0 0 1 6.86 3.24ZM10.10 8.00A2.1 2.1 0 1 1 5.90 8.00A2.1 2.1 0 1 1 10.10 8.00Z", Stroke)],
        "lyrics" => &[("M3 5h10M4.5 8h7M3.5 11h9", Stroke)],
        "card" => &[("M4.5 3.5h7a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2zM5.5 10h5", Stroke), ("M5.5 6.2h1.8v1.8h-1.8z", Fill)],
        "box" => &[("M3.5 5.5h9a1.5 1.5 0 0 1 1.5 1.5v2a1.5 1.5 0 0 1-1.5 1.5h-9a1.5 1.5 0 0 1-1.5-1.5v-2a1.5 1.5 0 0 1 1.5-1.5zM5 8h6", Stroke)],
        "video" => &[("M4 3.5h8a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5h-8a1.5 1.5 0 0 1-1.5-1.5v-6a1.5 1.5 0 0 1 1.5-1.5z", Stroke), ("M8 8h3.5v2.5h-3.5z", Fill)],
        "tab" => &[("M12.5 3.5v4a2 2 0 0 1-2 2H4M6.5 7 4 9.5 6.5 12", Stroke)],
        "close" => &[("M4.5 4.5l7 7M11.5 4.5l-7 7", Stroke)],
        "prev" => &[("M12 3.5v9L5.8 8z", Fill), ("M3.6 3.5v9", Stroke)],
        "next" => &[("M4 3.5v9L10.2 8z", Fill), ("M12.4 3.5v9", Stroke)],
        "play" => &[("M5.2 3.2 13 8l-7.8 4.8z", Fill), ("M5.2 3.2 13 8l-7.8 4.8z", Stroke)],
        "pause" => &[("M4.8 3.2h1.8a.6.6 0 0 1 .6.6v8.4a.6.6 0 0 1-.6.6H4.8a.6.6 0 0 1-.6-.6V3.8a.6.6 0 0 1 .6-.6zM10 3.2h1.8a.6.6 0 0 1 .6.6v8.4a.6.6 0 0 1-.6.6H10a.6.6 0 0 1-.6-.6V3.8a.6.6 0 0 1 .6-.6z", Fill)],
        "grip" => &[("M7 4a1 1 0 1 1-2 0a1 1 0 1 1 2 0zM11 4a1 1 0 1 1-2 0a1 1 0 1 1 2 0zM7 8a1 1 0 1 1-2 0a1 1 0 1 1 2 0zM11 8a1 1 0 1 1-2 0a1 1 0 1 1 2 0zM7 12a1 1 0 1 1-2 0a1 1 0 1 1 2 0zM11 12a1 1 0 1 1-2 0a1 1 0 1 1 2 0z", Fill)],
        "minus" => &[("M4 8h8", Stroke)],
        "plus" => &[("M4 8h8M8 4v8", Stroke)],
        "textsize" => &[("M2.5 12.5 5.5 4l3 8.5M3.5 10h4M10 12.5l1.8-5 1.8 5M10.6 11h2.4", Stroke)],
        "background" => &[("M13.5 8a5.5 5.5 0 1 1-11 0a5.5 5.5 0 1 1 11 0z", Stroke), ("M8 2.5a5.5 5.5 0 0 0 0 11z", Fill)],
        "timing" => &[("M13.5 8a5.5 5.5 0 1 1-11 0a5.5 5.5 0 1 1 11 0zM8 5v3l2 1.5", Stroke)],
        "lines" => &[("M3 4.5h10M3 8h10M3 11.5h6", Stroke)],
        "translate" => &[("M2.500 4h6M5.500 2.500V4M4 4c.300 2.300 1.900 4.200 4 5M7.500 4c-.400 2.500-2.200 4.600-5 5.500M8.500 13.500l2.500-6 2.500 6M9.300 11.500h3.400", Stroke)],
        "seekbar" => &[("M2.5 8h11", Stroke), ("M8.5 8a2 2 0 1 1-4 0a2 2 0 1 1 4 0z", Fill)],
        "hide" => &[("M2.500 8s2-3.500 5.500-3.500S13.500 8 13.500 8 11.500 11.500 8 11.500 2.500 8 2.500 8zM3.500 3.500l9 9", Stroke)],
        "out" => &[("M6.5 3.5H4.5a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1v-2M9.5 3h3.5v3.5M13 3 7.5 8.5", Stroke)],
        "box_off" => &[("M4 3.500h8a.500.500 0 0 1 .500.500v8a.500.500 0 0 1-.500.500H4a.500.500 0 0 1-.500-.500V4a.500.500 0 0 1 .500-.500z", Stroke)],
        "box_on" => &[("M4 3.500h8a.500.500 0 0 1 .500.500v8a.500.500 0 0 1-.500.500H4a.500.500 0 0 1-.500-.500V4a.500.500 0 0 1 .500-.500zM5.500 8.200 7.300 10l3.200-3.800", Stroke)],
        "note" => &[("M6.5 11.5a2 2 0 1 1-4 0a2 2 0 1 1 4 0zM6.5 11.5V3.5l6-1.5v8", Stroke), ("M12.5 10a2 2 0 1 1-4 0a2 2 0 1 1 4 0z", Stroke)],
        _ => &[],
    }
}

/// Draws icon `name`, `size` px across, centred on (cx, cy), in `rgb` at `alpha`.
pub fn draw(pm: &mut Pixmap, name: &str, cx: f32, cy: f32, size: f32, rgb: (u8, u8, u8), alpha: f32) {
    let k = size / 16.0;
    let t = Transform::from_row(k, 0.0, 0.0, k, cx - 8.0 * k, cy - 8.0 * k);
    let mut paint = Paint::default();
    paint.set_color_rgba8(rgb.0, rgb.1, rgb.2, (alpha.clamp(0.0, 1.0) * 255.0) as u8);
    paint.anti_alias = true;
    for (d, mode) in parts(name) {
        let Some(path) = parse(d) else { continue };
        match mode {
            Mode::Fill => {
                pm.fill_path(&path, &paint, FillRule::Winding, t, None);
            }
            Mode::Stroke => {
                let st = Stroke { width: 1.4, line_cap: LineCap::Round, line_join: LineJoin::Round, ..Default::default() };
                pm.stroke_path(&path, &paint, &st, t, None);
            }
        }
    }
}

// ---- SVG path reader ---------------------------------------------------------------------------

fn numbers(s: &str) -> Vec<f32> {
    let b = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        if c == b'-' || c == b'+' || c == b'.' || c.is_ascii_digit() {
            let start = i;
            i += 1;
            let mut dot = c == b'.';
            while i < b.len() {
                let d = b[i];
                if d.is_ascii_digit() {
                    i += 1;
                } else if d == b'.' && !dot {
                    dot = true;
                    i += 1;
                } else if (d == b'e' || d == b'E') && i + 1 < b.len() {
                    i += 1;
                    if b[i] == b'-' || b[i] == b'+' {
                        i += 1;
                    }
                } else {
                    break;
                }
            }
            if let Ok(v) = s[start..i].parse::<f32>() {
                out.push(v);
            }
        } else {
            i += 1;
        }
    }
    out
}

/// Arc flags may be written without separators ("011"): read them one character each.
fn arc_numbers(s: &str) -> Vec<f32> {
    let mut out = Vec::new();
    let mut rest = s.trim_start_matches([' ', ',']);
    let mut idx = 0;
    while !rest.is_empty() {
        let slot = idx % 7;
        if slot == 3 || slot == 4 {
            let c = rest.chars().next().unwrap();
            if c == '0' || c == '1' {
                out.push(if c == '1' { 1.0 } else { 0.0 });
                rest = rest[1..].trim_start_matches([' ', ',']);
                idx += 1;
                continue;
            }
        }
        let n = numbers(rest);
        let Some(first) = n.first() else { break };
        out.push(*first);
        // Skip past that one number.
        let b = rest.as_bytes();
        let mut i = 0;
        if i < b.len() && (b[i] == b'-' || b[i] == b'+') {
            i += 1;
        }
        let mut dot = false;
        while i < b.len() {
            if b[i].is_ascii_digit() {
                i += 1;
            } else if b[i] == b'.' && !dot {
                dot = true;
                i += 1;
            } else {
                break;
            }
        }
        rest = rest[i.max(1)..].trim_start_matches([' ', ',']);
        idx += 1;
    }
    out
}

/// Endpoint arc to cubic Béziers (SVG implementation notes, F.6).
#[allow(clippy::too_many_arguments)]
fn arc(pb: &mut PathBuilder, x1: f32, y1: f32, mut rx: f32, mut ry: f32, phi: f32, large: bool, sweep: bool, x2: f32, y2: f32) {
    if rx == 0.0 || ry == 0.0 || (x1 == x2 && y1 == y2) {
        pb.line_to(x2, y2);
        return;
    }
    rx = rx.abs();
    ry = ry.abs();
    let (sp, cp) = phi.to_radians().sin_cos();
    let dx = (x1 - x2) / 2.0;
    let dy = (y1 - y2) / 2.0;
    let x1p = cp * dx + sp * dy;
    let y1p = -sp * dx + cp * dy;
    let lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
    if lam > 1.0 {
        let s = lam.sqrt();
        rx *= s;
        ry *= s;
    }
    let num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
    let den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
    let mut co = (num / den).max(0.0).sqrt();
    if large == sweep {
        co = -co;
    }
    let cxp = co * rx * y1p / ry;
    let cyp = -co * ry * x1p / rx;
    let cx = cp * cxp - sp * cyp + (x1 + x2) / 2.0;
    let cy = sp * cxp + cp * cyp + (y1 + y2) / 2.0;
    let ang = |ux: f32, uy: f32, vx: f32, vy: f32| {
        let d = (ux * vx + uy * vy) / ((ux * ux + uy * uy).sqrt() * (vx * vx + vy * vy).sqrt());
        let a = d.clamp(-1.0, 1.0).acos();
        if ux * vy - uy * vx < 0.0 { -a } else { a }
    };
    let t1 = ang(1.0, 0.0, (x1p - cxp) / rx, (y1p - cyp) / ry);
    let mut dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
    if !sweep && dt > 0.0 {
        dt -= std::f32::consts::TAU;
    } else if sweep && dt < 0.0 {
        dt += std::f32::consts::TAU;
    }
    let segs = (dt.abs() / std::f32::consts::FRAC_PI_2).ceil().max(1.0) as usize;
    let d = dt / segs as f32;
    let k = 4.0 / 3.0 * (d / 4.0).tan();
    let pt = |t: f32| {
        let (s, c) = t.sin_cos();
        (cx + rx * c * cp - ry * s * sp, cy + rx * c * sp + ry * s * cp)
    };
    let dpt = |t: f32| {
        let (s, c) = t.sin_cos();
        (-rx * s * cp - ry * c * sp, -rx * s * sp + ry * c * cp)
    };
    let mut t = t1;
    for _ in 0..segs {
        let (p0, d0) = (pt(t), dpt(t));
        let (p3, d3) = (pt(t + d), dpt(t + d));
        pb.cubic_to(p0.0 + k * d0.0, p0.1 + k * d0.1, p3.0 - k * d3.0, p3.1 - k * d3.1, p3.0, p3.1);
        t += d;
    }
}

pub fn parse(d: &str) -> Option<tiny_skia::Path> {
    let mut pb = PathBuilder::new();
    let (mut x, mut y, mut sx, mut sy) = (0f32, 0f32, 0f32, 0f32);
    let mut last_c: Option<(f32, f32)> = None; // last cubic control point (for S)
    let mut last_q: Option<(f32, f32)> = None; // last quadratic control point (for T)
    let bytes = d.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i] as char;
        if !c.is_ascii_alphabetic() || c == 'e' || c == 'E' {
            i += 1;
            continue;
        }
        let mut j = i + 1;
        while j < bytes.len() && !((bytes[j] as char).is_ascii_alphabetic() && bytes[j] != b'e' && bytes[j] != b'E') {
            j += 1;
        }
        let args_s = &d[i + 1..j];
        let rel = c.is_ascii_lowercase();
        let up = c.to_ascii_uppercase();
        let a = if up == 'A' { arc_numbers(args_s) } else { numbers(args_s) };
        let (ox, oy) = if rel { (x, y) } else { (0.0, 0.0) };
        match up {
            'M' => {
                for (n, p) in a.chunks(2).enumerate() {
                    if p.len() < 2 {
                        break;
                    }
                    let (nx, ny) = if rel { (x + p[0], y + p[1]) } else { (p[0], p[1]) };
                    if n == 0 {
                        pb.move_to(nx, ny);
                        sx = nx;
                        sy = ny;
                    } else {
                        pb.line_to(nx, ny);
                    }
                    x = nx;
                    y = ny;
                }
                last_c = None;
                last_q = None;
            }
            'L' => {
                for p in a.chunks(2).filter(|p| p.len() == 2) {
                    let (nx, ny) = if rel { (x + p[0], y + p[1]) } else { (p[0], p[1]) };
                    pb.line_to(nx, ny);
                    x = nx;
                    y = ny;
                }
                last_c = None;
                last_q = None;
            }
            'H' => {
                for v in &a {
                    x = if rel { x + v } else { *v };
                    pb.line_to(x, y);
                }
                last_c = None;
                last_q = None;
            }
            'V' => {
                for v in &a {
                    y = if rel { y + v } else { *v };
                    pb.line_to(x, y);
                }
                last_c = None;
                last_q = None;
            }
            'C' => {
                for p in a.chunks(6).filter(|p| p.len() == 6) {
                    let (ox, oy) = if rel { (x, y) } else { (0.0, 0.0) };
                    let (c1, c2, e) = ((ox + p[0], oy + p[1]), (ox + p[2], oy + p[3]), (ox + p[4], oy + p[5]));
                    pb.cubic_to(c1.0, c1.1, c2.0, c2.1, e.0, e.1);
                    last_c = Some(c2);
                    x = e.0;
                    y = e.1;
                }
                last_q = None;
            }
            'S' => {
                for p in a.chunks(4).filter(|p| p.len() == 4) {
                    let (ox, oy) = if rel { (x, y) } else { (0.0, 0.0) };
                    let c1 = last_c.map(|(cx, cy)| (2.0 * x - cx, 2.0 * y - cy)).unwrap_or((x, y));
                    let (c2, e) = ((ox + p[0], oy + p[1]), (ox + p[2], oy + p[3]));
                    pb.cubic_to(c1.0, c1.1, c2.0, c2.1, e.0, e.1);
                    last_c = Some(c2);
                    x = e.0;
                    y = e.1;
                }
                last_q = None;
            }
            'Q' => {
                for p in a.chunks(4).filter(|p| p.len() == 4) {
                    let (ox, oy) = if rel { (x, y) } else { (0.0, 0.0) };
                    let (c1, e) = ((ox + p[0], oy + p[1]), (ox + p[2], oy + p[3]));
                    pb.quad_to(c1.0, c1.1, e.0, e.1);
                    last_q = Some(c1);
                    x = e.0;
                    y = e.1;
                }
                last_c = None;
            }
            'T' => {
                for p in a.chunks(2).filter(|p| p.len() == 2) {
                    let (ox, oy) = if rel { (x, y) } else { (0.0, 0.0) };
                    let c1 = last_q.map(|(cx, cy)| (2.0 * x - cx, 2.0 * y - cy)).unwrap_or((x, y));
                    let e = (ox + p[0], oy + p[1]);
                    pb.quad_to(c1.0, c1.1, e.0, e.1);
                    last_q = Some(c1);
                    x = e.0;
                    y = e.1;
                }
                last_c = None;
            }
            'A' => {
                for p in a.chunks(7).filter(|p| p.len() == 7) {
                    let (ox, oy) = if rel { (x, y) } else { (0.0, 0.0) };
                    let (ex, ey) = (ox + p[5], oy + p[6]);
                    arc(&mut pb, x, y, p[0], p[1], p[2], p[3] != 0.0, p[4] != 0.0, ex, ey);
                    x = ex;
                    y = ey;
                }
                last_c = None;
                last_q = None;
            }
            'Z' => {
                pb.close();
                x = sx;
                y = sy;
                last_c = None;
                last_q = None;
            }
            _ => {}
        }
        let _ = (ox, oy);
        i = j;
    }
    pb.finish()
}

pub const NAMES: [&str; 25] = [
    "gear", "lyrics", "card", "box", "video", "tab", "close", "prev", "next", "play", "pause", "grip", "minus", "plus", "textsize",
    "background", "timing", "lines", "translate", "seekbar", "hide", "out", "box_off", "box_on", "note",
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compact_numbers_are_read() {
        assert_eq!(numbers(".500.500 0 0 1 .500.500"), vec![0.5, 0.5, 0.0, 0.0, 1.0, 0.5, 0.5]);
        assert_eq!(numbers("-3.500-2.2"), vec![-3.5, -2.2]);
        assert_eq!(arc_numbers("2 2 0 011.5 1.5"), vec![2.0, 2.0, 0.0, 0.0, 1.0, 1.5, 1.5]);
    }

    #[test]
    fn every_icon_draws_ink() {
        for n in NAMES {
            let mut pm = Pixmap::new(32, 32).unwrap();
            draw(&mut pm, n, 16.0, 16.0, 28.0, (255, 255, 255), 1.0);
            let ink = pm.data().chunks(4).filter(|p| p[3] > 100).count();
            assert!(ink > 8, "{n}: {ink}");
        }
    }
}

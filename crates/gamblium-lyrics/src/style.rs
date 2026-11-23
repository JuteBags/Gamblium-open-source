//! The look, in `Gamblium\lyrics\style.json` (re-read while running, so it can be tuned live).
//! `"preset"` picks a starting look; any other key in the file overrides it.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Style {
    pub preset: String,
    /// Font family as Windows names it ("Segoe UI", "Poppins", "Nirmala UI" ...).
    pub font: String,
    pub size: f32,
    pub weight: u16,
    pub italic: bool,
    /// Text colour (#rrggbb), or the top of the gradient when `gradient_to` is set.
    pub color: String,
    pub gradient_to: Option<String>,
    /// 0-100: the text itself.
    pub text_opacity: f32,
    /// 0-100: the lines before / after the current one.
    pub other_lines_opacity: f32,
    pub other_lines_scale: f32,
    pub glow_color: String,
    /// Pixels; 0 = no glow.
    pub glow_radius: f32,
    /// 0-3: how strong the glow is.
    pub glow_strength: f32,
    pub outline_color: String,
    pub outline_width: f32,
    pub shadow_color: String,
    pub shadow_x: f32,
    pub shadow_y: f32,
    pub shadow_blur: f32,
    /// 0-100: shadow strength.
    pub shadow_opacity: f32,
    /// A bright band sweeping across the current line.
    pub shine: bool,
    pub shine_color: String,
    /// Seconds per sweep.
    pub shine_seconds: f32,
    pub background: String,
    /// 0-100.
    pub background_opacity: f32,
    pub corner_radius: f32,
    /// Window width in pixels.
    pub width: f32,
    /// 1: current line; 2: current + next; 3: previous + current + next.
    pub lines: u8,
    /// "original", "hinglish" or "both".
    pub script: String,
    /// Shift the lyrics: positive shows them later.
    pub offset_ms: i64,
    /// Clicks go to the app behind (Ctrl+Alt+L toggles).
    pub click_through: bool,
    /// A thin song progress bar along the bottom.
    pub progress_bar: bool,
    pub progress_color: String,
    /// "card" (mini player: art, song, controls, lyrics, progress) or "strip" (lyrics only).
    pub layout: String,
    /// Card width in pixels, and its lyrics' size.
    pub card_width: f32,
    pub card_text_size: f32,
    /// 0-100: the song's art, blurred, behind the card (frosted glass).
    pub art_opacity: f32,
    /// 0-100: the card tinted with the art's own colour.
    pub mood_tint: f32,
    /// Twinkling sparkles around the line being sung.
    pub sparkle: bool,
    pub sparkle_color: String,
    /// How many sparkles (4-40).
    pub sparkle_amount: u32,
    /// Song name and controls.
    pub title_color: String,
    /// Glass letters: see-through, frosting what is behind them, lit on their top edges.
    pub glass: bool,
    /// 0-100.
    pub glass_strength: f32,
    /// The lyrics-only shape shows a seek bar under the words.
    pub words_seek_bar: bool,
    /// The seek bar's knob (shown while the mouse is over the window): dot, heart, star, note,
    /// moon, sparkle, diamond, or custom (the person's picture).
    pub knob: String,
    pub knob_size: f32,
    pub knob_color: String,
    /// Moonstone (owner, Nov 23 2026). 0-100: the song's colour glowing under the card.
    pub aura: f32,
    /// "mood" (the song's colour) or #rrggbb.
    pub aura_color: String,
    /// 0-100 (60 = normal): the dark halo that keeps lyrics-only words readable on anything.
    pub halo: f32,
    /// How lines change: "slide", "fade" or "off".
    pub line_motion: String,
    /// One shine sweep per new line, this long.
    pub shine_sweep_ms: f32,
    /// Gold's foil line in the middle of the letters.
    pub foil: bool,
    /// The progress fill runs from `progress_color` ("mood" = the song's colour) to this.
    pub progress_to: String,
    /// The look's swatch in the menu (two colours of its card).
    pub swatch_from: String,
    pub swatch_to: String,
}

impl Default for Style {
    fn default() -> Self {
        serde_json::from_value(preset("glass")).unwrap()
    }
}

/// The starting looks (Moonstone spec, section 7). Every key is listed so a preset alone is a
/// whole style.
pub fn preset(name: &str) -> Value {
    let base = json!({
        "preset": "glass", "font": "Segoe UI Variable Display", "size": 30.0, "weight": 600, "italic": false,
        "color": "#f2f4f8", "gradient_to": null, "text_opacity": 100.0,
        "other_lines_opacity": 46.0, "other_lines_scale": 0.72,
        "glow_color": "#9d86ff", "glow_radius": 0.0, "glow_strength": 1.0,
        "outline_color": "#000000", "outline_width": 0.0,
        "shadow_color": "#000000", "shadow_x": 0.0, "shadow_y": 2.0, "shadow_blur": 4.0, "shadow_opacity": 70.0,
        "shine": false, "shine_color": "#ffffff", "shine_seconds": 2.5, "shine_sweep_ms": 700.0,
        "background": "#0b0d16", "background_opacity": 55.0, "corner_radius": 20.0,
        "width": 760.0, "lines": 2, "script": "hinglish", "offset_ms": 0,
        "click_through": false, "progress_bar": true, "progress_color": "mood", "progress_to": "#ffffff",
        "layout": "card", "card_width": 460.0, "card_text_size": 24.0, "art_opacity": 55.0, "mood_tint": 30.0,
        "sparkle": false, "sparkle_color": "#fff3c4", "sparkle_amount": 16, "title_color": "#ffffff",
        "glass": false, "glass_strength": 70.0, "words_seek_bar": true,
        "knob": "dot", "knob_size": 11.0, "knob_color": "#ffffff",
        "aura": 38.0, "aura_color": "mood", "halo": 60.0, "line_motion": "slide", "foil": false,
        "swatch_from": "#3d4a66", "swatch_to": "#1b2030"
    });
    let over = match name {
        "crystal" => json!({ "preset": "crystal", "font": "Segoe UI Black", "weight": 900, "color": "#eef6ff", "gradient_to": "#b9d4ff",
            "glass": true, "glass_strength": 75.0, "shadow_blur": 8.0, "shadow_y": 4.0, "shadow_opacity": 45.0, "shine": true,
            "background": "#0d1220", "background_opacity": 42.0, "art_opacity": 70.0, "mood_tint": 25.0,
            "card_text_size": 26.0, "size": 34.0, "progress_color": "#cfe0ff", "swatch_from": "#5f86b8", "swatch_to": "#232c48" }),
        "neon" => json!({ "preset": "neon", "font": "Segoe UI", "weight": 700, "color": "#e9fbff",
            "glow_color": "#00e5ff", "glow_radius": 14.0, "glow_strength": 2.2, "shadow_opacity": 0.0,
            "background": "#02060c", "background_opacity": 70.0, "art_opacity": 25.0, "mood_tint": 10.0,
            "aura": 55.0, "aura_color": "#00e5ff", "progress_color": "#00e5ff", "progress_to": "#00e5ff",
            "swatch_from": "#04090f", "swatch_to": "#04090f" }),
        "karaoke" => json!({ "preset": "karaoke", "font": "Segoe UI Black", "weight": 900, "color": "#ffe14d",
            "gradient_to": "#ff9f1a", "outline_color": "#1a0f00", "outline_width": 3.0, "shadow_y": 3.0,
            "background": "#120a00", "background_opacity": 50.0, "art_opacity": 45.0, "mood_tint": 20.0, "aura": 30.0,
            "progress_color": "#ff9f1a", "progress_to": "#ffe14d", "swatch_from": "#3a2a12", "swatch_to": "#191008" }),
        "minimal" => json!({ "preset": "minimal", "weight": 500, "size": 26.0, "card_text_size": 22.0, "color": "#ffffff",
            "background": "#0d0e10", "background_opacity": 86.0, "art_opacity": 0.0, "mood_tint": 0.0, "aura": 0.0,
            "shadow_blur": 6.0, "shadow_opacity": 85.0, "lines": 1, "progress_color": "#c9ced8", "progress_to": "#c9ced8",
            "swatch_from": "#101114", "swatch_to": "#101114" }),
        "sunset" => json!({ "preset": "sunset", "font": "Georgia", "weight": 700, "italic": true, "color": "#ffd1a3",
            "gradient_to": "#ff5e8a", "glow_color": "#ff5e8a", "glow_radius": 10.0, "glow_strength": 1.2, "shadow_opacity": 60.0,
            "background": "#1a0b14", "background_opacity": 52.0, "art_opacity": 60.0, "shine": true, "shine_color": "#fff3e0",
            "aura": 45.0, "progress_color": "#ff5e8a", "progress_to": "#ffd1a3", "swatch_from": "#5a2440", "swatch_to": "#24101c" }),
        "gold" => json!({ "preset": "gold", "font": "Cambria", "weight": 700, "color": "#fff2b0", "gradient_to": "#d4a017",
            "glow_color": "#ffcc33", "glow_radius": 8.0, "glow_strength": 1.0, "shadow_opacity": 65.0, "shine": true, "sparkle": true,
            "foil": true, "card_text_size": 25.0, "background": "#120d02", "background_opacity": 58.0, "art_opacity": 50.0,
            "mood_tint": 15.0, "aura": 40.0, "progress_color": "#d4a017", "progress_to": "#fff2b0",
            "swatch_from": "#3d3010", "swatch_to": "#161003" }),
        _ => json!({}),
    };
    merge(base, over)
}

pub const PRESETS: [&str; 7] = ["glass", "crystal", "neon", "karaoke", "minimal", "sunset", "gold"];

fn merge(mut base: Value, over: Value) -> Value {
    if let (Some(b), Some(o)) = (base.as_object_mut(), over.as_object()) {
        for (k, v) in o {
            b.insert(k.clone(), v.clone());
        }
    }
    base
}

pub fn dir() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join("Gamblium").join("lyrics"))
}

pub fn file() -> Option<PathBuf> {
    dir().map(|d| d.join("style.json"))
}

/// The style file, made with the glass look when missing. A broken file keeps the last good style.
pub fn load(last: &Style) -> Style {
    let Some(f) = file() else { return last.clone() };
    let text = match std::fs::read_to_string(&f) {
        Ok(t) => t,
        Err(_) => {
            let _ = std::fs::create_dir_all(f.parent().unwrap());
            let _ = std::fs::write(&f, serde_json::to_string_pretty(&json!({ "preset": "glass" })).unwrap());
            return Style::default();
        }
    };
    let Ok(user) = serde_json::from_str::<Value>(&text) else { return last.clone() };
    let name = user.get("preset").and_then(|p| p.as_str()).unwrap_or("glass").to_owned();
    serde_json::from_value(merge(preset(&name), user)).unwrap_or_else(|_| last.clone())
}

/// Switches the preset in the file, keeping the person's own overrides.
pub fn set_preset(name: &str) {
    let Some(f) = file() else { return };
    let mut user: Value = std::fs::read_to_string(&f).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(json!({}));
    if let Some(o) = user.as_object_mut() {
        o.insert("preset".into(), json!(name));
    }
    let _ = std::fs::create_dir_all(f.parent().unwrap());
    let _ = std::fs::write(&f, serde_json::to_string_pretty(&user).unwrap());
}

/// What a person sets for themselves and keeps when they pick another look (the rest is the look).
pub const KEEP: [&str; 12] = ["layout", "script", "lines", "offset_ms", "click_through", "width", "card_width", "progress_bar", "words_seek_bar", "knob", "knob_size", "knob_color"];

/// Picks a look: its colours and effects replace the person's, their own choices (KEEP) stay.
pub fn choose_preset(name: &str) {
    let Some(f) = file() else { return };
    let mut user: Value = std::fs::read_to_string(&f).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(json!({}));
    if let Some(o) = user.as_object_mut() {
        o.retain(|k, _| KEEP.contains(&k.as_str()));
        o.insert("preset".into(), json!(name));
    }
    let _ = std::fs::create_dir_all(f.parent().unwrap());
    let _ = std::fs::write(&f, serde_json::to_string_pretty(&user).unwrap());
}

pub fn set_key(key: &str, value: Value) {
    let Some(f) = file() else { return };
    let mut user: Value = std::fs::read_to_string(&f).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(json!({}));
    if let Some(o) = user.as_object_mut() {
        o.insert(key.into(), value);
    }
    let _ = std::fs::write(&f, serde_json::to_string_pretty(&user).unwrap());
}

/// "#rrggbb" -> (r, g, b); anything else is white.
pub fn rgb(s: &str) -> (u8, u8, u8) {
    let h = s.trim().trim_start_matches('#');
    if h.len() == 6 {
        if let Ok(v) = u32::from_str_radix(h, 16) {
            return ((v >> 16) as u8, (v >> 8) as u8, v as u8);
        }
    }
    (255, 255, 255)
}

/// A colour key that may say "mood": the song's colour (lifted 45% toward white, so it reads as a
/// fill), else the fallback blue.
pub fn colour_or_mood(s: &str, mood: Option<(u8, u8, u8)>) -> (u8, u8, u8) {
    if s == "mood" {
        let m = mood.unwrap_or((0x8f, 0xa3, 0xc4));
        let lift = |c: u8| (c as f32 + (255.0 - c as f32) * 0.45) as u8;
        (lift(m.0), lift(m.1), lift(m.2))
    } else {
        rgb(s)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_preset_is_a_whole_style() {
        for p in PRESETS {
            let s: Style = serde_json::from_value(preset(p)).expect(p);
            assert_eq!(s.preset, p);
        }
        assert_eq!(rgb("#ff8000"), (255, 128, 0));
    }
}

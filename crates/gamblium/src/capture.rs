//! A picture of what a browser window shows, taken by Windows, not by the browser.
//!
//! The browser gives extensions no picture of its own pages (New Tab, Settings, chrome://...,
//! the Web Store) and its debugger refuses them too. Windows can draw any window into a bitmap
//! (`PrintWindow` with full content), whatever the page inside allows, without the window
//! being in front and without anything else on the screen getting in. We crop to the page
//! area: the visible `Chrome_RenderWidgetHostHWND` child of that window.
//!
//! Only windows of the browser this helper belongs to are captured. The PNG goes to a file in
//! `Gamblium\shots` and travels to the extension in pieces (native messages are capped at 1 MB).

use std::path::PathBuf;

pub fn shots_dir() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join("Gamblium").join("shots"))
}

/// A picture id is ours only: letters and digits.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 40 && id.chars().all(|c| c.is_ascii_alphanumeric())
}

/// Piece `index` of a saved picture, as base64; (piece, total pieces).
pub fn piece(id: &str, index: usize, size: usize) -> Result<(String, usize), String> {
    if !valid_id(id) {
        return Err("not a picture id".into());
    }
    let path = shots_dir().ok_or("LOCALAPPDATA is not set")?.join(format!("{id}.png"));
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    let total = bytes.len().div_ceil(size).max(1);
    let start = (index * size).min(bytes.len());
    let end = ((index + 1) * size).min(bytes.len());
    if index + 1 >= total {
        let _ = std::fs::remove_file(&path);
    }
    Ok((b64(&bytes[start..end]), total))
}

pub fn b64(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for c in data.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if c.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if c.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

/// Which of the browser's windows: the one whose outer rectangle (in DIP, as chrome.windows has it) is nearest.
#[derive(Clone, Copy, Debug)]
pub struct Want {
    pub left: i32,
    pub top: i32,
    pub width: i32,
    pub height: i32,
}

#[cfg(windows)]
mod win {
    use super::Want;
    use windows_sys::Win32::Foundation::{BOOL, HWND, LPARAM, RECT};
    use windows_sys::Win32::Graphics::Gdi::*;
    use windows_sys::Win32::Storage::Xps::{PrintWindow, PW_CLIENTONLY};
    use windows_sys::Win32::UI::WindowsAndMessaging::*;

    const PW_RENDERFULLCONTENT: u32 = 2;

    struct Find {
        pid: u32,
        found: Vec<HWND>,
    }

    unsafe extern "system" fn top(h: HWND, l: LPARAM) -> BOOL {
        let f = &mut *(l as *mut Find);
        let mut pid = 0u32;
        GetWindowThreadProcessId(h, &mut pid);
        if pid == f.pid && IsWindowVisible(h) != 0 && IsIconic(h) == 0 && GetWindow(h, GW_OWNER).is_null() {
            f.found.push(h);
        }
        1
    }

    unsafe extern "system" fn child(h: HWND, l: LPARAM) -> BOOL {
        let f = &mut *(l as *mut Vec<(HWND, RECT)>);
        let mut name = [0u16; 64];
        let n = GetClassNameW(h, name.as_mut_ptr(), 64) as usize;
        if String::from_utf16_lossy(&name[..n]) == "Chrome_RenderWidgetHostHWND" && IsWindowVisible(h) != 0 {
            let mut r = RECT { left: 0, top: 0, right: 0, bottom: 0 };
            GetWindowRect(h, &mut r);
            if r.right - r.left > 50 && r.bottom - r.top > 50 {
                f.push((h, r));
            }
        }
        1
    }

    fn rect(h: HWND) -> RECT {
        let mut r = RECT { left: 0, top: 0, right: 0, bottom: 0 };
        unsafe { GetWindowRect(h, &mut r) };
        r
    }

    /// (width, height, RGBA rows) of the page area of the browser window nearest `want`.
    pub fn grab(pid: u32, want: Option<Want>) -> Result<(u32, u32, Vec<u8>), String> {
        unsafe {
            windows_sys::Win32::UI::HiDpi::SetThreadDpiAwarenessContext(windows_sys::Win32::UI::HiDpi::DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
            let mut f = Find { pid, found: Vec::new() };
            EnumWindows(Some(top), &mut f as *mut Find as LPARAM);
            // `want` is in the browser's own units (DIP): each window is compared at its own scale.
            let dist = |h: HWND| {
                let r = rect(h);
                let s = windows_sys::Win32::UI::HiDpi::GetDpiForWindow(h).max(96) as f64 / 96.0;
                let d = |a: i32| (a as f64 / s).round() as i32;
                want.map_or(0, |w| (d(r.left) - w.left).abs() + (d(r.top) - w.top).abs() + (d(r.right - r.left) - w.width).abs() + (d(r.bottom - r.top) - w.height).abs())
            };
            let win = f.found.iter().copied().min_by_key(|h| dist(*h)).ok_or("no browser window is showing (a minimised window has no picture)")?;
            let mut kids: Vec<(HWND, RECT)> = Vec::new();
            EnumChildWindows(win, Some(child), &mut kids as *mut _ as LPARAM);
            // The page is the biggest render area (a side panel or bubble is smaller).
            let page = kids.iter().max_by_key(|(_, r)| (r.right - r.left) * (r.bottom - r.top)).map(|(_, r)| *r).ok_or("the window shows no page")?;
            let wr = rect(win);
            let (ww, wh) = (wr.right - wr.left, wr.bottom - wr.top);
            let screen = GetDC(std::ptr::null_mut());
            let dc = CreateCompatibleDC(screen);
            let bmp = CreateCompatibleBitmap(screen, ww, wh);
            let old = SelectObject(dc, bmp);
            let ok = PrintWindow(win, dc, PW_RENDERFULLCONTENT) != 0;
            let _ = PW_CLIENTONLY;
            let (x, y) = (page.left - wr.left, page.top - wr.top);
            let (w, h) = ((page.right - page.left).min(ww - x), (page.bottom - page.top).min(wh - y));
            let mut info: BITMAPINFO = std::mem::zeroed();
            info.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
            info.bmiHeader.biWidth = ww;
            info.bmiHeader.biHeight = -wh;
            info.bmiHeader.biPlanes = 1;
            info.bmiHeader.biBitCount = 32;
            let mut all = vec![0u8; (ww * wh * 4) as usize];
            SelectObject(dc, old);
            let lines = GetDIBits(dc, bmp, 0, wh as u32, all.as_mut_ptr().cast(), &mut info, DIB_RGB_COLORS);
            DeleteObject(bmp);
            DeleteDC(dc);
            ReleaseDC(std::ptr::null_mut(), screen);
            if !ok || lines == 0 || w <= 0 || h <= 0 {
                return Err("Windows gave no picture of the window".into());
            }
            let mut out = Vec::with_capacity((w * h * 4) as usize);
            for row in y..y + h {
                let s = ((row * ww + x) * 4) as usize;
                for px in all[s..s + (w * 4) as usize].chunks(4) {
                    out.extend_from_slice(&[px[2], px[1], px[0], 255]);
                }
            }
            Ok((w as u32, h as u32, out))
        }
    }
}

/// Takes the picture, saves it as PNG; returns (id, width, height, bytes).
#[cfg(windows)]
pub fn capture(pid: u32, want: Option<Want>) -> Result<(String, u32, u32, usize), String> {
    let (w, h, rgba) = win::grab(pid, want)?;
    let mut png_bytes = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut png_bytes, w, h);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        enc.set_compression(png::Compression::Fast);
        enc.write_header().and_then(|mut wr| wr.write_image_data(&rgba)).map_err(|e| e.to_string())?;
    }
    let dir = shots_dir().ok_or("LOCALAPPDATA is not set")?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // Pictures nobody fetched (a closed menu) do not stay: older than 10 minutes go.
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.flatten() {
            if e.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|a| a.as_secs() > 600) {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
    let id = format!("{:x}{:x}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
    std::fs::write(dir.join(format!("{id}.png")), &png_bytes).map_err(|e| e.to_string())?;
    Ok((id, w, h, png_bytes.len()))
}

#[cfg(not(windows))]
pub fn capture(_pid: u32, _want: Option<Want>) -> Result<(String, u32, u32, usize), String> {
    Err("window pictures need Windows".into())
}

/// Joins PNG slices of one page, top to bottom, into one PNG written to `out`. A picture of a long
/// page comes in slices: the browser draws at most 16000 px in one go and a canvas holds at most
/// 32767. Rows are streamed: only one slice is in memory at a time. Slices narrower than the
/// first are padded with white; wider ones are cut. -> (width, height).
pub fn join_pngs(parts: &[Vec<u8>], out: impl std::io::Write) -> Result<(u32, u32), String> {
    fn rgba(png_bytes: &[u8]) -> Result<(u32, u32, Vec<u8>), String> {
        let mut dec = png::Decoder::new(std::io::Cursor::new(png_bytes));
        dec.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
        let mut rd = dec.read_info().map_err(|e| e.to_string())?;
        let mut buf = vec![0; rd.output_buffer_size()];
        let info = rd.next_frame(&mut buf).map_err(|e| e.to_string())?;
        let (w, h) = (info.width, info.height);
        let px: Vec<u8> = match info.color_type {
            png::ColorType::Rgba => buf[..info.buffer_size()].to_vec(),
            png::ColorType::Rgb => buf[..info.buffer_size()].chunks(3).flat_map(|p| [p[0], p[1], p[2], 255]).collect(),
            png::ColorType::GrayscaleAlpha => buf[..info.buffer_size()].chunks(2).flat_map(|p| [p[0], p[0], p[0], p[1]]).collect(),
            png::ColorType::Grayscale => buf[..info.buffer_size()].iter().flat_map(|&g| [g, g, g, 255]).collect(),
            other => return Err(format!("unexpected colours in a slice: {other:?}")),
        };
        Ok((w, h, px))
    }
    if parts.is_empty() {
        return Err("no slices".into());
    }
    // Sizes first (headers only), so the joined header can be written before any rows.
    let mut sizes = Vec::new();
    for p in parts {
        let rd = png::Decoder::new(std::io::Cursor::new(p.as_slice())).read_info().map_err(|e| e.to_string())?;
        sizes.push((rd.info().width, rd.info().height));
    }
    let width = sizes[0].0;
    let height: u32 = sizes.iter().map(|s| s.1).sum();
    let mut enc = png::Encoder::new(out, width, height);
    enc.set_color(png::ColorType::Rgba);
    enc.set_depth(png::BitDepth::Eight);
    enc.set_compression(png::Compression::Fast);
    let mut wr = enc.write_header().map_err(|e| e.to_string())?;
    let mut stream = wr.stream_writer().map_err(|e| e.to_string())?;
    use std::io::Write;
    let row_len = width as usize * 4;
    for p in parts {
        let (w, h, px) = rgba(p)?;
        let src_len = w as usize * 4;
        for y in 0..h as usize {
            let row = &px[y * src_len..(y + 1) * src_len];
            if src_len >= row_len {
                stream.write_all(&row[..row_len]).map_err(|e| e.to_string())?;
            } else {
                stream.write_all(row).map_err(|e| e.to_string())?;
                stream.write_all(&vec![255; row_len - src_len]).map_err(|e| e.to_string())?;
            }
        }
    }
    stream.finish().map_err(|e| e.to_string())?;
    Ok((width, height))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png_of(w: u32, h: u32, colour: [u8; 3]) -> Vec<u8> {
        let mut v = Vec::new();
        let mut enc = png::Encoder::new(&mut v, w, h);
        enc.set_color(png::ColorType::Rgb);
        enc.set_depth(png::BitDepth::Eight);
        let data: Vec<u8> = (0..w * h).flat_map(|_| colour).collect();
        enc.write_header().unwrap().write_image_data(&data).unwrap();
        v
    }

    #[test]
    fn slices_join_top_to_bottom() {
        let parts = vec![png_of(4, 3, [255, 0, 0]), png_of(4, 2, [0, 0, 255]), png_of(3, 1, [0, 255, 0])];
        let mut out = Vec::new();
        assert_eq!(join_pngs(&parts, &mut out).unwrap(), (4, 6));
        let mut rd = png::Decoder::new(std::io::Cursor::new(out)).read_info().unwrap();
        let mut buf = vec![0; rd.output_buffer_size()];
        rd.next_frame(&mut buf).unwrap();
        let px = |x: usize, y: usize| &buf[(y * 4 + x) * 4..(y * 4 + x) * 4 + 4];
        assert_eq!(px(0, 0), [255, 0, 0, 255]);
        assert_eq!(px(3, 4), [0, 0, 255, 255]);
        assert_eq!(px(0, 5), [0, 255, 0, 255]);
        assert_eq!(px(3, 5), [255, 255, 255, 255], "a narrower slice is padded with white");
        assert!(join_pngs(&[], Vec::new()).is_err());
    }

    #[test]
    fn base64_matches_the_standard() {
        assert_eq!(b64(b""), "");
        assert_eq!(b64(b"f"), "Zg==");
        assert_eq!(b64(b"fo"), "Zm8=");
        assert_eq!(b64(b"foobar"), "Zm9vYmFy");
    }
    #[test]
    fn ids_are_plain() {
        assert!(valid_id("1a2b3c"));
        assert!(!valid_id("../x"));
        assert!(!valid_id(""));
    }
}

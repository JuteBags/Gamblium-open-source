// A window program: no console window of its own (the helper talks to it through pipes).
#![windows_subsystem = "windows"]
#![recursion_limit = "256"]
//! gamblium-lyrics: Gamblium's floating lyrics window (issue #242, prototype).
//!
//! A see-through strip, always on top of every app (also while the browser is minimised), that
//! shows the synced lyrics of the song playing. Its own small program (not gamblium.exe), started
//! by the helper. Input is JSON lines on stdin:
//!   {"type":"track","title":"...","artist":"...","album":"...","duration":282.0}
//!   {"type":"clock","position":12.3,"paused":false,"rate":1.0}
//!   {"type":"lines","lines":[{"at":12.3,"text":"..."}],"source":"YouTube captions"}  (the page's own
//!     timed captions: used instead of a lookup)
//!   {"type":"preset","name":"neon"}   {"type":"quit"}
//! Its buttons (shown while the mouse is over it) answer on stdout: {"type":"action","what":"pip"|"tab"|"close"}.
//! or, to try it alone: `gamblium-lyrics --demo --title "Kalyani" --artist "ARJN" [--duration 282] [--at 30]`.
//!
//! The look lives in `%LOCALAPPDATA%\Gamblium\lyrics\style.json` (presets glass, neon, karaoke,
//! minimal, sunset, gold, plus any key overridden) and is re-read while running. Right-click the
//! strip for presets, script, lines, size, timing, click-through. Shortcuts: Ctrl+Alt+L
//! click-through on/off, Ctrl+Alt+K hide/show, Ctrl+Alt+P next preset, Ctrl+Alt+Left/Right timing.

mod hinglish;
mod icons;
mod lrc;
mod card;
mod knob;
mod render;
mod sheet;
mod style;
mod words;

#[cfg(not(windows))]
fn main() {
    eprintln!("gamblium-lyrics: Windows only for now");
}

#[cfg(windows)]
fn main() {
    // Font loading and text layout need more than the main thread's 1 MB stack on Windows.
    let t = std::thread::Builder::new().stack_size(16 << 20).spawn(win::run).expect("window thread");
    let _ = t.join();
}

#[cfg(windows)]
mod win {
    use crate::lrc::{self, Line, Track};
    use crate::render::{Item, Renderer};
    use crate::style::{self, Style, PRESETS};
    use crate::hinglish;
    use serde_json::{json, Value};
    use std::sync::mpsc::{channel, Receiver, Sender};
    use std::sync::{Mutex, OnceLock};
    use std::time::{Instant, SystemTime};
    use windows_sys::Win32::Foundation::*;
    use windows_sys::Win32::Graphics::Gdi::*;
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::HiDpi::*;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::*;
    use windows_sys::Win32::UI::WindowsAndMessaging::*;

    const WM_INPUT_READY: u32 = WM_APP + 1;
    const TIMER: usize = 1;

    enum Msg {
        Track(Track),
        Clock { pos_s: f64, paused: bool, rate: f64 },
        Lyrics { for_title: String, lines: Result<(Vec<Line>, bool, String), String> },
        /// The page's timed captions: kind "captions" (people's: shown as they are) or "auto"
        /// (automatic: the clock that looked-up lyrics are shifted onto).
        Lines(Vec<Line>, String, String),
        Preset(String),
        /// A jukebox / compilation: its songs and where each starts (ms).
        Chapters(Vec<(i64, String)>),
        /// The song's picture, decoded (None: none could be had).
        Art(String, Option<tiny_skia::Pixmap>),
        ChapterLyrics { idx: usize, video: String, lines: Result<(Vec<Line>, bool, String), String> },
        Quit,
    }

    struct App {
        hwnd: HWND,
        style: Style,
        style_seen: Option<SystemTime>,
        renderer: Renderer,
        track: Option<Track>,
        lines: Vec<Line>,
        synced: bool,
        status: String,
        base_ms: f64,
        base_at: Instant,
        rate: f64,
        paused: bool,
        hidden: bool,
        /// Bottom-centre of the strip on screen: the strip grows upwards from it.
        anchor: (i32, i32),
        last_key: String,
        started: Instant,
        rx: Receiver<Msg>,
        tx: Sender<Msg>,
        demo: bool,
        /// Lyrics came from the page (captions): a lookup answering later is ignored.
        from_page: bool,
        /// The video's automatic captions: timed to this very video.
        anchors: Vec<Line>,
        /// Looked-up lyrics as found, before any shift.
        found: Vec<Line>,
        hover: bool,
        buttons: Vec<([f32; 4], &'static str)>,
        /// The mouse in window pixels while over it; the button held down.
        pointer: Option<(f32, f32)>,
        pressed: Option<&'static str>,
        /// The hover reveal (0-1) and when it last changed direction.
        hover_from: f32,
        hover_at: Instant,
        /// When the search for this song's lyrics began (the card's "looking" sweep).
        looking_at: Instant,
        /// The line on show and when it came (line motion, the shine, the sparkles).
        line_idx: Option<usize>,
        line_at: Instant,
        /// The seek bar's knob while dragged (0-1 of the song).
        dragging: Option<f32>,
        panel_open: bool,
        art_url: String,
        art: Option<tiny_skia::Pixmap>,
        mood: Option<(u8, u8, u8)>,
        chapters: Vec<(i64, String)>,
        chapter_now: Option<usize>,
        chapter_lyrics: std::collections::HashMap<usize, Vec<Line>>,
        chapter_asked: std::collections::HashSet<usize>,
    }

    // The window handle is only used on the window's own thread.
    unsafe impl Send for App {}
    static APP: OnceLock<Mutex<App>> = OnceLock::new();

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(Some(0)).collect()
    }

    fn arg(args: &[String], name: &str) -> Option<String> {
        args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
    }

    fn state_file() -> Option<std::path::PathBuf> {
        style::dir().map(|d| d.join("window.json"))
    }

    pub fn run() {
        let args: Vec<String> = std::env::args().collect();
        if let Some(p) = arg(&args, "--preset") {
            style::set_preset(&p);
        }
        unsafe {
            SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        }
        // `--icons FILE`: every icon at 32 px on a dark sheet (for checking them by eye).
        if let Some(out) = arg(&args, "--icons") {
            let n = crate::icons::NAMES.len() as u32;
            if let Some(mut pm) = tiny_skia::Pixmap::new(n * 44 + 8, 52) {
                pm.fill(tiny_skia::Color::from_rgba8(20, 21, 26, 255));
                for (i, name) in crate::icons::NAMES.iter().enumerate() {
                    crate::icons::draw(&mut pm, name, 26.0 + i as f32 * 44.0, 26.0, 32.0, (233, 235, 240), 1.0);
                }
                let _ = pm.save_png(out);
            }
            return;
        }
        // `--style-json`: the look in use (preset plus the person's changes) and the presets, for
        // Gamblium's Settings page.
        if args.iter().any(|a| a == "--style-json") {
            let st = style::load(&Style::default());
            println!("{}", json!({ "style": st, "presets": PRESETS }));
            return;
        }
        // `--find`: which lyrics a song gets, and their shift onto `--anchors FILE` (JSON lines
        // [{at, text}], the video's automatic captions). For checking matches; no window.
        if args.iter().any(|a| a == "--find") {
            let t = Track {
                title: arg(&args, "--title").unwrap_or_default(),
                artist: arg(&args, "--artist").unwrap_or_default(),
                album: String::new(),
                art: String::new(),
                duration_s: arg(&args, "--duration").and_then(|d| d.parse().ok()).unwrap_or(0.0),
            };
            println!("guesses: {:?}", lrc::guesses(&t));
            match lrc::find(&t) {
                Ok(f) => {
                    println!("found: {}", f.source);
                    let lines = f.synced.as_deref().map(lrc::parse).unwrap_or_default();
                    let anchors: Vec<Line> = arg(&args, "--anchors")
                        .and_then(|p| std::fs::read_to_string(p).ok())
                        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
                        .and_then(|v| v.as_array().map(|a| a.iter().map(|l| Line { at_ms: (l["at"].as_f64().unwrap_or(0.0) * 1000.0) as i64, text: l["text"].as_str().unwrap_or("").to_owned() }).collect()))
                        .unwrap_or_default();
                    println!("shift onto the captions: {:?} ms ({} captions)", lrc::shift_to(&lines, &anchors), anchors.len());
                }
                Err(e) => println!("none: {e}"),
            }
            return;
        }
        // `--snapshot DIR`: every look drawn to DIR\<preset>.png at the time `--at`, no window.
        if let Some(out) = arg(&args, "--snapshot") {
            let t = Track {
                title: arg(&args, "--title").unwrap_or_else(|| "Kalyani".into()),
                artist: arg(&args, "--artist").unwrap_or_default(),
                album: String::new(),
                art: String::new(),
                duration_s: arg(&args, "--duration").and_then(|d| d.parse().ok()).unwrap_or(0.0),
            };
            let at_ms = (arg(&args, "--at").and_then(|d| d.parse::<f64>().ok()).unwrap_or(60.0) * 1000.0) as i64;
            let lines = match lrc::find(&t) {
                Ok(f) => f.synced.as_deref().map(lrc::parse).unwrap_or_default(),
                Err(e) => {
                    eprintln!("{e}");
                    Vec::new()
                }
            };
            let cur = lrc::current(&lines, at_ms).unwrap_or(0);
            let mut r = Renderer::new();
            let _ = std::fs::create_dir_all(&out);
            let art = arg(&args, "--art").and_then(|u| fetch_art(&u));
            let mood = art.as_ref().map(average);
            let (song, singer) = lrc::guesses(&t).into_iter().next().unwrap_or_default();
            // `--sheets`: the menu and the panel too.
            if arg(&args, "--sheets").is_some() {
                let st: Style = serde_json::from_value(style::preset("crystal")).unwrap();
                for (kind, name) in [(crate::sheet::Kind::Menu, "menu"), (crate::sheet::Kind::Panel, "panel")] {
                    let (pm, _) = r.draw_sheet(kind, &st, mood, &Default::default(), 1.0);
                    let _ = pm.save_png(std::path::Path::new(&out).join(format!("{name}.png")));
                }
            }
            for p in PRESETS {
                let mut st: Style = serde_json::from_value(style::preset(p)).unwrap();
                if let Some(l) = arg(&args, "--layout") {
                    st.layout = l;
                }
                if arg(&args, "--glass").is_some() {
                    st.glass = true;
                }
                if st.layout == "words" {
                    st.background_opacity = 0.0;
                    st.progress_bar = st.words_seek_bar;
                }
                if arg(&args, "--sparkle").is_some() {
                    st.sparkle = true;
                }
                if let Some(sc) = arg(&args, "--script") {
                    st.script = sc;
                }
                // The Hindi lines as most people read them.
                let shown = |x: &str| if hinglish::is_devanagari(x) && st.script == "hinglish" { hinglish::line(x) } else { x.to_owned() };
                let mut items = Vec::new();
                for (i, (k, current)) in [(cur, true), (cur + 1, false)].iter().enumerate() {
                    if i as u8 >= st.lines.max(1) {
                        break;
                    }
                    if let Some(l) = lines.get(*k) {
                        items.push(Item { text: shown(&l.text), scale: if *current { 1.0 } else { 0.72 }, opacity: if *current { 1.0 } else { 0.46 }, current: *current, dy: 0.0 });
                        if *current && st.script == "both" && hinglish::is_devanagari(&l.text) {
                            items.push(Item { text: hinglish::line(&l.text), scale: 0.62, opacity: 0.66, current: false, dy: 0.0 });
                        }
                    }
                }
                let hover = if arg(&args, "--hover").is_some() { 1.0 } else { 0.0 };
                let paused = arg(&args, "--paused").is_some();
                let stage = match arg(&args, "--stage").as_deref() {
                    Some("looking") => crate::card::Stage::Looking,
                    Some("none") => crate::card::Stage::None,
                    _ => crate::card::Stage::Lyrics,
                };
                let shine = if st.shine { 0.45 } else { -1.0 };
                let pm = if st.layout == "card" {
                    let card = crate::card::Card {
                        title: &song, artist: &singer, art: art.as_ref(), art_key: "snap", mood, playing: !paused,
                        position_s: at_ms as f64 / 1000.0, duration_s: t.duration_s, hover, pointer: None, pressed: None,
                        panel_open: false, stage, looking_s: 0.5, compilation: None, notches: &[], shine, sparkle: Some(0.4),
                    };
                    r.draw_card(&st, &card, &items, 1.0).0
                } else if st.layout == "words" {
                    let wd = crate::words::Words {
                        title: &song, playing: !paused, position_s: at_ms as f64 / 1000.0, duration_s: t.duration_s, hover,
                        pointer: None, pressed: None, dragging: None, panel_open: false, stage, mood, shine, sparkle: Some(0.4), click_through: false,
                    };
                    r.draw_words(&st, &wd, &items, 1.0).0
                } else {
                    r.draw(&st, &items, if st.progress_bar { Some(at_ms as f32 / (t.duration_s.max(1.0) as f32 * 1000.0)) } else { None }, 0.45, 1.0, &[]).0
                };
                // `--bench`: how long a frame takes in each look (the slab and text layouts cached,
                // as in a running window).
                if arg(&args, "--bench").is_some() {
                    let n = 20;
                    let t0 = Instant::now();
                    for i in 0..n {
                        let sh = (i as f32 / n as f32).min(0.99);
                        if st.layout == "card" {
                            let card = crate::card::Card {
                                title: &song, artist: &singer, art: art.as_ref(), art_key: "snap", mood, playing: true,
                                position_s: at_ms as f64 / 1000.0, duration_s: t.duration_s, hover: 0.0, pointer: None, pressed: None,
                                panel_open: false, stage, looking_s: 9.0, compilation: None, notches: &[], shine: sh, sparkle: Some(sh),
                            };
                            let _ = r.draw_card(&st, &card, &items, 1.0);
                        } else {
                            let wd = crate::words::Words {
                                title: &song, playing: true, position_s: at_ms as f64 / 1000.0, duration_s: t.duration_s, hover: 0.0,
                                pointer: None, pressed: None, dragging: None, panel_open: false, stage, mood, shine: sh, sparkle: Some(sh), click_through: false,
                            };
                            let _ = r.draw_words(&st, &wd, &items, 1.0);
                        }
                    }
                    let animated = t0.elapsed().as_secs_f64() * 1000.0 / n as f64;
                    // Steady: nothing moves but the time (the once-a-second repaint).
                    let t1 = Instant::now();
                    for i in 0..n {
                        let pos = at_ms as f64 / 1000.0 + i as f64;
                        if st.layout == "card" {
                            let card = crate::card::Card {
                                title: &song, artist: &singer, art: art.as_ref(), art_key: "snap", mood, playing: true,
                                position_s: pos, duration_s: t.duration_s, hover, pointer: None, pressed: None,
                                panel_open: false, stage, looking_s: 9.0, compilation: None, notches: &[], shine: -1.0, sparkle: None,
                            };
                            let _ = r.draw_card(&st, &card, &items, 1.0);
                        } else {
                            let wd = crate::words::Words {
                                title: &song, playing: true, position_s: pos, duration_s: t.duration_s, hover,
                                pointer: None, pressed: None, dragging: None, panel_open: false, stage, mood, shine: -1.0, sparkle: None, click_through: false,
                            };
                            let _ = r.draw_words(&st, &wd, &items, 1.0);
                        }
                    }
                    println!("{p} {}: {animated:.1} ms a frame animated, {:.2} ms steady", st.layout, t1.elapsed().as_secs_f64() * 1000.0 / n as f64);
                    continue;
                }
                let path = std::path::Path::new(&out).join(format!("{p}.png"));
                println!("{} {}", path.display(), pm.save_png(&path).is_ok());
            }
            return;
        }
        let demo =args.iter().any(|a| a == "--demo");
        let (tx, rx) = channel::<Msg>();
        let hwnd = unsafe { make_window() };
        if hwnd.is_null() {
            eprintln!("gamblium-lyrics: could not make the window");
            return;
        }
        // Where it was last, else bottom-centre of the main screen's work area.
        let mut work = RECT { left: 0, top: 0, right: 1280, bottom: 720 };
        unsafe { SystemParametersInfoW(SPI_GETWORKAREA, 0, &mut work as *mut _ as *mut _, 0) };
        let saved = state_file().and_then(|f| std::fs::read_to_string(f).ok()).and_then(|t| serde_json::from_str::<Value>(&t).ok());
        let anchor = saved
            .and_then(|v| Some((v.get("x")?.as_i64()? as i32, v.get("y")?.as_i64()? as i32)))
            .unwrap_or(((work.left + work.right) / 2, work.bottom - 80));
        let st = style::load(&Style::default());
        let app = App {
            hwnd,
            style: st,
            style_seen: None,
            renderer: Renderer::new(),
            track: None,
            lines: Vec::new(),
            synced: false,
            status: "Waiting for a song".into(),
            base_ms: 0.0,
            base_at: Instant::now(),
            rate: 1.0,
            paused: true,
            hidden: false,
            anchor,
            last_key: String::new(),
            started: Instant::now(),
            rx,
            tx: tx.clone(),
            demo,
            from_page: false,
            anchors: Vec::new(),
            found: Vec::new(),
            hover: false,
            buttons: Vec::new(),
            pointer: None,
            pressed: None,
            hover_from: 0.0,
            hover_at: Instant::now(),
            looking_at: Instant::now(),
            line_idx: None,
            line_at: Instant::now(),
            dragging: None,
            panel_open: false,
            art_url: String::new(),
            art: None,
            mood: None,
            chapters: Vec::new(),
            chapter_now: None,
            chapter_lyrics: Default::default(),
            chapter_asked: Default::default(),
        };
        let _ = APP.set(Mutex::new(app));

        if demo {
            let t = Track {
                title: arg(&args, "--title").unwrap_or_else(|| "Kalyani".into()),
                artist: arg(&args, "--artist").unwrap_or_default(),
                album: String::new(),
                art: String::new(),
                duration_s: arg(&args, "--duration").and_then(|d| d.parse().ok()).unwrap_or(0.0),
            };
            let at: f64 = arg(&args, "--at").and_then(|d| d.parse().ok()).unwrap_or(0.0);
            let _ = tx.send(Msg::Track(t));
            let _ = tx.send(Msg::Clock { pos_s: at, paused: false, rate: 1.0 });
        } else {
            // Lines from the helper; the end of input (the helper gone) ends the window too.
            let tx2 = tx.clone();
            let h = hwnd as isize;
            std::thread::spawn(move || {
                use std::io::BufRead;
                for line in std::io::stdin().lock().lines() {
                    let Ok(line) = line else { break };
                    let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
                    let m = match v.get("type").and_then(|t| t.as_str()) {
                        Some("track") => Msg::Track(Track {
                            title: v["title"].as_str().unwrap_or("").into(),
                            artist: v["artist"].as_str().unwrap_or("").into(),
                            album: v["album"].as_str().unwrap_or("").into(),
                            art: v["art"].as_str().unwrap_or("").into(),
                            duration_s: v["duration"].as_f64().unwrap_or(0.0),
                        }),
                        Some("clock") => Msg::Clock {
                            pos_s: v["position"].as_f64().unwrap_or(0.0),
                            paused: v["paused"].as_bool().unwrap_or(false),
                            rate: v["rate"].as_f64().unwrap_or(1.0),
                        },
                        Some("lines") => Msg::Lines(
                            v["lines"].as_array().map(|a| a.iter().map(|l| Line { at_ms: (l["at"].as_f64().unwrap_or(0.0) * 1000.0) as i64, text: l["text"].as_str().unwrap_or("").to_owned() }).collect()).unwrap_or_default(),
                            v["source"].as_str().unwrap_or("the page").to_owned(),
                            v["kind"].as_str().unwrap_or("captions").to_owned(),
                        ),
                        Some("preset") => Msg::Preset(v["name"].as_str().unwrap_or("glass").into()),
                        Some("chapters") => Msg::Chapters(
                            v["chapters"].as_array().map(|a| a.iter().map(|c| ((c["at"].as_f64().unwrap_or(0.0) * 1000.0) as i64, c["title"].as_str().unwrap_or("").to_owned())).collect()).unwrap_or_default(),
                        ),
                        Some("quit") => Msg::Quit,
                        _ => continue,
                    };
                    let _ = tx2.send(m);
                    unsafe { PostMessageW(h as HWND, WM_INPUT_READY, 0, 0) };
                }
                let _ = tx2.send(Msg::Quit);
                unsafe { PostMessageW(h as HWND, WM_INPUT_READY, 0, 0) };
            });
        }
        unsafe {
            RegisterHotKey(hwnd, 1, MOD_CONTROL | MOD_ALT | MOD_NOREPEAT, 'L' as u32);
            RegisterHotKey(hwnd, 2, MOD_CONTROL | MOD_ALT | MOD_NOREPEAT, 'K' as u32);
            RegisterHotKey(hwnd, 3, MOD_CONTROL | MOD_ALT | MOD_NOREPEAT, 'P' as u32);
            RegisterHotKey(hwnd, 4, MOD_CONTROL | MOD_ALT, VK_LEFT as u32);
            RegisterHotKey(hwnd, 5, MOD_CONTROL | MOD_ALT, VK_RIGHT as u32);
            PostMessageW(hwnd, WM_INPUT_READY, 0, 0);
            SetTimer(hwnd, TIMER, 250, None);
            let mut msg: MSG = std::mem::zeroed();
            while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
    }

    unsafe fn make_window() -> HWND {
        let inst = GetModuleHandleW(std::ptr::null());
        let class = wide("GambliumLyrics");
        let wc = WNDCLASSW {
            style: 0,
            lpfnWndProc: Some(wndproc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: inst,
            hIcon: std::ptr::null_mut(),
            hCursor: LoadCursorW(std::ptr::null_mut(), IDC_SIZEALL),
            hbrBackground: std::ptr::null_mut(),
            lpszMenuName: std::ptr::null(),
            lpszClassName: class.as_ptr(),
        };
        RegisterClassW(&wc);
        let sheet_class = wide("GambliumLyricsSheet");
        let wc2 = WNDCLASSW { lpfnWndProc: Some(sheet_proc), lpszClassName: sheet_class.as_ptr(), hCursor: LoadCursorW(std::ptr::null_mut(), IDC_ARROW), ..wc };
        RegisterClassW(&wc2);
        let title = wide("Gamblium lyrics");
        let ex = WS_EX_LAYERED | WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE;
        let h = CreateWindowExW(ex, class.as_ptr(), title.as_ptr(), WS_POPUP, 0, 0, 10, 10, std::ptr::null_mut(), std::ptr::null_mut(), inst, std::ptr::null());
        if !h.is_null() {
            ShowWindow(h, SW_SHOWNOACTIVATE);
        }
        h
    }

    impl App {
        fn now_ms(&self) -> f64 {
            if let Some(f) = self.dragging {
                let (start, dur) = self.span();
                return (start + f as f64 * dur) * 1000.0 - self.style.offset_ms as f64;
            }
            let run = if self.paused { 0.0 } else { self.base_at.elapsed().as_secs_f64() * 1000.0 * self.rate };
            self.base_ms + run - self.style.offset_ms as f64
        }

        fn shown(&self, text: &str) -> Vec<(String, f32)> {
            let deva = hinglish::is_devanagari(text);
            match (self.style.script.as_str(), deva) {
                ("original", _) | (_, false) => vec![(text.to_owned(), 1.0)],
                ("both", true) => vec![(text.to_owned(), 1.0), (hinglish::line(text), 0.62)],
                _ => vec![(hinglish::line(text), 1.0)],
            }
        }

        /// Where the bar runs: the current song of a compilation, else the whole video (seconds).
        fn span(&self) -> (f64, f64) {
            let total = self.track.as_ref().map(|t| t.duration_s).unwrap_or(0.0);
            match self.chapter_now.and_then(|i| self.chapters.get(i).map(|c| (i, c.0))) {
                Some((i, start)) => {
                    let end = self.chapters.get(i + 1).map(|c| c.0 as f64 / 1000.0).unwrap_or(total);
                    (start as f64 / 1000.0, (end - start as f64 / 1000.0).max(0.0))
                }
                None => (0.0, total),
            }
        }

        /// How far the newest line has come in (0-1, eased), by `line_motion`.
        fn line_ease(&self) -> f32 {
            if self.style.line_motion == "off" || self.dragging.is_some() || self.paused {
                return 1.0;
            }
            let t = (self.line_at.elapsed().as_secs_f32() / 0.26).clamp(0.0, 1.0);
            1.0 - (1.0 - t).powi(3)
        }

        fn items(&self) -> Vec<Item> {
            let st = &self.style;
            if self.lines.is_empty() {
                let what = match &self.track {
                    Some(t) if !t.title.is_empty() => {
                        let name = self.chapter_now.and_then(|i| self.chapters.get(i)).map(|c| c.1.clone()).unwrap_or_else(|| lrc::clean_title(&t.title));
                        format!("♪ {name}  ·  {}", self.status)
                    }
                    _ => format!("♪ {}", self.status),
                };
                return vec![Item { text: what, scale: 0.6, opacity: 0.85, current: false, dy: 0.0 }];
            }
            let ms = self.now_ms() as i64;
            let cur = lrc::current(&self.lines, ms);
            let e = self.line_ease();
            let rise = if st.line_motion == "slide" { 10.0 * (1.0 - e) } else { 0.0 };
            let dpi = unsafe { GetDpiForWindow(self.hwnd) }.max(96) as f32 / 96.0;
            let mut out = Vec::new();
            // Current: full size; next: 0.72 and 0.46; previous: 0.60 and 0.30 (spec 2.4).
            let mut push = |idx: Option<usize>, role: u8| {
                let Some(i) = idx else { return };
                let Some(l) = self.lines.get(i) else { return };
                let text = if l.text.is_empty() { "♪".to_owned() } else { l.text.clone() };
                let current = role == 1 && cur.is_some();
                let (scale, op) = match role {
                    0 => (0.60, 0.30),
                    1 => (1.0, 1.0),
                    _ => (0.72, 0.46),
                };
                let (dy, fade) = if role == 0 { (0.0, 1.0) } else { (rise * dpi, e) };
                for (k, (t, sub)) in self.shown(&text).into_iter().enumerate() {
                    out.push(Item { text: t, scale: scale * sub, opacity: op * fade * if k == 0 { 1.0 } else { 0.66 }, current: current && k == 0, dy });
                }
            };
            match st.lines {
                1 => push(cur.or(Some(0)), 1),
                3 => {
                    push(cur.and_then(|c| c.checked_sub(1)), 0);
                    push(cur.or(Some(0)), 1);
                    push(Some(cur.map(|c| c + 1).unwrap_or(1)), 2);
                }
                _ => {
                    push(cur.or(Some(0)), 1);
                    push(Some(cur.map(|c| c + 1).unwrap_or(1)), 2);
                }
            }
            out
        }

        fn progress(&self) -> Option<f32> {
            let d = self.track.as_ref().map(|t| t.duration_s).unwrap_or(0.0);
            if !self.style.progress_bar || d <= 0.0 {
                return None;
            }
            Some((self.now_ms() / (d * 1000.0)) as f32)
        }

        fn shine_phase(&self) -> f32 {
            let s = self.style.shine_seconds.max(0.3) as f64;
            ((self.started.elapsed().as_secs_f64() % s) / s) as f32
        }

        /// The hover reveal now (120 ms in, 180 ms out).
        fn hover_amt(&self) -> f32 {
            let t = self.hover_at.elapsed().as_secs_f32();
            if self.hover {
                (self.hover_from + t / 0.12).min(1.0)
            } else {
                (self.hover_from - t / 0.18).max(0.0)
            }
        }

        /// Something is moving: frames at 30 a second until it stops.
        fn animating(&self) -> bool {
            let since = self.line_at.elapsed().as_secs_f32();
            let playing = !self.paused && !self.lines.is_empty();
            let hover_moving = { let h = self.hover_amt(); h > 0.0 && h < 1.0 };
            let looking = self.lines.is_empty() && self.status.starts_with("looking") && self.looking_at.elapsed().as_secs_f32() < 4.3;
            let effects = playing && ((self.style.shine && since < 0.38 + self.style.shine_sweep_ms / 1000.0) || (self.style.sparkle && since < 1.8));
            since < 0.3 || hover_moving || looking || effects || self.dragging.is_some()
        }

        /// The current line's place in its effects: the shine's position (-1 = none) and the sparkles.
        fn effects(&self) -> (f32, Option<f32>) {
            if self.paused || self.lines.is_empty() {
                return (-1.0, None);
            }
            let since = self.line_at.elapsed().as_secs_f32() - 0.38;
            let sweep = (self.style.shine_sweep_ms / 1000.0).max(0.2);
            let shine = if self.style.shine && (0.0..=sweep).contains(&since) { since / sweep } else { -1.0 };
            let sparkle = if self.style.sparkle && (0.0..=1.4).contains(&since) { Some(since / 1.4) } else { None };
            (shine, sparkle)
        }

        /// Draws when what is shown changed, and every frame while something moves.
        fn paint(&mut self, force: bool) {
            if self.hidden {
                return;
            }
            self.chapter_tick();
            // A new line: its motion, shine and sparkles start now.
            let cur = if self.lines.is_empty() { None } else { lrc::current(&self.lines, self.now_ms() as i64) };
            if cur != self.line_idx {
                self.line_idx = cur;
                self.line_at = Instant::now();
            }
            let items = self.items();
            let (start, dur) = self.span();
            let pos = ((self.now_ms() + self.style.offset_ms as f64) / 1000.0 - start).max(0.0);
            let hover = self.hover_amt();
            let moving = self.animating();
            let key = format!(
                "{}|{}|{:?}|{:?}|{:?}|{}|{}|{}|{}|{}",
                items.iter().map(|i| i.text.as_str()).collect::<Vec<_>>().join("\n"),
                pos as i64,
                self.pointer.map(|(x, y)| (x as i32 / 2, y as i32 / 2)),
                self.pressed,
                self.dragging,
                hover > 0.5,
                self.paused,
                self.art.is_some(),
                self.panel_open,
                self.style.preset
            );
            if !force && !moving && key == self.last_key {
                return;
            }
            self.last_key = key;
            let dpi = unsafe { GetDpiForWindow(self.hwnd) }.max(96) as f32;
            let scale = dpi / 96.0;
            let (shine, sparkle) = self.effects();
            let stage = if !self.lines.is_empty() {
                crate::card::Stage::Lyrics
            } else if self.status.starts_with("looking") {
                crate::card::Stage::Looking
            } else {
                crate::card::Stage::None
            };
            let (title, artist) = self.names();
            let comp_name = self.track.as_ref().map(|t| lrc::clean_title(&t.title)).unwrap_or_default();
            let pm = match self.style.layout.as_str() {
                "card" => {
                    let card = crate::card::Card {
                        title: &title,
                        artist: &artist,
                        art: self.art.as_ref(),
                        art_key: &self.art_url,
                        mood: self.mood,
                        playing: !self.paused,
                        position_s: pos,
                        duration_s: dur,
                        hover,
                        pointer: self.pointer,
                        pressed: self.pressed,
                        panel_open: self.panel_open,
                        stage,
                        looking_s: self.looking_at.elapsed().as_secs_f32(),
                        compilation: self.chapter_now.map(|i| (i + 1, self.chapters.len(), comp_name.as_str())),
                        notches: &[],
                        shine,
                        sparkle,
                    };
                    let (pm, hits) = self.renderer.draw_card(&self.style, &card, &items, scale);
                    self.buttons = hits;
                    pm
                }
                "words" => {
                    let w = crate::words::Words {
                        title: &title,
                        playing: !self.paused,
                        position_s: pos,
                        duration_s: dur,
                        hover,
                        pointer: self.pointer,
                        pressed: self.pressed,
                        dragging: self.dragging,
                        panel_open: self.panel_open,
                        stage,
                        mood: self.mood,
                        shine,
                        sparkle,
                        click_through: self.style.click_through,
                    };
                    let (pm, hits) = self.renderer.draw_words(&self.style, &w, &items, scale);
                    self.buttons = hits;
                    pm
                }
                _ => {
                    // Lyrics in a box (the earlier strip).
                    let prog = if dur > 0.0 && self.style.progress_bar { Some((pos / dur) as f32) } else { None };
                    let labels: &[&str] = if self.hover { &["⚙", "▶  Video", "↩  Tab", "▭  Card", "✕"] } else { &[] };
                    let (pm, rects) = self.renderer.draw(&self.style, &items, prog, shine, scale, labels);
                    let n = labels.len();
                    let mut named: Vec<([f32; 4], &'static str)> = rects.iter().take(n).cloned().zip(["settings", "pip", "tab", "shape", "close"]).collect();
                    if let Some(bar) = rects.get(n) {
                        named.push((*bar, "seek"));
                    }
                    self.buttons = named;
                    pm
                }
            };
            unsafe { present(self.hwnd, &pm, self.anchor) };
        }

        fn set_click_through(&mut self, on: bool) {
            unsafe {
                let ex = GetWindowLongPtrW(self.hwnd, GWL_EXSTYLE) as u32;
                let ex = if on { ex | WS_EX_TRANSPARENT } else { ex & !WS_EX_TRANSPARENT };
                SetWindowLongPtrW(self.hwnd, GWL_EXSTYLE, ex as isize);
            }
        }

        fn reload_style(&mut self, force: bool) {
            let seen = style::file().and_then(|f| std::fs::metadata(f).ok()).and_then(|m| m.modified().ok());
            if !force && seen == self.style_seen {
                return;
            }
            self.style_seen = seen;
            let before = self.style.click_through;
            self.style = style::load(&self.style);
            if self.style.click_through != before || force {
                self.set_click_through(self.style.click_through);
            }
            self.last_key.clear();
        }

        fn take_input(&mut self) -> bool {
            let mut quit = false;
            while let Ok(m) = self.rx.try_recv() {
                match m {
                    Msg::Track(t) => {
                        let same = self.track.as_ref().is_some_and(|o| o.title == t.title && o.artist == t.artist);
                        if !same {
                            self.from_page = false;
                            self.chapters.clear();
                            self.chapter_now = None;
                            self.chapter_lyrics.clear();
                            self.chapter_asked.clear();
                            self.anchors.clear();
                            self.found.clear();
                            self.lines.clear();
                            self.status = "looking for lyrics…".into();
                            self.looking_at = Instant::now();
                            let tx = self.tx.clone();
                            let h = self.hwnd as isize;
                            let tt = t.clone();
                            std::thread::spawn(move || {
                                let r = lrc::find(&tt).and_then(|f| {
                                    if let Some(s) = f.synced.as_deref().filter(|s| !s.trim().is_empty()) {
                                        Ok((lrc::parse(s), true, f.source))
                                    } else if let Some(p) = f.plain.as_deref() {
                                        Ok((lrc::spread(p, tt.duration_s), false, f.source))
                                    } else {
                                        Err("no lyrics".into())
                                    }
                                });
                                let _ = tx.send(Msg::Lyrics { for_title: tt.title.clone(), lines: r });
                                unsafe { PostMessageW(h as HWND, WM_INPUT_READY, 0, 0) };
                            });
                        }
                        if let Some(old) = &mut self.track {
                            if same && t.duration_s > 0.0 {
                                old.duration_s = t.duration_s;
                            }
                        }
                        if !t.art.is_empty() && t.art != self.art_url {
                            self.art_url = t.art.clone();
                            let (tx, h, url) = (self.tx.clone(), self.hwnd as isize, t.art.clone());
                            std::thread::spawn(move || {
                                let pic = fetch_art(&url);
                                let _ = tx.send(Msg::Art(url, pic));
                                unsafe { PostMessageW(h as HWND, WM_INPUT_READY, 0, 0) };
                            });
                        }
                        if !same {
                            self.track = Some(t);
                        }
                    }
                    Msg::Clock { pos_s, paused, rate } => {
                        self.base_ms = pos_s * 1000.0;
                        self.base_at = Instant::now();
                        self.paused = paused;
                        self.rate = if rate > 0.0 { rate } else { 1.0 };
                    }
                    Msg::Lyrics { for_title, lines } => {
                        if self.from_page || !self.chapters.is_empty() || self.track.as_ref().map(|t| t.title.as_str()) != Some(for_title.as_str()) {
                            continue;
                        }
                        match lines {
                            Ok((l, synced, source)) => {
                                eprintln!("lyrics: {} lines ({}), {source}", l.len(), if synced { "synced" } else { "not synced" });
                                self.found = l;
                                self.synced = synced;
                                self.place_found();
                            }
                            Err(e) => {
                                eprintln!("lyrics: {e}");
                                if self.lines.is_empty() {
                                    self.status = "no lyrics found".into();
                                }
                            }
                        }
                    }
                    Msg::Lines(l, source, kind) => {
                        if l.is_empty() {
                            continue;
                        }
                        eprintln!("lyrics: {} lines from {source} ({kind})", l.len());
                        if kind == "auto" {
                            if !lrc::usable_auto(&l) {
                                eprintln!("lyrics: automatic captions look wrong (another language?): not used");
                                continue;
                            }
                            self.anchors = l;
                            if self.found.is_empty() {
                                // Until (unless) the real lyrics are found: the automatic captions.
                                if !self.from_page {
                                    self.lines = self.anchors.clone();
                                }
                            } else {
                                self.place_found();
                            }
                        } else {
                            self.lines = l;
                            self.synced = true;
                            self.from_page = true;
                        }
                    }
                    Msg::Preset(p) => style::set_preset(&p),
                    Msg::Art(url, pic) => {
                        if url == self.art_url {
                            self.mood = pic.as_ref().map(average);
                            self.art = pic;
                        }
                    }
                    Msg::Chapters(c) => {
                        if c.len() >= 2 && !self.from_page {
                            eprintln!("lyrics: {} songs in this video", c.len());
                            self.chapters = c;
                            self.chapter_now = None;
                            self.lines.clear();
                        }
                    }
                    Msg::ChapterLyrics { idx, video, lines } => {
                        if self.track.as_ref().map(|t| t.title.as_str()) != Some(video.as_str()) || idx >= self.chapters.len() {
                            continue;
                        }
                        match lines {
                            Ok((l, synced, source)) => {
                                let start = self.chapters[idx].0;
                                let end = self.chapters.get(idx + 1).map(|c| c.0).unwrap_or(i64::MAX);
                                let mut placed: Vec<Line> = l.into_iter().map(|x| Line { at_ms: x.at_ms + start, text: x.text }).collect();
                                // Fine-tuned against the automatic captions of this song's stretch.
                                let near: Vec<Line> = self.anchors.iter().filter(|a| a.at_ms >= start - 5000 && a.at_ms <= end.saturating_add(5000)).cloned().collect();
                                if synced {
                                    if let Some(ms) = lrc::shift_to(&placed, &near) {
                                        for x in placed.iter_mut() {
                                            x.at_ms += ms;
                                        }
                                    }
                                }
                                // The song's last line does not run on into the next song.
                                placed.retain(|x| x.at_ms < end);
                                if end != i64::MAX {
                                    placed.push(Line { at_ms: end - 1, text: String::new() });
                                }
                                eprintln!("lyrics: song {} ({}): {} lines, {source}", idx + 1, self.chapters[idx].1, placed.len());
                                self.chapter_lyrics.insert(idx, placed);
                            }
                            Err(e) => {
                                eprintln!("lyrics: song {}: {e}", idx + 1);
                                self.chapter_lyrics.insert(idx, Vec::new());
                            }
                        }
                        if self.chapter_now == Some(idx) {
                            self.chapter_now = None; // shown at the next tick
                        }
                    }
                    Msg::Quit => quit = !self.demo,
                }
            }
            self.last_key.clear();
            quit
        }

        /// Looked-up lyrics onto this video's clock: shifted by the gap to its automatic captions
        /// when enough lines match (an intro the song's own timings do not have).
        fn place_found(&mut self) {
            if self.from_page || self.found.is_empty() {
                return;
            }
            let shift = if self.synced { lrc::shift_to(&self.found, &self.anchors) } else { None };
            if let Some(ms) = shift {
                eprintln!("lyrics: shifted {ms} ms onto the video's captions");
            }
            let ms = shift.unwrap_or(0);
            self.lines = self.found.iter().map(|l| Line { at_ms: l.at_ms + ms, text: l.text.clone() }).collect();
            self.last_key.clear();
        }

        /// A compilation's song: its looked-up lyrics, else (none found) the automatic captions
        /// of its stretch of the video.
        fn chapter_lyric_lines(&self, idx: usize) -> Vec<Line> {
            match self.chapter_lyrics.get(&idx) {
                Some(l) if !l.is_empty() => l.clone(),
                Some(_) => {
                    let start = self.chapters[idx].0;
                    let end = self.chapters.get(idx + 1).map(|c| c.0).unwrap_or(i64::MAX);
                    self.anchors.iter().filter(|a| a.at_ms >= start && a.at_ms < end).cloned().collect()
                }
                None => Vec::new(),
            }
        }

        /// The artist of a compilation: "Best of Anuv Jain | Jukebox" -> "Anuv Jain", else the channel.
        fn base_artist(&self) -> String {
            let t = self.track.as_ref().map(|t| t.title.clone()).unwrap_or_default();
            let lower = t.to_lowercase();
            for key in ["best of ", "hits of ", "songs of ", "top songs of "] {
                if let Some(i) = lower.find(key) {
                    let rest = &t[i + key.len()..];
                    let name: String = rest.split(|c: char| c == '|' || c == '-' || c == '(' || c == '[' || c == ',').next().unwrap_or("").trim().to_owned();
                    let name = name.trim_end_matches(|c: char| c.is_ascii_digit() || c.is_whitespace()).to_owned();
                    for tail in [" Songs", " songs", " Jukebox", " jukebox", " Hits", " hits"] {
                        if let Some(n) = name.strip_suffix(tail) {
                            return n.trim().to_owned();
                        }
                    }
                    if !name.is_empty() {
                        return name;
                    }
                }
            }
            lrc::clean_artist(&self.track.as_ref().map(|t| t.artist.clone()).unwrap_or_default())
        }

        /// Which song of a compilation is playing; its lyrics shown, this one's and the next one's
        /// looked up (once each).
        fn chapter_tick(&mut self) {
            if self.chapters.is_empty() {
                return;
            }
            let now = self.now_ms() as i64;
            let idx = self.chapters.iter().rposition(|c| c.0 <= now).unwrap_or(0);
            if self.chapter_now != Some(idx) {
                self.chapter_now = Some(idx);
                self.lines = self.chapter_lyric_lines(idx);
                self.status = if self.chapter_lyrics.contains_key(&idx) { "no lyrics found".into() } else { "looking for lyrics…".into() };
                self.last_key.clear();
            }
            for i in [idx, idx + 1] {
                if i >= self.chapters.len() || !self.chapter_asked.insert(i) {
                    continue;
                }
                let start = self.chapters[i].0;
                let end = self.chapters.get(i + 1).map(|c| c.0).or_else(|| self.track.as_ref().map(|t| (t.duration_s * 1000.0) as i64)).unwrap_or(start);
                let t = Track { title: self.chapters[i].1.clone(), artist: self.base_artist(), album: String::new(), art: String::new(), duration_s: ((end - start).max(0) as f64) / 1000.0 };
                let video = self.track.as_ref().map(|t| t.title.clone()).unwrap_or_default();
                let tx = self.tx.clone();
                let h = self.hwnd as isize;
                std::thread::spawn(move || {
                    let r = lrc::find(&t).and_then(|f| match f.synced.as_deref().filter(|s| !s.trim().is_empty()) {
                        Some(s) => Ok((lrc::parse(s), true, f.source)),
                        None => f.plain.as_deref().map(|p| (lrc::spread(p, t.duration_s), false, f.source.clone())).ok_or_else(|| "no lyrics".to_owned()),
                    });
                    let _ = tx.send(Msg::ChapterLyrics { idx: i, video, lines: r });
                    unsafe { PostMessageW(h as HWND, WM_INPUT_READY, 0, 0) };
                });
            }
        }

        /// What the card names: the compilation's current song, else the song guessed from the title.
        fn names(&self) -> (String, String) {
            let Some(t) = &self.track else { return ("Waiting for a song".into(), String::new()) };
            if let Some(c) = self.chapter_now.and_then(|i| self.chapters.get(i)) {
                return (c.1.clone(), self.base_artist());
            }
            let g = lrc::guesses(t).into_iter().next().unwrap_or_default();
            let artist = if g.1.is_empty() { lrc::clean_artist(&t.artist) } else { g.1 };
            (if g.0.is_empty() { t.title.clone() } else { g.0 }, artist)
        }

        fn save_anchor(&self) {
            if let Some(f) = state_file() {
                let _ = std::fs::write(f, json!({ "x": self.anchor.0, "y": self.anchor.1 }).to_string());
            }
        }

        fn tick_ms(&self) -> u32 {
            if self.animating() {
                // The line rising in, hover and drags at 30 frames a second; the shine and the
                // sparkles alone (slow and soft) at 15: half the cost of every line change.
                let since = self.line_at.elapsed().as_secs_f32();
                let h = self.hover_amt();
                let quick = since < 0.3 || (h > 0.0 && h < 1.0) || self.dragging.is_some() || (self.lines.is_empty() && self.looking_at.elapsed().as_secs_f32() < 4.3);
                return if quick { 33 } else { 66 };
            }
            if self.hover {
                return 100; // follows the mouse over the buttons
            }
            if self.paused || self.lines.is_empty() {
                return 1000; // nothing moves: only the look file and the mouse are checked
            }
            // Playing: the next second (the times) or the next line, whichever comes first.
            let now = self.now_ms() as i64;
            let next_line = self.lines.iter().find(|l| l.at_ms > now).map(|l| ((l.at_ms - now) as f64 / self.rate) as i64).unwrap_or(1000);
            let next_sec = 1000 - (now.rem_euclid(1000));
            next_line.min(next_sec).clamp(30, 1000) as u32
        }
    }

    /// The picture onto the layered window: premultiplied RGBA -> BGRA, per-pixel alpha.
    unsafe fn present(hwnd: HWND, pm: &tiny_skia::Pixmap, anchor: (i32, i32)) {
        let (w, h) = (pm.width() as i32, pm.height() as i32);
        let screen = GetDC(std::ptr::null_mut());
        let mem = CreateCompatibleDC(screen);
        let mut bi: BITMAPINFO = std::mem::zeroed();
        bi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        bi.bmiHeader.biWidth = w;
        bi.bmiHeader.biHeight = -h;
        bi.bmiHeader.biPlanes = 1;
        bi.bmiHeader.biBitCount = 32;
        bi.bmiHeader.biCompression = BI_RGB;
        let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
        let bmp = CreateDIBSection(mem, &bi, DIB_RGB_COLORS, &mut bits, std::ptr::null_mut(), 0);
        if !bmp.is_null() && !bits.is_null() {
            let dst = std::slice::from_raw_parts_mut(bits as *mut u8, (w * h * 4) as usize);
            for (d, s) in dst.chunks_mut(4).zip(pm.data().chunks(4)) {
                d[0] = s[2];
                d[1] = s[1];
                d[2] = s[0];
                d[3] = s[3];
            }
            let old = SelectObject(mem, bmp);
            let pos = POINT { x: anchor.0 - w / 2, y: anchor.1 - h };
            let size = SIZE { cx: w, cy: h };
            let src = POINT { x: 0, y: 0 };
            let blend = BLENDFUNCTION { BlendOp: AC_SRC_OVER as u8, BlendFlags: 0, SourceConstantAlpha: 255, AlphaFormat: AC_SRC_ALPHA as u8 };
            UpdateLayeredWindow(hwnd, screen, &pos, &size, mem, &src, 0, &blend, ULW_ALPHA);
            SelectObject(mem, old);
            DeleteObject(bmp);
        }
        DeleteDC(mem);
        ReleaseDC(std::ptr::null_mut(), screen);
    }

    /// Which button is at (x, y) in the window, if any.
    fn button_at(a: &App, x: f32, y: f32) -> Option<&'static str> {
        a.buttons.iter().filter(|(_, w)| !w.starts_with('_')).find(|(b, _)| x >= b[0] && x < b[0] + b[2] && y >= b[1] && y < b[1] + b[3]).map(|(_, w)| *w)
    }

    /// The song's picture: downloaded (only the address the page gave) and decoded.
    fn fetch_art(url: &str) -> Option<tiny_skia::Pixmap> {
        if !url.starts_with("https://") {
            return None;
        }
        // YouTube's player gives its thumbnail with parameters that make the server send AVIF (which
        // is not decoded here: the card showed no art, owner Nov 23 2026); without them it is a JPEG.
        let url = if url.starts_with("https://i.ytimg.com/") { url.split('?').next().unwrap_or(url) } else { url };
        let r = ureq::AgentBuilder::new()
            .timeout(std::time::Duration::from_secs(8))
            .build()
            .get(url)
            .set("Accept", "image/jpeg,image/png,image/webp;q=0.9")
            .call()
            .ok()?;
        let mut bytes = Vec::new();
        use std::io::Read;
        r.into_reader().take(4 << 20).read_to_end(&mut bytes).ok()?;
        let mut img = image::load_from_memory(&bytes).ok()?.thumbnail(320, 320).to_rgba8();
        // YouTube's thumbnails carry black bars above and below the picture: cut away.
        let dark = |img: &image::RgbaImage, y: u32| (0..img.width()).map(|x| { let p = img.get_pixel(x, y); p[0] as u32 + p[1] as u32 + p[2] as u32 }).sum::<u32>() / img.width().max(1) < 40;
        let (mut top, mut bottom) = (0, img.height());
        while top < bottom && dark(&img, top) {
            top += 1;
        }
        while bottom > top && dark(&img, bottom - 1) {
            bottom -= 1;
        }
        if (top > 0 || bottom < img.height()) && bottom - top > img.height() / 3 {
            img = image::imageops::crop_imm(&img, 0, top, img.width(), bottom - top).to_image();
        }
        let (w, h) = img.dimensions();
        let mut pm = tiny_skia::Pixmap::new(w, h)?;
        for (d, s) in pm.data_mut().chunks_mut(4).zip(img.pixels()) {
            let a = s[3] as u16;
            d[0] = (s[0] as u16 * a / 255) as u8;
            d[1] = (s[1] as u16 * a / 255) as u8;
            d[2] = (s[2] as u16 * a / 255) as u8;
            d[3] = s[3];
        }
        Some(pm)
    }

    /// A picture's average colour, lifted a little so a dark cover still tints.
    fn average(pm: &tiny_skia::Pixmap) -> (u8, u8, u8) {
        let (mut r, mut g, mut b, mut n) = (0u64, 0u64, 0u64, 0u64);
        for c in pm.data().chunks(4).step_by(7) {
            r += c[0] as u64;
            g += c[1] as u64;
            b += c[2] as u64;
            n += 1;
        }
        let n = n.max(1);
        let lift = |v: u64| ((v / n) as f32 * 1.15 + 12.0).min(255.0) as u8;
        (lift(r), lift(g), lift(b))
    }

    /// A button press, to the helper (stdout, one JSON line).
    fn emit_value(v: Value) {
        use std::io::Write;
        let mut out = std::io::stdout().lock();
        let _ = writeln!(out, "{v}");
        let _ = out.flush();
    }

    fn emit(what: &str) {
        use std::io::Write;
        let mut out = std::io::stdout().lock();
        let _ = writeln!(out, "{}", json!({ "type": "action", "what": what }));
        let _ = out.flush();
    }

    impl App {
        /// The mouse over the window: the reveal eases in and out; the pointer is kept for the buttons.
        fn check_hover(&mut self) {
            let mut pt = POINT { x: 0, y: 0 };
            let mut r: RECT = unsafe { std::mem::zeroed() };
            let inside = unsafe { GetCursorPos(&mut pt) != 0 && GetWindowRect(self.hwnd, &mut r) != 0 } && pt.x >= r.left && pt.x < r.right && pt.y >= r.top && pt.y < r.bottom;
            let inside = inside && !self.style.click_through;
            // Over the card / the words themselves, not their transparent margin.
            let (lx, ly) = ((pt.x - r.left) as f32, (pt.y - r.top) as f32);
            let bodies: Vec<[f32; 4]> = self.buttons.iter().filter(|(_, w)| *w == "_body").map(|(b, _)| *b).collect();
            let inside = inside && (bodies.is_empty() || bodies.iter().any(|b| lx >= b[0] && lx < b[0] + b[2] && ly >= b[1] && ly < b[1] + b[3]));
            let now_pointer = if inside || self.dragging.is_some() { Some(((pt.x - r.left) as f32, (pt.y - r.top) as f32)) } else { None };
            if now_pointer != self.pointer {
                self.pointer = now_pointer;
            }
            // Stays shown while the panel is open.
            let want = inside || self.panel_open || self.dragging.is_some();
            if want != self.hover {
                self.hover_from = self.hover_amt();
                self.hover_at = Instant::now();
                self.hover = want;
            }
        }
    }

    fn with<R>(f: impl FnOnce(&mut App) -> R) -> Option<R> {
        let m = APP.get()?;
        let mut g = m.lock().ok()?;
        Some(f(&mut g))
    }

    // Menu command ids.
    const CMD_PRESET: usize = 100; // + index
    const CMD_SCRIPT: usize = 200; // + 0 original, 1 hinglish, 2 both
    const CMD_LINES: usize = 300; // + n
    const CMD_BIGGER: usize = 400;
    const CMD_SMALLER: usize = 401;
    const CMD_EARLIER: usize = 402;
    const CMD_LATER: usize = 403;
    const CMD_THROUGH: usize = 404;
    const CMD_BG_MORE: usize = 405;
    const CMD_BG_LESS: usize = 406;
    const CMD_EDIT: usize = 407;
    const CMD_HIDE: usize = 408;
    const CMD_CLOSE: usize = 409;
    const CMD_SHINE: usize = 410;
    const CMD_GLASS: usize = 411;
    const CMD_SEEKBAR: usize = 412;
    const CMD_SHAPE: usize = 500; // + 0 card, 1 words, 2 strip

    unsafe fn command(hwnd: HWND, cmd: usize) {
        let st = with(|a| a.style.clone()).unwrap_or_default();
        match cmd {
            c if (CMD_PRESET..CMD_PRESET + PRESETS.len()).contains(&c) => style::choose_preset(PRESETS[c - CMD_PRESET]),
            c if (CMD_SCRIPT..CMD_SCRIPT + 3).contains(&c) => style::set_key("script", json!(["original", "hinglish", "both"][c - CMD_SCRIPT])),
            c if (CMD_LINES + 1..=CMD_LINES + 3).contains(&c) => style::set_key("lines", json!(c - CMD_LINES)),
            CMD_BIGGER => style::set_key("size", json!((st.size + 2.0).min(72.0))),
            CMD_SMALLER => style::set_key("size", json!((st.size - 2.0).max(12.0))),
            CMD_BG_MORE => style::set_key("background_opacity", json!((st.background_opacity + 10.0).min(100.0))),
            CMD_BG_LESS => style::set_key("background_opacity", json!((st.background_opacity - 10.0).max(0.0))),
            CMD_SHINE => style::set_key("shine", json!(!st.shine)),
            CMD_GLASS => style::set_key("glass", json!(!st.glass)),
            CMD_SEEKBAR => style::set_key("words_seek_bar", json!(!st.words_seek_bar)),
            c if (CMD_SHAPE..CMD_SHAPE + 3).contains(&c) => style::set_key("layout", json!(["card", "words", "strip"][c - CMD_SHAPE])),
            CMD_EARLIER => style::set_key("offset_ms", json!(st.offset_ms - 500)),
            CMD_LATER => style::set_key("offset_ms", json!(st.offset_ms + 500)),
            CMD_THROUGH => style::set_key("click_through", json!(!st.click_through)),
            CMD_EDIT => {
                if let Some(f) = style::file() {
                    let _ = std::process::Command::new("notepad.exe").arg(f).spawn();
                }
            }
            CMD_HIDE => {
                with(|a| a.hidden = true);
                ShowWindow(hwnd, SW_HIDE);
            }
            CMD_CLOSE => {
                PostQuitMessage(0);
            }
            _ => {}
        }
        with(|a| {
            a.reload_style(true);
            a.paint(true);
        });
    }

    // ---- our menu and the quick look panel: a second, small layered window (sheet.rs draws it)
    struct SheetWin {
        hwnd: HWND,
        kind: crate::sheet::Kind,
        view: crate::sheet::View,
        hits: crate::sheet::SheetHits,
        drag: Option<usize>,
        /// Its top-left on screen.
        at: (i32, i32),
    }
    unsafe impl Send for SheetWin {}
    static SHEET: OnceLock<Mutex<Option<SheetWin>>> = OnceLock::new();
    /// When a sheet last closed (a gear click that closed the panel must not reopen it).
    static SHEET_CLOSED: OnceLock<Mutex<Option<Instant>>> = OnceLock::new();

    fn sheet_lock() -> std::sync::MutexGuard<'static, Option<SheetWin>> {
        SHEET.get_or_init(|| Mutex::new(None)).lock().unwrap_or_else(|e| e.into_inner())
    }

    unsafe fn present_at(hwnd: HWND, pm: &tiny_skia::Pixmap, x: i32, y: i32) {
        let (w, h) = (pm.width() as i32, pm.height() as i32);
        present(hwnd, pm, (x + w / 2, y + h));
    }

    unsafe fn sheet_paint() {
        let (kind, view, hwnd, at) = {
            let g = sheet_lock();
            let Some(sw) = g.as_ref() else { return };
            (sw.kind, sw.view.clone(), sw.hwnd, sw.at)
        };
        let Some((st, mood)) = with(|a| (a.style.clone(), a.mood)) else { return };
        let scale = GetDpiForWindow(hwnd).max(96) as f32 / 96.0;
        let Some((pm, hits)) = with(|a| a.renderer.draw_sheet(kind, &st, mood, &view, scale)) else { return };
        if let Some(sw) = sheet_lock().as_mut() {
            sw.hits = hits;
        }
        present_at(hwnd, &pm, at.0, at.1);
    }

    unsafe fn close_sheet() {
        let h = sheet_lock().take().map(|s| s.hwnd);
        if let Some(h) = h {
            DestroyWindow(h);
            *SHEET_CLOSED.get_or_init(|| Mutex::new(None)).lock().unwrap_or_else(|e| e.into_inner()) = Some(Instant::now());
        }
        with(|a| {
            a.panel_open = false;
            a.paint(true);
        });
    }

    unsafe fn toggle_panel(main: HWND) {
        let open = sheet_lock().as_ref().map(|s| s.kind) == Some(crate::sheet::Kind::Panel);
        let just_closed = SHEET_CLOSED.get_or_init(|| Mutex::new(None)).lock().map(|g| g.is_some_and(|t| t.elapsed().as_millis() < 350)).unwrap_or(false);
        if open {
            close_sheet();
        } else if !just_closed {
            open_sheet(main, crate::sheet::Kind::Panel);
        }
    }

    /// Opens the menu at the mouse, or the panel beside the card; flips at the screen's edges.
    unsafe fn open_sheet(main: HWND, kind: crate::sheet::Kind) {
        close_sheet();
        let inst = GetModuleHandleW(std::ptr::null());
        let class = wide("GambliumLyricsSheet");
        let scale = GetDpiForWindow(main).max(96) as f32 / 96.0;
        let (sw, sh) = crate::sheet::size(kind);
        let (side, bottom) = (crate::sheet::SIDE * scale, crate::sheet::BOTTOM * scale);
        let (w, h) = (sw * scale, sh * scale);
        let mut work = RECT { left: 0, top: 0, right: 1920, bottom: 1080 };
        SystemParametersInfoW(SPI_GETWORKAREA, 0, &mut work as *mut _ as *mut _, 0);
        let mut pt = POINT { x: 0, y: 0 };
        GetCursorPos(&mut pt);
        let mut r: RECT = std::mem::zeroed();
        GetWindowRect(main, &mut r);
        // Where the sheet body goes (its top-left), then the window is that minus the margins.
        let (mut bx, mut by) = match kind {
            crate::sheet::Kind::Menu => (pt.x as f32, pt.y as f32),
            crate::sheet::Kind::Panel => {
                let card_margin = 44.0 * scale;
                (r.right as f32 - card_margin + 10.0 * scale, r.top as f32 + card_margin)
            }
        };
        if bx + w > work.right as f32 {
            bx = match kind {
                crate::sheet::Kind::Menu => bx - w,
                crate::sheet::Kind::Panel => r.left as f32 + 44.0 * scale - 10.0 * scale - w,
            };
        }
        if by + h > work.bottom as f32 {
            by = (work.bottom as f32 - h).max(work.top as f32);
        }
        bx = bx.max(work.left as f32);
        let at = ((bx - side) as i32, (by - side) as i32);
        let _ = bottom;
        let title = wide("Gamblium lyrics settings");
        let hwnd = CreateWindowExW(
            WS_EX_LAYERED | WS_EX_TOPMOST | WS_EX_TOOLWINDOW,
            class.as_ptr(),
            title.as_ptr(),
            WS_POPUP,
            at.0,
            at.1,
            10,
            10,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            inst,
            std::ptr::null(),
        );
        if hwnd.is_null() {
            return;
        }
        *sheet_lock() = Some(SheetWin { hwnd, kind, view: Default::default(), hits: Vec::new(), drag: None, at });
        with(|a| {
            if kind == crate::sheet::Kind::Panel {
                a.panel_open = true;
                a.paint(true);
            }
        });
        sheet_paint();
        ShowWindow(hwnd, SW_SHOW);
        SetForegroundWindow(hwnd);
    }

    /// Carries out a sheet control; returns whether the sheet closes.
    unsafe fn sheet_do(ctl: &crate::sheet::Ctl, frac: Option<f32>) -> bool {
        let Some(st) = with(|a| a.style.clone()) else { return true };
        let e = crate::sheet::apply(ctl, &st, frac);
        if let Some(p) = e.preset {
            style::choose_preset(p);
        }
        for (k, v) in e.changes {
            style::set_key(k, v);
        }
        let main = with(|a| a.hwnd).unwrap_or(std::ptr::null_mut());
        match e.action {
            Some("through") => command(main, CMD_THROUGH),
            Some("settings") => emit("settings"),
            Some("hide") => command(main, CMD_HIDE),
            Some("quit") => PostQuitMessage(0),
            Some("reset") => {
                style::choose_preset(&st.preset);
                with(|a| {
                    a.reload_style(true);
                    a.paint(true);
                });
                return false;
            }
            _ => {}
        }
        with(|a| {
            a.reload_style(true);
            a.paint(true);
        });
        e.closes
    }

    unsafe extern "system" fn sheet_proc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
        let xy = || ((lp & 0xffff) as i16 as f32, ((lp >> 16) & 0xffff) as i16 as f32);
        let hit_at = |x: f32, y: f32| -> Option<(usize, crate::sheet::Ctl, [f32; 4])> {
            let g = sheet_lock();
            let sw = g.as_ref()?;
            sw.hits.iter().enumerate().find(|(_, (r, _))| x >= r[0] && x < r[0] + r[2] && y >= r[1] && y < r[1] + r[3]).map(|(i, (r, c))| (i, c.clone(), *r))
        };
        match msg {
            WM_MOUSEMOVE => {
                let (x, y) = xy();
                let drag = {
                    let mut g = sheet_lock();
                    let Some(sw) = g.as_mut() else { return 0 };
                    sw.view.pointer = Some((x, y));
                    sw.view.hover_look = sw.hits.iter().find(|(r, _)| x >= r[0] && x < r[0] + r[2] && y >= r[1] && y < r[1] + r[3]).and_then(|(_, c)| if let crate::sheet::Ctl::Swatch(p) = c { Some(*p) } else { None });
                    sw.drag.and_then(|i| sw.hits.get(i).cloned())
                };
                if let Some((r, ctl)) = drag {
                    sheet_do(&ctl, Some((x - r[0] - 7.0) / (r[2] - 14.0)));
                }
                sheet_paint();
                0
            }
            WM_LBUTTONDOWN => {
                let (x, y) = xy();
                if let Some((i, ctl, r)) = hit_at(x, y) {
                    if let Some(sw) = sheet_lock().as_mut() {
                        sw.view.pressed = Some(i);
                        if matches!(ctl, crate::sheet::Ctl::Slider { .. }) {
                            sw.drag = Some(i);
                        }
                    }
                    if matches!(ctl, crate::sheet::Ctl::Slider { .. }) {
                        SetCapture(hwnd);
                        sheet_do(&ctl, Some((x - r[0] - 7.0) / (r[2] - 14.0)));
                    }
                }
                sheet_paint();
                0
            }
            WM_LBUTTONUP => {
                ReleaseCapture();
                let (x, y) = xy();
                let (was_drag, pressed) = {
                    let mut g = sheet_lock();
                    let Some(sw) = g.as_mut() else { return 0 };
                    (sw.drag.take().is_some(), sw.view.pressed.take())
                };
                if !was_drag {
                    if let Some((i, ctl, _)) = hit_at(x, y) {
                        if Some(i) == pressed && sheet_do(&ctl, None) {
                            close_sheet();
                            return 0;
                        }
                    }
                }
                sheet_paint();
                0
            }
            WM_KEYDOWN => {
                if wp as u32 == VK_ESCAPE as u32 {
                    close_sheet();
                }
                0
            }
            WM_ACTIVATE => {
                // A click anywhere else closes it.
                if (wp & 0xffff) as u32 == WA_INACTIVE {
                    let dragging = sheet_lock().as_ref().is_some_and(|s| s.drag.is_some());
                    if !dragging {
                        close_sheet();
                    }
                }
                0
            }
            _ => DefWindowProcW(hwnd, msg, wp, lp),
        }
    }

    unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
        match msg {
            WM_INPUT_READY => {
                let quit = with(|a| {
                    let q = a.take_input();
                    a.reload_style(false);
                    a.paint(true);
                    SetTimer(a.hwnd, TIMER, a.tick_ms(), None);
                    q
                })
                .unwrap_or(false);
                if quit {
                    PostQuitMessage(0);
                }
                0
            }
            WM_TIMER => {
                with(|a| {
                    if a.dragging.is_none() {
                        a.check_hover();
                    }
                    a.reload_style(false);
                    a.paint(false);
                    SetTimer(a.hwnd, TIMER, a.tick_ms(), None);
                });
                0
            }
            WM_NCHITTEST => {
                // Buttons are clicked; the rest of the strip drags it.
                let (x, y) = ((lp & 0xffff) as i16 as i32, ((lp >> 16) & 0xffff) as i16 as i32);
                let mut r: RECT = std::mem::zeroed();
                GetWindowRect(hwnd, &mut r);
                let on_button = with(|a| button_at(a, (x - r.left) as f32, (y - r.top) as f32).is_some()).unwrap_or(false);
                if on_button { HTCLIENT as LRESULT } else { HTCAPTION as LRESULT }
            }
            WM_LBUTTONDOWN => {
                let (x, y) = ((lp & 0xffff) as i16 as f32, ((lp >> 16) & 0xffff) as i16 as f32);
                let what = with(|a| button_at(a, x, y)).flatten();
                with(|a| {
                    a.pressed = what;
                    if what == Some("seek") {
                        // The knob follows the mouse; the seek goes out on release.
                        if let Some(bar) = a.buttons.iter().find(|(_, w)| *w == "seek").map(|(b, _)| *b) {
                            a.dragging = Some(((x - bar[0]) / bar[2]).clamp(0.0, 1.0));
                        }
                    }
                    a.paint(true);
                    SetTimer(a.hwnd, TIMER, a.tick_ms(), None);
                });
                SetCapture(hwnd);
                0
            }
            WM_NCMOUSEMOVE => {
                // Over the drag area: the hover UI answers at once, not at the next timer tick.
                with(|a| {
                    a.check_hover();
                    a.paint(false);
                    SetTimer(a.hwnd, TIMER, a.tick_ms(), None);
                });
                DefWindowProcW(hwnd, msg, wp, lp)
            }
            WM_MOUSEMOVE => {
                let (x, y) = ((lp & 0xffff) as i16 as f32, ((lp >> 16) & 0xffff) as i16 as f32);
                with(|a| {
                    a.pointer = Some((x, y));
                    if a.dragging.is_some() {
                        if let Some(bar) = a.buttons.iter().find(|(_, w)| *w == "seek").map(|(b, _)| *b) {
                            a.dragging = Some(((x - bar[0]) / bar[2]).clamp(0.0, 1.0));
                        }
                    }
                    if !a.hover {
                        a.check_hover();
                    }
                    a.paint(false);
                });
                0
            }
            WM_LBUTTONUP => {
                ReleaseCapture();
                let (x, y) = ((lp & 0xffff) as i16 as f32, ((lp >> 16) & 0xffff) as i16 as f32);
                // A drag on the bar ends here: the song jumps to the knob.
                let dropped = with(|a| {
                    let f = a.dragging.take()?;
                    a.pressed = None;
                    let (start, dur) = a.span();
                    if dur <= 0.0 {
                        return None;
                    }
                    let t = start + f as f64 * dur;
                    a.base_ms = t * 1000.0;
                    a.base_at = Instant::now();
                    a.paint(true);
                    Some(t)
                })
                .flatten();
                if let Some(t) = dropped {
                    emit_value(json!({ "type": "action", "what": "seek", "to": t }));
                    return 0;
                }
                let pressed = with(|a| a.pressed.take()).flatten();
                let what = with(|a| button_at(a, x, y)).flatten();
                // A click counts only where it started (a press dragged off a button does nothing).
                if what.is_none() || what != pressed {
                    with(|a| a.paint(true));
                    return 0;
                }
                if what == Some("settings") {
                    // The gear: the quick look panel beside the card; Shift+click: all of Settings.
                    if GetKeyState(VK_SHIFT as i32) < 0 {
                        emit("settings");
                    } else {
                        toggle_panel(hwnd);
                    }
                    with(|a| a.paint(true));
                    return 0;
                }
                if what == Some("seek") {
                    // A click on the bar: the song jumps there (and the lyrics with it, at once).
                    let to = with(|a| {
                        let bar = a.buttons.iter().find(|(_, w)| *w == "seek").map(|(b, _)| *b)?;
                        let d = a.track.as_ref().map(|t| t.duration_s).filter(|d| *d > 0.0)?;
                        let f = ((x - bar[0]) / bar[2]).clamp(0.0, 1.0) as f64;
                        a.base_ms = f * d * 1000.0;
                        a.base_at = Instant::now();
                        a.paint(true);
                        Some(f * d)
                    })
                    .flatten();
                    if let Some(t) = to {
                        emit_value(json!({ "type": "action", "what": "seek", "to": t }));
                    }
                    return 0;
                }
                if what == Some("shape") {
                    // Card <-> the lyrics alone.
                    let now = with(|a| a.style.layout.clone()).unwrap_or_default();
                    style::set_key("layout", json!(if now == "card" { "words" } else { "card" }));
                    with(|a| {
                        a.reload_style(true);
                        a.paint(true);
                    });
                    return 0;
                }
                if let Some(w) = what {
                    emit(w);
                    if w == "close" {
                        with(|a| a.hidden = true);
                        ShowWindow(hwnd, SW_HIDE);
                    }
                }
                0
            }
            WM_NCRBUTTONUP | WM_RBUTTONUP => {
                open_sheet(hwnd, crate::sheet::Kind::Menu);
                0
            }
            WM_MOVE => {
                let mut r: RECT = std::mem::zeroed();
                GetWindowRect(hwnd, &mut r);
                with(|a| a.anchor = ((r.left + r.right) / 2, r.bottom));
                0
            }
            WM_EXITSIZEMOVE => {
                with(|a| a.save_anchor());
                0
            }
            WM_HOTKEY => {
                match wp {
                    1 => command(hwnd, CMD_THROUGH),
                    2 => {
                        let show = with(|a| {
                            a.hidden = !a.hidden;
                            !a.hidden
                        })
                        .unwrap_or(true);
                        ShowWindow(hwnd, if show { SW_SHOWNOACTIVATE } else { SW_HIDE });
                        with(|a| a.paint(true));
                    }
                    3 => {
                        let cur = with(|a| a.style.preset.clone()).unwrap_or_default();
                        let i = PRESETS.iter().position(|p| *p == cur).map(|i| (i + 1) % PRESETS.len()).unwrap_or(0);
                        command(hwnd, CMD_PRESET + i);
                    }
                    4 => command(hwnd, CMD_EARLIER),
                    5 => command(hwnd, CMD_LATER),
                    _ => {}
                }
                0
            }
            WM_DESTROY => {
                PostQuitMessage(0);
                0
            }
            _ => DefWindowProcW(hwnd, msg, wp, lp),
        }
    }
}

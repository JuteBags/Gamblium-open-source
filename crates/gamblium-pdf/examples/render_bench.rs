//! Times the engine on a PDF: `cargo run --release --example render_bench -- file.pdf [scale]`.
fn main() {
    let path = std::env::args().nth(1).expect("a PDF");
    let scale: f32 = std::env::args().nth(2).and_then(|s| s.parse().ok()).unwrap_or(2.0);
    let bytes = std::fs::read(&path).unwrap();
    let t0 = std::time::Instant::now();
    let v = gamblium_pdf::Viewer::new(bytes).ok().unwrap();
    println!("open {:?}, {} pages", t0.elapsed(), v.page_count());
    let mut times = vec![];
    for i in 0..v.page_count() {
        let t = std::time::Instant::now();
        let px = v.render(i, scale);
        times.push((t.elapsed().as_secs_f64() * 1000.0, i, px.len()));
    }
    let total: f64 = times.iter().map(|t| t.0).sum();
    times.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap());
    println!("render at {scale}x: total {:.0} ms, mean {:.1} ms/page", total, total / times.len() as f64);
    for t in times.iter().take(6) { println!("  page {} {:.0} ms", t.1 + 1, t.0); }
    let t = std::time::Instant::now();
    for i in 0..v.page_count() { let _ = v.words(i); }
    println!("words for all pages {:?}", t.elapsed());
}

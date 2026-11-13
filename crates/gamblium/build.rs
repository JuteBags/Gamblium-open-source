// Puts the Gamblium icon into both programs. If the Windows resource compiler
// is not installed the build still succeeds, just without the icon.
fn main() {
    let icon = std::path::Path::new("../../branding/gamblium.ico");
    println!("cargo:rerun-if-changed={}", icon.display());
    if std::env::var_os("CARGO_CFG_WINDOWS").is_none() || !icon.is_file() {
        return;
    }
    let mut res = winresource::WindowsResource::new();
    res.set_icon(&icon.to_string_lossy());
    res.set("ProductName", "Gamblium");
    res.set("FileDescription", "Gamblium");
    if let Err(e) = res.compile() {
        println!("cargo:warning=no icon embedded: {e}");
    }
}

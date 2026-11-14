mod audit;
mod capture;
mod dl;
mod host;
mod pack;
mod update;
mod install;
mod launch;
mod permit;
mod private;
mod procs;
mod rebrand;
mod scan;
mod sessions;
mod vault;

use clap::{Parser, Subcommand};
use procs::{Proc, Sampler};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::time::{Duration, Instant};

#[derive(Parser)]
#[command(name = "gamblium", version, about = "Gamblium companion CLI")]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// CPU and memory of a browser's whole process tree, grouped by process type.
    Stats {
        /// Executable name of the browser.
        #[arg(long, default_value = "brave.exe")]
        exe: String,
        /// Only trees whose root command line contains this text (e.g. a user-data-dir).
        #[arg(long)]
        marker: Option<String>,
        /// Seconds to measure CPU over. 0 = one memory snapshot, no CPU rate.
        #[arg(long, default_value_t = 30)]
        duration: u64,
        /// Seconds between samples while measuring.
        #[arg(long, default_value_t = 5)]
        interval: u64,
        /// How many of the busiest processes to list.
        #[arg(long, default_value_t = 8)]
        top: usize,
        /// Print one JSON object instead of a table.
        #[arg(long)]
        json: bool,
    },
    /// Configure and start the official Brave binary (never renamed or patched).
    Launch(LaunchArgs),
    /// Install Gamblium for you: its own folder, the helper, and Start-menu and
    /// desktop shortcuts with the Gamblium icon. No admin rights needed.
    Install {
        /// Uninstall instead. Your Gamblium profile is kept.
        #[arg(long)]
        remove: bool,
        /// Show what would happen without doing it.
        #[arg(long)]
        dry_run: bool,
    },
    /// Start a magnet link or a .torrent file in Gamblium's downloader and
    /// show the Downloads page. Windows runs this for clicked magnet links.
    Open {
        /// A magnet link, or the address or path of a .torrent file.
        address: String,
    },
    /// Named browser sessions that work with no window. This is what the
    /// `gamblium-cli` program runs; `gamblium cli help` lists its commands.
    Cli {
        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        args: Vec<String>,
    },
    /// Make a private copy of Brave that shows Gamblium's mark and name instead
    /// of Brave's lion (about 1 GB). The installed Brave is not changed. Run it
    /// again after every Brave update; until then the official Brave is started.
    Rebrand {
        /// Delete the copy and go back to the official Brave.
        #[arg(long)]
        remove: bool,
        /// Keep the copy but start Brave with its own name and logo from now on.
        #[arg(long, conflicts_with_all = ["remove", "on"])]
        off: bool,
        /// Use the rebranded copy again after --off.
        #[arg(long, conflicts_with = "remove")]
        on: bool,
        /// Say what would be done, but do nothing.
        #[arg(long)]
        dry_run: bool,
        /// Path to the installed brave.exe.
        #[arg(long, default_value = launch::DEFAULT_BRAVE)]
        brave: PathBuf,
    },
    /// Used by the helper: close one browser and start it again on the same
    /// profile folder, so a newly chosen theme shows.
    /// Updates: check and download a newer release (--download), say where things stand
    /// (--status), or install a downloaded one (--apply, run by the updater's own copy).
    Update {
        #[arg(long)]
        download: bool,
        #[arg(long)]
        status: bool,
        /// Install now if an update is ready and Gamblium is closed (the shortcut does this).
        #[arg(long)]
        apply_if_ready: bool,
        #[arg(long, value_name = "INSTALLER")]
        apply: Option<PathBuf>,
        /// Start Gamblium after installing.
        #[arg(long)]
        start: bool,
    },
    #[command(hide = true)]
    Relaunch {
        #[arg(long)]
        pid: u32,
        #[arg(long)]
        user_data_dir: PathBuf,
    },
    /// Brave policies Gamblium wrote for this Windows user: list or remove them.
    Policies {
        /// Remove every policy Gamblium wrote.
        #[arg(long)]
        remove: bool,
    },
    /// Started by the browser, not by people: lets the Gamblium extension use these tools.
    #[command(hide = true)]
    NativeHost {
        /// The browser passes the calling extension's origin and a window handle.
        #[arg(hide = true, trailing_var_arg = true, allow_hyphen_values = true)]
        _from_browser: Vec<String>,
    },
    /// Register this program with Brave so the Gamblium extension can talk to it.
    InstallHost {
        /// The extension's id (32 letters, shown on brave://extensions).
        #[arg(long, default_value = host::EXTENSION_ID)]
        extension_id: String,
        /// Remove the registration instead.
        #[arg(long)]
        remove: bool,
    },
    /// Control a running Gamblium from the command line (for AI agents and scripts).
    /// Examples: `ctl tabs`, `ctl open url=https://example.com wait=true`,
    /// `ctl text tab=12`, `ctl click selector=#go`, `ctl screenshot out=page.png`.
    Ctl {
        /// What to do. `gamblium ctl help` lists every command; docs/agent-cli.md
        /// explains them. Groups: tabs, windows, reading a page, acting on a page,
        /// downloads, network capture, security tools, settings, memory, sessions, cookies.
        op: String,
        /// Details as key=value, e.g. tab=12 url=https://example.com selector=#q text=hello
        args: Vec<String>,
        /// Which running Gamblium: agent, main, a browser process id, or part of
        /// its profile folder. Needed only when more than one is running.
        #[arg(long)]
        profile: Option<String>,
        /// Seconds to wait for the browser to answer.
        #[arg(long, default_value_t = 30)]
        timeout: u64,
    },
    /// Close Brave windows that were started on a separate profile folder, for
    /// example after a test. The real (default) profile is never closed by this.
    Close {
        /// Close the Brave running on this profile folder.
        #[arg(long)]
        user_data_dir: Option<PathBuf>,
        /// Close the agent profile.
        #[arg(long)]
        agent: bool,
        /// Close the pen-test profile.
        #[arg(long)]
        pentest: bool,
        /// Close every Brave started on a folder under the system temp directory
        /// (throwaway test profiles left open by a test run).
        #[arg(long)]
        all_temp: bool,
        /// Executable name of the browser.
        #[arg(long, default_value = "brave.exe")]
        exe: String,
    },
    /// Experiment: freeze page processes so they use no CPU, keeping their state.
    Freeze {
        /// Process ids to freeze. Only page (renderer) processes are accepted.
        #[arg(long, value_delimiter = ',')]
        pid: Vec<u32>,
        /// Or: measure for 5 s and freeze the N busiest page processes of the tree.
        #[arg(long, conflicts_with = "pid")]
        busiest: Option<usize>,
        /// Executable name of the browser.
        #[arg(long, default_value = "brave.exe")]
        exe: String,
        /// Only trees whose root command line contains this text.
        #[arg(long)]
        marker: Option<String>,
        /// Also push the frozen processes' memory out of RAM.
        #[arg(long)]
        trim: bool,
    },
    /// Let frozen page processes run again.
    Thaw {
        #[arg(long, value_delimiter = ',', required = true)]
        pid: Vec<u32>,
    },
    /// Experiment: move the memory of idle page processes out of RAM. Nothing is
    /// lost; a page takes its memory back as it touches it again.
    Trim {
        /// Executable name of the browser.
        #[arg(long, default_value = "brave.exe")]
        exe: String,
        /// Only trees whose root command line contains this text.
        #[arg(long)]
        marker: Option<String>,
        /// A page process counts as idle if it used almost no CPU for this many seconds.
        #[arg(long, default_value_t = 10)]
        idle_sec: u64,
        /// CPU milliseconds allowed within the window to still count as idle.
        #[arg(long, default_value_t = 20)]
        max_cpu_ms: u64,
    },
    /// Web security audit of one page: missing protections, weak cookies, unsafe
    /// cross-origin settings, disclosed versions. Two plain GET requests, no attacks.
    Audit {
        /// Page to check, e.g. https://staging.example.com/login
        #[arg(long)]
        url: String,
        /// Scope file (see `scan`). Needed for anything outside your own machine and network.
        #[arg(long)]
        scope: Option<PathBuf>,
        /// Also look up known vulnerabilities (CVEs) for the software versions the
        /// server discloses. Sends those product names and versions to nvd.nist.gov.
        #[arg(long)]
        cve: bool,
        /// Print JSON instead of text.
        #[arg(long)]
        json: bool,
    },
    /// Known vulnerabilities (CVEs) for one product version, from the US National
    /// Vulnerability Database. Sends the product name and version to nvd.nist.gov.
    Cve {
        /// e.g. apache, nginx, openssh, openssl, php, tomcat, iis
        #[arg(long)]
        product: String,
        #[arg(long)]
        version: String,
        /// How many to list, worst first.
        #[arg(long, default_value_t = 10)]
        top: usize,
        #[arg(long)]
        json: bool,
    },
    /// TCP port scan. Only your own machine and network, or targets in your scope file.
    Scan {
        /// Host names or IP addresses.
        #[arg(long, value_delimiter = ',', required = true)]
        target: Vec<String>,
        /// Ports, e.g. "80,443,8000-8100". Default: about 55 common service ports.
        #[arg(long)]
        ports: Option<String>,
        /// File listing what you are authorised to test: one host, *.domain, IP or
        /// IPv4 CIDR per line. Needed for anything outside your own machine and network.
        #[arg(long)]
        scope: Option<PathBuf>,
        /// Milliseconds to wait for each port.
        #[arg(long, default_value_t = 500)]
        timeout_ms: u64,
        /// Ports tried at the same time.
        #[arg(long, default_value_t = 100)]
        workers: usize,
        /// Print JSON instead of a table.
        #[arg(long)]
        json: bool,
    },
}

#[derive(clap::Args)]
struct LaunchArgs {
    /// lean, balanced or performance: how soon hidden tabs are put to sleep.
    /// Default: lean, or performance for --agent (a frozen tab cannot answer an agent).
    #[arg(long)]
    preset: Option<String>,
    /// JSON file {name, local_state, preferences, args} laid over the preset. Repeatable.
    #[arg(long)]
    preset_file: Vec<PathBuf>,
    /// Use this profile folder instead of Brave's default one.
    #[arg(long, conflicts_with = "pentest")]
    user_data_dir: Option<PathBuf>,
    /// Use the separate agent profile (its own folder, safe to drive by automation).
    #[arg(long, conflicts_with = "pentest")]
    agent: bool,
    /// With --agent: run with no window at all. Control it with `gamblium ctl`,
    /// end it with `gamblium close --agent`.
    #[arg(long, requires = "agent")]
    hidden: bool,
    /// Use the separate pen-test profile. Only for targets you own or are authorised to test.
    #[arg(long)]
    pentest: bool,
    /// Brave profile inside the folder, e.g. "Default" or "Profile 1".
    #[arg(long)]
    profile_directory: Option<String>,
    /// Open a debugging port. Not allowed on the main profile.
    #[arg(long)]
    debug_port: Option<u16>,
    /// Do not open Gamblium's welcome page in this profile. Implied by
    /// --debug-port, --agent and --pentest: test, automation and pen-test
    /// profiles never ask "What should I call you?".
    #[arg(long)]
    skip_welcome: bool,
    /// Send this profile's traffic through a proxy, e.g. http://127.0.0.1:8080 (Burp, mitmproxy).
    #[arg(long)]
    proxy: Option<String>,
    /// Write TLS session keys to this file so Wireshark can decrypt a capture, QUIC included.
    /// Not allowed on the main profile.
    #[arg(long)]
    tls_keylog: Option<PathBuf>,
    /// Wear a Gamblium theme, e.g. moon-dark (the default look), felt-dark, burgundy-dark
    /// (any presets/theme-<name>.json).
    #[arg(long)]
    theme: Option<String>,
    /// Make every website dark, including sites that only have a light design.
    /// The browser recolours pages itself; no extension or page script is involved.
    #[arg(long)]
    force_dark: bool,
    /// Follow what was chosen in Gamblium's Settings: the user's own colours
    /// for the frame (their background decides light or dark, which websites
    /// are told), and light-only websites made dark when the look is dark,
    /// unless that was switched off. The shortcuts start Gamblium this way.
    #[arg(long)]
    auto_dark: bool,
    /// Do not load the Gamblium extension.
    #[arg(long)]
    no_extension: bool,
    /// Keep Brave's extras (skip presets/debloat.json).
    #[arg(long)]
    no_debloat: bool,
    /// Also write the preset's Brave policies for this Windows user. They remove
    /// what settings cannot (menu entries for Leo, VPN, Wallet, Rewards), apply
    /// to every Brave profile of yours, and show "Managed by your organization".
    /// Undo with `gamblium policies --remove`.
    #[arg(long)]
    apply_policies: bool,
    /// Path to brave.exe.
    #[arg(long, default_value = launch::DEFAULT_BRAVE)]
    brave: PathBuf,
    /// Start the official Brave even if a rebranded copy exists.
    #[arg(long)]
    official: bool,
    /// Leave the per-app GPU preference alone.
    #[arg(long)]
    no_gpu_pref: bool,
    /// Show what would change and the command line, but do nothing.
    #[arg(long)]
    dry_run: bool,
    /// Extra switches passed to Brave unchanged (after `--`).
    #[arg(last = true)]
    extra: Vec<String>,
}

#[derive(Serialize, Default, Clone)]
struct Group {
    procs: usize,
    /// Percent of ONE core, averaged over the window.
    cpu_pct: f64,
    private_ws_mb: f64,
    commit_mb: f64,
    ws_mb: f64,
}

#[derive(Serialize)]
struct TopProc {
    pid: u32,
    kind: String,
    cpu_pct: f64,
    private_ws_mb: f64,
}

#[derive(Serialize)]
struct Report {
    exe: String,
    marker: Option<String>,
    window_sec: f64,
    cores: usize,
    total: Group,
    /// total.cpu_pct divided by the number of logical cores.
    cpu_pct_of_machine: f64,
    by_kind: BTreeMap<String, Group>,
    top: Vec<TopProc>,
    system_available_mb: f64,
    /// Sum of CPU seconds since each process started (for harnesses that diff it).
    cpu_sec_total: f64,
}

const MB: f64 = 1024.0 * 1024.0;

fn main() {
    let cli = Cli::parse();
    match cli.cmd {
        Cmd::Stats { exe, marker, duration, interval, top, json } => {
            let report = stats(&exe, marker, duration, interval.max(1), top);
            if report.total.procs == 0 {
                eprintln!("no running process tree found for {exe}");
                std::process::exit(2);
            }
            if json {
                println!("{}", serde_json::to_string(&report).unwrap());
            } else {
                print_table(&report);
            }
        }
        Cmd::Open { address } => {
            if !dl::is_torrent(&address) {
                eprintln!("error: '{address}' is not a magnet link or a .torrent file");
                std::process::exit(2);
            }
            // The seeding time the owner chose in Settings is the extension's to
            // know; from outside the browser a torrent stops when it is whole.
            // A clicked magnet link belongs to the user's own Gamblium profile.
            let profile = crate::install::profile_dir().map(|d| dl::profile_key(&d)).unwrap_or_default();
            match dl::start(&serde_json::json!({ "url": address }), &profile) {
                Ok(v) => println!("started {}", v["download"].as_str().unwrap_or("")),
                Err(e) => {
                    eprintln!("error: {e}");
                    std::process::exit(1);
                }
            }
            // Show it: a tab in the running Gamblium, or start Gamblium.
            let me = std::env::current_exe().unwrap_or_default();
            let profile = install::profile_dir();
            let page = format!("chrome-extension://{}/ui/downloads.html", host::EXTENSION_ID);
            let copy = rebrand::copy_dir().map(|d| d.join("brave.exe")).filter(|p| p.is_file());
            let running = profile.as_deref().map(|p| procs::browser_running("brave.exe", Some(p))).unwrap_or(false);
            let _ = match (running, copy, profile) {
                (true, Some(browser), Some(profile)) => launch::spawn_detached(&browser, &[format!("--user-data-dir={}", profile.display()), page]),
                _ => launch::spawn_detached(&me.with_file_name("gamblium-app.exe"), &[]),
            };
        }
        Cmd::Install { remove, dry_run } => {
            let result = if remove {
                install::remove(dry_run)
            } else {
                launch::find_home()
                    .ok_or("cannot find the Gamblium folder (extension/, presets/). Set GAMBLIUM_HOME".to_string())
                    .and_then(|home| install::install(&home, dry_run))
                    .map(|mut lines| {
                        // The installed patchers may be newer than the copy: make it again now
                        // (or at the next start, if a Gamblium runs from it).
                        let app = std::env::var_os("LOCALAPPDATA").map(|d| std::path::PathBuf::from(d).join("Gamblium").join("app"));
                        if let (false, Some(app)) = (dry_run, app.filter(|a| a.join("tools").join("rebrand").is_dir())) {
                            if let Some(line) = rebrand::refresh_if_needed(std::path::Path::new(launch::DEFAULT_BRAVE), &app) {
                                lines.push(line);
                            }
                        }
                        lines
                    })
            };
            match result {
                Ok(lines) => lines.iter().for_each(|l| println!("{l}")),
                Err(e) => {
                    eprintln!("error: {e}");
                    std::process::exit(1);
                }
            }
        }
        Cmd::Rebrand { remove, off, on, dry_run, brave } => {
            let result = if off || on {
                rebrand::set_official(off).map(|_| vec![if off {
                    "Brave's own name and logo will show the next time Gamblium starts. Undo with: gamblium rebrand --on".to_owned()
                } else {
                    "Gamblium's name and mark will show the next time Gamblium starts.".to_owned()
                }])
            } else if remove {
                rebrand::remove().map(|was| vec![if was { "removed the copy; the official Brave is used again".to_owned() } else { "there was no copy".to_owned() }])
            } else {
                launch::find_home().ok_or("the Gamblium folder was not found. Set GAMBLIUM_HOME".to_owned()).and_then(|home| rebrand::make(&brave, &home, dry_run))
            };
            match result {
                Ok(lines) => lines.iter().for_each(|l| println!("{l}")),
                Err(e) => {
                    eprintln!("error: {e}");
                    std::process::exit(1);
                }
            }
        }
        Cmd::Update { download, status, apply_if_ready, apply, start } => {
            // GAMBLIUM_UPDATE_AS: act as another version (tests only: lets a check find an older release).
            let pretend = std::env::var("GAMBLIUM_UPDATE_AS").ok();
            let current = pretend.as_deref().unwrap_or(env!("CARGO_PKG_VERSION"));
            if let Some(installer) = apply {
                if let Err(e) = update::apply(&installer, start) {
                    eprintln!("error: {e}");
                    std::process::exit(1);
                }
            } else if apply_if_ready {
                // Exit 0: the update is being installed (and will start Gamblium); 3: nothing to do.
                let open = install::profile_dir().is_some_and(|p| procs::browser_running("brave.exe", Some(&p)));
                match update::ready_installer(current) {
                    Some(installer) if !open => match update::start_apply(&installer, true) {
                        Ok(()) => println!("installing the update; Gamblium starts when it is done"),
                        Err(e) => {
                            eprintln!("error: {e}");
                            std::process::exit(3);
                        }
                    },
                    _ => std::process::exit(3),
                }
            } else if download {
                match update::check_and_download(current) {
                    Ok(v) => println!("{v}"),
                    Err(e) => {
                        eprintln!("error: {e}");
                        std::process::exit(1);
                    }
                }
            } else {
                let _ = status;
                update::forget_stale(current);
                println!("{}", serde_json::json!({ "current": current, "update": update::state() }));
            }
        }
        Cmd::Relaunch { pid, user_data_dir } => {
            // Let the helper's answer reach the page first.
            std::thread::sleep(std::time::Duration::from_millis(700));
            close_browser(pid, &user_data_dir);
            for _ in 0..40 {
                if !procs::browser_running("brave.exe", Some(&user_data_dir)) {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(250));
            }
            // Gamblium's own profile starts the way its shortcut does; any other
            // folder starts with the same options the shortcut would use.
            let me = std::env::current_exe().unwrap_or_default();
            let own = std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join("Gamblium").join("User Data"));
            let starter = me.with_file_name("gamblium-app.exe");
            let result = if own.as_deref() == Some(user_data_dir.as_path()) && starter.is_file() {
                launch::spawn_detached(&starter, &[])
            } else {
                launch::spawn_detached(&me, &["launch".into(), "--theme".into(), "moon-dark".into(), "--auto-dark".into(), "--user-data-dir".into(), user_data_dir.to_string_lossy().into_owned()])
            };
            if let Err(e) = result {
                eprintln!("error: {e}");
                std::process::exit(1);
            }
        }
        Cmd::Policies { remove } => match launch::remove_policies(!remove) {
            Ok(names) if names.is_empty() => println!("Gamblium has written no Brave policies."),
            Ok(names) if remove => println!("removed: {}", names.join(", ")),
            Ok(names) => println!("written by Gamblium (remove with --remove): {}", names.join(", ")),
            Err(e) => {
                eprintln!("error: {e}");
                std::process::exit(1);
            }
        },
        Cmd::NativeHost { .. } => {
            if let Err(e) = host::run() {
                eprintln!("native host: {e}");
                std::process::exit(1);
            }
        }
        Cmd::InstallHost { extension_id, remove } => {
            match host::install(&extension_id, remove) {
                Ok(msg) => println!("{msg}"),
                Err(e) => {
                    eprintln!("error: {e}");
                    std::process::exit(1);
                }
            }
        }
        Cmd::Ctl { op, args, profile, timeout } => {
            let run = || -> Result<serde_json::Value, String> {
                if op == "list" {
                    let list: Vec<_> = host::live_bridges()
                        .iter()
                        .map(|b| serde_json::json!({ "browserPid": b.browser_pid, "profile": b.user_data_dir.as_deref().unwrap_or("main profile") }))
                        .collect();
                    return Ok(serde_json::json!({ "ok": true, "running": list }));
                }
                // `help` with no browser running: the command reference that ships in this program.
                if op == "help" && host::live_bridges().is_empty() {
                    let doc = include_str!("../../../docs/agent-cli.md");
                    let reference = doc.split("<!-- commands:start").nth(1).and_then(|s| s.split_once("-->")).map(|x| x.1).unwrap_or(doc);
                    let reference = reference.split("<!-- commands:end").next().unwrap_or(reference).trim();
                    return Ok(serde_json::json!({
                        "ok": true,
                        "running": false,
                        "note": "No Gamblium is running. Start one with: gamblium launch --agent (add --hidden for no window).",
                        "reference": reference,
                    }));
                }
                // Checked before a browser is looked for, so a mistyped command says so.
                host::parse_ctl_args(&op, &args)?;
                let bridge = host::pick_bridge(host::live_bridges(), profile.as_deref())?;
                ctl_with(&bridge, &op, &args, timeout)
            };
            match run() {
                Ok(answer) => {
                    println!("{}", serde_json::to_string_pretty(&answer).unwrap());
                    if answer["ok"] == false {
                        std::process::exit(1);
                    }
                }
                Err(e) => {
                    println!("{}", serde_json::json!({ "ok": false, "error": e }));
                    std::process::exit(1);
                }
            }
        }
        Cmd::Cli { args } => std::process::exit(sessions::run(&args)),
        Cmd::Close { user_data_dir, agent, pentest, all_temp, exe } => {
            let mut wanted: Vec<String> = Vec::new();
            if let Some(d) = user_data_dir {
                wanted.push(d.to_string_lossy().into_owned());
            }
            if agent {
                wanted.extend(launch::agent_user_data_dir().map(|d| d.to_string_lossy().into_owned()));
            }
            if pentest {
                wanted.extend(launch::pentest_user_data_dir().map(|d| d.to_string_lossy().into_owned()));
            }
            if wanted.is_empty() && !all_temp {
                eprintln!("error: say which one: --user-data-dir, --agent, --pentest or --all-temp");
                std::process::exit(1);
            }
            let norm = |d: &str| d.to_ascii_lowercase().replace('/', "\\").trim_end_matches('\\').to_owned();
            let wanted: Vec<String> = wanted.iter().map(|d| norm(d)).collect();
            let mut closed = 0;
            for (pid, dir) in procs::browsers(&exe) {
                // No folder on the command line = the user's real profile. Never touched.
                let Some(dir) = dir else { continue };
                if !(wanted.contains(&norm(&dir)) || (all_temp && launch::is_temp_folder(&dir))) {
                    continue;
                }
                close_browser(pid, std::path::Path::new(&dir));
                closed += 1;
            }
            println!("closed {closed} Brave window group(s)");
        }
        Cmd::Freeze { pid, busiest, exe, marker, trim } => {
            let mut sampler = Sampler::new(&exe, marker);
            let before = sampler.sample();
            let targets: Vec<u32> = match busiest {
                None => pid,
                Some(n) => {
                    std::thread::sleep(Duration::from_secs(5));
                    let cpu0: HashMap<u32, u64> = before.iter().map(|p| (p.pid, p.cpu_ms)).collect();
                    let mut used: Vec<(u64, u32)> = sampler
                        .sample()
                        .iter()
                        .filter(|p| p.kind == "renderer")
                        .map(|p| (p.cpu_ms.saturating_sub(cpu0.get(&p.pid).copied().unwrap_or(p.cpu_ms)), p.pid))
                        .filter(|(ms, _)| *ms > 0)
                        .collect();
                    used.sort_unstable_by(|a, b| b.cmp(a));
                    used.into_iter().take(n).map(|(_, pid)| pid).collect()
                }
            };
            // Freezing the browser, GPU or network process would hang every tab.
            let renderers: std::collections::HashSet<u32> =
                before.iter().filter(|p| p.kind == "renderer").map(|p| p.pid).collect();
            let mut frozen = Vec::new();
            for p in targets {
                if !renderers.contains(&p) {
                    eprintln!("skipped {p}: not a page process of {exe}");
                    continue;
                }
                match procs::freeze(p).and_then(|_| if trim { procs::trim(p) } else { Ok(()) }) {
                    Ok(()) => frozen.push(p.to_string()),
                    Err(e) => eprintln!("failed {p}: {e}"),
                }
            }
            println!("{}", frozen.join(","));
        }
        Cmd::Trim { exe, marker, idle_sec, max_cpu_ms } => {
            let mut sampler = Sampler::new(&exe, marker);
            let before = sampler.sample();
            std::thread::sleep(Duration::from_secs(idle_sec));
            let after = sampler.sample();
            let cpu0: HashMap<u32, u64> = before.iter().map(|p| (p.pid, p.cpu_ms)).collect();
            let total = |ps: &[Proc]| ps.iter().map(|p| p.private_ws).sum::<u64>() as f64 / MB;
            let mut trimmed = 0;
            for p in after.iter().filter(|p| p.kind == "renderer") {
                // Only processes that existed for the whole window and stayed quiet.
                let Some(c0) = cpu0.get(&p.pid) else { continue };
                if p.cpu_ms.saturating_sub(*c0) <= max_cpu_ms && procs::trim(p.pid).is_ok() {
                    trimmed += 1;
                }
            }
            let renderers = after.iter().filter(|p| p.kind == "renderer").count();
            let now = sampler.sample();
            println!(
                "trimmed {trimmed} of {renderers} page processes; private memory {:.0} MB -> {:.0} MB; system available {:.0} MB",
                total(&after),
                total(&now),
                procs::system_available() as f64 / MB
            );
        }
        Cmd::Thaw { pid } => {
            for p in pid {
                if let Err(e) = procs::thaw(p) {
                    eprintln!("failed {p}: {e}");
                }
            }
        }
        Cmd::Audit { url, scope, cve, json } => {
            if let Err(e) = run_audit(&url, scope, cve, json) {
                eprintln!("error: {e}");
                std::process::exit(1);
            }
        }
        Cmd::Cve { product, version, top, json } => match lookup_cves(&product, &version) {
            Ok(cves) if json => println!("{}", serde_json::to_string(&cves).unwrap()),
            Ok(cves) => print_cves(&product, &version, &cves, top),
            Err(e) => {
                eprintln!("error: {e}");
                std::process::exit(1);
            }
        },
        Cmd::Scan { target, ports, scope, timeout_ms, workers, json } => {
            if let Err(e) = run_scan(target, ports, scope, timeout_ms, workers, json) {
                eprintln!("error: {e}");
                std::process::exit(1);
            }
        }
        Cmd::Launch(args) => {
            if let Err(e) = run_launch(args) {
                eprintln!("error: {e}");
                std::process::exit(1);
            }
        }
    }
}

/// Sends one command to a running Gamblium and returns its answer.
/// `file=<path>` is read and sent; `out=<path>` saves the answer to a file.
fn ctl_with(bridge: &host::BridgeInfo, op: &str, args: &[String], timeout: u64) -> Result<serde_json::Value, String> {
    let mut cmd = host::parse_ctl_args(op, args)?;
    // file=<path>: read a checkpoint from disk and send its content.
    if let Some(file) = cmd["file"].as_str().map(str::to_owned) {
        let text = std::fs::read_to_string(&file).map_err(|e| format!("{file}: {e}"))?;
        cmd["session"] = serde_json::from_str(&text).map_err(|e| format!("{file} is not JSON: {e}"))?;
    }
    let mut answer = host::ctl(bridge, &cmd, timeout * 1000)?;
    // out=<path>: save the result to a file instead of printing it all.
    if let Some(out) = cmd["out"].as_str() {
        if let Some(parts) = answer["parts"].as_array() {
            // A long page comes in slices; they become one picture here.
            let mut pngs = Vec::new();
            for p in parts {
                let data = p.as_str().unwrap_or_default();
                pngs.push(host::decode_base64(data.split_once(',').map(|x| x.1).unwrap_or(data)).ok_or("the browser sent a broken image")?);
            }
            let file = std::fs::File::create(out).map_err(|e| format!("{out}: {e}"))?;
            let (w, h) = capture::join_pngs(&pngs, std::io::BufWriter::new(file))?;
            answer["parts"] = serde_json::Value::Null;
            answer["slices"] = serde_json::json!(pngs.len());
            answer["width"] = serde_json::json!(w);
            answer["height"] = serde_json::json!(h);
            answer["bytes"] = serde_json::json!(std::fs::metadata(out).map(|m| m.len()).unwrap_or(0));
            answer["saved"] = serde_json::json!(out);
        } else if let Some(data) = answer["dataUrl"].as_str() {
            let b64 = data.split_once(',').map(|x| x.1).unwrap_or(data);
            let bytes = host::decode_base64(b64).ok_or("the browser sent a broken image")?;
            std::fs::write(out, &bytes).map_err(|e| format!("{out}: {e}"))?;
            answer["dataUrl"] = serde_json::Value::Null;
            answer["bytes"] = serde_json::json!(bytes.len());
            answer["saved"] = serde_json::json!(out);
        } else if answer["ok"] == true {
            let body = if answer["session"].is_object() { &answer["session"] } else { &answer };
            std::fs::write(out, serde_json::to_string_pretty(body).unwrap()).map_err(|e| format!("{out}: {e}"))?;
            answer = serde_json::json!({ "ok": true, "saved": out });
        }
    }
    Ok(answer)
}

/// Asks Brave to close its windows; if it has not gone after a few seconds,
/// stops it and marks the exit as clean so the next start does not restore tabs.
fn close_browser(pid: u32, user_data_dir: &std::path::Path) {
    let taskkill = |args: &[&str]| {
        let _ = std::process::Command::new("taskkill").args(args).output();
    };
    let id = pid.to_string();
    taskkill(&["/PID", &id]); // polite: the same as clicking the close button
    for _ in 0..24 {
        if !procs::is_running(pid) {
            println!("closed {} (pid {pid})", user_data_dir.display());
            return;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    taskkill(&["/T", "/F", "/PID", &id]);
    std::thread::sleep(Duration::from_millis(500));
    if let Err(e) = launch::mark_clean_exit(user_data_dir) {
        eprintln!("could not mark a clean exit for {}: {e}", user_data_dir.display());
    }
    println!("stopped {} (pid {pid}); it did not close by itself", user_data_dir.display());
}

fn load_scope(scope_file: &Option<PathBuf>) -> Result<Vec<scan::ScopeEntry>, String> {
    match scope_file {
        Some(f) => Ok(scan::parse_scope(
            &std::fs::read_to_string(f).map_err(|e| format!("scope file {}: {e}", f.display()))?,
        )),
        None => Ok(Vec::new()),
    }
}

/// The address of a target we are allowed to touch, or an error. There is no
/// switch that skips this.
fn authorised(target: &str, scope: &[scan::ScopeEntry]) -> Result<std::net::IpAddr, String> {
    let ip = scan::resolve(target)?;
    if !scan::is_local(ip) && !scan::in_scope(target, ip, scope) {
        return Err(format!(
            "{target} ({ip}) is not on your own machine or network and is not in a scope file. Only test what you own or are authorised to test: list it in a file and pass --scope <file>."
        ));
    }
    Ok(ip)
}

fn http_get(url: &str, origin: Option<&str>) -> Result<(u16, audit::Headers), String> {
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(15))
        .redirects(0)
        .user_agent("gamblium-audit/0.1")
        .build();
    let mut req = agent.get(url);
    if let Some(o) = origin {
        req = req.set("Origin", o);
    }
    let resp = match req.call() {
        Ok(r) => r,
        Err(ureq::Error::Status(_, r)) => r, // 4xx and 5xx still carry headers worth reading
        Err(e) => return Err(format!("{url}: {e}")),
    };
    let mut names = resp.headers_names();
    names.sort();
    names.dedup();
    let mut headers = Vec::new();
    for name in names {
        for v in resp.all(&name) {
            headers.push((name.to_ascii_lowercase(), v.to_owned()));
        }
    }
    Ok((resp.status(), headers))
}

pub(crate) fn lookup_cves(product: &str, version: &str) -> Result<Vec<audit::Cve>, String> {
    let (vendor, name) = audit::cpe_for(product).ok_or(format!(
        "'{product}' is not in the product table yet (apache, nginx, openssh, openssl, php, tomcat, iis, ...)"
    ))?;
    let url = audit::nvd_url(vendor, name, version);
    let body = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(40))
        .user_agent("gamblium-audit/0.1")
        .build()
        .get(&url)
        .call()
        .map_err(|e| format!("NVD lookup failed: {e}"))?
        .into_string()
        .map_err(|e| format!("NVD answer unreadable: {e}"))?;
    let json: serde_json::Value = serde_json::from_str(&body).map_err(|e| format!("NVD answer is not JSON: {e}"))?;
    Ok(audit::parse_nvd(&json))
}

fn print_cves(product: &str, version: &str, cves: &[audit::Cve], top: usize) {
    println!("{product} {version}: {} known vulnerabilities in the NVD", cves.len());
    for c in cves.iter().take(top) {
        let score = c.score.map(|s| format!("{s:.1}")).unwrap_or("-".into());
        // NVD descriptions contain line breaks; keep each CVE on one line.
        let summary: String = c.summary.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(110).collect();
        println!("  {:<16} {:>4} {:<8} {}  {}", c.id, score, c.severity.as_deref().unwrap_or("-"), c.published, summary);
    }
}

#[derive(Serialize, Debug)]
pub(crate) struct AuditReport {
    url: String,
    ip: String,
    status: u16,
    findings: Vec<audit::Finding>,
    software: Vec<(String, String)>,
    cves: BTreeMap<String, Vec<audit::Cve>>,
}

/// Audits one page. `scope` is what the user may test beyond their own machine and network.
pub(crate) fn audit_report(url: &str, scope: &[scan::ScopeEntry], cve: bool) -> Result<AuditReport, String> {
    let parsed = url::Url::parse(url).map_err(|e| format!("bad URL: {e}"))?;
    let https = match parsed.scheme() {
        "https" => true,
        "http" => false,
        other => return Err(format!("only http and https can be audited, not {other}")),
    };
    let host = parsed.host_str().ok_or("the URL has no host")?.trim_matches(|c| c == '[' || c == ']');
    let ip = authorised(host, scope)?;

    let (status, headers) = http_get(url, None)?;
    let cors = http_get(url, Some(audit::PROBE_ORIGIN)).ok().map(|(_, h)| h);
    let findings = audit::analyse(https, scan::is_local(ip), &headers, cors.as_ref());
    let disclosed: Vec<&str> =
        headers.iter().filter(|(k, _)| k == "server" || k == "x-powered-by").map(|(_, v)| v.as_str()).collect();
    let software = audit::detect_software(&disclosed.join(" "));
    let mut cves = BTreeMap::new();
    if cve {
        for (product, version) in &software {
            if audit::cpe_for(product).is_some() {
                match lookup_cves(product, version) {
                    Ok(list) => {
                        cves.insert(format!("{product} {version}"), list);
                    }
                    Err(e) => eprintln!("{product} {version}: {e}"),
                }
            }
        }
    }
    Ok(AuditReport { url: url.to_owned(), ip: ip.to_string(), status, findings, software, cves })
}

fn run_audit(url: &str, scope_file: Option<PathBuf>, cve: bool, json: bool) -> Result<(), String> {
    let report = audit_report(url, &load_scope(&scope_file)?, cve)?;
    if json {
        println!("{}", serde_json::to_string(&report).unwrap());
        return Ok(());
    }
    println!("{} ({}) answered {}: {} findings", report.url, report.ip, report.status, report.findings.len());
    for f in &report.findings {
        let sev = format!("{:?}", f.severity).to_uppercase();
        println!("  [{sev:<6}] {}", f.title);
        println!("           {}", f.detail);
    }
    for (product, version) in &report.software {
        println!("  software: {product} {version}");
    }
    for (name, list) in &report.cves {
        let (product, version) = name.split_once(' ').unwrap_or((name, ""));
        print_cves(product, version, list, 5);
    }
    Ok(())
}

/// Scans targets after checking every one of them against the scope.
pub(crate) fn scan_targets(
    targets: &[String],
    ports: Option<&str>,
    scope: &[scan::ScopeEntry],
    timeout_ms: u64,
    workers: usize,
) -> Result<Vec<scan::ScanResult>, String> {
    let ports = match ports {
        Some(spec) => scan::parse_ports(spec)?,
        None => scan::COMMON_PORTS.to_vec(),
    };
    // Check every target before the first packet leaves.
    let mut resolved = Vec::new();
    for t in targets {
        resolved.push((t.clone(), authorised(t, scope)?));
    }
    Ok(resolved.into_iter().map(|(t, ip)| scan::scan(&t, ip, &ports, Duration::from_millis(timeout_ms), workers)).collect())
}

fn run_scan(
    targets: Vec<String>,
    ports: Option<String>,
    scope_file: Option<PathBuf>,
    timeout_ms: u64,
    workers: usize,
    json: bool,
) -> Result<(), String> {
    let results = scan_targets(&targets, ports.as_deref(), &load_scope(&scope_file)?, timeout_ms, workers)?;
    if json {
        println!("{}", serde_json::to_string(&results).unwrap());
        return Ok(());
    }
    for r in &results {
        println!("{} ({}): {} of {} ports open", r.target, r.ip, r.open.len(), r.ports_scanned);
        for p in &r.open {
            println!("  {:>5}/tcp  {}", p.port, p.banner.as_deref().unwrap_or(""));
        }
    }
    Ok(())
}

/// The look of a profile that was never given one.
const DEFAULT_THEME: &str = "moon-dark";

fn run_launch(mut a: LaunchArgs) -> Result<(), String> {
    let folder = if a.user_data_dir.is_some() {
        a.user_data_dir.clone()
    } else if a.agent {
        launch::agent_user_data_dir()
    } else if a.pentest {
        launch::pentest_user_data_dir()
    } else {
        None
    };
    rebrand::look_belongs_to(folder.as_deref());
    // Started from a shortcut: the theme chosen on the welcome page or in
    // Settings wins over the shortcut's default, if its preset still exists.
    if a.auto_dark {
        if let Some(chosen) = rebrand::chosen_theme() {
            let exists = launch::find_home().map(|h| h.join("presets").join(format!("theme-{chosen}.json")).is_file()).unwrap_or(false);
            if exists {
                a.theme = Some(chosen);
            }
        }
    }
    // Every Gamblium profile wears the same look until one is chosen for it:
    // test windows, named sessions and the agent profile included. Brave's
    // own profile (no folder given) is left as it is.
    if a.theme.is_none() {
        if let Some(folder) = &folder {
            let has_default = launch::find_home().map(|h| h.join("presets").join(format!("theme-{DEFAULT_THEME}.json")).is_file()).unwrap_or(false);
            if has_default && launch::read_launch_theme(folder).is_none() {
                a.theme = Some(DEFAULT_THEME.into());
            }
        }
    }
    let LaunchArgs { brave, dry_run, profile_directory, debug_port, no_gpu_pref, mut extra, .. } = a;
    // Gamblium's own browser: the installed copy (which came with the package,
    // or was made from the installed Brave and still matches it), or else the
    // one in the folder this program was started from (a package not installed).
    // The copy is made again by itself when it is out of date (owner: nobody should have to run
    // `gamblium rebrand`). Only when no Gamblium runs from it; otherwise at a later start.
    // From the installed programs only: a test window with GAMBLIUM_HOME on a branch must never
    // remake everybody's copy with that branch's patchers.
    let installed_home = std::env::var_os("LOCALAPPDATA").map(|d| std::path::PathBuf::from(d).join("Gamblium").join("app"));
    if !dry_run && !a.official && std::env::var_os("GAMBLIUM_HOME").is_none() {
        if let Some(home) = installed_home.filter(|h| h.join("tools").join("rebrand").is_dir()) {
            if let Some(line) = rebrand::refresh_if_needed(&brave, &home) {
                println!("{line}");
            }
        }
    }
    let brave = match (a.official || rebrand::wants_official(), rebrand::copy_dir()) {
        (false, Some(copy)) => match rebrand::state(&brave, &copy) {
            rebrand::Copy::Fresh(exe) => {
                println!("browser: Gamblium's rebranded copy of Brave");
                exe
            }
            rebrand::Copy::Stale { copy, installed } => {
                println!("note: the rebranded copy is for Brave {copy} but Brave {installed} is installed, and it could not be made again now (in use?). Starting the official Brave; the copy is refreshed at a later start.");
                brave
            }
            rebrand::Copy::None => match rebrand::packaged_browser() {
                Some(exe) => {
                    println!("browser: the one inside this Gamblium package");
                    exe
                }
                None => brave,
            },
        },
        _ => brave,
    };
    if !brave.is_file() {
        return Err(format!("no browser to start: this Gamblium has none of its own (run `gamblium install` from the full package) and Brave is not installed at {}", brave.display()));
    }
    // None = Brave's default folder, which Brave finds by itself.
    // --agent with --user-data-dir: an agent profile in a folder of the caller's choosing.
    let custom_dir = if a.user_data_dir.is_some() {
        a.user_data_dir.clone()
    } else if a.agent {
        Some(launch::agent_user_data_dir().ok_or("LOCALAPPDATA is not set")?)
    } else if a.pentest {
        Some(launch::pentest_user_data_dir().ok_or("LOCALAPPDATA is not set")?)
    } else {
        a.user_data_dir
    };
    let new_folder = custom_dir.as_deref().is_some_and(launch::is_new_profile_folder);

    // Layers, later ones win: built-in preset, debloat, new-profile defaults,
    // theme, then the caller's own preset files.
    let preset_name = a.preset.clone().unwrap_or_else(|| if a.agent { "performance".into() } else { "lean".into() });
    let mut preset =
        launch::builtin(&preset_name).ok_or(format!("unknown preset '{preset_name}' (lean, balanced, performance)"))?;
    if a.agent {
        // Brave asks where to save every download. An agent cannot answer a
        // Save-as dialog, so the agent profile saves to the download folder.
        preset.preferences.insert("download.prompt_for_download".into(), serde_json::json!(false));
    }
    let home = launch::find_home();
    let mut extension_freezes = false;
    let overlay = |preset: &mut launch::Preset, f: &std::path::Path| {
        launch::overlay_preset_file(preset, f).map_err(|e| format!("preset file {}: {e}", f.display()))
    };
    if let Some(home) = &home {
        let presets = home.join("presets");
        if !a.no_debloat && presets.join("debloat.json").is_file() {
            overlay(&mut preset, &presets.join("debloat.json"))?;
        }
        if new_folder && presets.join("new-profile.json").is_file() {
            overlay(&mut preset, &presets.join("new-profile.json"))?;
        }
        if let Some(theme) = &a.theme {
            if theme.is_empty() || !theme.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
                return Err(format!("'{theme}' is not a theme name"));
            }
            // A theme is a preset: one seed colour in the profile prefs colours
            // the whole browser. An old-style theme extension is loaded too if
            // one exists under theme/<name>.
            let f = presets.join(format!("theme-{theme}.json"));
            let dir = home.join("theme").join(theme);
            let has_extension = dir.join("manifest.json").is_file();
            if !f.is_file() && !has_extension {
                return Err(format!("no theme named '{theme}' (looked for {})", f.display()));
            }
            if f.is_file() {
                overlay(&mut preset, &f)?;
            }
            if has_extension {
                preset.args.push(format!("--load-extension={}", dir.display()));
            }
        }
        if !a.no_extension {
            let extension = if a.agent && !dry_run {
                launch::agent_extension(&home.join("extension")).map_err(|e| format!("agent extension: {e}"))?
            } else {
                home.join("extension")
            };
            preset.args.push(format!("--load-extension={}", extension.display()));
            // The extension does the freezing. In an agent's browser too: there
            // it freezes tabs the agent has left alone for two minutes and
            // wakes a tab when a command comes for it (an idle hidden session
            // used 16% of one core with its tabs awake: tester).
            extension_freezes = if a.agent { true } else { launch::freeze_by_extension(&mut preset) };
        }
    } else {
        if a.theme.is_some() {
            return Err("--theme needs the Gamblium folder (extension/, theme/, presets/). Set GAMBLIUM_HOME".into());
        }
        println!("note: Gamblium folder not found, so no extension, theme or debloat. Set GAMBLIUM_HOME to fix.");
    }
    for f in &a.preset_file {
        overlay(&mut preset, f)?;
    }
    // The look is dark unless the theme says light or the user's own background is light.
    let theme_name = a.theme.as_deref().unwrap_or("");
    let mut dark_look = if theme_name.ends_with("-auto") { !launch::windows_apps_are_light() } else { !theme_name.ends_with("-light") };
    if a.auto_dark {
        if let Some((accent, bg)) = rebrand::own_colours() {
            dark_look = rebrand::apply_own_colours(&mut preset, accent, bg, dark_look);
            println!("your own colours: the browser is {} and tells websites so", if dark_look { "dark" } else { "light" });
        }
    }
    if a.force_dark || (a.auto_dark && dark_look && rebrand::wants_dark_pages()) {
        preset.args.push(launch::FORCE_DARK_SWITCH.to_owned());
    }
    if a.apply_policies {
        let written = launch::apply_policies(&preset.policies, dry_run)?;
        let tag = if dry_run { "would be written" } else { "written" };
        println!("policies {tag} for this Windows user: {}", if written.is_empty() { "none in this preset".into() } else { written.join(", ") });
    }
    let main_profile = custom_dir.is_none();
    if debug_port.is_some() && main_profile {
        return Err("a debugging port is not allowed on the main profile: an attached debugger stops tabs from sleeping. Use --agent, --pentest or --user-data-dir".into());
    }
    if a.tls_keylog.is_some() && main_profile {
        return Err("--tls-keylog is not allowed on the main profile: it would write the keys of every logged-in session to disk. Use --pentest".into());
    }
    if a.agent && !dry_run {
        // Says to the helper: this browser is an agent's. Such a browser may
        // ask for permission to change settings but can never give it.
        if let Some(folder) = &folder {
            let _ = std::fs::create_dir_all(folder).and_then(|_| std::fs::write(folder.join(launch::AGENT_MARKER), "This profile is driven by agents.\n"));
        }
    }
    if a.agent {
        // An agent's window is usually covered, minimised or not there at all.
        // Its pages must keep running at full speed anyway, and the short
        // debugger attachment used for real input must not put up a warning bar.
        for s in [
            "--disable-backgrounding-occluded-windows",
            "--disable-renderer-backgrounding",
            "--disable-background-timer-throttling",
            "--silent-debugger-extension-api",
        ] {
            extra.push(s.into());
        }
    }
    if a.hidden {
        extra.push("--headless=new".into());
        println!("hidden: no window will open. Control it with `gamblium ctl`, end it with `gamblium close --agent`.");
    }
    if a.pentest {
        println!("pen-test profile: only test targets you own or are authorised to test.");
        // Keep Brave's own update and filter-list traffic out of the capture.
        extra.push("--disable-background-networking".into());
        extra.push("--disable-component-update".into());
    }
    if let Some(p) = &a.proxy {
        extra.push(format!("--proxy-server={p}"));
        if a.pentest {
            // Chromium skips the proxy for localhost; a local test target must go through it too.
            extra.push("--proxy-bypass-list=<-loopback>".into());
        }
        if main_profile {
            println!("note: ALL traffic of the main profile, logged-in sessions included, will go through {p}");
        }
    }
    if let Some(f) = &a.tls_keylog {
        extra.push(format!("--ssl-key-log-file={}", f.display()));
        println!("TLS keys will be written to {} (anyone with this file can decrypt the capture)", f.display());
    }
    let prefs_dir = match &custom_dir {
        Some(d) => d.clone(),
        None => launch::default_user_data_dir().ok_or("LOCALAPPDATA is not set")?,
    };
    let exe_name = brave.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let running = procs::browser_running(&exe_name, custom_dir.as_deref());
    let tag = if dry_run { "would change" } else { "changed" };

    println!("preset: {}   profile folder: {}", preset.name, prefs_dir.display());
    if running {
        // Brave rewrites Local State on exit, and switches only apply at start.
        println!("Brave is already running on this folder: prefs and switches are NOT applied this time.");
        println!("Close every Brave window of this profile and launch again to apply them.");
    } else {
        // Ours: any folder of Gamblium's (own profile, agents, sessions, tests), never Brave's own.
        let ours = custom_dir.is_some() && launch::default_user_data_dir().is_none_or(|brave| brave != prefs_dir);
        if !dry_run && launch::ensure_first_run_marker(&prefs_dir, ours).map_err(|e| format!("First Run marker: {e}"))? {
            println!("new profile folder: marked as already set up, so Brave keeps our settings");
        }
        // Lets Gamblium's own pages follow the theme. Without --theme the last
        // note stays, because the theme itself stays in the profile.
        // A test window, an agent's or a pen-test profile: no welcome page in
        // front (it stole the owner's screen during test runs).
        let welcome = !(a.skip_welcome || debug_port.is_some() || a.agent || a.pentest);
        if !dry_run && (a.theme.is_some() || extension_freezes || !welcome || prefs_dir.join(launch::LAUNCH_INFO_FILE).exists()) {
            launch::write_launch_info(&prefs_dir, a.theme.as_deref(), extension_freezes, welcome).map_err(|e| format!("launch note: {e}"))?;
        }
        let changed = launch::apply_local_state(&prefs_dir, &preset.local_state, dry_run)
            .map_err(|e| format!("Local State: {e}"))?;
        if changed.is_empty() {
            println!("prefs: already as wanted");
        }
        for k in &changed {
            println!("prefs {tag}: {k} = {}", preset.local_state[k]);
        }
        if !preset.preferences.is_empty() {
            let profile = profile_directory.as_deref().unwrap_or("Default");
            let changed = launch::apply_preferences(&prefs_dir, profile, &preset.preferences, dry_run)
                .map_err(|e| format!("Preferences: {e}"))?;
            for k in &changed {
                println!("profile prefs {tag} ({profile}): {k} = {}", preset.preferences[k]);
            }
        }
        if ours {
            let profile = profile_directory.as_deref().unwrap_or("Default");
            if launch::ensure_pinned(&prefs_dir, profile, host::EXTENSION_ID, dry_run).map_err(|e| format!("Preferences: {e}"))? {
                println!("profile prefs {tag} ({profile}): Gamblium's button pinned at the right end of the toolbar");
            }
            // Translation off once for profiles made before it was the default (#231; owner's yes,
            // Nov 14 2026): no "Translate this page?" bubble popping up by itself. Once only, so a
            // person who turns it back on keeps it.
            let marker = prefs_dir.join("gamblium-translate-off");
            if !dry_run && !marker.exists() {
                let mut off = serde_json::Map::new();
                off.insert("translate.enabled".into(), serde_json::json!(false));
                launch::apply_preferences(&prefs_dir, profile, &off, false).map_err(|e| format!("Preferences: {e}"))?;
                let _ = std::fs::write(&marker, "");
                println!("profile prefs changed ({profile}): translate.enabled = false (once)");
            }
        }
    }
    // The preference is a registry entry named after the program's path. A
    // browser run from an unpacked package may be deleted tomorrow, so
    // nothing is written for it; the installed one gets it.
    let tried_in_place = rebrand::packaged_browser().is_some_and(|p| p == brave);
    if tried_in_place {
        println!("GPU preference: not written for a package that is not installed");
    } else if !no_gpu_pref {
        match launch::ensure_gpu_preference(&brave, dry_run) {
            Ok(true) => println!("GPU preference {tag}: integrated GPU for {}", brave.display()),
            Ok(false) => println!("GPU preference: already set"),
            Err(e) => println!("GPU preference: could not set ({e})"),
        }
    }
    let args =
        launch::build_args(custom_dir.as_deref(), profile_directory.as_deref(), debug_port, &preset, &extra);
    println!("command: \"{}\" {}", brave.display(), args.join(" "));
    if dry_run {
        return Ok(());
    }
    // Once per profile: let our extension work in private and Tor windows too.
    let loads_extension = args.iter().any(|x| x.starts_with("--load-extension="));
    if loads_extension && !running && !a.hidden && !a.agent && private::failed_before(&prefs_dir, host::EXTENSION_ID) {
        println!("private windows: not tried again (it failed before; delete gamblium-private-access.failed in the profile folder to retry)");
    } else if loads_extension && !running && !a.hidden && !a.agent && !private::already_done(&prefs_dir, host::EXTENSION_ID) {
        match private::allow(&brave, &prefs_dir, &args, host::EXTENSION_ID) {
            Ok(()) => println!("private windows: the Gamblium extension is now allowed in private and Tor windows"),
            Err(e) => println!("private windows: could not switch the extension on there ({e}); it can be done by hand under Extensions > Gamblium > Allow in Private"),
        }
    }
    launch::spawn_detached(&brave, &args).map_err(|e| format!("could not start Brave: {e}"))?;
    Ok(())
}

fn stats(exe: &str, marker: Option<String>, duration: u64, interval: u64, top: usize) -> Report {
    let mut sampler = Sampler::new(exe, marker.clone());
    let start = Instant::now();
    let mut last = sampler.sample();
    let mut prev_cpu: HashMap<u32, u64> = last.iter().map(|p| (p.pid, p.cpu_ms)).collect();
    // CPU milliseconds used inside the window, per process. Summed per interval
    // so a process that exits still counts up to its last sample.
    let mut used: HashMap<u32, (String, u64)> = HashMap::new();

    let deadline = start + Duration::from_secs(duration);
    while Instant::now() < deadline {
        let left = deadline - Instant::now();
        std::thread::sleep(left.min(Duration::from_secs(interval)));
        last = sampler.sample();
        for p in &last {
            // A process first seen now spent all its CPU time inside the window.
            let before = prev_cpu.get(&p.pid).copied().unwrap_or(0);
            let e = used.entry(p.pid).or_insert_with(|| (p.kind.clone(), 0));
            e.1 += p.cpu_ms.saturating_sub(before);
        }
        prev_cpu = last.iter().map(|p| (p.pid, p.cpu_ms)).collect();
    }
    let window = start.elapsed().as_secs_f64();
    let pct = |ms: u64| if duration == 0 { 0.0 } else { ms as f64 / 1000.0 / window * 100.0 };

    let mut by_kind: BTreeMap<String, Group> = BTreeMap::new();
    let mut total = Group::default();
    for p in &last {
        for g in [by_kind.entry(p.kind.clone()).or_default(), &mut total] {
            g.procs += 1;
            g.private_ws_mb += p.private_ws as f64 / MB;
            g.commit_mb += p.commit as f64 / MB;
            g.ws_mb += p.ws as f64 / MB;
        }
    }
    for (kind, ms) in used.values() {
        by_kind.entry(kind.clone()).or_default().cpu_pct += pct(*ms);
        total.cpu_pct += pct(*ms);
    }

    let alive: HashMap<u32, &Proc> = last.iter().map(|p| (p.pid, p)).collect();
    let mut top_procs: Vec<TopProc> = if duration == 0 {
        last.iter()
            .map(|p| TopProc { pid: p.pid, kind: p.kind.clone(), cpu_pct: 0.0, private_ws_mb: p.private_ws as f64 / MB })
            .collect()
    } else {
        used.iter()
            .map(|(pid, (kind, ms))| TopProc {
                pid: *pid,
                kind: kind.clone(),
                cpu_pct: pct(*ms),
                private_ws_mb: alive.get(pid).map(|p| p.private_ws as f64 / MB).unwrap_or(0.0),
            })
            .collect()
    };
    if duration == 0 {
        top_procs.sort_by(|a, b| b.private_ws_mb.total_cmp(&a.private_ws_mb));
    } else {
        top_procs.sort_by(|a, b| b.cpu_pct.total_cmp(&a.cpu_pct));
    }
    top_procs.truncate(top);

    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1);
    Report {
        exe: exe.to_owned(),
        marker,
        window_sec: window,
        cores,
        cpu_pct_of_machine: total.cpu_pct / cores as f64,
        total,
        by_kind,
        top: top_procs,
        system_available_mb: procs::system_available() as f64 / MB,
        cpu_sec_total: last.iter().map(|p| p.cpu_ms).sum::<u64>() as f64 / 1000.0,
    }
}

fn print_table(r: &Report) {
    println!(
        "{} tree: {} processes, window {:.0} s, {} logical cores",
        r.exe, r.total.procs, r.window_sec, r.cores
    );
    println!("{:<28} {:>5} {:>10} {:>11} {:>10}", "process type", "procs", "CPU %core", "private MB", "commit MB");
    let row = |name: &str, g: &Group| {
        println!("{:<28} {:>5} {:>10.2} {:>11.0} {:>10.0}", name, g.procs, g.cpu_pct, g.private_ws_mb, g.commit_mb)
    };
    let mut kinds: Vec<_> = r.by_kind.iter().collect();
    kinds.sort_by(|a, b| b.1.cpu_pct.total_cmp(&a.1.cpu_pct).then(b.1.private_ws_mb.total_cmp(&a.1.private_ws_mb)));
    for (k, g) in kinds {
        row(k, g);
    }
    row("TOTAL", &r.total);
    println!(
        "CPU: {:.2}% of one core = {:.2}% of the machine. System available: {:.0} MB",
        r.total.cpu_pct, r.cpu_pct_of_machine, r.system_available_mb
    );
    println!("busiest processes:");
    for t in &r.top {
        println!("  pid {:>6}  {:<26} {:>7.2} %core  {:>6.0} MB", t.pid, t.kind, t.cpu_pct, t.private_ws_mb);
    }
}

//! Process-tree sampling for a Chromium-family browser.
//!
//! Finds every root process of the browser (by exe name, optionally narrowed by
//! a marker in its command line such as the user-data-dir), takes all its
//! descendants, and reads CPU time and memory counters for each one.

use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

#[derive(Clone, Debug, Serialize)]
pub struct Proc {
    pub pid: u32,
    pub ppid: u32,
    /// browser, renderer, extension, gpu, utility:<Service>, crashpad-handler, ...
    pub kind: String,
    /// Chromium's own number for a page process (`--renderer-client-id`). The
    /// extension sees the same number as a frame's processId, which is how a
    /// tab is matched to its process.
    pub client_id: Option<u32>,
    /// Kernel + user CPU time since the process started.
    pub cpu_ms: u64,
    pub ws: u64,
    pub private_ws: u64,
    pub commit: u64,
}

pub struct Sampler {
    sys: System,
    exe: String,
    marker: Option<String>,
    /// Only the tree under this browser process, if set.
    pub root: Option<u32>,
}

impl Sampler {
    pub fn new(exe: &str, marker: Option<String>) -> Self {
        Self { sys: System::new(), exe: exe.to_ascii_lowercase(), marker, root: None }
    }

    pub fn sample(&mut self) -> Vec<Proc> {
        // The command line is read once per process and then kept.
        self.sys.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing().with_cmd(UpdateKind::OnlyIfNotSet),
        );

        let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
        let mut roots = Vec::new();
        for (pid, p) in self.sys.processes() {
            let pid = pid.as_u32();
            if let Some(pp) = p.parent() {
                children.entry(pp.as_u32()).or_default().push(pid);
            }
            let name = p.name().to_string_lossy().to_ascii_lowercase();
            if name != self.exe {
                continue;
            }
            let hit = match &self.marker {
                None => true,
                Some(m) => p.cmd().iter().any(|a| a.to_string_lossy().contains(m.as_str())),
            };
            if hit {
                roots.push(pid);
            }
        }
        if let Some(root) = self.root {
            roots.retain(|p| *p == root);
        }

        let mut seen = HashSet::new();
        let mut stack = roots;
        while let Some(pid) = stack.pop() {
            if !seen.insert(pid) {
                continue;
            }
            if let Some(kids) = children.get(&pid) {
                stack.extend(kids.iter().copied());
            }
        }

        let mut out = Vec::with_capacity(seen.len());
        for pid in seen {
            let Some(p) = self.sys.process(sysinfo::Pid::from_u32(pid)) else { continue };
            let Some(c) = os::counters(pid) else { continue };
            out.push(Proc {
                pid,
                ppid: p.parent().map(|x| x.as_u32()).unwrap_or(0),
                // A child that is not the browser's own exe (our helper, its
                // launcher, a download opened from the browser) is not a browser process.
                kind: if p.name().to_string_lossy().eq_ignore_ascii_case(&self.exe) {
                    classify(p.cmd())
                } else {
                    "other".into()
                },
                client_id: client_id(p.cmd()),
                cpu_ms: c.cpu_ms,
                ws: c.ws,
                private_ws: c.private_ws,
                commit: c.commit,
            });
        }
        out.sort_by_key(|p| p.pid);
        out
    }
}

/// The `--renderer-client-id=N` of a page process.
pub fn client_id(cmd: &[OsString]) -> Option<u32> {
    cmd.iter().find_map(|a| a.to_string_lossy().strip_prefix("--renderer-client-id=").and_then(|v| v.parse().ok()))
}

/// The browser process that started us, found by walking up our parents.
/// Used by the native-messaging host to report on its own browser only.
pub fn browser_ancestor(exe: &str) -> Option<u32> {
    let mut sys = System::new();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_cmd(UpdateKind::Always),
    );
    let mut pid = sysinfo::Pid::from_u32(std::process::id());
    for _ in 0..8 {
        let parent = sys.process(pid)?.parent()?;
        let p = sys.process(parent)?;
        if p.name().to_string_lossy().eq_ignore_ascii_case(exe) && classify(p.cmd()) == "browser" {
            return Some(parent.as_u32());
        }
        pid = parent;
    }
    None
}

/// Chromium marks every child process with `--type=`; the browser process has none.
pub fn classify(cmd: &[OsString]) -> String {
    let args: Vec<String> = cmd.iter().map(|a| a.to_string_lossy().into_owned()).collect();
    let find = |prefix: &str| args.iter().find_map(|a| a.strip_prefix(prefix).map(str::to_owned));
    match find("--type=").as_deref() {
        None => "browser".into(),
        Some("renderer") => {
            if args.iter().any(|a| a == "--extension-process") { "extension".into() } else { "renderer".into() }
        }
        Some("gpu-process") => "gpu".into(),
        Some("utility") => match find("--utility-sub-type=") {
            Some(sub) => format!("utility:{}", sub.rsplit('.').next().unwrap_or(&sub)),
            None => "utility".into(),
        },
        Some(other) => other.to_owned(),
    }
}

/// Every running main (browser) process of `exe`, with its profile folder.
/// `None` means the default folder, i.e. the user's real profile.
pub fn browsers(exe: &str) -> Vec<(u32, Option<String>)> {
    let mut sys = System::new();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_cmd(UpdateKind::Always),
    );
    sys.processes()
        .iter()
        .filter(|(_, p)| p.name().to_string_lossy().eq_ignore_ascii_case(exe) && classify(p.cmd()) == "browser")
        .map(|(pid, p)| {
            let dir = p
                .cmd()
                .iter()
                .map(|a| a.to_string_lossy().into_owned())
                .find_map(|a| a.strip_prefix("--user-data-dir=").map(|v| v.trim_matches('"').to_owned()));
            (pid.as_u32(), dir)
        })
        .collect()
}

/// The program file of a running process.
pub fn exe_of(pid: u32) -> Option<std::path::PathBuf> {
    let mut sys = System::new();
    let p = sysinfo::Pid::from_u32(pid);
    sys.refresh_processes_specifics(ProcessesToUpdate::Some(&[p]), true, ProcessRefreshKind::nothing().with_exe(UpdateKind::Always));
    sys.process(p).and_then(|p| p.exe()).map(|e| e.to_path_buf())
}

pub fn is_running(pid: u32) -> bool {
    let mut sys = System::new();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[sysinfo::Pid::from_u32(pid)]),
        true,
        ProcessRefreshKind::nothing(),
    );
    sys.process(sysinfo::Pid::from_u32(pid)).is_some()
}

/// True if a browser process of `exe` is running on this user-data-dir.
/// `None` means Brave's default location (no `--user-data-dir` switch).
pub fn browser_running(exe: &str, user_data_dir: Option<&std::path::Path>) -> bool {
    let mut sys = System::new();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_cmd(UpdateKind::Always),
    );
    let want = user_data_dir.map(|d| d.to_string_lossy().to_ascii_lowercase());
    sys.processes().values().any(|p| {
        if !p.name().to_string_lossy().eq_ignore_ascii_case(exe) || classify(p.cmd()) != "browser" {
            return false;
        }
        let udd = p
            .cmd()
            .iter()
            .map(|a| a.to_string_lossy().to_ascii_lowercase())
            .find_map(|a| a.strip_prefix("--user-data-dir=").map(|v| v.trim_matches('"').to_owned()));
        match (&want, udd) {
            (None, None) => true,
            (Some(w), Some(u)) => u.trim_end_matches('\\') == w.trim_end_matches('\\'),
            _ => false,
        }
    })
}

pub struct Counters {
    pub cpu_ms: u64,
    pub ws: u64,
    pub private_ws: u64,
    pub commit: u64,
}

/// Physical memory the system could still hand out, in bytes.
pub fn system_available() -> u64 {
    os::system_available()
}

/// Stops every thread of a process. It keeps its memory and uses no CPU until thawed.
pub fn freeze(pid: u32) -> Result<(), String> {
    os::suspend_resume(pid, true)
}

/// Lets a frozen process run again.
pub fn thaw(pid: u32) -> Result<(), String> {
    os::suspend_resume(pid, false)
}

/// Asks Windows to move the process's memory out of RAM (compressed or to the
/// page file). It comes back page by page when the process touches it again.
pub fn trim(pid: u32) -> Result<(), String> {
    os::trim(pid)
}

/// Normal priority and no power throttling (EcoQoS) for a process the
/// browser runs as a background one. For the extension's process: at idle
/// priority it got almost no CPU while pages loaded, and its events arrived
/// seconds late (backend: with 15 tabs loading, the load queue held none;
/// raised, it held exactly as many as it should).
pub fn lift(pid: u32) -> Result<(), String> {
    os::lift(pid)
}

#[cfg(windows)]
mod os {
    use super::Counters;
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, HANDLE};
    use windows_sys::Win32::System::ProcessStatus::{
        K32EmptyWorkingSet, K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS,
    };
    use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    use windows_sys::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, ProcessPowerThrottling, SetPriorityClass, SetProcessInformation,
        NORMAL_PRIORITY_CLASS, PROCESS_POWER_THROTTLING_CURRENT_VERSION, PROCESS_POWER_THROTTLING_EXECUTION_SPEED,
        PROCESS_POWER_THROTTLING_STATE, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SET_INFORMATION, PROCESS_SET_QUOTA,
        PROCESS_SUSPEND_RESUME, PROCESS_VM_READ,
    };

    /// PROCESS_MEMORY_COUNTERS_EX2 (Windows 10 22H2 and later).
    #[repr(C)]
    #[derive(Default)]
    struct PmcEx2 {
        cb: u32,
        page_fault_count: u32,
        peak_working_set_size: usize,
        working_set_size: usize,
        quota_peak_paged_pool_usage: usize,
        quota_paged_pool_usage: usize,
        quota_peak_non_paged_pool_usage: usize,
        quota_non_paged_pool_usage: usize,
        pagefile_usage: usize,
        peak_pagefile_usage: usize,
        private_usage: usize,
        private_working_set_size: usize,
        shared_commit_usage: u64,
    }

    fn ft_ms(ft: &FILETIME) -> u64 {
        (((ft.dwHighDateTime as u64) << 32) | ft.dwLowDateTime as u64) / 10_000
    }

    pub fn counters(pid: u32) -> Option<Counters> {
        unsafe {
            let mut h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, 0, pid);
            if h.is_null() {
                h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            }
            if h.is_null() {
                return None;
            }
            let zero = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
            let (mut created, mut exited, mut kernel, mut user) = (zero, zero, zero, zero);
            let times_ok = GetProcessTimes(h, &mut created, &mut exited, &mut kernel, &mut user) != 0;

            let mut pmc = PmcEx2::default();
            pmc.cb = std::mem::size_of::<PmcEx2>() as u32;
            let mem_ok =
                K32GetProcessMemoryInfo(h, &mut pmc as *mut PmcEx2 as *mut PROCESS_MEMORY_COUNTERS, pmc.cb) != 0;
            CloseHandle(h);
            if !times_ok || !mem_ok {
                return None;
            }
            Some(Counters {
                cpu_ms: ft_ms(&kernel) + ft_ms(&user),
                ws: pmc.working_set_size as u64,
                private_ws: pmc.private_working_set_size as u64,
                commit: pmc.private_usage as u64,
            })
        }
    }

    #[link(name = "ntdll")]
    extern "system" {
        fn NtSuspendProcess(handle: HANDLE) -> i32;
        fn NtResumeProcess(handle: HANDLE) -> i32;
    }

    pub fn suspend_resume(pid: u32, suspend: bool) -> Result<(), String> {
        unsafe {
            let h = OpenProcess(PROCESS_SUSPEND_RESUME, 0, pid);
            if h.is_null() {
                return Err(format!("cannot open process {pid}"));
            }
            let status = if suspend { NtSuspendProcess(h) } else { NtResumeProcess(h) };
            CloseHandle(h);
            if status < 0 {
                return Err(format!("NTSTATUS {status:#x} for process {pid}"));
            }
            Ok(())
        }
    }

    pub fn trim(pid: u32) -> Result<(), String> {
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SET_QUOTA, 0, pid);
            if h.is_null() {
                return Err(format!("cannot open process {pid}"));
            }
            let ok = K32EmptyWorkingSet(h) != 0;
            CloseHandle(h);
            if ok { Ok(()) } else { Err(format!("could not trim process {pid}")) }
        }
    }

    pub fn lift(pid: u32) -> Result<(), String> {
        unsafe {
            let h = OpenProcess(PROCESS_SET_INFORMATION, 0, pid);
            if h.is_null() {
                return Err(format!("cannot open process {pid}"));
            }
            let prio = SetPriorityClass(h, NORMAL_PRIORITY_CLASS) != 0;
            // Execution speed throttling explicitly off (ControlMask set, StateMask clear).
            let state = PROCESS_POWER_THROTTLING_STATE {
                Version: PROCESS_POWER_THROTTLING_CURRENT_VERSION,
                ControlMask: PROCESS_POWER_THROTTLING_EXECUTION_SPEED,
                StateMask: 0,
            };
            let eco = SetProcessInformation(
                h,
                ProcessPowerThrottling,
                &state as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<PROCESS_POWER_THROTTLING_STATE>() as u32,
            ) != 0;
            CloseHandle(h);
            if prio && eco { Ok(()) } else { Err(format!("could not raise process {pid} (priority {prio}, power {eco})")) }
        }
    }

    pub fn system_available() -> u64 {
        unsafe {
            let mut m: MEMORYSTATUSEX = std::mem::zeroed();
            m.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
            if GlobalMemoryStatusEx(&mut m) != 0 { m.ullAvailPhys } else { 0 }
        }
    }
}

#[cfg(not(windows))]
mod os {
    use super::Counters;
    pub fn counters(_pid: u32) -> Option<Counters> {
        None
    }
    pub fn suspend_resume(_pid: u32, _suspend: bool) -> Result<(), String> {
        Err("only implemented on Windows".into())
    }
    pub fn trim(_pid: u32) -> Result<(), String> {
        Err("only implemented on Windows".into())
    }
    pub fn lift(_pid: u32) -> Result<(), String> {
        Err("only implemented on Windows".into())
    }
    pub fn system_available() -> u64 {
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cmd(args: &[&str]) -> Vec<OsString> {
        args.iter().map(OsString::from).collect()
    }

    #[test]
    fn classifies_chromium_process_types() {
        assert_eq!(classify(&cmd(&["brave.exe", "--user-data-dir=x"])), "browser");
        assert_eq!(classify(&cmd(&["brave.exe", "--type=renderer", "--lang=en"])), "renderer");
        assert_eq!(classify(&cmd(&["brave.exe", "--type=renderer", "--extension-process"])), "extension");
        assert_eq!(classify(&cmd(&["brave.exe", "--type=gpu-process"])), "gpu");
        assert_eq!(
            classify(&cmd(&["brave.exe", "--type=utility", "--utility-sub-type=network.mojom.NetworkService"])),
            "utility:NetworkService"
        );
        assert_eq!(classify(&cmd(&["brave.exe", "--type=utility"])), "utility");
        assert_eq!(classify(&cmd(&["brave.exe", "--type=crashpad-handler"])), "crashpad-handler");
        assert_eq!(client_id(&cmd(&["brave.exe", "--type=renderer", "--renderer-client-id=42"])), Some(42));
        assert_eq!(client_id(&cmd(&["brave.exe", "--type=gpu-process"])), None);
    }
}

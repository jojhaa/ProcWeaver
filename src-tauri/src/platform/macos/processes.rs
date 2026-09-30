use crate::routing_overrides::{native::ProcessRecord, tracker::{self, ProcessEntry}};
use std::{mem::{size_of, zeroed}, process::Child, sync::atomic::Ordering, time::{Duration, Instant}};

fn info(pid: u32) -> Option<libc::proc_bsdinfo> {
    let mut value: libc::proc_bsdinfo = unsafe { zeroed() };
    let read = unsafe { libc::proc_pidinfo(pid.try_into().ok()?, libc::PROC_PIDTBSDINFO, 0,
        (&mut value as *mut libc::proc_bsdinfo).cast(), size_of::<libc::proc_bsdinfo>() as i32) };
    (read as usize == size_of::<libc::proc_bsdinfo>()).then_some(value)
}

pub fn inspect(pid: u32, parent_pid: u32, name: String) -> ProcessEntry {
    let mut entry = ProcessEntry { pid, parent_pid, name, identity: String::new(), created_at: 0,
        executable_path: None, parent_identity: None, ancestors: vec![] };
    let Some(before) = info(pid) else { return entry; };
    let mut path = vec![0u8; 4096];
    let length = unsafe { libc::proc_pidpath(pid as i32, path.as_mut_ptr().cast(), path.len() as u32) };
    let Some(after) = info(pid) else { return entry; };
    if before.pbi_start_tvsec != after.pbi_start_tvsec || before.pbi_start_tvusec != after.pbi_start_tvusec { return entry; }
    entry.parent_pid = before.pbi_ppid;
    entry.created_at = before.pbi_start_tvsec.saturating_mul(1_000_000).saturating_add(before.pbi_start_tvusec);
    if entry.created_at > 0 { entry.identity = format!("{pid}:{}", entry.created_at); }
    if length > 0 {
        let end = path.iter().position(|b| *b == 0).unwrap_or(path.len());
        if let Ok(path) = std::str::from_utf8(&path[..end]) {
            entry.name = std::path::Path::new(path).file_name().map(|p| p.to_string_lossy().into_owned()).unwrap_or(entry.name);
            entry.executable_path = Some(path.into());
        }
    }
    entry
}

pub fn process_list() -> Result<Vec<ProcessRecord>, String> {
    let mut pids = vec![0i32; 8193];
    let count = unsafe { libc::proc_listallpids(pids.as_mut_ptr().cast(), (pids.len() * size_of::<i32>()) as i32) };
    if count < 0 { return Err("读取 macOS 进程列表失败".into()); }
    if count as usize >= pids.len() { return Err("进程树超过 8192 项，跟踪受限".into()); }
    let mut result = Vec::new();
    for pid in pids.into_iter().take(count as usize).filter(|p| *p > 0) {
        let entry = inspect(pid as u32, 0, String::new());
        if entry.created_at > 0 {
            result.push(ProcessRecord { pid: entry.pid, parent_pid: entry.parent_pid, name: entry.name });
        }
    }
    Ok(result)
}

/// 使用无特权快照，不将轮询宣称为可靠的所有创建/退出事件。
pub fn observe() -> Result<(), String> {
    tracker::reconcile(crate::routing_overrides::native::snapshot()?, true);
    while tracker::ENABLED.load(Ordering::Acquire) {
        tracker::limited("macOS 使用进程快照跟踪；短命子进程可能未被观察，实际代理以连接记录为准");
        std::thread::sleep(std::time::Duration::from_millis(500));
        tracker::reconcile(crate::routing_overrides::native::snapshot()?, false);
    }
    Ok(())
}

/// KERN_PROCARGS2 尾部还包含环境变量；只读取 argc 个 argv，绝不保存环境。
pub fn arguments(pid: u32) -> Result<Vec<String>, String> {
    let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, i32::try_from(pid).map_err(|_| "PID 无效")?];
    let mut bytes = vec![0u8; 1024 * 1024]; let mut length = bytes.len();
    if unsafe { libc::sysctl(mib.as_mut_ptr(), 3, bytes.as_mut_ptr().cast(), &mut length, std::ptr::null_mut(), 0) } != 0 {
        return Err("应用参数不可读，请正常退出目标程序后从 ProcWeaver 启动".into());
    }
    bytes.truncate(length);
    crate::platform::arguments::parse_process_arguments(&bytes)
}

pub fn request_close(pid: u32, identity: &str) -> Result<(), String> {
    let current = inspect(pid, 0, String::new());
    if current.identity.is_empty() || current.identity != identity || pid == std::process::id() {
        return Err("应用实例已改变，请重新检测".into());
    }
    // NSRunningApplication.terminate 请求指定实例正常退出，应用可以拒绝。
    let script = format!("ObjC.import('AppKit'); var app = $.NSRunningApplication.runningApplicationWithProcessIdentifier({pid}); if (!app || !app.terminate()) throw new Error('quit refused');");
    super::text("/usr/bin/osascript", &["-l", "JavaScript", "-e", &script])?;
    Ok(())
}

/// Give Mihomo a chance to release its listeners and future utun state.
/// The Child handle keeps this PID from being reused until it is reaped.
pub fn stop_core(child: &mut Child) -> Result<bool, String> {
    if child.try_wait().map_err(|_| "读取核心退出状态失败")?.is_some() { return Ok(true); }
    let pid = i32::try_from(child.id()).map_err(|_| "核心 PID 无效")?;
    if unsafe { libc::kill(pid, libc::SIGTERM) } != 0
        && std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH) {
        return Err("请求核心正常退出失败；未强制结束".into());
    }
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        if child.try_wait().map_err(|_| "读取核心退出状态失败")?.is_some() { return Ok(true); }
        if Instant::now() >= deadline { break; }
        std::thread::sleep(Duration::from_millis(50));
    }
    match child.kill() {
        Ok(()) => { child.wait().map_err(|_| "等待核心强制退出失败")?; Ok(false) },
        Err(_) if child.try_wait().map_err(|_| "读取核心退出状态失败")?.is_some() => Ok(true),
        Err(_) => Err("核心未在限定时间内正常退出，强制结束也失败".into()),
    }
}

pub fn owns_socket(addr: std::net::SocketAddr, pid: u32, tcp: bool) -> Result<bool, String> {
    if pid == 0 { return Ok(false); }
    let filter = format!("-i{}:{}", if tcp { "TCP" } else { "UDP" }, addr.port());
    let mut args = vec!["-nP", &filter, "-Fpn"];
    if tcp { args.push("-sTCP:LISTEN"); }
    let result = super::output("/usr/sbin/lsof", &args, std::time::Duration::from_secs(3))?;
    if !result.status.success() && !(result.status.code() == Some(1) && result.stdout.is_empty() && result.stderr.is_empty()) {
        return Err("无法核验 macOS DNS 监听进程归属".into());
    }
    let raw = std::str::from_utf8(&result.stdout).map_err(|_| "端口归属结果无效")?;
    let mut owner = 0; let mut found = false;
    for line in raw.lines() {
        if let Some(value) = line.strip_prefix('p') { owner = value.parse::<u32>().map_err(|_| "端口所属进程无效")?; }
        if let Some(endpoint) = line.strip_prefix('n') {
            // 连接态 UDP 的远端不参与监听地址匹配。
            let endpoint = endpoint.split("->").next().unwrap_or(endpoint);
            let parsed = if endpoint.starts_with("*:") {
                Some(std::net::SocketAddr::new(if addr.is_ipv4() { std::net::Ipv4Addr::UNSPECIFIED.into() } else { std::net::Ipv6Addr::UNSPECIFIED.into() }, addr.port()))
            } else { endpoint.parse().ok() };
            if let Some(endpoint) = parsed {
                if endpoint.port() == addr.port() && endpoint.is_ipv4() == addr.is_ipv4()
                    && (endpoint.ip() == addr.ip() || endpoint.ip().is_unspecified() || addr.ip().is_unspecified()) {
                    if owner != pid { return Err("DNS 监听端口被其他进程占用".into()); }
                    found = true;
                }
            }
        }
    }
    Ok(found)
}

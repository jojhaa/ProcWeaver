//! 只改当前网络服务的 HTTP/HTTPS/SOCKS；先持久化恢复记录，回读确认。
use serde::{Deserialize, Serialize};
use std::{fs::{File, OpenOptions}, os::fd::AsRawFd, path::{Path, PathBuf}, sync::{Mutex, MutexGuard}, time::{Duration, Instant}};
use crate::commands::sysproxy::SystemProxyStatus;
static LOCK: Mutex<()> = Mutex::new(());
static CACHE: Mutex<Option<(Instant, Result<SystemProxyStatus, String>)>> = Mutex::new(None);
fn invalidate() { if let Ok(mut cache) = CACHE.lock() { *cache = None; } }

use crate::platform::proxy_state::{Proxy, owner_pid, parse, needs_restore, restore_incomplete, safe_core_handoff};
#[derive(Clone, Serialize, Deserialize)]
struct Recovery { service: String, owner: String, port: u16, original: Vec<Proxy> }
const TYPES: [&str; 3] = ["webproxy", "securewebproxy", "socksfirewallproxy"];
fn path() -> PathBuf { crate::storage::data_dir().join("config/macos-proxy-recovery.json") }
pub(crate) fn journal_path() -> PathBuf { path() }
// The core guardian and a new GUI process can recover at the same time. The
// separate, persistent lock inode covers journal replacement and deletion too.
fn lock(record_path: &Path) -> Result<(MutexGuard<'static, ()>, File), String> {
    let local = LOCK.lock().map_err(|_| "系统代理状态锁不可用")?;
    let lock_path = record_path.with_extension("lock");
    std::fs::create_dir_all(lock_path.parent().ok_or("代理恢复路径无效")?).map_err(|_| "代理恢复目录不可用")?;
    let file = OpenOptions::new().read(true).write(true).create(true).open(lock_path)
        .map_err(|_| "代理恢复锁不可用")?;
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) } != 0 {
        return Err("代理恢复锁不可用".into());
    }
    Ok((local, file))
}
fn tool(args: &[&str]) -> Result<String, String> { super::text("/usr/sbin/networksetup", args) }
fn owner() -> String { super::processes::inspect(std::process::id(), 0, String::new()).identity }
fn record(record_path: &Path) -> Result<Option<Recovery>, String> {
    match std::fs::read(record_path) {
        Ok(bytes) => {
            let record: Recovery = serde_json::from_slice(&bytes).map_err(|_| "系统代理恢复记录损坏，未覆盖")?;
            if record.original.len() != TYPES.len() || record.port == 0 || record.service.is_empty() || owner_pid(&record.owner).is_none() {
                return Err("系统代理恢复记录无效，未覆盖".into());
            }
            Ok(Some(record))
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("读取系统代理恢复记录失败".into()),
    }
}
fn current_service() -> Result<String, String> {
    let route = super::text("/sbin/route", &["-n", "get", "default"])
        .or_else(|_| super::text("/sbin/route", &["-n", "get", "-inet6", "default"]))?;
    let device = route.lines().find_map(|line| line.trim().strip_prefix("interface:").map(str::trim)).ok_or("无法识别当前网络接口")?;
    let order = tool(&["-listnetworkserviceorder"])?;
    let mut service = None;
    for line in order.lines() {
        let line = line.trim();
        if line.starts_with('(') && !line.starts_with("(Hardware Port:") {
            service = line.split_once(") ").and_then(|(prefix, name)| if prefix.contains('*') { None } else { Some(name.to_owned()) });
        } else if line.contains(&format!("Device: {device})")) {
            return service.ok_or("当前网络服务已停用".into());
        }
    }
    Err("无法定位当前网络服务；可使用业务包的应用代理入口".into())
}
fn read(service: &str) -> Result<Vec<Proxy>, String> {
    TYPES.iter().map(|kind| parse(&tool(&[&format!("-get{kind}"), service])?)).collect()
}
fn ours(value: &Proxy, port: u16) -> bool { value.enabled && value.server == "127.0.0.1" && value.port == port && !value.authenticated }
fn write(service: &str, kind: &str, value: &Proxy) -> Result<(), String> {
    if value.authenticated { return Err("认证代理需要保留系统凭据，未修改".into()); }
    // 先关闭再尝试恢复字段；恢复未配置的空地址失败时也不能遗留启用状态。
    if !value.enabled { tool(&[&format!("-set{kind}state"), service, "off"])?; }
    tool(&[&format!("-set{kind}"), service, &value.server, &value.port.to_string()])?;
    tool(&[&format!("-set{kind}state"), service, if value.enabled { "on" } else { "off" }])?;
    Ok(())
}
fn restore(record_path: &Path, record: &Recovery) -> Result<(), String> {
    let current = read(&record.service)?;
    for ((kind, now), original) in TYPES.iter().zip(current).zip(&record.original) {
        if now == *original { continue; }
        // 启用写到一半时可能仍是 disabled，但地址/端口已经写入。
        if needs_restore(&now, original, record.port) {
            let result = write(&record.service, kind, original);
            // 未启用且原地址为空时，系统可能拒绝空地址/0；回读仍须确认地址和端口已清除。
            if original.enabled || !original.server.is_empty() || original.port != 0 { result?; }
        }
        // 外部变更归外部所有，保留，不覆盖。
    }
    let verified = read(&record.service)?;
    if verified.iter().zip(&record.original).any(|(now, original)| restore_incomplete(now, original, record.port)) {
        return Err("系统代理恢复未确认，已保留恢复记录，请重试".into());
    }
    std::fs::remove_file(record_path).map_err(|_| "代理已恢复，但恢复记录清理失败")?;
    Ok(())
}
pub fn recover() -> Result<(), String> {
    let record_path = path();
    let _lock = lock(&record_path)?;
    invalidate();
    let Some(record) = record(&record_path)? else { return Ok(()); };
    if record.owner != owner() {
        let pid = owner_pid(&record.owner).ok_or("系统代理恢复记录的宿主身份无效")?;
        if super::processes::inspect(pid, 0, String::new()).identity == record.owner { return Err("另一实例仍持有系统代理，请先退出该实例".into()); }
        restore(&record_path, &record)?;
    }
    Ok(())
}
pub(crate) fn recover_for_dead_owner(record_path: &Path, expected_owner: &str) -> Result<(), String> {
    let _lock = lock(record_path)?;
    let Some(record) = record(record_path)? else { return Ok(()); };
    // A newly started GUI may already own a replacement record. Never touch it.
    if record.owner != expected_owner { return Ok(()); }
    let pid = owner_pid(expected_owner).ok_or("核心保护读取到无效宿主身份")?;
    if super::processes::inspect(pid, 0, String::new()).identity == expected_owner {
        return Err("宿主仍在运行，暂不恢复代理".into());
    }
    restore(record_path, &record)
}
pub(crate) fn owns_recovery(record_path: &Path, expected_owner: &str) -> Result<bool, String> {
    let _lock = lock(record_path)?;
    Ok(record(record_path)?.is_some_and(|record| record.owner == expected_owner))
}
pub fn has_recovery() -> bool { path().exists() }
/// 核心重启可沿用本实例完整启用的代理；其他恢复记录必须先处理。
pub fn ensure_core_start_safe() -> Result<(), String> {
    let record_path = path();
    let _lock = lock(&record_path)?;
    let Some(record) = record(&record_path)? else { return Ok(()); };
    if record.owner != owner() {
        return Err("系统代理恢复记录尚未处理，请先点击系统代理按钮重试恢复".into());
    }
    let service = current_service()?;
    let current = read(&record.service)?;
    if safe_core_handoff(true, record.service == service, &current, record.port) { return Ok(()); }
    Err("系统代理恢复状态未确认，请先点击系统代理按钮重试恢复".into())
}
pub fn status() -> Result<SystemProxyStatus, String> {
    let record_path = path();
    let _lock = lock(&record_path)?;
    if let Some((time, result)) = CACHE.lock().map_err(|_| "代理状态缓存不可用")?.as_ref() {
        if time.elapsed() < Duration::from_secs(2) { return result.clone(); }
    }
    let result = read_status(&record_path);
    *CACHE.lock().map_err(|_| "代理状态缓存不可用")? = Some((Instant::now(), result.clone()));
    result
}
fn read_status(record_path: &Path) -> Result<SystemProxyStatus, String> {
    let record = record(record_path)?;
    let service = current_service()?;
    let current = read(&service)?;
    let active = record.as_ref().is_some_and(|record|
        safe_core_handoff(record.owner == owner(), record.service == service, &current, record.port));
    let pending = record.is_some() && !active;
    let state = if active { "enabled" }
        else if pending { "unknown" }
        else if current.iter().any(|v| v.enabled) { "external" }
        else { "disabled" };
    let message = if pending && record.as_ref().is_some_and(|record| record.service != service) {
        "网络服务已切换，旧服务的系统代理恢复记录仍待处理；请重试恢复"
    } else if pending { "系统代理恢复未完成，已保留记录；请重试恢复或检查 macOS 网络代理设置" }
        else { "仅作用于遵循当前网络服务代理设置的应用" };
    Ok(SystemProxyStatus { state: state.into(), bypass_changed: false, message: message.into(), last_change: None })
}
pub fn set(enable: bool, port: Option<u16>) -> Result<bool, String> {
    let record_path = path();
    let _lock = lock(&record_path)?;
    invalidate();
    if !enable {
        if let Some(record) = record(&record_path)? {
            if record.owner != owner() {
                let pid = owner_pid(&record.owner).ok_or("系统代理恢复记录的宿主身份无效")?;
                if super::processes::inspect(pid, 0, String::new()).identity == record.owner {
                    return Err("另一实例仍持有系统代理，请先退出该实例".into());
                }
            }
            restore(&record_path, &record)?;
        }
        return Ok(false);
    }
    let port = port.filter(|port| *port > 0).ok_or("系统代理端口无效")?;
    let service = current_service()?;
    if let Some(record) = record(&record_path)? {
        if record.owner != owner() {
            let pid = owner_pid(&record.owner).ok_or("系统代理恢复记录的宿主身份无效")?;
            if super::processes::inspect(pid, 0, String::new()).identity == record.owner {
                return Err("另一实例仍持有系统代理，请先退出该实例".into());
            }
        }
        if record.owner == owner() && record.service == service && record.port == port && read(&service)?.iter().all(|v| ours(v, port)) { return Ok(true); }
        restore(&record_path, &record)?;
    }
    for option in ["-getautoproxyurl", "-getproxyautodiscovery"] {
        if tool(&[option, &service])?.lines().any(|line| line.ends_with(": Yes") || line.ends_with(": On")) {
            return Err("当前网络使用 PAC 或自动代理发现；请使用应用代理入口，避免覆盖既有网络设置".into());
        }
    }
    let original = read(&service)?;
    if original.iter().any(|v| v.authenticated) { return Err("当前网络使用认证代理，已保留原设置；请使用业务包应用入口".into()); }
    let owner = owner(); if owner.is_empty() { return Err("无法核实本程序身份，未修改系统代理".into()); }
    let recovery = Recovery { service, owner, port, original };
    crate::storage::replace_atomic(&record_path, &serde_json::to_vec(&recovery).map_err(|_| "代理恢复记录无效")?)?;
    let desired = Proxy { enabled: true, server: "127.0.0.1".into(), port, authenticated: false };
    let apply: Result<(), String> = (|| {
        for kind in TYPES { write(&recovery.service, kind, &desired)?; }
        if !read(&recovery.service)?.iter().all(|v| *v == desired) { return Err("系统代理回读不一致".into()); }
        Ok(())
    })();
    if let Err(error) = apply {
        return match restore(&record_path, &recovery) { Ok(()) => Err(format!("{error}；已恢复原设置")), Err(_) => Err(format!("{error}；恢复未完成，已保留恢复记录")) };
    }
    Ok(true)
}

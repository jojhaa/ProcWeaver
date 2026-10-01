use super::model::Bundle;
use crate::routing_overrides::{native, tracker::{self, ProcessEntry}};
use std::net::SocketAddr;

pub(super) fn generic(value: &str) -> bool { matches!(value.to_ascii_lowercase().as_str(), "node.exe" | "cmd.exe" | "powershell.exe" | "pwsh.exe" | "python.exe" | "java.exe") }
fn score(bundle: &Bundle, process: &ProcessEntry) -> Option<usize> {
    if process.identity.is_empty() || process.created_at == 0 { return None; }
    let path = process.executable_path.as_deref()?;
    bundle.members.iter().filter_map(|m| {
        let matches = |path: &str| {
            let value = if m.kind == "path" { path } else { path.rsplit(['\\', '/']).next().unwrap_or("") };
            crate::platform::same_path(&m.value, value)
        };
        // Shared interpreters with only a basename are companions. A path binding
        // is explicit; otherwise a verified ancestor must own the connection.
        if m.kind == "name" && generic(&m.value) { return None; }
        let specificity = usize::from(m.kind != "path");
        if matches(path) { Some(specificity) }
        else if m.descendants { process.ancestors.iter().position(|(_, path)| matches(path)).map(|depth| 2 + depth * 2 + specificity) }
        else { None }
    }).min()
}
pub fn owner<'a>(bundles: &'a [Bundle], process: &ProcessEntry) -> Option<&'a str> {
    let mut candidates: Vec<_> = bundles.iter().filter(|b| b.enabled).filter_map(|b| score(b, process).map(|s| (s, b.id.as_str()))).collect();
    candidates.sort_unstable();
    let first = candidates.first()?;
    if candidates.get(1).is_some_and(|other| other.0 == first.0) { return None; }
    Some(first.1)
}
pub async fn inspect(source: SocketAddr, destination: SocketAddr) -> Result<ProcessEntry, String> {
    inspect_endpoint(source, Some(destination)).await
}
pub async fn inspect_udp(source: SocketAddr) -> Result<ProcessEntry, String> {
    inspect_endpoint(source, None).await
}
pub async fn udp_matches(source: SocketAddr, expected: &ProcessEntry) -> bool {
    let expected = expected.clone();
    tokio::task::spawn_blocking(move || {
        #[cfg(windows)] {
            let Some(pid) = crate::capture::windivert::udp_owner(source) else { return false; };
            if pid != expected.pid { return false; }
            let current = native::inspect(pid, 0, String::new());
            !current.identity.is_empty() && current.identity == expected.identity && current.executable_path == expected.executable_path
        }
        #[cfg(not(windows))] { let _ = (source, expected); false }
    }).await.unwrap_or(false)
}
async fn inspect_endpoint(source: SocketAddr, destination: Option<SocketAddr>) -> Result<ProcessEntry, String> {
    tokio::task::spawn_blocking(move || {
        #[cfg(windows)] let pid = match destination {
            Some(destination) => crate::capture::windivert::tcp_owner(source, destination),
            None => crate::capture::windivert::udp_owner(source),
        }.ok_or("无法核实连接所属进程，已拒绝转发")?;
        #[cfg(not(windows))] let pid = { let _ = (source, destination); return Err::<ProcessEntry, String>("独立进程代理首期支持 Windows".into()); #[allow(unreachable_code)] 0 };
        let current = native::inspect(pid, 0, String::new());
        if current.identity.is_empty() || current.executable_path.is_none() { return Err("连接进程身份或路径不可读，已拒绝转发".into()); }
        if let Some(entry) = tracker::entry(&current.identity).filter(|p| p.executable_path == current.executable_path) { return Ok(entry); }
        let entries = tracker::enrich_snapshot(native::snapshot()?);
        entries.into_iter().find(|p| p.identity == current.identity && p.executable_path == current.executable_path).ok_or("进程已退出或身份改变，已拒绝转发".into())
    }).await.map_err(|_| "连接身份核验任务失败".to_string())?
}

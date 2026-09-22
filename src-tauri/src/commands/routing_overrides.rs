use crate::routing_overrides::{self as service, model::Overrides, Selection, View, tracker::ProcessEntry};

#[tauri::command]
pub async fn get_routing_overrides() -> Result<View, String> {
    let _lock = super::process::LIFECYCLE.lock().await;
    service::view()
}
#[tauri::command]
pub async fn save_routing_overrides(config: Overrides, selections: Vec<Selection>) -> Result<View, String> { service::save(config, selections).await }
#[tauri::command]
pub async fn get_process_tree() -> Result<Vec<ProcessEntry>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut entries = service::native::snapshot()?;
        let identities: Vec<_> = entries.iter().filter(|p| p.created_at > 0).map(|p| (p.pid, p.created_at, p.identity.clone())).collect();
        for p in &mut entries {
            p.parent_identity = identities.iter().find(|(pid, time, _)| *pid == p.parent_pid && *time < p.created_at).map(|(_, _, id)| id.clone());
        }
        Ok(entries)
    }).await.map_err(|_| "进程树读取任务失败")?
}

#[tauri::command]
pub async fn choose_routing_executable() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        #[cfg(windows)] unsafe {
            use windows_sys::Win32::UI::Controls::Dialogs::*;
            let mut buffer = vec![0u16; 32768];
            let filter: Vec<u16> = "可执行文件 (*.exe)\0*.exe\0\0".encode_utf16().collect();
            let mut dialog: OPENFILENAMEW = std::mem::zeroed();
            dialog.lStructSize = std::mem::size_of_val(&dialog) as u32;
            dialog.lpstrFilter = filter.as_ptr(); dialog.lpstrFile = buffer.as_mut_ptr(); dialog.nMaxFile = buffer.len() as u32;
            dialog.Flags = OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST | OFN_NOCHANGEDIR;
            if GetOpenFileNameW(&mut dialog) != 0 {
                let end = buffer.iter().position(|c| *c == 0).unwrap_or(buffer.len());
                return Ok(Some(String::from_utf16_lossy(&buffer[..end])));
            }
            if CommDlgExtendedError() != 0 { return Err("打开程序选择器失败".into()); }
            Ok(None)
        }
        #[cfg(not(windows))] { Err("仅支持 Windows".into()) }
    }).await.map_err(|_| "程序选择器任务失败")?
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DnsDiagnostic { duration_ms: u128, answers: Vec<String>, message: String }
#[tauri::command]
pub async fn diagnose_routing_dns(rule_id: String) -> Result<DnsDiagnostic, String> {
    let _lock = super::process::LIFECYCLE.lock().await;
    if !super::process::ACTIVE.load(std::sync::atomic::Ordering::SeqCst) { return Err("请先启动核心".into()); }
    let config = service::read()?;
    let r = config.dns_rules.iter().find(|r| r.id == rule_id && r.enabled && config.dns_enabled).ok_or("请先保存并启用 DNS 规则")?;
    let port = super::settings::get_general_settings()?.controller_port;
    let client = super::mihomo_api::controller_client().timeout(std::time::Duration::from_secs(10)).build().map_err(|_| "创建诊断连接失败")?;
    let start = std::time::Instant::now();
    let response = client.get(format!("http://127.0.0.1:{port}/dns/query")).query(&[("name", r.domain.as_str()), ("type", "A")]).send().await.map_err(|_| "核心 DNS 查询失败或超时")?;
    if !response.status().is_success() { return Err("核心拒绝 DNS 查询，请检查 DNS 配置与出口".into()); }
    let value: serde_json::Value = response.json().await.map_err(|_| "核心 DNS 返回格式错误")?;
    if value["Status"].as_u64().is_some_and(|v| v != 0) { return Err("DNS 返回解析失败，未切换为直连查询".into()); }
    let answers = value["Answer"].as_array().into_iter().flatten().take(16).filter_map(|v| v["data"].as_str().map(|s| s.chars().take(256).collect())).collect();
    Ok(DnsDiagnostic { duration_ms: start.elapsed().as_millis(), answers, message: "核心解析完成；可能使用缓存或 hosts，尚未观察确认查询出口".into() })
}

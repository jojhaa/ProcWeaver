use std::sync::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};

static CURRENT_TRAY_PAYLOAD: Mutex<Option<TrayMenuPayload>> = Mutex::new(None);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrayNodeItem {
    pub name: String,
    pub delay: Option<i64>,
    pub active: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrayRegionGroup {
    pub region: String,
    pub nodes: Vec<TrayNodeItem>,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrayMenuPayload {
    pub running: bool,
    pub mode: String,
    #[serde(rename = "sysProxyEnabled")]
    pub sys_proxy_enabled: bool,
    #[serde(rename = "sysProxyState", default)]
    pub sys_proxy_state: String,
    #[serde(rename = "tunEnabled", default)]
    pub tun_enabled: bool,
    #[serde(rename = "autoRun", default)]
    pub auto_run: bool,
    #[serde(rename = "processEnabled", default = "default_true")]
    pub process_enabled: bool,
    #[serde(rename = "activeNode")]
    pub active_node: Option<String>,
    #[serde(rename = "activeNodeDelay", default)]
    pub active_node_delay: Option<i64>,
    #[serde(rename = "downSpeed", default)]
    pub down_speed: Option<f64>,
    #[serde(rename = "upSpeed", default)]
    pub up_speed: Option<f64>,
    pub groups: Vec<TrayRegionGroup>,
    #[serde(default)]
    pub direction: Option<String>,
}

static CURRENT_DIRECTION: Mutex<&'static str> = Mutex::new("left");

fn format_speed(bps: f64) -> String {
    if bps <= 0.0 || !bps.is_finite() {
        "0 B/s".into()
    } else if bps < 1024.0 {
        format!("{:.1} B/s", bps)
    } else if bps < 1024.0 * 1024.0 {
        format!("{:.2} KB/s", bps / 1024.0)
    } else {
        format!("{:.2} MB/s", bps / (1024.0 * 1024.0))
    }
}

pub fn rebuild_tray_in_place(app: &tauri::AppHandle) {
    if let Ok(guard) = CURRENT_TRAY_PAYLOAD.lock() {
        if let Some(payload) = guard.as_ref() {
            let _ = app.emit("tray-payload-updated", payload.clone());
            if let Some(tray) = app.tray_by_id("procweaver") {
                let mode_zh = match payload.mode.as_str() {
                    "global" => "全局",
                    "direct" => "直连",
                    _ => "规则",
                };
                let node_str = payload.active_node.as_deref().unwrap_or("未选择");
                let tooltip = format!(
                    "ProcWeaver V{}\n状态: {}\n出口: {}\n流量: ↓ {} | ↑ {}",
                    env!("CARGO_PKG_VERSION"),
                    if payload.running { mode_zh } else { "已停止" },
                    node_str,
                    format_speed(payload.down_speed.unwrap_or(0.0)),
                    format_speed(payload.up_speed.unwrap_or(0.0))
                );
                let _ = tray.set_tooltip(Some(tooltip));

                let style = crate::commands::settings::get_general_settings()
                    .map(|s| s.tray_menu_style)
                    .unwrap_or_else(|_| "modern".into());

                if style == "classic" {
                    if let Ok(new_menu) = build_tray_menu(app, payload) {
                        let _ = tray.set_menu(Some(new_menu));
                    }
                } else {
                    let _ = tray.set_menu(None::<Menu<tauri::Wry>>);
                }
            }
        }
    }
}

pub fn notify_sysproxy_changed(app: &tauri::AppHandle, _enabled: bool) {
    let actual = crate::commands::sysproxy::system_proxy_snapshot();
    if let Ok(mut guard) = CURRENT_TRAY_PAYLOAD.lock() {
        if let Some(payload) = guard.as_mut() {
            payload.sys_proxy_enabled = actual.enabled();
            payload.sys_proxy_state = actual.state.clone();
        }
    }
    let _ = app.emit("netbox-sysproxy-changed", actual.enabled());
    rebuild_tray_in_place(app);
}

pub fn show(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

pub fn toggle_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) && !window.is_minimized().unwrap_or(false) {
            let _ = window.hide();
        } else {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
    }
}

async fn switch_node_to_available_groups(node_name: &str) {
    let mut switched = false;
    if let Ok(res) = crate::commands::mihomo_api::get_mihomo_proxies().await {
        if let Some(groups) = res.get("groups").and_then(|g| g.as_array()) {
            for g in groups {
                if let Some(name) = g.get("name").and_then(|n| n.as_str()) {
                    let g_type = g.get("type").and_then(|t| t.as_str()).unwrap_or("");
                    if g_type.eq_ignore_ascii_case("Selector") {
                        if let Some(all) = g.get("all").and_then(|a| a.as_array()) {
                            let contains_node = all.iter().any(|v| v.as_str() == Some(node_name));
                            if contains_node || name == "PROXY" || name == "GLOBAL" || name.contains("节点选择") {
                                let _ = crate::commands::mihomo_api::switch_mihomo_proxy(name.to_string(), node_name.to_string()).await;
                                switched = true;
                            }
                        }
                    }
                }
            }
        }
    }
    if !switched {
        let _ = crate::commands::mihomo_api::switch_mihomo_proxy("PROXY".into(), node_name.to_string()).await;
        let _ = crate::commands::mihomo_api::switch_mihomo_proxy("GLOBAL".into(), node_name.to_string()).await;
    }
}

pub fn handle_menu_event(app: &tauri::AppHandle, id: &str) {
    match id {
        "open" => show(app),
        "open_node_view" => {
            show(app);
            let _ = app.emit("procweaver-navigate-tab", "proxies");
        }
        "quit" => {
            crate::shutdown::request(app, 0);
        }
        "toggle_sysproxy" => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let _lock = crate::commands::process::LIFECYCLE.lock().await;
                let result = async {
                    let next = !crate::commands::sysproxy::get_system_proxy_status()?;
                    let port = crate::commands::settings::get_general_settings()?.mixed_port;
                    crate::commands::sysproxy::set_system_proxy_locked(next, Some(port)).await
                }.await;
                match result {
                    Ok(actual) => notify_sysproxy_changed(&app, actual),
                    Err(error) => { show(&app); let _ = app.emit("netbox-sysproxy-error", error); }
                }
            });
        }
        "toggle_process_master" => {
            let app_handle = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Ok(mut cfg) = crate::routing_overrides::read() {
                    let next = !cfg.process_enabled;
                    cfg.process_enabled = next;
                    let _ = crate::routing_overrides::save(cfg, vec![]).await;
                    if let Ok(mut guard) = CURRENT_TRAY_PAYLOAD.lock() {
                        if let Some(payload) = guard.as_mut() {
                            payload.process_enabled = next;
                        }
                    }
                    rebuild_tray_in_place(&app_handle);
                    let _ = app_handle.emit("netbox-process-master-changed", next);
                    let _ = app_handle.emit("netbox-settings-saved", ());
                }
            });
        }
        "toggle_autolaunch" => {
            let app_handle = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Ok(mut s) = crate::commands::settings::get_general_settings() {
                    let next = !s.auto_start;
                    s.auto_start = next;
                    s.auto_run = next;
                    let state = app_handle.state::<crate::commands::process::CoreStateMutex>();
                    let _ = crate::commands::settings::save_general_settings(s, state).await;
                    if let Ok(mut guard) = CURRENT_TRAY_PAYLOAD.lock() {
                        if let Some(payload) = guard.as_mut() {
                            payload.auto_run = next;
                        }
                    }
                    rebuild_tray_in_place(&app_handle);
                    let _ = app_handle.emit("netbox-settings-saved", ());
                }
            });
        }
        "set_mode:rule" | "set_mode:global" | "set_mode:direct" => {
            let target_mode = id.trim_start_matches("set_mode:").to_string();
            if let Ok(mut guard) = CURRENT_TRAY_PAYLOAD.lock() {
                if let Some(payload) = guard.as_mut() {
                    payload.mode = target_mode.clone();
                }
            }
            rebuild_tray_in_place(app);
            let app_handle = app.clone();
            tauri::async_runtime::spawn(async move {
                let _ = crate::commands::mihomo_api::set_mihomo_mode(target_mode).await;
                let _ = app_handle.emit("netbox-route-changed", ());
            });
        }
        "select_fastest_node" => {
            let app_clone = app.clone();
            tauri::async_runtime::spawn(async move {
                let cached_best = {
                    if let Ok(guard) = CURRENT_TRAY_PAYLOAD.lock() {
                        if let Some(payload) = guard.as_ref() {
                            let mut best: Option<(String, i64)> = None;
                            for group in &payload.groups {
                                for node in &group.nodes {
                                    if let Some(d) = node.delay {
                                        if d > 0 {
                                            if best.as_ref().map(|(_, bd)| d < *bd).unwrap_or(true) {
                                                best = Some((node.name.clone(), d));
                                            }
                                        }
                                    }
                                }
                            }
                            best.map(|(name, _)| name)
                        } else {
                            None
                        }
                    } else {
                        None
                    }
                };

                let target_node = if let Some(name) = cached_best {
                    Some(name)
                } else if let Ok(res) = crate::commands::mihomo_api::get_mihomo_proxies().await {
                    if let Some(proxies) = res.get("proxies").and_then(|p| p.as_object()) {
                        let mut best_node: Option<(String, u64)> = None;
                        for (name, data) in proxies {
                            if name == "DIRECT" || name == "REJECT" || name == "GLOBAL" {
                                continue;
                            }
                            if let Some(history) = data.get("history").and_then(|h| h.as_array()) {
                                if let Some(last) = history.last() {
                                    if let Some(delay) = last.get("delay").and_then(|d| d.as_u64()) {
                                        if delay > 0 {
                                            if best_node.as_ref().map(|(_, best_d)| delay < *best_d).unwrap_or(true) {
                                                best_node = Some((name.clone(), delay));
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        best_node.map(|(n, _)| n)
                    } else {
                        None
                    }
                } else {
                    None
                };

                if let Some(node_name) = target_node {
                    switch_node_to_available_groups(&node_name).await;
                    if let Ok(mut guard) = CURRENT_TRAY_PAYLOAD.lock() {
                        if let Some(payload) = guard.as_mut() {
                            payload.active_node = Some(node_name.clone());
                            for g in &mut payload.groups {
                                for n in &mut g.nodes {
                                    n.active = n.name == node_name;
                                }
                            }
                        }
                    }
                    rebuild_tray_in_place(&app_clone);
                    let _ = app_clone.emit("netbox-route-changed", ());
                    let _ = app_clone.emit("netbox-active-node-changed", serde_json::json!({ "nodeName": node_name }));
                }
            });
        }
        "tool:flush_dns" => {
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                let _ = std::process::Command::new("ipconfig")
                    .arg("/flushdns")
                    .creation_flags(0x08000000)
                    .spawn();
            }
        }
        "tool:close_all_conns" => {
            tauri::async_runtime::spawn(async move {
                let _ = crate::commands::mihomo_api::close_all_connections().await;
            });
        }
        "tool:copy_env" | "tool:copy_env_pwsh" => {
            let port = crate::commands::settings::get_general_settings()
                .map(|s| s.mixed_port)
                .unwrap_or(7890);
            let cmd = format!("$env:http_proxy=\"http://127.0.0.1:{port}\"; $env:https_proxy=\"http://127.0.0.1:{port}\"");
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                let _ = std::process::Command::new("powershell")
                    .args(["-NoProfile", "-Command", &format!("Set-Clipboard -Value '{}'", cmd)])
                    .creation_flags(0x08000000)
                    .spawn();
            }
        }
        "tool:copy_env_cmd" => {
            let port = crate::commands::settings::get_general_settings()
                .map(|s| s.mixed_port)
                .unwrap_or(7890);
            let cmd = format!("set http_proxy=http://127.0.0.1:{port} & set https_proxy=http://127.0.0.1:{port}");
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                let _ = std::process::Command::new("powershell")
                    .args(["-NoProfile", "-Command", &format!("Set-Clipboard -Value '{}'", cmd)])
                    .creation_flags(0x08000000)
                    .spawn();
            }
        }
        "tool:emergency_reset" => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                match crate::commands::dns_adapter::emergency_repair_network().await {
                    Ok(message) => {
                        notify_sysproxy_changed(&app, false);
                        let _ = app.emit("notify-network-repaired", message);
                    }
                    Err(error) => { show(&app); let _ = app.emit("netbox-sysproxy-error", error); }
                }
            });
        }
        "tool:restart_core" => {
            let app_handle = app.clone();
            tauri::async_runtime::spawn(async move {
                let _ = crate::commands::process::restart_core_transaction(&app_handle).await;
            });
        }
        _ if id.starts_with("select_fastest_region:") => {
            let region_name = id.trim_start_matches("select_fastest_region:").to_string();
            let app_clone = app.clone();
            tauri::async_runtime::spawn(async move {
                let target_node = {
                    if let Ok(guard) = CURRENT_TRAY_PAYLOAD.lock() {
                        if let Some(payload) = guard.as_ref() {
                            if let Some(group) = payload.groups.iter().find(|g| g.region == region_name) {
                                let mut best: Option<(String, i64)> = None;
                                for node in &group.nodes {
                                    if let Some(d) = node.delay {
                                        if d > 0 {
                                            if best.as_ref().map(|(_, bd)| d < *bd).unwrap_or(true) {
                                                best = Some((node.name.clone(), d));
                                            }
                                        }
                                    }
                                }
                                best.map(|(n, _)| n).or_else(|| group.nodes.first().map(|n| n.name.clone()))
                            } else {
                                None
                            }
                        } else {
                            None
                        }
                    } else {
                        None
                    }
                };

                if let Some(node_name) = target_node {
                    switch_node_to_available_groups(&node_name).await;
                    if let Ok(mut guard) = CURRENT_TRAY_PAYLOAD.lock() {
                        if let Some(payload) = guard.as_mut() {
                            payload.active_node = Some(node_name.clone());
                            for g in &mut payload.groups {
                                for n in &mut g.nodes {
                                    n.active = n.name == node_name;
                                }
                            }
                        }
                    }
                    rebuild_tray_in_place(&app_clone);
                    let _ = app_clone.emit("netbox-route-changed", ());
                    let _ = app_clone.emit("netbox-active-node-changed", serde_json::json!({ "nodeName": node_name }));
                }
            });
        }
        _ if id.starts_with("view_more_region:") => {
            let region_name = id.trim_start_matches("view_more_region:").to_string();
            show(app);
            let _ = app.emit("procweaver-navigate-tab", "proxies");
            let _ = app.emit("procweaver-filter-region", region_name);
        }
        _ if id.starts_with("select_node:") => {
            let node_name = id.trim_start_matches("select_node:").to_string();
            let app_clone = app.clone();
            tauri::async_runtime::spawn(async move {
                switch_node_to_available_groups(&node_name).await;
                if let Ok(mut guard) = CURRENT_TRAY_PAYLOAD.lock() {
                    if let Some(payload) = guard.as_mut() {
                        payload.active_node = Some(node_name.clone());
                        for g in &mut payload.groups {
                            for n in &mut g.nodes {
                                n.active = n.name == node_name;
                            }
                        }
                    }
                }
                rebuild_tray_in_place(&app_clone);
                let _ = app_clone.emit("netbox-route-changed", ());
                let _ = app_clone.emit("netbox-active-node-changed", serde_json::json!({ "nodeName": node_name }));
            });
        }
        _ => {}
    }
}

pub fn build_tray_menu(
    app: &tauri::AppHandle,
    payload: &TrayMenuPayload,
) -> Result<Menu<tauri::Wry>, Box<dyn std::error::Error>> {
    let mode_zh = match payload.mode.as_str() {
        "global" => "全局代理",
        "direct" => "直接连接",
        _ => "规则分流",
    };

    // 1. 顶部状态标头
    let status_text = if payload.running {
        format!("🟢 ProcWeaver  [运行中 · {}]", mode_zh)
    } else {
        "⚪ ProcWeaver  [内核已停止]".to_string()
    };
    let status_item = MenuItem::with_id(app, "status_info", &status_text, false, None::<&str>)?;

    // 2. 当前出口节点
    let node_text = match &payload.active_node {
        Some(name) if !name.is_empty() => match payload.active_node_delay {
            Some(d) if d > 0 => format!("📍 出口: {} ({}ms)", name, d),
            _ => format!("📍 出口: {}", name),
        },
        _ => "📍 出口: 未选择节点 / 直连".to_string(),
    };
    let node_item = MenuItem::with_id(app, "open_node_view", &node_text, true, None::<&str>)?;

    // 3. 实时网络吞吐
    let speed_text = format!(
        "⚡ 流量: ↓ {}  ↑ {}",
        format_speed(payload.down_speed.unwrap_or(0.0)),
        format_speed(payload.up_speed.unwrap_or(0.0))
    );
    let speed_item = MenuItem::with_id(app, "speed_info", &speed_text, false, None::<&str>)?;

    let sep1 = PredefinedMenuItem::separator(app)?;

    // 4. 核心快捷开关：系统代理 与 进程分流总开关
    let sysproxy_text = format!(
        "系统代理: {}",
        match payload.sys_proxy_state.as_str() { "enabled" => "✅ 已开启", "disabled" => "❌ 已关闭", "external" => "其他代理", _ => "状态未知" }
    );
    let sysproxy_item = MenuItem::with_id(app, "toggle_sysproxy", &sysproxy_text, true, None::<&str>)?;

    let process_text = format!(
        "进程与应用分流: {}",
        if payload.process_enabled { "✅ 已开启" } else { "💤 待机中" }
    );
    let process_item = MenuItem::with_id(app, "toggle_process_master", &process_text, true, None::<&str>)?;

    // 5. 分流运行模式二级子菜单
    let mode_rule = MenuItem::with_id(
        app,
        "set_mode:rule",
        format!("{} 规则分流 (Rule)", if payload.mode == "rule" { "●" } else { "○" }),
        true,
        None::<&str>,
    )?;
    let mode_global = MenuItem::with_id(
        app,
        "set_mode:global",
        format!("{} 全局代理 (Global)", if payload.mode == "global" { "●" } else { "○" }),
        true,
        None::<&str>,
    )?;
    let mode_direct = MenuItem::with_id(
        app,
        "set_mode:direct",
        format!("{} 直接连接 (Direct)", if payload.mode == "direct" { "●" } else { "○" }),
        true,
        None::<&str>,
    )?;
    let mode_sub = Submenu::with_items(
        app,
        "分流运行模式",
        true,
        &[&mode_rule, &mode_global, &mode_direct],
    )?;

    // 6. 节点与线路秒切二级子菜单（包含全局自动优选 + 地区专属优选与分类）
    let fastest_item = MenuItem::with_id(
        app,
        "select_fastest_node",
        "⚡ 全局测速优选 (一键切最快)",
        true,
        None::<&str>,
    )?;
    let sep_fastest = PredefinedMenuItem::separator(app)?;

    let mut region_submenus = Vec::new();
    for group in &payload.groups {
        let max_display = 20;
        let mut node_items = Vec::new();

        // 地区专属优选第一项
        let reg_fastest_id = format!("select_fastest_region:{}", group.region);
        let fastest_reg_item = MenuItem::with_id(
            app,
            reg_fastest_id,
            "⚡ 优选此地区最低延迟",
            true,
            None::<&str>,
        )?;
        let sep_fastest_reg = PredefinedMenuItem::separator(app)?;

        for node in group.nodes.iter().take(max_display) {
            let label = match node.delay {
                Some(d) if d > 0 => format!("{}{} · {}ms", if node.active { "✔ " } else { "  " }, node.name, d),
                _ => format!("{}{}", if node.active { "✔ " } else { "  " }, node.name),
            };
            let id = format!("select_node:{}", node.name);
            if let Ok(item) = MenuItem::with_id(app, id, label, true, None::<&str>) {
                node_items.push(item);
            }
        }

        let has_more = group.nodes.len() > max_display;
        let sep_more = if has_more { Some(PredefinedMenuItem::separator(app)?) } else { None };
        let more_item = if has_more {
            Some(MenuItem::with_id(
                app,
                format!("view_more_region:{}", group.region),
                format!("👉 查看全部 {} 个节点...", group.nodes.len()),
                true,
                None::<&str>,
            )?)
        } else {
            None
        };

        let mut refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = Vec::new();
        refs.push(&fastest_reg_item);
        refs.push(&sep_fastest_reg);
        for item in &node_items {
            refs.push(item);
        }
        if let Some(s) = &sep_more {
            refs.push(s);
        }
        if let Some(m) = &more_item {
            refs.push(m);
        }

        if let Ok(sub) = Submenu::with_items(app, &group.region, true, &refs) {
            region_submenus.push(sub);
        }
    }

    let mut nodes_items: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = Vec::new();
    nodes_items.push(&fastest_item);
    nodes_items.push(&sep_fastest);
    for s in &region_submenus {
        nodes_items.push(s as &dyn tauri::menu::IsMenuItem<tauri::Wry>);
    }

    let nodes_sub = Submenu::with_items(
        app,
        "节点与线路秒切",
        !payload.groups.is_empty(),
        &nodes_items,
    )?;

    let sep2 = PredefinedMenuItem::separator(app)?;

    // 7. 网络急救与工具二级菜单
    let emergency_reset = MenuItem::with_id(app, "tool:emergency_reset", "🚨 一键网络急救复位 (还原DNS与代理)", true, None::<&str>)?;
    let flush_dns = MenuItem::with_id(app, "tool:flush_dns", "🔄 刷新系统 DNS 缓存", true, None::<&str>)?;
    let close_all_conns = MenuItem::with_id(app, "tool:close_all_conns", "🔌 掐断所有当前连接 (断连重选)", true, None::<&str>)?;
    let copy_env_pwsh = MenuItem::with_id(app, "tool:copy_env_pwsh", "📋 复制 PowerShell 代理命令", true, None::<&str>)?;
    let copy_env_cmd = MenuItem::with_id(app, "tool:copy_env_cmd", "📋 复制 CMD 代理命令", true, None::<&str>)?;
    let restart_core = MenuItem::with_id(app, "tool:restart_core", "♻️ 重启网络核心服务", true, None::<&str>)?;
    let tools_sub = Submenu::with_items(
        app,
        "网络急救与工具",
        true,
        &[&emergency_reset, &flush_dns, &close_all_conns, &copy_env_pwsh, &copy_env_cmd, &restart_core],
    )?;

    let sep3 = PredefinedMenuItem::separator(app)?;

    // 8. 开机自启开关
    let autolaunch_text = format!(
        "开机自动启动: {}",
        if payload.auto_run { "✅ 已开启" } else { "❌ 已关闭" }
    );
    let autolaunch_item = MenuItem::with_id(app, "toggle_autolaunch", &autolaunch_text, true, None::<&str>)?;

    // 9. 打开与退出
    let open_item = MenuItem::with_id(app, "open", "打开主界面", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "彻底退出 ProcWeaver", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &status_item,
            &node_item,
            &speed_item,
            &sep1,
            &sysproxy_item,
            &process_item,
            &mode_sub,
            &nodes_sub,
            &sep2,
            &tools_sub,
            &sep3,
            &autolaunch_item,
            &open_item,
            &quit_item,
        ],
    )?;

    Ok(menu)
}

fn tray_tooltip(payload: &TrayMenuPayload) -> String {
        let mode_zh = match payload.mode.as_str() {
            "global" => "全局",
            "direct" => "直连",
            _ => "规则",
        };
        let node_str = payload.active_node.as_deref().unwrap_or("未选择");
        format!(
            "ProcWeaver V{}\n状态: {}\n出口: {}\n流量: ↓ {} | ↑ {}",
            env!("CARGO_PKG_VERSION"),
            if payload.running { mode_zh } else { "已停止" },
            node_str,
            format_speed(payload.down_speed.unwrap_or(0.0)),
            format_speed(payload.up_speed.unwrap_or(0.0))
        )
}

#[tauri::command]
pub fn update_tray_traffic(app: tauri::AppHandle, down_speed: f64, up_speed: f64) -> Result<(), String> {
    let tooltip = {
        let mut guard = CURRENT_TRAY_PAYLOAD.lock().map_err(|_| "托盘状态暂不可用")?;
        let payload = guard.as_mut().ok_or("托盘尚未初始化")?;
        payload.down_speed = Some(if down_speed.is_finite() { down_speed.max(0.0) } else { 0.0 });
        payload.up_speed = Some(if up_speed.is_finite() { up_speed.max(0.0) } else { 0.0 });
        tray_tooltip(payload)
    };
    if let Some(tray) = app.tray_by_id("procweaver") { let _ = tray.set_tooltip(Some(tooltip)); }
    if let Some(window) = app.get_webview_window("tray-menu") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.emit("tray-traffic-updated", serde_json::json!({"downSpeed": down_speed, "upSpeed": up_speed}));
        }
    }
    Ok(())
}

#[tauri::command]
pub fn update_tray_menu(
    app: tauri::AppHandle,
    mut payload: TrayMenuPayload,
) -> Result<(), String> {
    let proxy = crate::commands::sysproxy::system_proxy_snapshot();
    payload.sys_proxy_enabled = proxy.enabled();
    payload.sys_proxy_state = proxy.state;
    if let Ok(mut guard) = CURRENT_TRAY_PAYLOAD.lock() {
        if let Some(previous) = guard.as_ref() {
            payload.down_speed = payload.down_speed.or(previous.down_speed);
            payload.up_speed = payload.up_speed.or(previous.up_speed);
        }
        *guard = Some(payload.clone());
    }
    let _ = app.emit("tray-payload-updated", payload.clone());

    let style = crate::commands::settings::get_general_settings()
        .map(|s| s.tray_menu_style)
        .unwrap_or_else(|_| "modern".into());

    if let Some(tray) = app.tray_by_id("procweaver") {
        let _ = tray.set_tooltip(Some(tray_tooltip(&payload)));
        if style == "classic" {
            if let Ok(new_menu) = build_tray_menu(&app, &payload) {
                let _ = tray.set_menu(Some(new_menu));
            }
        } else {
            let _ = tray.set_menu(None::<Menu<tauri::Wry>>);
        }
    }
    Ok(())
}

#[cfg(windows)]
fn get_cursor_screen_pos() -> Option<(f64, f64)> {
    use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;
    use windows_sys::Win32::Foundation::POINT;
    unsafe {
        let mut pt = POINT { x: 0, y: 0 };
        if GetCursorPos(&mut pt) != 0 {
            return Some((pt.x as f64, pt.y as f64));
        }
    }
    None
}
#[cfg(not(windows))]
fn get_cursor_screen_pos() -> Option<(f64, f64)> {
    None
}

fn parse_tray_groups(proxies_obj: &serde_json::Map<String, serde_json::Value>, active_node: Option<&str>) -> Vec<TrayRegionGroup> {
    use std::collections::BTreeMap;

    let region_rules: &[(&[&str], i32, &str)] = &[
        (&["HK", "Hong Kong", "香港", "中国香港", "🇭🇰"], 1, "🇭🇰 中国香港"),
        (&["JP", "Japan", "日本", "东京", "大阪", "🇯🇵"], 2, "🇯🇵 日本"),
        (&["SG", "Singapore", "新加坡", "狮城", "🇸🇬"], 3, "🇸🇬 新加坡"),
        (&["US", "USA", "United States", "美国", "洛杉矶", "硅谷", "🇺🇸"], 4, "🇺🇸 美国"),
        (&["TW", "Taiwan", "台湾", "中国台湾", "台北", "🇹🇼"], 5, "🇹🇼 中国台湾"),
        (&["KR", "Korea", "韩国", "首尔", "🇰🇷"], 6, "🇰🇷 韩国"),
        (&["GB", "UK", "United Kingdom", "英国", "伦敦", "🇬🇧"], 10, "🇬🇧 英国"),
        (&["DE", "Germany", "德国", "法兰克福", "🇩🇪"], 11, "🇩🇪 德国"),
        (&["FR", "France", "法国", "巴黎", "🇫🇷"], 12, "🇫🇷 法国"),
        (&["CA", "Canada", "加拿大", "多伦多", "🇨🇦"], 13, "🇨🇦 加拿大"),
        (&["AU", "Australia", "澳大利亚", "悉尼", "墨尔本", "🇦🇺"], 14, "🇦🇺 澳大利亚"),
        (&["AR", "Argentina", "阿根廷", "🇦🇷"], 20, "🇦🇷 阿根廷"),
        (&["AE", "UAE", "阿联酋", "迪拜", "🇦🇪"], 21, "🇦🇪 阿联酋"),
        (&["BR", "Brazil", "巴西", "圣保罗", "🇧🇷"], 22, "🇧🇷 巴西"),
        (&["IN", "India", "印度", "孟买", "🇮🇳"], 23, "🇮🇳 印度"),
        (&["RU", "Russia", "俄罗斯", "莫斯科", "🇷🇺"], 24, "🇷🇺 俄罗斯"),
        (&["TR", "Turkey", "土耳其", "伊斯坦布尔", "🇹🇷"], 25, "🇹🇷 土耳其"),
        (&["MY", "Malaysia", "马来西亚", "🇲🇾"], 26, "🇲🇾 马来西亚"),
        (&["TH", "Thailand", "泰国", "曼谷", "🇹🇭"], 27, "🇹🇭 泰国"),
        (&["VN", "Vietnam", "越南", "🇻🇳"], 28, "🇻🇳 越南"),
        (&["PH", "Philippines", "菲律宾", "🇵🇭"], 29, "🇵🇭 菲律宾"),
    ];

    struct Bucket {
        region: String,
        priority: i32,
        nodes: Vec<TrayNodeItem>,
    }

    let mut buckets: BTreeMap<String, Bucket> = BTreeMap::new();

    for (name, val) in proxies_obj {
        let node_type = val.get("type").and_then(|t| t.as_str()).unwrap_or("");
        if matches!(node_type, "Direct" | "Reject" | "Selector" | "URLTest" | "Fallback" | "LoadBalance" | "Relay" | "") {
            continue;
        }
        if matches!(name.as_str(), "DIRECT" | "REJECT" | "GLOBAL") {
            continue;
        }
        let lower = name.to_lowercase();
        if lower.contains("剩余") || lower.contains("到期") || lower.contains("官网") || lower.contains("流量") || lower.contains("群") || lower.contains("重置") {
            continue;
        }

        let delay = val.get("history")
            .and_then(|h| h.as_array())
            .and_then(|arr| arr.last())
            .and_then(|last| last.get("delay"))
            .and_then(|d| d.as_i64());

        let is_active = active_node.map(|a| a == name).unwrap_or(false);

        let mut matched_region = "🌐 其它地区";
        let mut matched_priority = 999;

        for &(keywords, prio, label) in region_rules {
            let mut found = false;
            for &kw in keywords {
                if name.contains(kw) {
                    found = true;
                    break;
                }
            }
            if found {
                matched_region = label;
                matched_priority = prio;
                break;
            }
        }

        let entry = buckets.entry(matched_region.to_string()).or_insert_with(|| Bucket {
            region: matched_region.to_string(),
            priority: matched_priority,
            nodes: Vec::new(),
        });

        entry.nodes.push(TrayNodeItem {
            name: name.clone(),
            delay,
            active: is_active,
        });
    }

    let mut result: Vec<Bucket> = buckets.into_values().collect();
    result.sort_by(|a, b| {
        a.priority.cmp(&b.priority).then_with(|| a.region.cmp(&b.region))
    });

    result.into_iter().map(|b| TrayRegionGroup {
        region: b.region,
        nodes: b.nodes,
    }).collect()
}

pub fn show_or_toggle_tray_menu(app: &tauri::AppHandle, pos: tauri::PhysicalPosition<f64>) {
    if let Some(window) = app.get_webview_window("tray-menu") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
            return;
        }

        let monitor = window
            .current_monitor()
            .ok()
            .flatten()
            .or_else(|| window.primary_monitor().ok().flatten());

        let (screen_x, screen_y, screen_w, screen_h, scale) = if let Some(m) = monitor {
            let size = m.size();
            let position = m.position();
            (position.x as f64, position.y as f64, size.width as f64, size.height as f64, m.scale_factor())
        } else {
            (0.0, 0.0, 1920.0, 1080.0, 1.0)
        };

        // 优先使用 Windows 原生光标屏幕物理坐标，保证 1:1 跟随鼠标点击
        let (pos_x, pos_y) = get_cursor_screen_pos().unwrap_or((pos.x, pos.y));

        // 画布总宽高：500 x 380 (物理像素)
        let canvas_w = 500.0 * scale;
        let canvas_h = 380.0 * scale;
        let main_w = 244.0 * scale;

        // 探测屏幕边缘：鼠标处于屏幕中心线的左侧还是右侧
        let is_dock_right = pos_x > (screen_x + screen_w / 2.0);
        let dir = if is_dock_right { "left" } else { "right" };
        if let Ok(mut d_guard) = CURRENT_DIRECTION.lock() {
            *d_guard = dir;
        }

        // 计算画布在屏幕上的准确位置：让主菜单物理实体中心精准对齐鼠标点击横坐标 pos_x
        let mut target_x = if is_dock_right {
            pos_x - canvas_w + (main_w / 2.0)
        } else {
            pos_x - (main_w / 2.0)
        };

        let mut target_y = pos_y - canvas_h - 6.0 * scale;

        // 横向防溢出：
        // 1. 如果靠右弹出，主菜单右边缘是 target_x + canvas_w，不能超出屏幕最右侧
        if target_x + canvas_w > screen_x + screen_w - 8.0 * scale {
            target_x = screen_x + screen_w - canvas_w - 8.0 * scale;
        }
        // 2. 如果向左展开的二级菜单超出屏幕最左侧，向右推回
        if target_x < screen_x + 8.0 * scale {
            target_x = screen_x + 8.0 * scale;
        }

        // 纵向防碰底 / 任务栏在顶端时向下弹出
        if target_y < screen_y + 8.0 * scale {
            target_y = pos_y + 12.0 * scale;
        }
        if target_y + canvas_h > screen_y + screen_h - 8.0 * scale {
            target_y = screen_y + screen_h - canvas_h - 8.0 * scale;
        }

        let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition {
            x: target_x.round() as i32,
            y: target_y.round() as i32,
        }));
        let _ = window.emit("tray-direction-changed", dir);
        let _ = window.show();
        let _ = window.set_focus();

        // 亮屏瞬间立即异步触发最新 Payload 推送，做到双保险 0 延迟
        let app_handle = app.clone();
        tauri::async_runtime::spawn(async move {
            if let Some(payload) = get_tray_payload(app_handle.clone()).await {
                let _ = app_handle.emit("tray-payload-updated", payload);
            }
        });
    }
}

#[tauri::command]
pub async fn get_tray_payload(app: tauri::AppHandle) -> Option<TrayMenuPayload> {
    let mut payload = CURRENT_TRAY_PAYLOAD.lock().ok().and_then(|g| g.clone()).unwrap_or_else(|| TrayMenuPayload {
        running: false,
        mode: "rule".into(),
        sys_proxy_enabled: false,
        sys_proxy_state: "unknown".into(),
        tun_enabled: false,
        auto_run: false,
        process_enabled: true,
        active_node: None,
        active_node_delay: None,
        down_speed: None,
        up_speed: None,
        groups: vec![],
        direction: None,
    });

    // 1. 直连底层检查内核真实运行状态
    if let Some(state) = app.try_state::<crate::commands::process::CoreStateMutex>() {
        if let Ok(status) = crate::commands::process::get_core_status(state).await {
            payload.running = status.running;
        }
    }
    // 2. 检查系统代理真实状态
    let sp = crate::commands::sysproxy::system_proxy_snapshot();
    payload.sys_proxy_enabled = sp.enabled();
    payload.sys_proxy_state = sp.state;
    // 3. 检查进程分流真实状态
    if let Ok(ro) = crate::routing_overrides::read() {
        payload.process_enabled = ro.process_enabled;
    }
    // 4. 检查自启动真实状态
    if let Ok(gs) = crate::commands::settings::get_general_settings() {
        payload.auto_run = gs.auto_start;
    }
    // 5. 填入当前飞出方向
    let cur_dir = CURRENT_DIRECTION.lock().ok().map(|d| d.to_string()).unwrap_or_else(|| "left".into());
    payload.direction = Some(cur_dir);

    // 6. 若核心正在运行，主动向 Mihomo 探测活跃节点、延迟与国家地区分组
    if payload.running {
        if let Ok(res) = crate::commands::mihomo_api::get_mihomo_proxies().await {
            if let Some(proxies) = res.get("proxies").and_then(|p| p.as_object()) {
                for group_name in ["节点选择", "🚀 节点选择", "PROXY", "GLOBAL"] {
                    if let Some(group_val) = proxies.get(group_name) {
                        if let Some(now) = group_val.get("now").and_then(|n| n.as_str()) {
                            payload.active_node = Some(now.to_string());
                            if let Some(node_val) = proxies.get(now) {
                                if let Some(history) = node_val.get("history").and_then(|h| h.as_array()) {
                                    if let Some(last) = history.last() {
                                        payload.active_node_delay = last.get("delay").and_then(|d| d.as_i64());
                                    }
                                }
                            }
                            break;
                        }
                    }
                }
                let parsed_groups = parse_tray_groups(proxies, payload.active_node.as_deref());
                if !parsed_groups.is_empty() {
                    payload.groups = parsed_groups;
                }
            }
        }
    }

    if let Ok(mut guard) = CURRENT_TRAY_PAYLOAD.lock() {
        *guard = Some(payload.clone());
    }

    Some(payload)
}

#[tauri::command]
pub fn execute_tray_menu_action(app: tauri::AppHandle, id: String) {
    handle_menu_event(&app, &id);
}

#[tauri::command]
pub fn hide_tray_menu(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("tray-menu") {
        let _ = w.hide();
    }
}

#[tauri::command]
pub fn show_tray_menu(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("tray-menu") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

pub fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let tray_icon = tauri::include_image!("icons/32x32.png");
    let style = crate::commands::settings::get_general_settings()
        .map(|s| s.tray_menu_style)
        .unwrap_or_else(|_| "modern".into());

    let mut builder = TrayIconBuilder::with_id("procweaver")
        .icon(tray_icon)
        .tooltip(concat!("ProcWeaver V", env!("CARGO_PKG_VERSION"), "\n双击或右键打开控制面板"))
        .show_menu_on_left_click(false);

    if style == "classic" {
        let open = MenuItem::with_id(app, "open", "打开主界面", true, None::<&str>)?;
        let quit = MenuItem::with_id(app, "quit", "彻底退出 ProcWeaver", true, None::<&str>)?;
        let menu = Menu::with_items(app, &[&open, &quit])?;
        builder = builder.menu(&menu);
    }

    builder
        .on_menu_event(|app, event| {
            handle_menu_event(app, event.id.as_ref());
        })
        .on_tray_icon_event(|tray, event| match event {
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } => {
                toggle_window(tray.app_handle());
            }
            TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            } => {
                show(tray.app_handle());
            }
            TrayIconEvent::Click {
                button: MouseButton::Right,
                button_state: MouseButtonState::Up,
                position,
                ..
            } => {
                let style = crate::commands::settings::get_general_settings()
                    .map(|s| s.tray_menu_style)
                    .unwrap_or_else(|_| "modern".into());
                if style == "modern" {
                    show_or_toggle_tray_menu(tray.app_handle(), position);
                }
            }
            _ => {}
        })
        .build(app)?;
    Ok(())
}

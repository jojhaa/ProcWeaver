use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Child;
use std::sync::Mutex;
use crate::commands::sysproxy::{self, get_system_proxy_status, set_system_proxy_raw};
pub static ACTIVE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
pub(crate) static PID: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
pub(crate) static LIFECYCLE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
#[cfg(test)]
pub(crate) static STARTUP_BARRIER: Mutex<Option<(std::sync::Arc<tokio::sync::Barrier>, std::sync::Arc<tokio::sync::Barrier>)>> = Mutex::new(None);

/// 即使宿主被强制结束，Windows 也会关闭 Job 句柄并终止本应用的核心。
#[cfg(windows)]
fn bind_core_lifetime(child: &Child) -> Result<(), String> {
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use windows_sys::Win32::System::JobObjects::*;
    static JOB: std::sync::OnceLock<Result<OwnedHandle, String>> = std::sync::OnceLock::new();
    let job = JOB.get_or_init(|| unsafe {
        let raw = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if raw.is_null() { return Err("创建核心进程保护失败".into()); }
        let handle = OwnedHandle::from_raw_handle(raw);
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let set = SetInformationJobObject(
            handle.as_raw_handle(),
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const _,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        if set == 0 { return Err("配置核心进程保护失败".into()); }
        Ok(handle)
    });
    match job {
        Ok(h) => unsafe {
            let assign = AssignProcessToJobObject(h.as_raw_handle(), child.as_raw_handle());
            if assign == 0 { Err("关联核心进程保护失败".into()) } else { Ok(()) }
        },
        Err(e) => Err(e.clone()),
    }
}

#[cfg(not(windows))]
fn bind_core_lifetime(_child: &Child) -> Result<(), String> {
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CpuInfo {
    pub arch: String,
    #[serde(rename = "avx2Supported")]
    pub avx2_supported: bool,
    #[serde(rename = "recommendedCore")]
    pub recommended_core: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CoreStatus {
    pub running: bool,
    pub pid: Option<u32>,
    #[serde(rename = "systemProxyEnabled")]
    pub system_proxy_enabled: bool,
    #[serde(rename = "systemProxy")]
    pub system_proxy: sysproxy::SystemProxyStatus,
    #[serde(rename = "mixedPort")]
    pub mixed_port: u16,
    #[serde(rename = "controllerPort")]
    pub controller_port: u16,
    #[serde(rename = "activeCore")]
    pub active_core: Option<String>,
    #[serde(rename = "startedAt")]
    pub started_at: Option<u64>,
}

pub struct CoreState {
    pub child: Option<Child>,
    pub mixed_port: u16,
    pub controller_port: u16,
    pub active_core: Option<String>,
    pub active_core_path: Option<String>,
    pub core_mode: Option<String>,
    pub started_at: Option<u64>,
}

pub type CoreStateMutex = Mutex<CoreState>;

/// 检测当前 CPU 是否支持 AVX2 指令集 (x86_64-v3)
pub fn check_avx2_support() -> bool {
    #[cfg(target_arch = "x86_64")]
    {
        is_x86_feature_detected!("avx2")
    }
    #[cfg(not(target_arch = "x86_64"))]
    {
        false
    }
}

pub fn stop_owned_child(state: &mut CoreState) -> Result<(), String> {
    stop_owned_child_ex(state, false)
}

pub fn stop_owned_child_ex(state: &mut CoreState, keep_proxy: bool) -> Result<(), String> {
    crate::routing_overrides::reset_system_proxy_observation();
    crate::capture::stop();
    if let Some(child) = state.child.as_mut() {
        if child.try_wait().map_err(|e| e.to_string())?.is_none() {
            child.kill().map_err(|e| e.to_string())?;
            child.wait().map_err(|e| e.to_string())?;
        }
    }
    state.child = None;
    ACTIVE.store(false, std::sync::atomic::Ordering::SeqCst);
    PID.store(0, std::sync::atomic::Ordering::SeqCst);
    state.active_core = None;
    state.active_core_path = None;
    state.core_mode = None;
    state.started_at = None;
    if !keep_proxy {
        set_system_proxy_raw(false, None)?;
    }
    Ok(())
}

#[tauri::command]
pub fn get_cpu_info() -> CpuInfo {
    let avx2 = check_avx2_support();
    CpuInfo {
        arch: std::env::consts::ARCH.to_string(),
        avx2_supported: avx2,
        recommended_core: if avx2 { "v3".into() } else { "compatible".into() },
    }
}

/// UI queries only observe. Cleanup and route reconciliation belong to the background lifecycle.
#[tauri::command]
pub async fn get_core_status(state: tauri::State<'_, CoreStateMutex>) -> Result<CoreStatus, String> {
    let _lifecycle = LIFECYCLE.lock().await;
    read_core_status(&state)
}

fn read_core_status(state: &CoreStateMutex) -> Result<CoreStatus, String> {
    let mut state = state.lock().map_err(|e| e.to_string())?;
    let pid = match state.child.as_mut() {
        Some(child) => if child.try_wait().map_err(|_| "无法读取核心状态")?.is_none() { Some(child.id()) } else { None },
        None => None,
    };
    let proxy = sysproxy::system_proxy_snapshot();
    Ok(CoreStatus {
        running: pid.is_some(), pid,
        system_proxy_enabled: proxy.enabled(), system_proxy: proxy,
        mixed_port: state.mixed_port, controller_port: state.controller_port,
        active_core: state.active_core.clone(), started_at: if pid.is_some() { state.started_at } else { None },
    })
}

pub(crate) async fn monitor_core(state: tauri::State<'_, CoreStateMutex>) -> Result<(), String> {
    let _lifecycle = LIFECYCLE.lock().await;
    {
        let mut state = state.lock().map_err(|e| e.to_string())?;
        let exited = match state.child.as_mut() {
            Some(child) => child.try_wait().map_err(|_| "无法读取核心状态，暂缓退出恢复")?.is_some(),
            None => false,
        };
        if exited || (state.child.is_none() && sysproxy::has_owned_proxy()) {
            // Release proxy before dropping the handle, so a failed restore is retried next tick.
            sysproxy::set_system_proxy_with_reason(false, None, "核心异常退出，恢复接管前的系统代理设置")?;
            stop_owned_child_ex(&mut state, true)?;
        }
    }
    let proxy = sysproxy::observe_change(None);
    crate::routing_overrides::reconcile_system_proxy(&proxy).await
}

#[tauri::command]
pub async fn start_core(
    core_mode: Option<String>,
    state: tauri::State<'_, CoreStateMutex>,
) -> Result<CoreStatus, String> {
    start_core_transaction(core_mode, &state).await
}

pub(crate) async fn start_core_transaction(core_mode: Option<String>, state: &CoreStateMutex) -> Result<CoreStatus, String> {
    let _lifecycle = LIFECYCLE.lock().await;
    start_core_locked(core_mode, state).await
}

/// 调用方持有 LIFECYCLE，设置事务重启时避免重复获取同一锁。
pub(crate) async fn start_core_locked(core_mode: Option<String>, state: &CoreStateMutex) -> Result<CoreStatus, String> {
    if crate::shutdown::in_progress() { return Err("正在恢复网络并退出，暂不启动核心".into()); }
    // 如果已经在运行，先检查并返回
    {
        let mut state_guard = state.lock().map_err(|e| e.to_string())?;
        if let Some(ref mut child) = state_guard.child {
            if child.try_wait().map(|s| s.is_none()).unwrap_or(false) {
                let sys_proxy = sysproxy::system_proxy_snapshot();
                return Ok(CoreStatus {
                    running: true,
                    pid: Some(child.id()),
                    system_proxy_enabled: sys_proxy.enabled(),
                    system_proxy: sys_proxy,
                    mixed_port: state_guard.mixed_port,
                    controller_port: state_guard.controller_port,
                    active_core: state_guard.active_core.clone(),
                    started_at: state_guard.started_at,
                });
            }
        }
    } // state_guard 在此被丢弃，后续操作不持有锁

    let base_dir = crate::commands::profile::get_base_dir();
    let resource_dir = crate::storage::resource_dir();
    let mode = core_mode.unwrap_or_else(|| "auto".to_string());
    let avx2_supported = check_avx2_support();

    let find_bin = |name: &str| -> Option<PathBuf> {
        let candidates = [
            resource_dir.join("binaries").join(name),
            base_dir.join("binaries").join(name),
        ];
        for c in &candidates {
            if c.exists() { return Some(c.clone()); }
        }
        #[cfg(not(test))]
        {
            let has_any_binaries_dir = resource_dir.join("binaries").is_dir() || base_dir.join("binaries").is_dir();
            if !has_any_binaries_dir {
                if let Ok(exe) = std::env::current_exe() {
                    if let Some(parent) = exe.parent() {
                        let c1 = parent.join("binaries").join(name);
                        if c1.exists() { return Some(c1); }
                        let mut curr = parent;
                        while let Some(up) = curr.parent() {
                            let c2 = up.join("binaries").join(name);
                            if c2.exists() { return Some(c2); }
                            curr = up;
                        }
                    }
                }
            }
        }
        None
    };

    let v3_path = find_bin("mihomo-v3.exe");
    let comp_path = find_bin("mihomo-compatible.exe");
    let std_path = find_bin("mihomo.exe");

    // 智能决策具体启动哪个二进制文件
    let (chosen_exe, core_label) = match mode.as_str() {
        "v3" => {
            if let Some(p) = v3_path {
                (p, "amd64-v3 (AVX2 高性能)")
            } else {
                return Err("未找到内核文件: binaries/mihomo-v3.exe".into());
            }
        }
        "compatible" => {
            if let Some(p) = comp_path {
                (p, "amd64-compatible (通用兼容)")
            } else {
                return Err("未找到内核文件: binaries/mihomo-compatible.exe".into());
            }
        }
        "standard" => {
            if let Some(p) = std_path {
                (p, "mihomo 标准版")
            } else {
                return Err("未找到标准版核心 mihomo.exe".into());
            }
        }
        _ => {
            // "auto" 模式：优先判断 CPU 是否支持 AVX2
            if avx2_supported && v3_path.is_some() {
                (v3_path.unwrap(), "amd64-v3 (AVX2 高性能 • 自动推荐)")
            } else if let Some(p) = comp_path {
                (p, "amd64-compatible (通用兼容)")
            } else if let Some(p) = std_path {
                (p, "mihomo 标准版")
            } else {
                return Err("未检测到任何可用的 mihomo 内核，请检查 binaries 目录".into());
            }
        }
    };

    let mut cmd = std::process::Command::new(&chosen_exe);

    // 优先寻找当前选中的配置文件，若无则降级为 default.yaml
    let default_config = base_dir.join("config").join("default.yaml");
    let mut chosen_config = default_config.clone();

    let profiles_json_path = crate::commands::profile::get_profiles_index_file();
    if let Ok(profiles_content) = std::fs::read_to_string(&profiles_json_path) {
        if let Ok(profiles) = serde_json::from_str::<Vec<serde_json::Value>>(&profiles_content) {
            for item in profiles {
                if item.get("isSelected").and_then(|v| v.as_bool()).unwrap_or(false) {
                    if let Some(fp) = item.get("filePath").and_then(|v| v.as_str()) {
                        let candidate = base_dir.join(fp);
                        if candidate.exists() {
                            chosen_config = candidate;
                            break;
                        }
                    }
                }
            }
        }
    }

    // 指定独立的工作数据目录 (包含 geoip.metadb 和 geosite.dat)
    let core_data_dir = base_dir.join("core_data");
    std::fs::create_dir_all(&core_data_dir).map_err(|_| "创建核心数据目录失败")?;
    let canonical_data = std::fs::canonicalize(&core_data_dir).map_err(|_| "解析核心数据目录失败")?;
    let canonical_text = canonical_data.to_string_lossy();
    let core_data_dir = std::path::PathBuf::from(canonical_text.strip_prefix(r"\\?\").unwrap_or(&canonical_text));
    cmd.arg("-d").arg(&core_data_dir);

    // 将选中的配置复制到 core_data/config.yaml (保证后续 REST API PUT /configs 符合 SAFE_PATHS 要求)
    let core_config = core_data_dir.join("config.yaml");
    if chosen_config.exists() {
        let raw = std::fs::read_to_string(&chosen_config).map_err(|e| e.to_string())?;
        #[cfg(test)] {
            let barriers = STARTUP_BARRIER.lock().unwrap().take();
            if let Some((read, resume)) = barriers { read.wait().await; resume.wait().await; }
        }
        let prepared = rule_startup_config(&crate::commands::settings::prepare_config(&raw)?)?;
        crate::commands::profile::validate_config(&prepared)?;
        super::dns_runtime::preflight(&prepared, 0).await?;
        crate::storage::replace(&core_config, prepared.as_bytes())?;
        cmd.arg("-f").arg(&core_config);
    } else { return Err("配置文件不存在，请重新选择订阅".into()); }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW 避免黑框
        cmd.creation_flags(0x08000000);
    }

    let preferences = crate::commands::settings::get_general_settings()?;
    for port in [preferences.mixed_port, preferences.controller_port] {
        std::net::TcpListener::bind(("127.0.0.1", port)).map_err(|_| format!("端口 {port} 已被占用，核心未启动"))?;
    }
    let mut child = cmd.spawn().map_err(|e| format!("启动内核 [{}] 失败: {}", chosen_exe.display(), e))?;
    #[cfg(windows)]
    if let Err(error) = bind_core_lifetime(&child) {
        let _ = child.kill(); let _ = child.wait();
        return Err(error);
    }
    
    // 监听端口与控制接口均就绪才报告成功，供自动重启事务判断是否回滚。
    let ready = async {
        wait_for_core_ready(&mut child, preferences.controller_port, preferences.mixed_port).await?;
        let raw = std::fs::read_to_string(&core_config).map_err(|_| "读取核心启动配置失败")?;
        super::dns_runtime::confirm(&raw, child.id()).await?;
        crate::routing_overrides::bundles::select(&raw).await?;
        crate::capture::confirm_runtime(&raw).await
    }.await;
    if let Err(error) = ready {
        let _ = child.kill(); let _ = child.wait();
        return Err(error);
    }

    let pid = child.id();
    PID.store(pid, std::sync::atomic::Ordering::SeqCst);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let mut state_guard = match state.lock() {
        Ok(guard) => guard,
        Err(error) => {
            let _ = child.kill(); let _ = child.wait();
            return Err(error.to_string());
        }
    };
    state_guard.mixed_port = preferences.mixed_port;
    state_guard.controller_port = preferences.controller_port;
    state_guard.child = Some(child);
    ACTIVE.store(true, std::sync::atomic::Ordering::SeqCst);
    if let Ok(config) = crate::routing_overrides::read() {
        crate::routing_overrides::set_applied(config.revision, crate::routing_overrides::tracker::status(&config).generation);
    }
    state_guard.active_core = Some(core_label.to_string());
    state_guard.active_core_path = Some(chosen_exe.to_string_lossy().to_string());
    let file_name = chosen_exe.file_name().and_then(|f| f.to_str()).unwrap_or("");
    state_guard.core_mode = Some(if file_name.contains("v3") {
        "v3"
    } else if file_name.contains("compatible") {
        "compatible"
    } else {
        "standard"
    }.into());
    state_guard.started_at = Some(now);

    let sys_proxy = sysproxy::system_proxy_snapshot();

    Ok(CoreStatus {
        running: true,
        pid: Some(pid),
        system_proxy_enabled: sys_proxy.enabled(),
        system_proxy: sys_proxy,
        mixed_port: state_guard.mixed_port,
        controller_port: state_guard.controller_port,
        active_core: state_guard.active_core.clone(),
        started_at: Some(now),
    })
}

fn rule_startup_config(raw: &str) -> Result<String, String> {
    let mut value: serde_yaml::Value = serde_yaml::from_str(raw).map_err(|_| "运行配置格式无效")?;
    value.as_mapping_mut().ok_or("运行配置必须为对象")?.insert("mode".into(), "rule".into());
    serde_yaml::to_string(&value).map_err(|_| "生成启动模式失败".into())
}

async fn wait_for_core_ready(child: &mut Child, controller: u16, mixed: u16) -> Result<(), String> {
    let client = super::mihomo_api::controller_client().timeout(std::time::Duration::from_millis(500)).build().map_err(|_| "初始化核心就绪检查失败")?;
    for _ in 0..30 {
        if child.try_wait().map_err(|_| "读取核心启动状态失败")?.is_some() { return Err("核心启动后退出，请检查配置和端口".into()); }
        let controller_ready = client.get(format!("http://127.0.0.1:{controller}/version")).send().await.is_ok_and(|r| r.status().is_success());
        if controller_ready && tokio::time::timeout(std::time::Duration::from_millis(300), tokio::net::TcpStream::connect(("127.0.0.1", mixed))).await.is_ok_and(|r| r.is_ok()) { return Ok(()); }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    Err("核心监听端口或控制接口就绪超时".into())
}

#[tauri::command]
pub async fn stop_core(state: tauri::State<'_, CoreStateMutex>) -> Result<CoreStatus, String> {
    let _lifecycle = LIFECYCLE.lock().await;
    let mut state = state.lock().map_err(|e| e.to_string())?;

    stop_owned_child(&mut state)?;
    let proxy = sysproxy::system_proxy_snapshot();

    Ok(CoreStatus {
        running: false,
        pid: None,
        system_proxy_enabled: proxy.enabled(),
        system_proxy: proxy,
        mixed_port: state.mixed_port,
        controller_port: state.controller_port,
        active_core: None,
        started_at: None,
    })
}

#[tauri::command]
pub async fn restart_core(app: tauri::AppHandle) -> Result<CoreStatus, String> {
    restart_core_transaction(&app).await
}

pub async fn restart_core_transaction(app: &tauri::AppHandle) -> Result<CoreStatus, String> {
    use tauri::Manager;
    use tauri::Emitter;
    let _lifecycle = LIFECYCLE.lock().await;

    // 1. 抓取重启前环境快照
    let was_proxy_enabled = get_system_proxy_status()?;
    let mut last_active_node: Option<String> = None;
    let mut last_mode: Option<String> = None;

    if let Ok(res) = crate::commands::mihomo_api::get_mihomo_proxies().await {
        if let Some(proxies) = res.get("proxies").and_then(|p| p.as_object()) {
            for group_name in ["节点选择", "🚀 节点选择", "PROXY", "GLOBAL"] {
                if let Some(group_val) = proxies.get(group_name) {
                    if let Some(now) = group_val.get("now").and_then(|n| n.as_str()) {
                        last_active_node = Some(now.to_string());
                        break;
                    }
                }
            }
        }
    }
    if let Ok(cfg) = crate::commands::mihomo_api::get_mihomo_config().await {
        if let Some(m) = cfg.get("mode").and_then(|v| v.as_str()) {
            last_mode = Some(m.to_string());
        }
    }

    // 2. 停掉旧核心（设置 keep_proxy 为 true，避免断开 Windows 系统代理）
    {
        let state = app.state::<CoreStateMutex>();
        let mut state_guard = state.lock().map_err(|e| e.to_string())?;
        stop_owned_child_ex(&mut state_guard, true)?;
    }

    // 3. 启动新核心（持锁状态下调用 start_core_locked，避免 LIFECYCLE 死锁）
    let state = app.state::<CoreStateMutex>();
    let mut status = match start_core_locked(None, &state).await {
        Ok(s) => s,
        Err(e) => {
            // 启动失败时，旧核心已停，系统代理必须关闭并通知，防止系统代理指向死端口导致用户断网
            if was_proxy_enabled {
                sysproxy::set_system_proxy_with_reason(false, None, "核心重启失败，恢复接管前的系统代理设置")
                    .map_err(|restore| format!("重启失败：{e}；系统代理恢复失败：{restore}"))?;
                crate::app_lifecycle::notify_sysproxy_changed(app, false);
            }
            return Err(format!("重启核心失败: {}", e));
        }
    };

    // 4. 环境还原
    if was_proxy_enabled {
        // If another application took over while restarting, keep its settings intact.
        if get_system_proxy_status()? {
            sysproxy::set_system_proxy_with_reason(true, Some(status.mixed_port), "核心重启完成，系统代理保持启用")?;
        }
        status.system_proxy = sysproxy::system_proxy_snapshot();
        status.system_proxy_enabled = status.system_proxy.enabled();
        crate::app_lifecycle::notify_sysproxy_changed(app, status.system_proxy_enabled);
    }
    if let Some(node) = last_active_node {
        for group in ["节点选择", "🚀 节点选择", "PROXY", "GLOBAL"] {
            let _ = crate::commands::mihomo_api::switch_mihomo_proxy(group.into(), node.clone()).await;
        }
    }
    if let Some(m) = last_mode {
        let _ = crate::commands::mihomo_api::set_mihomo_mode(m).await;
    }

    // 5. 全局广播与托盘刷新
    let _ = app.emit("netbox-route-changed", ());
    crate::app_lifecycle::rebuild_tray_in_place(app);

    Ok(status)
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    #[test]
    fn status_queries_never_cleanup_exited_core_or_write_proxy_events() {
        use std::os::windows::process::CommandExt;
        let mut child = std::process::Command::new("pwsh").args(["-NoProfile", "-Command", "exit 0"])
            .creation_flags(0x08000000).spawn().unwrap();
        child.wait().unwrap();
        let state = Mutex::new(CoreState { child: Some(child), mixed_port: 7890, controller_port: 9090,
            active_core: None, active_core_path: None, core_mode: None, started_at: Some(1) });
        let events = crate::storage::data_dir().join("config/system-proxy-events.json");
        let before = std::fs::read(&events).ok();
        for _ in 0..5 { assert!(!read_core_status(&state).unwrap().running); }
        assert!(state.lock().unwrap().child.is_some(), "查询保留句柄，由后台生命周期执行退出恢复");
        assert_eq!(std::fs::read(&events).ok(), before);
    }
    #[test]
    fn forced_owner_exit_terminates_bound_core() {
        use std::os::windows::{io::{FromRawHandle, OwnedHandle, AsRawHandle}, process::CommandExt};
        use windows_sys::Win32::System::Threading::{OpenProcess, WaitForSingleObject};
        const FLAG: &str = "NETBOX_JOB_TEST_PID_FILE";
        if let Some(marker) = std::env::var_os(FLAG) {
            let mut child = std::process::Command::new("pwsh").args(["-NoProfile", "-Command", "Start-Sleep -Seconds 60"])
                .creation_flags(0x08000000).spawn().unwrap();
            if let Err(error) = bind_core_lifetime(&child) { let _ = child.kill(); let _ = child.wait(); panic!("{error}"); }
            std::fs::write(marker, child.id().to_string()).unwrap();
            std::thread::sleep(std::time::Duration::from_secs(60));
            return;
        }
        let marker = std::env::temp_dir().join(format!("netbox-job-test-{}.pid", std::process::id()));
        let mut owner = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "commands::process::tests::forced_owner_exit_terminates_bound_core"])
            .env(FLAG, &marker).creation_flags(0x08000000).spawn().unwrap();
        let start = std::time::Instant::now();
        while !marker.exists() && start.elapsed().as_secs() < 15 && owner.try_wait().unwrap().is_none() {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        if !marker.exists() { let _ = owner.kill(); let _ = owner.wait(); panic!("核心绑定测试未就绪"); }
        let pid: u32 = std::fs::read_to_string(&marker).unwrap().parse().unwrap();
        let raw = unsafe { OpenProcess(0x00100000, 0, pid) };
        owner.kill().unwrap(); owner.wait().unwrap();
        assert!(!raw.is_null(), "必须先持有被保护进程句柄");
        let handle = unsafe { OwnedHandle::from_raw_handle(raw) };
        assert_eq!(unsafe { WaitForSingleObject(handle.as_raw_handle(), 5000) }, 0, "宿主强制结束后核心必须退出");
        std::fs::remove_file(marker).unwrap();
    }
    #[test]
    fn stopping_owned_child_leaves_other_process_alive() {
        use std::os::windows::process::CommandExt;
        let spawn = || std::process::Command::new("pwsh")
            .args(["-NoProfile", "-Command", "Start-Sleep -Seconds 30"])
            .creation_flags(0x08000000).spawn().unwrap();
        let mut unrelated = spawn();
        let mut state = CoreState { child: Some(spawn()), mixed_port: 7890, controller_port: 9090, active_core: None, active_core_path: None, core_mode: None, started_at: None };
        let result = stop_owned_child(&mut state);
        let unrelated_alive = unrelated.try_wait().unwrap().is_none();
        unrelated.kill().unwrap(); unrelated.wait().unwrap();
        result.unwrap();
        assert!(state.child.is_none());
        assert!(unrelated_alive);
    }
}

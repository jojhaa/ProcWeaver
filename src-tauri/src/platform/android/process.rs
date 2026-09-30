use crate::{commands::{settings, sysproxy}, platform::android};
use serde::{Deserialize, Serialize};
use std::sync::{atomic::{AtomicBool, AtomicU32, Ordering}, Mutex};
use tauri::Manager;

pub static ACTIVE: AtomicBool = AtomicBool::new(false);
pub(crate) static PID: AtomicU32 = AtomicU32::new(0);
pub(crate) static LIFECYCLE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServiceStatus { running: bool, pid: u32, started_at: u64, generation: u64 }

pub struct ServiceHandle { generation: u64 }
impl ServiceHandle {
    pub fn id(&self) -> u32 { std::process::id() }
    pub fn try_wait(&mut self) -> Result<Option<()>, String> {
        let status: ServiceStatus = android::call("status", ())?;
        Ok((!status.running || status.generation != self.generation).then_some(()))
    }
}

pub struct CoreState {
    pub child: Option<ServiceHandle>, pub mixed_port: u16, pub controller_port: u16,
    pub active_core: Option<String>, pub active_core_path: Option<String>,
    pub core_mode: Option<String>, pub started_at: Option<u64>,
}
pub type CoreStateMutex = Mutex<CoreState>;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CpuInfo { arch: String, avx2_supported: bool, recommended_core: String }
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreStatus {
    pub running: bool, pub pid: Option<u32>, pub system_proxy_enabled: bool,
    pub generation: u64,
    pub system_proxy: sysproxy::SystemProxyStatus, pub mixed_port: u16, pub controller_port: u16,
    pub active_core: Option<String>, pub started_at: Option<u64>,
}

pub fn check_avx2_support() -> bool { false }
#[tauri::command]
pub fn get_cpu_info() -> CpuInfo { CpuInfo { arch: std::env::consts::ARCH.into(), avx2_supported: false, recommended_core: "standard".into() } }

fn record(state: &CoreStateMutex, status: ServiceStatus) -> Result<CoreStatus, String> {
    let preferences = settings::get_general_settings()?;
    let mut core = state.lock().map_err(|_| "读取核心状态失败")?;
    core.mixed_port = preferences.mixed_port; core.controller_port = preferences.controller_port;
    core.child = status.running.then_some(ServiceHandle { generation: status.generation });
    core.started_at = status.running.then_some(status.started_at);
    core.active_core = status.running.then(|| "Mihomo Android ARM64".into());
    core.core_mode = Some("standard".into());
    ACTIVE.store(status.running, Ordering::SeqCst);
    PID.store(if status.running { status.pid } else { 0 }, Ordering::SeqCst);
    Ok(CoreStatus { running: status.running, pid: status.running.then_some(status.pid), system_proxy_enabled: false,
        generation: status.generation,
        system_proxy: sysproxy::system_proxy_snapshot(), mixed_port: core.mixed_port, controller_port: core.controller_port,
        active_core: core.active_core.clone(), started_at: core.started_at })
}

#[tauri::command]
pub async fn get_core_status(state: tauri::State<'_, CoreStateMutex>) -> Result<CoreStatus, String> {
    let _lock = LIFECYCLE.lock().await;
    record(&state, android::call_async("status", ()).await?)
}

#[tauri::command]
pub async fn start_core(core_mode: Option<String>, state: tauri::State<'_, CoreStateMutex>) -> Result<CoreStatus, String> {
    start_core_transaction(core_mode, &state).await
}
pub(crate) async fn start_core_transaction(mode: Option<String>, state: &CoreStateMutex) -> Result<CoreStatus, String> {
    let _lock = LIFECYCLE.lock().await;
    start_core_locked(mode, state).await
}
pub(crate) async fn start_core_locked(_: Option<String>, state: &CoreStateMutex) -> Result<CoreStatus, String> {
    let status: ServiceStatus = android::call_async("status", ()).await?;
    if status.running { return record(state, status); }
    let prepared = prepare_current_runtime()?;
    // Native parsing may load Geo databases. Never block the Android UI thread.
    let validation = prepared.clone();
    tauri::async_runtime::spawn_blocking(move || android::validate(&validation)).await.map_err(|_| "校验任务失败")??;
    let path = crate::storage::data_dir().join("core_data/config.yaml");
    crate::storage::replace(&path, prepared.as_bytes())?;
    let preferences = settings::get_general_settings()?;
    let status: ServiceStatus = android::call_async("start", serde_json::json!({"config": path, "ipv6": preferences.ipv6})).await?;
    if !status.running { return Err("VPN 服务未启动".into()); }
    let ready = async {
        let client = crate::commands::mihomo_api::controller_client().timeout(std::time::Duration::from_secs(2)).build().map_err(|e| e.to_string())?;
        for _ in 0..30 {
            if client.get(format!("http://127.0.0.1:{}/version", preferences.controller_port)).send().await.is_ok_and(|r| r.status().is_success()) {
                return Ok(());
            }
            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        }
        Err("VPN 控制接口未就绪".into())
    }.await;
    if let Err(error) = ready { let _: serde_json::Value = android::call_async("stop", ()).await?; return Err(error); }
    let result = record(state, status)?;
    if let Ok(config) = crate::routing_overrides::read() {
        crate::routing_overrides::set_applied(config.revision, crate::routing_overrides::tracker::status(&config).generation);
    }
    Ok(result)
}

pub(crate) fn prepare_current_runtime() -> Result<String, String> {
    let (_, source) = crate::routing_overrides::current_source();
    let raw = std::fs::read_to_string(&source).map_err(|_| "配置不存在，请先导入订阅")?;
    let prepared = settings::prepare_config(&raw)?;
    let mut yaml: serde_yaml::Value = serde_yaml::from_str(&prepared).map_err(|_| "配置无效")?;
    yaml["mode"] = "rule".into();
    serde_yaml::to_string(&yaml).map_err(|_| "配置序列化失败".into())
}

pub fn stop_owned_child(state: &mut CoreState) -> Result<(), String> { stop_owned_child_ex(state, false) }
pub fn stop_owned_child_ex(state: &mut CoreState, _: bool) -> Result<(), String> {
    let _: serde_json::Value = android::call("stop", ())?;
    state.child = None; state.active_core = None; state.started_at = None; state.active_core_path = None;
    ACTIVE.store(false, Ordering::SeqCst); PID.store(0, Ordering::SeqCst);
    Ok(())
}
#[tauri::command]
pub async fn stop_core(state: tauri::State<'_, CoreStateMutex>) -> Result<CoreStatus, String> {
    let _lock = LIFECYCLE.lock().await;
    record(&state, android::call_async("stop", ()).await?)
}
#[tauri::command]
pub async fn restart_core(app: tauri::AppHandle) -> Result<CoreStatus, String> { restart_core_transaction(app).await }
pub(crate) async fn restart_core_transaction(app: tauri::AppHandle) -> Result<CoreStatus, String> {
    let _lock = LIFECYCLE.lock().await;
    let state = app.state::<CoreStateMutex>();
    let _: serde_json::Value = android::call_async("stop", ()).await?;
    start_core_locked(None, &state).await
}

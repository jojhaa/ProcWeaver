//! Desktop feature scope, independent of Mihomo's rule/global/direct mode.
use serde::{Deserialize, Serialize};
use std::sync::{atomic::{AtomicBool, Ordering}, Mutex};
use crate::commands::{process, settings};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FunctionMode { #[default] Full, ProcessProxy }
#[derive(Default, Serialize, Deserialize)]
struct Config { #[serde(default)] mode: FunctionMode }
static PROCESS_ONLY: AtomicBool = AtomicBool::new(false);
static LOAD_ERROR: Mutex<Option<String>> = Mutex::new(None);
pub(crate) fn core_features_enabled() -> bool { !crate::edition::PROCESS && !PROCESS_ONLY.load(Ordering::Acquire) }
fn current() -> FunctionMode { if core_features_enabled() { FunctionMode::Full } else { FunctionMode::ProcessProxy } }
fn path() -> std::path::PathBuf { crate::storage::data_dir().join("config/function-mode.json") }
pub(crate) fn initialize() {
    if crate::edition::PROCESS { PROCESS_ONLY.store(true, Ordering::Release); return; }
    let result = read_config(&path());
    // A corrupt preference must not unexpectedly start a network core.
    PROCESS_ONLY.store(result.as_ref().map_or(true, |c| c.mode == FunctionMode::ProcessProxy), Ordering::Release);
    *LOAD_ERROR.lock().unwrap_or_else(|e| e.into_inner()) = result.err();
}
fn read_config(path: &std::path::Path) -> Result<Config, String> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| "功能模式配置损坏，未启动核心；请修复配置后重新打开程序".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Config::default()),
        Err(_) => Err("无法读取功能模式配置，未启动核心".into()),
    }
}
pub(crate) fn require_full() -> Result<(), String> {
    if !core_features_enabled() { return Err("当前为进程代理功能，请切回完整功能后使用此操作".into()); }
    Ok(())
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View { mode: FunctionMode, core_running: bool, independent_win_divert: bool, win_divert_reason: &'static str }
fn view() -> Result<View, String> {
    if let Some(error) = LOAD_ERROR.lock().unwrap_or_else(|e| e.into_inner()).clone() { return Err(error); }
    Ok(View { mode: current(), core_running: process::ACTIVE.load(Ordering::SeqCst), independent_win_divert: cfg!(all(windows,target_arch="x86_64")),
        win_divert_reason: "WinDivert 可直接使用独立外部代理，需管理员权限；只接管明确进程的新连接" })
}
#[tauri::command]
pub fn get_function_mode() -> Result<View, String> { view() }
fn validate_change(mode: FunctionMode, expected: FunctionMode, actual: FunctionMode, confirmed: bool) -> Result<(), String> {
    if expected != actual { return Err("功能模式已改变，请重新读取后再切换".into()); }
    if mode == FunctionMode::ProcessProxy && actual != mode && !confirmed { return Err("切换会停止核心接管，需先确认网络影响".into()); }
    if mode == FunctionMode::ProcessProxy && !cfg!(windows) { return Err("进程代理专用界面当前仅支持 Windows".into()); }
    Ok(())
}
#[tauri::command]
pub async fn set_function_mode(mode: FunctionMode, expected_mode: FunctionMode, confirm_network_stop: bool,
    app: tauri::AppHandle, state: tauri::State<'_, process::CoreStateMutex>) -> Result<View, String> {
    if crate::edition::PROCESS { return Err("独立进程版固定使用进程代理功能".into()); }
    let _lifecycle = process::LIFECYCLE.lock().await;
    if crate::shutdown::in_progress() { return Err("正在退出，暂不切换功能模式".into()); }
    let previous = view()?.mode;
    validate_change(mode, expected_mode, previous, confirm_network_stop)?;
    if mode == previous { return view(); }
    let (was_running, core_mode, mixed_port) = {
        let core = state.lock().map_err(|_| "读取核心状态失败")?;
        (process::ACTIVE.load(Ordering::SeqCst), core.core_mode.clone(), core.mixed_port)
    };
    let was_proxy = crate::commands::sysproxy::has_owned_proxy();
    let was_dns = crate::commands::dns_adapter::get_dns_guard_status()?;
    let saved = serde_json::to_vec_pretty(&Config { mode }).map_err(|_| "无法编码功能模式")?;
    let transition = async {
        if mode == FunctionMode::ProcessProxy {
            crate::commands::dns_adapter::restore_dns_guard().await?;
            let mut core = state.lock().map_err(|_| "读取核心状态失败")?;
            process::stop_owned_child(&mut core)?;
        }
        crate::storage::replace(&path(), &saved)
    }.await;
    if let Err(error) = transition {
        let mut failures = Vec::new();
        if was_running {
            if let Err(e) = process::start_core_locked(core_mode, &state).await { failures.push(e); }
        }
        if was_proxy && (!was_running || process::ACTIVE.load(Ordering::SeqCst)) {
            if let Err(e) = crate::commands::sysproxy::set_system_proxy_raw(true, Some(mixed_port)) { failures.push(e); }
        }
        if was_dns && process::ACTIVE.load(Ordering::SeqCst) {
            if let Err(e) = crate::commands::dns_adapter::enable_dns_guard().await { failures.push(e); }
        }
        return Err(if failures.is_empty() { format!("切换失败，保留原功能模式：{error}") }
            else { format!("切换失败，原功能模式保留；网络恢复未完成：{}；原因：{error}", failures.join("；")) });
    }
    PROCESS_ONLY.store(mode == FunctionMode::ProcessProxy, Ordering::Release);
    if mode == FunctionMode::Full { crate::process_capture::stop(); }
    crate::commands::geo::function_mode_changed();
    if mode == FunctionMode::ProcessProxy {
        crate::commands::process_watcher::stop_watcher_loop();
        crate::commands::health_probe::shutdown();
    } else { crate::commands::process_watcher::init_watcher_on_startup(); }
    #[cfg(not(target_os = "android"))]
    crate::app_lifecycle::rebuild_tray_in_place(&app);
    use tauri::Emitter;
    let _ = app.emit("procweaver-function-mode-changed", mode);
    let _ = app.emit("procweaver-dns-guard-changed", ());
    view()
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProcessPreferences { auto_start: bool, minimize_on_close: bool, silent_start: bool }
impl From<&settings::GeneralSettings> for ProcessPreferences {
    fn from(s: &settings::GeneralSettings) -> Self { Self { auto_start: s.auto_start, minimize_on_close: s.minimize_on_close, silent_start: s.silent_start } }
}
#[tauri::command]
pub fn get_process_preferences() -> Result<ProcessPreferences, String> { settings::get_general_settings().map(|s| ProcessPreferences::from(&s)) }
#[tauri::command]
pub async fn save_process_preferences(settings: ProcessPreferences, state: tauri::State<'_, process::CoreStateMutex>) -> Result<ProcessPreferences, String> {
    let _lifecycle = process::LIFECYCLE.lock().await;
    if current() != FunctionMode::ProcessProxy { return Err("功能模式已改变，请重新读取设置".into()); }
    let mut next = settings::get_general_settings()?;
    next.auto_start = settings.auto_start; next.minimize_on_close = settings.minimize_on_close; next.silent_start = settings.silent_start;
    settings::persist_general_settings(next, &state).map(|s| ProcessPreferences::from(&s))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mode_schema_is_separate_and_rejects_unknown_modes() {
        assert_eq!(serde_json::from_str::<Config>("{}").unwrap().mode, FunctionMode::Full);
        assert_eq!(serde_json::from_str::<Config>(r#"{"mode":"process_proxy"}"#).unwrap().mode, FunctionMode::ProcessProxy);
        assert!(serde_json::from_str::<Config>(r#"{"mode":"global"}"#).is_err());
        assert!(serde_json::from_str::<ProcessPreferences>(r#"{"autoStart":false,"minimizeOnClose":true,"silentStart":false,"tunMode":true}"#).is_err());
    }
    #[test]
    fn stale_or_unconfirmed_transition_is_rejected_before_network_changes() {
        assert!(validate_change(FunctionMode::ProcessProxy, FunctionMode::Full, FunctionMode::ProcessProxy, true).is_err());
        assert!(validate_change(FunctionMode::ProcessProxy, FunctionMode::Full, FunctionMode::Full, false).is_err());
        assert!(validate_change(FunctionMode::Full, FunctionMode::ProcessProxy, FunctionMode::ProcessProxy, false).is_ok());
    }
    #[test]
    fn missing_mode_defaults_full_but_corrupt_mode_never_defaults_full() {
        let path = std::env::temp_dir().join(format!("procweaver-mode-{}.json", std::process::id()));
        assert_eq!(read_config(&path).unwrap().mode, FunctionMode::Full);
        crate::storage::replace(&path, br#"{"mode":"process_proxy"}"#).unwrap();
        assert_eq!(read_config(&path).unwrap().mode, FunctionMode::ProcessProxy);
        std::fs::write(&path, b"corrupt").unwrap();
        assert!(read_config(&path).is_err());
        std::fs::remove_file(path).unwrap();
    }
}

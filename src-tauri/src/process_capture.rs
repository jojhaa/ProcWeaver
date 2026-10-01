//! Independent capture selection. Persisted separately from Mihomo traffic mode.
use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
#[derive(Clone, Copy, Default, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AccessMode {
    #[default]
    AppProxy,
    Windivert,
}
#[derive(Default, Serialize, Deserialize)]
struct Config {
    mode: AccessMode,
}
static SELECTED: AtomicBool = AtomicBool::new(false);
static ERROR: Mutex<Option<String>> = Mutex::new(None);
#[cfg(windows)]
static ENGINE: Mutex<Option<crate::capture::windivert::runtime::Engine>> = Mutex::new(None);
fn path() -> std::path::PathBuf {
    crate::storage::data_dir().join("config/process-capture.json")
}
pub(crate) fn initialize() {
    match std::fs::read(path()) {
        Ok(bytes) => match serde_json::from_slice::<Config>(&bytes) {
            Ok(c) => SELECTED.store(c.mode == AccessMode::Windivert, Ordering::Release),
            Err(_) => *ERROR.lock().unwrap() = Some("进程接入配置损坏，驱动未自动启动".into()),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => *ERROR.lock().unwrap() = Some("进程接入配置读取失败".into()),
    }
}
pub(crate) fn selected() -> bool {
    SELECTED.load(Ordering::Acquire) && !crate::function_mode::core_features_enabled()
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    mode: AccessMode,
    active: bool,
    admin: bool,
    supported: bool,
    error: Option<String>,
    tcp: u64,
    udp: u64,
    dns: u64,
    unclassified: u64,
    failures: u64,
}
#[tauri::command]
pub fn get_process_capture() -> View {
    #[cfg(windows)]
    let stats = ENGINE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .map(|e| e.stats())
        .unwrap_or_default();
    #[cfg(not(windows))]
    let stats = Stats::default();
    View {
        mode: if SELECTED.load(Ordering::Acquire) {
            AccessMode::Windivert
        } else {
            AccessMode::AppProxy
        },
        active: stats.active,
        admin: crate::commands::system::check_is_admin(),
        supported: cfg!(all(windows, target_arch = "x86_64")),
        error: ERROR.lock().unwrap_or_else(|e| e.into_inner()).clone(),
        tcp: stats.tcp,
        udp: stats.udp,
        dns: stats.dns,
        unclassified: stats.unknown,
        failures: stats.failures,
    }
}
#[cfg(not(windows))]
#[derive(Default)]
struct Stats {
    active: bool,
    tcp: u64,
    udp: u64,
    dns: u64,
    unknown: u64,
    failures: u64,
}
pub(crate) fn active() -> bool {
    selected() && get_process_capture().active
}
fn stop_blocking() {
    #[cfg(windows)]
    {
        let engine = ENGINE.lock().unwrap_or_else(|e| e.into_inner()).take();
        drop(engine);
    }
}
pub(crate) fn stop() {
    #[cfg(windows)]
    if ENGINE.lock().unwrap_or_else(|e| e.into_inner()).is_none() {
        return;
    }
    let _ = std::thread::spawn(stop_blocking).join();
}
fn start_blocking() -> Result<(), String> {
    #[cfg(feature = "process-edition")]
    if let Err(error) = crate::process_conflict::check() {
        // A retry can race with another client's startup. Do not leave our old
        // engine active after setting ERROR (which pauses subsequent ticks).
        stop_blocking();
        return Err(error);
    }
    if !cfg!(all(windows, target_arch = "x86_64")) {
        return Err("独立 WinDivert 仅支持 Windows x64".into());
    }
    if !crate::commands::system::check_is_admin() {
        return Err("WinDivert 需要管理员权限。请正常退出后以管理员身份打开 ProcWeaver，再点击 WinDivert 重试".into());
    }
    #[cfg(windows)]
    {
        let mut current = ENGINE.lock().unwrap_or_else(|e| e.into_inner());
        if current.as_ref().is_some_and(|e| e.stats().active) {
            return Ok(());
        }
        let old = current.take();
        drop(old);
        if !crate::external_proxy::monitoring_required() {
            return Ok(());
        }
        let own = crate::capture::windivert::ownership::Identity::inspect(std::process::id())
            .ok_or("无法确认本程序身份")?;
        let directory = crate::capture::windivert::assets::prepare()?;
        *current = Some(crate::capture::windivert::runtime::Engine::start_external(
            &directory,
            vec![own],
        )?);
    }
    Ok(())
}
pub(crate) async fn tick() {
    if !selected() || !crate::external_proxy::monitoring_required() {
        #[cfg(windows)]
        if ENGINE.lock().unwrap_or_else(|e| e.into_inner()).is_none() {
            return;
        }
        let _ = tokio::task::spawn_blocking(stop_blocking).await;
        return;
    }
    if ERROR.lock().unwrap_or_else(|e| e.into_inner()).is_some() {
        return;
    }
    #[cfg(feature = "process-edition")]
    if let Err(error) = tokio::task::spawn_blocking(crate::process_conflict::check).await
        .unwrap_or_else(|_| Err("检查接管冲突失败，驱动已暂停".into())) {
        *ERROR.lock().unwrap_or_else(|e| e.into_inner()) = Some(error);
        let _ = tokio::task::spawn_blocking(stop_blocking).await;
        return;
    }
    #[cfg(windows)]
    {
        let stats = ENGINE
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .map(|e| e.stats());
        if let Some(s) = stats {
            if s.active {
                return;
            }
            *ERROR.lock().unwrap_or_else(|e| e.into_inner()) =
                Some("WinDivert 工作线程已停止，请点击 WinDivert 重试".into());
            let _ = tokio::task::spawn_blocking(stop_blocking).await;
            return;
        }
    }
    if let Err(e) = tokio::task::spawn_blocking(start_blocking)
        .await
        .unwrap_or_else(|_| Err("独立接管启动任务失败".into()))
    {
        *ERROR.lock().unwrap_or_else(|e| e.into_inner()) = Some(e);
    }
}
#[tauri::command]
pub async fn set_process_capture(
    mode: AccessMode,
    expected_mode: AccessMode,
    confirmed: bool,
) -> Result<View, String> {
    let _lifecycle = crate::commands::process::LIFECYCLE.lock().await;
    if crate::shutdown::in_progress() {
        return Err("正在退出，不能切换接入方式".into());
    }
    if crate::function_mode::core_features_enabled() {
        return Err("请先切换为进程代理功能".into());
    }
    let previous = if SELECTED.load(Ordering::Acquire) {
        AccessMode::Windivert
    } else {
        AccessMode::AppProxy
    };
    validate(mode, expected_mode, previous, confirmed)?;
    if mode == AccessMode::Windivert {
        // Retry is explicit. On first activation a failed start cannot persist selection.
        let result = tokio::task::spawn_blocking(start_blocking)
            .await
            .map_err(|_| "接管启动任务失败")?;
        if let Err(error) = result {
            *ERROR.lock().unwrap_or_else(|e| e.into_inner()) = Some(error.clone());
            return Err(error);
        }
    }
    if let Err(error) = crate::storage::replace(
        &path(),
        &serde_json::to_vec_pretty(&Config { mode }).map_err(|_| "接入方式编码失败")?,
    ) {
        if previous == AccessMode::AppProxy {
            let _ = tokio::task::spawn_blocking(stop_blocking).await;
        }
        return Err(format!("接入方式保存失败，保留原选择：{error}"));
    }
    SELECTED.store(mode == AccessMode::Windivert, Ordering::Release);
    if mode == AccessMode::AppProxy {
        let _ = tokio::task::spawn_blocking(stop_blocking).await;
    }
    *ERROR.lock().unwrap_or_else(|e| e.into_inner()) = None;
    Ok(get_process_capture())
}
fn validate(
    mode: AccessMode,
    expected: AccessMode,
    actual: AccessMode,
    confirmed: bool,
) -> Result<(), String> {
    if expected != actual {
        return Err("接入方式已改变，请刷新后重试".into());
    }
    if mode != actual && !confirmed {
        return Err("切换会启停驱动与转发连接，请先确认".into());
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stale_and_unconfirmed_are_rejected() {
        assert!(validate(
            AccessMode::Windivert,
            AccessMode::AppProxy,
            AccessMode::AppProxy,
            false
        )
        .is_err());
        assert!(validate(
            AccessMode::AppProxy,
            AccessMode::AppProxy,
            AccessMode::Windivert,
            true
        )
        .is_err());
        assert!(validate(
            AccessMode::Windivert,
            AccessMode::Windivert,
            AccessMode::Windivert,
            true
        )
        .is_ok());
    }
}

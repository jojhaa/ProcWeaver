//! Keep the event loop and DNS core alive until network restoration completes.
use std::sync::atomic::{AtomicU8, Ordering};
use tauri::{Emitter, Manager};
static PHASE: AtomicU8 = AtomicU8::new(0); // idle, restoring, ready
pub(crate) fn ready() -> bool { PHASE.load(Ordering::Acquire) == 2 }
pub(crate) fn in_progress() -> bool { PHASE.load(Ordering::Acquire) != 0 }

async fn restore_before_stop(restore: impl std::future::Future<Output = Result<(), String>>, stop: impl FnOnce() -> Result<(), String>) -> Result<(), String> {
    restore.await?;
    stop()
}

pub(crate) fn request(app: &tauri::AppHandle, code: i32) {
    if PHASE.compare_exchange(0, 1, Ordering::AcqRel, Ordering::Acquire).is_err() { return; }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _lifecycle = crate::commands::process::LIFECYCLE.lock().await;
        let result = restore_before_stop(crate::commands::dns_adapter::restore_dns_guard(), || {
            // Restore the proxy before stopping its endpoint. Failure keeps the app alive.
            crate::commands::sysproxy::set_system_proxy_raw(false, None)?;
            let state = app.state::<crate::commands::process::CoreStateMutex>();
            let mut core = state.lock().map_err(|_| "读取核心状态失败")?;
            crate::commands::process::stop_owned_child_ex(&mut core, true)
        }).await;
        match result {
            Ok(()) => {
                crate::commands::process_watcher::stop_watcher_loop();
                crate::commands::health_probe::shutdown();
                PHASE.store(2, Ordering::Release);
                if code == tauri::RESTART_EXIT_CODE { app.request_restart(); } else { app.exit(code); }
            }
            Err(error) => {
                PHASE.store(0, Ordering::Release);
                crate::app_lifecycle::show(&app);
                let _ = app.emit("netbox-sysproxy-error", format!("退出尚未完成：{error}。程序和恢复记录已保留，请重试退出。"));
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn performance_waits_for_restore_and_never_stops_on_failure() {
        use std::{cell::Cell, rc::Rc};
        let stopped = Rc::new(Cell::new(false));
        let flag = stopped.clone();
        let mut task = Box::pin(restore_before_stop(std::future::pending(), move || { flag.set(true); Ok(()) }));
        assert!(tokio::time::timeout(std::time::Duration::from_millis(5), &mut task).await.is_err());
        assert!(!stopped.get());
        assert!(restore_before_stop(async { Err("DNS failure".into()) }, || { stopped.set(true); Ok(()) }).await.is_err());
        assert!(!stopped.get());
        restore_before_stop(async { Ok(()) }, || { stopped.set(true); Ok(()) }).await.unwrap();
        assert!(stopped.get());
    }
}

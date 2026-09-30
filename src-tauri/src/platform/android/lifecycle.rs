use tauri::Manager;

pub fn show(app: &tauri::AppHandle) { if let Some(window) = app.get_webview_window("main") { let _ = window.show(); } }
// Desktop callers share these hooks; Android exposes state through its foreground notification.
pub fn rebuild_tray_in_place(_: &tauri::AppHandle) {}
pub fn notify_sysproxy_changed(_: &tauri::AppHandle, _: bool) {}

#[tauri::command]
pub fn update_tray_menu() -> Result<(), String> { Err("Android 使用 VPN 通知管理连接".into()) }
#[tauri::command]
pub fn update_tray_traffic() -> Result<(), String> { Err("Android 没有桌面托盘".into()) }
#[tauri::command]
pub fn get_tray_payload() -> Option<serde_json::Value> { None }
#[tauri::command]
pub fn execute_tray_menu_action() -> Result<(), String> { Err("Android 没有桌面托盘".into()) }
#[tauri::command]
pub fn hide_tray_menu() -> Result<(), String> { Err("Android 没有桌面托盘".into()) }
#[tauri::command]
pub fn show_tray_menu() -> Result<(), String> { Err("Android 没有桌面托盘".into()) }

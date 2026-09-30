#[tauri::command]
pub fn window_minimize() -> Result<(), String> { Err("Android 请使用系统返回或主页按钮".into()) }
#[tauri::command]
pub fn window_start_dragging() -> Result<(), String> { Err("Android 不支持拖动桌面窗口".into()) }
#[tauri::command]
pub fn window_toggle_maximize() -> Result<bool, String> { Err("Android 不支持最大化桌面窗口".into()) }
#[tauri::command]
pub fn window_is_maximized() -> bool { false }
#[tauri::command]
pub fn window_close() -> Result<(), String> { Err("Android 请使用系统返回或主页按钮".into()) }
#[tauri::command]
pub fn window_monitor_visible() -> bool { true }

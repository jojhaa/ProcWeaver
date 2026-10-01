//! Fixed, coreless Windows host. Full-client network lifecycle and IPC are absent.
use crate::{commands, external_proxy, function_mode, process_capture};
use tauri::{Emitter, Manager};

#[tauri::command]
fn get_platform_capabilities() -> crate::platform::Capabilities {
    let mut c = crate::platform::capabilities_for(std::env::consts::OS, std::env::consts::ARCH);
    c.tun = false; c.smart_hybrid = false; c.system_proxy = false; c.dns_guard = false;
    c.process_watcher = false; c.core_modes.clear();
    c
}

pub fn run() {
    let context = tauri::generate_context!("tauri.process.conf.json");
    assert_eq!(context.config().identifier, "com.procweaver.process", "进程版应用身份配置错误");
    #[cfg(windows)]
    crate::windows_identity::initialize(&context.config().identifier).expect("设置进程版任务栏身份失败");
    let state = std::sync::Mutex::new(commands::process::CoreState {
        child: None, mixed_port: 0, controller_port: 0, active_core: None,
        active_core_path: None, core_mode: None, started_at: None,
    });
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _| {
            crate::app_lifecycle::show(app);
            commands::bundle_launch::dispatch(app, args);
        }))
        .plugin(tauri_plugin_opener::init())
        .manage(state)
        .setup(|app| {
            crate::storage::initialize_process(app.handle())?;
            function_mode::initialize();
            process_capture::initialize();
            tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App("process.html".into()))
                .title(crate::edition::NAME).inner_size(1200., 800.).min_inner_size(1000., 680.)
                .decorations(false).visible(false).center()
                .data_directory(crate::storage::data_dir().join("webview"))
                .icon(tauri::include_image!("icons/128x128.png"))?.build()?;
            let open = tauri::menu::MenuItem::with_id(app, "open", "打开进程版", true, None::<&str>)?;
            let quit = tauri::menu::MenuItem::with_id(app, "quit", "退出进程版", true, None::<&str>)?;
            let menu = tauri::menu::Menu::with_items(app, &[&open, &quit])?;
            tauri::tray::TrayIconBuilder::with_id("procweaver-process")
                .icon(tauri::include_image!("icons/32x32.png"))
                .tooltip(crate::edition::NAME).menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => crate::app_lifecycle::show(app),
                    "quit" => crate::shutdown::request(app, 0), _ => {}
                }).build(app)?;
            tauri::async_runtime::spawn(external_proxy::restore());
            let monitor = app.handle().clone();
            tauri::async_runtime::spawn(crate::routing_overrides::tracker::run(move |change| {
                let _ = monitor.emit("procweaver-processes-changed", change);
            }));
            tauri::async_runtime::spawn(async {
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                    let _lock = commands::process::LIFECYCLE.lock().await;
                    if crate::shutdown::in_progress() { break; }
                    process_capture::tick().await;
                }
            });
            commands::bundle_launch::dispatch(app.handle(), std::env::args().collect());
            if !commands::settings::get_general_settings().is_ok_and(|s| s.silent_start) {
                crate::app_lifecycle::show(app.handle());
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_platform_capabilities,
            function_mode::get_function_mode,
            function_mode::get_process_preferences, function_mode::save_process_preferences,
            process_capture::get_process_capture, process_capture::set_process_capture,
            external_proxy::get_external_proxy, external_proxy::save_external_proxy_settings,
            external_proxy::apply_external_bundles, external_proxy::test_external_proxy,
            crate::bundle_repository::read_bundle_repository_file,
            crate::bundle_repository::cancel_bundle_repository_request,
            commands::bundle_launch::launch_bundle_app, commands::bundle_launch::get_bundle_entry_states,
            commands::bundle_launch::take_bundle_launch_requests, commands::bundle_launch::choose_bundle_executable,
            commands::bundle_shortcuts::get_bundle_shortcuts, commands::bundle_shortcuts::change_bundle_shortcut,
            commands::routing_overrides::get_process_tree, commands::routing_overrides::choose_routing_executable,
            commands::window::window_minimize, commands::window::window_start_dragging,
            commands::window::window_toggle_maximize, commands::window::window_is_maximized,
            commands::window::window_close, commands::window::window_monitor_visible,
            commands::system::check_is_admin,
            crate::process_update::check_process_update, crate::process_update::download_process_update,
            commands::maintenance::restart_app,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if !crate::shutdown::ready() {
                    api.prevent_close();
                    if commands::settings::get_general_settings().is_ok_and(|s| s.minimize_on_close) && window.hide().is_ok() { return; }
                    crate::shutdown::request(window.app_handle(), 0);
                }
            }
        })
        .build(context).expect("启动 ProcWeaver Process 失败")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                if !crate::shutdown::ready() { api.prevent_exit(); crate::shutdown::request(app, code.unwrap_or(0)); }
            }
        });
}

pub mod commands;
pub mod storage;
pub mod local_nodes;
mod bundle_repository;
mod app_lifecycle;
#[cfg(windows)]
mod windows_identity;
mod shutdown;
pub mod routing_overrides;
pub mod capture;

use std::sync::Mutex;
use commands::process::{CoreState, CoreStateMutex};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = tauri::generate_context!();
    #[cfg(windows)]
    windows_identity::initialize(&context.config().identifier)
        .expect("无法设置 ProcWeaver 的 Windows 任务栏身份");
    let core_state: CoreStateMutex = Mutex::new(CoreState {
        child: None,
        mixed_port: 7890,
        controller_port: 9090,
        active_core: None,
        active_core_path: None,
        core_mode: None,
        started_at: None,
    });

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            app_lifecycle::show(app);
            commands::bundle_launch::dispatch(app, args);
        }))
        .plugin(tauri_plugin_opener::init())
        .manage(core_state)
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                window.set_icon(tauri::include_image!("icons/128x128.png"))?;
            }
            storage::initialize(app)?;
            commands::bundle_launch::dispatch(app.handle(), std::env::args().collect());
            commands::sysproxy::recover_stale_proxy().map_err(std::io::Error::other)?;
            let dns_app = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                commands::dns_adapter::auto_recover_dns_on_startup().await;
                use tauri::Emitter;
                let _ = dns_app.emit("procweaver-dns-guard-changed", ());
            });
            commands::process_watcher::init_watcher_on_startup();
            commands::local_rules::initialize()?;
            tauri::async_runtime::spawn(commands::geo::run_scheduler());
            tauri::async_runtime::spawn(commands::profile::run_profile_scheduler());
            tauri::async_runtime::spawn(routing_overrides::tracker::run());
            tauri::async_runtime::spawn(capture::run());
            tauri::async_runtime::spawn(capture::smart_arbiter::run_arbiter());
            app_lifecycle::setup(app)?;
            let preferences = commands::settings::get_general_settings();
            if preferences.as_ref().map_or(true, |s| !s.silent_start) { app_lifecycle::show(app.handle()); }
            if preferences.as_ref().is_ok_and(|s| s.auto_run) {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = commands::process::start_core(None, handle.state()).await {
                        eprintln!("自动运行核心失败：{error}");
                        app_lifecycle::show(&handle);
                    }
                });
            }
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                    if let Err(e) = commands::process::monitor_core(handle.state()).await {
                        eprintln!("内核监控失败：{e}");
                    }
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" && !shutdown::ready() {
                    api.prevent_close();
                    if commands::settings::get_general_settings().is_ok_and(|s| s.minimize_on_close) && window.hide().is_ok() { return; }
                    shutdown::request(window.app_handle(), 0);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            local_nodes::get_local_nodes,
            local_nodes::get_local_node,
            local_nodes::save_local_nodes,
            local_nodes::preview_local_nodes,
            bundle_repository::read_bundle_repository_file,
            bundle_repository::cancel_bundle_repository_request,
            commands::bundle_launch::launch_bundle_app,
            commands::bundle_launch::get_bundle_entry_states,
            commands::bundle_launch::take_bundle_launch_requests,
            commands::bundle_launch::choose_bundle_executable,
            commands::bundle_shortcuts::get_bundle_shortcuts,
            commands::bundle_shortcuts::change_bundle_shortcut,
            commands::routing_overrides::get_routing_overrides,
            commands::routing_overrides::save_routing_overrides,
            commands::routing_overrides::get_process_tree,
            commands::routing_overrides::choose_routing_executable,
            commands::routing_overrides::diagnose_routing_dns,
            commands::mihomo_api::get_traffic_snapshot,
            commands::local_rules::get_local_rule_plan,
            commands::exclusions::get_exclusions,
            commands::exclusions::save_exclusions,
            commands::local_rules::set_local_rule_plan_enabled,
            commands::ip_health::check_ip_health,
            commands::ip_health::wait_for_exit_connection,
            commands::process::get_cpu_info,
            commands::process::get_core_status,
            commands::process::start_core,
            commands::process::stop_core,
            commands::process::restart_core,
            commands::sysproxy::set_system_proxy,
            commands::sysproxy::get_system_proxy_status,
            commands::profile::list_profiles,
            commands::profile::add_profile,
            commands::profile::update_profile,
            commands::profile::select_profile,
            commands::profile_switch::preview_profile_switch,
            commands::profile::delete_profile,
            commands::profile::edit_profile_metadata,
            commands::profile::get_profile_content,
            commands::profile::save_profile_content,
            commands::profile::export_profile_file,
            commands::profile::add_external_rule_provider,
            commands::profile::remove_external_rule_provider,
            commands::mihomo_api::get_mihomo_proxies,
            commands::mihomo_api::switch_mihomo_proxy,
            commands::mihomo_api::test_mihomo_delay,
            commands::mihomo_api::get_mihomo_rules,
            commands::mihomo_api::set_mihomo_mode,
            commands::mihomo_api::get_mihomo_config,
            commands::mihomo_api::get_mihomo_rule_providers,
            commands::mihomo_api::update_mihomo_rule_provider,
            commands::mihomo_api::get_active_connections,
            commands::mihomo_api::close_connection,
            commands::mihomo_api::close_all_connections,
            commands::geo::get_geo_config,
            commands::geo::save_geo_config,
            commands::geo::sync_geo_resource,
            commands::geo::sync_all_geo_resources,
            commands::profile::get_smart_groups,
            commands::profile::save_smart_groups,
            commands::profile::get_business_channels,
            commands::profile::save_business_channels,
            commands::profile::sync_smart_groups_to_core,
            commands::settings::get_general_settings,
            commands::settings::save_general_settings,
            commands::settings::get_active_traffic_driver,
            commands::dns::get_dns_settings,
            commands::dns::save_dns_settings,
            commands::health_probe::begin_health_probe,
            commands::health_probe::probe_node_health,
            commands::health_probe::end_health_probe,
            commands::health_probe::get_health_cache,
            commands::health_probe::save_health_cache,
            commands::window::window_minimize,
            commands::window::window_start_dragging,
            commands::window::window_toggle_maximize,
            commands::window::window_is_maximized,
            commands::window::window_close,
            commands::unlock_probe::probe_unlock_matrix,
            commands::system::check_is_admin,
            commands::system::restart_elevated,
            commands::dns_adapter::toggle_dns_guard,
            commands::dns_adapter::get_dns_guard_status,
            commands::dns_adapter::run_network_emergency_repair,
            commands::app_launcher::launch_preset_app,
            commands::shortcut_manager::get_shortcut_status,
            commands::shortcut_manager::patch_existing_shortcut,
            commands::shortcut_manager::restore_existing_shortcut,
            commands::shortcut_manager::create_dedicated_shortcut,
            commands::shortcut_manager::get_app_shortcut_status,
            commands::shortcut_manager::patch_app_shortcut,
            commands::shortcut_manager::restore_app_shortcut,
            commands::shortcut_manager::create_dedicated_app_shortcut,
            commands::process_watcher::toggle_process_watcher,
            commands::process_watcher::get_process_watcher_status,
            commands::process_watcher::get_watcher_mode,
            commands::process_watcher::set_watcher_mode,
            commands::maintenance::check_app_update,
            commands::maintenance::download_app_update,
            commands::maintenance::install_app_update,
            commands::maintenance::restart_app,
            commands::maintenance::get_mihomo_core_detail,
            commands::maintenance::check_mihomo_update,
            commands::maintenance::check_rules_repo_update,
            commands::maintenance::check_core_rules_update,
            commands::maintenance::download_core_rules_update,
            app_lifecycle::update_tray_menu,
            app_lifecycle::update_tray_traffic,
            commands::window::window_monitor_visible,
            app_lifecycle::get_tray_payload,
            app_lifecycle::execute_tray_menu_action,
            app_lifecycle::hide_tray_menu,
            app_lifecycle::show_tray_menu,
        ])
        .on_window_event(|window, event| {
            if window.label() == "tray-menu" {
                if let tauri::WindowEvent::Focused(false) = event {
                    let _ = window.hide();
                }
            }
        })
        .build(context)
        .expect("error while running tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                if !shutdown::ready() {
                    api.prevent_exit();
                    shutdown::request(app_handle, code.unwrap_or(0));
                }
            }
        });
}

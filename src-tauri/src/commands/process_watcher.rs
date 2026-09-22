use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

static WATCHER_ACTIVE: AtomicBool = AtomicBool::new(false);
static CURRENT_MODE: Mutex<WatcherMode> = Mutex::new(WatcherMode::AutoRelaunch);
static HANDLED_PIDS: Mutex<Option<HashSet<u32>>> = Mutex::new(None);
static LAST_HANDLED_APP: Mutex<Option<HashMap<String, Instant>>> = Mutex::new(None);
static TRIGGER_HISTORY: Mutex<Option<HashMap<String, Vec<Instant>>>> = Mutex::new(None);
static APP_HANDLE: Mutex<Option<tauri::AppHandle>> = Mutex::new(None);

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WatcherMode {
    /// 模式 A: ⚡ 自动热替换接管（带四道铁锁）
    AutoRelaunch,
    /// 模式 B: 🔔 温和气泡提示（绝不强杀）
    NotifyOnly,
    /// 模式 C: ⚪ 完全关闭
    Disabled,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct WatcherConfig {
    pub mode: WatcherMode,
    #[serde(default)]
    pub enabled: bool,
}

#[derive(Serialize, Clone, Debug)]
pub struct BareProcessDetectedPayload {
    pub app_id: String,
    pub display_name: String,
    pub pid: u32,
    pub is_browser: bool,
    pub message: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct AutoRelaunchedPayload {
    pub app_id: String,
    pub display_name: String,
    pub pid: u32,
    pub message: String,
}

struct MonitoredAppDef {
    process_name: &'static str,
    preset_id: &'static str,
    display_name: &'static str,
    is_browser: bool,
}

const MONITORED_APPS: &[MonitoredAppDef] = &[
    MonitoredAppDef {
        process_name: "ChatGPT.exe",
        preset_id: "chatgpt",
        display_name: "ChatGPT",
        is_browser: false,
    },
    MonitoredAppDef {
        process_name: "Claude.exe",
        preset_id: "claude",
        display_name: "Claude",
        is_browser: false,
    },
    MonitoredAppDef {
        process_name: "Cursor.exe",
        preset_id: "cursor",
        display_name: "Cursor",
        is_browser: false,
    },
    MonitoredAppDef {
        process_name: "Code.exe",
        preset_id: "vscode",
        display_name: "VS Code",
        is_browser: false,
    },
    MonitoredAppDef {
        process_name: "Discord.exe",
        preset_id: "discord",
        display_name: "Discord",
        is_browser: false,
    },
    MonitoredAppDef {
        process_name: "Antigravity.exe",
        preset_id: "antigravity",
        display_name: "Antigravity",
        is_browser: false,
    },
    MonitoredAppDef {
        process_name: "antigravity.exe",
        preset_id: "antigravity",
        display_name: "Antigravity",
        is_browser: false,
    },
    MonitoredAppDef {
        process_name: "Antigravity IDE.exe",
        preset_id: "antigravity-ide",
        display_name: "Antigravity IDE",
        is_browser: false,
    },
    MonitoredAppDef {
        process_name: "antigravity-ide.exe",
        preset_id: "antigravity-ide",
        display_name: "Antigravity IDE",
        is_browser: false,
    },
    // 普通浏览器：仅作为常规应用，绝不强制杀进程
    MonitoredAppDef {
        process_name: "chrome.exe",
        preset_id: "chrome",
        display_name: "Google Chrome",
        is_browser: true,
    },
    MonitoredAppDef {
        process_name: "msedge.exe",
        preset_id: "edge",
        display_name: "Microsoft Edge",
        is_browser: true,
    },
    MonitoredAppDef {
        process_name: "brave.exe",
        preset_id: "brave",
        display_name: "Brave",
        is_browser: true,
    },
];

fn config_path() -> PathBuf {
    crate::storage::data_dir().join("config/process-watcher.json")
}

pub fn set_app_handle(handle: tauri::AppHandle) {
    if let Ok(mut guard) = APP_HANDLE.lock() {
        *guard = Some(handle);
    }
}

pub fn load_watcher_config() -> WatcherConfig {
    let path = config_path();
    if let Ok(bytes) = std::fs::read(&path) {
        if let Ok(cfg) = serde_json::from_slice::<WatcherConfig>(&bytes) {
            return cfg;
        }
        // 兼容只存 enabled 的旧配置
        if let Ok(old_val) = serde_json::from_slice::<serde_json::Value>(&bytes) {
            let enabled = old_val.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false);
            return WatcherConfig {
                mode: if enabled { WatcherMode::AutoRelaunch } else { WatcherMode::Disabled },
                enabled,
            };
        }
    }
    WatcherConfig {
        mode: WatcherMode::Disabled,
        enabled: false,
    }
}

pub fn save_watcher_config(cfg: &WatcherConfig) {
    let path = config_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(path, serde_json::to_vec_pretty(cfg).unwrap_or_default());
}

/// 执行静默命令行
fn run_hidden(program: &str, args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new(program);
    cmd.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let output = cmd.output().map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// 扫描系统中是否有裸跑（无代理参数）启动的应用进程
fn scan_and_handle_bare_processes() {
    #[cfg(windows)]
    {
        let mode = match CURRENT_MODE.lock() {
            Ok(g) => *g,
            Err(_) => return,
        };

        if mode == WatcherMode::Disabled {
            return;
        }

        // 构建单条高效 WMI 联合查询，一次性扫描所有受监控进程
        // 例如: name = 'ChatGPT.exe' or name = 'Claude.exe' or ...
        let filters: Vec<String> = MONITORED_APPS
            .iter()
            .map(|a| format!("name = '{}'", a.process_name))
            .collect();
        let filter_expr = filters.join(" or ");
        let ps_cmd = format!(
            "Get-CimInstance Win32_Process -Filter \"{}\" | Select-Object ProcessId, Name, CommandLine | ConvertTo-Json -Compress",
            filter_expr
        );

        let out = match run_hidden("powershell", &["-NoProfile", "-NonInteractive", "-Command", &ps_cmd]) {
            Ok(s) => s.trim().to_string(),
            Err(_) => return,
        };

        if out.is_empty() || out == "null" {
            return;
        }

        let items: Vec<serde_json::Value> = if out.starts_with('[') {
            serde_json::from_str(&out).unwrap_or_default()
        } else if let Ok(single) = serde_json::from_str::<serde_json::Value>(&out) {
            vec![single]
        } else {
            Vec::new()
        };

        let now = Instant::now();
        // Business bundles own their stable entry and explicit restart confirmation.
        // The legacy watcher must never restart them through the public mixed port.
        let bundle_names: Vec<String> = crate::routing_overrides::read().map(|c| c.bundles.into_iter()
            .map(|b| std::path::Path::new(&b.main_exe).file_name().unwrap_or_default().to_string_lossy().to_lowercase()).collect()).unwrap_or_default();

        for item in items {
            let pid = match item.get("ProcessId").and_then(|p| p.as_u64()).map(|p| p as u32) {
                Some(p) => p,
                None => continue,
            };
            let proc_name = item.get("Name").and_then(|n| n.as_str()).unwrap_or("");
            if bundle_names.iter().any(|name| name.eq_ignore_ascii_case(proc_name)) { continue; }
            let cmd = item.get("CommandLine").and_then(|c| c.as_str()).unwrap_or("");

            // 【第一道铁锁】：严格过滤 Chromium/Electron 内部辅助子进程
            // 带有 --type=crashpad-handler、--type=gpu-process、--type=renderer、--type=utility 的进程坚决不碰！
            if cmd.contains("--type=") {
                continue;
            }

            // 【第二道铁锁】：空命令行保护
            // 若由于沙盒限制或系统权限读不到命令行，坚决不盲杀！
            if cmd.trim().is_empty() {
                continue;
            }

            // 如果已有代理参数，说明已经成功接入加速通道，放行
            if cmd.contains("--proxy-server") {
                continue;
            }

            // 匹配属于哪一个纳管应用
            let app_def = match MONITORED_APPS.iter().find(|a| a.process_name.eq_ignore_ascii_case(proc_name)) {
                Some(a) => a,
                None => continue,
            };

            // 检查墓碑 PID：已处理过的 PID 绝不重复触发
            {
                let mut pids_lock = match HANDLED_PIDS.lock() {
                    Ok(g) => g,
                    Err(_) => continue,
                };
                let set = pids_lock.get_or_insert_with(HashSet::new);
                if set.contains(&pid) {
                    continue;
                }
                set.insert(pid);
            }

            // 【第三道铁锁】：30 秒强制冷却防抖窗口（单应用独立）
            {
                let mut last_lock = match LAST_HANDLED_APP.lock() {
                    Ok(g) => g,
                    Err(_) => continue,
                };
                let map = last_lock.get_or_insert_with(HashMap::new);
                if let Some(last_time) = map.get(app_def.preset_id) {
                    if now.duration_since(*last_time) < Duration::from_secs(30) {
                        continue; // 处于 30 秒冷却防抖期内，跳过
                    }
                }
                map.insert(app_def.preset_id.to_string(), now);
            }

            // 【第四道铁锁】：1 分钟 2 次自动熔断保险丝
            {
                let mut history_lock = match TRIGGER_HISTORY.lock() {
                    Ok(g) => g,
                    Err(_) => continue,
                };
                let map = history_lock.get_or_insert_with(HashMap::new);
                let list = map.entry(app_def.preset_id.to_string()).or_default();
                // 剔除 60 秒之前的历史记录
                list.retain(|t| now.duration_since(*t) < Duration::from_secs(60));
                list.push(now);

                if list.len() >= 3 {
                    // 1 分钟内触发达 3 次以上，判定存在反复启动异常，触发保险丝熔断！
                    if let Ok(guard) = APP_HANDLE.lock() {
                        if let Some(app) = guard.as_ref() {
                            use tauri::Emitter;
                            let _ = app.emit("watcher-circuit-breaker-tripped", format!(
                                "⚠️ 守护熔断：检测到「{}」在 1 分钟内频繁重启，已自动暂停该应用的智能干预以防卡死",
                                app_def.display_name
                            ));
                        }
                    }
                    continue;
                }
            }

            // 执行策略动作
            // 普通浏览器（Chrome, Edge, Brave）：由于用户可能正在浏览日常网页，绝不自动强杀！直接走温和提示
            if app_def.is_browser || mode == WatcherMode::NotifyOnly {
                // 模式 B（温和气泡提示）
                if let Ok(guard) = APP_HANDLE.lock() {
                    if let Some(app) = guard.as_ref() {
                        use tauri::Emitter;
                        let payload = BareProcessDetectedPayload {
                            app_id: app_def.preset_id.to_string(),
                            display_name: app_def.display_name.to_string(),
                            pid,
                            is_browser: app_def.is_browser,
                            message: format!(
                                "检测到「{}」正在直连裸跑（PID: {}），建议通过专属加速通道启动以防网络受阻",
                                app_def.display_name, pid
                            ),
                        };
                        let _ = app.emit("watcher-bare-process-detected", payload);
                    }
                }
            } else if mode == WatcherMode::AutoRelaunch {
                // 模式 A（自动热替换接管）
                // 1. 结束裸跑主进程
                let _ = run_hidden("taskkill", &["/F", "/PID", &pid.to_string()]);

                // 2. 稍作延时等待文件句柄释放
                std::thread::sleep(Duration::from_millis(250));

                // 3. 重新以专属代理通道唤起
                let launch_res = crate::commands::app_launcher::launch_preset_app(app_def.preset_id.to_string());
                match launch_res {
                    Ok(_) => {
                        // 4. 真正拉起成功后才发送自愈通知 (A10: 启动失败绝不通知成功)
                        if let Ok(guard) = APP_HANDLE.lock() {
                            if let Some(app) = guard.as_ref() {
                                use tauri::Emitter;
                                let payload = AutoRelaunchedPayload {
                                    app_id: app_def.preset_id.to_string(),
                                    display_name: app_def.display_name.to_string(),
                                    pid,
                                    message: format!(
                                        "⚡ 智能自愈：「{}」裸跑实例已被接管，已注入代理通道重新拉起",
                                        app_def.display_name
                                    ),
                                };
                                let _ = app.emit("watcher-auto-relaunched", payload);
                            }
                        }
                    }
                    Err(err) => {
                        eprintln!("[ProcessWatcher] 重新拉起应用失败: {}", err);
                        if let Ok(guard) = APP_HANDLE.lock() {
                            if let Some(app) = guard.as_ref() {
                                use tauri::Emitter;
                                let _ = app.emit("watcher-launch-failed", format!(
                                    "⚠️ 智能自愈失败：无法重新拉起「{}」({})",
                                    app_def.display_name, err
                                ));
                            }
                        }
                    }
                }
            }
        }
    }
}

/// 启动后台守护任务循环
pub fn start_watcher_loop() {
    if WATCHER_ACTIVE.swap(true, Ordering::SeqCst) {
        return; // 已经运行中
    }

    tauri::async_runtime::spawn(async move {
        while WATCHER_ACTIVE.load(Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_millis(2000)).await;
            if !WATCHER_ACTIVE.load(Ordering::SeqCst) {
                break;
            }

            // 在阻塞线程执行轻量批量扫描
            tokio::task::spawn_blocking(scan_and_handle_bare_processes).await.ok();
        }
    });
}

pub fn stop_watcher_loop() {
    WATCHER_ACTIVE.store(false, Ordering::SeqCst);
}

/// 初始化开机/启动自愈状态
pub fn init_watcher_on_startup() {
    let cfg = load_watcher_config();
    if let Ok(mut g) = CURRENT_MODE.lock() {
        *g = cfg.mode;
    }
    if cfg.mode != WatcherMode::Disabled {
        start_watcher_loop();
    }
}

#[tauri::command]
pub fn get_watcher_mode() -> Result<WatcherMode, String> {
    let guard = CURRENT_MODE.lock().map_err(|e| e.to_string())?;
    Ok(*guard)
}

#[tauri::command]
pub fn set_watcher_mode(mode: WatcherMode) -> Result<WatcherMode, String> {
    if let Ok(mut g) = CURRENT_MODE.lock() {
        *g = mode;
    }
    let enabled = mode != WatcherMode::Disabled;
    save_watcher_config(&WatcherConfig { mode, enabled });

    if enabled {
        start_watcher_loop();
    } else {
        stop_watcher_loop();
    }
    Ok(mode)
}

#[tauri::command]
pub fn toggle_process_watcher(enable: bool) -> Result<bool, String> {
    let mode = if enable {
        WatcherMode::AutoRelaunch
    } else {
        WatcherMode::Disabled
    };
    let _ = set_watcher_mode(mode)?;
    Ok(enable)
}

#[tauri::command]
pub fn get_process_watcher_status() -> Result<bool, String> {
    Ok(WATCHER_ACTIVE.load(Ordering::SeqCst))
}

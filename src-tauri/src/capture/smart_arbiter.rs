use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

/// 智能双模式下，当前是否因为感知到高阶游戏/特殊协议进程而临时升维至 TUN
static TUN_ESCALATED: AtomicBool = AtomicBool::new(false);
/// 记录最后一次感知到目标高阶进程的时间戳 (秒)
static LAST_GAME_SEEN: Mutex<Option<u64>> = Mutex::new(None);

/// 预设需要原生 UDP / 低延迟虚拟网卡通道的高阶外服游戏与特殊应用
const ESCALATION_GAMES: &[&str] = &[
    "cs2.exe",
    "valorant.exe",
    "apex.exe",
    "r5apex.exe",
    "dota2.exe",
    "overwatch.exe",
    "pubg.exe",
    "destiny2.exe",
    "rainbowsix.exe",
    "leagueclient.exe",
    "gta5.exe",
    "battlefield2042.exe",
];

/// 查询当前是否处于 TUN 临时升维态
pub fn is_tun_escalated() -> bool {
    TUN_ESCALATED.load(Ordering::SeqCst)
}

/// 手动或由仲裁器设置 TUN 临时升维态
pub fn set_tun_escalated(val: bool) {
    TUN_ESCALATED.store(val, Ordering::SeqCst);
}

/// 获取当前系统物理上正在生效的接管驱动类型
/// 返回: "app_proxy" | "tun"
pub fn get_active_driver_name() -> String {
    let settings = crate::commands::settings::get_general_settings().unwrap_or_default();
    match settings.traffic_mode.as_str() {
        "tun" => "tun".to_string(),
        "smart_hybrid" => {
            if is_tun_escalated() {
                "tun".to_string()
            } else {
                "app_proxy".to_string()
            }
        }
        _ => "app_proxy".to_string(),
    }
}

async fn set_mihomo_tun(enable: bool) -> bool {
    if let Ok(settings) = crate::commands::settings::get_general_settings() {
        let port = settings.controller_port;
        let client = crate::commands::mihomo_api::controller_client()
            .timeout(std::time::Duration::from_secs(2))
            .build();
        if let Ok(c) = client {
            let body = serde_json::json!({
                "tun": {
                    "enable": enable
                }
            });
            match c.patch(format!("http://127.0.0.1:{port}/configs")).json(&body).send().await {
                Ok(resp) if resp.status().is_success() => return true,
                Ok(resp) => {
                    eprintln!("[SmartArbiter] 切换 TUN 模式失败，核心返回状态码: {}", resp.status());
                }
                Err(e) => {
                    eprintln!("[SmartArbiter] 切换 TUN 模式网络通信错误: {}", e);
                }
            }
        }
    }
    false
}

/// 智能双模式后台仲裁器主循环
pub async fn run_arbiter() {
    loop {
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;

        let settings = match crate::commands::settings::get_general_settings() {
            Ok(s) => s,
            Err(_) => continue,
        };

        // 仅在配置为智能双模式 (smart_hybrid) 时执行动态仲裁
        if settings.traffic_mode != "smart_hybrid" {
            if TUN_ESCALATED.load(Ordering::SeqCst) {
                if settings.traffic_mode != "tun" {
                    let _ = set_mihomo_tun(false).await;
                }
                TUN_ESCALATED.store(false, Ordering::SeqCst);
            }
            continue;
        }

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        // 获取系统当前活跃进程快照
        // Arbitration needs executable names only; do not open every process or read paths.
        let tracker_processes = tokio::task::spawn_blocking(crate::routing_overrides::native::process_list)
            .await.ok().and_then(Result::ok).unwrap_or_default();
        let mut game_found = false;

        // 收集所有需要升维的目标游戏名（包括预设高阶游戏与用户在游戏业务通道中自定义的进程）
        let mut custom_game_procs = Vec::new();
        if let Ok(channels) = crate::commands::profile::get_business_channels() {
            for ch in channels {
                if ch.id == "game" {
                    for p in &ch.custom_processes {
                        custom_game_procs.push(p.to_lowercase());
                    }
                }
            }
        }

        for p in &tracker_processes {
            let name_lower = p.name.to_lowercase();
            if ESCALATION_GAMES.iter().any(|&g| g == name_lower)
                || custom_game_procs.iter().any(|g| g == &name_lower)
            {
                game_found = true;
                break;
            }
        }

        if game_found {
            if let Ok(mut last) = LAST_GAME_SEEN.lock() {
                *last = Some(now);
            }
            if !TUN_ESCALATED.load(Ordering::SeqCst) {
                eprintln!("[SmartArbiter] 检测到高阶游戏启动，智能双模式尝试升维至 TUN 虚拟网卡接管...");
                if set_mihomo_tun(true).await {
                    eprintln!("[SmartArbiter] TUN 升维成功！");
                    TUN_ESCALATED.store(true, Ordering::SeqCst);
                } else {
                    eprintln!("[SmartArbiter] TUN 升维失败，保持原接管模式。");
                }
            }
        } else {
            // 当游戏退出后，保持 30 秒缓冲期，再降级回 WinDivert 极简态
            let should_downgrade = {
                if let Ok(last) = LAST_GAME_SEEN.lock() {
                    match *last {
                        Some(t) => now.saturating_sub(t) > 30,
                        None => true,
                    }
                } else {
                    false
                }
            };

            if should_downgrade && TUN_ESCALATED.load(Ordering::SeqCst) {
                eprintln!("[SmartArbiter] 游戏进程已退出，智能双模式平滑归位至 WinDivert 极简巡航态...");
                if set_mihomo_tun(false).await {
                    TUN_ESCALATED.store(false, Ordering::SeqCst);
                }
            }
        }
    }
}

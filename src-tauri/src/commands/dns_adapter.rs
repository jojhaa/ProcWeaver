use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

static ADAPTER_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct DnsAdapterRecovery {
    pub interface_alias: String,
    pub was_dhcp: bool,
    pub static_dns: Vec<String>,
}

fn recovery_path() -> PathBuf {
    crate::storage::data_dir().join("config/dns-adapter-recovery.json")
}

/// 执行隐藏窗口的异步命令行工具，具备有界超时防护 (C01)
#[cfg(windows)]
async fn run_hidden_cmd_async(program: &str, args: &[&str], timeout_secs: u64) -> Result<String, String> {
    let mut cmd = tokio::process::Command::new(program);
    cmd.args(args);
    cmd.creation_flags(CREATE_NO_WINDOW);

    let output_future = cmd.output();
    let res = tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), output_future)
        .await
        .map_err(|_| format!("执行命令 [{}] 超时 ({}秒)，已终止等待", program, timeout_secs))?
        .map_err(|e| format!("执行命令 [{}] 失败: {}", program, e))?;

    let stdout = String::from_utf8_lossy(&res.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&res.stderr).trim().to_string();
    if !res.status.success() && !stderr.is_empty() {
        return Err(format!("命令 [{}] 执行返回错误: {}", program, stderr));
    }
    Ok(stdout)
}

#[cfg(not(windows))]
async fn run_hidden_cmd_async(_program: &str, _args: &[&str], _timeout_secs: u64) -> Result<String, String> {
    Ok(String::new())
}

/// 异步获取当前连接互联网的主要网络适配器名称（如 "以太网" 或 "WLAN"）
pub async fn get_active_interface_alias() -> Result<String, String> {
    #[cfg(windows)]
    {
        let ps_cmd = "Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -ne $null } | Select-Object -ExpandProperty InterfaceAlias";
        if let Ok(out) = run_hidden_cmd_async("powershell", &["-NoProfile", "-NonInteractive", "-Command", ps_cmd], 5).await {
            for line in out.lines() {
                let trimmed = line.trim();
                if !trimmed.is_empty() {
                    return Ok(trimmed.to_string());
                }
            }
        }
        // 若 PowerShell 未获取到，尝试使用 netsh 获取首个处于已连接状态的接口
        let netsh_out = run_hidden_cmd_async("netsh", &["interface", "ipv4", "show", "interfaces"], 4).await?;
        for line in netsh_out.lines() {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() >= 5 && parts[1] == "connected" {
                return Ok(parts[4..].join(" "));
            }
        }
        Err("未找到活跃的上网网卡接口".into())
    }
    #[cfg(not(windows))]
    {
        Err("仅支持 Windows 系统".into())
    }
}

/// 异步获取指定网卡当前配置的 DNS 信息
pub async fn get_interface_dns_info(alias: &str) -> Result<(bool, Vec<String>), String> {
    #[cfg(windows)]
    {
        let ps_cmd = format!(
            "(Get-DnsClientServerAddress -InterfaceAlias '{}' -AddressFamily IPv4).ServerAddresses",
            alias.replace('\'', "''")
        );
        let servers = match run_hidden_cmd_async("powershell", &["-NoProfile", "-NonInteractive", "-Command", &ps_cmd], 5).await {
            Ok(out) => out
                .lines()
                .map(|l| l.trim().to_string())
                .filter(|s| !s.is_empty() && s.contains('.'))
                .collect(),
            Err(_) => Vec::new(),
        };

        // 查看 netsh 确认是否为 DHCP
        let netsh_out = run_hidden_cmd_async("netsh", &["interface", "ipv4", "show", "dnsservers", &format!("name={}", alias)], 4)
            .await
            .unwrap_or_default();
        let was_dhcp = netsh_out.contains("DHCP") || servers.is_empty();

        Ok((was_dhcp, servers))
    }
    #[cfg(not(windows))]
    {
        let _ = alias;
        Ok((true, Vec::new()))
    }
}

/// 检查本地 DNS 53 服务就绪状态 (C03: 防范核心未启动或未监听 53 端口导致断网)
pub async fn check_dns_service_ready() -> Result<(), String> {
    let is_running = crate::commands::process::ACTIVE.load(std::sync::atomic::Ordering::SeqCst);
    if !is_running {
        return Err("Mihomo 核心当前未运行，无法启用 DNS 护航。请先启动核心。".into());
    }

    // 探测 127.0.0.1:53 是否开放并响应
    // 构造基础 DNS 查询包探测 localhost
    let socket = tokio::net::UdpSocket::bind("127.0.0.1:0").await.map_err(|e| format!("绑定测试 UDP 端口失败: {}", e))?;
    let probe_query = [
        0x12, 0x34, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x09, b'l', b'o', b'c',
        b'a', b'l', b'h', b'o', b's', b't', 0x00, 0x00,
        0x01, 0x00, 0x01
    ];
    let _ = socket.send_to(&probe_query, "127.0.0.1:53").await;
    let mut buf = [0u8; 512];
    let udp_recv = tokio::time::timeout(std::time::Duration::from_millis(500), socket.recv_from(&mut buf)).await;

    if udp_recv.is_err() {
        // UDP 未快速响应，进一步探测 TCP 53 端口是否可连接
        let tcp_probe = tokio::time::timeout(
            std::time::Duration::from_millis(500),
            tokio::net::TcpStream::connect("127.0.0.1:53")
        ).await;

        if tcp_probe.is_err() || tcp_probe.unwrap().is_err() {
            return Err("未检测到 127.0.0.1:53 的 DNS 服务响应。Windows 系统 DNS 仅支持 53 端口，若核心使用 1053 等自定义端口或 53 端口被占用，请在 DNS 设置中检查配置。".into());
        }
    }

    Ok(())
}

/// 启用本地 DNS 护航（将网卡首选 DNS 指向 127.0.0.1）
pub async fn enable_dns_guard() -> Result<(), String> {
    #[cfg(windows)]
    {
        let _guard = ADAPTER_LOCK.lock().await;

        // C03: 严格校验本地 DNS 服务就绪后再修改系统网卡
        check_dns_service_ready().await?;

        let alias = get_active_interface_alias().await?;
        let (was_dhcp, static_dns) = get_interface_dns_info(&alias).await?;

        // 如果已经是指向 127.0.0.1，说明已处于护航状态
        if static_dns.first().map(|s| s.as_str()) == Some("127.0.0.1") {
            return Ok(());
        }

        let record = DnsAdapterRecovery {
            interface_alias: alias.clone(),
            was_dhcp,
            static_dns: static_dns.clone(),
        };

        // 保存恢复快照凭证
        let path = recovery_path();
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let json = serde_json::to_vec_pretty(&record).map_err(|e| e.to_string())?;
        crate::storage::replace(&path, &json)?;

        // 将网卡首选 DNS 设为 127.0.0.1 (带超时防护)
        let set_res = run_hidden_cmd_async(
            "netsh",
            &["interface", "ipv4", "set", "dnsservers", &format!("name={}", alias), "static", "127.0.0.1", "primary"],
            5
        ).await;

        if let Err(e) = set_res {
            // 设置失败，尝试清除恢复记录并报错
            let _ = std::fs::remove_file(&path);
            return Err(format!("修改网卡 DNS 失败: {}", e));
        }

        // 刷新系统 DNS 解析缓存
        let _ = run_hidden_cmd_async("ipconfig", &["/flushdns"], 4).await;

        // 回读核验修改结果
        if let Ok((_, current_dns)) = get_interface_dns_info(&alias).await {
            if current_dns.first().map(|s| s.as_str()) != Some("127.0.0.1") {
                eprintln!("[DnsAdapter] 警告: 修改网卡 DNS 后回读未立即生效，可能受外部安全软件拦截");
            }
        }

        Ok(())
    }
    #[cfg(not(windows))]
    {
        Ok(())
    }
}

/// 恢复网卡原始 DNS 配置 (C04: 验证恢复成功后再删除快照文件)
pub async fn restore_dns_guard() -> Result<(), String> {
    #[cfg(windows)]
    {
        let _guard = ADAPTER_LOCK.lock().await;
        let path = recovery_path();
        if !path.exists() {
            return Ok(());
        }

        let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
        let record: DnsAdapterRecovery = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;

        let alias = &record.interface_alias;
        let restore_res = if record.was_dhcp || record.static_dns.is_empty() {
            run_hidden_cmd_async(
                "netsh",
                &["interface", "ipv4", "set", "dnsservers", &format!("name={}", alias), "source=dhcp"],
                5
            ).await
        } else {
            let primary = &record.static_dns[0];
            let prim_res = run_hidden_cmd_async(
                "netsh",
                &["interface", "ipv4", "set", "dnsservers", &format!("name={}", alias), "static", primary, "primary"],
                5
            ).await;
            if prim_res.is_ok() {
                for (idx, secondary) in record.static_dns.iter().skip(1).enumerate() {
                    let index_arg = format!("index={}", idx + 2);
                    let _ = run_hidden_cmd_async(
                        "netsh",
                        &["interface", "ipv4", "add", "dnsservers", &format!("name={}", alias), secondary, &index_arg],
                        4
                    ).await;
                }
            }
            prim_res
        };

        if let Err(e) = restore_res {
            return Err(format!("恢复网卡 DNS 失败: {}；已保留恢复记录以备重试", e));
        }

        let _ = run_hidden_cmd_async("ipconfig", &["/flushdns"], 4).await;

        // 回读核验：确认首选 DNS 不再是 127.0.0.1 后，才安全删除凭据文件
        if let Ok((_, current_servers)) = get_interface_dns_info(alias).await {
            if current_servers.first().map(|s| s.as_str()) == Some("127.0.0.1") {
                return Err("已尝试恢复 DNS，但回读网卡仍为 127.0.0.1，保留恢复凭证以便再次恢复".into());
            }
        }

        let _ = std::fs::remove_file(&path);
        Ok(())
    }
    #[cfg(not(windows))]
    {
        Ok(())
    }
}

/// 冷启动断网自愈检查 (C05: 异步执行，不阻塞 UI 启动)
pub async fn auto_recover_dns_on_startup() {
    #[cfg(windows)]
    {
        let path = recovery_path();
        if path.exists() {
            eprintln!("[DnsAdapter] 检测到上次未恢复的 DNS 护航快照，正在后台执行网络自愈恢复...");
            if let Err(e) = restore_dns_guard().await {
                eprintln!("[DnsAdapter] 启动自动恢复 DNS 失败: {}", e);
            } else {
                eprintln!("[DnsAdapter] 启动自动恢复 DNS 成功！");
            }
        }
    }
}

/// 一键网络急救：强制重置主要网卡 DNS 为 DHCP，并清理系统代理
pub async fn emergency_repair_network() -> Result<String, String> {
    #[cfg(windows)]
    {
        let _guard = ADAPTER_LOCK.lock().await;

        // 1. 强制重置系统代理
        let _ = super::sysproxy::reset_system_proxy_emergency();

        // 2. 尝试将主要网卡复位为 DHCP
        if let Ok(alias) = get_active_interface_alias().await {
            let _ = run_hidden_cmd_async(
                "netsh",
                &["interface", "ipv4", "set", "dnsservers", &format!("name={}", alias), "source=dhcp"],
                5
            ).await;
        }

        // 3. 清理 recovery 凭据
        let path = recovery_path();
        if path.exists() {
            let _ = std::fs::remove_file(&path);
        }

        // 4. 刷新 DNS 缓存
        let _ = run_hidden_cmd_async("ipconfig", &["/flushdns"], 4).await;

        Ok("网络急救完成：已将网卡 DNS 恢复为自动获取 (DHCP)，并清除系统代理。".into())
    }
    #[cfg(not(windows))]
    {
        Ok("当前系统无需急救".into())
    }
}

#[tauri::command]
pub async fn toggle_dns_guard(enable: bool) -> Result<bool, String> {
    if enable {
        enable_dns_guard().await?;
        Ok(true)
    } else {
        restore_dns_guard().await?;
        Ok(false)
    }
}

#[tauri::command]
pub fn get_dns_guard_status() -> Result<bool, String> {
    let path = recovery_path();
    Ok(path.exists())
}

#[tauri::command]
pub async fn run_network_emergency_repair() -> Result<String, String> {
    emergency_repair_network().await
}

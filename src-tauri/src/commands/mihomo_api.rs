use serde_json::Value;
mod monitor;
pub(crate) fn invalidate_monitor_types() { monitor::invalidate(); }

fn is_proxy_connection(leaf: &str, kind: &str) -> bool {
    !leaf.is_empty() && !kind.is_empty()
        && !matches!(kind.to_ascii_lowercase().as_str(), "direct" | "reject" | "rejectdrop" | "pass" | "compatible")
        && !matches!(leaf, "DIRECT" | "REJECT" | "REJECT-DROP")
}

#[tauri::command]
pub async fn get_traffic_snapshot(state: tauri::State<'_, super::process::CoreStateMutex>, include_connections: Option<bool>) -> Result<Value, String> {
    monitor::snapshot(&state, include_connections.unwrap_or(false)).await
}

/// 本地控制接口必须直连，避免系统代理形成回环或返回代理网关错误。
pub(crate) fn controller_client() -> reqwest::ClientBuilder {
    reqwest::Client::builder().no_proxy()
}

#[cfg(test)]
mod tests {
    #[test]
    fn traffic_filter_uses_outbound_type_not_only_display_name() {
        assert!(super::is_proxy_connection("node", "Shadowsocks"));
        assert!(!super::is_proxy_connection("custom-direct", "Direct"));
        assert!(!super::is_proxy_connection("DIRECT", "Direct"));
        assert!(!super::is_proxy_connection("unknown", ""));
        assert!(!super::is_proxy_connection("drop", "RejectDrop"));
    }
    #[test]
    fn controller_bypasses_proxy_environment() {
        const FLAG: &str = "NETBOX_CONTROLLER_TEST_CHILD";
        if std::env::var_os(FLAG).is_none() {
            let status = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "commands::mihomo_api::tests::controller_bypasses_proxy_environment"])
                .env(FLAG, "1")
                .env("HTTP_PROXY", "http://127.0.0.1:1")
                .env("HTTPS_PROXY", "http://127.0.0.1:1")
                .env("ALL_PROXY", "http://127.0.0.1:1")
                .env("NO_PROXY", "")
                .status().unwrap();
            assert!(status.success());
            return;
        }
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut buffer = [0; 4096];
                stream.read(&mut buffer).await.unwrap();
                stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}").await.unwrap();
            });
            let response = super::controller_client().timeout(std::time::Duration::from_secs(2))
                .build().unwrap().get(format!("http://{address}/proxies")).send().await.unwrap();
            assert!(response.status().is_success());
            server.await.unwrap();
        });
    }
}

fn base_url() -> Result<String, String> {
    let settings = super::settings::get_general_settings()?;
    if !settings.enable_controller_port {
        return Err("API 外部控制端口已关闭，如需管理节点或测速请在设置中开启".into());
    }
    Ok(format!("http://127.0.0.1:{}", settings.controller_port))
}

fn url_encode(input: &str) -> String {
    let mut encoded = String::new();
    for b in input.bytes() {
        match b {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(b as char);
            }
            _ => {
                encoded.push_str(&format!("%{:02X}", b));
            }
        }
    }
    encoded
}

#[tauri::command]
pub async fn get_mihomo_proxies() -> Result<Value, String> {
    let client = controller_client()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .map_err(|e| e.to_string())?;

    let res = client
        .get(format!("{}/proxies", base_url()?))
        .send()
        .await
        .map_err(|e| format!("无法连接 Mihomo 控制端口: {}", e))?;

    if !res.status().is_success() {
        return Err(format!("Mihomo 返回错误状态: {}", res.status()));
    }

    let json: Value = res
        .json()
        .await
        .map_err(|e| format!("解析节点数据失败: {}", e))?;

    Ok(json)
}

#[tauri::command]
pub async fn switch_mihomo_proxy(group: String, proxy: String) -> Result<bool, String> {
    let client = controller_client()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .map_err(|e| e.to_string())?;

    let url = format!("{}/proxies/{}", base_url()?, url_encode(&group));
    let body = serde_json::json!({ "name": &proxy });

    let res = client
        .put(url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("切换节点请求失败: {}", e))?;

    if !res.status().is_success() {
        let err_body = res.text().await.unwrap_or_default();
        return Err(format!("Mihomo 拒绝切换: {}", err_body));
    }

    // 若切换的是主策略组，同步将 GLOBAL 策略组切换至相同节点，确保全局模式下无缝生效
    let g_lower = group.to_lowercase();
    if g_lower.contains("节点选择") || g_lower == "proxy" {
        let global_url = format!("{}/proxies/GLOBAL", base_url()?);
        let global_body = serde_json::json!({ "name": &proxy });
        let _ = client.put(global_url).json(&global_body).send().await;
    }

    // 切换节点后，根据设置决定是否断开旧连接，使新流量立刻走新选中的节点
    if super::settings::get_general_settings().map(|s| s.auto_close_connections).unwrap_or(true) {
        let _ = client
            .delete(format!("{}/connections", base_url()?))
            .send()
            .await;
    }

    Ok(true)
}

#[tauri::command]
pub async fn test_mihomo_delay(
    proxy: String,
    url: Option<String>,
    timeout: Option<u64>,
) -> Result<Option<u32>, String> {
    let client = controller_client()
        .timeout(std::time::Duration::from_secs(4))
        .build()
        .map_err(|e| e.to_string())?;

    // 默认采用 HTTPS 真实链路握手端点 (Cloudflare / Google)
    let test_url = url.unwrap_or_else(|| "https://cp.cloudflare.com/generate_204".into());
    let timeout_ms = timeout.unwrap_or(2000);

    let target = format!(
        "{}/proxies/{}/delay?url={}&timeout={}",
        base_url()?,
        url_encode(&proxy),
        url_encode(&test_url),
        timeout_ms
    );

    let res = client
        .get(target)
        .send()
        .await
        .map_err(|e| format!("测速请求失败: {}", e))?;

    if res.status().is_success() {
        let json: Value = res.json().await.map_err(|e| e.to_string())?;
        if let Some(delay) = json.get("delay").and_then(|d| d.as_u64()) {
            return Ok(Some(delay as u32));
        }
    }

    Ok(None)
}

#[tauri::command]
pub async fn get_mihomo_rules() -> Result<Value, String> {
    let client = controller_client()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .map_err(|e| e.to_string())?;

    let res = client
        .get(format!("{}/rules", base_url()?))
        .send()
        .await
        .map_err(|e| format!("获取规则失败: {}", e))?;

    let json: Value = res.json().await.map_err(|e| e.to_string())?;
    Ok(json)
}

#[tauri::command]
pub async fn set_mihomo_mode(mode: String) -> Result<bool, String> {
    let _lifecycle = super::process::LIFECYCLE.lock().await;
    if mode.to_lowercase() != "rule" && crate::routing_overrides::read()?.process_enabled {
        return Err("进程接管使用独立规则入口，请先关闭进程接管，再切换全局或直连模式".into());
    }
    let client = controller_client()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .map_err(|e| e.to_string())?;

    // 规范化模式名称 (TitleCase)
    let standard_mode = match mode.to_lowercase().as_str() {
        "global" => "Global",
        "direct" => "Direct",
        _ => "Rule",
    };

    let body = serde_json::json!({ "mode": standard_mode });
    let res = client
        .patch(format!("{}/configs", base_url()?))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("切换模式失败: {}", e))?;

    if !res.status().is_success() {
        let err_body = res.text().await.unwrap_or_default();
        return Err(format!("Mihomo 拒绝切换模式: {}", err_body));
    }

    // 切换模式后，根据设置断开所有旧的活动连接，使流量立刻按新模式路由
    if super::settings::get_general_settings().map(|s| s.auto_close_connections).unwrap_or(true) {
        let _ = client
            .delete(format!("{}/connections", base_url()?))
            .send()
            .await;
    }

    // 若切换为 Global 全局模式，确保 GLOBAL 策略组联动选中当前主出站节点
    if standard_mode == "Global" {
        if let Ok(proxies_res) = client.get(format!("{}/proxies", base_url()?)).send().await {
            if let Ok(json) = proxies_res.json::<Value>().await {
                if let Some(proxies_map) = json.get("proxies").and_then(|p| p.as_object()) {
                    let current_selected = proxies_map.iter().find_map(|(k, v)| {
                        let k_low = k.to_lowercase();
                        if k_low.contains("节点选择") || k_low == "proxy" {
                            v.get("now").and_then(|n| n.as_str()).map(|s| s.to_string())
                        } else {
                            None
                        }
                    });

                    if let Some(node_name) = current_selected {
                        let global_body = serde_json::json!({ "name": node_name });
                        let _ = client
                            .put(format!("{}/proxies/GLOBAL", base_url()?))
                            .json(&global_body)
                            .send()
                            .await;
                    }
                }
            }
        }
    }

    Ok(true)
}

#[tauri::command]
pub async fn get_mihomo_config() -> Result<Value, String> {
    let client = controller_client()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .map_err(|e| e.to_string())?;

    let res = client
        .get(format!("{}/configs", base_url()?))
        .send()
        .await
        .map_err(|e| format!("获取配置失败: {}", e))?;

    let json: Value = res.json().await.map_err(|e| e.to_string())?;
    Ok(json)
}

#[tauri::command]
pub async fn get_mihomo_rule_providers() -> Result<Value, String> {
    let client = controller_client()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .map_err(|e| e.to_string())?;

    let res = client
        .get(format!("{}/providers/rules", base_url()?))
        .send()
        .await
        .map_err(|e| format!("获取规则集失败: {}", e))?;

    let json: Value = res.json().await.map_err(|e| e.to_string())?;
    Ok(json)
}

#[tauri::command]
pub async fn update_mihomo_rule_provider(name: String) -> Result<bool, String> {
    let client = controller_client()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;

    let res = client
        .put(format!("{}/providers/rules/{}", base_url()?, url_encode(&name)))
        .send()
        .await
        .map_err(|e| format!("更新规则集失败: {}", e))?;

    Ok(res.status().is_success())
}

#[tauri::command]
pub async fn get_active_connections() -> Result<Value, String> {
    let client = controller_client()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .map_err(|e| e.to_string())?;

    let res = client
        .get(format!("{}/connections", base_url()?))
        .send()
        .await
        .map_err(|e| format!("读取活动连接失败: {}", e))?
        .error_for_status()
        .map_err(|e| format!("核心拒绝请求: {}", e))?
        .json::<Value>()
        .await
        .map_err(|e| format!("活动连接数据解析失败: {}", e))?;

    Ok(res)
}

#[tauri::command]
pub async fn close_connection(id: String) -> Result<bool, String> {
    let client = controller_client()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .map_err(|e| e.to_string())?;

    let res = client
        .delete(format!("{}/connections/{}", base_url()?, url_encode(&id)))
        .send()
        .await
        .map_err(|e| format!("关闭连接失败: {}", e))?;

    Ok(res.status().is_success())
}

#[tauri::command]
pub async fn close_all_connections() -> Result<bool, String> {
    let client = controller_client()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .map_err(|e| e.to_string())?;

    let res = client
        .delete(format!("{}/connections", base_url()?))
        .send()
        .await
        .map_err(|e| format!("关闭所有连接失败: {}", e))?;

    Ok(res.status().is_success())
}

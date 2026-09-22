use serde::{Deserialize, Serialize};

#[tauri::command]
pub async fn wait_for_exit_connection(proxy_port: u16) -> Result<(), String> {
    if proxy_port == 0 { return Err("代理端口无效".into()); }
    let client = reqwest::Client::builder().no_proxy()
        .proxy(reqwest::Proxy::all(format!("http://127.0.0.1:{proxy_port}")).map_err(|_| "代理地址无效")?)
        .timeout(std::time::Duration::from_secs(8)).build().map_err(|_| "初始化连接检测失败")?;
    for _ in 0..3 {
        if client.get("https://cp.cloudflare.com/generate_204").send().await.is_ok_and(|response| response.status().is_success()) { return Ok(()); }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
    Err("节点连接尚未就绪，请确认节点可用后重试".into())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IpHealthInfo {
    pub source: String,
    pub ip: String,
    pub asn: Option<u32>,
    #[serde(rename = "asOrganization")]
    pub as_organization: Option<String>,
    pub country: Option<String>,
    #[serde(rename = "countryCode")]
    pub country_code: Option<String>,
    pub region: Option<String>,
    #[serde(rename = "regionCode")]
    pub region_code: Option<String>,
    pub city: Option<String>,
    pub timezone: Option<String>,
    pub longitude: Option<String>,
    pub latitude: Option<String>,
    #[serde(rename = "postalCode")]
    pub postal_code: Option<String>,
    #[serde(rename = "fraudScore")]
    pub fraud_score: Option<u32>,
    #[serde(rename = "isResidential")]
    pub is_residential: Option<bool>,
    #[serde(rename = "isBroadcast")]
    pub is_broadcast: Option<bool>,
    #[serde(rename = "userAgent")]
    pub user_agent: Option<String>,
}

// 解析来自 IPpure 的标准返回数据
fn parse_ippure_json(text: &str) -> Option<IpHealthInfo> {
    let val: serde_json::Value = serde_json::from_str(text).ok()?;
    let ip = val.get("ip").and_then(|v| v.as_str())?.to_string();
    if ip.is_empty() {
        return None;
    }

    let asn = val
        .get("asn")
        .and_then(|v| v.as_u64().map(|n| n as u32).or_else(|| v.as_str().and_then(|s| s.parse().ok())));

    let as_organization = val.get("asOrganization").and_then(|v| v.as_str()).map(|s| s.to_string());
    let country = val.get("country").and_then(|v| v.as_str()).map(|s| s.to_string());
    let country_code = val.get("countryCode").and_then(|v| v.as_str()).map(|s| s.to_string());
    let region = val.get("region").and_then(|v| v.as_str()).map(|s| s.to_string());
    let region_code = val.get("regionCode").and_then(|v| v.as_str()).map(|s| s.to_string());
    let city = val.get("city").and_then(|v| v.as_str()).map(|s| s.to_string());
    let timezone = val.get("timezone").and_then(|v| v.as_str()).map(|s| s.to_string());

    let longitude = val.get("longitude").map(|v| {
        if let Some(s) = v.as_str() {
            s.to_string()
        } else {
            v.to_string().trim_matches('"').to_string()
        }
    });

    let latitude = val.get("latitude").map(|v| {
        if let Some(s) = v.as_str() {
            s.to_string()
        } else {
            v.to_string().trim_matches('"').to_string()
        }
    });

    let postal_code = val.get("postalCode").and_then(|v| v.as_str()).map(|s| s.to_string());

    let fraud_score = val
        .get("fraudScore")
        .and_then(|v| v.as_u64().map(|n| n as u32).or_else(|| v.as_str().and_then(|s| s.parse().ok())));

    let is_residential = val.get("isResidential").and_then(|v| v.as_bool());
    let is_broadcast = val.get("isBroadcast").and_then(|v| v.as_bool());
    let user_agent = val.get("userAgent").and_then(|v| v.as_str()).map(|s| s.to_string());

    Some(IpHealthInfo {
        source: "IPpure".into(),
        ip,
        asn,
        as_organization,
        country,
        country_code,
        region,
        region_code,
        city,
        timezone,
        longitude,
        latitude,
        postal_code,
        fraud_score,
        is_residential,
        is_broadcast,
        user_agent,
    })
}

// 备用免盾通道：通过免盾权威接口探测真实出口 IP 与风控数据，避免因节点机房属性被 CF 5秒盾拦截
async fn fetch_fallback_ip_info(proxy_port: Option<u16>) -> Result<IpHealthInfo, String> {
    let mut builder = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_millis(1500))
        .timeout(std::time::Duration::from_millis(3000));

    if let Some(port) = proxy_port {
        let proxy_url = format!("http://127.0.0.1:{}", port);
        if let Ok(p) = reqwest::Proxy::all(&proxy_url) {
            builder = builder.proxy(p);
        }
    }

    let client = builder.build().map_err(|e| e.to_string())?;
    // fields=status,message,country,countryCode,region,regionName,city,zip,lat,lon,timezone,isp,org,as,query,hosting
    let resp = client
        .get("http://ip-api.com/json/?fields=status,message,country,countryCode,region,regionName,city,zip,lat,lon,timezone,isp,org,as,query,hosting")
        .send()
        .await
        .map_err(|e| format!("备用探测连接失败: {}", e))?;

    let val: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let ip = val.get("query").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if ip.is_empty() {
        return Err("未获取到出口 IP".to_string());
    }

    let as_str = val.get("as").and_then(|v| v.as_str()).unwrap_or("");
    let asn = if as_str.starts_with("AS") {
        as_str[2..].split_whitespace().next().and_then(|s| s.parse().ok())
    } else {
        None
    };

    let is_residential = None;
    let fraud_score = None;

    Ok(IpHealthInfo {
        source: "ip-api（仅地理信息，评分不可用）".into(),
        ip,
        asn,
        as_organization: val.get("org").and_then(|v| v.as_str()).map(|s| s.to_string()),
        country: val.get("country").and_then(|v| v.as_str()).map(|s| s.to_string()),
        country_code: val.get("countryCode").and_then(|v| v.as_str()).map(|s| s.to_string()),
        region: val.get("regionName").and_then(|v| v.as_str()).map(|s| s.to_string()),
        region_code: val.get("region").and_then(|v| v.as_str()).map(|s| s.to_string()),
        city: val.get("city").and_then(|v| v.as_str()).map(|s| s.to_string()),
        timezone: val.get("timezone").and_then(|v| v.as_str()).map(|s| s.to_string()),
        longitude: val.get("lon").map(|v| v.to_string()),
        latitude: val.get("lat").map(|v| v.to_string()),
        postal_code: val.get("zip").and_then(|v| v.as_str()).map(|s| s.to_string()),
        fraud_score,
        is_residential,
        is_broadcast: None,
        user_agent: Some("curl/8.7.1".to_string()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn missing_score_remains_unknown() {
        let data = parse_ippure_json(r#"{"ip":"192.0.2.1"}"#).unwrap();
        assert_eq!(data.fraud_score, None);
        assert_eq!(data.source, "IPpure");
    }
}

#[tauri::command]
pub async fn check_ip_health(proxy_port: Option<u16>) -> Result<IpHealthInfo, String> {
    // 方案一：优先采用 Rust 原生超轻量异步连接池（0 进程开销，1.8秒建连短路 + 3.5秒总超时）
    let mut builder = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_millis(1800))
        .timeout(std::time::Duration::from_millis(3500))
        .redirect(reqwest::redirect::Policy::limited(3))
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36");

    if let Some(port) = proxy_port {
        if let Ok(p) = reqwest::Proxy::all(&format!("http://127.0.0.1:{}", port)) {
            builder = builder.proxy(p);
        }
    }

    if let Ok(client) = builder.build() {
        if let Ok(resp) = client
            .get("https://my.ippure.com/v1/info")
            .header("Accept", "application/json, text/plain, */*")
            .send()
            .await
        {
            if resp.status().is_success() {
                if let Ok(text) = resp.text().await {
                    if !text.contains("Just a moment...") && !text.contains("cf_chl_opt") {
                        if let Some(info) = parse_ippure_json(&text) {
                            return Ok(info);
                        }
                    }
                }
            }
        }
    }

    // 方案二：若 IPpure 出现 5 秒盾或不可用，极速切换至免盾通道 ip-api (同样受 3.0 秒短路保护)
    fetch_fallback_ip_info(proxy_port).await
}

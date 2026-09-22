use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
// 配置写入与核心启停属于同一事务；所有调用方只获取一次此锁。
pub(crate) use super::process::LIFECYCLE as PROFILE_WRITE;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProfileItem {
    pub id: String,
    pub name: String,
    pub url: String,
    #[serde(rename = "filePath")]
    pub file_path: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
    #[serde(rename = "nodeCount")]
    pub node_count: usize,
    #[serde(rename = "isSelected")]
    pub is_selected: bool,
    #[serde(default, rename = "upload", skip_serializing_if = "Option::is_none")]
    pub upload: Option<u64>,
    #[serde(default, rename = "download", skip_serializing_if = "Option::is_none")]
    pub download: Option<u64>,
    #[serde(default, rename = "total", skip_serializing_if = "Option::is_none")]
    pub total: Option<u64>,
    #[serde(default, rename = "expire", skip_serializing_if = "Option::is_none")]
    pub expire: Option<u64>,
    /// 自动更新周期（小时），0 表示不自动更新
    #[serde(default, rename = "autoUpdateInterval")]
    pub auto_update_interval: u32,
    /// 上次更新成功的 Unix 时间戳（秒）
    #[serde(default, rename = "lastUpdatedAtSeconds")]
    pub last_updated_at_seconds: u64,
}

/// 获取项目根工作目录 (避免数据写在 src-tauri 内部触发 Tauri Dev 热重载无限重启死循环)
pub fn get_base_dir() -> PathBuf {
    crate::storage::data_dir()
}

pub fn get_profiles_dir() -> PathBuf {
    get_base_dir().join("config").join("profiles")
}

pub fn get_profiles_index_file() -> PathBuf {
    get_base_dir().join("config").join("profiles.json")
}

fn ensure_profiles_dir() -> Result<(), String> {
    let dir = get_profiles_dir();
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| format!("创建配置目录失败: {}", e))?;
    }
    Ok(())
}

pub fn count_proxies(content: &str) -> usize {
    let mut in_proxies = false;
    let mut count = 0;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("proxies:") {
            in_proxies = true;
            continue;
        }
        if in_proxies {
            if trimmed.starts_with("proxy-groups:")
                || trimmed.starts_with("rules:")
                || trimmed.starts_with("rule-providers:")
            {
                break;
            }
            if trimmed.starts_with('-') && (trimmed.contains("name:") || trimmed.contains("name :")) {
                count += 1;
            }
        }
    }
    if count == 0 {
        count = content
            .lines()
            .filter(|l| {
                let t = l.trim();
                t.starts_with('-') && (t.contains("name:") || t.contains("name :"))
            })
            .count();
    }
    count
}

pub fn ensure_config_compat(content: &str) -> String {
    let mut modified = content.to_string();
    if !modified.contains("external-controller:") {
        modified = format!("external-controller: '127.0.0.1:9090'\n{}", modified);
    }
    if !modified.contains("mixed-port:") && !modified.contains("port:") {
        modified = format!("mixed-port: 7890\n{}", modified);
    }
    // 默认确保优先使用 IPv4 (ipv6: false)，避免因出口节点不支持 IPv6 或双栈握手失败导致频繁连接重置
    if !modified.contains("ipv6:") {
        modified = format!("ipv6: false\n{}", modified);
    }
    // 注入纯应用层安全 DNS（真实解析模式 redir-host，避免 Fake-IP 在无 TUN 下直连断网）
    if !modified.contains("dns:") {
        let listen_str = if std::net::UdpSocket::bind("127.0.0.1:53").is_ok() {
            "  listen: 127.0.0.1:53\n"
        } else {
            ""
        };
        let dns_block = format!(
"dns:\n  enable: true\n{}  ipv6: false\n  enhanced-mode: redir-host\n  nameserver:\n    - 223.5.5.5\n    - 119.29.29.29\n  fallback:\n    - https://1.1.1.1/dns-query\n    - https://8.8.8.8/dns-query\n  nameserver-policy:\n    '+.openai.com': 'https://1.1.1.1/dns-query'\n    '+.chatgpt.com': 'https://1.1.1.1/dns-query'\n    '+.oaistatic.com': 'https://1.1.1.1/dns-query'\n    '+.oaiusercontent.com': 'https://1.1.1.1/dns-query'\n  fallback-filter:\n    geoip: true\n    geoip-code: CN\n    geosite:\n      - gfw\n    domain:\n      - '+.openai.com'\n      - '+.chatgpt.com'\n      - '+.oaistatic.com'\n      - '+.oaiusercontent.com'\n",
            listen_str
        );
        modified = format!("{}\n{}", dns_block, modified);
    } else if !modified.contains("nameserver-policy:") {
        // 若已有 dns 块但没有指定 policy，注入 policy 防投毒
        if let Some(pos) = modified.find("dns:") {
            let insert_pos = pos + 4;
            let policy_block = "\n  nameserver-policy:\n    '+.openai.com': 'https://1.1.1.1/dns-query'\n    '+.chatgpt.com': 'https://1.1.1.1/dns-query'\n    '+.oaistatic.com': 'https://1.1.1.1/dns-query'\n    '+.oaiusercontent.com': 'https://1.1.1.1/dns-query'";
            modified.insert_str(insert_pos, policy_block);
        }
    }
    // 自动注入防 Fake-IP 泄露规则与 IP 健康度探测路由
    if modified.contains("rules:") {
        let mut security_injections = Vec::new();
        // 1. 拦截 WebRTC STUN 探测 (UDP 3478/5349)，彻底杜绝浏览器向检测站暴露 198.18.x.x 或本地真实 IP
        if !modified.contains("DST-PORT,3478") {
            security_injections.push("    - 'AND,((DST-PORT,3478),(NETWORK,UDP)),REJECT'".to_string());
        }
        if !modified.contains("DST-PORT,5349") {
            security_injections.push("    - 'AND,((DST-PORT,5349),(NETWORK,UDP)),REJECT'".to_string());
        }
        // 2. 自动注入 OpenAI 核心域名分流保障
        let target_group = if modified.contains("🔰 节点选择") {
            "🔰 节点选择"
        } else if modified.contains("PROXY") {
            "PROXY"
        } else if modified.contains("GLOBAL") {
            "GLOBAL"
        } else {
            "DIRECT"
        };
        if target_group != "DIRECT" {
            if !modified.contains("DOMAIN-SUFFIX,openai.com") {
                security_injections.push(format!("    - 'DOMAIN-SUFFIX,openai.com,{}'", target_group));
                security_injections.push(format!("    - 'DOMAIN-SUFFIX,chatgpt.com,{}'", target_group));
                security_injections.push(format!("    - 'DOMAIN-SUFFIX,oaistatic.com,{}'", target_group));
                security_injections.push(format!("    - 'DOMAIN-SUFFIX,oaiusercontent.com,{}'", target_group));
            }
        }
        // 3. 自动注入 ippure 分流规则，确保 IP 健康度探测 100% 路由至当前主出站代理
        if !modified.contains("DOMAIN-KEYWORD,ippure") {
            if target_group != "DIRECT" {
                security_injections.push(format!("    - 'DOMAIN-KEYWORD,ippure,{}'", target_group));
                security_injections.push(format!("    - 'DOMAIN-SUFFIX,ippure.com,{}'", target_group));
            }
        }
        if !security_injections.is_empty() {
            let inject_rule = format!("rules:\n{}", security_injections.join("\n"));
            modified = modified.replacen("rules:", &inject_rule, 1);
        }
    }

    // 自动将广告拦截/Reject 策略组的默认选中项调整为直连放行 (默认停用广告拦截，避免误杀正常网站脚本及频繁触发 Cloudflare 5秒盾)
    let mut lines: Vec<String> = modified.lines().map(|l| l.to_string()).collect();
    let mut in_proxy_groups = false;
    for line in lines.iter_mut() {
        let trimmed = line.trim();
        if trimmed.starts_with("proxy-groups:") {
            in_proxy_groups = true;
            continue;
        }
        if in_proxy_groups {
            if trimmed.starts_with("rules:") || trimmed.starts_with("rule-providers:") {
                in_proxy_groups = false;
                continue;
            }
            let is_reject_group = trimmed.contains("Reject")
                || trimmed.contains("广告")
                || trimmed.contains("拦截");
            if is_reject_group && trimmed.contains("proxies:") {
                if line.contains("[REJECT, '🎯 全球直连'") {
                    *line = line.replace("[REJECT, '🎯 全球直连'", "['🎯 全球直连', REJECT");
                } else if line.contains("[REJECT, \"🎯 全球直连\"") {
                    *line = line.replace("[REJECT, \"🎯 全球直连\"", "[\"🎯 全球直连\", REJECT");
                } else if line.contains("[REJECT, DIRECT") {
                    *line = line.replace("[REJECT, DIRECT", "[DIRECT, REJECT");
                } else if line.contains("[REJECT, 'DIRECT'") {
                    *line = line.replace("[REJECT, 'DIRECT'", "['DIRECT', REJECT");
                } else if line.contains("[REJECT, \"DIRECT\"") {
                    *line = line.replace("[REJECT, \"DIRECT\"", "[\"DIRECT\", REJECT");
                } else if line.contains("proxies: [REJECT,") && line.contains("🎯 全球直连") {
                    *line = line.replace("proxies: [REJECT,", "proxies: ['🎯 全球直连', REJECT,");
                } else if line.contains("proxies: [REJECT,") && line.contains("DIRECT") {
                    *line = line.replace("proxies: [REJECT,", "proxies: [DIRECT, REJECT,");
                }
            }
        }
    }
    modified = lines.join("\n");

    modified
}

pub(crate) fn read_profiles_index() -> Vec<ProfileItem> {
    let index_file = get_profiles_index_file();
    if let Ok(content) = fs::read_to_string(&index_file) {
        let mut list: Vec<ProfileItem> = serde_json::from_str(&content).unwrap_or_default();
        for item in list.iter_mut() {
            if item.node_count == 0 {
                let p = Path::new(&item.file_path);
                let actual_path = if p.is_absolute() {
                    p.to_path_buf()
                } else {
                    get_base_dir().join(p)
                };
                if let Ok(c) = fs::read_to_string(actual_path) {
                    item.node_count = count_proxies(&c);
                }
            }
        }
        list
    } else {
        Vec::new()
    }
}

fn write_profiles_index(list: &[ProfileItem]) -> Result<(), String> {
    let json = serde_json::to_string_pretty(list).map_err(|e| e.to_string())?;
    let index_file = get_profiles_index_file();
    if let Some(parent) = index_file.parent() {
        let _ = fs::create_dir_all(parent);
    }
    crate::storage::replace(&index_file, json.as_bytes())?;
    Ok(())
}

#[tauri::command]
pub fn list_profiles() -> Result<Vec<ProfileItem>, String> {
    ensure_profiles_dir()?;
    // 只读操作，绝不在每次查询时写回文件，彻底避免触发 Tauri dev 监听器重启
    Ok(read_profiles_index())
}

/// 解析节点订阅标准 Subscription-Userinfo 头
/// 格式样例: upload=1073741824; download=41454145536; total=107374182400; expire=1791696000
pub fn parse_subscription_userinfo(header_str: &str) -> (Option<u64>, Option<u64>, Option<u64>, Option<u64>) {
    let mut upload = None;
    let mut download = None;
    let mut total = None;
    let mut expire = None;

    for part in header_str.split(';') {
        let part = part.trim();
        if let Some((k, v)) = part.split_once('=') {
            let key = k.trim().to_lowercase();
            let val = v.trim();
            if let Ok(num) = val.parse::<u64>() {
                match key.as_str() {
                    "upload" => upload = Some(num),
                    "download" => download = Some(num),
                    "total" => total = Some(num),
                    "expire" => expire = Some(num),
                    _ => {}
                }
            }
        }
    }

    (upload, download, total, expire)
}

#[tauri::command]
pub async fn add_profile(name: String, url: String) -> Result<ProfileItem, String> {
    let _write = PROFILE_WRITE.lock().await;
    ensure_profiles_dir()?;
    let id = format!(
        "prof_{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis()
    );
    let filename = format!("{}.yaml", id);
    let full_path = get_profiles_dir().join(&filename);
    let rel_path = format!("config/profiles/{}", filename);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .user_agent("ClashMeta")
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client.get(&url).send().await.map_err(|e| format!("下载订阅失败: {}", e))?;
    if !resp.status().is_success() { return Err(format!("下载订阅失败：HTTP {}", resp.status())); }

    // 提取流量与到期时间信息 (从标准 Subscription-Userinfo 响应头)
    let (mut upload, mut download, mut total, mut expire) = resp
        .headers()
        .get("subscription-userinfo")
        .and_then(|h| h.to_str().ok())
        .map(parse_subscription_userinfo)
        .unwrap_or((None, None, None, None));

    let raw_content = resp.text().await.map_err(|e| format!("读取订阅内容失败: {}", e))?;

    // 如果响应头没有提供完整信息，尝试兼容从 yaml 注释或头部元数据解析
    if total.is_none() && expire.is_none() {
        for line in raw_content.lines().take(30) {
            let line_trimmed = line.trim();
            if line_trimmed.to_lowercase().starts_with("# subscription-userinfo:") || line_trimmed.to_lowercase().starts_with("# subscription:") {
                if let Some((_, info)) = line_trimmed.split_once(':') {
                    let (u, d, t, e) = parse_subscription_userinfo(info);
                    if upload.is_none() { upload = u; }
                    if download.is_none() { download = d; }
                    if total.is_none() { total = t; }
                    if expire.is_none() { expire = e; }
                }
            }
        }
    }

    let node_count = count_proxies(&raw_content);
    let final_content = super::settings::prepare_with(&raw_content, &super::settings::get_general_settings()?)?;
    validate_config(&final_content)?;

    crate::storage::replace(&full_path, final_content.as_bytes())?;

    let now = chrono_or_simple_date();
    let mut list = read_profiles_index();
    let is_first = list.is_empty();

    let now_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let item = ProfileItem {
        id: id.clone(),
        name,
        url,
        file_path: rel_path,
        updated_at: now,
        node_count,
        is_selected: is_first,
        upload,
        download,
        total,
        expire,
        auto_update_interval: 0,
        last_updated_at_seconds: now_secs,
    };

    list.push(item.clone());
    if is_first {
        apply_profile_to_core(&full_path.to_string_lossy()).await?;
    }
    write_profiles_index(&list)?;

    Ok(item)
}

#[tauri::command]
pub async fn update_profile(id: String) -> Result<ProfileItem, String> {
    let _write = PROFILE_WRITE.lock().await;
    let mut list = read_profiles_index();
    let idx = list.iter().position(|p| p.id == id).ok_or_else(|| "订阅未找到".to_string())?;

    let url = list[idx].url.clone();
    let p = Path::new(&list[idx].file_path);
    let full_path = if p.is_absolute() {
        p.to_path_buf()
    } else {
        get_base_dir().join(p)
    };

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .user_agent("ClashMeta")
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client.get(&url).send().await.map_err(|e| format!("更新订阅失败: {}", e))?;
    if !resp.status().is_success() { return Err(format!("更新订阅失败：HTTP {}", resp.status())); }

    // 提取流量与到期时间信息 (从标准 Subscription-Userinfo 响应头)
    let (mut upload, mut download, mut total, mut expire) = resp
        .headers()
        .get("subscription-userinfo")
        .and_then(|h| h.to_str().ok())
        .map(parse_subscription_userinfo)
        .unwrap_or((None, None, None, None));

    let raw_content = resp.text().await.map_err(|e| format!("读取订阅内容失败: {}", e))?;

    // 如果响应头没有提供完整信息，尝试兼容从 yaml 注释中解析
    if total.is_none() && expire.is_none() {
        for line in raw_content.lines().take(30) {
            let line_trimmed = line.trim();
            if line_trimmed.to_lowercase().starts_with("# subscription-userinfo:") || line_trimmed.to_lowercase().starts_with("# subscription:") {
                if let Some((_, info)) = line_trimmed.split_once(':') {
                    let (u, d, t, e) = parse_subscription_userinfo(info);
                    if upload.is_none() { upload = u; }
                    if download.is_none() { download = d; }
                    if total.is_none() { total = t; }
                    if expire.is_none() { expire = e; }
                }
            }
        }
    }

    let node_count = count_proxies(&raw_content);
    let final_content = super::settings::prepare_with(&raw_content, &super::settings::get_general_settings()?)?;
    validate_config(&final_content)?;
    let previous = fs::read(&full_path).map_err(|e| e.to_string())?;
    crate::storage::replace(&full_path, final_content.as_bytes())?;
    if list[idx].is_selected {
        if let Err(error) = apply_profile_to_core(&full_path.to_string_lossy()).await {
            crate::storage::replace(&full_path, &previous)?;
            return Err(error);
        }
    }

    list[idx].updated_at = chrono_or_simple_date();
    list[idx].node_count = node_count;
    list[idx].last_updated_at_seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    if upload.is_some() || total.is_some() {
        list[idx].upload = upload;
        list[idx].download = download;
        list[idx].total = total;
        list[idx].expire = expire;
    }

    write_profiles_index(&list)?;

    Ok(list[idx].clone())
}

#[tauri::command]
pub async fn select_profile(id: String) -> Result<bool, String> {
    let _write = PROFILE_WRITE.lock().await;
    let mut list = read_profiles_index();
    if !list.iter().any(|item| item.id == id) { return Err("订阅不存在".into()); }
    let mut selected_file = None;

    for item in list.iter_mut() {
        if item.id == id {
            item.is_selected = true;
            let p = Path::new(&item.file_path);
            let full_path = if p.is_absolute() {
                p.to_path_buf()
            } else {
                get_base_dir().join(p)
            };
            selected_file = Some(full_path);
        } else {
            item.is_selected = false;
        }
    }

    if let Some(path) = selected_file {
        apply_profile_to_core(&path.to_string_lossy()).await?;
    }
    if let Err(error) = write_profiles_index(&list) {
        let (_, old_source) = crate::routing_overrides::current_source();
        apply_profile_to_core(&old_source.to_string_lossy()).await
            .map_err(|restore| format!("订阅索引保存失败：{error}；核心恢复失败：{restore}"))?;
        return Err(format!("订阅索引保存失败，已恢复原核心配置：{error}"));
    }

    Ok(true)
}

#[tauri::command]
pub async fn delete_profile(id: String) -> Result<bool, String> {
    let _write = PROFILE_WRITE.lock().await;
    let mut list = read_profiles_index();
    if let Some(pos) = list.iter().position(|p| p.id == id) {
        let is_selected = list[pos].is_selected;
        if is_selected {
            // 如果仅剩一个订阅且正在生效，禁止直接删除
            if list.len() <= 1 {
                return Err("无法删除当前正在生效的唯一订阅。请先添加或切换至其他可用订阅后再删除。".into());
            }
            // 挑选下一个可用订阅先进行事务切换
            let alt_idx = if pos == 0 { 1 } else { 0 };
            list[alt_idx].is_selected = true;
            let alt_path = {
                let p = Path::new(&list[alt_idx].file_path);
                if p.is_absolute() {
                    p.to_path_buf()
                } else {
                    get_base_dir().join(p)
                }
            };
            // 必须新订阅成功加载至核心后，才允许继续移除旧项
            apply_profile_to_core(&alt_path.to_string_lossy()).await
                .map_err(|e| format!("自动切换至备用订阅失败，删除事务已中止: {}", e))?;
        }

        let removed = list.remove(pos);
        let p = Path::new(&removed.file_path);
        let full_path = if p.is_absolute() {
            p.to_path_buf()
        } else {
            get_base_dir().join(p)
        };
        let _ = fs::remove_file(full_path);
        write_profiles_index(&list)?;
        Ok(true)
    } else {
        Err("订阅不存在".into())
    }
}

/// 编辑订阅元数据（名称、URL、自动更新周期小时数）
#[tauri::command]
pub async fn edit_profile_metadata(
    id: String,
    name: String,
    url: String,
    auto_update_interval: u32,
) -> Result<ProfileItem, String> {
    let _write = PROFILE_WRITE.lock().await;
    let mut list = read_profiles_index();
    let idx = list.iter().position(|p| p.id == id).ok_or_else(|| "订阅未找到".to_string())?;

    list[idx].name = name.trim().to_string();
    list[idx].url = url.trim().to_string();
    list[idx].auto_update_interval = auto_update_interval;

    write_profiles_index(&list)?;
    Ok(list[idx].clone())
}

/// 读取订阅 YAML 文本内容（用于配置查看与在线编辑）
#[tauri::command]
pub async fn get_profile_content(id: String) -> Result<String, String> {
    let list = read_profiles_index();
    let item = list.iter().find(|p| p.id == id).ok_or_else(|| "订阅未找到".to_string())?;
    let p = Path::new(&item.file_path);
    let full_path = if p.is_absolute() {
        p.to_path_buf()
    } else {
        get_base_dir().join(p)
    };
    fs::read_to_string(&full_path).map_err(|e| format!("读取配置文件失败: {}", e))
}

/// 保存并应用用户编辑的订阅 YAML 配置文本
#[tauri::command]
pub async fn save_profile_content(id: String, content: String) -> Result<ProfileItem, String> {
    let _write = PROFILE_WRITE.lock().await;
    let mut list = read_profiles_index();
    let idx = list.iter().position(|p| p.id == id).ok_or_else(|| "订阅未找到".to_string())?;

    let p = Path::new(&list[idx].file_path);
    let full_path = if p.is_absolute() {
        p.to_path_buf()
    } else {
        get_base_dir().join(p)
    };

    // 校验配置合法性
    validate_config(&content)?;

    let node_count = count_proxies(&content);
    let previous = fs::read(&full_path).map_err(|e| e.to_string())?;
    crate::storage::replace(&full_path, content.as_bytes())?;

    if list[idx].is_selected {
        if let Err(error) = apply_profile_to_core(&full_path.to_string_lossy()).await {
            crate::storage::replace(&full_path, &previous)?;
            return Err(format!("保存后核心重载失败: {}", error));
        }
    }

    list[idx].node_count = node_count;
    list[idx].updated_at = chrono_or_simple_date();
    if let Err(error) = write_profiles_index(&list) {
        crate::storage::replace(&full_path, &previous)?;
        if list[idx].is_selected {
            let _ = apply_profile_to_core(&full_path.to_string_lossy()).await;
        }
        return Err(format!("保存订阅索引失败，已回滚文件: {}", error));
    }

    Ok(list[idx].clone())
}

/// 导出订阅配置文件到指定目标路径
#[tauri::command]
pub async fn export_profile_file(id: String, target_path: String) -> Result<bool, String> {
    let list = read_profiles_index();
    let item = list.iter().find(|p| p.id == id).ok_or_else(|| "订阅未找到".to_string())?;
    let p = Path::new(&item.file_path);
    let full_path = if p.is_absolute() {
        p.to_path_buf()
    } else {
        get_base_dir().join(p)
    };

    let content = fs::read(&full_path).map_err(|e| format!("读取配置文件失败: {}", e))?;
    fs::write(&target_path, content).map_err(|e| format!("写入目标文件失败: {}", e))?;
    Ok(true)
}

/// 订阅后台自动更新定时调度器
pub async fn run_profile_scheduler() {
    loop {
        tokio::time::sleep(std::time::Duration::from_secs(60)).await;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        // 获取需要更新的订阅列表
        let pending_ids: Vec<String> = {
            let list = read_profiles_index();
            list.into_iter()
                .filter(|p| {
                    if p.auto_update_interval == 0 || p.url.trim().is_empty() || !p.url.starts_with("http") {
                        return false;
                    }
                    let interval_secs = (p.auto_update_interval as u64) * 3600;
                    now >= p.last_updated_at_seconds.saturating_add(interval_secs)
                })
                .map(|p| p.id)
                .collect()
        };

        for id in pending_ids {
            eprintln!("[ProfileScheduler] 正在触发自动更新订阅: {}", id);
            if let Err(e) = update_profile(id).await {
                eprintln!("[ProfileScheduler] 自动更新订阅失败: {}", e);
            }
        }
    }
}

pub async fn apply_profile_to_core(yaml_path: &str) -> Result<(), String> {
    let base_dir = get_base_dir();
    let p = Path::new(yaml_path);
    let actual_path = if p.is_absolute() {
        p.to_path_buf()
    } else {
        base_dir.join(p)
    };

    if !actual_path.exists() {
        return Err(format!("配置文件不存在: {}", actual_path.display()));
    }

    // 关键修复：Mihomo 内核的 home 目录 (-d) 为 core_data，其 REST API PUT /configs
    // 强制校验 path 必须在 core_data 内部（SAFE_PATHS）。
    // 将选中的配置文件同步复制到 core_data/config.yaml，再提交给内核热重载！
    let core_data_dir = base_dir.join("core_data");
    let _ = fs::create_dir_all(&core_data_dir);

    let raw = fs::read_to_string(&actual_path).map_err(|e| e.to_string())?;
    let (cleaned_raw, was_cleaned) = sanitize_profile_rules(&raw);
    if was_cleaned {
        let _ = crate::storage::replace(&actual_path, cleaned_raw.as_bytes());
    }
    // 切换时索引尚未提交，必须使用候选文件的订阅身份，不能绑定旧订阅同名节点。
    let profile_id = read_profiles_index().iter().find(|item| get_base_dir().join(&item.file_path) == actual_path)
        .map(|item| item.id.clone()).unwrap_or_else(|| "default".into());
    let config = crate::routing_overrides::read()?;
    let prepared = crate::routing_overrides::prepare(&cleaned_raw, &config, &profile_id)?;
    validate_config(&prepared)?;
    crate::routing_overrides::apply_runtime(&prepared).await?;
    crate::routing_overrides::set_applied(config.revision, crate::routing_overrides::tracker::status(&config).generation);
    Ok(())
}

pub fn validate_config(content: &str) -> Result<(), String> {
    let id = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos();
    let dir = std::env::temp_dir().join(format!("netbox-validate-{id}"));
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    if let Err(error) = copy_validation_assets(&get_base_dir().join("core_data"), &dir) {
        let _ = fs::remove_dir_all(&dir);
        return Err(error);
    }
    let path = dir.join("config.yaml");
    fs::write(&path, content).map_err(|e| e.to_string())?;
    let exe = validation_core()?;
    let mut command = std::process::Command::new(exe);
    command.arg("-t").arg("-d").arg(&dir).arg("-f").arg(&path);
    #[cfg(windows)] { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
    command.stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    let mut child = command.spawn().map_err(|_| "无法运行内核配置校验，请检查内核资源".to_string())?;
    let start = std::time::Instant::now();
    let result = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status.success()),
            Ok(None) if start.elapsed() < std::time::Duration::from_secs(15) => std::thread::sleep(std::time::Duration::from_millis(50)),
            _ => {
                let _ = child.kill(); let _ = child.wait();
                break Err("内核配置校验超时或进程异常；请检查本地 Geo 数据和规则资源，原订阅保持不变".to_string());
            }
        }
    };
    let _ = fs::remove_dir_all(&dir);
    if result? { Ok(()) } else { Err("内核配置校验失败，原订阅保持不变".into()) }
}

/// 校验复用运行环境的资源副本，避免因空目录触发 Geo/规则重新下载。
/// 不复制运行配置、数据库、链接或临时文件，校验仍完全隔离。
pub(crate) fn copy_validation_assets(source: &Path, target: &Path) -> Result<(), String> {
    if !source.exists() { return Ok(()); }
    for entry in fs::read_dir(source).map_err(|_| "无法读取本地校验资源")? {
        let entry = entry.map_err(|_| "无法读取本地校验资源项")?;
        let kind = entry.file_type().map_err(|_| "无法识别本地校验资源")?;
        if kind.is_symlink() { continue; }
        let path = entry.path();
        let destination = target.join(entry.file_name());
        if kind.is_dir() {
            fs::create_dir_all(&destination).map_err(|_| "无法创建隔离校验资源目录")?;
            copy_validation_assets(&path, &destination)?;
        } else if kind.is_file() {
            let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
            let extension = path.extension().and_then(|v| v.to_str()).unwrap_or("").to_ascii_lowercase();
            if name != "config.yaml" && name != "config.yml"
                && matches!(extension.as_str(), "dat" | "metadb" | "mmdb" | "mrs" | "yaml" | "yml" | "txt") {
                fs::copy(&path, destination).map_err(|_| "复制本地 Geo 或规则资源失败")?;
            }
        }
    }
    Ok(())
}

pub(crate) fn validation_core() -> Result<PathBuf, String> {
    let root = crate::storage::resource_dir().join("binaries");
    for name in ["mihomo-compatible.exe", "mihomo.exe", "mihomo-v3.exe"] {
        if name == "mihomo-v3.exe" && !super::process::check_avx2_support() { continue; }
        let path = root.join(name);
        if path.is_file() { return Ok(path); }
    }
    Err("未找到可用于校验的核心".into())
}

#[cfg(test)]
mod validation_tests {
    use super::*;

    #[test]
    fn test_parse_subscription_userinfo() {
        let raw = "upload=1073741824; download=41454145536; total=107374182400; expire=1791696000";
        let (u, d, t, e) = parse_subscription_userinfo(raw);
        assert_eq!(u, Some(1073741824));
        assert_eq!(d, Some(41454145536));
        assert_eq!(t, Some(107374182400));
        assert_eq!(e, Some(1791696000));

        let partial = "download=500; total=1000";
        let (u, d, t, e) = parse_subscription_userinfo(partial);
        assert_eq!(u, None);
        assert_eq!(d, Some(500));
        assert_eq!(t, Some(1000));
        assert_eq!(e, None);
    }

    #[test]
    fn switching_during_startup_waits_and_applies_selected_profile() {
        const FLAG: &str = "NETBOX_PROFILE_RACE_CHILD";
        if std::env::var_os(FLAG).is_none() {
            assert!(std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "commands::profile::validation_tests::switching_during_startup_waits_and_applies_selected_profile"])
                .env(FLAG, "1").status().unwrap().success());
            return;
        }
        let root = std::env::temp_dir().join(format!("netbox-profile-race-{}", std::process::id()));
        fs::create_dir_all(root.join("config")).unwrap();
        crate::storage::initialize_test(root.clone(), PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf());
        let listeners: Vec<_> = (0..2).map(|_| std::net::TcpListener::bind("127.0.0.1:0").unwrap()).collect();
        let prefs = super::super::settings::GeneralSettings {
            mixed_port: listeners[0].local_addr().unwrap().port(), controller_port: listeners[1].local_addr().unwrap().port(),
            ..Default::default()
        };
        drop(listeners);
        fs::write(root.join("config/preferences.json"), serde_json::to_vec(&prefs).unwrap()).unwrap();
        fs::write(root.join("config/local-rules.json"), r#"{"enabled":false,"providers":[]}"#).unwrap();
        for (id, target) in [("old", "DIRECT"), ("new", "REJECT")] {
            fs::write(root.join(format!("config/{id}.yaml")), format!("proxies: []\nrules: ['MATCH,{target}']\n")).unwrap();
        }
        let profiles: Vec<_> = ["old", "new"].iter().map(|id| ProfileItem { id: (*id).into(), name: (*id).into(), url: String::new(), file_path: format!("config/{id}.yaml"), updated_at: String::new(), node_count: 0, is_selected: *id == "old", ..Default::default() }).collect();
        write_profiles_index(&profiles).unwrap();
        let state = std::sync::Mutex::new(super::super::process::CoreState { child: None, mixed_port: prefs.mixed_port, controller_port: prefs.controller_port, active_core: None, active_core_path: None, core_mode: None, started_at: None });
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let read = std::sync::Arc::new(tokio::sync::Barrier::new(2));
            let resume = std::sync::Arc::new(tokio::sync::Barrier::new(2));
            *super::super::process::STARTUP_BARRIER.lock().unwrap() = Some((read.clone(), resume.clone()));
            let start = super::super::process::start_core_transaction(Some("compatible".into()), &state);
            let switch = async {
                read.wait().await;
                let selected = select_profile("new".into());
                tokio::pin!(selected);
                assert!(tokio::time::timeout(std::time::Duration::from_millis(50), &mut selected).await.is_err(), "启动读取旧订阅后，切换不能提前提交");
                resume.wait().await;
                selected.await.unwrap();
            };
            let (started, _) = tokio::join!(start, switch);
            started.unwrap();
            assert_eq!(read_profiles_index().iter().find(|p| p.is_selected).unwrap().id, "new");
            assert!(fs::read_to_string(root.join("core_data/config.yaml")).unwrap().contains("MATCH,REJECT"));
            let response: serde_json::Value = super::super::mihomo_api::controller_client().build().unwrap()
                .get(format!("http://127.0.0.1:{}/rules", prefs.controller_port)).send().await.unwrap().json().await.unwrap();
            assert_eq!(response["rules"][0]["proxy"], "REJECT");
            super::super::process::stop_owned_child(&mut state.lock().unwrap()).unwrap();
        });
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn validation_copies_geo_and_nested_rules_without_runtime_state() {
        let root = std::env::temp_dir().join(format!("netbox-assets-test-{}", std::process::id()));
        let source = root.join("source"); let target = root.join("target");
        fs::create_dir_all(source.join("ruleset")).unwrap();
        fs::create_dir_all(&target).unwrap();
        fs::write(source.join("geosite.dat"), b"geo").unwrap();
        fs::write(source.join("ruleset/test.yaml"), b"payload: []").unwrap();
        fs::write(source.join("config.yaml"), b"private config").unwrap();
        fs::write(source.join("cache.db"), b"runtime").unwrap();
        copy_validation_assets(&source, &target).unwrap();
        assert_eq!(fs::read(target.join("geosite.dat")).unwrap(), b"geo");
        assert!(target.join("ruleset/test.yaml").exists());
        assert!(!target.join("config.yaml").exists());
        assert!(!target.join("cache.db").exists());
        fs::write(target.join("geosite.dat"), b"changed").unwrap();
        assert_eq!(fs::read(source.join("geosite.dat")).unwrap(), b"geo");
        fs::remove_dir_all(root).unwrap();
    }
}

fn chrono_or_simple_date() -> String {
    let now = std::time::SystemTime::now();
    let duration = now.duration_since(std::time::UNIX_EPOCH).unwrap();
    let secs = duration.as_secs();
    let days = secs / 86400;
    let rem_secs = secs % 86400;
    let hours = (rem_secs / 3600 + 8) % 24;
    let mins = (rem_secs % 3600) / 60;
    format!(
        "2026-{:02}-{:02} {:02}:{:02}",
        (days % 365) / 30 + 1,
        (days % 30) + 1,
        hours,
        mins
    )
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuleProviderSpec {
    pub name: String,
    pub url: String,
    pub behavior: String,
    #[serde(default)]
    pub format: Option<String>,
    #[serde(alias = "targetProxy")]
    pub target_proxy: String,
}

#[tauri::command]
pub async fn add_external_rule_provider(spec: RuleProviderSpec) -> Result<bool, String> {
    let name = spec.name.trim().to_string();
    change_rule_provider(&name, Some(&spec)).await
}

#[tauri::command]
pub async fn remove_external_rule_provider(name: String) -> Result<bool, String> {
    change_rule_provider(name.trim(), None).await
}

async fn change_rule_provider(name: &str, spec: Option<&RuleProviderSpec>) -> Result<bool, String> {
    let _write = PROFILE_WRITE.lock().await;
    let mut plan = super::local_rules::get_local_rule_plan()?;
    // 即使当前使用订阅规则，也校验本地规则集输入。
    let normalized = spec.cloned().map(|mut s| {
        s.name = name.into();
        s.target_proxy = super::local_rules::local_target(&s.target_proxy).into();
        s
    });
    let mut validation_spec = normalized.clone();
    if let Some(s) = validation_spec.as_mut() { if !matches!(s.target_proxy.as_str(), "DIRECT" | "REJECT") { s.target_proxy = "本地方案·节点选择".into(); } }
    edit_rule_provider("proxies: []\nproxy-groups: [{name: 本地方案·节点选择, type: select, proxies: [REJECT]}]\nrules: []\n", name, validation_spec.as_ref())?;
    plan.providers.retain(|provider| provider.name != name);
    if let Some(spec) = normalized {
        plan.providers.push(spec);
    }
    super::local_rules::save(plan).await?;
    Ok(true)
}

pub(crate) fn edit_rule_provider(content: &str, name: &str, spec: Option<&RuleProviderSpec>) -> Result<String, String> {
    if name.is_empty() || name.len() > 128 || name.contains("..")
        || !name.chars().all(|c| c.is_alphanumeric() || matches!(c, '_' | '-' | '.')) {
        return Err("规则集名称仅允许文字、数字、下划线、短横线和单个点".into());
    }
    let mut yaml: serde_yaml::Value = serde_yaml::from_str(content).map_err(|_| "订阅 YAML 格式错误")?;
    let mut new_rule = None;
    if let Some(spec) = spec {
        if !matches!(spec.behavior.as_str(), "domain" | "ipcidr" | "classical") {
            return Err("规则行为必须为 domain、ipcidr 或 classical".into());
        }
        let url = reqwest::Url::parse(&spec.url).map_err(|_| "规则集 URL 格式错误")?;
        if !matches!(url.scheme(), "http" | "https") { return Err("规则集仅支持 HTTP 或 HTTPS".into()); }
        let inferred = if url.path().ends_with(".mrs") { "mrs" }
            else if url.path().to_ascii_lowercase().contains("loyalsoldier/clash-rules") { "yaml" }
            else if url.path().ends_with(".txt") || url.path().ends_with(".list") { "text" } else { "yaml" };
        let format = spec.format.as_deref().unwrap_or(inferred);
        let extension = match format { "mrs" => "mrs", "text" => "txt", "yaml" => "yaml", _ => return Err("规则格式须为 yaml、text 或 mrs".into()) };
        if format == "mrs" && spec.behavior == "classical" { return Err("MRS 仅支持 domain 或 ipcidr".into()); }
        let mut targets = vec!["DIRECT".to_string(), "REJECT".to_string()];
        for section in ["proxies", "proxy-groups"] {
            if let Some(items) = yaml.get(section).and_then(serde_yaml::Value::as_sequence) {
                targets.extend(items.iter().filter_map(|item| item["name"].as_str().map(str::to_string)));
            }
        }
        let target = if targets.contains(&spec.target_proxy) { spec.target_proxy.clone() }
            else { targets.iter().find(|name| name.contains("节点选择")).cloned().ok_or("目标策略组不存在，请选择有效分流目标")? };
        if target.contains(',') || target.contains('\n') || target.contains('\r') { return Err("分流目标名称不能含逗号或换行".into()); }
        let provider = serde_json::json!({
            "type": "http", "behavior": spec.behavior, "format": format,
            "url": spec.url, "path": format!("./ruleset/{name}.{extension}"), "interval": 86400
        });
        let root = yaml.as_mapping_mut().ok_or("配置必须为对象")?;
        let providers = root.entry("rule-providers".into()).or_insert(serde_yaml::Value::Mapping(Default::default()));
        if providers.is_null() { *providers = serde_yaml::Value::Mapping(Default::default()); }
        providers.as_mapping_mut().ok_or("rule-providers 必须为对象")?
            .insert(name.into(), serde_yaml::to_value(provider).map_err(|e| e.to_string())?);
        new_rule = Some(format!("RULE-SET,{name},{target}"));
    } else if let Some(providers) = yaml.get_mut("rule-providers").and_then(serde_yaml::Value::as_mapping_mut) {
        providers.remove(serde_yaml::Value::from(name));
    }
    let root = yaml.as_mapping_mut().ok_or("配置必须为对象")?;
    let rules = root.entry("rules".into()).or_insert(serde_yaml::Value::Sequence(Vec::new()));
    if rules.is_null() { *rules = serde_yaml::Value::Sequence(Vec::new()); }
    let rules = rules.as_sequence_mut().ok_or("rules 必须为数组")?;
    rules.retain(|rule| !rule.as_str().is_some_and(|rule| {
        let mut fields = rule.split(',').map(str::trim);
        fields.next() == Some("RULE-SET") && fields.next() == Some(name)
    }));
    if let Some(rule) = new_rule { rules.insert(0, rule.into()); }
    serde_yaml::to_string(&yaml).map_err(|e| e.to_string())
}

#[cfg(test)]
mod rule_provider_tests {
    use super::*;
    fn spec(name: &str) -> RuleProviderSpec {
        RuleProviderSpec { name: name.into(), url: "https://example.org/rules.txt?test=1".into(), behavior: "domain".into(), format: None, target_proxy: "DIRECT".into() }
    }
    #[test]
    fn formats_handle_yaml_txt_and_reject_classical_mrs() {
        let raw = "proxies: []\nrules: []\n";
        let mut provider = spec("format");
        provider.url = "https://raw.githubusercontent.com/Loyalsoldier/clash-rules/release/private.txt".into();
        let value: serde_yaml::Value = serde_yaml::from_str(&edit_rule_provider(raw, "format", Some(&provider)).unwrap()).unwrap();
        assert_eq!(value["rule-providers"]["format"]["format"].as_str(), Some("yaml"));
        provider.format = Some("text".into());
        let value: serde_yaml::Value = serde_yaml::from_str(&edit_rule_provider(raw, "format", Some(&provider)).unwrap()).unwrap();
        assert_eq!(value["rule-providers"]["format"]["format"].as_str(), Some("text"));
        provider.format = Some("mrs".into()); provider.behavior = "classical".into();
        assert!(edit_rule_provider(raw, "format", Some(&provider)).is_err());
    }
    #[test]
    fn add_update_remove_preserves_sibling_providers_and_rules() {
        let raw = "proxies: []\nrule-providers:\n  first: {type: http, url: 'https://example.org/one', behavior: domain, path: './ruleset/one.yaml'}\n  keep: {type: http, url: 'https://example.org/two', behavior: domain, path: './ruleset/two.yaml'}\nrules:\n- RULE-SET,first,DIRECT\n- RULE-SET,keep,REJECT\n- MATCH,DIRECT\n";
        let added = edit_rule_provider(raw, "first", Some(&spec("first"))).unwrap();
        let again = edit_rule_provider(&added, "first", Some(&spec("first"))).unwrap();
        let value: serde_yaml::Value = serde_yaml::from_str(&again).unwrap();
        assert_eq!(value["rule-providers"].as_mapping().unwrap().len(), 2);
        assert_eq!(value["rule-providers"]["first"]["format"].as_str(), Some("text"));
        assert_eq!(value["rules"].as_sequence().unwrap().len(), 3);
        let removed = edit_rule_provider(&again, "first", None).unwrap();
        let value: serde_yaml::Value = serde_yaml::from_str(&removed).unwrap();
        assert!(value["rule-providers"].get("keep").is_some());
        assert_eq!(value["rules"].as_sequence().unwrap().len(), 2);
        assert_eq!(value["rules"][0].as_str(), Some("RULE-SET,keep,REJECT"));
    }
    #[test]
    fn rejects_path_and_yaml_injection_names() {
        for name in ["../file", "a/b", "a\\b", "a\nport", "a,b"] {
            assert!(edit_rule_provider("proxies: []", name, Some(&spec(name))).is_err());
        }
    }
    #[cfg(windows)]
    #[test]
    fn native_core_accepts_add_update_and_remove() {
        use std::os::windows::process::CommandExt;
        let directory = std::env::temp_dir().join(format!("netbox-rule-test-{}", std::process::id()));
        fs::create_dir_all(directory.join("ruleset")).unwrap();
        fs::write(directory.join("ruleset/test.txt"), b"example.org\n").unwrap();
        let initial = "proxies: []\nrules:\n- MATCH,DIRECT\n";
        let mut provider = spec("test");
        provider.url = "http://127.0.0.1:1/test.txt".into();
        let added = edit_rule_provider(initial, "test", Some(&provider)).unwrap();
        let updated = edit_rule_provider(&added, "test", Some(&provider)).unwrap();
        let removed = edit_rule_provider(&updated, "test", None).unwrap();
        let mut statuses = Vec::new();
        for content in [added, updated, removed] {
            let path = directory.join("config.yaml");
            fs::write(&path, content).unwrap();
            let mut child = std::process::Command::new(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries/mihomo-compatible.exe"))
                .arg("-t").arg("-d").arg(&directory).arg("-f").arg(path)
                .creation_flags(0x08000000).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn().unwrap();
            let start = std::time::Instant::now();
            loop {
                if let Some(status) = child.try_wait().unwrap() { statuses.push(status.success()); break; }
                if start.elapsed().as_secs() >= 5 { child.kill().unwrap(); child.wait().unwrap(); statuses.push(false); break; }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
        }
        fs::remove_dir_all(directory).unwrap();
        assert_eq!(statuses, vec![true, true, true]);
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SmartGroupInjectSpec {
    pub name: String,
    #[serde(rename = "type")]
    pub group_type: String,
    pub proxies: Vec<String>,
    #[serde(default)]
    pub tolerance: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BusinessChannelSpec {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub desc: Option<String>,
    #[serde(rename = "targetType")]
    pub target_type: String,
    #[serde(rename = "targetName")]
    pub target_name: String,
    #[serde(rename = "matchRulesSummary")]
    pub match_rules_summary: Option<String>,
    #[serde(default, rename = "customDomains")]
    pub custom_domains: Vec<String>,
    #[serde(default, rename = "customProcesses")]
    pub custom_processes: Vec<String>,
    #[serde(default, rename = "isCustom")]
    pub is_custom: Option<bool>,
}

pub fn get_smart_groups_file() -> PathBuf {
    get_base_dir().join("config").join("smart_groups.json")
}

pub fn get_business_channels_file() -> PathBuf {
    get_base_dir().join("config").join("business_channels.json")
}

#[tauri::command]
pub fn get_smart_groups() -> Result<Vec<serde_json::Value>, String> {
    let file = get_smart_groups_file();
    if file.exists() {
        let content = fs::read_to_string(&file).map_err(|e| e.to_string())?;
        let val: Vec<serde_json::Value> = serde_json::from_str(&content).unwrap_or_default();
        Ok(val)
    } else {
        Ok(Vec::new())
    }
}

#[tauri::command]
pub fn save_smart_groups(rules: Vec<serde_json::Value>) -> Result<bool, String> {
    let file = get_smart_groups_file();
    let json = serde_json::to_vec_pretty(&rules).map_err(|e| e.to_string())?;
    crate::storage::replace_atomic(&file, &json).map_err(|e| format!("保存智能策略组配置失败: {}", e))?;
    Ok(true)
}

#[tauri::command]
pub fn get_business_channels() -> Result<Vec<BusinessChannelSpec>, String> {
    let file = get_business_channels_file();
    if file.exists() {
        let content = fs::read_to_string(&file).map_err(|e| e.to_string())?;
        let val: Vec<BusinessChannelSpec> = serde_json::from_str(&content).unwrap_or_default();
        Ok(val)
    } else {
        Ok(Vec::new())
    }
}

#[tauri::command]
pub fn save_business_channels(channels: Vec<BusinessChannelSpec>) -> Result<bool, String> {
    let file = get_business_channels_file();
    let json = serde_json::to_vec_pretty(&channels).map_err(|e| e.to_string())?;
    crate::storage::replace_atomic(&file, &json).map_err(|e| format!("保存业务通道配置失败: {}", e))?;
    Ok(true)
}

/// 清洗订阅配置中历史遗留/已固化的业务通道规则 (例如用户已删除的自定义域名、旧节点目标或旧版通道规则)
/// 确保订阅 profile 文件仅保留原生规则与策略组，业务规则完全由 prepare() 在运行时动态挂载
pub fn sanitize_profile_rules(raw: &str) -> (String, bool) {
    let mut yaml: serde_yaml::Value = match serde_yaml::from_str(raw) {
        Ok(v) => v,
        Err(_) => return (raw.to_string(), false),
    };
    let map = match yaml.as_mapping_mut() {
        Some(m) => m,
        None => return (raw.to_string(), false),
    };

    // 收集所有具体代理节点名称 (排除内置策略组与常见通用组)
    let mut proxy_node_names = std::collections::HashSet::new();
    if let Some(proxies) = map.get(serde_yaml::Value::from("proxies")).and_then(|v| v.as_sequence()) {
        for p in proxies {
            if let Some(name) = p.get("name").and_then(|n| n.as_str()) {
                proxy_node_names.insert(name.trim().to_string());
            }
        }
    }

    // 收集预设业务通道域名
    let default_biz_domains: std::collections::HashSet<&'static str> = [
        "openai.com", "chatgpt.com", "anthropic.com", "claude.ai", "oaistatic.com", "oaiusercontent.com",
        "generativelanguage.googleapis.com", "grok.com", "x.ai", "perplexity.ai",
        "youtube.com", "googlevideo.com", "netflix.com", "nflxvideo.net", "disneyplus.com", "spotify.com",
        "telegram.org", "t.me", "slack.com", "notion.so", "zoom.us",
        "github.com", "githubusercontent.com", "docker.com", "docker.io", "npmjs.org", "npmjs.com",
        "steampowered.com", "steamcommunity.com",
    ].into_iter().collect();

    // 收集当前活跃业务通道配置中的所有域名与进程
    let active_channels = get_business_channels().unwrap_or_default();
    let mut active_channel_domains = std::collections::HashSet::new();
    let mut active_channel_procs = std::collections::HashSet::new();
    for ch in &active_channels {
        for d in &ch.custom_domains {
            let clean = d.trim().trim_start_matches("*.").trim_start_matches('.').to_ascii_lowercase();
            if !clean.is_empty() {
                active_channel_domains.insert(clean);
            }
        }
        for p in &ch.custom_processes {
            let clean = p.trim().to_ascii_lowercase();
            if !clean.is_empty() {
                active_channel_procs.insert(clean);
            }
        }
    }

    let mut was_cleaned = false;
    if let Some(rules_entry) = map.get_mut(serde_yaml::Value::from("rules")).and_then(|v| v.as_sequence_mut()) {
        let initial_len = rules_entry.len();
        rules_entry.retain(|r| {
            if let Some(s) = r.as_str() {
                let trimmed = s.trim();
                // 1. 清理旧版注释标记
                if trimmed.contains("#NETBOX_BIZ#") {
                    return false;
                }
                let parts: Vec<&str> = trimmed.split(',').map(|p| p.trim()).collect();
                if parts.len() >= 3 {
                    let rule_type = parts[0].to_ascii_uppercase();
                    let payload = parts[1].trim_start_matches("*.").trim_start_matches('.').to_ascii_lowercase();
                    let target = parts[2];

                    // 2. 如果目标是具体的单一代理节点 (非通用策略组)，且类型为 DOMAIN-SUFFIX 或 PROCESS-NAME，
                    // 说明是 NetBox 自定义分流注入的规则，从 profile 原生文件中清洗剔除
                    if (rule_type == "DOMAIN-SUFFIX" || rule_type == "DOMAIN" || rule_type == "PROCESS-NAME")
                        && proxy_node_names.contains(target)
                    {
                        return false;
                    }

                    // 3. 如果 payload 是 NetBox 预设或活跃业务通道的域名/进程，且类型匹配，从 profile 原生文件中清洗剔除
                    if (rule_type == "DOMAIN-SUFFIX" || rule_type == "DOMAIN")
                        && (default_biz_domains.contains(payload.as_str()) || active_channel_domains.contains(&payload))
                    {
                        return false;
                    }
                    if (rule_type == "PROCESS-NAME" || rule_type == "PROCESS-PATH")
                        && active_channel_procs.contains(&payload)
                    {
                        return false;
                    }
                }
            }
            true
        });
        if rules_entry.len() != initial_len {
            was_cleaned = true;
        }
    }

    if was_cleaned {
        if let Ok(new_str) = serde_yaml::to_string(&yaml) {
            return (new_str, true);
        }
    }
    (raw.to_string(), false)
}

/// 将多轨业务矩阵中的自定义域名与进程规则纯净注入 rules 最前列 (杜绝行尾注释破坏 target 解析)
pub fn compose_business_channels(raw: &str, channels: &[BusinessChannelSpec]) -> Result<String, String> {
    let mut yaml: serde_yaml::Value = serde_yaml::from_str(raw).map_err(|e| e.to_string())?;
    let map = yaml.as_mapping_mut().ok_or("配置必须为对象")?;

    // 收集所有可用的出站目标 (包括 DIRECT, REJECT, proxies, proxy-groups)
    let mut available = std::collections::HashSet::from(["DIRECT".to_string(), "REJECT".to_string()]);
    for section in ["proxies", "proxy-groups"] {
        if let Some(items) = map.get(serde_yaml::Value::from(section)).and_then(|v| v.as_sequence()) {
            for item in items {
                if let Some(name) = item.get("name").and_then(|n| n.as_str()) {
                    available.insert(name.to_string());
                }
            }
        }
    }

    let rules_entry = map.entry(serde_yaml::Value::from("rules"))
        .or_insert(serde_yaml::Value::Sequence(Vec::new()))
        .as_sequence_mut().ok_or("rules 必须为数组")?;

    // 清理旧版可能遗留的 #NETBOX_BIZ# 注释行
    rules_entry.retain(|r| {
        if let Some(s) = r.as_str() {
            !s.contains("#NETBOX_BIZ#")
        } else {
            true
        }
    });

    if channels.is_empty() {
        return serde_yaml::to_string(&yaml).map_err(|e| e.to_string());
    }

    let mut custom_rules_prefix = Vec::new();
    let mut channel_domain_set = std::collections::HashSet::new();
    let mut channel_proc_set = std::collections::HashSet::new();

    for ch in channels {
        let raw_dest = ch.target_name.trim();
        let dest = if !raw_dest.is_empty() && available.contains(raw_dest) {
            raw_dest
        } else if raw_dest.eq_ignore_ascii_case("DIRECT") {
            "DIRECT"
        } else if raw_dest.eq_ignore_ascii_case("REJECT") {
            "REJECT"
        } else {
            "DIRECT"
        };

        for domain in &ch.custom_domains {
            let clean = domain.trim().trim_start_matches("*.").trim_start_matches('.');
            if !clean.is_empty() {
                // 纯净标准的 DOMAIN-SUFFIX 规则，不带任何行尾注释，确保 Mihomo 100% 正确解析 Target
                let rule_str = format!("DOMAIN-SUFFIX,{},{}", clean, dest);
                custom_rules_prefix.push(serde_yaml::Value::String(rule_str));
                channel_domain_set.insert(clean.to_ascii_lowercase());
            }
        }
        for proc in &ch.custom_processes {
            let clean = proc.trim();
            if !clean.is_empty() {
                let rule_str = format!("PROCESS-NAME,{},{}", clean, dest);
                custom_rules_prefix.push(serde_yaml::Value::String(rule_str));
                channel_proc_set.insert(clean.to_ascii_lowercase());
            }
        }
    }

    // 从现存 rules 中剔除与即将注入的域名或进程同名的已有规则 (彻底防止更换目标时旧规则遗留产生重复堆叠)
    rules_entry.retain(|r| {
        if let Some(s) = r.as_str() {
            let parts: Vec<&str> = s.split(',').map(|p| p.trim()).collect();
            if parts.len() >= 2 {
                let rtype = parts[0].to_ascii_uppercase();
                let payload = parts[1].trim_start_matches("*.").trim_start_matches('.').to_ascii_lowercase();
                if (rtype == "DOMAIN-SUFFIX" || rtype == "DOMAIN") && channel_domain_set.contains(&payload) {
                    return false;
                }
                if (rtype == "PROCESS-NAME" || rtype == "PROCESS-PATH") && channel_proc_set.contains(&payload) {
                    return false;
                }
            }
        }
        true
    });

    if !custom_rules_prefix.is_empty() {
        rules_entry.splice(0..0, custom_rules_prefix);
    }

    serde_yaml::to_string(&yaml).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sync_smart_groups_to_core(
    groups: Vec<SmartGroupInjectSpec>,
    channels: Option<Vec<BusinessChannelSpec>>,
) -> Result<bool, String> {
    let _write = PROFILE_WRITE.lock().await;

    // 前端传入 channels 时立即持久化保存并作为当前生效配置
    let _effective_channels = if let Some(chs) = channels {
        save_business_channels(chs.clone())?;
        chs
    } else {
        get_business_channels().unwrap_or_default()
    };

    let list = read_profiles_index();
    let current = list.iter().find(|p| p.is_selected).ok_or("当前未选中任何订阅配置文件")?;
    let full_path = get_base_dir().join(&current.file_path);
    let previous = fs::read(&full_path).map_err(|e| e.to_string())?;
    let previous_str = String::from_utf8_lossy(&previous);

    // 关键：先对原订阅内容进行规则清洗，彻底拔除历史版本写入 full_path 的业务通道与自定义规则
    let (cleaned_str, _) = sanitize_profile_rules(&previous_str);
    let mut yaml: serde_yaml::Value = serde_yaml::from_str(&cleaned_str).map_err(|_| "订阅配置无效")?;
    let map = yaml.as_mapping_mut().ok_or("订阅必须为对象")?;
    let entries = map.entry(serde_yaml::Value::from("proxy-groups"))
        .or_insert(serde_yaml::Value::Sequence(Vec::new()))
        .as_sequence_mut().ok_or("proxy-groups 必须为数组")?;
    // 收集所有已知与历史自建组名称（包括持久化存储与本次传入），以实现按完整期望集合差异更新，避免改名或删除残留
    let mut known_smart_names: std::collections::HashSet<String> = groups.iter().map(|g| g.name.clone()).collect();
    if let Ok(saved_groups) = get_smart_groups() {
        for sg in saved_groups {
            if let Some(n) = sg.get("name").and_then(|v| v.as_str()) {
                known_smart_names.insert(n.to_string());
            }
        }
    }

    // 1. 先从 proxy-groups 中彻底清理所有已知自建组
    entries.retain(|item| {
        let name = item["name"].as_str().unwrap_or("");
        !known_smart_names.contains(name)
    });

    // 2. 清理原生策略组中对已知自建组的旧引用，杜绝残留
    for item in entries.iter_mut() {
        if let Some(item_map) = item.as_mapping_mut() {
            if let Some(proxies_seq) = item_map.get_mut(&serde_yaml::Value::from("proxies")).and_then(|v| v.as_sequence_mut()) {
                proxies_seq.retain(|p| {
                    let p_str = p.as_str().unwrap_or("");
                    !known_smart_names.contains(p_str)
                });
            }
        }
    }

    // 3. 注入本次传入的期望自建组集合
    for group in &groups {
        if group.name.trim().is_empty() { return Err("策略组名称不能为空".into()); }
        let (kind, is_sticky) = match group.group_type.as_str() {
            "select" => ("select", false),
            "url-test" => ("url-test", false),
            "fallback" => ("fallback", false),
            "sticky" => ("fallback", true), // 极稳接力模式在内核映射为顺位 fallback，配合客户端锁定首位节点实现不死不切
            "relay" => ("relay", false),   // 链式中继模式（前置+后置双跳）
            _ => return Err("策略组类型无效".into()),
        };
        let mut value = serde_json::json!({"name": group.name, "type": kind, "proxies": group.proxies});
        if kind != "select" && kind != "relay" {
            value["url"] = "https://cp.cloudflare.com/generate_204".into();
            // 极稳模式使用更长探活周期 (600s)，url-test 使用 300s；统一开启 lazy 杜绝无流量盲测
            value["interval"] = if is_sticky { 600.into() } else { 300.into() };
            value["lazy"] = true.into();
            if let Some(tol) = group.tolerance {
                if kind == "url-test" && tol > 0 {
                    value["tolerance"] = tol.into();
                }
            }
        }
        entries.push(serde_yaml::to_value(value).map_err(|e| e.to_string())?);
    }

    // 4. 将本次生效的自建策略组追加到主 select 策略组 (如 PROXY, 节点选择 等) 的可选列表中
    let smart_group_names: Vec<String> = groups.iter().map(|g| g.name.clone()).collect();
    for item in entries.iter_mut() {
        if let Some(item_map) = item.as_mapping_mut() {
            let item_name = item_map.get(&serde_yaml::Value::from("name")).and_then(|v| v.as_str()).unwrap_or("").to_string();
            let item_type = item_map.get(&serde_yaml::Value::from("type")).and_then(|v| v.as_str()).unwrap_or("");
            // 仅对原订阅的主选择组进行追加，严禁自建组自身循环引用
            if item_type == "select" && !smart_group_names.contains(&item_name) {
                if let Some(proxies_seq) = item_map.get_mut(&serde_yaml::Value::from("proxies")).and_then(|v| v.as_sequence_mut()) {
                    for s_name in &smart_group_names {
                        let val = serde_yaml::Value::from(s_name.as_str());
                        if !proxies_seq.contains(&val) {
                            proxies_seq.insert(0, val);
                        }
                    }
                }
            }
        }
    }

    let content = serde_yaml::to_string(&yaml).map_err(|e| e.to_string())?;
    // 关键修正：绝不调用 compose_business_channels 写入 full_path 订阅原文件！
    // 订阅文件仅保留纯净原生规则与 proxy-groups，业务规则由 apply_profile_to_core -> prepare 运行时动态注入

    validate_config(&super::settings::prepare_config(&content)?)?;
    crate::storage::replace(&full_path, content.as_bytes())?;
    if let Err(error) = apply_profile_to_core(&full_path.to_string_lossy()).await {
        crate::storage::replace(&full_path, &previous)?;
        return Err(error);
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_compose_business_channels_clean_rules() {
        let raw = r#"
proxies:
  - name: JP07
    type: ss
    server: 1.2.3.4
    port: 8388
    cipher: aes-128-gcm
    password: test
proxy-groups:
  - name: PROXY
    type: select
    proxies: [JP07]
rules:
  - GEOIP,CN,DIRECT
  - MATCH,PROXY
"#;
        let channels = vec![
            BusinessChannelSpec {
                id: "ai".into(),
                name: "AI".into(),
                icon: None,
                desc: None,
                target_type: "proxy".into(),
                target_name: "JP07".into(),
                match_rules_summary: None,
                custom_domains: vec!["ping0.cc".into(), "*.ippure.com".into()],
                custom_processes: vec!["chrome.exe".into()],
                is_custom: Some(false),
            },
        ];

        let composed = compose_business_channels(raw, &channels).unwrap();
        let val: serde_yaml::Value = serde_yaml::from_str(&composed).unwrap();
        let rules = val["rules"].as_sequence().unwrap();

        // 必须注入在最前列
        assert_eq!(rules[0].as_str(), Some("DOMAIN-SUFFIX,ping0.cc,JP07"));
        assert_eq!(rules[1].as_str(), Some("DOMAIN-SUFFIX,ippure.com,JP07"));
        assert_eq!(rules[2].as_str(), Some("PROCESS-NAME,chrome.exe,JP07"));
        // 且原有规则顺序在后
        assert_eq!(rules[3].as_str(), Some("GEOIP,CN,DIRECT"));
        assert_eq!(rules[4].as_str(), Some("MATCH,PROXY"));

        // 再次注入排重测试：不应出现重复
        let double_composed = compose_business_channels(&composed, &channels).unwrap();
        let double_val: serde_yaml::Value = serde_yaml::from_str(&double_composed).unwrap();
        let double_rules = double_val["rules"].as_sequence().unwrap();
        assert_eq!(double_rules.len(), rules.len());
    }

    #[test]
    fn test_compose_business_channels_replace_target() {
        let raw = r#"
proxies:
  - name: JP07
    type: ss
    server: 1.2.3.4
    port: 8388
    cipher: aes-128-gcm
    password: test
  - name: US04
    type: ss
    server: 1.2.3.4
    port: 8389
    cipher: aes-128-gcm
    password: test
proxy-groups:
  - name: PROXY
    type: select
    proxies: [JP07, US04]
rules:
  - GEOIP,CN,DIRECT
  - MATCH,PROXY
"#;
        let channels1 = vec![
            BusinessChannelSpec {
                id: "c1".into(),
                name: "C1".into(),
                icon: None,
                desc: None,
                target_type: "proxy".into(),
                target_name: "JP07".into(),
                match_rules_summary: None,
                custom_domains: vec!["ippure.com".into()],
                custom_processes: vec![],
                is_custom: Some(true),
            },
        ];
        let composed1 = compose_business_channels(raw, &channels1).unwrap();

        // 变更目标为 US04
        let channels2 = vec![
            BusinessChannelSpec {
                id: "c1".into(),
                name: "C1".into(),
                icon: None,
                desc: None,
                target_type: "proxy".into(),
                target_name: "US04".into(),
                match_rules_summary: None,
                custom_domains: vec!["ippure.com".into()],
                custom_processes: vec![],
                is_custom: Some(true),
            },
        ];
        let composed2 = compose_business_channels(&composed1, &channels2).unwrap();
        let val: serde_yaml::Value = serde_yaml::from_str(&composed2).unwrap();
        let rules = val["rules"].as_sequence().unwrap();

        // 验证只存在一条 ippure.com 规则且目标为新的 US04，杜绝两条并存
        let ippure_rules: Vec<_> = rules.iter().filter(|r| r.as_str().unwrap_or("").contains("ippure.com")).collect();
        assert_eq!(ippure_rules.len(), 1);
        assert_eq!(ippure_rules[0].as_str(), Some("DOMAIN-SUFFIX,ippure.com,US04"));
    }

    #[test]
    fn test_sanitize_profile_rules_removes_injected_rules() {
        let contaminated = r#"
proxies:
  - name: JP07
    type: ss
    server: 1.2.3.4
    port: 8388
    cipher: aes-128-gcm
    password: test
proxy-groups:
  - name: PROXY
    type: select
    proxies: [JP07]
rules:
  - DOMAIN-SUFFIX,openai.com,DIRECT
  - DOMAIN-SUFFIX,ping0.cc,JP07
  - DOMAIN-SUFFIX,inets.io,PROXY
  - MATCH,PROXY
"#;
        let (cleaned, was_cleaned) = sanitize_profile_rules(contaminated);
        assert!(was_cleaned);
        let val: serde_yaml::Value = serde_yaml::from_str(&cleaned).unwrap();
        let rules = val["rules"].as_sequence().unwrap();
        // openai.com 与 ping0.cc (指向节点 JP07) 均被剔除，原生 inets.io 与 MATCH 保留
        assert_eq!(rules.len(), 2);
        assert_eq!(rules[0].as_str(), Some("DOMAIN-SUFFIX,inets.io,PROXY"));
        assert_eq!(rules[1].as_str(), Some("MATCH,PROXY"));
    }
}


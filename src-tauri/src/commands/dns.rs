use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DnsSettings {
    #[serde(default)]
    pub enable_override: bool,
    #[serde(default = "default_true")]
    pub status: bool,
    #[serde(default = "default_listen")]
    pub listen: String,
    #[serde(default = "default_enhanced_mode")]
    pub enhanced_mode: String,
    #[serde(default = "default_fake_ip_range")]
    pub fake_ip_range: String,
    #[serde(default = "default_fake_ip_filter")]
    pub fake_ip_filter: Vec<String>,
    #[serde(default = "default_true")]
    pub use_hosts: bool,
    #[serde(default = "default_true")]
    pub use_system_hosts: bool,
    #[serde(default)]
    pub respect_rules: bool,
    #[serde(default)]
    pub prefer_h3: bool,
    #[serde(default)]
    pub ipv6: bool,
    #[serde(default = "default_nameserver_ips")]
    pub default_nameserver: Vec<String>,
    #[serde(default = "default_nameservers")]
    pub nameserver: Vec<String>,
    #[serde(default = "default_fallbacks")]
    pub fallback: Vec<String>,
    #[serde(default = "default_nameserver_ips")]
    pub proxy_server_nameserver: Vec<String>,
    #[serde(default)]
    pub append_system_dns: bool,
    #[serde(default)]
    pub nameserver_policy: std::collections::HashMap<String, String>,
    #[serde(default = "default_true")]
    pub fallback_filter_geoip: bool,
    #[serde(default = "default_geoip_code")]
    pub fallback_filter_geoip_code: String,
    #[serde(default = "default_geosite")]
    pub fallback_filter_geosite: Vec<String>,
    #[serde(default = "default_ipcidr")]
    pub fallback_filter_ipcidr: Vec<String>,
    #[serde(default)]
    pub fallback_filter_domain: Vec<String>,
}

fn default_true() -> bool { true }
fn default_listen() -> String { "0.0.0.0:1053".into() }
fn default_enhanced_mode() -> String { "fake-ip".into() }
fn default_fake_ip_range() -> String { "198.18.0.1/16".into() }
fn default_geoip_code() -> String { "CN".into() }
fn default_geosite() -> Vec<String> { vec!["gfw".into()] }
fn default_ipcidr() -> Vec<String> { vec!["240.0.0.0/4".into()] }
fn default_nameserver_ips() -> Vec<String> {
    vec!["223.5.5.5".into(), "119.29.29.29".into()]
}
fn default_nameservers() -> Vec<String> {
    vec![
        "https://dns.alidns.com/dns-query".into(),
        "https://doh.pub/dns-query".into(),
    ]
}
fn default_fallbacks() -> Vec<String> {
    vec![
        "https://1.1.1.1/dns-query".into(),
        "https://8.8.8.8/dns-query".into(),
    ]
}
fn default_fake_ip_filter() -> Vec<String> {
    vec![
        "*.lan".into(),
        "*.local".into(),
        "localhost.ptlogin2.qq.com".into(),
        "+.msftconnecttest.com".into(),
        "+.msftncsi.com".into(),
        "*.msftncsi.com".into(),
        "+.market.xiaomi.com".into(),
    ]
}

impl Default for DnsSettings {
    fn default() -> Self {
        Self {
            enable_override: false,
            status: true,
            listen: default_listen(),
            enhanced_mode: default_enhanced_mode(),
            fake_ip_range: default_fake_ip_range(),
            fake_ip_filter: default_fake_ip_filter(),
            use_hosts: true,
            use_system_hosts: true,
            respect_rules: false,
            prefer_h3: false,
            ipv6: false,
            default_nameserver: default_nameserver_ips(),
            nameserver: default_nameservers(),
            fallback: default_fallbacks(),
            proxy_server_nameserver: default_nameserver_ips(),
            append_system_dns: false,
            nameserver_policy: std::collections::HashMap::new(),
            fallback_filter_geoip: true,
            fallback_filter_geoip_code: default_geoip_code(),
            fallback_filter_geosite: default_geosite(),
            fallback_filter_ipcidr: default_ipcidr(),
            fallback_filter_domain: Vec::new(),
        }
    }
}

#[tauri::command]
pub fn get_dns_settings() -> Result<DnsSettings, String> {
    let path = crate::storage::data_dir().join("config/dns-preferences.json");
    if !path.exists() {
        return Ok(DnsSettings::default());
    }
    serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|_| "DNS 偏好设置损坏，已恢复默认".into())
}

impl DnsSettings {
    pub fn validate(&self) -> Result<(), String> {
        super::dns_runtime::parse_listen(&self.listen)?;

        if !matches!(self.enhanced_mode.as_str(), "fake-ip" | "redir-host" | "normal") {
            return Err(format!("未知的增强模式: {}", self.enhanced_mode));
        }

        if self.nameserver.is_empty() {
            return Err("主 DNS 服务器列表 (nameserver) 不能为空".into());
        }

        Ok(())
    }
}

#[tauri::command]
pub async fn save_dns_settings(
    mut settings: DnsSettings,
    state: tauri::State<'_, super::process::CoreStateMutex>,
) -> Result<DnsSettings, String> {
    settings.validate()?;
    settings.listen = super::dns_runtime::parse_listen(&settings.listen)?.to_string();

    let _lifecycle = super::process::LIFECYCLE.lock().await;
    let path = crate::storage::data_dir().join("config/dns-preferences.json");
    let bytes = serde_json::to_vec_pretty(&settings).map_err(|e| e.to_string())?;
    let write_path = path.clone();
    let previous_bytes = tokio::task::spawn_blocking(move || {
        let previous = match std::fs::read(&write_path) {
            Ok(bytes) => Some(bytes),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(_) => return Err("无法读取原 DNS 配置，未覆盖".to_string()),
        };
        crate::storage::replace(&write_path, &bytes)?;
        Ok(previous)
    }).await.map_err(|_| "保存 DNS 配置任务失败")??;

    // 若核心当前正在运行，由于 DNS 覆写影响底层网络，重启核心以应用新 DNS
    let (running, mode) = {
        let mut core = state.lock().map_err(|_| "读取核心状态失败")?;
        let is_running = match core.child.as_mut() {
            Some(child) => child.try_wait().map_err(|_| "读取核心状态失败")?.is_none(),
            None => false,
        };
        let mode = core.core_mode.clone();
        (is_running, mode)
    };

    if running {
        {
            let mut core = state.lock().map_err(|_| "读取核心状态失败")?;
            super::process::stop_owned_child(&mut core)?;
        }
        if let Err(e) = super::process::start_core_locked(mode.clone(), &state).await {
            // 核心加载新配置失败，回滚原始 DNS 配置
            let rollback = tokio::task::spawn_blocking(move || match previous_bytes {
                Some(previous) => crate::storage::replace(&path, &previous),
                None => std::fs::remove_file(&path).map_err(|error| error.to_string()),
            }).await.map_err(|_| "DNS 配置回滚任务失败")?;
            if let Err(error) = rollback { return Err(format!("应用新 DNS 配置失败：{e}；回滚失败：{error}")); }
            let restored = super::process::start_core_locked(mode, &state).await;
            return Err(format!("应用新 DNS 配置失败：{e}；原配置已回滚{}", restored.err().map(|error| format!("，但核心恢复失败：{error}")).unwrap_or_default()));
        }
    }

    Ok(settings)
}

/// 将 DNS 偏好构建为标准 Mihomo (Clash.Meta) YAML 映射
pub fn build_dns_mapping(settings: &DnsSettings) -> serde_yaml::Value {
    let mut map = serde_yaml::Mapping::new();
    map.insert("enable".into(), settings.status.into());
    map.insert("listen".into(), settings.listen.clone().into());
    map.insert("ipv6".into(), settings.ipv6.into());
    map.insert("enhanced-mode".into(), settings.enhanced_mode.clone().into());
    map.insert("fake-ip-range".into(), settings.fake_ip_range.clone().into());
    map.insert("use-hosts".into(), settings.use_hosts.into());
    map.insert("use-system-hosts".into(), settings.use_system_hosts.into());
    map.insert("respect-rules".into(), settings.respect_rules.into());
    map.insert("prefer-h3".into(), settings.prefer_h3.into());
    map.insert("append-system-dns".into(), settings.append_system_dns.into());

    let fake_filter_seq: Vec<serde_yaml::Value> = settings
        .fake_ip_filter
        .iter()
        .map(|s| serde_yaml::Value::from(s.clone()))
        .collect();
    map.insert("fake-ip-filter".into(), serde_yaml::Value::Sequence(fake_filter_seq));

    let default_ns: Vec<serde_yaml::Value> = settings
        .default_nameserver
        .iter()
        .map(|s| serde_yaml::Value::from(s.clone()))
        .collect();
    map.insert("default-nameserver".into(), serde_yaml::Value::Sequence(default_ns));

    let ns: Vec<serde_yaml::Value> = settings
        .nameserver
        .iter()
        .map(|s| serde_yaml::Value::from(s.clone()))
        .collect();
    map.insert("nameserver".into(), serde_yaml::Value::Sequence(ns));

    let fb: Vec<serde_yaml::Value> = settings
        .fallback
        .iter()
        .map(|s| serde_yaml::Value::from(s.clone()))
        .collect();
    map.insert("fallback".into(), serde_yaml::Value::Sequence(fb));

    let proxy_ns: Vec<serde_yaml::Value> = settings
        .proxy_server_nameserver
        .iter()
        .map(|s| serde_yaml::Value::from(s.clone()))
        .collect();
    map.insert(
        "proxy-server-nameserver".into(),
        serde_yaml::Value::Sequence(proxy_ns),
    );

    // 域名服务器策略 (nameserver-policy)
    if !settings.nameserver_policy.is_empty() {
        let mut policy_map = serde_yaml::Mapping::new();
        for (k, v) in &settings.nameserver_policy {
            if !k.trim().is_empty() && !v.trim().is_empty() {
                policy_map.insert(
                    serde_yaml::Value::from(k.clone()),
                    serde_yaml::Value::from(v.clone()),
                );
            }
        }
        if !policy_map.is_empty() {
            map.insert("nameserver-policy".into(), serde_yaml::Value::Mapping(policy_map));
        }
    }

    let mut fb_filter = serde_yaml::Mapping::new();
    fb_filter.insert("geoip".into(), settings.fallback_filter_geoip.into());
    fb_filter.insert(
        "geoip-code".into(),
        settings.fallback_filter_geoip_code.clone().into(),
    );
    if !settings.fallback_filter_geosite.is_empty() {
        let seq: Vec<serde_yaml::Value> = settings
            .fallback_filter_geosite
            .iter()
            .map(|s| serde_yaml::Value::from(s.clone()))
            .collect();
        fb_filter.insert("geosite".into(), serde_yaml::Value::Sequence(seq));
    }
    if !settings.fallback_filter_ipcidr.is_empty() {
        let seq: Vec<serde_yaml::Value> = settings
            .fallback_filter_ipcidr
            .iter()
            .map(|s| serde_yaml::Value::from(s.clone()))
            .collect();
        fb_filter.insert("ipcidr".into(), serde_yaml::Value::Sequence(seq));
    }
    if !settings.fallback_filter_domain.is_empty() {
        let seq: Vec<serde_yaml::Value> = settings
            .fallback_filter_domain
            .iter()
            .map(|s| serde_yaml::Value::from(s.clone()))
            .collect();
        fb_filter.insert("domain".into(), serde_yaml::Value::Sequence(seq));
    }
    map.insert(
        "fallback-filter".into(),
        serde_yaml::Value::Mapping(fb_filter),
    );

    serde_yaml::Value::Mapping(map)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_dns_defaults_and_yaml_builder() {
        let mut settings = DnsSettings::default();
        assert_eq!(settings.enhanced_mode, "fake-ip");
        assert_eq!(settings.fallback_filter_geoip_code, "CN");
        assert_eq!(settings.append_system_dns, false);
        assert_eq!(settings.fallback_filter_geosite, vec!["gfw"]);
        assert_eq!(settings.fallback_filter_ipcidr, vec!["240.0.0.0/4"]);

        settings.append_system_dns = true;
        settings.nameserver_policy.insert("geosite:cn".into(), "https://dns.alidns.com/dns-query".into());
        settings.fallback_filter_domain.push("+.google.com".into());

        let yaml = build_dns_mapping(&settings);
        assert_eq!(yaml["enable"].as_bool(), Some(true));
        assert_eq!(yaml["enhanced-mode"].as_str(), Some("fake-ip"));
        assert_eq!(yaml["listen"].as_str(), Some("0.0.0.0:1053"));
        assert_eq!(yaml["fake-ip-range"].as_str(), Some("198.18.0.1/16"));
        assert_eq!(yaml["append-system-dns"].as_bool(), Some(true));
        assert_eq!(yaml["fallback-filter"]["geoip-code"].as_str(), Some("CN"));
        assert_eq!(yaml["fallback-filter"]["geosite"][0].as_str(), Some("gfw"));
        assert_eq!(yaml["fallback-filter"]["ipcidr"][0].as_str(), Some("240.0.0.0/4"));
        assert_eq!(yaml["fallback-filter"]["domain"][0].as_str(), Some("+.google.com"));
        assert_eq!(yaml["nameserver-policy"]["geosite:cn"].as_str(), Some("https://dns.alidns.com/dns-query"));
        assert!(yaml["nameserver"].as_sequence().unwrap().len() >= 2);
    }
}

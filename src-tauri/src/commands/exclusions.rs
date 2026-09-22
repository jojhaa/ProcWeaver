use serde::{Deserialize, Serialize};
use serde_yaml::Value;
use std::net::IpAddr;

#[derive(Clone, Default, Serialize, Deserialize)]
pub struct Exclusions {
    pub enabled: bool,
    pub entries: Vec<String>,
}

fn path() -> std::path::PathBuf { crate::storage::data_dir().join("config/exclusions.json") }

#[tauri::command]
pub fn get_exclusions() -> Result<Exclusions, String> {
    if !path().exists() { return Ok(Exclusions { enabled: true, entries: vec![] }); }
    serde_json::from_slice(&std::fs::read(path()).map_err(|_| "读取排除配置失败")?)
        .map_err(|_| "排除配置损坏，请恢复备份".into())
}

fn entry_rule(entry: &str) -> Result<String, String> {
    if let Ok(ip) = entry.parse::<IpAddr>() {
        return Ok(format!("IP-CIDR,{ip}/{},DIRECT", if ip.is_ipv4() { 32 } else { 128 }));
    }
    if let Some((address, prefix)) = entry.split_once('/') {
        let ip: IpAddr = address.parse().map_err(|_| "IP 地址无效")?;
        let bits: u8 = prefix.parse().map_err(|_| "CIDR 前缀无效")?;
        if bits > if ip.is_ipv4() { 32 } else { 128 } { return Err("CIDR 前缀超出范围".into()); }
        return Ok(format!("IP-CIDR,{ip}/{bits},DIRECT"));
    }
    let (kind, domain) = if let Some(domain) = entry.strip_prefix("+.") {
        ("DOMAIN-SUFFIX", domain)
    } else if entry.contains(['*', '?']) { ("DOMAIN-WILDCARD", entry) }
    else { ("DOMAIN", entry) };
    if domain.is_empty() || domain.len() > 253 || !domain.bytes().any(|b| b.is_ascii_alphabetic())
        || domain.split('.').any(|label| label.is_empty() || label.len() > 63
            || label.starts_with('-') || label.ends_with('-')
            || !label.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'
                || (kind == "DOMAIN-WILDCARD" && matches!(b, b'*' | b'?')))) {
        return Err("请输入有效域名（中文请使用 Punycode）、通配域名或 IP/CIDR，不要填写网址、端口或规则语句".into());
    }
    Ok(format!("{kind},{domain},DIRECT"))
}

fn normalize(mut config: Exclusions) -> Result<Exclusions, String> {
    if config.entries.len() > 2000 { return Err("排除项最多 2000 条".into()); }
    let mut seen = std::collections::HashSet::new();
    let mut entries = Vec::new();
    for (index, entry) in config.entries.iter().enumerate() {
        let entry = entry.trim().to_ascii_lowercase();
        if entry.is_empty() { continue; }
        if entry.len() > 255 { return Err(format!("第 {} 行过长", index + 1)); }
        entry_rule(&entry).map_err(|error| format!("第 {} 行：{error}", index + 1))?;
        if seen.insert(entry.clone()) { entries.push(entry); }
    }
    config.entries = entries;
    Ok(config)
}

/// 用户明确排除的目标优先直连；不改写原订阅或自动补充方案。
pub fn compose(raw: &str, config: &Exclusions) -> Result<String, String> {
    let config = normalize(config.clone())?;
    if !config.enabled || config.entries.is_empty() { return Ok(raw.into()); }
    let mut yaml: Value = serde_yaml::from_str(raw).map_err(|_| "配置 YAML 无效")?;
    let rules = yaml.as_mapping_mut().ok_or("配置须为对象")?
        .entry(Value::from("rules")).or_insert(Value::Sequence(vec![]))
        .as_sequence_mut().ok_or("rules 须为数组")?;
    let prefix = config.entries.iter().map(|e| entry_rule(e).map(Value::from)).collect::<Result<Vec<_>, _>>()?;
    rules.splice(0..0, prefix);
    serde_yaml::to_string(&yaml).map_err(|_| "生成排除规则失败".into())
}

#[tauri::command]
pub async fn save_exclusions(config: Exclusions) -> Result<Exclusions, String> {
    let _lock = super::profile::PROFILE_WRITE.lock().await;
    let config = normalize(config)?;
    let selected = super::profile::read_profiles_index().into_iter().find(|p| p.is_selected);
    let source = selected.map(|p| super::profile::get_base_dir().join(p.file_path));
    if let Some(source) = &source {
        let raw = std::fs::read_to_string(source).map_err(|_| "读取订阅失败")?;
        let prepared = super::settings::prepare_with(&raw, &super::settings::get_general_settings()?)?;
        let prepared = super::local_rules::compose(&prepared, &super::local_rules::get_local_rule_plan()?)?;
        super::profile::validate_config(&compose(&prepared, &config)?)?;
    }
    persist_and_apply(&path(), &config, async {
        if let Some(source) = source {
            super::profile::apply_profile_to_core(&source.to_string_lossy()).await?;
        }
        Ok(())
    }).await?;
    Ok(config)
}

async fn persist_and_apply(path: &std::path::Path, config: &Exclusions,
    apply: impl std::future::Future<Output = Result<(), String>>) -> Result<(), String> {
    let previous = if path.exists() { Some(std::fs::read(path).map_err(|_| "读取旧排除配置失败")?) } else { None };
    crate::storage::replace(path, &serde_json::to_vec_pretty(config).map_err(|_| "序列化排除配置失败")?)?;
    if let Err(error) = apply.await {
        if let Some(bytes) = previous { crate::storage::replace(path, &bytes)?; }
        else { std::fs::remove_file(path).map_err(|_| "恢复排除配置失败")?; }
        return Err(error);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn failed_apply_restores_previous_or_absent_file() {
        let directory = std::env::temp_dir().join(format!("netbox-exclusions-rollback-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("exclusions.json");
        let original = b"{\"enabled\":false,\"entries\":[\"old.example.com\"]}";
        std::fs::write(&path, original).unwrap();
        let candidate = Exclusions { enabled: true, entries: vec!["new.example.com".into()] };
        assert!(persist_and_apply(&path, &candidate, async { Err("模拟应用失败".into()) }).await.is_err());
        assert_eq!(std::fs::read(&path).unwrap(), original);
        std::fs::remove_file(&path).unwrap();
        assert!(persist_and_apply(&path, &candidate, async { Err("模拟首次应用失败".into()) }).await.is_err());
        assert!(!path.exists());
        persist_and_apply(&path, &candidate, async { Ok(()) }).await.unwrap();
        let saved: Exclusions = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(saved.entries, candidate.entries);
        std::fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn validates_types_and_rejects_injection() {
        for (input, expected) in [("example.com", "DOMAIN,example.com,DIRECT"),
            ("+.example.com", "DOMAIN-SUFFIX,example.com,DIRECT"),
            ("*.example.com", "DOMAIN-WILDCARD,*.example.com,DIRECT"),
            ("api?.example.com", "DOMAIN-WILDCARD,api?.example.com,DIRECT"),
            ("1.2.3.4", "IP-CIDR,1.2.3.4/32,DIRECT"),
            ("::1", "IP-CIDR,::1/128,DIRECT"),
            ("2001:db8::/32", "IP-CIDR,2001:db8::/32,DIRECT")] {
            assert_eq!(entry_rule(input).unwrap(), expected);
        }
        for input in ["1.2.3.999", "1.2.3.4/33", "::1/129", "https://example.com", "a.com,DIRECT", "a\nb.com", "*", "+.*.com", "a..com", "example.com:443"] {
            assert!(entry_rule(input).is_err(), "accepted {input}");
        }
    }
    #[test]
    fn local_and_subscription_rules_remain_after_exclusions() {
        let config = Exclusions { enabled: true, entries: vec![" EXAMPLE.COM ".into(), "example.com".into()] };
        for raw in ["rules: [MATCH,REJECT]\n", "rules: ['DOMAIN,example.com,REJECT', 'MATCH,REJECT']\n"] {
            let result: Value = serde_yaml::from_str(&compose(raw, &config).unwrap()).unwrap();
            let original: Value = serde_yaml::from_str(raw).unwrap();
            let rules = result["rules"].as_sequence().unwrap();
            assert_eq!(rules[0].as_str(), Some("DOMAIN,example.com,DIRECT"));
            assert_eq!(&rules[1..], original["rules"].as_sequence().unwrap());
            assert_eq!(compose(raw, &Exclusions { enabled: false, ..config.clone() }).unwrap(), raw);
        }
        assert!(normalize(Exclusions { enabled: true, entries: vec!["a.com".into(); 2001] }).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn native_core_accepts_exclusions_before_subscription_rules() {
        use std::os::windows::process::CommandExt;
        let config = Exclusions { enabled: true, entries: vec!["example.com", "+.example.org", "*.example.net", "api?.example.net", "192.0.2.1", "192.0.2.0/24", "::1", "2001:db8::/32"].into_iter().map(String::from).collect() };
        let raw = "mixed-port: 0\nproxies: []\nrules: ['DOMAIN,example.com,REJECT', 'MATCH,REJECT']\n";
        let directory = std::env::temp_dir().join(format!("netbox-exclusions-test-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join("config.yaml"), compose(raw, &config).unwrap()).unwrap();
        let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let result = std::process::Command::new(root.join("binaries/mihomo-compatible.exe"))
            .arg("-t").arg("-d").arg(&directory).creation_flags(0x08000000).output().unwrap();
        std::fs::remove_dir_all(directory).unwrap();
        assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stdout));
    }
}

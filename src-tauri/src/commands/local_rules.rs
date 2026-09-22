use serde::{Deserialize, Serialize};
use serde_yaml::Value;
use super::profile::{self, RuleProviderSpec};

const GROUP: &str = "本地方案·节点选择";
const CATEGORY_GROUPS: &[&str] = &["本地方案·AI", "本地方案·流媒体", "本地方案·通信", "本地方案·开发", "本地方案·游戏", "本地方案·微软"];

fn provider_priority(name: &str) -> u64 {
    static PRIORITIES: std::sync::OnceLock<std::collections::HashMap<String, u64>> = std::sync::OnceLock::new();
    *PRIORITIES.get_or_init(|| {
        let entries: Vec<serde_json::Value> = serde_json::from_str(include_str!("../../../src/data/localRulePresets.json")).expect("内置规则目录格式");
        entries.into_iter().map(|p| (p["name"].as_str().unwrap().to_owned(), p["priority"].as_u64().unwrap_or(100))).collect()
    }).get(name).unwrap_or(&100)
}

pub(crate) fn local_target(target: &str) -> &str {
    if matches!(target, "DIRECT" | "REJECT") || CATEGORY_GROUPS.contains(&target) { target } else { GROUP }
}

pub fn preset_providers() -> Vec<RuleProviderSpec> {
    let entries: Vec<serde_json::Value> = serde_json::from_str(include_str!("../../../src/data/localRulePresets.json")).expect("内置规则目录格式");
    entries.into_iter().filter(|entry| entry["enabledByDefault"].as_bool() == Some(true))
        .map(|entry| serde_json::from_value(entry).expect("内置规则定义")).collect()
}

#[derive(Clone, Serialize, Deserialize)]
pub struct LocalRulePlan {
    pub enabled: bool,
    pub providers: Vec<RuleProviderSpec>,
}

impl Default for LocalRulePlan {
    fn default() -> Self { Self { enabled: true, providers: preset_providers() } }
}

fn path() -> std::path::PathBuf { crate::storage::data_dir().join("config/local-rules.json") }

pub fn initialize() -> Result<(), String> {
    if !path().exists() {
        crate::storage::replace(&path(), &serde_json::to_vec_pretty(&LocalRulePlan::default()).map_err(|e| e.to_string())?)?;
    }
    Ok(())
}

#[tauri::command]
pub fn get_local_rule_plan() -> Result<LocalRulePlan, String> {
    if !path().exists() { return Ok(LocalRulePlan::default()); }
    serde_json::from_slice(&std::fs::read(path()).map_err(|_| "读取本地规则方案失败")?)
        .map_err(|_| "本地规则方案损坏，请恢复备份".into())
}

// 切换流量分流方案时，DNS 仍可能通过策略键或 fake-ip-filter 引用订阅规则集。
fn dns_provider_names(value: &Value, names: &mut std::collections::HashSet<String>) {
    match value {
        Value::String(text) => {
            let text = text.trim();
            let lower = text.to_ascii_lowercase();
            if lower.starts_with("rule-set:") {
                names.extend(text[9..].split(',').map(|s| s.trim().to_string()));
            } else if lower.starts_with("rule-set,") {
                if let Some(name) = text.split(',').nth(1) { names.insert(name.trim().to_string()); }
            }
        }
        Value::Sequence(items) => { for item in items { dns_provider_names(item, names); } }
        Value::Mapping(items) => { for (key, value) in items { dns_provider_names(key, names); dns_provider_names(value, names); } }
        _ => {}
    }
}

/// 仅合成运行配置，不回写订阅。稳定策略组独立于订阅提供的组名。
pub fn compose(raw: &str, plan: &LocalRulePlan) -> Result<String, String> {
    if !plan.enabled { return Ok(raw.into()); }
    let mut yaml: Value = serde_yaml::from_str(raw).map_err(|_| "配置 YAML 无效")?;
    // 订阅有实际分流规则时优先使用；空规则、只有 MATCH/FINAL 时使用本地方案。
    if yaml["rules"].as_sequence().is_some_and(|rules| rules.iter().any(|rule| {
        rule.as_str().is_some_and(|s| !matches!(s.split(',').next().unwrap_or("").trim().to_ascii_uppercase().as_str(), "MATCH" | "FINAL" | ""))
    })) { return Ok(raw.into()); }
    let mut nodes: Vec<Value> = yaml["proxies"].as_sequence().into_iter().flatten()
        .filter_map(|node| node["name"].as_str().map(Value::from)).collect();
    let uses: Vec<Value> = yaml["proxy-providers"].as_mapping().into_iter().flatten()
        .map(|(name, _)| name.clone()).collect();
    if nodes.is_empty() && uses.is_empty() { nodes.push("REJECT".into()); }
    let groups = yaml.as_mapping_mut().ok_or("配置须为对象")?
        .entry(Value::from("proxy-groups")).or_insert(Value::Sequence(vec![]))
        .as_sequence_mut().ok_or("proxy-groups 须为数组")?;
    if groups.iter().any(|g| g["name"].as_str() == Some(GROUP)) {
        return Err("订阅策略组与本地方案保留名称冲突".into());
    }
    groups.push(serde_yaml::to_value(serde_json::json!({
        "name": GROUP, "type": "select", "proxies": &nodes, "use": &uses
    })).map_err(|e| e.to_string())?);
    for category in CATEGORY_GROUPS {
        if !plan.providers.iter().any(|provider| provider.target_proxy == *category) { continue; }
        if groups.iter().any(|g| g["name"].as_str() == Some(category)) || nodes.iter().any(|n| n.as_str() == Some(category)) {
            return Err("订阅名称与本地分类策略组冲突".into());
        }
        let mut choices = vec![Value::from(GROUP), Value::from("DIRECT")];
        choices.extend(nodes.clone());
        groups.push(serde_yaml::to_value(serde_json::json!({
            "name": category, "type": "select", "proxies": choices, "use": &uses
        })).map_err(|e| e.to_string())?);
    }
    let profile = yaml.as_mapping_mut().unwrap().entry(Value::from("profile"))
        .or_insert(Value::Mapping(Default::default()));
    profile.as_mapping_mut().ok_or("profile 须为对象")?.insert("store-selected".into(), true.into());
    let mut dns_names = std::collections::HashSet::new();
    dns_provider_names(&yaml["dns"], &mut dns_names);
    let mut dns_providers = serde_yaml::Mapping::new();
    for name in &dns_names {
        if let Some(provider) = yaml["rule-providers"].get(name.as_str()) {
            if plan.providers.iter().any(|p| p.name == *name) {
                return Err(format!("订阅 DNS 引用的规则集 {name} 与本地方案同名，请先调整本地规则集名称"));
            }
            dns_providers.insert(name.clone().into(), provider.clone());
        }
    }
    yaml["rule-providers"] = Value::Mapping(dns_providers);
    yaml["rules"] = serde_yaml::to_value(vec![
        "IP-CIDR,127.0.0.0/8,DIRECT,no-resolve".to_string(),
        "IP-CIDR,10.0.0.0/8,DIRECT,no-resolve".into(),
        "IP-CIDR,172.16.0.0/12,DIRECT,no-resolve".into(),
        "IP-CIDR,192.168.0.0/16,DIRECT,no-resolve".into(),
        "IP-CIDR6,::1/128,DIRECT,no-resolve".into(),
        "IP-CIDR6,fc00::/7,DIRECT,no-resolve".into(),
        "IP-CIDR6,fe80::/10,DIRECT,no-resolve".into(),
        "GEOSITE,cn,DIRECT".into(), "GEOIP,CN,DIRECT".into(), format!("MATCH,{GROUP}")
    ]).map_err(|e| e.to_string())?;
    let mut result = serde_yaml::to_string(&yaml).map_err(|e| e.to_string())?;
    let mut providers: Vec<_> = plan.providers.iter().collect();
    providers.sort_by_key(|p| provider_priority(&p.name));
    for provider in providers.into_iter().rev() {
        let mut spec = provider.clone();
        spec.target_proxy = local_target(&spec.target_proxy).into();
        result = profile::edit_rule_provider(&result, &spec.name, Some(&spec))?;
    }
    // 局域网优先，联网规则集优先于国内判断和兜底。
    let mut value: Value = serde_yaml::from_str(&result).map_err(|e| e.to_string())?;
    if let Some(providers) = value["rule-providers"].as_mapping_mut() {
        for (name, provider) in providers.iter_mut() {
            if name.as_str().is_some_and(|name| dns_names.contains(name)) { continue; }
            if let Some(path) = provider["path"].as_str() {
                provider["path"] = path.replacen("./ruleset/", "./ruleset/local-plan/", 1).into();
            }
        }
    }
    let rules = value["rules"].as_sequence_mut().ok_or("规则须为数组")?;
    let count = rules.len() - 10;
    rules[..count + 7].rotate_left(count);
    // 局域网 IP 仅匹配已有地址，不能为了局域网判断提前解析域名。
    if plan.providers.iter().any(|p| p.name == "ls-lancidr" && p.behavior == "ipcidr") {
        for rule in rules.iter_mut() {
            if let Some(text) = rule.as_str().filter(|s| s.starts_with("RULE-SET,ls-lancidr,")) {
                *rule = format!("{text},no-resolve").into();
            }
        }
    }
    // 国内 IP 是兜底：放在域名规则和 GEOSITE 后，仍允许解析。
    // 服务专用规则（如 Telegram IP、Steam 国内下载）保持原有业务优先级。
    if let Some(index) = rules.iter().position(|r| r.as_str().is_some_and(|s| s.starts_with("RULE-SET,ls-cncidr,"))) {
        let fallback = rules.remove(index);
        let geoip = rules.iter().position(|r| r.as_str() == Some("GEOIP,CN,DIRECT")).ok_or("缺少国内 IP 兜底")?;
        rules.insert(geoip, fallback);
    }
    serde_yaml::to_string(&value).map_err(|e| e.to_string())
}

pub async fn save(plan: LocalRulePlan) -> Result<LocalRulePlan, String> {
    let profiles = profile::read_profiles_index();
    let selected = profiles.iter().find(|p| p.is_selected).ok_or("请先选择订阅")?;
    let source = profile::get_base_dir().join(&selected.file_path);
    let raw = std::fs::read_to_string(&source).map_err(|_| "读取订阅失败")?;
    let prepared = super::settings::prepare_with(&raw, &super::settings::get_general_settings()?)?;
    profile::validate_config(&compose(&prepared, &plan)?)?;
    let previous = if path().exists() { Some(std::fs::read(path()).map_err(|_| "读取旧方案失败")?) } else { None };
    crate::storage::replace(&path(), &serde_json::to_vec_pretty(&plan).map_err(|e| e.to_string())?)?;
    if let Err(error) = profile::apply_profile_to_core(&source.to_string_lossy()).await {
        if let Some(bytes) = previous { crate::storage::replace(&path(), &bytes)?; }
        else { std::fs::remove_file(path()).map_err(|_| "恢复本地方案失败")?; }
        return Err(error);
    }
    Ok(plan)
}

#[tauri::command]
pub async fn set_local_rule_plan_enabled(enabled: bool) -> Result<LocalRulePlan, String> {
    let _lock = profile::PROFILE_WRITE.lock().await;
    let mut plan = get_local_rule_plan()?;
    plan.enabled = enabled;
    save(plan).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preserves_subscription_dns_providers_and_paths() {
        let raw = "proxies: []\nrules: ['MATCH,DIRECT']\nrule-providers:\n  dns-only: {type: file, behavior: domain, path: './ruleset/dns.yaml'}\n  filter: {type: inline, behavior: domain, payload: ['+.test.example']}\n  unused: {type: inline, behavior: domain, payload: ['+.unused.example']}\ndns:\n  nameserver-policy: {'rule-set:dns-only,filter': system}\n  fake-ip-filter: ['RULE-SET,filter,real-ip']\n";
        let plan = LocalRulePlan { enabled: true, providers: vec![] };
        let original: Value = serde_yaml::from_str(raw).unwrap();
        let output: Value = serde_yaml::from_str(&compose(raw, &plan).unwrap()).unwrap();
        assert_eq!(output["rule-providers"]["dns-only"], original["rule-providers"]["dns-only"]);
        assert_eq!(output["rule-providers"]["filter"], original["rule-providers"]["filter"]);
        assert!(output["rule-providers"].get("unused").is_none());
        assert_eq!(output["dns"], original["dns"]);
        let mut plan = LocalRulePlan::default();
        plan.providers[0].name = "dns-only".into();
        assert!(compose(raw, &plan).unwrap_err().contains("同名"));
    }
    #[test]
    fn presets_use_independent_groups_and_keep_ads_disabled() {
        let plan = LocalRulePlan::default();
        assert_eq!(plan.providers.len(), 30);
        assert!(!plan.providers.iter().any(|p| p.target_proxy == "REJECT"));
        let value: Value = serde_yaml::from_str(&compose("proxies: []\nrules: []\n", &plan).unwrap()).unwrap();
        assert_eq!(value["rules"].as_sequence().unwrap().len(), 40);
        let groups = value["proxy-groups"].as_sequence().unwrap();
        assert_eq!(groups.len(), 7);
        for category in CATEGORY_GROUPS {
            let group = groups.iter().find(|g| g["name"].as_str() == Some(category)).unwrap();
            assert_eq!(group["proxies"][0].as_str(), Some(GROUP));
        }
        assert!(value["rules"].as_sequence().unwrap().iter().any(|rule| rule.as_str() == Some("RULE-SET,nb-ai,本地方案·AI")));
        let rules = value["rules"].as_sequence().unwrap();
        let position = |prefix: &str| rules.iter().position(|r| r.as_str().unwrap().starts_with(prefix)).unwrap();
        assert!(position("RULE-SET,ls-private,") < position("RULE-SET,nb-ai,"));
        assert!(position("RULE-SET,bm-disney,") < position("RULE-SET,ls-direct,"));
        assert!(position("RULE-SET,bm-steamcn,") < position("RULE-SET,nb-steam,"));
        assert!(position("RULE-SET,ls-direct,") < position("RULE-SET,ls-proxy,"));
        assert!(rules.iter().any(|r| r.as_str() == Some("RULE-SET,ls-lancidr,DIRECT,no-resolve")));
        assert!(position("RULE-SET,ls-proxy,") < position("RULE-SET,ls-cncidr,"));
        assert!(position("GEOSITE,cn,") < position("RULE-SET,ls-cncidr,"));
        assert!(position("RULE-SET,ls-cncidr,") < position("GEOIP,CN,"));
        assert!(rules.iter().any(|r| r.as_str() == Some("RULE-SET,ls-cncidr,DIRECT")));
        assert!(rules.iter().any(|r| r.as_str() == Some("GEOIP,CN,DIRECT")));
        assert!(rules.iter().any(|r| r.as_str() == Some("RULE-SET,ls-telegramcidr,本地方案·通信")));
    }
    #[test]
    fn subscription_switch_preserves_local_rules_and_replaces_nodes() {
        let plan = LocalRulePlan { enabled: true, providers: vec![RuleProviderSpec {
            name: "custom".into(), url: "https://example.org/rules.txt".into(),
            behavior: "domain".into(), format: None, target_proxy: "old-group".into()
        }] };
        for name in ["node-a", "node-b"] {
            let raw = format!("proxies:\n- {{name: {name}, type: direct}}\nrules: ['MATCH,DIRECT']\n");
            let result: Value = serde_yaml::from_str(&compose(&raw, &plan).unwrap()).unwrap();
            assert_eq!(result["proxy-groups"][0]["proxies"][0].as_str(), Some(name));
            let rules = result["rules"].as_sequence().unwrap();
            assert_eq!(rules.len(), 11);
            assert_eq!(rules[7].as_str(), Some(format!("RULE-SET,custom,{GROUP}").as_str()));
            assert_eq!(result["rule-providers"]["custom"]["interval"].as_u64(), Some(86400));
            assert_eq!(result["rule-providers"]["custom"]["path"].as_str(), Some("./ruleset/local-plan/custom.txt"));
        }
    }
    #[test]
    fn disabled_plan_leaves_subscription_unchanged() {
        let raw = "proxies: []\nrules: [MATCH,DIRECT]\n";
        assert_eq!(compose(raw, &LocalRulePlan { enabled: false, providers: vec![] }).unwrap(), raw);
    }
    #[test]
    fn subscription_rules_take_priority() {
        let raw = "proxies: []\nrules:\n- DOMAIN,example.org,DIRECT\n- MATCH,DIRECT\n";
        assert_eq!(compose(raw, &LocalRulePlan::default()).unwrap(), raw);
    }

    #[cfg(windows)]
    #[test]
    fn native_core_downloads_local_plan_provider() {
        use std::{io::{Read, Write}, sync::{Arc, atomic::{AtomicBool, AtomicUsize, Ordering}}, os::windows::process::CommandExt};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        listener.set_nonblocking(true).unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let count = Arc::new(AtomicUsize::new(0));
        let server_stop = stop.clone();
        let hits = count.clone();
        let server = std::thread::spawn(move || {
            while !server_stop.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        stream.set_read_timeout(Some(std::time::Duration::from_secs(1))).unwrap();
                        let mut buffer = [0; 4096];
                        if stream.read(&mut buffer).is_ok() {
                            let body = "example.org\n";
                            let response = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                            let _ = stream.write_all(response.as_bytes());
                            hits.fetch_add(1, Ordering::SeqCst);
                        }
                    }
                    Err(_) => std::thread::sleep(std::time::Duration::from_millis(10)),
                }
            }
        });
        let directory = std::env::temp_dir().join(format!("netbox-local-native-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        profile::copy_validation_assets(&root.parent().unwrap().join("core_data"), &directory).unwrap();
        let plan = LocalRulePlan { enabled: true, providers: vec![RuleProviderSpec {
            name: "local-native-fixture".into(), url: format!("http://{address}/rules.txt"),
            behavior: "domain".into(), format: None, target_proxy: "DIRECT".into()
        }] };
        let output = compose("proxies: []\nrules: ['MATCH,DIRECT']\n", &plan).unwrap();
        std::fs::write(directory.join("config.yaml"), output).unwrap();
        let mut child = std::process::Command::new(root.join("binaries/mihomo-compatible.exe"))
            .arg("-d").arg(&directory).creation_flags(0x08000000)
            .stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn().unwrap();
        let start = std::time::Instant::now();
        let success = loop {
            if child.try_wait().unwrap().is_some() { break false; }
            if directory.join("ruleset/local-plan/local-native-fixture.txt").exists() && count.load(Ordering::SeqCst) > 0 {
                child.kill().unwrap(); child.wait().unwrap(); break true;
            }
            if start.elapsed().as_secs() >= 15 { child.kill().unwrap(); child.wait().unwrap(); break false; }
            std::thread::sleep(std::time::Duration::from_millis(20));
        };
        stop.store(true, Ordering::SeqCst);
        server.join().unwrap();
        std::fs::remove_dir_all(&directory).unwrap();
        assert!(success, "本地方案须实际启动并缓存联网规则集");
        assert!(count.load(Ordering::SeqCst) > 0, "原生内核须真实联网下载规则集");
    }
}

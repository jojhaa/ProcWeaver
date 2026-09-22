use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneralSettings {
    pub mixed_port: u16,
    pub controller_port: u16,
    #[serde(default = "default_enable_controller_port")]
    pub enable_controller_port: bool,
    pub allow_lan: bool,
    pub tun_mode: bool,
    pub auto_start: bool,
    #[serde(default = "default_true")]
    pub unified_delay: bool,
    #[serde(default)]
    pub tcp_concurrent: bool,
    #[serde(default = "default_geo_low_memory")]
    pub geo_low_memory: bool,
    #[serde(default)]
    pub minimize_on_close: bool,
    #[serde(default)]
    pub silent_start: bool,
    #[serde(default = "default_geo_low_memory")]
    pub auto_run: bool,
    #[serde(default = "default_true")]
    pub only_proxy_traffic: bool,
    #[serde(default = "default_traffic_mode")]
    pub traffic_mode: String,
    #[serde(default = "default_routing_priority")]
    pub routing_priority: String,
    #[serde(default = "default_speed_test_url")]
    pub speed_test_url: String,
    #[serde(default = "default_speed_test_concurrency")]
    pub speed_test_concurrency: usize,
    #[serde(default)]
    pub ipv6: bool,
    #[serde(default = "default_find_process_mode")]
    pub find_process_mode: String,
    #[serde(default = "default_auto_close_connections")]
    pub auto_close_connections: bool,
    #[serde(default)]
    pub append_system_dns: bool,
    #[serde(default = "default_true")]
    pub log_capture: bool,
    #[serde(default = "default_true")]
    pub tab_animation: bool,
    #[serde(default = "default_health_probe_concurrency")]
    pub health_probe_concurrency: usize,
    #[serde(default = "default_tray_menu_style")]
    pub tray_menu_style: String,
}
fn default_enable_controller_port() -> bool { true }
fn default_true() -> bool { true }
fn default_tray_menu_style() -> String { "modern".into() }
fn default_find_process_mode() -> String { "auto".into() }
fn default_auto_close_connections() -> bool { true }
fn default_traffic_mode() -> String { "app_proxy".into() }
fn default_routing_priority() -> String { "domain_first".into() }
fn default_geo_low_memory() -> bool { true }
fn default_speed_test_url() -> String { "https://cp.cloudflare.com/generate_204".into() }
fn default_speed_test_concurrency() -> usize { 10 }
fn default_health_probe_concurrency() -> usize { 4 }
impl Default for GeneralSettings {
    fn default() -> Self {
        Self {
            mixed_port: 7890,
            controller_port: 9090,
            enable_controller_port: true,
            allow_lan: false,
            tun_mode: false,
            auto_start: false,
            unified_delay: true,
            tcp_concurrent: false,
            geo_low_memory: true,
            minimize_on_close: false,
            silent_start: false,
            auto_run: true,
            only_proxy_traffic: true,
            traffic_mode: "app_proxy".into(),
            routing_priority: "domain_first".into(),
            speed_test_url: "https://cp.cloudflare.com/generate_204".into(),
            speed_test_concurrency: 10,
            health_probe_concurrency: 4,
            ipv6: false,
            find_process_mode: "auto".into(),
            auto_close_connections: true,
            append_system_dns: false,
            log_capture: true,
            tab_animation: true,
            tray_menu_style: "modern".into(),
        }
    }
}
#[tauri::command]
pub fn get_general_settings() -> Result<GeneralSettings, String> {
    let path = crate::storage::data_dir().join("config/preferences.json");
    if !path.exists() { return Ok(GeneralSettings::default()); }
    serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?).map_err(|_| "偏好设置损坏，请恢复备份".into())
}
#[tauri::command]
pub async fn save_general_settings(settings: GeneralSettings, state: tauri::State<'_, super::process::CoreStateMutex>) -> Result<GeneralSettings, String> {
    save_and_restart(settings, &state).await
}

async fn save_and_restart(settings: GeneralSettings, state: &super::process::CoreStateMutex) -> Result<GeneralSettings, String> {
    let _lifecycle = super::process::LIFECYCLE.lock().await;
    let previous = get_general_settings()?;
    let (restart, mode) = {
        let mut core = state.lock().map_err(|_| "读取核心状态失败")?;
        let running = match core.child.as_mut() { Some(child) => child.try_wait().map_err(|_| "读取核心状态失败")?.is_none(), None => false };
        let mode = core.core_mode.clone();
        (running && core_settings_changed(&previous, &settings), mode)
    };
    let proxy_enabled = super::sysproxy::get_system_proxy_status()?;
    let preference_path = crate::storage::data_dir().join("config/preferences.json");
    let original = if preference_path.exists() { Some(std::fs::read(&preference_path).map_err(|_| "备份偏好失败")?) } else { None };
    persist_general_settings(settings.clone(), &state)?;
    if restart {
        let result = async {
            { let mut core = state.lock().map_err(|_| "读取核心状态失败")?; super::process::stop_owned_child(&mut core)?; }
            super::process::start_core_locked(mode.clone(), state).await?;
            if proxy_enabled { super::sysproxy::set_system_proxy_locked(true, Some(settings.mixed_port)).await?; }
            Ok::<(), String>(())
        }.await;
        if let Err(error) = result {
            persist_general_settings(previous.clone(), &state)?;
            if let Some(bytes) = original { crate::storage::replace(&preference_path, &bytes)?; }
            else { std::fs::remove_file(&preference_path).map_err(|_| "恢复旧偏好失败")?; }
            { let mut core = state.lock().map_err(|_| "读取核心状态失败")?; super::process::stop_owned_child(&mut core).map_err(|e| format!("旧设置已恢复，但核心清理失败：{e}"))?; }
            let recovery = super::process::start_core_locked(mode, state).await;
            if let Err(recovery_error) = recovery { return Err(format!("新设置启动失败：{error}；旧设置已恢复，但核心恢复失败：{recovery_error}")); }
            if proxy_enabled { super::sysproxy::set_system_proxy_locked(true, Some(previous.mixed_port)).await?; }
            return Err(format!("新设置启动失败，已恢复旧设置和核心：{error}"));
        }
    }
    Ok(settings)
}

fn persist_general_settings(mut settings: GeneralSettings, state: &super::process::CoreStateMutex) -> Result<GeneralSettings, String> {
    if settings.mixed_port == 0 {
        return Err("Mixed 端口须为 1–65535".into());
    }
    if settings.enable_controller_port {
        if settings.controller_port == 0 || settings.mixed_port == settings.controller_port {
            return Err("端口须为 1–65535，且两个端口不能相同".into());
        }
    }
    if settings.traffic_mode.is_empty() || settings.traffic_mode == "windivert" {
        settings.traffic_mode = if settings.tun_mode { "tun".into() } else { "app_proxy".into() };
    }
    if settings.traffic_mode == "tun" {
        settings.tun_mode = true;
    } else {
        settings.tun_mode = false;
        if settings.traffic_mode != "smart_hybrid" {
            settings.traffic_mode = "app_proxy".into();
        }
    }
    let mut core = state.lock().map_err(|e| e.to_string())?;
    let bytes = serde_json::to_vec_pretty(&settings).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    let autostart_rollback = if get_general_settings()?.auto_start != settings.auto_start {
        use winreg::{RegKey, enums::*};
        let (key, _) = RegKey::predef(HKEY_CURRENT_USER).create_subkey(r"Software\Microsoft\Windows\CurrentVersion\Run").map_err(|e| e.to_string())?;
        let previous = match key.get_raw_value("ProcWeaver") {
            Ok(value) => Some(value),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => match key.get_raw_value("NetBox") {
                Ok(value) => Some(value),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
                Err(e) => return Err(e.to_string()),
            },
            Err(e) => return Err(e.to_string()),
        };
        if settings.auto_start {
            let exe = std::env::current_exe().map_err(|e| e.to_string())?;
            key.set_value("ProcWeaver", &format!("\"{}\"", exe.display())).map_err(|e| e.to_string())?;
            let _ = key.delete_value("NetBox");
        } else {
            let _ = key.delete_value("ProcWeaver");
            let _ = key.delete_value("NetBox");
        }
        Some((key, previous))
    } else { None };
    if let Err(error) = crate::storage::replace(&crate::storage::data_dir().join("config/preferences.json"), &bytes) {
        #[cfg(windows)] if let Some((key, previous)) = autostart_rollback {
            let restored = match previous {
                Some(value) => key.set_raw_value("ProcWeaver", &value),
                None => match key.delete_value("ProcWeaver") {
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                    result => result,
                },
            };
            restored.map_err(|e| format!("保存失败：{error}；自启动恢复失败：{e}"))?;
        }
        return Err(error);
    }
    if core.child.is_none() {
        core.mixed_port = settings.mixed_port;
        core.controller_port = settings.controller_port;
    }
    Ok(settings)
}

fn core_settings_changed(a: &GeneralSettings, b: &GeneralSettings) -> bool {
    a.mixed_port != b.mixed_port || a.controller_port != b.controller_port
        || a.enable_controller_port != b.enable_controller_port
        || a.allow_lan != b.allow_lan || a.tun_mode != b.tun_mode
        || a.unified_delay != b.unified_delay || a.tcp_concurrent != b.tcp_concurrent
        || a.geo_low_memory != b.geo_low_memory || a.traffic_mode != b.traffic_mode
        || a.routing_priority != b.routing_priority
        || a.ipv6 != b.ipv6 || a.find_process_mode != b.find_process_mode
        || a.append_system_dns != b.append_system_dns
}

#[tauri::command]
pub fn get_active_traffic_driver() -> String {
    crate::capture::smart_arbiter::get_active_driver_name()
}

pub fn prepare_config(raw: &str) -> Result<String, String> {
    let (id, _) = crate::routing_overrides::current_source();
    crate::routing_overrides::prepare(raw, &crate::routing_overrides::read()?, &id)
}

pub fn prepare_with(raw: &str, settings: &GeneralSettings) -> Result<String, String> {
    let mut legacy_groups = Vec::new();
    let mut yaml: serde_yaml::Value = match serde_yaml::from_str(raw) {
        Ok(value) => value,
        Err(_) => {
            for line in raw.lines().filter(|line| line.starts_with("    - { name:")) {
                if let Ok(value) = serde_yaml::from_str::<serde_yaml::Value>(line.trim_start().trim_start_matches("- ")) {
                    if let Some(name) = value["name"].as_str() { legacy_groups.push(name.to_owned()); }
                }
            }
            serde_yaml::from_str(&repair_legacy_group_indentation(&repair_legacy_rule_indentation(raw))).map_err(|error| {
            match error.location() {
                Some(location) => format!("订阅 YAML 格式错误：第 {} 行、第 {} 列，请检查该处缩进或恢复订阅备份", location.line(), location.column()),
                None => "订阅不是有效的 YAML 配置".to_string(),
            }
        })?
        },
    };
    repair_legacy_members(&mut yaml, &legacy_groups);
    let map = yaml.as_mapping_mut().ok_or("订阅必须是配置对象，不能是 HTML 或普通文本")?;
    if !map.contains_key(serde_yaml::Value::from("proxies")) && !map.contains_key(serde_yaml::Value::from("proxy-providers")) {
        return Err("订阅缺少 proxies 或 proxy-providers".into());
    }
    map.insert("mixed-port".into(), settings.mixed_port.into());
    // 始终保留内部回环控制接口 (127.0.0.1)，确保应用控制与就绪探针正常运作
    map.insert("external-controller".into(), format!("127.0.0.1:{}", settings.controller_port).into());
    map.insert("allow-lan".into(), settings.allow_lan.into());
    map.insert("unified-delay".into(), settings.unified_delay.into());
    map.insert("tcp-concurrent".into(), settings.tcp_concurrent.into());
    map.insert("geodata-loader".into(), if settings.geo_low_memory { "memconservative" } else { "standard" }.into());
    map.insert("ipv6".into(), settings.ipv6.into());
    let find_proc = match settings.find_process_mode.as_str() {
        "always" => "always",
        "off" => "off",
        _ => {
            if crate::routing_overrides::read().map(|r| r.process_enabled).unwrap_or(false) {
                "always"
            } else {
                "off"
            }
        }
    };
    map.insert("find-process-mode".into(), find_proc.into());
    let tun = map.entry(serde_yaml::Value::from("tun")).or_insert(serde_yaml::Value::Mapping(Default::default()));
    let tun_enable = match settings.traffic_mode.as_str() {
        "tun" => true,
        "smart_hybrid" => crate::capture::smart_arbiter::is_tun_escalated(),
        "app_proxy" => false,
        _ => settings.tun_mode,
    };
    let tun_map = tun.as_mapping_mut().ok_or("tun 必须是对象")?;
    tun_map.insert("enable".into(), tun_enable.into());
    if tun_enable {
        tun_map.entry("stack".into()).or_insert("mixed".into());
        tun_map.entry("auto-route".into()).or_insert(true.into());
        tun_map.entry("auto-detect-interface".into()).or_insert(true.into());
        if !tun_map.contains_key(&serde_yaml::Value::from("dns-hijack")) {
            tun_map.insert("dns-hijack".into(), serde_yaml::to_value(["any:53", "tcp://any:53"]).unwrap());
        }
    }

    // DNS 覆写逻辑：若开启了 DNS 覆写，则合成标准化 DNS 块并覆盖订阅原 DNS
    if let Ok(mut dns_settings) = super::dns::get_dns_settings() {
        if dns_settings.enable_override {
            if settings.append_system_dns {
                dns_settings.append_system_dns = true;
            }
            map.insert("dns".into(), super::dns::build_dns_mapping(&dns_settings));
        } else if let Some(dns_map) = map.get_mut(serde_yaml::Value::from("dns")).and_then(|v| v.as_mapping_mut()) {
            dns_map.insert("append-system-dns".into(), settings.append_system_dns.into());
        }
    } else if let Some(dns_map) = map.get_mut(serde_yaml::Value::from("dns")).and_then(|v| v.as_mapping_mut()) {
        dns_map.insert("append-system-dns".into(), settings.append_system_dns.into());
    }

    serde_yaml::to_string(&yaml).map_err(|e| e.to_string())
}

fn repair_legacy_members(yaml: &mut serde_yaml::Value, legacy_names: &[String]) {
    if legacy_names.is_empty() || !yaml.is_mapping() { return; }
    let mut available = std::collections::HashSet::from(["DIRECT".to_string(), "REJECT".to_string()]);
    for section in ["proxies", "proxy-groups"] {
        if let Some(items) = yaml[section].as_sequence() {
            for item in items {
                if let Some(name) = item["name"].as_str() { available.insert(name.into()); }
            }
        }
    }
    if let Some(groups) = yaml["proxy-groups"].as_sequence_mut() {
        for group in groups {
            let name = group["name"].as_str().unwrap_or_default().to_string();
            if !legacy_names.contains(&name) { continue; }
            if let Some(members) = group["proxies"].as_sequence_mut() {
                members.retain(|member| member.as_str().is_some_and(|value| value != name && available.contains(value)));
                // 旧缓存全部失效时拒绝流量，不能悄悄改为直连。
                if members.is_empty() { members.push("REJECT".into()); }
            }
        }
    }
}

// 旧版注入器固定写入四空格的单行策略组，而 YAML 序列化器使用零缩进列表。
// 仅在同一 proxy-groups 段存在零缩进列表时，修复该旧版单行形式。
fn repair_legacy_group_indentation(raw: &str) -> String {
    let mut lines: Vec<&str> = raw.lines().collect();
    let Some(start) = lines.iter().position(|line| *line == "proxy-groups:") else { return raw.into(); };
    let end = (start + 1..lines.len()).find(|&i| {
        let line = lines[i];
        !line.is_empty() && !line.starts_with(char::is_whitespace)
            && !line.starts_with('-') && !line.starts_with('#')
    }).unwrap_or(lines.len());
    if !lines[start + 1..end].iter().any(|line| line.starts_with("- ")) { return raw.into(); }
    for line in &mut lines[start + 1..end] {
        if line.starts_with("    - { name:") && line.contains("type:") && line.contains("proxies:") && line.trim_end().ends_with('}') {
            *line = line.trim_start();
        }
    }
    lines.join("\n")
}

/// 旧规则集注入器在零缩进 rules 列表前插入四空格 RULE-SET 行。
fn repair_legacy_rule_indentation(raw: &str) -> String {
    let mut lines: Vec<&str> = raw.lines().collect();
    let Some(start) = lines.iter().position(|line| *line == "rules:") else { return raw.into(); };
    let end = (start + 1..lines.len()).find(|&i| {
        let line = lines[i];
        !line.is_empty() && !line.starts_with(char::is_whitespace) && !line.starts_with('-') && !line.starts_with('#')
    }).unwrap_or(lines.len());
    if lines[start + 1..end].iter().any(|line| line.starts_with("- ")) {
        for line in &mut lines[start + 1..end] {
            if line.starts_with("    - 'RULE-SET,") && line.trim_end().ends_with('\'') { *line = line.trim_start(); }
        }
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn repairs_old_rule_insertion_without_dropping_existing_rules() {
        let raw = "proxies: []\nrules:\n    - 'RULE-SET,openai,DIRECT'\n- DOMAIN,example.org,DIRECT\n- MATCH,DIRECT\n";
        assert!(serde_yaml::from_str::<serde_yaml::Value>(raw).is_err());
        let result = prepare_with(raw, &GeneralSettings::default()).unwrap();
        let value: serde_yaml::Value = serde_yaml::from_str(&result).unwrap();
        assert_eq!(value["rules"].as_sequence().unwrap().len(), 3);
        assert_eq!(value["rules"][0].as_str(), Some("RULE-SET,openai,DIRECT"));
        assert_eq!(value["rules"][2].as_str(), Some("MATCH,DIRECT"));
    }
    #[test]
    fn legacy_stale_members_fail_closed_and_leave_regular_groups_unchanged() {
        let raw = "proxies: []\nproxy-groups:\n    - { name: '旧智能组', type: select, proxies: ['已删除节点'] }\n- name: 普通组\n  type: select\n  proxies: [DIRECT]\n";
        let result = prepare_with(raw, &GeneralSettings::default()).unwrap();
        let value: serde_yaml::Value = serde_yaml::from_str(&result).unwrap();
        assert_eq!(value["proxy-groups"][0]["proxies"][0].as_str(), Some("REJECT"));
        assert_eq!(value["proxy-groups"][1]["proxies"][0].as_str(), Some("DIRECT"));
    }
    #[test]
    fn legacy_injected_groups_preserve_all_members() {
        let raw = "proxies: []\nproxy-groups:\n    - { name: '智能组', type: select, proxies: [DIRECT] }\n- name: 普通组\n  type: select\n  proxies:\n  - DIRECT\nrules:\n- MATCH,DIRECT\n";
        assert!(serde_yaml::from_str::<serde_yaml::Value>(raw).is_err());
        let prepared = prepare_with(raw, &GeneralSettings::default()).unwrap();
        let value: serde_yaml::Value = serde_yaml::from_str(&prepared).unwrap();
        assert_eq!(value["proxy-groups"].as_sequence().unwrap().len(), 2);
        assert_eq!(value["proxy-groups"][0]["name"].as_str(), Some("智能组"));
        assert_eq!(value["proxy-groups"][1]["name"].as_str(), Some("普通组"));
        assert_eq!(value["proxy-groups"][1]["proxies"][0].as_str(), Some("DIRECT"));
        assert_eq!(value["rules"][0].as_str(), Some("MATCH,DIRECT"));
    }
    #[test]
    fn legacy_repair_does_not_change_unrelated_sections() {
        let raw = "proxies: []\nproxy-groups:\n    - { name: '组', type: select, proxies: [DIRECT] }\nrules:\n- MATCH,DIRECT\n";
        assert_eq!(repair_legacy_group_indentation(raw), raw);
    }
    #[test]
    fn rejects_error_pages_and_scalar_documents() {
        for raw in ["<html>Forbidden</html>", "unavailable", "[]", "error: denied"] {
            assert!(prepare_with(raw, &GeneralSettings::default()).is_err());
        }
    }
    #[test]
    fn applies_preferences_without_losing_tun_or_proxy_fields() {
        let settings = GeneralSettings { mixed_port: 17890, controller_port: 19090, tun_mode: true, traffic_mode: "tun".into(), ..GeneralSettings::default() };
        let result = prepare_with("proxies: []\ntun:\n  stack: system\n  enable: false\nrules:\n  - MATCH,DIRECT\n", &settings).unwrap();
        let value: serde_yaml::Value = serde_yaml::from_str(&result).unwrap();
        assert_eq!(value["mixed-port"].as_u64(), Some(17890));
        assert_eq!(value["external-controller"].as_str(), Some("127.0.0.1:19090"));
        assert_eq!(value["tun"]["stack"].as_str(), Some("system"));
        assert_eq!(value["tun"]["enable"].as_bool(), Some(true));
        assert_eq!(value["rules"][0].as_str(), Some("MATCH,DIRECT"));

        let disabled_settings = GeneralSettings { enable_controller_port: false, ..settings };
        let disabled_res = prepare_with("proxies: []\nrules:\n  - MATCH,DIRECT\n", &disabled_settings).unwrap();
        let disabled_val: serde_yaml::Value = serde_yaml::from_str(&disabled_res).unwrap();
        // A06: 为防止控制器与就绪探针失联，回环控制接口始终保留有效绑定
        assert_eq!(disabled_val["external-controller"].as_str(), Some("127.0.0.1:19090"));
    }
    #[test]
    fn performance_settings_support_old_files_and_both_switch_states() {
        let old: GeneralSettings = serde_json::from_str(r#"{"mixedPort":7890,"controllerPort":9090,"allowLan":false,"tunMode":false,"autoStart":false}"#).unwrap();
        assert!(old.unified_delay && !old.tcp_concurrent && old.geo_low_memory);
        assert!(!old.minimize_on_close && !old.silent_start && old.auto_run && old.only_proxy_traffic);
        for enabled in [false, true] {
            let settings = GeneralSettings { unified_delay: enabled, tcp_concurrent: enabled, geo_low_memory: enabled, ..old.clone() };
            let persisted = serde_json::to_vec(&settings).unwrap();
            let restored: GeneralSettings = serde_json::from_slice(&persisted).unwrap();
            let result = prepare_with("proxies: []\ngeodata-mode: false\nunified-delay: true\ntcp-concurrent: true\ngeodata-loader: standard\nrules: ['MATCH,DIRECT']\n", &restored).unwrap();
            let value: serde_yaml::Value = serde_yaml::from_str(&result).unwrap();
            assert_eq!(value["unified-delay"].as_bool(), Some(enabled));
            assert_eq!(value["tcp-concurrent"].as_bool(), Some(enabled));
            assert_eq!(value["geodata-loader"].as_str(), Some(if enabled { "memconservative" } else { "standard" }));
            assert_eq!(value["geodata-mode"].as_bool(), Some(false));
        }
    }
    #[test]
    fn app_preferences_roundtrip_without_requiring_core_stop() {
        let old = GeneralSettings::default();
        let changed = GeneralSettings { minimize_on_close: true, silent_start: true, auto_run: false, only_proxy_traffic: false, auto_start: true, ..old.clone() };
        assert!(!core_settings_changed(&old, &changed));
        let restored: GeneralSettings = serde_json::from_slice(&serde_json::to_vec(&changed).unwrap()).unwrap();
        assert!(restored.minimize_on_close && restored.silent_start && !restored.only_proxy_traffic && restored.auto_start);
        assert!(!restored.auto_run);
        assert!(core_settings_changed(&old, &GeneralSettings { tcp_concurrent: true, ..changed }));
    }

    #[cfg(windows)]
    #[test]
    fn native_settings_restart_and_port_failure_restore_old_core() {
        const FLAG: &str = "NETBOX_RESTART_TEST_CHILD";
        if std::env::var_os(FLAG).is_none() {
            for mode in ["compatible", "standard"] {
                let status = std::process::Command::new(std::env::current_exe().unwrap())
                    .args(["--exact", "commands::settings::tests::native_settings_restart_and_port_failure_restore_old_core"])
                    .env(FLAG, mode).status().unwrap();
                assert!(status.success(), "{mode}");
            }
            return;
        }
        let directory = std::env::temp_dir().join(format!("netbox-restart-test-{}", std::process::id()));
        std::fs::create_dir_all(directory.join("config")).unwrap();
        std::fs::write(directory.join("config/default.yaml"), "proxies: []\nmode: global\nrules: ['MATCH,DIRECT']\n").unwrap();
        std::fs::write(directory.join("config/local-rules.json"), r#"{"enabled":false,"providers":[]}"#).unwrap();
        let original_resources = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf();
        let mode = std::env::var(FLAG).unwrap();
        let resources = directory.join("resources");
        std::fs::create_dir_all(resources.join("binaries")).unwrap();
        let file = if mode == "standard" { "mihomo.exe" } else { "mihomo-compatible.exe" };
        std::fs::copy(original_resources.join("binaries/mihomo-compatible.exe"), resources.join("binaries").join(file)).unwrap();
        crate::storage::initialize_test(directory.clone(), resources);
        let mut numbers = Vec::new();
        while numbers.len() < 4 {
            for _ in 0..100 {
                if let Ok(l) = std::net::TcpListener::bind("127.0.0.1:0") {
                    let port = l.local_addr().unwrap().port();
                    if !numbers.contains(&port) {
                        if let Ok(u) = std::net::UdpSocket::bind(format!("127.0.0.1:{}", port)) {
                            drop(u); drop(l); numbers.push(port); break;
                        }
                    }
                }
            }
        }
        let old = GeneralSettings { mixed_port: numbers[0], controller_port: numbers[1], ..GeneralSettings::default() };
        let state = std::sync::Mutex::new(super::super::process::CoreState {child: None, mixed_port: old.mixed_port, controller_port: old.controller_port, active_core: None, active_core_path: None, core_mode: None, started_at: None});
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            save_and_restart(old.clone(), &state).await.unwrap();
            assert!(state.lock().unwrap().child.is_none(), "停止状态保存不得启动核心");
            let first = super::super::process::start_core_transaction(None, &state).await.unwrap();
            assert_eq!(state.lock().unwrap().core_mode.as_deref(), Some(mode.as_str()));
            let mut changed = old.clone(); changed.mixed_port = numbers[2]; changed.controller_port = numbers[3];
            save_and_restart(changed.clone(), &state).await.unwrap();
            let second = state.lock().unwrap().child.as_ref().unwrap().id();
            assert_eq!(state.lock().unwrap().core_mode.as_deref(), Some(mode.as_str()));
            assert_ne!(first.pid, Some(second));
            let client = super::super::mihomo_api::controller_client().build().unwrap();
            let config: serde_json::Value = client.get(format!("http://127.0.0.1:{}/configs", changed.controller_port)).send().await.unwrap().json().await.unwrap();
            assert_eq!(config["mode"], "rule");
            let good_bytes = std::fs::read(directory.join("config/preferences.json")).unwrap();
            let occupied = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let mut invalid = changed.clone(); invalid.mixed_port = occupied.local_addr().unwrap().port();
            let error = save_and_restart(invalid, &state).await.err().expect("占用端口应失败");
            assert!(error.contains("已恢复旧设置和核心"), "{error}");
            assert_eq!(std::fs::read(directory.join("config/preferences.json")).unwrap(), good_bytes);
            let restored = state.lock().unwrap().child.as_ref().unwrap().id();
            assert_ne!(restored, second);
            assert!(client.get(format!("http://127.0.0.1:{}/version", changed.controller_port)).send().await.unwrap().status().is_success());
            super::super::process::stop_owned_child(&mut state.lock().unwrap()).unwrap();
        });
        std::fs::remove_dir_all(directory).unwrap();
    }
}

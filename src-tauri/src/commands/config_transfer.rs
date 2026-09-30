//! Versioned, bounded configuration snapshots. No runtime binaries or recovery
//! state leave the data directory. The UI encrypts snapshots before export/sync.
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fs, path::{Path, PathBuf}};
const LIMIT: usize = 6 * 1024 * 1024 - 1024;
const FILES: &[&str] = &["config/preferences.json", "config/profiles.json", "config/default.yaml", "config/dns-preferences.json",
    "config/routing-overrides.json", "config/local-nodes.json", "config/local-rules.json", "config/exclusions.json",
    "config/geo_config.json", "config/smart_groups.json", "config/business_channels.json"];
const UI_KEYS: &[&str] = &["netbox_business_bundles_instances_v1"];
const JOURNAL: &str = "config/restore-pending.procweaver-backup";
const UI_PENDING: &str = "config/restore-ui.json";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Snapshot {
    pub schema_version: u32, pub app_version: String, pub platform: String, pub created_at: u64,
    pub files: BTreeMap<String, String>, pub browser_state: BTreeMap<String, String>,
}
fn allowed(name: &str) -> bool {
    FILES.contains(&name) || name.strip_prefix("config/profiles/").is_some_and(|name| {
        !name.is_empty() && name.len() < 240 && !name.starts_with('.') && name.ends_with(".yaml")
            && name.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
    })
}
fn checked_path(root: &Path, name: &str) -> Result<PathBuf, String> {
    if !allowed(name) && name != UI_PENDING { return Err("备份包含不允许的文件路径".into()); }
    let path = root.join(name);
    let parent = path.parent().ok_or("备份路径无效")?;
    fs::create_dir_all(parent).map_err(|_| "创建配置目录失败")?;
    let canonical = root.canonicalize().map_err(|_| "应用目录无效")?;
    if !parent.canonicalize().map_err(|_| "配置目录无效")?.starts_with(&canonical)
        || (path.exists() && !path.canonicalize().map_err(|_| "配置文件无效")?.starts_with(&canonical)) {
        return Err("配置目录包含越界链接".into());
    }
    Ok(path)
}
fn collect(root: &Path) -> Result<BTreeMap<String, String>, String> {
    let mut names: Vec<String> = FILES.iter().map(|s| (*s).into()).collect();
    if let Ok(entries) = fs::read_dir(root.join("config/profiles")) {
        for entry in entries { let entry = entry.map_err(|_| "读取订阅列表失败")?;
            let name = format!("config/profiles/{}", entry.file_name().to_string_lossy());
            if allowed(&name) { names.push(name); }
        }
    }
    if names.len() > 5000 { return Err("配置文件数量超过备份上限".into()); }
    let mut files = BTreeMap::new(); let mut size = 0;
    for name in names {
        let path = checked_path(root, &name)?;
        if !path.exists() { continue; }
        if fs::metadata(&path).map_err(|_| "读取配置大小失败")?.len() > LIMIT as u64 { return Err("配置超过 6 MB 备份上限".into()); }
        let raw = fs::read_to_string(path).map_err(|_| "读取配置文件失败")?;
        size += raw.len(); if size > LIMIT { return Err("配置总量超过 6 MB 备份上限".into()); }
        files.insert(name, raw);
    }
    Ok(files)
}
fn validate(snapshot: &Snapshot) -> Result<(), String> {
    if snapshot.schema_version != 1 || snapshot.files.len() > 5000 || serde_json::to_vec(snapshot).map_err(|_| "备份格式无效")?.len() > LIMIT {
        return Err("备份版本不支持或内容超过 6 MB".into());
    }
    if !snapshot.files.contains_key("config/default.yaml") { return Err("备份缺少默认配置".into()); }
    for (name, content) in &snapshot.files {
        if !allowed(name) { return Err("备份包含不允许的文件路径".into()); }
        if name.ends_with(".json") { serde_json::from_str::<serde_json::Value>(content).map_err(|_| "备份中的 JSON 配置无效")?; }
        else {
            let value: serde_yaml::Value = serde_yaml::from_str(content).map_err(|_| "备份中的 YAML 无效")?;
            if !value.is_mapping() || (value.get("proxies").is_none() && value.get("proxy-providers").is_none()) { return Err("备份中的订阅缺少节点定义".into()); }
        }
    }
    if let Some(raw) = snapshot.files.get("config/profiles.json") {
        let list: Vec<super::profile::ProfileItem> = serde_json::from_str(raw).map_err(|_| "订阅索引无效")?;
        let mut ids = std::collections::BTreeSet::new();
        if list.iter().filter(|p| p.is_selected).count() > 1 { return Err("备份存在多个活动订阅".into()); }
        for item in list {
            if !ids.insert(item.id) || !item.file_path.starts_with("config/profiles/") || !allowed(&item.file_path) || !snapshot.files.contains_key(&item.file_path) {
                return Err("订阅索引包含越界、重复或缺失文件".into());
            }
        }
    }
    if let Some(raw) = snapshot.files.get("config/preferences.json") {
        let value: super::settings::GeneralSettings = serde_json::from_str(raw).map_err(|_| "偏好设置无效")?;
        if value.mixed_port == 0 || (value.enable_controller_port && (value.controller_port == 0 || value.controller_port == value.mixed_port)) {
            return Err("备份中的端口无效".into());
        }
        if snapshot.platform == "android" {
            if !value.enable_controller_port { return Err("Android 备份缺少内部控制端口".into()); }
            super::mobile_settings::validate(&value.lan_sharing, value.allow_lan, &value.vpn_apps, value.mixed_port, value.controller_port)?;
        }
    }
    if let Some(raw) = snapshot.files.get("config/geo_config.json") {
        super::geo::validate_settings(&serde_json::from_str(raw).map_err(|_| "Geo 设置无效")?)?;
    }
    if let Some(raw) = snapshot.files.get("config/routing-overrides.json") {
        let value = serde_json::from_str::<crate::routing_overrides::model::Overrides>(raw).map_err(|_| "分流设置无效")?;
        if snapshot.platform == std::env::consts::OS { crate::routing_overrides::model::normalize(value)?; }
    }
    if let Some(raw) = snapshot.files.get("config/dns-preferences.json") {
        serde_json::from_str::<super::dns::DnsSettings>(raw).map_err(|_| "DNS 设置无效")?.validate()?;
    }
    if let Some(raw) = snapshot.files.get("config/local-nodes.json") {
        crate::local_nodes::check_store(&serde_json::from_str(raw).map_err(|_| "本地节点无效")?)?;
    }
    if let Some(raw) = snapshot.files.get("config/exclusions.json") {
        super::exclusions::compose("proxies: []\nrules: []", &serde_json::from_str(raw).map_err(|_| "排除设置无效")?)?;
    }
    if let Some(raw) = snapshot.files.get("config/local-rules.json") {
        let plan: super::local_rules::LocalRulePlan = serde_json::from_str(raw).map_err(|_| "本地规则无效")?;
        if plan.providers.len() > 512 { return Err("本地规则数量超过上限".into()); }
    }
    for (key, value) in &snapshot.browser_state {
        if !UI_KEYS.contains(&key.as_str()) { return Err("备份包含未知界面状态".into()); }
        let json: serde_json::Value = serde_json::from_str(value).map_err(|_| "规则包界面状态无效")?;
        let items = json.as_array().ok_or("规则包界面状态必须为列表")?;
        let mut ids = std::collections::BTreeSet::new();
        if items.len() > 128 { return Err("业务包最多 128 个".into()); }
        for item in items {
            let id = item["instanceId"].as_str().filter(|id| !id.is_empty() && id.len() <= 128).ok_or("业务包实例无效")?;
            let definition = &item["definition"];
            if !ids.insert(id) || !item["enabled"].is_boolean() || !item["slotBindings"].is_object()
                || !definition["packageId"].is_string() || !definition["packageName"].is_string()
                || !definition["slots"].is_array() || !definition["processes"].is_array()
                || !matches!(item["watcherMode"].as_str(), Some("auto" | "hot_swap" | "notify" | "disabled")) {
                return Err("业务包界面结构无效".into());
            }
            for key in ["domains", "additionalExes", "androidPackages"] {
                if let Some(values) = definition.get(key) {
                    if !values.as_array().is_some_and(|v| v.iter().all(serde_json::Value::is_string)) { return Err("业务包成员列表无效".into()); }
                }
            }
            if let Some(bindings) = item.get("processBindings").filter(|v| !v.is_null()) {
                let platforms = bindings.as_object().ok_or("本机进程绑定无效")?;
                for (platform, values) in platforms {
                    if !matches!(platform.as_str(), "windows" | "macos") { return Err("本机进程绑定平台无效".into()); }
                    let values = values.as_array().filter(|v| v.len() <= 100).ok_or("本机进程绑定数量无效")?;
                    for value in values {
                        let path = value["executablePath"].as_str().filter(|p| !p.is_empty() && p.len() <= 1024 && !p.chars().any(char::is_control)).ok_or("本机程序路径无效")?;
                        let exe = value["exe"].as_str().filter(|s| !s.is_empty() && !s.contains(['/', '\\'])).ok_or("本机程序名无效")?;
                        let absolute = if platform == "windows" { path.starts_with("\\\\") || path.as_bytes().get(1) == Some(&b':') && matches!(path.as_bytes().get(2), Some(b'\\' | b'/')) } else { path.starts_with('/') };
                        if !absolute || !path.rsplit(['/', '\\']).next().is_some_and(|name| name == exe || platform == "windows" && name.eq_ignore_ascii_case(exe)) || !value["includeDescendants"].is_boolean() { return Err("本机程序绑定内容无效".into()); }
                    }
                }
            }
        }
    }
    Ok(())
}
#[tauri::command]
pub async fn export_config_snapshot(browser_state: BTreeMap<String, String>) -> Result<Snapshot, String> {
    let _guard = super::process::LIFECYCLE.lock().await;
    let _geo = super::geo::CONFIG.lock().await;
    let snapshot = Snapshot { schema_version: 1, app_version: env!("CARGO_PKG_VERSION").into(), platform: std::env::consts::OS.into(),
        created_at: std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs(),
        files: collect(&crate::storage::data_dir())?, browser_state };
    #[cfg(target_os = "android")]
    let snapshot = mobile_snapshot(snapshot)?;
    validate(&snapshot)?; Ok(snapshot)
}

fn mobile_snapshot(mut snapshot: Snapshot) -> Result<Snapshot, String> {
    snapshot.browser_state.clear();
    snapshot.files.remove("config/business_channels.json");
    if let Some(raw) = snapshot.files.get_mut("config/routing-overrides.json") {
        let config: crate::routing_overrides::model::Overrides = serde_json::from_str(raw).map_err(|_| "分流设置无效")?;
        *raw = serde_json::to_string(&config.without_bundles()).map_err(|_| "生成手机分流配置失败")?;
    }
    Ok(snapshot)
}
#[tauri::command]
pub fn preview_config_snapshot(snapshot: Snapshot) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "android")]
    let snapshot = mobile_snapshot(snapshot)?;
    validate(&snapshot)?;
    Ok(serde_json::json!({"files":snapshot.files.len(),"createdAt":snapshot.created_at,"platform":snapshot.platform,
        "crossPlatform":snapshot.platform != std::env::consts::OS,"appVersion":snapshot.app_version}))
}
fn write_changes(root: &Path, changes: &BTreeMap<String, Option<String>>) -> Result<(), String> {
    for (name, value) in changes {
        let path = checked_path(root, name)?;
        match value {
            Some(raw) => crate::storage::replace_atomic(&path, raw.as_bytes())?,
            None if path.exists() => fs::remove_file(path).map_err(|_| "移除旧配置失败")?,
            None => (),
        }
    }
    Ok(())
}
pub(crate) fn recover(root: &Path) -> Result<(), String> {
    let path = root.join(JOURNAL);
    if !path.exists() { return Ok(()); }
    let bytes = fs::read(&path).map_err(|_| "读取恢复日志失败")?;
    let before: BTreeMap<String, Option<String>> = serde_json::from_slice(&bytes).map_err(|_| "恢复日志损坏，请保留恢复文件")?;
    write_changes(root, &before)?;
    fs::remove_file(path).map_err(|_| "恢复日志清理失败".into())
}
#[tauri::command]
pub async fn restore_config_snapshot(mut snapshot: Snapshot, state: tauri::State<'_, super::process::CoreStateMutex>) -> Result<(), String> {
    #[cfg(target_os = "android")]
    { snapshot = mobile_snapshot(snapshot)?; }
    validate(&snapshot)?;
    let _guard = super::process::LIFECYCLE.lock().await;
    let _geo_update = super::geo::UPDATE.try_lock().map_err(|_| "Geo 正在更新，请稍后再恢复配置")?;
    let _geo_config = super::geo::CONFIG.lock().await;
    #[cfg(target_os = "android")]
    {
        let status: serde_json::Value = crate::platform::android::call("status", ())?;
        if status["running"] == true || status["starting"] == true { return Err("请先断开 VPN 再恢复配置".into()); }
    }
    { let mut core = state.lock().map_err(|_| "核心状态不可用")?;
      if core.child.as_mut().is_some_and(|child| child.try_wait().map_or(true, |exit| exit.is_none())) { return Err("请先停止核心再恢复配置".into()); } }
    let root = crate::storage::data_dir();
    let current = collect(&root)?;
    if snapshot.platform != std::env::consts::OS {
        // Keep device ports/system integration. Portable data can be shared, while
        // process bindings require explicit review on the receiving platform.
        if let Some(raw) = snapshot.files.get_mut("config/preferences.json") {
            let incoming: super::settings::GeneralSettings = serde_json::from_str(raw).map_err(|_| "偏好无效")?;
            let mut local = super::settings::get_general_settings()?;
            local.only_proxy_traffic=incoming.only_proxy_traffic; local.log_capture=incoming.log_capture;
            local.tab_animation=incoming.tab_animation; local.geo_low_memory=incoming.geo_low_memory;
            local.speed_test_url=incoming.speed_test_url;
            *raw=serde_json::to_string(&local).map_err(|_| "生成本机偏好失败")?;
        }
        if let Some(raw) = snapshot.files.get_mut("config/routing-overrides.json") {
            let mut config: crate::routing_overrides::model::Overrides = serde_json::from_str(raw).map_err(|_| "分流无效")?;
            config.process_enabled=false; config.bundles_enabled=false;
            *raw=serde_json::to_string(&config).map_err(|_| "生成分流配置失败")?;
        }
        for raw in snapshot.browser_state.values_mut() {
            let mut instances: serde_json::Value = serde_json::from_str(raw).map_err(|_| "规则包状态无效")?;
            if let Some(items) = instances.as_array_mut() { for item in items { if let Some(object) = item.as_object_mut() {
                object.insert("enabled".into(), false.into());
                object.insert("watcherMode".into(), "disabled".into());
                object.remove("processBindings");
            } } }
            *raw = serde_json::to_string(&instances).map_err(|_| "生成规则包状态失败")?;
        }
    }
    // Parse all received profiles using this platform's core before modifying
    // any persistent file. The archive never selects a core executable.
    let incoming = snapshot.files.get("config/preferences.json")
        .map(|raw| serde_json::from_str::<super::settings::GeneralSettings>(raw).map_err(|_| "偏好无效"))
        .transpose()?.unwrap_or_default();
    for (name, raw) in &snapshot.files { if name.ends_with(".yaml") {
        let prepared = super::settings::prepare_with(raw, &incoming)?;
        tokio::task::spawn_blocking(move || super::profile::validate_config(&prepared)).await.map_err(|_| "备份校验任务失败")??;
    } }
    let mut changes: BTreeMap<String, Option<String>> = current.keys().map(|key| (key.clone(), None)).collect();
    for (key, value) in snapshot.files { changes.insert(key, Some(value)); }
    changes.insert(UI_PENDING.into(), Some(serde_json::to_string(&snapshot.browser_state).map_err(|_| "生成界面恢复数据失败")?));
    let mut before: BTreeMap<String, Option<String>> = changes.keys().map(|key| (key.clone(), current.get(key).cloned())).collect();
    before.insert(UI_PENDING.into(), fs::read_to_string(root.join(UI_PENDING)).ok());
    crate::storage::replace_atomic(&root.join(JOURNAL), &serde_json::to_vec(&before).map_err(|_| "生成恢复日志失败")?)?;
    if let Err(error) = write_changes(&root, &changes) { recover(&root).map_err(|_| format!("{error}；回滚失败，请保留恢复文件"))?; return Err(error); }
    fs::remove_file(root.join(JOURNAL)).map_err(|_| "恢复成功，但事务日志清理失败")?;
    Ok(())
}
#[tauri::command]
pub fn pending_restore_ui(acknowledge: bool) -> Result<Option<BTreeMap<String, String>>, String> {
    let path = crate::storage::data_dir().join(UI_PENDING);
    if !path.exists() { return Ok(None); }
    let data = serde_json::from_slice(&fs::read(&path).map_err(|_| "读取界面恢复数据失败")?).map_err(|_| "界面恢复数据无效")?;
    if acknowledge { fs::remove_file(path).map_err(|_| "确认界面恢复失败")?; }
    Ok(Some(data))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn mobile_snapshot_discards_desktop_bundle_state_before_validation() {
        let mut data = fixture();
        data.browser_state.insert(UI_KEYS[0].into(), "[{}]".into());
        let config = crate::routing_overrides::model::Overrides::default();
        data.files.insert("config/routing-overrides.json".into(), serde_json::to_string(&config).unwrap());
        let sanitized = mobile_snapshot(data).unwrap();
        assert!(sanitized.browser_state.is_empty());
        let routing: crate::routing_overrides::model::Overrides = serde_json::from_str(&sanitized.files["config/routing-overrides.json"]).unwrap();
        assert!(!routing.bundles_enabled);
        assert!(validate(&sanitized).is_ok());
    }
    fn fixture() -> Snapshot { Snapshot {schema_version:1,app_version:"2.0.4".into(),platform:"android".into(),created_at:0,
        files:BTreeMap::from([("config/default.yaml".into(),"proxies: []\n".into())]),browser_state:BTreeMap::new()} }
    #[test] fn rejects_traversal_runtime_files_and_invalid_versions() {
        for path in ["../secret", "config/profiles/../default.yaml", "core_data/config.yaml", "config/system-proxy-recovery.json"] {
            let mut data=fixture(); data.files.insert(path.into(),"{}".into()); assert!(validate(&data).is_err());
        }
        let mut data=fixture(); data.schema_version=2; assert!(validate(&data).is_err()); assert!(validate(&fixture()).is_ok());
    }
    #[test] fn refuses_index_referencing_missing_or_external_profile() {
        let mut data=fixture();
        let profile=super::super::profile::ProfileItem {id:"one".into(),file_path:"/private/config.yaml".into(),..Default::default()};
        data.files.insert("config/profiles.json".into(),serde_json::to_string(&vec![profile]).unwrap());
        assert!(validate(&data).is_err());
    }
    #[test] fn malformed_mobile_policy_and_ui_state_are_rejected_before_restore() {
        let mut data=fixture(); let mut settings=super::super::settings::GeneralSettings::default();
        settings.vpn_apps=super::super::mobile_settings::VpnApps {mode:"include".into(),packages:vec![]};
        data.files.insert("config/preferences.json".into(),serde_json::to_string(&settings).unwrap()); assert!(validate(&data).is_err());
        data.files.remove("config/preferences.json");
        for raw in ["[null]", "[{}]", "[\"invalid\"]"] {
            data.browser_state.insert(UI_KEYS[0].into(),raw.into()); assert!(validate(&data).is_err());
        }
    }
    #[test] fn interrupted_restore_recovers_old_files_and_removes_new_ones() {
        let root=std::env::temp_dir().join(format!("procweaver-restore-{}",std::process::id())); fs::create_dir_all(root.join("config/profiles")).unwrap();
        fs::write(root.join("config/default.yaml"),"new").unwrap(); fs::write(root.join("config/profiles/new.yaml"),"new").unwrap();
        let before=BTreeMap::from([("config/default.yaml",Some("old")),("config/profiles/new.yaml",None)]);
        fs::write(root.join(JOURNAL),serde_json::to_vec(&before).unwrap()).unwrap(); recover(&root).unwrap();
        assert_eq!(fs::read_to_string(root.join("config/default.yaml")).unwrap(),"old"); assert!(!root.join("config/profiles/new.yaml").exists());
        fs::remove_dir_all(root).unwrap();
    }
}

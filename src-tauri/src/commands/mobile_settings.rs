//! Mobile-specific settings keep system VPN policy separate from core routing.
use serde::{Deserialize, Serialize};
use serde_yaml::{Mapping, Value};

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LanSharing {
    pub port: u16,
    pub username: String,
    pub password: String,
    pub allowed_networks: Vec<String>,
    pub outbound: String,
}
impl Default for LanSharing {
    fn default() -> Self { Self { port: 7891, username: String::new(), password: String::new(),
        allowed_networks: vec!["10.0.0.0/8".into(), "172.16.0.0/12".into(), "192.168.0.0/16".into(), "fc00::/7".into()], outbound: String::new() } }
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct VpnApps { pub mode: String, pub packages: Vec<String> }
impl Default for VpnApps { fn default() -> Self { Self { mode: "all".into(), packages: vec![] } } }

pub fn validate(lan: &LanSharing, enabled: bool, apps: &VpnApps, mixed: u16, controller: u16) -> Result<(), String> {
    if !matches!(apps.mode.as_str(), "all" | "include" | "exclude") || apps.packages.len() > 1000 {
        return Err("VPN 应用名单无效".into());
    }
    if apps.mode == "include" && apps.packages.is_empty() { return Err("仅选中应用模式至少需要一个应用".into()); }
    if apps.packages.iter().any(|p| p.is_empty() || p.len() > 255 || !p.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'_')) {
        return Err("VPN 应用包名无效".into());
    }
    if !enabled { return Ok(()); }
    if lan.port == 0 || lan.port == mixed || lan.port == controller { return Err("共享端口不能为 0 或与本机端口重复".into()); }
    if lan.username.is_empty() || lan.username.len() > 64 || lan.username.contains(':') || lan.username.chars().any(char::is_control)
        || lan.password.len() < 8 || lan.password.len() > 128 || lan.password.chars().any(char::is_control) {
        return Err("共享代理需要有效用户名和 8–128 字节密码".into());
    }
    if lan.allowed_networks.is_empty() || lan.allowed_networks.len() > 64 { return Err("请设置 1–64 个允许访问的网段".into()); }
    for network in &lan.allowed_networks {
        let (address, prefix) = network.split_once('/').ok_or("允许网段需要 CIDR 格式，例如 192.168.1.0/24")?;
        let address: std::net::IpAddr = address.parse().map_err(|_| "允许网段地址无效")?;
        let prefix: u8 = prefix.parse().map_err(|_| "允许网段前缀无效")?;
        if prefix > if address.is_ipv4() { 32 } else { 128 } { return Err("允许网段前缀无效".into()); }
    }
    Ok(())
}

// Always discard an imported listener with our reserved name; recreate it from
// explicitly saved preferences only, after validating all untrusted listeners.
pub fn remove_managed_listener(map: &mut Mapping) {
    if let Some(listeners) = map.get_mut(Value::from("listeners")).and_then(Value::as_sequence_mut) {
        listeners.retain(|l| l.get("name").and_then(Value::as_str) != Some("procweaver-lan"));
    }
}

pub fn add_lan_listener(map: &mut Mapping, lan: &LanSharing) -> Result<(), String> {
    if !lan.outbound.is_empty() && !matches!(lan.outbound.as_str(), "DIRECT" | "REJECT") {
        let exists = ["proxies", "proxy-groups"].iter().any(|key| map.get(Value::from(*key)).and_then(Value::as_sequence)
            .is_some_and(|items| items.iter().any(|item| item.get("name").and_then(Value::as_str) == Some(&lan.outbound))));
        if !exists { return Err("共享出口已不存在，请重新选择".into()); }
    }
    let value = |v| serde_yaml::to_value(v).map_err(|_| "生成共享设置失败".to_string());
    map.insert("authentication".into(), value(vec![format!("{}:{}", lan.username, lan.password)])?);
    map.insert("skip-auth-prefixes".into(), value(vec!["127.0.0.0/8".into(), "::1/128".into()])?);
    let mut networks = lan.allowed_networks.clone(); networks.extend(["127.0.0.0/8".into(), "::1/128".into()]);
    map.insert("lan-allowed-ips".into(), value(networks)?);
    map.insert("lan-disallowed-ips".into(), Value::Sequence(vec![]));
    let listener = serde_json::json!({"name":"procweaver-lan", "type":"mixed", "listen":"0.0.0.0", "port":lan.port,
        "udp":false, "proxy":lan.outbound});
    // Omit users to share the core's authenticated store and source-IP ACL.
    map.entry(Value::from("listeners")).or_insert(Value::Sequence(vec![])).as_sequence_mut()
        .ok_or("listeners 必须是列表")?.push(serde_yaml::to_value(listener).map_err(|_| "生成共享监听失败")?);
    Ok(())
}

#[tauri::command]
pub fn get_lan_outbounds() -> Result<Vec<String>, String> {
    let (_, path) = crate::routing_overrides::current_source();
    let raw = std::fs::read_to_string(path).map_err(|_| "无法读取当前订阅")?;
    let yaml: Value = serde_yaml::from_str(&raw).map_err(|_| "当前订阅格式无效")?;
    let mut names = vec!["DIRECT".into(), "REJECT".into()];
    for key in ["proxies", "proxy-groups"] {
        if let Some(items) = yaml.get(key).and_then(Value::as_sequence) {
            names.extend(items.iter().filter_map(|item| item.get("name").and_then(Value::as_str).map(str::to_owned)));
        }
    }
    names.sort(); names.dedup(); Ok(names)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sharing_requires_credentials_and_valid_distinct_ports_and_cidrs() {
        let mut lan = LanSharing::default(); let apps = VpnApps::default();
        assert!(validate(&lan, false, &apps, 7890, 9090).is_ok());
        assert!(validate(&lan, true, &apps, 7890, 9090).is_err());
        lan.username="user".into(); lan.password="test-only-password".into();
        assert!(validate(&lan, true, &apps, 7890, 9090).is_ok());
        lan.allowed_networks=vec!["192.168.1.0/33".into()];
        assert!(validate(&lan, true, &apps, 7890, 9090).is_err());
        lan.allowed_networks=vec!["192.168.1.0/24".into()]; lan.port=7890;
        assert!(validate(&lan, true, &apps, 7890, 9090).is_err());
    }
    #[test]
    fn include_list_cannot_accidentally_capture_every_app() {
        assert!(validate(&LanSharing::default(), false, &VpnApps {mode:"include".into(), packages:vec![]},7890,9090).is_err());
    }
}

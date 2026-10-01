use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Endpoint {
    pub id: String,
    pub name: String,
    pub protocol: String,
    pub host: String,
    pub port: u16,
    #[serde(default)] pub username: String,
    // DPAPI ciphertext only; never returned by the public view or exported.
    #[serde(default)] pub secret: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Member {
    pub value: String,
    pub kind: String,
    pub descendants: bool,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Bundle {
    pub id: String,
    pub name: String,
    pub main_exe: String,
    pub enabled: bool,
    pub mode: String,
    pub domains: Vec<String>,
    pub members: Vec<Member>,
    pub endpoint_id: Option<String>,
    pub fallback: String,
    #[serde(default)] pub port: u16,
    #[serde(default)] pub dns_port: u16,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DnsSettings { pub enabled: bool, pub server: String, pub port: u16 }
impl Default for DnsSettings {
    fn default() -> Self { Self { enabled: false, server: "1.1.1.1".into(), port: 53 } }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub revision: u64,
    pub enabled: bool,
    pub default_endpoint_id: Option<String>,
    pub endpoints: Vec<Endpoint>,
    pub bundles: Vec<Bundle>,
    #[serde(default)] pub dns: DnsSettings,
}
impl Default for Config {
    fn default() -> Self { Self { revision: 0, enabled: true, default_endpoint_id: None, endpoints: vec![], bundles: vec![], dns: DnsSettings::default() } }
}
pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}
pub fn valid_host(host: &str) -> bool {
    !host.is_empty() && host.len() <= 253 && (host.parse::<std::net::IpAddr>().is_ok()
        || host.split('.').all(|s| !s.is_empty() && s.len() <= 63 && !s.starts_with('-') && !s.ends_with('-')
            && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')))
}
pub fn endpoint<'a>(config: &'a Config, bundle: &Bundle) -> Result<&'a Endpoint, String> {
    let id = bundle.endpoint_id.as_ref().or(config.default_endpoint_id.as_ref()).ok_or("请先配置默认或本包外部代理")?;
    config.endpoints.iter().find(|e| &e.id == id).ok_or_else(|| "所选外部代理已移除，请重新选择".into())
}
pub fn validate(config: &mut Config) -> Result<(), String> {
    config.dns.server = config.dns.server.trim().trim_start_matches('[').trim_end_matches(']').to_string();
    let dns_ip = config.dns.server.parse::<std::net::IpAddr>().map_err(|_| "DNS 上游须填写 IP，避免引导解析依赖")?;
    if config.dns.port == 0 || dns_ip.is_unspecified() || dns_ip.is_multicast() || dns_ip == std::net::IpAddr::V4(std::net::Ipv4Addr::BROADCAST) { return Err("DNS 上游地址或端口无效".into()); }
    if config.endpoints.len() > 128 || config.bundles.len() > 128 { return Err("外部代理和业务包各最多 128 项".into()); }
    let mut ids = HashSet::new();
    for e in &mut config.endpoints {
        e.host = e.host.trim().trim_start_matches('[').trim_end_matches(']').to_ascii_lowercase();
        if !valid_id(&e.id) || !ids.insert(e.id.clone()) || e.name.trim().is_empty() || e.name.len() > 120 || e.name.chars().any(char::is_control)
            || !matches!(e.protocol.as_str(), "http" | "socks5") || !valid_host(&e.host) || e.port == 0
            || e.username.len() > 255 || e.username.chars().any(char::is_control) || e.username.contains(':') {
            return Err("代理名称、协议、地址、端口或用户名无效".into());
        }
    }
    if config.default_endpoint_id.as_ref().is_some_and(|id| !ids.contains(id)) { return Err("默认代理不存在".into()); }
    ids.clear();
    for b in &mut config.bundles {
        if !valid_id(&b.id) || !ids.insert(b.id.clone()) || b.name.is_empty() || b.name.len() > 200 || b.name.chars().any(char::is_control)
            || !matches!(b.mode.as_str(), "strict" | "sandbox") || !matches!(b.fallback.as_str(), "direct" | "default")
            || b.members.is_empty() || b.members.len() > 256 || b.domains.len() > 512 {
            return Err("独立业务包的标识、进程、模式或未命中策略无效".into());
        }
        for m in &b.members {
            if m.value.is_empty() || m.value.len() > 1024 || m.value.chars().any(char::is_control)
                || m.value.contains(['*', '?']) || !m.value.to_ascii_lowercase().ends_with(".exe")
                || match m.kind.as_str() { "path" => !std::path::Path::new(&m.value).is_absolute(), "name" => m.value.contains(['/', '\\', ':']), _ => true } {
                return Err("独立模式进程应为 Windows EXE 名称或完整路径".into());
            }
        }
        if !b.members.iter().any(|m| crate::platform::same_path(&m.value, &b.main_exe)) { return Err("主程序须属于本包进程清单".into()); }
        if b.enabled && !b.members.iter().any(|m| m.kind == "path" || !super::identity::generic(&m.value)) {
            return Err("共享运行时作为独立主程序时，请从进程选择器绑定完整路径；仅有名称的伴生进程需要可核实的主程序祖先".into());
        }
        for d in &mut b.domains {
            *d = d.trim().trim_end_matches('.').to_ascii_lowercase();
            if !crate::routing_overrides::model::domain(d.strip_prefix("*.").unwrap_or(d)) { return Err("域名须为纯域名或 *.域名，国际域名请使用 Punycode".into()); }
        }
        b.domains.sort(); b.domains.dedup();
    }
    for b in config.bundles.iter().filter(|b| b.enabled && config.enabled) {
        endpoint(config, b)?;
        if b.mode == "sandbox" && b.fallback == "default" && config.default_endpoint_id.is_none() { return Err("未命中策略选择默认代理时，必须配置默认代理".into()); }
    }
    Ok(())
}
pub fn domain_matches(pattern: &str, host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    if let Some(suffix) = pattern.strip_prefix("*.") { host == suffix || host.ends_with(&format!(".{suffix}")) }
    else { host == pattern }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn domain_matching_has_boundaries_and_empty_list_does_not_match() {
        assert!(domain_matches("*.example.com", "EXAMPLE.com."));
        assert!(domain_matches("*.example.com", "a.example.com"));
        assert!(!domain_matches("*.example.com", "badexample.com"));
        assert!(!domain_matches("example.com", "a.example.com"));
        assert!(!valid_host("x\r\nAuthorization: secret"));
        assert!(!valid_host("user@host"));
    }
}

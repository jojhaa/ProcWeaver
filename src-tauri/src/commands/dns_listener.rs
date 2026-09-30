//! DNS listener policy is independent of resolver/upstream settings. Port allocation
//! happens only while applying a live plan, never while saving an offline definition.
use super::dns::{DnsListenerMode, DnsSettings};
use serde::{Deserialize, Serialize};
use serde_yaml::Value;
use std::net::SocketAddr;
use std::sync::atomic::Ordering;

const KEY: &str = "procweaver-dns-listener";
const FIRST_PORT: u16 = 45053;
const PORT_COUNT: u16 = 100;

#[derive(Serialize, Deserialize)]
struct Plan { movable: bool }

pub fn validate_guard(settings: &DnsSettings, guard: bool) -> Result<(), String> {
    if !guard { return Ok(()); }
    if settings.enable_override && !settings.status {
        return Err("DNS 护航仍在使用本地解析，请先关闭护航再停用核心 DNS".into());
    }
    match settings.listener_mode {
        Some(DnsListenerMode::Off) => Err("DNS 护航仍在使用 127.0.0.1:53，请先关闭护航再关闭监听".into()),
        Some(DnsListenerMode::Fixed) | None if (settings.listener_mode.is_some() || settings.enable_override)
            && super::dns_runtime::parse_listen(&settings.listen)? != "127.0.0.1:53".parse::<SocketAddr>().unwrap() =>
            Err("DNS 护航需要 127.0.0.1:53，不能移动到其他端口；请先关闭护航".into()),
        _ => Ok(()),
    }
}

fn cache_path() -> std::path::PathBuf {
    crate::storage::data_dir().join("config/dns-listener-runtime.json")
}

fn last_port() -> Option<u16> {
    let value: serde_json::Value = serde_json::from_slice(&std::fs::read(cache_path()).ok()?).ok()?;
    let port = value["port"].as_u64().and_then(|p| u16::try_from(p).ok())?;
    (port > 1024).then_some(port)
}

fn occupied(yaml: &Value, port: u16) -> bool {
    ["port", "socks-port", "mixed-port", "redir-port", "tproxy-port"].iter()
        .any(|key| crate::capture::contains_port(&yaml[*key], port))
        || ["external-controller", "external-controller-tls"].iter().any(|key|
            yaml[*key].as_str().and_then(|s| s.rsplit(':').next()).and_then(|s| s.parse::<u16>().ok()) == Some(port))
        || yaml["listeners"].as_sequence().is_some_and(|listeners| listeners.iter().any(|l|
            crate::capture::contains_port(&l["port"], port) || crate::capture::contains_port(&l["ports"], port)))
}

pub fn compose(raw: &str, config: &crate::routing_overrides::model::Overrides) -> Result<String, String> {
    let settings = super::dns::get_dns_settings()?;
    let guard = super::dns_adapter::get_dns_guard_status()?;
    compose_with(raw, config, &settings, guard, last_port(), super::settings::get_general_settings()?.allow_lan)
}

fn compose_with(raw: &str, config: &crate::routing_overrides::model::Overrides, settings: &DnsSettings, guard: bool, last: Option<u16>, allow_lan: bool) -> Result<String, String> {
    let mut yaml: Value = serde_yaml::from_str(raw).map_err(|_| "DNS 运行配置无法解析")?;
    if yaml.get(KEY).is_some() { return Err(format!("订阅包含保留字段 {KEY}")); }
    validate_guard(settings, guard)?;
    let Some(mode) = settings.listener_mode else {
        if guard && (yaml["dns"]["enable"].as_bool() != Some(true)
            || yaml["dns"]["listen"].as_str() != Some("127.0.0.1:53")) {
            return Err("DNS 护航仍在使用 127.0.0.1:53，请先关闭护航再修改监听".into());
        }
        return Ok(raw.into());
    };
    let capture = config.dns_enabled && config.dns_rules.iter().any(|r| r.enabled);
    if mode == DnsListenerMode::Off && capture {
        return Err("DNS 规则接管需要本地监听，请选择自动或固定模式，或先关闭 DNS 接管规则".into());
    }
    if yaml["dns"].is_null() { yaml["dns"] = Value::Mapping(Default::default()); }
    let existing = yaml["dns"]["listen"].as_str().filter(|s| !s.trim().is_empty())
        .map(super::dns_runtime::parse_listen).transpose()?;
    let movable = match mode {
        DnsListenerMode::Fixed => {
            let mut address = super::dns_runtime::parse_listen(&settings.listen)?;
            if !allow_lan && address.ip().is_unspecified() {
                address.set_ip(if address.is_ipv4() { std::net::Ipv4Addr::LOCALHOST.into() } else { std::net::Ipv6Addr::LOCALHOST.into() });
            }
            if !allow_lan && !address.ip().is_loopback() { return Err("关闭局域网访问时，DNS 监听只能绑定回环地址".into()); }
            yaml["dns"]["listen"] = address.to_string().into();
            false
        },
        DnsListenerMode::Off => { yaml["dns"]["listen"] = "".into(); false },
        DnsListenerMode::Auto if guard => {
            if yaml["dns"]["enable"].as_bool() != Some(true) { return Err("DNS 护航需要启用核心 DNS，请先关闭护航或启用 DNS".into()); }
            yaml["dns"]["listen"] = "127.0.0.1:53".into(); false
        },
        // Explicit port 53 and LAN DNS endpoints may have external clients; do not move them.
        DnsListenerMode::Auto if existing.is_some_and(|a| a.port() == 53 || !a.ip().is_loopback()) => false,
        DnsListenerMode::Auto if !capture => { yaml["dns"]["listen"] = "".into(); false },
        DnsListenerMode::Auto => {
            let port = last.into_iter().chain(FIRST_PORT..FIRST_PORT + PORT_COUNT).find(|port|
                !occupied(&yaml, *port) && !config.bundles.iter().any(|b| b.port == *port)
                && !(0..config.process_rules.len()).any(|i| 32000usize + i == *port as usize))
                .ok_or("自动 DNS 候选端口均与运行配置冲突，请配置固定端口")?;
            yaml["dns"]["listen"] = format!("127.0.0.1:{port}").into(); true
        },
    };
    yaml[KEY] = serde_yaml::to_value(Plan { movable }).map_err(|_| "DNS 监听策略无法编码")?;
    serde_yaml::to_string(&yaml).map_err(|_| "DNS 监听策略无法生成".into())
}

pub async fn resolve_for_apply(raw: &str, owned_pid: u32) -> Result<String, String> {
    let mut yaml: Value = serde_yaml::from_str(raw).map_err(|_| "DNS 运行配置无法解析")?;
    if yaml[KEY]["movable"].as_bool() != Some(true) || yaml["dns"]["enable"].as_bool() != Some(true) {
        return Ok(raw.into());
    }
    let preferred = yaml["dns"]["listen"].as_str().and_then(|s| super::dns_runtime::parse_listen(s).ok()).map(|a| a.port());
    let mut tried = std::collections::HashSet::new();
    let mut last_error = String::new();
    for port in preferred.into_iter().chain(FIRST_PORT..FIRST_PORT + PORT_COUNT) {
        if !tried.insert(port) || occupied(&yaml, port) { continue; }
        yaml["dns"]["listen"] = format!("127.0.0.1:{port}").into();
        if yaml["netbox-capture"].is_mapping() { yaml["netbox-capture"]["dns_port"] = port.into(); }
        let candidate = serde_yaml::to_string(&yaml).map_err(|_| "DNS 监听策略无法生成")?;
        match super::dns_runtime::preflight(&candidate, owned_pid).await {
            Ok(()) => return Ok(candidate),
            Err(error) => last_error = error,
        }
    }
    Err(format!("自动 DNS 无可用 TCP/UDP 端口，请选择固定端口。{last_error}"))
}

/// Called only after DNS, bundle routing and capture have all confirmed readiness.
pub fn remember_success(raw: &str) {
    let Ok(yaml) = serde_yaml::from_str::<Value>(raw) else { return; };
    if yaml[KEY]["movable"].as_bool() != Some(true) || yaml["dns"]["enable"].as_bool() != Some(true) { return; }
    let Some(port) = yaml["dns"]["listen"].as_str().and_then(|s| super::dns_runtime::parse_listen(s).ok()).map(|a| a.port()) else { return; };
    if last_port() == Some(port) { return; }
    let bytes = format!("{{\"port\":{port}}}\n");
    if let Err(error) = crate::storage::replace(&cache_path(), bytes.as_bytes()) {
        eprintln!("DNS 已生效，但无法保存自动端口：{error}");
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListenerStatus { pub running: bool, pub listen: Option<String>, pub resolver_enabled: bool }

#[tauri::command]
pub async fn get_dns_listener_status() -> Result<ListenerStatus, String> {
    let _lock = super::process::LIFECYCLE.lock().await;
    if !super::process::ACTIVE.load(Ordering::SeqCst) {
        return Ok(ListenerStatus { running: false, listen: None, resolver_enabled: false });
    }
    let raw = std::fs::read_to_string(crate::storage::data_dir().join("core_data/config.yaml")).map_err(|_| "读取 DNS 运行状态失败")?;
    let yaml: Value = serde_yaml::from_str(&raw).map_err(|_| "DNS 运行配置无法解析")?;
    let resolver_enabled = yaml["dns"]["enable"].as_bool() == Some(true);
    let listen = if resolver_enabled { yaml["dns"]["listen"].as_str().filter(|s| !s.is_empty()).map(str::to_owned) } else { None };
    Ok(ListenerStatus { running: true, listen, resolver_enabled })
}

#[cfg(test)]
mod tests;

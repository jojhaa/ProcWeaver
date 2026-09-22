//! Windows 纯应用层进程路由与状态管理。
pub mod smart_arbiter;
use crate::routing_overrides::{model::*, tracker::ProcessEntry};
use serde::{Deserialize, Serialize};
use serde_yaml::Value;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
};

#[derive(Clone, Serialize, Deserialize)]
pub struct Plan {
    pub config: Overrides,
    pub ports: Vec<u16>,
    pub dns_port: u16,
}
impl Plan {
    pub fn select(&self, p: &ProcessEntry) -> Option<usize> {
        if !self.config.process_enabled {
            return None;
        }
        let rules = &self.config.process_rules;
        let explicit = rules.iter().position(|r| {
            r.enabled
                && if r.match_kind == "path" {
                    p.executable_path
                        .as_ref()
                        .is_some_and(|v| v.eq_ignore_ascii_case(&r.match_value))
                } else {
                    p.name.eq_ignore_ascii_case(&r.match_value)
                }
        });
        explicit.or_else(|| {
            p.ancestors.iter().find_map(|(_, ancestor_path)| {
                let file_name = std::path::Path::new(ancestor_path).file_name().and_then(|f| f.to_str()).unwrap_or("");
                rules.iter().position(|r| {
                    r.enabled && r.include_descendants && (
                        if r.match_kind == "path" {
                            r.match_value.eq_ignore_ascii_case(ancestor_path)
                        } else {
                            r.match_value.eq_ignore_ascii_case(file_name)
                        }
                    )
                })
            })
        })
    }
    pub fn dns_matches(&self, query: &[u8]) -> bool {
        if !self.config.dns_enabled
            || query.len() < 12
            || query[2] & 0x80 != 0
            || query[4..6] != [0, 1]
        {
            return false;
        }
        let mut pos = 12;
        let mut domain = String::new();
        for _ in 0..128 {
            let Some(&len) = query.get(pos) else {
                return false;
            };
            pos += 1;
            if len == 0 {
                return query.len() >= pos + 4
                    && self.config.dns_rules.iter().any(|r| {
                        r.enabled
                            && (domain.eq_ignore_ascii_case(&r.domain)
                                || (r.domain_kind == "suffix"
                                    && domain
                                        .to_ascii_lowercase()
                                        .ends_with(&format!(".{}", r.domain))))
                    });
            }
            if len > 63 || domain.len() + len as usize > 253 {
                return false;
            }
            let Some(label) = query.get(pos..pos + len as usize) else {
                return false;
            };
            if !label.is_ascii() {
                return false;
            }
            if !domain.is_empty() {
                domain.push('.');
            }
            domain.push_str(std::str::from_utf8(label).unwrap());
            pos += len as usize;
        }
        false
    }
}
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub active: bool,
    pub transitioning: bool,
    pub message: String,
    pub tcp_connections: u64,
    pub udp_packets: u64,
    pub dns_queries: u64,
    pub failures: u64,
    pub unclassified: u64,
    pub last_error: Option<String>,
    pub recent_errors: Vec<ConnectionError>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionError {
    pub time_ms: u64,
    pub destination: String,
    pub stage: String,
    pub kind: String,
    pub system_code: Option<i32>,
}
pub(super) static TCP: AtomicU64 = AtomicU64::new(0);
pub(super) static UDP: AtomicU64 = AtomicU64::new(0);
pub(super) static DNS: AtomicU64 = AtomicU64::new(0);
pub(super) static FAILURES: AtomicU64 = AtomicU64::new(0);
pub(super) static UNKNOWN: AtomicU64 = AtomicU64::new(0);
static STATUS: Mutex<Status> = Mutex::new(Status {
    active: false,
    transitioning: false,
    message: String::new(),
    tcp_connections: 0,
    udp_packets: 0,
    dns_queries: 0,
    failures: 0,
    unclassified: 0,
    last_error: None,
    recent_errors: Vec::new(),
});
#[allow(dead_code)]
pub(super) fn is_normal_close(error: &std::io::Error) -> bool {
    matches!(
        error.kind(),
        std::io::ErrorKind::ConnectionReset
            | std::io::ErrorKind::ConnectionAborted
            | std::io::ErrorKind::BrokenPipe
            | std::io::ErrorKind::UnexpectedEof
            | std::io::ErrorKind::NotConnected
    ) || matches!(
        error.raw_os_error(),
        Some(10054) // WSAECONNRESET: 远程主机强迫关闭了一个现有的连接 (正常主动关闭/RST)
            | Some(10053) // WSAECONNABORTED: 本机软件中止连接
            | Some(10058) // WSAESHUTDOWN: 套接字已关闭
            | Some(10038) // WSAENOTSOCK
    )
}
#[allow(dead_code)]
pub(super) fn connection_error(stage: &str, destination: std::net::SocketAddr, error: &std::io::Error) {
    if is_normal_close(error) {
        return;
    }
    let item = ConnectionError {
        time_ms: std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64,
        destination: destination.to_string(), stage: stage.into(),
        kind: format!("{:?}", error.kind()), system_code: error.raw_os_error(),
    };
    // Memory only: bounded diagnostics, no URLs, payloads or browsing history file.
    let mut state = STATUS.lock().unwrap_or_else(|p| p.into_inner());
    if state.recent_errors.len() >= 12 { state.recent_errors.remove(0); }
    state.recent_errors.push(item);
}
#[allow(dead_code)]
pub(super) fn set_error(stage: &str, error: &std::io::Error) {
    if is_normal_close(error) {
        return;
    }
    // Never expose packet contents, hosts or credentials in diagnostics.
    STATUS.lock().unwrap_or_else(|p| p.into_inner()).last_error = Some(format!(
        "{stage}：{:?}（系统码 {}）", error.kind(), error.raw_os_error().map(|v| v.to_string()).unwrap_or_else(|| "无".into())
    ));
}
#[allow(dead_code)]
pub(super) fn record_error(stage: &str, error: &std::io::Error) {
    if is_normal_close(error) {
        return;
    }
    FAILURES.fetch_add(1, Ordering::Relaxed);
    set_error(stage, error);
}
pub fn status() -> Status {
    let mut s = STATUS.lock().unwrap_or_else(|p| p.into_inner()).clone();
    s.tcp_connections = TCP.load(Ordering::Relaxed);
    s.udp_packets = UDP.load(Ordering::Relaxed);
    s.dns_queries = DNS.load(Ordering::Relaxed);
    s.failures = FAILURES.load(Ordering::Relaxed);
    s.unclassified = UNKNOWN.load(Ordering::Relaxed);
    s
}
pub fn stop() {
    let mut s = STATUS.lock().unwrap_or_else(|p| p.into_inner());
    s.active = false;
    s.transitioning = false;
    s.message = "纯应用层引擎已就绪".into();
}
pub fn pause() {
    let mut s = STATUS.lock().unwrap_or_else(|p| p.into_inner());
    s.active = false;
    s.transitioning = true;
    s.message = "正在切换配置".into();
}
pub fn failed(message: &str) {
    let mut s = STATUS.lock().unwrap_or_else(|p| p.into_inner());
    s.active = false; s.transitioning = false; s.message = message.into();
}
pub async fn confirm_runtime(raw: &str) -> Result<(), String> {
    let yaml: Value = serde_yaml::from_str(raw).map_err(|_| "接管计划无效")?;
    if yaml["netbox-capture"].is_null() { stop(); return Ok(()); }
    let plan: Plan = serde_yaml::from_value(yaml["netbox-capture"].clone()).map_err(|_| "接管计划无效")?;
    let port = crate::commands::settings::get_general_settings()?.controller_port;
    let client = crate::commands::mihomo_api::controller_client().timeout(std::time::Duration::from_secs(2)).build().map_err(|_| "核心连接失败")?;
    let actual: serde_json::Value = client.get(format!("http://127.0.0.1:{port}/configs")).send().await.map_err(|_| "核心未就绪")?
        .error_for_status().map_err(|_| "核心拒绝状态核验")?.json().await.map_err(|_| "核心状态无效")?;
    if plan.config.process_enabled && actual["mode"].as_str() != Some("rule") { return Err("进程分流需要规则模式，请切回规则模式".into()); }
    let mut checks = tokio::task::JoinSet::new();
    for bundle in &plan.config.bundles {
        let port = bundle.port;
        checks.spawn(async move { tokio::time::timeout(std::time::Duration::from_millis(700), tokio::net::TcpStream::connect(("127.0.0.1", port))).await
            .map_err(|_| "业务包入口核验超时")?.map(|_| ()).map_err(|_| "业务包入口未监听") });
    }
    while let Some(result) = checks.join_next().await { result.map_err(|_| "业务包入口核验失败")??; }
    let mut s = STATUS.lock().unwrap_or_else(|p| p.into_inner());
    s.active = true; s.transitioning = false;
    s.message = "应用层规则与代理入口已就绪；应用接入与连接出口单独核验".into();
    Ok(())
}
pub fn compose(raw: &str, config: &Overrides, profile_id: &str, fallback: &[Value]) -> Result<String, String> {
    let process_active = config.process_enabled && config.process_rules.iter().any(|r| r.enabled);
    let dns_active = config.dns_enabled && config.dns_rules.iter().any(|r| r.enabled);
    if !process_active && !dns_active && config.bundles.is_empty() {
        return Ok(raw.into());
    }
    let targets = crate::routing_overrides::composer::targets(raw, profile_id)?;
    let mut yaml: Value = serde_yaml::from_str(raw).map_err(|_| "接管配置 YAML 无效")?;
    if yaml.get("netbox-capture").is_some() {
        return Err("订阅包含保留字段 netbox-capture".into());
    }
    let mut listeners = yaml["listeners"].as_sequence().cloned().unwrap_or_default();
    let mut subrules = yaml["sub-rules"].as_mapping().cloned().unwrap_or_default();
    let exclusions = crate::commands::exclusions::get_exclusions()?;
    let prefix = crate::commands::exclusions::compose("rules: []", &exclusions)?;
    let prefix: Value = serde_yaml::from_str(&prefix).map_err(|_| "排除规则无效")?;
    let ports: Vec<u16> = (0..config.process_rules.len())
        .map(|i| 32000 + i as u16)
        .collect();
    let mut occupied: Vec<u16> = [
        "port",
        "socks-port",
        "mixed-port",
        "redir-port",
        "tproxy-port",
    ]
    .iter()
    .filter_map(|key| yaml[*key].as_u64().and_then(|v| u16::try_from(v).ok()))
    .collect();
    if let Some(port) = yaml["external-controller"]
        .as_str()
        .and_then(|v| v.rsplit(':').next())
        .and_then(|v| v.parse::<u16>().ok())
    {
        occupied.push(port);
    }
    if process_active {
        for (i, r) in config
            .process_rules
            .iter()
            .enumerate()
            .filter(|(_, r)| r.enabled && crate::routing_overrides::bundles::owner(&r.id, &config.bundles).is_none())
        {
            let name = format!("netbox-capture-{i}");
            let port = ports[i];
            if occupied.contains(&port)
                || listeners.iter().any(|l| {
                    l["name"].as_str() == Some(&name)
                        || contains_port(&l["port"], port)
                        || contains_port(&l["ports"], port)
                })
                || subrules.contains_key(Value::from(name.clone()))
            {
                return Err("订阅与进程接管监听名称或端口冲突".into());
            }
            let target = match r.action.as_str() {
                "direct" => "DIRECT",
                "reject" => "REJECT",
                _ => r
                    .target
                    .as_ref()
                    .filter(|t| targets.contains(t))
                    .map_or("REJECT", |t| t.name.as_str()),
            };
            let mut rules = prefix["rules"].as_sequence().cloned().unwrap_or_default();
            rules.push(format!("MATCH,{target}").into());
            rules.push("MATCH,REJECT".into());
            subrules.insert(name.clone().into(), rules.into());
            for (suffix, listen) in [("", "127.0.0.1"), ("-v6", "::1")] {
                let listener_name = format!("{name}{suffix}");
                if listeners.iter().any(|l| l["name"].as_str() == Some(&listener_name)) { return Err("进程接管监听名称冲突".into()); }
                listeners.push(serde_yaml::to_value(serde_json::json!({"name":listener_name,"type":"mixed","listen":listen,"port":port,"udp":true,"users":[],"rule":name})).map_err(|_|"生成进程接管监听失败")?);
            }
        }
    }
    yaml["listeners"] = listeners.into();
    yaml["sub-rules"] = subrules.into();
    if config.bundles.iter().any(|b| occupied.contains(&b.port)) { return Err("业务包入口与核心端口冲突".into()); }
    crate::routing_overrides::bundles::add_listeners(&mut yaml, config, &prefix, fallback)?;
    let mut dns_port = 31999;
    if dns_active {
        if yaml["dns"].is_null() {
            yaml["dns"] = Value::Mapping(Default::default());
        }
        if let Some(existing) = yaml["dns"]["listen"].as_str().filter(|v| !v.is_empty()) {
            let address: std::net::SocketAddr = existing
                .parse()
                .map_err(|_| "已有 DNS 监听格式不支持接管，未覆盖原设置")?;
            if !address.is_ipv4()
                || (!address.ip().is_loopback() && !address.ip().is_unspecified())
                || address.port() == 0
            {
                return Err("已有 DNS 监听无法通过 IPv4 回环访问，未覆盖原设置".into());
            }
            dns_port = address.port();
        } else {
            yaml["dns"]["listen"] = "127.0.0.1:31999".into();
        }
        if occupied.contains(&dns_port)
            || yaml["listeners"].as_sequence().is_some_and(|ls| {
                ls.iter().any(|l| {
                    contains_port(&l["port"], dns_port) || contains_port(&l["ports"], dns_port)
                })
            })
        {
            return Err("DNS 接管端口与已有监听冲突".into());
        }
    }
    let mut active = config.clone();
    active.process_enabled = process_active;
    active.dns_enabled = dns_active;
    yaml["netbox-capture"] = serde_yaml::to_value(Plan {
        config: active,
        ports,
        dns_port,
    })
    .map_err(|_| "生成接管计划失败")?;
    serde_yaml::to_string(&yaml).map_err(|_| "生成接管配置失败".into())
}
pub(crate) fn contains_port(value: &Value, port: u16) -> bool {
    if let Some(n) = value.as_u64() {
        return n == port as u64;
    }
    if let Some(items) = value.as_sequence() {
        return items.iter().any(|v| contains_port(v, port));
    }
    value.as_str().is_some_and(|text| {
        text.split(',').any(|part| {
            let part = part.trim();
            if let Ok(n) = part.parse::<u16>() {
                return n == port;
            }
            part.split_once('-').is_some_and(|(a, b)| {
                match (a.trim().parse::<u16>(), b.trim().parse::<u16>()) {
                    (Ok(a), Ok(b)) => (a..=b).contains(&port),
                    _ => false,
                }
            })
        })
    })
}
pub async fn run() {
    let mut previous = String::new();
    loop {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        let _lock = crate::commands::process::LIFECYCLE.lock().await;
        if !crate::commands::process::ACTIVE.load(Ordering::SeqCst) {
            stop();
            previous.clear();
            continue;
        }
        let active_driver = smart_arbiter::get_active_driver_name();
        if active_driver == "tun" {
            stop();
            previous.clear();
            continue;
        }
        let result = async {
            let raw =
                std::fs::read_to_string(crate::storage::data_dir().join("core_data/config.yaml"))
                    .map_err(|_| "读取接管计划失败".to_string())?;
            let yaml: Value = serde_yaml::from_str(&raw).map_err(|_| "接管计划无效".to_string())?;
            if yaml["netbox-capture"].is_null() {
                stop();
                previous.clear();
                return Ok(());
            }
            let plan: Plan = serde_yaml::from_value(yaml["netbox-capture"].clone())
                .map_err(|_| "接管计划无效".to_string())?;
            let signature = serde_json::to_string(&plan).map_err(|_| "接管计划无效".to_string())?;
            if signature == previous && status().active {
                return Ok(());
            }
            confirm_runtime(&raw).await?;
            previous = signature;
            Ok::<(), String>(())
        }
        .await;
        drop(_lock);
        if let Err(error) = result {
            failed(&error);
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }
    }
}

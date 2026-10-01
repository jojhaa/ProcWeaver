//! Independent application proxy runtime. Its lifecycle never starts/stops Mihomo.
mod identity;
pub mod model;
mod server;
mod secrets;
mod transport;
mod udp;
mod dns;
mod probe;
mod sniff;
#[cfg(windows)] pub(crate) mod captured;
#[cfg(test)] mod tests;
#[cfg(all(test, windows))] mod udp_tests;

use model::{Bundle, Config, Endpoint};
use serde::{Deserialize, Serialize};
use std::{collections::{BTreeMap, VecDeque}, path::PathBuf, sync::{Arc, LazyLock, Mutex, RwLock, atomic::{AtomicU64, Ordering}}};
use tokio::{net::TcpListener, sync::{watch, Semaphore}};
static ENGINE: LazyLock<Mutex<Option<Arc<Engine>>>> = LazyLock::new(|| Mutex::new(None));
static OPERATIONS: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

struct Listener { port: u16, stop: watch::Sender<bool>, task: tokio::task::JoinHandle<()> }
pub(crate) struct Engine {
    root: PathBuf,
    config: RwLock<Config>,
    listeners: Mutex<BTreeMap<String, Listener>>,
    dns_listeners: Mutex<BTreeMap<String, Listener>>,
    errors: Mutex<BTreeMap<String, String>>,
    records: Mutex<VecDeque<Record>>,
    serial: AtomicU64,
    capacity: Arc<Semaphore>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub id: u64, pub bundle_id: String, pub generation: u64,
    pub pid: u32, pub process: String, pub target: String, pub route: String,
    pub upstream: String, pub state: String, pub message: String,
    pub uploaded: u64, pub downloaded: u64, pub at: u64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointView { pub id: String, pub name: String, pub protocol: String, pub host: String, pub port: u16, pub username: String, pub has_password: bool }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleState { pub id: String, pub port: u16, pub ready: bool, pub dns_port: u16, pub dns_ready: bool, pub upstream: String, pub error: String }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    pub revision: u64, pub enabled: bool, pub default_endpoint_id: Option<String>,
    pub endpoints: Vec<EndpointView>, pub bundles: Vec<Bundle>, pub states: Vec<BundleState>,
    pub records: Vec<Record>, pub supported: bool,
    pub dns: model::DnsSettings,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EndpointInput { pub id: String, pub name: String, pub protocol: String, pub host: String, pub port: u16, pub username: String, pub password: Option<String> }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettingsInput { pub revision: u64, pub default_endpoint_id: Option<String>, pub endpoints: Vec<EndpointInput>, #[serde(default)] pub dns: Option<model::DnsSettings> }

impl Engine {
    fn load(root: PathBuf) -> Result<Arc<Self>, String> {
        let file = root.join("config/external-proxy.json");
        let mut config = match std::fs::read(&file) {
            Ok(bytes) if bytes.len() <= 2 * 1024 * 1024 => serde_json::from_slice(&bytes).map_err(|_| "独立代理配置损坏，未覆盖原文件")?,
            Ok(_) => return Err("独立代理配置超过大小限制".into()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Config::default(),
            Err(_) => return Err("无法读取独立代理配置".into()),
        };
        model::validate(&mut config)?;
        Ok(Arc::new(Self { root, config: RwLock::new(config), listeners: Mutex::new(BTreeMap::new()), dns_listeners: Mutex::new(BTreeMap::new()), errors: Mutex::new(BTreeMap::new()),
            records: Mutex::new(VecDeque::new()), serial: AtomicU64::new(1), capacity: Arc::new(Semaphore::new(512)) }))
    }
    fn config(&self) -> Config { self.config.read().unwrap_or_else(|e| e.into_inner()).clone() }
    fn view(&self) -> View {
        let config = self.config();
        let listeners = self.listeners.lock().unwrap_or_else(|e| e.into_inner());
        let dns_listeners = self.dns_listeners.lock().unwrap_or_else(|e| e.into_inner());
        let errors = self.errors.lock().unwrap_or_else(|e| e.into_inner());
        let states = config.bundles.iter().map(|b| BundleState { id: b.id.clone(), port: b.port,
            dns_port: b.dns_port, dns_ready: config.dns.enabled && config.enabled && b.enabled && dns_listeners.get(&b.id).is_some_and(|l| !l.task.is_finished() && l.port == b.dns_port),
            ready: config.enabled && b.enabled && listeners.get(&b.id).is_some_and(|l| !l.task.is_finished() && l.port == b.port),
            upstream: model::endpoint(&config, b).map(|e| e.name.clone()).unwrap_or_default(), error: errors.get(&b.id).cloned().unwrap_or_default() }).collect();
        View { revision: config.revision, enabled: config.enabled, default_endpoint_id: config.default_endpoint_id,
            endpoints: config.endpoints.iter().map(|e| EndpointView { id: e.id.clone(), name: e.name.clone(), protocol: e.protocol.clone(), host: e.host.clone(), port: e.port, username: e.username.clone(), has_password: !e.secret.is_empty() }).collect(),
            dns: config.dns, bundles: config.bundles, states, records: self.records.lock().unwrap_or_else(|e| e.into_inner()).iter().rev().take(100).cloned().collect(), supported: cfg!(windows) }
    }
    async fn apply(self: &Arc<Self>, mut next: Config) -> Result<View, String> {
        model::validate(&mut next)?;
        if !cfg!(windows) && !next.bundles.is_empty() { return Err("独立进程代理首期支持 Windows".into()); }
        let old = self.config();
        if next.revision != old.revision { return Err("独立代理设置已改变，请刷新后重试".into()); }
        let mut prepared = Vec::new();
        let mut prepared_dns = Vec::new();
        for b in &mut next.bundles {
            b.port = old.bundles.iter().find(|v| v.id == b.id).map(|v| v.port).unwrap_or(0);
            b.dns_port = old.bundles.iter().find(|v| v.id == b.id).map(|v| v.dns_port).unwrap_or(0);
            if !next.enabled || !b.enabled { continue; }
            if next.dns.enabled && !self.dns_listeners.lock().unwrap_or_else(|e| e.into_inner()).get(&b.id).is_some_and(|l| !l.task.is_finished() && l.port == b.dns_port) {
                let (tcp, udp) = dns::bind(b.dns_port).await.map_err(|e| format!("「{}」{e}", b.name))?;
                b.dns_port = tcp.local_addr().map_err(|_| "读取 DNS 入口失败")?.port();
                prepared_dns.push((b.id.clone(), b.dns_port, tcp, udp));
            }
            if self.listeners.lock().unwrap_or_else(|e| e.into_inner()).get(&b.id).is_some_and(|l| !l.task.is_finished() && l.port == b.port) { continue; }
            let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, b.port)).await.map_err(|_| format!("「{}」本地入口被占用或不可绑定；保留原设置，请关闭占用后重试", b.name))?;
            b.port = listener.local_addr().map_err(|_| "读取独立入口失败")?.port();
            prepared.push((b.id.clone(), b.port, listener));
        }
        let ports: Vec<_> = next.bundles.iter().flat_map(|b| [b.port, b.dns_port]).filter(|p| *p != 0).collect();
        if next.dns.enabled && next.dns.server.parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback()) && ports.contains(&next.dns.port) { return Err("DNS 上游不能指向本程序入口".into()); }
        for e in &next.endpoints {
            if (e.host == "localhost" || e.host.parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback())) && ports.contains(&e.port) {
                return Err("上游不能指向本程序业务入口".into());
            }
            if !e.username.is_empty() { secrets::reveal(&e.secret)?; }
        }
        next.revision = old.revision.checked_add(1).ok_or("配置版本已耗尽")?;
        crate::storage::replace_atomic(&self.root.join("config/external-proxy.json"), &serde_json::to_vec_pretty(&next).map_err(|_| "生成独立代理配置失败")?).map_err(|_| "独立代理配置保存失败，原运行状态保留")?;
        *self.config.write().unwrap_or_else(|e| e.into_inner()) = next.clone();
        let mut stopped = {
            let mut listeners = self.listeners.lock().unwrap_or_else(|e| e.into_inner());
            let remove: Vec<_> = listeners.iter().filter(|(id, entry)| !next.enabled || !next.bundles.iter().any(|b| b.id == **id && b.enabled) || entry.task.is_finished()).map(|(id, _)| id.clone()).collect();
            let stopped: Vec<_> = remove.into_iter().filter_map(|id| listeners.remove(&id)).collect();
            for entry in &stopped { let _ = entry.stop.send(true); }
            for (id, port, listener) in prepared {
                let (stop, rx) = watch::channel(false);
                let runtime = self.clone(); let bundle_id = id.clone();
                let task = tokio::spawn(async move { server::listen(runtime, bundle_id, listener, rx).await; });
                listeners.insert(id, Listener { port, stop, task });
            }
            stopped
        };
        {
            let mut listeners = self.dns_listeners.lock().unwrap_or_else(|e| e.into_inner());
            let remove: Vec<_> = listeners.iter().filter(|(id, entry)| !next.enabled || !next.dns.enabled || !next.bundles.iter().any(|b| b.id == **id && b.enabled) || entry.task.is_finished()).map(|(id, _)| id.clone()).collect();
            for id in remove { if let Some(entry) = listeners.remove(&id) { let _ = entry.stop.send(true); stopped.push(entry); } }
            for (id, port, tcp, udp) in prepared_dns {
                let (stop, rx) = watch::channel(false); let runtime = self.clone(); let bundle_id = id.clone();
                let task = tokio::spawn(async move { dns::listen(runtime, bundle_id, tcp, udp, rx).await; });
                listeners.insert(id, Listener { port, stop, task });
            }
        }
        // A successful disable means its stable port has actually been released.
        for entry in stopped { let _ = entry.task.await; }
        self.errors.lock().unwrap_or_else(|e| e.into_inner()).clear();
        Ok(self.view())
    }
    fn select(&self, id: &str, process: &crate::routing_overrides::tracker::ProcessEntry, destination: &transport::Destination) -> Result<(Option<Endpoint>, String, u64, Vec<u16>), String> {
        let config = self.config.read().unwrap_or_else(|e| e.into_inner());
        let b = config.bundles.iter().find(|b| b.id == id).ok_or("业务包已移除")?;
        if !config.enabled || !b.enabled { return Err("独立业务包已停用".into()); }
        if identity::owner(&config.bundles, process) != Some(id) { return Err("连接进程不属于本业务包或归属不唯一，已拒绝转发".into()); }
        let matched = b.mode == "strict" || b.domains.iter().any(|d| model::domain_matches(d, &destination.host));
        let (endpoint, reason) = if matched { (Some(model::endpoint(&config, b)?.clone()), "业务包") }
            else if b.fallback == "default" { (Some(config.endpoints.iter().find(|e| Some(&e.id) == config.default_endpoint_id.as_ref()).ok_or("默认代理不可用")?.clone()), "未命中→默认代理") }
            else { (None, "未命中→直连") };
        let ports = config.bundles.iter().flat_map(|b| [b.port, b.dns_port]).filter(|p| *p != 0).collect();
        Ok((endpoint, reason.into(), config.revision, ports))
    }
    fn record(&self, bundle: &str, pid: u32, process: &str, target: &str, route: &str, generation: u64, endpoint: Option<&Endpoint>) -> u64 {
        let id = self.serial.fetch_add(1, Ordering::Relaxed);
        let mut records = self.records.lock().unwrap_or_else(|e| e.into_inner());
        while records.len() >= 200 { records.pop_front(); }
        records.push_back(Record { id, bundle_id: bundle.into(), generation, pid, process: process.into(), target: target.into(), route: route.into(), upstream: endpoint.map(|e| e.name.clone()).unwrap_or_else(|| "直连".into()), state: "connecting".into(), message: String::new(), uploaded: 0, downloaded: 0,
            at: std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64 }); id
    }
    fn update(&self, id: u64, state: &str, message: &str, bytes: (u64, u64)) {
        if let Some(record) = self.records.lock().unwrap_or_else(|e| e.into_inner()).iter_mut().find(|r| r.id == id) {
            record.state = state.into(); record.message = message.into(); record.uploaded = bytes.0; record.downloaded = bytes.1;
        }
    }
    fn stop(&self) {
        for (_, listener) in std::mem::take(&mut *self.listeners.lock().unwrap_or_else(|e| e.into_inner())) { let _ = listener.stop.send(true); }
        for (_, listener) in std::mem::take(&mut *self.dns_listeners.lock().unwrap_or_else(|e| e.into_inner())) { let _ = listener.stop.send(true); }
    }
}
fn engine() -> Result<Arc<Engine>, String> {
    let mut value = ENGINE.lock().unwrap_or_else(|e| e.into_inner());
    if value.is_none() { *value = Some(Engine::load(crate::storage::data_dir())?); }
    Ok(value.as_ref().unwrap().clone())
}
pub fn monitoring_required() -> bool {
    ENGINE.lock().unwrap_or_else(|e| e.into_inner()).as_ref().is_some_and(|runtime| { let config = runtime.config.read().unwrap_or_else(|e| e.into_inner()); config.enabled && config.bundles.iter().any(|b| b.enabled) })
}
pub(crate) fn monitor_fingerprints(state: &crate::routing_overrides::tracker::TrackingStatus) -> std::collections::BTreeMap<String, String> {
    let mut result = std::collections::BTreeMap::new();
    let engine = ENGINE.lock().unwrap_or_else(|e| e.into_inner());
    let Some(runtime) = engine.as_ref() else { return result; };
    let config = runtime.config.read().unwrap_or_else(|e| e.into_inner());
    if !config.enabled { return result; }
    let mut owned: std::collections::BTreeMap<&str, Vec<_>> = std::collections::BTreeMap::new();
    for entry in &state.entries {
        if let Some(id) = identity::owner(&config.bundles, entry) {
            owned.entry(id).or_default().push((&entry.identity, &entry.executable_path, &entry.parent_identity));
        }
    }
    for bundle in config.bundles.iter().filter(|b| b.enabled) {
        let entries = owned.get(bundle.id.as_str());
        result.insert(bundle.id.clone(), serde_json::to_string(&(bundle, entries, &state.unverified_names)).unwrap_or_default());
    }
    result
}
pub fn check_core_conflicts(core: &crate::routing_overrides::model::Overrides) -> Result<(), String> {
    if !crate::function_mode::core_features_enabled() { return Ok(()); }
    let Ok(runtime) = engine() else { return Ok(()); };
    validate_core_separation(&runtime.config(), core)
}
fn validate_core_separation(config: &Config, core: &crate::routing_overrides::model::Overrides) -> Result<(), String> {
    if !config.enabled { return Ok(()); }
    let core = core.effective();
    for bundle in config.bundles.iter().filter(|b| b.enabled) {
        if core.bundles.iter().any(|b| b.id == bundle.id && b.enabled) { return Err("此包的独立代理仍已启用，请先切换出口方式再应用核心规则".into()); }
        for member in &bundle.members {
            if member.kind == "name" && identity::generic(&member.value) { continue; }
            let overlaps = |kind: &str, value: &str| {
                if kind == member.kind { crate::platform::same_path(value, &member.value) }
                else if kind == "name" { crate::platform::same_path(value, member.value.rsplit(['\\', '/']).next().unwrap_or("")) }
                else { crate::platform::same_path(value.rsplit(['\\', '/']).next().unwrap_or(""), &member.value) }
            };
            if core.process_rules.iter().any(|r| r.enabled && overlaps(&r.match_kind, &r.match_value)
                && crate::routing_overrides::ownership::standalone(r, &core)) { return Err("核心进程规则与已启用的独立业务包重复，请调整绑定".into()); }
        }
    }
    Ok(())
}
pub fn route(id: &str) -> Result<Option<crate::routing_overrides::model::BundleRoute>, String> {
    let runtime = engine()?;
    let config = runtime.config.read().unwrap_or_else(|e| e.into_inner());
    Ok(config.bundles.iter().find(|b| b.id == id).map(|b| launch_route(b, config.enabled)))
}
fn launch_route(b: &Bundle, enabled: bool) -> crate::routing_overrides::model::BundleRoute {
    crate::routing_overrides::model::BundleRoute { id: b.id.clone(), name: b.name.clone(), main_exe: b.main_exe.clone(), enabled: b.enabled && enabled, main_target: None, dns_target: None, port: b.port, mode: b.mode.clone(), domains: b.domains.clone(), fallback: "direct".into() }
}
pub fn routes() -> Vec<crate::routing_overrides::model::BundleRoute> {
    engine().map(|runtime| {
        let config = runtime.config.read().unwrap_or_else(|e| e.into_inner());
        config.bundles.iter().map(|b| launch_route(b, config.enabled)).collect()
    }).unwrap_or_default()
}
pub fn generation(id: &str) -> Option<u64> { engine().ok().and_then(|e| { let c = e.config.read().unwrap_or_else(|e| e.into_inner()); c.bundles.iter().any(|b| b.id == id).then_some(c.revision) }) }
pub fn ensure_ready(id: &str) -> Result<crate::routing_overrides::model::BundleRoute, String> {
    let runtime = engine()?;
    let bundle = route(id)?.ok_or("独立业务包未保存")?;
    if !bundle.enabled { return Err("独立业务包或独立代理总开关已停用".into()); }
    if !runtime.listeners.lock().unwrap_or_else(|e| e.into_inner()).get(id).is_some_and(|l| l.port == bundle.port && !l.task.is_finished()) { return Err("独立入口未就绪，请在业务包页面重新应用".into()); }
    Ok(bundle)
}
pub fn connection_evidence(id: &str) -> Option<(String, String, Vec<String>)> {
    let runtime = engine().ok()?;
    if !runtime.config().bundles.iter().any(|b| b.id == id) { return None; }
    let records = runtime.records.lock().unwrap_or_else(|e| e.into_inner());
    let recent: Vec<_> = records.iter().rev().filter(|r| r.bundle_id == id).take(4).collect();
    let state = if recent.first().is_some_and(|r| r.state == "failed") { "error" } else if recent.iter().any(|r| matches!(r.state.as_str(), "active" | "closed" | "response")) { "observed" } else { "idle" };
    Some((state.into(), "独立代理连接记录（含历史连接）；入口就绪不代表外部代理可用".into(), recent.iter().map(|r| format!("{} · {} → {} · {}{}", r.target, r.route, r.upstream, r.state, if r.message.is_empty() { String::new() } else { format!("：{}", r.message) })).collect()))
}
pub async fn restore() {
    let _lock = OPERATIONS.lock().await;
    let _core = crate::commands::process::LIFECYCLE.lock().await;
    let Ok(runtime) = engine() else { return; };
    let config = runtime.config();
    if config.bundles.iter().any(|b| b.enabled) && config.enabled {
        if let Ok(core) = crate::routing_overrides::read() {
            if let Err(error) = check_core_conflicts(&core) {
                *runtime.errors.lock().unwrap_or_else(|e| e.into_inner()) = config.bundles.iter().filter(|b| b.enabled).map(|b| (b.id.clone(), error.clone())).collect();
                return;
            }
        }
        if let Err(error) = runtime.apply(config.clone()).await {
            *runtime.errors.lock().unwrap_or_else(|e| e.into_inner()) = config.bundles.iter().filter(|b| b.enabled).map(|b| (b.id.clone(), error.clone())).collect();
        }
    }
}
pub fn shutdown() { if let Some(runtime) = ENGINE.lock().unwrap_or_else(|e| e.into_inner()).as_ref() { runtime.stop(); } }
#[tauri::command]
pub fn get_external_proxy() -> Result<View, String> { Ok(engine()?.view()) }
#[tauri::command]
pub async fn save_external_proxy_settings(input: SettingsInput) -> Result<View, String> {
    let _lock = OPERATIONS.lock().await;
    let _core = crate::commands::process::LIFECYCLE.lock().await;
    let runtime = engine()?; let mut config = runtime.config();
    if input.revision != config.revision { return Err("配置已改变，请刷新后重试".into()); }
    if input.endpoints.len() > 128 { return Err("最多保存 128 个外部代理".into()); }
    match crate::routing_overrides::read() {
        Ok(core) => check_core_conflicts(&core)?,
        Err(error) if crate::commands::process::ACTIVE.load(Ordering::SeqCst) => return Err(error),
        Err(_) => {},
    }
    let mut endpoints = Vec::new();
    for input in input.endpoints {
        let secret = if input.username.is_empty() { String::new() }
            else if let Some(password) = input.password { secrets::protect(&password)? }
            else { config.endpoints.iter().find(|e| e.id == input.id && e.username == input.username).map(|e| e.secret.clone()).filter(|v| !v.is_empty()).ok_or("新增或修改认证用户时请输入密码")? };
        endpoints.push(Endpoint { id: input.id, name: input.name, protocol: input.protocol, host: input.host, port: input.port, username: input.username, secret });
    }
    config.endpoints = endpoints; config.default_endpoint_id = input.default_endpoint_id;
    if let Some(dns) = input.dns { config.dns = dns; }
    runtime.apply(config).await
}
#[tauri::command]
pub async fn apply_external_bundles(revision: u64, bundles: Vec<Bundle>, enabled: bool) -> Result<View, String> {
    let _lock = OPERATIONS.lock().await;
    let _core = crate::commands::process::LIFECYCLE.lock().await;
    let runtime = engine()?; let mut config = runtime.config();
    if revision != config.revision { return Err("独立代理配置已改变，请重新加载后应用".into()); }
    config.bundles = bundles; config.enabled = enabled;
    // A stale core rule would otherwise also act on the same process in TUN or
    // WinDivert. The controller must detach it before activating this backend.
    let core = match crate::routing_overrides::read() {
        Ok(config) => config.effective(),
        Err(error) if crate::commands::process::ACTIVE.load(Ordering::SeqCst) => return Err(error),
        Err(_) => crate::routing_overrides::model::Overrides::default(),
    };
    if crate::function_mode::core_features_enabled() { validate_core_separation(&config, &core)?; }
    runtime.apply(config).await
}
#[tauri::command]
pub async fn test_external_proxy(endpoint_id: String, host: String, port: u16, protocol: Option<String>, query_name: Option<String>, timeout_ms: Option<u64>) -> Result<String, String> {
    let runtime = engine()?; let config = runtime.config();
    let endpoint = config.endpoints.iter().find(|e| e.id == endpoint_id).ok_or("请先保存代理设置")?;
    let ports = config.bundles.iter().flat_map(|b| [b.port, b.dns_port]).collect::<Vec<_>>();
    let destination = transport::Destination::new(&host, port)?;
    probe::run(endpoint, destination, protocol.as_deref().unwrap_or("tcp"), query_name.as_deref(), timeout_ms.unwrap_or(10000), &ports).await
}

//! Local nodes are independent of subscription files. References use immutable aliases.
use crate::{commands::{process, profile}, routing_overrides::{self, model::{Overrides, Target}}};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::HashSet, sync::atomic::{AtomicU64, Ordering}};

pub const SOURCE: &str = "procweaver-local";
pub const PREFIX: &str = "PW-L-";
pub const TYPES: &[&str] = &["vmess", "vless", "ss", "trojan", "hysteria2", "wireguard", "socks5", "http", "tuic", "anytls", "ssr", "hysteria", "snell", "ssh", "mieru", "shadowquic", "gost-relay", "sudoku", "masque", "trusttunnel", "openvpn", "tailscale", "zerotier", "easytier"];
const OVERLAYS: &[&str] = &["tailscale", "zerotier", "easytier"];
#[path = "local_node_options.rs"]
mod options;
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Node { pub id: String, pub name: String, pub config: Value }
impl Node {
    pub fn alias(&self) -> String { format!("{PREFIX}{}", self.id) }
    pub fn target(&self) -> Target { Target { profile_id: SOURCE.into(), kind: "node".into(), name: self.alias() } }
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Store { pub revision: u64, pub nodes: Vec<Node> }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary { pub id: String, pub name: String, pub alias: String, pub protocol: String, pub server: String, pub port: u64 }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View { pub revision: u64, pub nodes: Vec<Summary>, pub running: bool }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Draft { pub id: Option<String>, pub name: String, pub config: Value }
fn path() -> std::path::PathBuf { crate::storage::data_dir().join("config/local-nodes.json") }
pub fn read() -> Result<Store, String> {
    match std::fs::read(path()) {
        Ok(bytes) => {
            if bytes.len() > 4 * 1024 * 1024 { return Err("本地节点文件过大".into()); }
            let store: Store = serde_json::from_slice(&bytes).map_err(|_| "本地节点文件损坏，未覆盖原文件")?;
            check_store(&store)?; Ok(store)
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Store::default()),
        Err(_) => Err("读取本地节点失败".into()),
    }
}
fn view(store: &Store) -> View {
    View { revision: store.revision, running: process::ACTIVE.load(Ordering::SeqCst), nodes: store.nodes.iter().map(|n| Summary {
        id: n.id.clone(), name: n.name.clone(), alias: n.alias(), protocol: n.config["type"].as_str().unwrap_or_default().into(),
        server: n.config["server"].as_str().unwrap_or_default().into(), port: n.config["port"].as_u64().unwrap_or_default(),
    }).collect() }
}
#[tauri::command]
pub fn get_local_nodes() -> Result<View, String> { Ok(view(&read()?)) }
#[tauri::command]
pub fn get_local_node(id: String) -> Result<Node, String> { read()?.nodes.into_iter().find(|n| n.id == id).ok_or("本地节点已不存在".into()) }

fn check_store(store: &Store) -> Result<(), String> {
    if store.nodes.len() > 256 { return Err("本地节点最多 256 个".into()); }
    let mut ids = HashSet::new(); let mut names = HashSet::new();
    for node in &store.nodes {
        if node.id.is_empty() || node.id.len() > 40 || !node.id.bytes().all(|b| b.is_ascii_hexdigit()) || !ids.insert(&node.id) { return Err("本地节点身份无效或重复".into()); }
        if node.name.trim().is_empty() || node.name.len() > 160 || node.name.chars().any(char::is_control) || !names.insert(node.name.trim().to_lowercase()) { return Err("本地节点名称为空、过长或重复".into()); }
        validate_node(&node.config)?;
    }
    Ok(())
}
pub fn validate_node(config: &Value) -> Result<(), String> {
    let map = config.as_object().ok_or("节点配置必须为对象")?;
    let kind = config["type"].as_str().ok_or("请选择节点协议")?;
    if !TYPES.contains(&kind) { return Err("当前核心不支持此节点协议；不支持 NaiveProxy".into()); }
    // Explicit allowlist prevents silently discarded fields, arbitrary local paths,
    // chained subscription dependencies and outbound interface changes.
    let common = ["name", "type", "server", "port", "udp", "ip-version", "tfo", "mptcp", "tls", "servername", "sni", "skip-cert-verify", "alpn", "client-fingerprint", "fingerprint", "network", "ws-opts", "grpc-opts", "http-opts", "h2-opts", "reality-opts", "packet-encoding"];
    let fields = options::fields(kind);
    if let Some(key) = map.keys().find(|k| !common.contains(&k.as_str()) && !fields.contains(&k.as_str())) {
        return Err(format!("节点包含不支持的字段「{key}」，请核对后再导入"));
    }
    if ["wireguard", "ss"].contains(&kind) && ["tls", "sni", "servername", "alpn", "reality-opts", "client-fingerprint", "skip-cert-verify"].iter().any(|k| map.contains_key(*k)) {
        return Err("此协议不使用这些 TLS 字段，请核对节点配置".into());
    }
    if !["vmess", "vless", "trojan"].contains(&kind) && ["network", "ws-opts", "grpc-opts", "http-opts", "h2-opts", "reality-opts"].iter().any(|k| map.contains_key(*k) && !fields.contains(k)) {
        return Err("此协议不支持所填传输层选项".into());
    }
    if kind == "tuic" && map.contains_key("token") && (map.contains_key("uuid") || map.contains_key("password")) { return Err("TUIC v4 token 与 v5 UUID/密码不能同时填写".into()); }
    for (key, allowed) in [
        ("ws-opts", &["path", "headers", "max-early-data", "early-data-header-name", "v2ray-http-upgrade", "v2ray-http-upgrade-fast-open"][..]),
        ("grpc-opts", &["grpc-service-name"][..]), ("reality-opts", &["public-key", "short-id", "support-x25519mlkem768"][..]),
        ("http-opts", &["method", "path", "headers"][..]), ("h2-opts", &["host", "path"][..]),
        ("plugin-opts", &["mode", "host", "path", "tls", "skip-cert-verify", "mux", "headers"][..]),
    ] {
        if let Some(options) = config.get(key) {
            let options = options.as_object().ok_or_else(|| format!("{key} 必须为对象"))?;
            if options.keys().any(|k| !allowed.contains(&k.as_str())) { return Err(format!("{key} 包含未支持选项，请核对后再导入")); }
        }
    }
    validate_inline_material(config, kind, true)?;
    let server = config["server"].as_str().unwrap_or_default();
    let peers = kind == "wireguard" && config.get("peers").is_some();
    if !OVERLAYS.contains(&kind) && !peers {
        if server.is_empty() || server.len() > 253 || server.chars().any(|c| c.is_whitespace() || c.is_control() || matches!(c, '/' | '\\' | '#' | '@')) { return Err("服务器地址无效，请填写域名或 IP".into()); }
        if kind == "mieru" && config.get("port-range").is_some() {
            let range = config["port-range"].as_str().unwrap_or_default().split('-').filter_map(|n| n.parse::<u16>().ok()).collect::<Vec<_>>();
            if config.get("port").is_some() || range.len() != 2 || range[0] == 0 || range[0] > range[1] { return Err("Mieru 端口范围须为 起始端口-结束端口，不能与 port 同时填写".into()); }
        } else if !config["port"].as_u64().is_some_and(|n| n > 0 && n <= 65535) { return Err("端口须为 1–65535 的整数".into()); }
    } else if OVERLAYS.contains(&kind) && (map.contains_key("server") || map.contains_key("port")) { return Err("虚拟网络使用网络配置，不填写 server/port".into()); }
    if peers {
        let list = config["peers"].as_array().filter(|l| !l.is_empty() && l.len() <= 256).ok_or("WireGuard peers 须为非空对端列表")?;
        for peer in list {
            let p = peer.as_object().ok_or("WireGuard 对端须为对象")?;
            if p.keys().any(|k| !["server", "port", "public-key", "pre-shared-key", "reserved", "allowed-ips"].contains(&k.as_str())) { return Err("WireGuard 对端包含不支持字段".into()); }
            if peer["server"].as_str().is_none_or(str::is_empty) || !peer["port"].as_u64().is_some_and(|p| p > 0 && p <= 65535) || peer["public-key"].as_str().is_none_or(str::is_empty) { return Err("WireGuard 对端缺少地址、端口或公钥".into()); }
        }
    }
    let required: &[&str] = match kind { "vmess" | "vless" => &["uuid"], "ss" => &["cipher", "password"], "ssr" => &["cipher", "password", "protocol", "obfs"], "snell" => &["psk"], "sudoku" => &["key"], "ssh" => &["username"], "mieru" | "shadowquic" | "trusttunnel" => &["username", "password"], "masque" => &["private-key", "public-key"], "zerotier" => &["network"], "trojan" | "anytls" => &["password"], "hysteria2" if config["realm-opts"]["enable"] != true => &["password"], "wireguard" if peers => &["private-key"], "wireguard" => &["private-key", "public-key"], "tuic" if config.get("token").is_none() => &["uuid", "password"], "tuic" => &["token"], _ => &[] };
    for key in required { if config[key].as_str().is_none_or(|v| v.is_empty()) { return Err(format!("缺少必填字段：{key}")); } }
    if serde_json::to_vec(config).map_err(|_| "节点配置无效")?.len() > 131072 { return Err("单个节点配置过大".into()); }
    Ok(())
}

fn validate_inline_material(value: &Value, kind: &str, root: bool) -> Result<(), String> {
    if let Some(map) = value.as_object() {
        for (key, value) in map {
            let pem = ["certificate", "ca", "cert", "tls-auth", "tls-crypt", "tls-crypt-v2"].contains(&key.as_str())
                || key == "private-key" && !(root && ["wireguard", "masque"].contains(&kind))
                || root && kind == "openvpn" && key == "key";
            if pem && value.as_str().is_none_or(|v| !v.is_empty() && !v.trim_start().starts_with("-----BEGIN ")) { return Err(format!("{key} 请填写内联证书或密钥内容，不支持文件路径")); }
            validate_inline_material(value, kind, false)?;
        }
    } else if let Some(items) = value.as_array() { for item in items { validate_inline_material(item, kind, false)?; } }
    Ok(())
}

pub fn remap(target: &mut Target, active: &str) { if target.profile_id == SOURCE && target.kind == "node" { target.profile_id = active.into(); } }
pub fn map_config(config: &Overrides, active: &str) -> Overrides {
    let mut mapped = config.clone();
    for r in &mut mapped.process_rules { if let Some(t) = &mut r.target { remap(t, active); } }
    for r in &mut mapped.dns_rules { remap(&mut r.target, active); }
    for b in &mut mapped.bundles { for t in [&mut b.main_target, &mut b.dns_target].into_iter().flatten() { remap(t, active); } }
    mapped
}
pub fn compose(raw: &str, store: &Store) -> Result<String, String> {
    if store.nodes.is_empty() { return Ok(raw.into()); }
    let mut doc: serde_yaml::Value = serde_yaml::from_str(raw).map_err(|_| "订阅配置无效")?;
    let root = doc.as_mapping_mut().ok_or("订阅配置必须为对象")?;
    for key in ["proxies", "proxy-groups"] {
        if root.get(serde_yaml::Value::from(key)).and_then(|v| v.as_sequence()).into_iter().flatten().any(|p| p["name"].as_str().is_some_and(|s| s.starts_with(PREFIX))) {
            return Err("订阅使用了本地节点保留名称 PW-L-，请先修改订阅名称".into());
        }
    }
    let nodes = root.entry("proxies".into()).or_insert(serde_yaml::Value::Sequence(vec![])).as_sequence_mut().ok_or("proxies 必须为数组")?;
    for node in &store.nodes {
        let mut config = node.config.clone(); config["name"] = node.alias().into();
        if OVERLAYS.contains(&config["type"].as_str().unwrap_or_default()) { config["state-dir"] = format!("local-node-state/{}", node.alias()).into(); }
        nodes.push(serde_yaml::to_value(config).map_err(|_| "生成本地节点失败")?);
    }
    let groups = root.entry("proxy-groups".into()).or_insert(serde_yaml::Value::Sequence(vec![])).as_sequence_mut().ok_or("proxy-groups 必须为数组")?;
    let aliases: Vec<serde_yaml::Value> = store.nodes.iter().map(|n| n.alias().into()).collect();
    let index = groups.iter().position(|g| g["type"].as_str() == Some("select") && ["PROXY", "节点选择", "🚀 节点选择", "🔰 节点选择", "本地方案·节点选择"].contains(&g["name"].as_str().unwrap_or_default()))
        .or_else(|| groups.iter().position(|g| g["type"].as_str() == Some("select")));
    if let Some(index) = index {
        if let Some(items) = groups[index]["proxies"].as_sequence_mut() { for alias in aliases { if !items.contains(&alias) { items.push(alias); } } }
    } else { groups.push(serde_yaml::to_value(serde_json::json!({"name":"PROXY", "type":"select", "proxies":aliases})).unwrap()); }
    serde_yaml::to_string(&doc).map_err(|_| "生成本地节点配置失败".into())
}

fn references(node: &Node, config: &Overrides) -> Result<Vec<String>, String> {
    let target = node.target(); let alias = node.alias(); let mut found = Vec::new();
    for b in &config.bundles { if b.main_target.as_ref() == Some(&target) || b.dns_target.as_ref() == Some(&target) { found.push(format!("业务包：{}", b.name)); } }
    for r in &config.process_rules { if !r.id.starts_with("bundle-") && r.target.as_ref() == Some(&target) { found.push(format!("进程规则：{}", r.label)); } }
    for r in &config.dns_rules { if !r.id.starts_with("bundle-dns-") && r.target == target { found.push(format!("DNS 规则：{}", r.domain)); } }
    for group in profile::get_smart_groups()? { if group.to_string().contains(&alias) { found.push(format!("自建线路：{}", group["name"].as_str().unwrap_or("未命名"))); } }
    let mut sources = profile::read_profiles_index().into_iter().map(|p| (p.name, profile::get_base_dir().join(p.file_path))).collect::<Vec<_>>();
    sources.push(("默认配置".into(), profile::get_base_dir().join("config/default.yaml")));
    for (name, path) in sources { if path.exists() && std::fs::read_to_string(path).map_err(|_| "无法检查节点配置引用")?.contains(&alias) { found.push(format!("配置：{name}")); } }
    Ok(found)
}
#[tauri::command]
pub async fn save_local_nodes(expected_revision: u64, upserts: Vec<Draft>, deletes: Vec<String>) -> Result<View, String> {
    let _lock = process::LIFECYCLE.lock().await;
    let old = read()?;
    if expected_revision != old.revision { return Err("本地节点已被其他页面修改，请刷新后重试".into()); }
    if upserts.len() + deletes.len() > 256 { return Err("一次最多修改 256 个节点".into()); }
    let config = routing_overrides::read()?;
    let mut next = old.clone();
    for id in &deletes {
        let node = old.nodes.iter().find(|n| &n.id == id).ok_or("待删除节点已不存在")?;
        let used = references(node, &config)?;
        if !used.is_empty() { return Err(format!("节点仍被引用，请先换绑或移除引用：{}", used.join("；"))); }
    }
    next.nodes.retain(|n| !deletes.contains(&n.id));
    static SERIAL: AtomicU64 = AtomicU64::new(0);
    let mut touched = HashSet::new();
    for draft in upserts {
        let id = if let Some(id) = draft.id {
            if !next.nodes.iter().any(|n| n.id == id) || !touched.insert(id.clone()) { return Err("节点身份已失效或重复提交".into()); } id
        } else { format!("{:x}{:x}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos(), SERIAL.fetch_add(1, Ordering::Relaxed)) };
        let mut item = Node { id, name: draft.name.trim().into(), config: draft.config };
        if let Some(map) = item.config.as_object_mut() { map.remove("name"); }
        if let Some(existing) = next.nodes.iter_mut().find(|n| n.id == item.id) { *existing = item; } else { next.nodes.push(item); }
    }
    check_store(&next)?;
    next.revision = old.revision.checked_add(1).ok_or("本地节点修订号已耗尽")?;
    let bytes = serde_json::to_vec_pretty(&next).map_err(|_| "节点序列化失败")?;
    if bytes.len() > 4 * 1024 * 1024 { return Err("本地节点总配置不能超过 4 MB".into()); }
    let (source_id, source) = routing_overrides::current_source();
    let raw = std::fs::read_to_string(&source).map_err(|_| "无法读取当前分流配置，请先初始化默认配置")?;
    let candidate = next.clone(); let rules = config.clone();
    let prepared = tokio::task::spawn_blocking(move || {
        let prepared = routing_overrides::prepare_with_nodes(&raw, &rules, &source_id, &candidate)?;
        profile::validate_config(&prepared).map_err(|_| "核心校验未通过，请检查节点字段和高级选项；原配置保持不变".to_string())?;
        Ok::<_, String>(prepared)
    }).await.map_err(|_| "节点校验任务失败")??;
    let runtime = if process::ACTIVE.load(Ordering::SeqCst) { Some(std::fs::read_to_string(crate::storage::data_dir().join("core_data/config.yaml")).map_err(|_| "读取恢复配置失败")?) } else { None };
    routing_overrides::apply_runtime(&prepared).await?;
    if let Err(error) = crate::storage::replace_atomic(&path(), &bytes) {
        if let Some(raw) = runtime { routing_overrides::apply_runtime(&raw).await.map_err(|restore| format!("节点保存失败；恢复失败：{restore}"))?; }
        return Err(format!("节点保存失败，已恢复原配置：{error}"));
    }
    Ok(view(&next))
}

#[tauri::command]
pub fn preview_local_nodes(text: String) -> Result<Vec<DraftPreview>, String> {
    if text.len() > 1024 * 1024 { return Err("导入内容不能超过 1 MB".into()); }
    let value: Value = serde_yaml::from_str(&text).map_err(|_| "节点 YAML / JSON 无效；链接请切换到链接导入")?;
    let nodes = if let Some(list) = value.as_array() { list.clone() }
        else if let Some(list) = value.get("proxies").and_then(Value::as_array) {
            if value.as_object().is_some_and(|m| m.keys().any(|k| k != "proxies")) { return Err("仅导入节点，请只保留 proxies 列表，移除规则、DNS 和其他配置".into()); } list.clone()
        } else { vec![value] };
    if nodes.is_empty() || nodes.len() > 256 { return Err("请导入 1–256 个节点".into()); }
    nodes.into_iter().enumerate().map(|(i, mut config)| {
        validate_node(&config).map_err(|e| format!("第 {} 个节点：{e}", i + 1))?;
        let name = config.get("name").and_then(Value::as_str).map(String::from).unwrap_or_else(|| format!("本地节点 {}", i + 1));
        config.as_object_mut().unwrap().remove("name"); Ok(DraftPreview { name, config })
    }).collect()
}
#[derive(Serialize)]
pub struct DraftPreview { pub name: String, pub config: Value }
#[cfg(test)]
#[path = "local_nodes_tests.rs"]
mod tests;

//! Node inventory is configuration data, not a side effect of a running VPN.
use serde_json::{json, Value};
use std::{collections::BTreeMap, hash::{Hash, Hasher}, path::{Component, Path}};

pub(crate) struct Catalog {
    pub profile: String,
    pub nodes: BTreeMap<String, Value>,
    pub groups: Vec<Value>,
    pub warnings: Vec<String>,
}

fn insert_nodes(value: &Value, nodes: &mut BTreeMap<String, Value>) -> Result<(), String> {
    if let Some(items) = value.get("proxies").and_then(Value::as_array) {
        for item in items {
            let name = item.get("name").and_then(Value::as_str).filter(|s| !s.is_empty()).ok_or("订阅包含无名称节点")?;
            if nodes.insert(name.into(), item.clone()).is_some() { return Err(format!("订阅包含重复节点名称：{name}")); }
        }
    }
    Ok(())
}

fn parse(raw: &str, profile: String, home: &Path) -> Result<Catalog, String> {
    let value: Value = serde_yaml::from_str(raw).map_err(|_| "订阅配置格式无效")?;
    let mut result = Catalog { profile, nodes: BTreeMap::new(), groups: vec![], warnings: vec![] };
    insert_nodes(&value, &mut result.nodes)?;
    if let Some(providers) = value.get("proxy-providers").and_then(Value::as_object) {
        for (name, provider) in providers {
            let loaded = (|| -> Result<Value, String> {
                if let Some(payload) = provider.get("payload") { return Ok(json!({"proxies": payload})); }
                let path = provider.get("path").and_then(Value::as_str).ok_or("尚无本地缓存")?;
                if Path::new(path).components().any(|part| !matches!(part, Component::Normal(_) | Component::CurDir)) { return Err("缓存路径超出配置目录".into()); }
                let candidate = home.join(path).canonicalize().map_err(|_| "尚无本地缓存")?;
                let root = home.canonicalize().map_err(|_| "缓存目录不可用")?;
                if !candidate.starts_with(root) { return Err("缓存路径超出配置目录".into()); }
                let meta = std::fs::metadata(&candidate).map_err(|_| "缓存不可读")?;
                if meta.len() > 16 * 1024 * 1024 { return Err("缓存超过大小限制".into()); }
                serde_yaml::from_str(&std::fs::read_to_string(candidate).map_err(|_| "缓存不可读")?).map_err(|_| "缓存格式无效".into())
            })();
            match loaded {
                Ok(data) => insert_nodes(&data, &mut result.nodes)?,
                Err(reason) => result.warnings.push(format!("节点集合「{name}」{reason}，请更新订阅或连接 VPN 下载")),
            }
        }
    }
    result.groups = value.get("proxy-groups").and_then(Value::as_array).cloned().unwrap_or_default();
    Ok(result)
}

pub(crate) fn read() -> Result<Catalog, String> {
    let (profile, path) = crate::routing_overrides::current_source();
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && profile == "default" => "proxies: []".into(),
        Err(_) => return Err("无法读取当前订阅，请重新导入或恢复配置".into()),
    };
    let raw = crate::local_nodes::compose(&raw, &crate::local_nodes::read()?)?;
    parse(&raw, profile, &crate::storage::data_dir().join("core_data"))
}

/// Download provider inventories during an explicit subscription import/update,
/// never as a side effect of opening the node list. Content-addressed paths leave
/// the previously working subscription's cache untouched if validation fails.
#[cfg(target_os = "android")]
pub(crate) async fn hydrate(raw: &str, profile: &str) -> Result<String, String> {
    let mut value: Value = serde_yaml::from_str(raw).map_err(|_| "订阅配置格式无效")?;
    if let Some(providers) = value.get_mut("proxy-providers").and_then(Value::as_object_mut) {
        if providers.len() > 64 { return Err("单个订阅的节点集合超过 64 个".into()); }
        let client = reqwest::Client::builder().no_proxy().timeout(std::time::Duration::from_secs(20)).user_agent("ClashMeta").build().map_err(|_| "订阅下载初始化失败")?;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(90);
        let mut total_bytes = 0usize;
        for (name, provider) in providers {
            if provider["type"] != "http" { continue; }
            let url = provider["url"].as_str().ok_or("节点集合缺少下载地址")?;
            let parsed = reqwest::Url::parse(url).map_err(|_| "节点集合下载地址无效")?;
            if !matches!(parsed.scheme(), "https" | "http") { return Err("节点集合仅支持 HTTP/HTTPS 地址".into()); }
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() { return Err("节点集合下载超时，请检查网络后重试".into()); }
            let mut request = client.get(parsed).timeout(remaining.min(std::time::Duration::from_secs(20)));
            if let Some(headers) = provider.get("header").and_then(Value::as_object) {
                for (key, values) in headers {
                    let header = reqwest::header::HeaderName::from_bytes(key.as_bytes()).map_err(|_| "节点集合请求头名称无效")?;
                    let values = values.as_array().cloned().unwrap_or_else(|| vec![values.clone()]);
                    for value in values {
                        let value = value.as_str().ok_or("节点集合请求头须为文本")?;
                        let value = reqwest::header::HeaderValue::from_str(value).map_err(|_| "节点集合请求头值无效")?;
                        request = request.header(header.clone(), value);
                    }
                }
            }
            let mut response = request.send().await.map_err(|_| format!("下载节点集合「{name}」失败，请检查网络后重试"))?;
            if !response.status().is_success() { return Err(format!("节点集合「{name}」返回 HTTP {}", response.status().as_u16())); }
            let mut body = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|_| "节点集合下载中断")? {
                if body.len() + chunk.len() > 8 * 1024 * 1024 { return Err("节点集合超过 8 MB".into()); }
                total_bytes += chunk.len();
                if total_bytes > 32 * 1024 * 1024 { return Err("本次节点集合下载总量超过 32 MB".into()); }
                body.extend_from_slice(&chunk);
            }
            let data: Value = serde_yaml::from_slice(&body).map_err(|_| format!("节点集合「{name}」不是有效 YAML"))?;
            if !data["proxies"].is_array() { return Err(format!("节点集合「{name}」缺少 proxies 列表")); }
            let mut identity = std::collections::hash_map::DefaultHasher::new();
            profile.hash(&mut identity); name.hash(&mut identity); body.hash(&mut identity);
            let path = format!("providers/procweaver/{:016x}.yaml", identity.finish());
            crate::storage::replace_atomic(&crate::storage::data_dir().join("core_data").join(&path), &body)?;
            provider["path"] = path.into();
        }
    }
    serde_yaml::to_string(&value).map_err(|_| "生成订阅节点目录失败".into())
}

#[cfg(target_os = "android")]
pub(crate) fn count(raw: &str) -> Result<usize, String> {
    Ok(parse(raw, String::new(), &crate::storage::data_dir().join("core_data"))?.nodes.len())
}

impl Catalog {
    pub fn public(&self) -> Value {
        let mut proxies = serde_json::Map::new();
        for (name, node) in &self.nodes {
            let mut identity = std::collections::hash_map::DefaultHasher::new();
            self.profile.hash(&mut identity);
            node.to_string().hash(&mut identity);
            proxies.insert(name.clone(), json!({"name": name, "type": node["type"], "udp":node["udp"],
                "catalogKey":format!("{:016x}", identity.finish()), "history":[]}));
        }
        for group in &self.groups {
            if let Some(name) = group["name"].as_str() {
                let members = group.get("proxies").cloned().unwrap_or(json!([]));
                proxies.insert(name.into(), json!({"name":name, "type": match group["type"].as_str().unwrap_or("select") {
                    "url-test" => "URLTest", "fallback" => "Fallback", "load-balance" => "LoadBalance", "relay" => "Relay", _ => "Selector"
                }, "all": members, "now":"", "history":[]}));
            }
        }
        json!({"proxies":proxies,"catalogProfile":self.profile,"catalogWarnings":self.warnings,"offline":true})
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn offline_catalog_redacts_credentials_and_scopes_observations() {
        let raw = "proxies: [{name: node, type: socks5, server: example.test, port: 1080, password: secret}]";
        let a = parse(raw, "one".into(), Path::new(".")).unwrap().public();
        let b = parse(raw, "two".into(), Path::new(".")).unwrap().public();
        assert!(!a.to_string().contains("secret"));
        assert!(!a.to_string().contains("example.test"));
        assert_ne!(a["proxies"]["node"]["catalogKey"], b["proxies"]["node"]["catalogKey"]);
        let changed = parse(&raw.replace("1080", "1081"), "one".into(), Path::new(".")).unwrap().public();
        assert_ne!(a["proxies"]["node"]["catalogKey"], changed["proxies"]["node"]["catalogKey"]);
    }
    #[test]
    fn unavailable_providers_are_explicit_and_inline_payload_works() {
        let data = parse("proxy-providers:\n  inline:\n    payload: [{name: a, type: socks5}]\n  missing:\n    path: ../private.yaml\n", "one".into(), Path::new(".")).unwrap();
        assert_eq!(data.nodes.len(), 1);
        assert_eq!(data.warnings.len(), 1);
        assert!(data.warnings[0].contains("超出"));
        assert!(parse("proxies: [{name: a}, {name: a}]", "one".into(), Path::new(".")).is_err());
    }
}

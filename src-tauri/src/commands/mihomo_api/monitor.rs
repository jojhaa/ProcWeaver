use serde_json::Value;
use std::{collections::HashMap, sync::OnceLock, time::{Duration, Instant, SystemTime}};
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Clone, PartialEq, Eq)]
struct Source {
    base: String,
    epoch: Option<u32>,
    config: Option<(SystemTime, u64)>,
    revision: u64,
}
#[derive(Default)]
struct TypesCache {
    source: Option<Source>,
    loaded: Option<Instant>,
    types: HashMap<String, String>,
}
static TYPES: OnceLock<tokio::sync::Mutex<TypesCache>> = OnceLock::new();
static CLIENT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();
static REVISION: AtomicU64 = AtomicU64::new(0);
pub(super) fn invalidate() { REVISION.fetch_add(1, Ordering::SeqCst); }

fn source(state: &super::super::process::CoreStateMutex) -> Result<Source, String> {
    let epoch = state.lock().map_err(|_| "读取核心状态失败")?.child.as_ref().map(|child| child.id());
    let config = std::fs::metadata(crate::storage::data_dir().join("core_data/config.yaml"))
        .ok().and_then(|m| Some((m.modified().ok()?, m.len())));
    Ok(Source { base: super::base_url()?, epoch, config, revision: REVISION.load(Ordering::SeqCst) })
}
async fn read(client: &reqwest::Client, url: String) -> Result<Value, String> {
    client.get(url).send().await.map_err(|_| "读取监控数据失败")?
        .error_for_status().map_err(|_| "核心拒绝监控请求")?
        .json().await.map_err(|_| "监控响应无效".into())
}
fn needs_refresh(cache: &TypesCache, current: &Source, connections: &Value) -> bool {
    cache.source.as_ref() != Some(current)
        || cache.loaded.is_none_or(|time| time.elapsed() >= Duration::from_secs(30))
        || connections["connections"].as_array().into_iter().flatten().any(|c| {
            c["chains"][0].as_str().is_some_and(|leaf| !cache.types.contains_key(leaf))
        })
}
pub(super) async fn snapshot(state: &super::super::process::CoreStateMutex, include_connections: bool) -> Result<Value, String> {
    // 跨调用串行；复用 HTTP 连接池，缓存仅保存出站名称和类型。
    let mut cache = TYPES.get_or_init(Default::default).lock().await;
    let current = source(state)?;
    let client = CLIENT.get_or_init(|| super::controller_client().timeout(Duration::from_secs(3)).build()
        .map_err(|_| "统计客户端初始化失败".to_string())).as_ref().map_err(Clone::clone)?;
    let result = collect(client, &current, &mut cache, include_connections).await?;
    if source(state)? != current { return Err("核心配置已变化，等待下一次采样".into()); }
    Ok(result)
}
async fn collect(client: &reqwest::Client, current: &Source, cache: &mut TypesCache, include_connections: bool) -> Result<Value, String> {
    let connections = read(client, format!("{}/connections", current.base)).await?;
    if needs_refresh(cache, current, &connections) {
        let proxies = read(client, format!("{}/proxies", current.base)).await?;
        cache.types = proxies["proxies"].as_object().ok_or("出站类型响应无效")?.iter()
            .filter_map(|(name, proxy)| Some((name.clone(), proxy["type"].as_str()?.to_ascii_lowercase())))
            .collect();
        cache.source = Some(current.clone());
        cache.loaded = Some(Instant::now());
    }
    let entries: Vec<_> = connections["connections"].as_array().into_iter().flatten().map(|c| {
        let leaf = c["chains"][0].as_str().unwrap_or("");
        let kind = cache.types.get(leaf).map(String::as_str).unwrap_or("");
        serde_json::json!({"id": c["id"], "upload": c["upload"], "download": c["download"],
            "proxied": super::is_proxy_connection(leaf, kind)})
    }).collect();
    let mut result = serde_json::json!({"epoch": current.epoch, "uploadTotal": connections["uploadTotal"],
        "downloadTotal": connections["downloadTotal"], "connections": entries});
    if include_connections { result["details"] = connections; }
    Ok(result)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn types_refresh_on_restart_config_change_expiry_or_unknown_leaf() {
        let source = Source { base: "local".into(), epoch: Some(1), config: None, revision: 0 };
        let mut cache = TypesCache { source: Some(source.clone()), loaded: Some(Instant::now()),
            types: HashMap::from([("node".into(), "direct".into())]) };
        let connections = serde_json::json!({"connections":[{"chains":["node"]}]});
        assert!(!needs_refresh(&cache, &source, &connections));
        let mut reloaded = source.clone(); reloaded.revision += 1;
        assert!(needs_refresh(&cache, &reloaded, &connections));
        let mut changed = source.clone(); changed.epoch = Some(2);
        assert!(needs_refresh(&cache, &changed, &connections));
        changed = source.clone(); changed.config = Some((SystemTime::now(), 10));
        assert!(needs_refresh(&cache, &changed, &connections));
        assert!(needs_refresh(&cache, &source, &serde_json::json!({"connections":[{"chains":["new"]}]})));
        cache.loaded = Some(Instant::now() - Duration::from_secs(31));
        assert!(needs_refresh(&cache, &source, &connections));
    }

    #[tokio::test]
    async fn shared_sample_reuses_types_and_only_includes_requested_details() {
        use tokio::{io::{AsyncReadExt, AsyncWriteExt}, net::TcpListener};
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let mut paths = Vec::new();
            for _ in 0..3 {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut buf = [0; 2048];
                let size = stream.read(&mut buf).await.unwrap();
                let request = String::from_utf8_lossy(&buf[..size]);
                let path = request.split_whitespace().nth(1).unwrap().to_string();
                let body = if path == "/proxies" {
                    serde_json::json!({"proxies":{"node":{"type":"Shadowsocks"},"local":{"type":"Direct"}}})
                } else {
                    serde_json::json!({"uploadTotal":10,"downloadTotal":20,"connections":[
                        {"id":"a","upload":3,"download":4,"chains":["node"]},
                        {"id":"b","upload":7,"download":16,"chains":["local"]}]})
                }.to_string();
                paths.push(path);
                let response = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body);
                stream.write_all(response.as_bytes()).await.unwrap();
            }
            paths
        });
        let client = super::super::controller_client().timeout(Duration::from_secs(2)).build().unwrap();
        let source = Source { base: format!("http://{address}"), epoch: Some(1), config: None, revision: 0 };
        let mut cache = TypesCache::default();
        let first = collect(&client, &source, &mut cache, false).await.unwrap();
        assert!(first.get("details").is_none());
        assert_eq!(first["connections"][0]["proxied"], true);
        assert_eq!(first["connections"][1]["proxied"], false);
        let second = collect(&client, &source, &mut cache, true).await.unwrap();
        assert_eq!(second["details"]["connections"].as_array().unwrap().len(), 2);
        assert_eq!(server.await.unwrap(), vec!["/connections", "/proxies", "/connections"]);
    }
}

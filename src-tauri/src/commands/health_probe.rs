use std::{collections::HashMap, fs, net::TcpListener, path::PathBuf, process::Child, sync::{Arc, Mutex, LazyLock}, time::{Duration, SystemTime, UNIX_EPOCH}};
use serde_yaml::Value;
use super::ip_health::{check_ip_health, IpHealthInfo};

struct Session {
    _slot: tokio::sync::OwnedSemaphorePermit,
    child: Mutex<Option<Child>>,
    directory: PathBuf,
    ports: HashMap<String, u16>,
}
impl Session {
    fn stop(&self) {
        if let Ok(mut child) = self.child.lock() {
            if let Some(mut process) = child.take() { let _ = process.kill(); let _ = process.wait(); }
        }
        let _ = fs::remove_dir_all(&self.directory);
    }
}
impl Drop for Session { fn drop(&mut self) { self.stop(); } }
static SESSIONS: LazyLock<Mutex<HashMap<String, Arc<Session>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static START: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static LIMIT: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(64);
static SESSION_SLOTS: LazyLock<Arc<tokio::sync::Semaphore>> = LazyLock::new(|| Arc::new(tokio::sync::Semaphore::new(2)));

pub fn shutdown() {
    if let Ok(mut sessions) = SESSIONS.lock() {
        for session in sessions.values() { session.stop(); }
        sessions.clear();
    }
}

fn build_config(raw: &str, ports: &HashMap<String, u16>) -> Result<String, String> {
    let original: Value = serde_yaml::from_str(raw).map_err(|_| "无法读取当前内核配置")?;
    let mut map = serde_yaml::Mapping::new();
    // 仅复用出站与解析能力，排除主内核监听、控制器、TUN、规则和全局模式。
    // 注意：绝不继承原配置中复杂的 dns（包含 fake-ip-filter / nameserver-policy 等 rule-set 外部依赖），
    // 避免跨机环境因缺少 rule-providers 导致 fatal parse error。
    for key in ["proxies", "proxy-providers", "proxy-groups", "hosts", "geodata-mode", "geox-url", "global-client-fingerprint"] {
        if let Some(value) = original.get(key) { map.insert(key.into(), value.clone()); }
    }
    if let Some(providers) = map.get_mut(Value::from("proxy-providers")).and_then(Value::as_mapping_mut) {
        for provider in providers.values_mut() {
            if let Some(provider) = provider.as_mapping_mut() {
                if let Some(path) = provider.get(Value::from("path")).and_then(Value::as_str) {
                    if std::path::Path::new(path).components().any(|part| !matches!(part, std::path::Component::Normal(_) | std::path::Component::CurDir)) {
                        return Err("节点集合路径超出隔离目录，暂不支持该订阅的并发健康检测".into());
                    }
                }
                provider.insert("health-check".into(), serde_yaml::to_value(serde_json::json!({"enable":false})).unwrap());
            }
        }
    }
    if let Some(groups) = map.get_mut(Value::from("proxy-groups")).and_then(Value::as_sequence_mut) {
        for group in groups {
            if let Some(group) = group.as_mapping_mut() { group.insert("type".into(), "select".into()); }
        }
    }

    // 专属轻量纯净 DNS：仅用于解析节点服务器自身域名，彻底杜绝任何外部 rule-set 或复杂路由依赖
    let mut probe_dns = serde_yaml::Mapping::new();
    probe_dns.insert("enable".into(), true.into());
    probe_dns.insert("ipv6".into(), false.into());
    probe_dns.insert("enhanced-mode".into(), "redir-host".into());
    probe_dns.insert("respect-rules".into(), false.into());
    probe_dns.insert("nameserver".into(), serde_yaml::to_value(vec![
        "223.5.5.5",
        "119.29.29.29",
        "1.1.1.1",
        "8.8.8.8",
    ]).unwrap());
    map.insert("dns".into(), Value::Mapping(probe_dns));
    map.insert("mode".into(), "rule".into());
    map.insert("allow-lan".into(), false.into());
    map.insert("log-level".into(), "silent".into());
    map.insert("rules".into(), serde_yaml::to_value(vec!["MATCH,REJECT"]).unwrap());
    let listeners: Vec<_> = ports.iter().enumerate().map(|(i, (node, port))| serde_json::json!({
        "name": format!("probe-{i}"), "type": "http", "listen": "127.0.0.1", "port": port, "proxy": node
    })).collect();
    map.insert("listeners".into(), serde_yaml::to_value(listeners).map_err(|e| e.to_string())?);
    serde_yaml::to_string(&map).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn begin_health_probe(names: Vec<String>) -> Result<String, String> {
    let slot = SESSION_SLOTS.clone().acquire_owned().await.map_err(|e| e.to_string())?;
    let _start = START.lock().await;
    if names.is_empty() || names.len() > 1024 { return Err("每批检测须为 1–1024 个节点".into()); }
    let mut ports = HashMap::new();
    let mut reserved = Vec::new();
    for name in names {
        if ports.contains_key(&name) { continue; }
        let listener = TcpListener::bind("127.0.0.1:0").map_err(|_| "无法分配检测端口")?;
        ports.insert(name, listener.local_addr().map_err(|e| e.to_string())?.port());
        reserved.push(listener);
    }
    let id = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos().to_string();
    let directory = std::env::temp_dir().join(format!("netbox-health-{id}"));
    fs::create_dir_all(&directory).map_err(|_| "无法创建检测目录")?;
    let session = Arc::new(Session { _slot: slot, child: Mutex::new(None), directory, ports });
    let data = crate::storage::data_dir().join("core_data");
    let _ = super::profile::copy_validation_assets(&data, &session.directory);
    // 双保险：若 core_data 缺失某些资源，尝试从内置 defaults 补充
    let defaults_core = crate::storage::resource_dir().join("defaults/core_data");
    if defaults_core.exists() {
        let _ = super::profile::copy_validation_assets(&defaults_core, &session.directory);
    }
    let raw = fs::read_to_string(data.join("config.yaml")).map_err(|_| "请先启动核心加载订阅")?;
    let config = build_config(&raw, &session.ports)?;
    let config_path = session.directory.join("config.yaml");
    fs::write(&config_path, config).map_err(|_| "无法生成隔离检测配置")?;

    let core_exe = super::profile::validation_core()?;
    let mut command = std::process::Command::new(core_exe);
    command.arg("-d").arg(&session.directory).arg("-f").arg(&config_path);

    let log_path = session.directory.join("probe_kernel.log");
    if let Ok(file) = fs::File::create(&log_path) {
        if let Ok(err_file) = file.try_clone() {
            command.stdout(std::process::Stdio::from(file));
            command.stderr(std::process::Stdio::from(err_file));
        } else {
            command.stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
        }
    } else {
        command.stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    }

    #[cfg(windows)] { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
    drop(reserved);
    // 释放端口后微量等待 60ms，防止 Windows TCP 栈 TIME_WAIT 导致的 WSAEADDRINUSE 端口争抢
    tokio::time::sleep(Duration::from_millis(60)).await;

    *session.child.lock().map_err(|e| e.to_string())? = Some(command.spawn().map_err(|e| format!("无法启动隔离检测内核: {e}"))?);
    let started = std::time::Instant::now();
    loop {
        if session.child.lock().map_err(|e| e.to_string())?.as_mut().unwrap().try_wait().map_err(|e| e.to_string())?.is_some() {
            let detail = fs::read_to_string(&log_path).unwrap_or_default();
            let err_summary = detail
                .lines()
                .filter(|l| l.contains("level=error") || l.contains("level=fatal") || l.contains("FATAL") || l.contains("bind:"))
                .take(3)
                .collect::<Vec<_>>()
                .join(" | ");
            let err_msg = if !err_summary.is_empty() {
                format!("隔离检测内核启动失败: {}", err_summary)
            } else if !detail.trim().is_empty() {
                let tail = detail.lines().rev().take(3).collect::<Vec<_>>();
                format!("隔离检测内核启动退出: {}", tail.join(" | "))
            } else {
                "隔离检测内核启动失败，请检查节点及订阅资源".into()
            };
            return Err(err_msg);
        }
        let mut ready = true;
        for port in session.ports.values() {
            if tokio::net::TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, *port)).await.is_err() { ready = false; break; }
        }
        if ready { break; }
        if started.elapsed() > Duration::from_secs(15) { return Err("隔离检测内核启动超时".into()); }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    SESSIONS.lock().map_err(|e| e.to_string())?.insert(id.clone(), session);
    Ok(id)
}

#[tauri::command]
pub async fn probe_node_health(session: String, node: String) -> Result<IpHealthInfo, String> {
    let _permit = LIMIT.acquire().await.map_err(|e| e.to_string())?;
    let session = SESSIONS.lock().map_err(|e| e.to_string())?.get(&session).cloned().ok_or("检测批次已结束")?;
    let port = session.ports.get(&node).copied().ok_or("节点不在检测批次中")?;
    check_ip_health(Some(port)).await
}

#[tauri::command]
pub fn end_health_probe(session: String) -> Result<(), String> {
    SESSIONS.lock().map_err(|e| e.to_string())?.remove(&session);
    Ok(())
}

#[tauri::command]
pub fn get_health_cache() -> Result<serde_json::Value, String> {
    let path = crate::storage::data_dir().join("config/health_cache.json");
    if !path.exists() {
        return Ok(serde_json::json!({}));
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("读取健康缓存文件失败: {e}"))?;
    serde_json::from_slice(&bytes).map_err(|e| format!("解析健康缓存文件失败: {e}"))
}

#[tauri::command]
pub fn save_health_cache(cache: serde_json::Value) -> Result<(), String> {
    let path = crate::storage::data_dir().join("config/health_cache.json");
    let bytes = serde_json::to_vec_pretty(&cache).map_err(|e| format!("序列化健康缓存失败: {e}"))?;
    crate::storage::replace_atomic(&path, &bytes).map_err(|e| format!("持久化健康缓存失败: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn provider_paths_cannot_escape_the_probe_directory() {
        let ports = HashMap::from([("node".into(), 18001)]);
        assert!(build_config("proxy-providers:\n  remote:\n    path: ../outside.yaml\n", &ports).is_err());
        let value: Value = serde_yaml::from_str(&build_config("proxy-providers:\n  remote:\n    path: ./providers/nodes.yaml\n    health-check: {enable: true}\n", &ports).unwrap()).unwrap();
        assert_eq!(value["proxy-providers"]["remote"]["health-check"]["enable"].as_bool(), Some(false));
    }
    #[test]
    fn isolated_config_removes_system_inbounds_and_pins_every_node() {
        let raw = "mixed-port: 7890\nexternal-controller: 127.0.0.1:9090\ntun: {enable: true}\nmode: global\nproxies: []\ndns: {enable: true, respect-rules: true, listen: '0.0.0.0:53', nameserver-policy: {'rule-set:cndns': '223.5.5.5'}, fake-ip-filter: ['rule-set:fakeip-filter_domain']}\n";
        let ports = HashMap::from([("节点甲".into(), 18001), ("节点乙".into(), 18002)]);
        let value: Value = serde_yaml::from_str(&build_config(raw, &ports).unwrap()).unwrap();
        assert!(value.get("tun").is_none());
        assert!(value.get("external-controller").is_none());
        assert!(value.get("mixed-port").is_none());
        assert_eq!(value["mode"].as_str(), Some("rule"));
        assert_eq!(value["dns"]["respect-rules"].as_bool(), Some(false));
        assert!(value["dns"].get("listen").is_none());
        assert!(value["dns"].get("nameserver-policy").is_none());
        assert!(value["dns"].get("fake-ip-filter").is_none());
        assert_eq!(value["dns"]["enhanced-mode"].as_str(), Some("redir-host"));
        assert!(value["dns"]["nameserver"].as_sequence().is_some());
        for listener in value["listeners"].as_sequence().unwrap() {
            assert_eq!(listener["listen"].as_str(), Some("127.0.0.1"));
            let node = listener["proxy"].as_str().unwrap();
            assert_eq!(listener["port"].as_u64(), Some(ports[node] as u64));
        }
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn native_parallel_requests_do_not_cross_node_routes() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use std::os::windows::process::CommandExt;
        async fn mock(marker: &'static str) -> (u16, tokio::task::JoinHandle<()>) {
            let server = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = server.local_addr().unwrap().port();
            let task = tokio::spawn(async move {
                let mut handlers = Vec::new();
                for _ in 0..16 {
                    let (mut stream, _) = server.accept().await.unwrap();
                    handlers.push(tokio::spawn(async move {
                        let mut bytes = [0; 8192];
                        let count = stream.read(&mut bytes).await.unwrap();
                        if bytes[..count].starts_with(b"CONNECT ") {
                            stream.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n").await.unwrap();
                            let _ = stream.read(&mut bytes).await.unwrap();
                        }
                        let response = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", marker.len(), marker);
                        stream.write_all(response.as_bytes()).await.unwrap();
                    }));
                }
                for h in handlers {
                    let _ = h.await;
                }
            });
            (port, task)
        }
        let (a, task_a) = mock("node-a").await;
        let (b, task_b) = mock("node-b").await;
        let reservations: Vec<_> = (0..2).map(|_| TcpListener::bind("127.0.0.1:0").unwrap()).collect();
        let ports = HashMap::from([("a".into(), reservations[0].local_addr().unwrap().port()), ("b".into(), reservations[1].local_addr().unwrap().port())]);
        let raw = serde_yaml::to_string(&serde_json::json!({"proxies": [
            {"name":"a", "type":"http", "server":"127.0.0.1", "port":a},
            {"name":"b", "type":"http", "server":"127.0.0.1", "port":b}
        ]})).unwrap();
        let directory = std::env::temp_dir().join(format!("netbox-route-test-{}", std::process::id()));
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("config.yaml"), build_config(&raw, &ports).unwrap()).unwrap();
        let guard = Session { _slot: Arc::new(tokio::sync::Semaphore::new(1)).acquire_owned().await.unwrap(), directory, ports, child: Mutex::new(None) };
        drop(reservations);
        let child = std::process::Command::new(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries/mihomo-compatible.exe"))
            .arg("-d").arg(&guard.directory).arg("-f").arg(guard.directory.join("config.yaml"))
            .creation_flags(0x08000000).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn().unwrap();
        *guard.child.lock().unwrap() = Some(child);
        for _ in 0..50 {
            if tokio::net::TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, guard.ports["a"])).await.is_ok() { break; }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let mut jobs = tokio::task::JoinSet::new();
        for index in 0..32 {
            let node = if index % 2 == 0 { "a" } else { "b" };
            let port = guard.ports[node];
            jobs.spawn(async move {
                let client = reqwest::Client::builder().timeout(Duration::from_secs(8))
                    .proxy(reqwest::Proxy::http(format!("http://127.0.0.1:{port}")).unwrap()).build().unwrap();
                let response = client.get("http://probe.invalid/").send().await.unwrap();
                assert_eq!(response.status(), reqwest::StatusCode::OK);
                let body = response.text().await.unwrap();
                assert_eq!(body, format!("node-{node}"));
            });
        }
        while let Some(result) = jobs.join_next().await { result.unwrap(); }
        task_a.await.unwrap(); task_b.await.unwrap();
    }
}

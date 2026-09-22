use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::time::SystemTime;
use std::sync::atomic::{AtomicU64, Ordering};

static UPDATE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static CONFIG: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static CHANGED: tokio::sync::Notify = tokio::sync::Notify::const_new();
static REVISION: AtomicU64 = AtomicU64::new(0);
const MAX_BYTES: usize = 128 * 1024 * 1024;

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GeoResource {
    pub id: String,
    pub name: String,
    pub file_name: String,
    pub url: String,
    pub file_size_bytes: u64,
    pub file_size_formatted: String,
    pub updated_at_relative: String,
    pub updated_at: Option<String>,
    pub exists: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GeoConfig {
    pub auto_update: bool,
    pub update_interval_hours: u32,
    pub last_checked_at: Option<String>,
    #[serde(default)]
    pub last_error: Option<String>,
    pub resources: Vec<GeoResource>,
}

fn get_default_resources() -> Vec<GeoResource> {
    vec![
        GeoResource {
            id: "mmdb".to_string(),
            name: "MMDB".to_string(),
            file_name: "geoip.metadb".to_string(),
            url: "https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geoip.metadb".to_string(),
            file_size_bytes: 0,
            file_size_formatted: "0 MB".to_string(),
            updated_at_relative: "未下载".to_string(),
            updated_at: None,
            exists: false,
        },
        GeoResource {
            id: "asn".to_string(),
            name: "ASN".to_string(),
            file_name: "GeoLite2-ASN.mmdb".to_string(),
            url: "https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/GeoLite2-ASN.mmdb".to_string(),
            file_size_bytes: 0,
            file_size_formatted: "0 MB".to_string(),
            updated_at_relative: "未下载".to_string(),
            updated_at: None,
            exists: false,
        },
        GeoResource {
            id: "geoip".to_string(),
            name: "GEOIP".to_string(),
            file_name: "geoip.dat".to_string(),
            url: "https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geoip.dat".to_string(),
            file_size_bytes: 0,
            file_size_formatted: "0 MB".to_string(),
            updated_at_relative: "未下载".to_string(),
            updated_at: None,
            exists: false,
        },
        GeoResource {
            id: "geosite".to_string(),
            name: "GEOSITE".to_string(),
            file_name: "geosite.dat".to_string(),
            url: "https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geosite.dat".to_string(),
            file_size_bytes: 0,
            file_size_formatted: "0 MB".to_string(),
            updated_at_relative: "未下载".to_string(),
            updated_at: None,
            exists: false,
        },
    ]
}

fn format_bytes(bytes: u64) -> String {
    if bytes >= 1024 * 1024 {
        format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
    } else if bytes >= 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    } else if bytes > 0 {
        format!("{} B", bytes)
    } else {
        "0 MB".to_string()
    }
}

fn format_relative_time(modified: SystemTime) -> (String, String) {
    let now = SystemTime::now();
    let duration = match now.duration_since(modified) {
        Ok(d) => d,
        Err(_) => return ("刚刚".to_string(), "刚刚".to_string()),
    };

    let secs = duration.as_secs();
    let relative = if secs < 60 {
        "刚刚".to_string()
    } else if secs < 3600 {
        format!("{} 分钟前", secs / 60)
    } else if secs < 86400 {
        format!("{} 小时前", secs / 3600)
    } else {
        format!("{} 天前", secs / 86400)
    };

    // 格式化大概时间
    (relative.clone(), relative)
}

fn get_geo_config_path() -> PathBuf {
    crate::commands::profile::get_base_dir().join("config").join("geo_config.json")
}

fn get_core_data_dir() -> PathBuf {
    crate::commands::profile::get_base_dir().join("core_data")
}

fn enrich_resource_with_file(res: &mut GeoResource) {
    let data_dir = get_core_data_dir();
    let target_file = data_dir.join(&res.file_name);
    if target_file.exists() {
        if let Ok(meta) = fs::metadata(&target_file) {
            res.exists = true;
            res.file_size_bytes = meta.len();
            res.file_size_formatted = format_bytes(meta.len());
            if let Ok(mod_time) = meta.modified() {
                let (rel, abs) = format_relative_time(mod_time);
                res.updated_at_relative = rel;
                res.updated_at = Some(abs);
            }
        }
    } else {
        res.exists = false;
        res.file_size_bytes = 0;
        res.file_size_formatted = "未下载".to_string();
        res.updated_at_relative = "未下载".to_string();
        res.updated_at = None;
    }
}

#[tauri::command]
pub async fn get_geo_config() -> Result<GeoConfig, String> {
    read_config()
}

fn read_config() -> Result<GeoConfig, String> {
    let config_path = get_geo_config_path();
    let mut config: GeoConfig = if config_path.exists() {
        serde_json::from_slice(&fs::read(&config_path).map_err(|_| "读取 Geo 配置失败")?)
            .map_err(|_| "Geo 配置损坏，请恢复备份")?
    } else {
        GeoConfig {
            auto_update: true,
            update_interval_hours: 24,
            last_checked_at: None,
            last_error: None,
            resources: get_default_resources(),
        }
    };
    validate_settings(&config)?;

    // 补充可能缺失的默认项
    let defaults = get_default_resources();
    for def in defaults {
        if !config.resources.iter().any(|r| r.id == def.id) {
            config.resources.push(def);
        }
    }

    // 丰富本地文件信息
    for res in &mut config.resources {
        enrich_resource_with_file(res);
    }

    Ok(config)
}

#[tauri::command]
pub async fn save_geo_config(mut config: GeoConfig) -> Result<bool, String> {
    let _config = CONFIG.lock().await;
    validate_settings(&config)?;
    let current = read_config()?;
    config.last_checked_at = current.last_checked_at;
    config.last_error = current.last_error;
    write_config(&config)?;
    REVISION.fetch_add(1, Ordering::SeqCst);
    CHANGED.notify_one();
    Ok(true)
}

fn validate_settings(config: &GeoConfig) -> Result<(), String> {
    if !(1..=8760).contains(&config.update_interval_hours) { return Err("Geo 更新间隔须为 1–8760 小时".into()); }
    let defaults = get_default_resources();
    let mut ids = std::collections::HashSet::new();
    for res in &config.resources {
        let expected = defaults.iter().find(|r| r.id == res.id).ok_or("未知 Geo 资源")?;
        if res.file_name != expected.file_name || !ids.insert(&res.id) { return Err("Geo 文件名或资源标识无效".into()); }
        validate_url(&res.url)?;
    }
    Ok(())
}
fn validate_url(value: &str) -> Result<(), String> {
    let url = reqwest::Url::parse(value).map_err(|_| "Geo 下载地址无效")?;
    if value.len() > 4096 || !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() { return Err("Geo 下载地址必须使用 HTTP 或 HTTPS".into()); }
    Ok(())
}
fn write_config(config: &GeoConfig) -> Result<(), String> {
    crate::storage::replace_atomic(&get_geo_config_path(), &serde_json::to_vec_pretty(config).map_err(|_| "生成 Geo 配置失败")?)
}
fn now_seconds() -> u64 { SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs() }
fn due(config: &GeoConfig, now: u64) -> bool {
    config.auto_update && config.last_checked_at.as_deref().and_then(|v| v.parse::<u64>().ok())
        .map_or(true, |last| now >= last.saturating_add(u64::from(config.update_interval_hours) * 3600))
}
fn check_revision(revision: Option<u64>) -> Result<(), String> {
    if revision.is_some_and(|r| r != REVISION.load(Ordering::SeqCst)) { return Err("Geo 设置已变化，取消本轮自动更新".into()); }
    Ok(())
}
async fn wait_for_change(revision: u64) {
    loop {
        let notified = CHANGED.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if revision != REVISION.load(Ordering::SeqCst) { return; }
        notified.await;
    }
}

async fn download_once(url: &str, use_proxy: Option<u16>) -> Result<Vec<u8>, String> {
    validate_url(url)?;
    let mut builder = reqwest::Client::builder()
        .connect_timeout(if use_proxy.is_some() {
            std::time::Duration::from_secs(30)
        } else {
            std::time::Duration::from_secs(12)
        })
        .timeout(std::time::Duration::from_secs(90));
    if let Some(port) = use_proxy {
        if let Ok(proxy) = reqwest::Proxy::all(format!("http://127.0.0.1:{}", port)) {
            builder = builder.proxy(proxy);
        }
    }
    let client = builder.build().map_err(|e| format!("初始化 Geo 下载客户端失败: {}", e))?;
    let mut response = client
        .get(url)
        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36")
        .send()
        .await
        .map_err(|e| format!("Geo 下载连接失败: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("Geo 下载返回 HTTP {}", response.status()));
    }
    if response.content_length().is_some_and(|n| n > MAX_BYTES as u64) {
        return Err("Geo 文件超过 128 MiB 限制".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| format!("读取 Geo 数据失败: {}", e))? {
        if bytes.len() + chunk.len() > MAX_BYTES {
            return Err("Geo 文件超过 128 MiB 限制".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    if bytes.is_empty() {
        return Err("Geo 下载为空文件".into());
    }
    Ok(bytes)
}

async fn download(url: &str) -> Result<Vec<u8>, String> {
    // 检查本地运行中的代理端口
    let local_proxy = if let Ok(settings) = crate::commands::settings::get_general_settings() {
        let port = settings.mixed_port;
        if tokio::net::TcpStream::connect(("127.0.0.1", port)).await.is_ok() {
            Some(port)
        } else {
            None
        }
    } else {
        None
    };

    // 优先 1：若本地代理处于运行就绪状态，优先通过本地代理极速下载 GitHub 规则源
    if let Some(port) = local_proxy {
        if let Ok(bytes) = download_once(url, Some(port)).await {
            return Ok(bytes);
        }
    }

    // 优先 2：直连下载源站
    match download_once(url, None).await {
        Ok(bytes) => Ok(bytes),
        Err(direct_err) => {
            // 优先 3：直连失败且为 GitHub 资源时，自动回退到可靠的公共 GitHub 加速镜像
            if url.starts_with("https://github.com/") {
                let mirrors = [
                    format!("https://ghfast.top/{}", url),
                    format!("https://mirror.ghproxy.com/{}", url),
                    format!("https://ghproxy.net/{}", url),
                    format!("https://gh-proxy.com/{}", url),
                ];
                for mirror in mirrors {
                    if let Ok(bytes) = download_once(&mirror, None).await {
                        return Ok(bytes);
                    }
                }
            }
            Err(format!("直连及加速镜像下载均失败 ({direct_err})，请确认网络连接或开启代理"))
        }
    }
}

// 只放入候选文件并强制对应解析器读取；禁止从网络补齐或修复候选。
fn validate_database(exe: &std::path::Path, id: &str, bytes: &[u8]) -> Result<(), String> {
    let (file, mode, rule) = match id {
        "mmdb" => ("geoip.metadb", false, "GEOIP,CN,DIRECT"),
        "asn" => ("ASN.mmdb", false, "IP-ASN,13335,DIRECT"),
        "geoip" => ("geoip.dat", true, "GEOIP,CN,DIRECT"),
        "geosite" => ("geosite.dat", true, "GEOSITE,cn,DIRECT"),
        _ => return Err("未知 Geo 格式".into()),
    };
    let stamp = SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos();
    let dir = std::env::temp_dir().join(format!("netbox-geo-check-{}-{stamp}", std::process::id()));
    fs::create_dir_all(&dir).map_err(|_| "创建 Geo 校验目录失败")?;
    let result = (|| {
        fs::write(dir.join(file), bytes).map_err(|_| "写入 Geo 候选失败")?;
        let yaml = format!("mode: rule\ngeodata-mode: {mode}\ngeo-auto-update: false\ngeodata-loader: standard\ngeox-url:\n  geoip: http://127.0.0.1:0/disabled\n  mmdb: http://127.0.0.1:0/disabled\n  asn: http://127.0.0.1:0/disabled\n  geosite: http://127.0.0.1:0/disabled\nrules:\n  - {rule}\n  - MATCH,DIRECT\n");
        let config = dir.join("config.yaml");
        fs::write(&config, yaml).map_err(|_| "写入 Geo 校验配置失败")?;
        let mut command = std::process::Command::new(exe);
        command.args(["-t", "-d"]).arg(&dir).arg("-f").arg(&config)
            .stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
        for name in ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"] { command.env_remove(name); }
        #[cfg(windows)] { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
        let mut child = command.spawn().map_err(|_| "启动 Geo 校验核心失败")?;
        let start = std::time::Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(status)) => return if status.success() && fs::read(dir.join(file)).is_ok_and(|v| v == bytes) { Ok(()) }
                    else { Err("Geo 数据库格式或内容校验失败，旧文件保持不变".into()) },
                Ok(None) if start.elapsed().as_secs() < 15 => std::thread::sleep(std::time::Duration::from_millis(25)),
                _ => { let _ = child.kill(); let _ = child.wait(); return Err("Geo 校验超时或异常，旧文件保持不变".into()); }
            }
        }
    })();
    let _ = fs::remove_dir_all(dir);
    result
}

fn commit_files(files: &[(PathBuf, &[u8])]) -> Result<(), String> {
    let originals: Vec<_> = files.iter().map(|(path, _)| match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)), Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("备份 Geo 文件失败".to_string()),
    }).collect::<Result<_, _>>()?;
    for (i, (path, bytes)) in files.iter().enumerate() {
        if let Err(error) = crate::storage::replace_atomic(path, bytes) {
            let mut failures = Vec::new();
            for j in (0..i).rev() {
                let result = match &originals[j] {
                    Some(old) => crate::storage::replace_atomic(&files[j].0, old),
                    None => fs::remove_file(&files[j].0).map_err(|e| e.to_string()),
                };
                if result.is_err() { failures.push(j.to_string()); }
            }
            return if failures.is_empty() { Err(format!("Geo 更新失败，已恢复旧文件：{error}")) }
                else { Err("Geo 更新失败且部分恢复失败，请保留备份并重试".into()) };
        }
    }
    Ok(())
}

async fn sync_one(id: &str, custom_url: Option<String>, revision: Option<u64>) -> Result<GeoResource, String> {
    check_revision(revision)?;
    let config = read_config()?;
    let mut res = config.resources.into_iter().find(|r| r.id == id).ok_or("未知 Geo 资源")?;
    let original_url = res.url.clone();
    if let Some(url) = custom_url.filter(|v| !v.trim().is_empty()) { res.url = url.trim().into(); }
    let bytes = if let Some(revision) = revision {
        tokio::select! { result = download(&res.url) => result?, _ = wait_for_change(revision) => return Err("Geo 设置已变化，取消本轮自动更新".into()) }
    } else { download(&res.url).await? };
    let exe = super::profile::validation_core()?;
    let owned_id = id.to_string();
    let bytes = tokio::task::spawn_blocking(move || { validate_database(&exe, &owned_id, &bytes)?; Ok::<_, String>(bytes) })
        .await.map_err(|_| "Geo 校验任务失败")??;
    let _config = CONFIG.lock().await;
    check_revision(revision)?;
    let mut latest = read_config()?;
    let entry = latest.resources.iter_mut().find(|r| r.id == id).ok_or("Geo 资源已移除")?;
    if entry.url != original_url {
        return Err("Geo 地址已变化，请重新同步".into());
    }
    entry.url = res.url.clone();
    let metadata = serde_json::to_vec_pretty(&latest).map_err(|_| "生成 Geo 元数据失败")?;
    let mut files = vec![(get_core_data_dir().join(&res.file_name), bytes.as_slice())];
    let compatibility = super::profile::get_base_dir().join("config").join(&res.file_name);
    if compatibility.exists() || matches!(id, "mmdb" | "geosite") { files.push((compatibility, bytes.as_slice())); }
    if id == "asn" { files.push((get_core_data_dir().join("ASN.mmdb"), bytes.as_slice())); }
    files.push((get_geo_config_path(), metadata.as_slice()));
    commit_files(&files)?;
    enrich_resource_with_file(&mut res);
    Ok(res)
}

#[tauri::command]
pub async fn sync_geo_resource(id: String, custom_url: Option<String>) -> Result<GeoResource, String> {
    let _update = UPDATE.lock().await;
    sync_one(&id, custom_url, None).await
}
async fn sync_all_locked(revision: Option<u64>) -> Result<GeoConfig, String> {
    let mut failures = Vec::new();
    for res in read_config()?.resources {
        check_revision(revision)?;
        if let Err(error) = sync_one(&res.id, None, revision).await { failures.push(format!("{}：{error}", res.name)); }
    }
    let _config = CONFIG.lock().await;
    check_revision(revision)?;
    let mut config = read_config()?;
    config.last_checked_at = Some(now_seconds().to_string());
    config.last_error = if failures.is_empty() { None } else { Some(failures.join("；")) };
    write_config(&config)?;
    if let Some(error) = &config.last_error { return Err(error.clone()); }
    Ok(config)
}
#[tauri::command]
pub async fn sync_all_geo_resources() -> Result<GeoConfig, String> {
    let _update = UPDATE.lock().await;
    sync_all_locked(None).await
}

pub(crate) async fn run_scheduler() {
    loop {
        // 启动时检查遗漏周期；读取持久化时间，避免重启后立即重复下载。
        if let Ok(_update) = UPDATE.try_lock() {
            if read_config().is_ok_and(|c| due(&c, now_seconds())) {
                let revision = REVISION.load(Ordering::SeqCst);
                if let Err(error) = sync_all_locked(Some(revision)).await { eprintln!("Geo 自动更新：{error}"); }
            }
        }
        tokio::select! { _ = tokio::time::sleep(std::time::Duration::from_secs(60)) => {}, _ = CHANGED.notified() => {} }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_geo_formats_reject_html_and_truncated_candidates() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf();
        let exe = root.join("binaries/mihomo-compatible.exe");
        for resource in get_default_resources() {
            let bytes = fs::read(root.join("core_data").join(&resource.file_name)).unwrap();
            validate_database(&exe, &resource.id, &bytes).unwrap_or_else(|e| panic!("{}: {e}", resource.id));
            assert!(validate_database(&exe, &resource.id, b"<html>upstream failed</html>").is_err(), "{} HTML", resource.id);
            assert!(validate_database(&exe, &resource.id, &bytes[..bytes.len() / 2]).is_err(), "{} 截断", resource.id);
        }
    }
    #[test]
    fn schedule_obeys_period_restart_and_disabled_state() {
        let mut config = GeoConfig { auto_update: true, update_interval_hours: 2, last_checked_at: None, last_error: None, resources: vec![] };
        assert!(due(&config, 100));
        config.last_checked_at = Some("100".into());
        assert!(!due(&config, 7299)); assert!(due(&config, 7300));
        let restored: GeoConfig = serde_json::from_slice(&serde_json::to_vec(&config).unwrap()).unwrap();
        assert!(due(&restored, 8000));
        config.auto_update = false; assert!(!due(&config, 8000));
        config.update_interval_hours = 0; assert!(validate_settings(&config).is_err());
    }
    #[test]
    fn metadata_failure_rolls_back_database_and_compatibility_copy() {
        let dir = std::env::temp_dir().join(format!("netbox-geo-rollback-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let target = dir.join("geo.dat"); let copy = dir.join("copy.dat"); let metadata = dir.join("geo.json");
        fs::write(&target, b"old-valid").unwrap(); fs::write(&metadata, b"old-metadata").unwrap();
        #[cfg(windows)] {
            use std::os::windows::fs::OpenOptionsExt;
            let held = fs::OpenOptions::new().read(true).share_mode(1).open(&metadata).unwrap();
            assert!(commit_files(&[(target.clone(), b"new-valid"), (copy.clone(), b"new-valid"), (metadata.clone(), b"new-metadata")]).is_err());
            assert_eq!(fs::read(&target).unwrap(), b"old-valid"); assert!(!copy.exists());
            assert_eq!(fs::read(&metadata).unwrap(), b"old-metadata");
            drop(held);
        }
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn download_and_scheduler_cancel_preserve_existing_data() {
        const FLAG: &str = "NETBOX_GEO_TEST_CHILD";
        if std::env::var_os(FLAG).is_none() {
            assert!(std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "commands::geo::tests::download_and_scheduler_cancel_preserve_existing_data"])
                .env(FLAG, "1").status().unwrap().success()); return;
        }
        let root = std::env::temp_dir().join(format!("netbox-geo-integration-{}", std::process::id()));
        fs::create_dir_all(root.join("config")).unwrap();
        let resources = PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf();
        let valid = fs::read(resources.join("core_data/geoip.metadb")).unwrap();
        crate::storage::initialize_test(root.clone(), resources);
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let (arrived, mut requests) = tokio::sync::mpsc::unbounded_channel();
            let valid_response = valid.clone();
            let server = tokio::spawn(async move {
                loop {
                    let (mut stream, _) = listener.accept().await.unwrap();
                    let mut request = [0; 4096]; let count = stream.read(&mut request).await.unwrap();
                    let request = String::from_utf8_lossy(&request[..count]);
                    if request.starts_with("GET /slow ") { arrived.send(()).unwrap(); let mut data = [0; 1]; let _ = stream.read(&mut data).await; continue; }
                    let body: &[u8] = if request.starts_with("GET /valid ") { &valid_response } else { b"<html>bad</html>" };
                    let length = if request.starts_with("GET /large ") { MAX_BYTES + 1 } else { body.len() };
                    let header = format!("HTTP/1.1 200 OK\r\nContent-Length: {length}\r\nConnection: close\r\n\r\n");
                    let _ = stream.write_all(header.as_bytes()).await; let _ = stream.write_all(body).await;
                }
            });
            let mut config = read_config().unwrap(); config.auto_update = false;
            for res in &mut config.resources { res.url = format!("http://{address}/valid"); }
            save_geo_config(config.clone()).await.unwrap();
            sync_geo_resource("mmdb".into(), None).await.unwrap();
            let target = get_core_data_dir().join("geoip.metadb");
            assert_eq!(fs::read(&target).unwrap(), valid);
            assert!(sync_geo_resource("mmdb".into(), Some(format!("http://{address}/html"))).await.is_err());
            assert_eq!(fs::read(&target).unwrap(), valid);
            assert!(download(&format!("http://{address}/large")).await.is_err());
            config.auto_update = true;
            for res in &mut config.resources { res.url = format!("http://{address}/slow"); }
            save_geo_config(config.clone()).await.unwrap();
            let scheduler = tokio::spawn(run_scheduler());
            tokio::time::timeout(std::time::Duration::from_secs(3), requests.recv()).await.unwrap().unwrap();
            // 自动任务下载中，手动同步只能排队；关闭自动更新后取消正在下载的旧批次。
            let manual = sync_geo_resource("mmdb".into(), Some(format!("http://{address}/valid")));
            tokio::pin!(manual);
            assert!(tokio::time::timeout(std::time::Duration::from_millis(50), &mut manual).await.is_err());
            config.auto_update = false; save_geo_config(config).await.unwrap();
            tokio::time::timeout(std::time::Duration::from_secs(5), manual).await.unwrap().unwrap();
            assert_eq!(fs::read(&target).unwrap(), valid);
            assert!(read_config().unwrap().last_checked_at.is_none());
            scheduler.abort(); server.abort();
        });
        fs::remove_dir_all(root).unwrap();
    }
}

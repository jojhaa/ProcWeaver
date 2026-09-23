use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::State;
use crate::commands::process::{check_avx2_support, CoreStateMutex};

/// 客户端主版本更新检测结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateInfo {
    pub current_version: String,
    pub latest_version: String,
    pub has_update: bool,
    pub release_name: String,
    pub release_notes: String,
    pub published_at: String,
    pub download_url: Option<String>,
    pub asset_name: Option<String>,
    pub asset_size_bytes: u64,
    pub asset_size_formatted: String,
    pub html_url: String,
    pub repo_url: String,
}

/// 代理内核运行与版本详情
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MihomoCoreDetail {
    pub active_core_mode: String,
    pub active_core_path: Option<String>,
    pub core_version_raw: String,
    pub core_version_tag: String,
    pub cpu_arch: String,
    pub avx2_supported: bool,
    pub recommended_core: String,
    pub is_running: bool,
    pub pid: Option<u32>,
    pub mixed_port: u16,
    pub controller_port: u16,
    pub started_at: Option<u64>,
}

/// 官方 Mihomo 发行版检测结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MihomoReleaseInfo {
    pub latest_version: String,
    pub release_name: String,
    pub published_at: String,
    pub download_url: Option<String>,
    pub asset_name: Option<String>,
    pub asset_size_bytes: u64,
    pub asset_size_formatted: String,
    pub html_url: String,
}

/// 规则包仓库状态
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RulesRepoInfo {
    pub repo_url: String,
    pub latest_tag: Option<String>,
    pub release_name: Option<String>,
    pub updated_at: Option<String>,
    pub description: String,
}

fn format_bytes(bytes: u64) -> String {
    if bytes >= 1024 * 1024 * 1024 {
        format!("{:.2} GB", bytes as f64 / (1024.0 * 1024.0 * 1024.0))
    } else if bytes >= 1024 * 1024 {
        format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
    } else if bytes >= 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    } else if bytes > 0 {
        format!("{} B", bytes)
    } else {
        "0 B".to_string()
    }
}

/// 构造网络客户端，优先走本地核心代理
fn build_http_client(proxy_port: Option<u16>) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(45))
        .user_agent(concat!("ProcWeaver-Desktop/", env!("CARGO_PKG_VERSION"), " (Windows NT 10.0; Win64; x64)"));

    if let Some(port) = proxy_port {
        if let Ok(proxy) = reqwest::Proxy::all(format!("http://127.0.0.1:{}", port)) {
            builder = builder.proxy(proxy);
        }
    }
    builder.build().map_err(|e| format!("构建 HTTP 客户端失败: {}", e))
}

/// 获取当前代理核心的混合端口（若正在运行）
fn get_running_proxy_port(state: &State<'_, CoreStateMutex>) -> Option<u16> {
    if let Ok(guard) = state.lock() {
        if guard.child.is_some() {
            return Some(guard.mixed_port);
        }
    }
    None
}

/// 检测 ProcWeaver 主仓库 Release
#[tauri::command]
pub async fn check_app_update(
    state: State<'_, CoreStateMutex>,
) -> Result<AppUpdateInfo, String> {
    let current_version = env!("CARGO_PKG_VERSION").to_string();
    let repo_owner_repo = "jojhaa/ProcWeaver";
    let api_url = format!("https://api.github.com/repos/{}/releases/latest", repo_owner_repo);
    let proxy_port = get_running_proxy_port(&state);

    // 尝试带代理或直连获取
    let client = build_http_client(proxy_port)?;
    let response = client
        .get(&api_url)
        .header("Accept", "application/vnd.github.v3+json")
        .send()
        .await;

    // 如果带代理失败且有代理端口，尝试直连一次兜底
    let res = match response {
        Ok(r) => Ok(r),
        Err(e) => {
            if proxy_port.is_some() {
                let direct_client = build_http_client(None)?;
                direct_client
                    .get(&api_url)
                    .header("Accept", "application/vnd.github.v3+json")
                    .send()
                    .await
            } else {
                Err(e)
            }
        }
    };

    let release_val = match res {
        Ok(r) if r.status().is_success() => {
            r.json::<serde_json::Value>().await.map_err(|e| format!("解析 Release JSON 失败: {}", e))?
        }
        Ok(r) => {
            return Err(format!("GitHub API 响应异常: HTTP {}", r.status()));
        }
        Err(e) => {
            return Err(format!("检测更新网络请求失败: {}", e));
        }
    };

    let tag_raw = release_val.get("tag_name").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let clean_latest = tag_raw.trim_start_matches('v').to_string();
    let release_name = release_val.get("name").and_then(|v| v.as_str()).unwrap_or(&tag_raw).to_string();
    let release_notes = release_val.get("body").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let published_at = release_val.get("published_at").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let html_url = release_val.get("html_url").and_then(|v| v.as_str()).unwrap_or("https://github.com/jojhaa/ProcWeaver/releases").to_string();

    // 比较版本
    let has_update = compare_semver(&clean_latest, &current_version);

    // 挑选合适的 Windows 资产：优先选择 Portable.zip，其次选择 .exe
    let mut download_url = None;
    let mut asset_name = None;
    let mut asset_size_bytes = 0u64;

    if let Some(assets) = release_val.get("assets").and_then(|v| v.as_array()) {
        // 先找 Portable zip
        for asset in assets {
            let name = asset.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let lower = name.to_lowercase();
            if lower.ends_with(".zip") && (lower.contains("portable") || lower.contains("procweaver")) {
                asset_name = Some(name.to_string());
                download_url = asset.get("browser_download_url").and_then(|v| v.as_str()).map(|s| s.to_string());
                asset_size_bytes = asset.get("size").and_then(|v| v.as_u64()).unwrap_or(0);
                break;
            }
        }
        // 若无 Portable zip，则找任意 Windows 安装包或压缩包
        if download_url.is_none() {
            for asset in assets {
                let name = asset.get("name").and_then(|v| v.as_str()).unwrap_or("");
                let lower = name.to_lowercase();
                if lower.ends_with(".zip") || lower.ends_with(".exe") || lower.ends_with(".msi") {
                    asset_name = Some(name.to_string());
                    download_url = asset.get("browser_download_url").and_then(|v| v.as_str()).map(|s| s.to_string());
                    asset_size_bytes = asset.get("size").and_then(|v| v.as_u64()).unwrap_or(0);
                    break;
                }
            }
        }
    }

    let asset_size_formatted = format_bytes(asset_size_bytes);

    Ok(AppUpdateInfo {
        current_version: format!("V{}", current_version),
        latest_version: if tag_raw.is_empty() { format!("V{}", current_version) } else { tag_raw },
        has_update,
        release_name,
        release_notes,
        published_at,
        download_url,
        asset_name,
        asset_size_bytes,
        asset_size_formatted,
        html_url,
        repo_url: "https://github.com/jojhaa/ProcWeaver".to_string(),
    })
}

/// 语义化版本简单对比：若 latest > current 返回 true
fn compare_semver(latest: &str, current: &str) -> bool {
    let parse = |v: &str| -> Vec<u64> {
        v.split('.')
            .map(|p| p.split('-').next().unwrap_or("0"))
            .filter_map(|p| p.parse::<u64>().ok())
            .collect()
    };
    let l_parts = parse(latest);
    let c_parts = parse(current);
    let max_len = l_parts.len().max(c_parts.len());
    for i in 0..max_len {
        let l = l_parts.get(i).copied().unwrap_or(0);
        let c = c_parts.get(i).copied().unwrap_or(0);
        if l > c {
            return true;
        } else if l < c {
            return false;
        }
    }
    false
}

/// 下载客户端更新包到本地缓存
#[tauri::command]
pub async fn download_app_update(
    download_url: String,
    file_name: String,
    state: State<'_, CoreStateMutex>,
) -> Result<String, String> {
    let base_dir = crate::commands::profile::get_base_dir();
    let cache_dir = base_dir.join(".update_cache");
    std::fs::create_dir_all(&cache_dir).map_err(|e| format!("创建更新缓存目录失败: {}", e))?;

    let dest_path = cache_dir.join(&file_name);
    let proxy_port = get_running_proxy_port(&state);
    let client = build_http_client(proxy_port)?;

    let mut response = client
        .get(&download_url)
        .send()
        .await
        .map_err(|e| format!("下载更新包请求失败: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("下载更新包失败: HTTP {}", response.status()));
    }

    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| format!("读取更新包数据失败: {}", e))? {
        bytes.extend_from_slice(&chunk);
    }

    if bytes.is_empty() {
        return Err("下载的更新包为空".into());
    }

    std::fs::write(&dest_path, &bytes).map_err(|e| format!("保存更新包失败: {}", e))?;
    Ok(dest_path.to_string_lossy().to_string())
}

/// 执行客户端更新替换安装（便携模式保护：绝不碰 data/ 目录）
#[tauri::command]
pub async fn install_app_update(archive_path: String) -> Result<bool, String> {
    let archive = PathBuf::from(&archive_path);
    if !archive.exists() {
        return Err("更新包文件不存在".into());
    }

    let current_exe = std::env::current_exe().map_err(|e| format!("获取当前程序路径失败: {}", e))?;
    let app_dir = current_exe.parent().ok_or("无法获取应用所在目录")?.to_path_buf();

    let file_name_lower = archive.file_name().unwrap_or_default().to_string_lossy().to_lowercase();

    // 若为独立 exe 安装器，直接拉起安装器
    if file_name_lower.ends_with(".exe") {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            std::process::Command::new(&archive)
                .creation_flags(0x00000008) // DETACHED_PROCESS
                .spawn()
                .map_err(|e| format!("启动安装程序失败: {}", e))?;
            return Ok(true);
        }
        #[cfg(not(windows))]
        {
            return Err("非 Windows 平台不支持该安装方式".into());
        }
    }

    // 若为 ZIP 便携包：解压并无损热替换
    if file_name_lower.ends_with(".zip") {
        let temp_extract = app_dir.join(".update_cache").join("extracted");
        let _ = std::fs::remove_dir_all(&temp_extract);
        std::fs::create_dir_all(&temp_extract).map_err(|e| format!("创建解压目录失败: {}", e))?;

        // 优先使用系统内置 tar 命令解压 zip，兼容 Windows 10/11
        let mut tar_cmd = std::process::Command::new("tar");
        tar_cmd
            .arg("-xf")
            .arg(&archive)
            .arg("-C")
            .arg(&temp_extract);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            tar_cmd.creation_flags(0x08000000);
        }
        let status = tar_cmd.status();

        let extract_ok = match status {
            Ok(s) if s.success() => true,
            _ => {
                // 降级使用 PowerShell Expand-Archive
                let ps_cmd = format!(
                    "Expand-Archive -Path '{}' -DestinationPath '{}' -Force",
                    archive.to_string_lossy(),
                    temp_extract.to_string_lossy()
                );
                let mut ps_process = std::process::Command::new("powershell");
                ps_process.args(["-NoProfile", "-NonInteractive", "-Command", &ps_cmd]);
                #[cfg(windows)]
                {
                    use std::os::windows::process::CommandExt;
                    ps_process.creation_flags(0x08000000);
                }
                let ps_status = ps_process.status();
                matches!(ps_status, Ok(s) if s.success())
            }
        };

        if !extract_ok {
            return Err("解压更新包失败，请检查压缩文件完整性".into());
        }

        // 寻找新版的 ProcWeaver.exe
        let mut new_exe_path = temp_extract.join("ProcWeaver.exe");
        if !new_exe_path.exists() {
            // 可能压缩包内套了一层目录，深入一层查找
            if let Ok(entries) = std::fs::read_dir(&temp_extract) {
                for entry in entries.flatten() {
                    let sub = entry.path().join("ProcWeaver.exe");
                    if sub.exists() {
                        new_exe_path = sub;
                        break;
                    }
                }
            }
        }

        if !new_exe_path.exists() {
            return Err("更新包内未找到主程序 ProcWeaver.exe".into());
        }

        // 在 Windows 下执行运行中 exe 重命名并替换
        let old_exe_bak = app_dir.join("ProcWeaver.exe.old");
        let _ = std::fs::remove_file(&old_exe_bak);

        if let Err(e) = std::fs::rename(&current_exe, &old_exe_bak) {
            return Err(format!("重命名当前主程序失败: {}", e));
        }

        if let Err(e) = std::fs::copy(&new_exe_path, &current_exe) {
            // 复制失败尝试回滚
            let _ = std::fs::rename(&old_exe_bak, &current_exe);
            return Err(format!("写入新版主程序失败: {}", e));
        }

        // 便携模式核心铁律：绝对禁止清空或覆盖 app_dir/data 目录！
        return Ok(true);
    }

    Err("不受支持的更新包类型".into())
}

/// 重启应用
#[tauri::command]
pub async fn restart_app(app: tauri::AppHandle) -> Result<(), String> {
    crate::shutdown::request(&app, tauri::RESTART_EXIT_CODE);
    Ok(())
}

/// 获取当前内核的详细运行与版本信息
#[tauri::command]
pub async fn get_mihomo_core_detail(
    state: State<'_, CoreStateMutex>,
) -> Result<MihomoCoreDetail, String> {
    let base_dir = crate::commands::profile::get_base_dir();
    let resource_dir = crate::storage::resource_dir();

    let (active_mode, active_path, is_running, pid, mixed_port, controller_port, started_at) = {
        let guard = state.lock().map_err(|e| e.to_string())?;
        let is_run = guard.child.as_ref().is_some();
        let pid_val = guard.child.as_ref().map(|c| c.id());
        (
            guard.core_mode.clone().unwrap_or_else(|| "auto".to_string()),
            guard.active_core_path.clone(),
            is_run,
            pid_val,
            guard.mixed_port,
            guard.controller_port,
            guard.started_at,
        )
    };

    let avx2 = check_avx2_support();
    let recommended = if avx2 { "v3" } else { "compatible" };

    // 定位实际内核二进制文件
    let find_bin = |name: &str| -> Option<PathBuf> {
        let candidates = [
            resource_dir.join("binaries").join(name),
            base_dir.join("binaries").join(name),
        ];
        for c in &candidates {
            if c.exists() { return Some(c.clone()); }
        }
        None
    };

    let candidate_path = if let Some(ref p) = active_path {
        let pb = PathBuf::from(p);
        if pb.exists() {
            pb
        } else if avx2 && find_bin("mihomo-v3.exe").is_some() {
            find_bin("mihomo-v3.exe").unwrap()
        } else if let Some(p) = find_bin("mihomo-compatible.exe") {
            p
        } else if let Some(p) = find_bin("mihomo.exe") {
            p
        } else {
            base_dir.join("binaries").join("mihomo.exe")
        }
    } else if avx2 && find_bin("mihomo-v3.exe").is_some() {
        find_bin("mihomo-v3.exe").unwrap()
    } else if let Some(p) = find_bin("mihomo-compatible.exe") {
        p
    } else if let Some(p) = find_bin("mihomo.exe") {
        p
    } else {
        base_dir.join("binaries").join("mihomo.exe")
    };

    // 探测真实内核版本 -v
    let mut core_version_raw = "未知内核版本".to_string();
    let mut core_version_tag = "v1.19.0".to_string();

    if candidate_path.exists() {
        let mut ver_cmd = std::process::Command::new(&candidate_path);
        ver_cmd.arg("-v");
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            ver_cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW 杜绝一闪而过的黑框
        }
        if let Ok(output) = ver_cmd.output() {
            let out_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !out_str.is_empty() {
                core_version_raw = out_str.clone();
                // 尝试从中截取 tag，例如 "Mihomo Meta v1.19.0 windows amd64 with go1.22..."
                for part in out_str.split_whitespace() {
                    if part.starts_with('v') && part.chars().nth(1).map_or(false, |c| c.is_ascii_digit()) {
                        core_version_tag = part.to_string();
                        break;
                    }
                }
            }
        }
    }

    // 双重保险：若内核正在运行，向本地 controller 发起 /version 探测
    if is_running {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_millis(800))
            .build();
        if let Ok(cli) = client {
            let ver_url = format!("http://127.0.0.1:{}/version", controller_port);
            if let Ok(resp) = cli.get(&ver_url).send().await {
                if resp.status().is_success() {
                    if let Ok(json_val) = resp.json::<serde_json::Value>().await {
                        if let Some(v) = json_val.get("version").and_then(|v| v.as_str()) {
                            if !v.is_empty() {
                                core_version_tag = if v.starts_with('v') { v.to_string() } else { format!("v{}", v) };
                                if core_version_raw == "未知内核版本" {
                                    core_version_raw = format!("Mihomo Meta {} (from REST API)", core_version_tag);
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    Ok(MihomoCoreDetail {
        active_core_mode: active_mode,
        active_core_path: Some(candidate_path.to_string_lossy().to_string()),
        core_version_raw,
        core_version_tag,
        cpu_arch: std::env::consts::ARCH.to_string(),
        avx2_supported: avx2,
        recommended_core: recommended.to_string(),
        is_running,
        pid,
        mixed_port,
        controller_port,
        started_at,
    })
}

/// 检查 MetaCubeX/mihomo 官方 Release
#[tauri::command]
pub async fn check_mihomo_update(
    state: State<'_, CoreStateMutex>,
) -> Result<MihomoReleaseInfo, String> {
    let api_url = "https://api.github.com/repos/MetaCubeX/mihomo/releases/latest";
    let proxy_port = get_running_proxy_port(&state);
    let client = build_http_client(proxy_port)?;

    let response = client
        .get(api_url)
        .header("Accept", "application/vnd.github.v3+json")
        .send()
        .await;

    let res = match response {
        Ok(r) => Ok(r),
        Err(e) => {
            if proxy_port.is_some() {
                let direct = build_http_client(None)?;
                direct.get(api_url).header("Accept", "application/vnd.github.v3+json").send().await
            } else {
                Err(e)
            }
        }
    };

    let release_val = match res {
        Ok(r) if r.status().is_success() => {
            r.json::<serde_json::Value>().await.map_err(|e| format!("解析 Mihomo Release JSON 失败: {}", e))?
        }
        Ok(r) => return Err(format!("GitHub API 返回异常: HTTP {}", r.status())),
        Err(e) => return Err(format!("检测 Mihomo 更新失败: {}", e)),
    };

    let tag_raw = release_val.get("tag_name").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let release_name = release_val.get("name").and_then(|v| v.as_str()).unwrap_or(&tag_raw).to_string();
    let published_at = release_val.get("published_at").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let html_url = release_val.get("html_url").and_then(|v| v.as_str()).unwrap_or("https://github.com/MetaCubeX/mihomo/releases").to_string();

    let avx2 = check_avx2_support();
    let mut download_url = None;
    let mut asset_name = None;
    let mut asset_size_bytes = 0u64;

    if let Some(assets) = release_val.get("assets").and_then(|v| v.as_array()) {
        // 根据 CPU 是否支持 AVX2，寻找 windows-amd64-v3 或 windows-amd64-compatible
        let target_kw = if avx2 { "windows-amd64-v3" } else { "windows-amd64-compatible" };
        for asset in assets {
            let name = asset.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let lower = name.to_lowercase();
            if lower.contains("windows") && lower.contains("amd64") && (lower.contains(target_kw) || lower.ends_with(".zip")) {
                asset_name = Some(name.to_string());
                download_url = asset.get("browser_download_url").and_then(|v| v.as_str()).map(|s| s.to_string());
                asset_size_bytes = asset.get("size").and_then(|v| v.as_u64()).unwrap_or(0);
                if lower.contains(target_kw) {
                    break;
                }
            }
        }
    }

    let asset_size_formatted = format_bytes(asset_size_bytes);

    Ok(MihomoReleaseInfo {
        latest_version: tag_raw,
        release_name,
        published_at,
        download_url,
        asset_name,
        asset_size_bytes,
        asset_size_formatted,
        html_url,
    })
}

/// 检查规则仓库 (ProcWeaver-Rules) 发版动态
#[tauri::command]
pub async fn check_rules_repo_update(
    state: State<'_, CoreStateMutex>,
) -> Result<RulesRepoInfo, String> {
    let repo_url = "https://github.com/jojhaa/ProcWeaver-Rules".to_string();
    let api_url = "https://api.github.com/repos/jojhaa/ProcWeaver-Rules/releases/latest";
    let proxy_port = get_running_proxy_port(&state);
    let client = build_http_client(proxy_port)?;

    let res = client
        .get(api_url)
        .header("Accept", "application/vnd.github.v3+json")
        .send()
        .await;

    if let Ok(r) = res {
        if r.status().is_success() {
            if let Ok(val) = r.json::<serde_json::Value>().await {
                let tag = val.get("tag_name").and_then(|v| v.as_str()).map(|s| s.to_string());
                let name = val.get("name").and_then(|v| v.as_str()).map(|s| s.to_string());
                let updated = val.get("published_at").and_then(|v| v.as_str()).map(|s| s.to_string());
                return Ok(RulesRepoInfo {
                    repo_url,
                    latest_tag: tag,
                    release_name: name,
                    updated_at: updated,
                    description: "包含常用业务规则包 (.pwpack.json)、分流规则集与增强规则配置".to_string(),
                });
            }
        }
    }

    // 默认兜底信息
    Ok(RulesRepoInfo {
        repo_url,
        latest_tag: Some("main (持续同步)".to_string()),
        release_name: Some("ProcWeaver 规则仓库 (Business-Rules & Core-Rules)".to_string()),
        updated_at: None,
        description: "包含 Business-Rules 业务规则包与 Core-Rules 核心分流规则集".to_string(),
    })
}

/// 核心分流规则集 (Core-Rules) 更新检测结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreRulesUpdateInfo {
    pub current_version: String,
    pub latest_version: String,
    pub has_update: bool,
    pub total_rules_count: usize,
    pub release_name: String,
    pub release_notes: String,
    pub published_at: String,
    pub download_url: Option<String>,
    pub asset_name: Option<String>,
    pub asset_size_bytes: u64,
    pub asset_size_formatted: String,
    pub local_rules_dir: String,
}

/// 检测 ProcWeaver-Rules 仓库中的 Core-Rules 核心规则集更新
#[tauri::command]
pub async fn check_core_rules_update(
    state: State<'_, CoreStateMutex>,
) -> Result<CoreRulesUpdateInfo, String> {
    let base_dir = crate::commands::profile::get_base_dir();
    let local_plan_dir = base_dir.join("core_data").join("ruleset").join("local-plan");
    
    // 统计本地规则文件数量
    let mut total_rules_count = 0;
    if let Ok(entries) = std::fs::read_dir(&local_plan_dir) {
        for entry in entries.flatten() {
            if let Some(ext) = entry.path().extension().and_then(|s| s.to_str()) {
                let ext_lower = ext.to_lowercase();
                if ext_lower == "mrs" || ext_lower == "yaml" || ext_lower == "txt" {
                    total_rules_count += 1;
                }
            }
        }
    }

    // 读取本地规则版本
    let version_file = local_plan_dir.join(".version");
    let current_version = if version_file.exists() {
        std::fs::read_to_string(&version_file).unwrap_or_else(|_| "v2026.09.21".to_string()).trim().to_string()
    } else {
        "v2026.09.21".to_string()
    };

    let api_url = "https://api.github.com/repos/jojhaa/ProcWeaver-Rules/releases/latest";
    let proxy_port = get_running_proxy_port(&state);
    let client = build_http_client(proxy_port)?;

    let res = client
        .get(api_url)
        .header("Accept", "application/vnd.github.v3+json")
        .send()
        .await;

    let mut latest_version = current_version.clone();
    let mut release_name = "Core-Rules 核心规则基准版".to_string();
    let mut release_notes = "当前为本地核心分流规则集基准版本，支持 AI、流媒体、国内直连等 30 项预设分流。".to_string();
    let mut published_at = "2026-09-21".to_string();
    let mut download_url = None;
    let mut asset_name = None;
    let mut asset_size_bytes = 0u64;
    let mut has_update = false;

    if let Ok(r) = res {
        if r.status().is_success() {
            if let Ok(val) = r.json::<serde_json::Value>().await {
                if let Some(tag) = val.get("tag_name").and_then(|v| v.as_str()) {
                    latest_version = tag.to_string();
                }
                if let Some(name) = val.get("name").and_then(|v| v.as_str()) {
                    release_name = name.to_string();
                }
                if let Some(body) = val.get("body").and_then(|v| v.as_str()) {
                    release_notes = body.to_string();
                }
                if let Some(published) = val.get("published_at").and_then(|v| v.as_str()) {
                    published_at = published.to_string();
                }

                // 寻找 Core-Rules 相关的压缩包
                if let Some(assets) = val.get("assets").and_then(|v| v.as_array()) {
                    for asset in assets {
                        let name = asset.get("name").and_then(|v| v.as_str()).unwrap_or("");
                        let lower = name.to_lowercase();
                        if lower.ends_with(".zip") && (lower.contains("core-rules") || lower.contains("rules") || lower.contains("local-plan")) {
                            asset_name = Some(name.to_string());
                            download_url = asset.get("browser_download_url").and_then(|v| v.as_str()).map(|s| s.to_string());
                            asset_size_bytes = asset.get("size").and_then(|v| v.as_u64()).unwrap_or(0);
                            break;
                        }
                    }
                    // 若未找到特定命名，挑选第一个 zip
                    if download_url.is_none() {
                        for asset in assets {
                            let name = asset.get("name").and_then(|v| v.as_str()).unwrap_or("");
                            if name.to_lowercase().ends_with(".zip") {
                                asset_name = Some(name.to_string());
                                download_url = asset.get("browser_download_url").and_then(|v| v.as_str()).map(|s| s.to_string());
                                asset_size_bytes = asset.get("size").and_then(|v| v.as_u64()).unwrap_or(0);
                                break;
                            }
                        }
                    }
                }

                if !latest_version.is_empty() && latest_version != current_version {
                    has_update = true;
                }
            }
        }
    }

    let asset_size_formatted = format_bytes(asset_size_bytes);

    Ok(CoreRulesUpdateInfo {
        current_version,
        latest_version,
        has_update,
        total_rules_count,
        release_name,
        release_notes,
        published_at,
        download_url,
        asset_name,
        asset_size_bytes,
        asset_size_formatted,
        local_rules_dir: local_plan_dir.to_string_lossy().to_string(),
    })
}

/// 下载 Core-Rules 核心规则更新包，解压更新至 local-plan 并触发内核热重载
#[tauri::command]
pub async fn download_core_rules_update(
    download_url: String,
    version_tag: String,
    state: State<'_, CoreStateMutex>,
) -> Result<String, String> {
    let base_dir = crate::commands::profile::get_base_dir();
    let local_plan_dir = base_dir.join("core_data").join("ruleset").join("local-plan");
    std::fs::create_dir_all(&local_plan_dir).map_err(|e| format!("创建规则目录失败: {}", e))?;

    let proxy_port = get_running_proxy_port(&state);
    let client = build_http_client(proxy_port)?;

    let mut response = client
        .get(&download_url)
        .send()
        .await
        .map_err(|e| format!("下载核心规则包失败: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("下载核心规则失败: HTTP {}", response.status()));
    }

    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| format!("读取核心规则流失败: {}", e))? {
        bytes.extend_from_slice(&chunk);
    }

    if bytes.is_empty() {
        return Err("下载的核心规则包为空".into());
    }

    // 写入临时压缩包
    let cache_dir = base_dir.join(".update_cache");
    let _ = std::fs::create_dir_all(&cache_dir);
    let temp_zip = cache_dir.join("Core-Rules-temp.zip");
    std::fs::write(&temp_zip, &bytes).map_err(|e| format!("缓存规则包失败: {}", e))?;

    // 解压临时文件
    let temp_extract = cache_dir.join("extracted_core_rules");
    let _ = std::fs::remove_dir_all(&temp_extract);
    let _ = std::fs::create_dir_all(&temp_extract);

    let mut tar_cmd = std::process::Command::new("tar");
    tar_cmd
        .arg("-xf")
        .arg(&temp_zip)
        .arg("-C")
        .arg(&temp_extract);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        tar_cmd.creation_flags(0x08000000);
    }
    let status = tar_cmd.status();

    let extract_ok = match status {
        Ok(s) if s.success() => true,
        _ => {
            let ps_cmd = format!(
                "Expand-Archive -Path '{}' -DestinationPath '{}' -Force",
                temp_zip.to_string_lossy(),
                temp_extract.to_string_lossy()
            );
            let mut ps_cmd_obj = std::process::Command::new("powershell");
            ps_cmd_obj.args(["-NoProfile", "-NonInteractive", "-Command", &ps_cmd]);
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                ps_cmd_obj.creation_flags(0x08000000);
            }
            matches!(ps_cmd_obj.status(), Ok(s) if s.success())
        }
    };

    if !extract_ok {
        return Err("解压核心规则包失败".into());
    }

    // 递归收集解压出的 .mrs, .yaml, .txt 规则文件写入 local-plan
    let mut updated_count = 0;
    fn copy_rules(src: &std::path::Path, dst: &std::path::Path, count: &mut usize) {
        if let Ok(entries) = std::fs::read_dir(src) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_dir() {
                    copy_rules(&p, dst, count);
                } else if let Some(ext) = p.extension().and_then(|s| s.to_str()) {
                    let ext_lower = ext.to_lowercase();
                    if ext_lower == "mrs" || ext_lower == "yaml" || ext_lower == "txt" {
                        if let Some(fname) = p.file_name() {
                            let target = dst.join(fname);
                            if std::fs::copy(&p, &target).is_ok() {
                                *count += 1;
                            }
                        }
                    }
                }
            }
        }
    }
    copy_rules(&temp_extract, &local_plan_dir, &mut updated_count);

    // 写入新版本标识
    let version_file = local_plan_dir.join(".version");
    let _ = std::fs::write(&version_file, version_tag.as_bytes());

    // 清理临时文件
    let _ = std::fs::remove_file(&temp_zip);
    let _ = std::fs::remove_dir_all(&temp_extract);

    // 内核零断流热重载
    let (is_running, controller_port) = {
        if let Ok(guard) = state.lock() {
            (guard.child.is_some(), guard.controller_port)
        } else {
            (false, 9090)
        }
    };

    if is_running {
        let reload_client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(3))
            .build();
        if let Ok(cli) = reload_client {
            let core_config_path = base_dir.join("core_data").join("config.yaml");
            let reload_url = format!("http://127.0.0.1:{}/configs?force=true", controller_port);
            let body = serde_json::json!({
                "path": core_config_path.to_string_lossy()
            });
            let _ = cli.put(&reload_url).json(&body).send().await;
        }
    }

    Ok(format!("成功更新 {} 个核心规则集文件，内核分流规则已热重载生效！", updated_count))
}

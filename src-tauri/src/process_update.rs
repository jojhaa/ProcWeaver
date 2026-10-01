//! Separate update channel: only process portable assets, never a full installer.
use crate::commands::maintenance::AppUpdateInfo;
use serde_json::Value;
const REPO: &str = "https://github.com/jojhaa/ProcWeaver";
fn version(value: &str) -> Option<(u32, u32, u32)> {
    let parts = value.trim_start_matches(['v','V']).split('.').map(str::parse::<u32>).collect::<Result<Vec<_>, _>>().ok()?;
    (parts.len() == 3).then(|| (parts[0], parts[1], parts[2]))
}
fn asset_version(name: &str) -> Option<(u32,u32,u32)> {
    version(name.strip_prefix("ProcWeaverProcess_v")?.strip_suffix("_x64_Portable.zip")?)
}
fn selected(releases: &[Value]) -> Option<(&Value, &Value)> {
    releases.iter().filter(|r| r["draft"].as_bool() == Some(false) && r["prerelease"].as_bool() == Some(false))
        .flat_map(|r| r["assets"].as_array().into_iter().flatten().map(move |a| (r, a)))
        .filter(|(_,a)| a["name"].as_str().and_then(asset_version).is_some())
        .max_by_key(|(_,a)| asset_version(a["name"].as_str().unwrap()))
}
fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder().user_agent("ProcWeaverProcess")
        .connect_timeout(std::time::Duration::from_secs(10)).timeout(std::time::Duration::from_secs(120))
        .build().map_err(|_| "初始化更新请求失败".into())
}
#[tauri::command]
pub async fn check_process_update() -> Result<AppUpdateInfo, String> {
    let response = client()?.get("https://api.github.com/repos/jojhaa/ProcWeaver/releases?per_page=30")
        .send().await.map_err(|_| "连接版本服务器失败")?.error_for_status().map_err(|_| "版本服务器拒绝请求，请稍后重试")?;
    let releases: Vec<Value> = response.json().await.map_err(|_| "版本列表格式无效")?;
    let current = env!("CARGO_PKG_VERSION");
    let mut info = AppUpdateInfo {
        current_version: format!("V{current}"), latest_version: format!("V{current}"), has_update: false,
        release_name: "独立进程版".into(), release_notes: "当前发布列表尚无独立进程版便携包。".into(),
        published_at: String::new(), download_url: None, asset_name: None, asset_size_bytes: 0,
        asset_size_formatted: String::new(), html_url: format!("{REPO}/releases"), repo_url: REPO.into(),
    };
    if let Some((release, asset)) = selected(&releases) {
        let name = asset["name"].as_str().unwrap();
        let latest = asset_version(name).unwrap();
        let url = asset["browser_download_url"].as_str().ok_or("更新包地址缺失")?;
        if !url.starts_with("https://github.com/jojhaa/ProcWeaver/releases/download/") || !url.ends_with(name) { return Err("更新包来源无效".into()); }
        info.latest_version = format!("V{}.{}.{}", latest.0, latest.1, latest.2);
        info.has_update = Some(latest) > version(current);
        info.download_url = Some(url.into()); info.asset_name = Some(name.into());
        info.asset_size_bytes = asset["size"].as_u64().unwrap_or(0);
        info.asset_size_formatted = format!("{:.1} MB", info.asset_size_bytes as f64 / 1048576.);
        info.release_name = release["name"].as_str().unwrap_or("独立进程版更新").into();
        info.release_notes = release["body"].as_str().unwrap_or("").into();
        info.published_at = release["published_at"].as_str().unwrap_or("").into();
    }
    Ok(info)
}
#[tauri::command]
pub async fn download_process_update() -> Result<String, String> {
    use tokio::io::AsyncWriteExt;
    // Resolve again on the backend: no frontend-supplied URL, name or install path.
    let info = check_process_update().await?;
    let name = info.asset_name.ok_or("暂无独立进程版更新包")?;
    let url = info.download_url.ok_or("暂无独立进程版更新包")?;
    let folder = crate::storage::data_dir().join("downloads").join(
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|_| "系统时间无效")?.as_millis().to_string());
    tokio::fs::create_dir_all(&folder).await.map_err(|_| "创建下载目录失败")?;
    let path = folder.join(&name);
    let part = folder.join("download.part");
    let result = async {
        let mut response = client()?.get(url).send().await.map_err(|_| "下载请求失败")?
            .error_for_status().map_err(|_| "更新包下载失败")?;
        let mut file = tokio::fs::OpenOptions::new().create_new(true).write(true).open(&part).await.map_err(|_| "创建下载文件失败")?;
        let mut size = 0u64;
        while let Some(bytes) = response.chunk().await.map_err(|_| "下载中断，请重试")? {
            size += bytes.len() as u64;
            if size > 256 * 1024 * 1024 { return Err("更新包超过大小上限".into()); }
            file.write_all(&bytes).await.map_err(|_| "写入更新包失败")?;
        }
        if size == 0 || size != info.asset_size_bytes { return Err("下载大小不符，文件未保存".into()); }
        file.sync_all().await.map_err(|_| "保存更新包失败")?; drop(file);
        tokio::fs::rename(&part, &path).await.map_err(|_| "完成下载失败")?;
        Ok(path.to_string_lossy().into_owned())
    }.await;
    if result.is_err() { let _ = tokio::fs::remove_file(part).await; }
    result
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn never_selects_full_packages_or_paths() {
        for name in ["ProcWeaver_v99.0.0_x64_Portable.zip", "ProcWeaverProcess.exe", "../ProcWeaverProcess_v2.0.6_x64_Portable.zip"] { assert!(asset_version(name).is_none()); }
        let releases = serde_json::json!([
            {"draft":false,"prerelease":false,"assets":[{"name":"ProcWeaver_v99.0.0_x64_Portable.zip"}]},
            {"draft":false,"prerelease":false,"assets":[{"name":"ProcWeaverProcess_v2.0.6_x64_Portable.zip"}]},
            {"draft":false,"prerelease":true,"assets":[{"name":"ProcWeaverProcess_v3.0.0_x64_Portable.zip"}]}]);
        assert_eq!(selected(releases.as_array().unwrap()).unwrap().1["name"], "ProcWeaverProcess_v2.0.6_x64_Portable.zip");
    }
}

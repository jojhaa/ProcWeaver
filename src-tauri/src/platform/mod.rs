//! 平台差异集中在此；业务规则、出口和代理协议保持共用。
use serde::Serialize;
use std::path::{Path, PathBuf};
#[cfg(any(target_os = "macos", test))]
pub mod arguments;
#[cfg(any(target_os = "macos", test))]
pub mod proxy_state;

#[cfg(target_os = "macos")]
pub mod macos;
#[cfg(target_os = "android")]
pub mod android;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub os: String,
    pub arch: String,
    pub label: String,
    pub app_proxy: bool,
    pub tun: bool,
    pub smart_hybrid: bool,
    pub system_proxy: bool,
    pub dns_guard: bool,
    pub process_tree: bool,
    pub process_watcher: bool,
    pub shortcut_management: bool,
    pub autostart: bool,
    pub elevation: bool,
    pub core_modes: Vec<String>,
}

pub fn capabilities_for(os: &str, arch: &str) -> Capabilities {
    let windows = os == "windows";
    let macos = os == "macos" && matches!(arch, "aarch64" | "x86_64");
    Capabilities {
        os: os.into(), arch: arch.into(),
        label: match (os, arch) {
            ("macos", "aarch64") => "macOS · Apple Silicon".into(),
            ("macos", "x86_64") => "macOS · Intel".into(),
            ("windows", "x86_64") => "Windows · x64".into(),
            _ => format!("{os} · {arch}"),
        },
        app_proxy: windows || macos, tun: windows || os == "android", smart_hybrid: windows, system_proxy: windows || macos,
        dns_guard: windows, process_tree: windows || macos, process_watcher: windows,
        shortcut_management: windows, autostart: windows || macos, elevation: windows,
        core_modes: if windows { vec!["auto", "v3", "compatible", "standard"] } else { vec!["auto", "standard"] }
            .into_iter().map(String::from).collect(),
    }
}

#[tauri::command]
pub fn get_platform_capabilities() -> Capabilities {
    capabilities_for(std::env::consts::OS, std::env::consts::ARCH)
}

pub fn supports_tun() -> bool { cfg!(any(windows, target_os = "android")) }
pub fn supports_smart_hybrid() -> bool { cfg!(windows) }

#[tauri::command]
pub async fn get_android_applications() -> Result<serde_json::Value, String> {
    #[cfg(target_os = "android")]
    { android::call_async("applications", ()).await }
    #[cfg(not(target_os = "android"))]
    { Err("应用包名列表仅用于 Android".into()) }
}

#[tauri::command]
pub async fn android_mobile_action(action: String, page: Option<String>, start: Option<i64>, end: Option<i64>) -> Result<serde_json::Value, String> {
    if !matches!(action.as_str(), "windowInsets" | "appearance" | "networkInfo" | "openSettings" | "takeImport" | "readDocument" | "scanQr" | "readQrImage" | "trafficHistory" | "proxyHistory" | "clearProxyHistory" | "addVpnTile") { return Err("未知手机操作".into()); }
    #[cfg(target_os = "android")]
    { android::call_async("mobileAction", serde_json::json!({"action":action, "page":page.unwrap_or_default(), "start":start.unwrap_or(0), "end":end.unwrap_or(0)})).await }
    #[cfg(not(target_os = "android"))]
    { let _ = (page, start, end); Err("此操作仅用于 Android".into()) }
}

#[tauri::command]
pub async fn save_android_document(filename: String, content: String, mime: String) -> Result<serde_json::Value, String> {
    if content.len() > 8 * 1024 * 1024 || filename.is_empty() || filename.len() > 240 || filename.contains(['/', '\\', '\0']) {
        return Err("导出文件名无效或内容超过 8 MB".into());
    }
    #[cfg(target_os = "android")]
    { android::call_async("saveDocument", serde_json::json!({"filename":filename,"content":content,"mime":mime})).await }
    #[cfg(not(target_os = "android"))]
    { let _ = mime; Err("系统文档保存仅用于 Android".into()) }
}

#[tauri::command]
pub fn get_core_log_token() -> Result<String, String> {
    #[cfg(target_os = "android")]
    { android::controller_secret() }
    #[cfg(not(target_os = "android"))]
    { Ok(String::new()) }
}

pub fn path_key(value: &str) -> String {
    if cfg!(windows) { value.replace('/', "\\").to_lowercase() } else { value.to_string() }
}
pub fn same_path(a: &str, b: &str) -> bool { path_key(a) == path_key(b) }

pub fn validate_traffic_mode(mode: &str, tun: bool) -> Result<(), String> {
    validate_traffic_mode_for(std::env::consts::OS, mode, tun)
}

fn validate_traffic_mode_for(os: &str, mode: &str, tun: bool) -> Result<(), String> {
    if mode == "windivert_v1" && (os != "windows" || tun) { return Err("WinDivert 仅支持 Windows，且不能与 TUN 同时启用".into()); }
    if os == "android" {
        return if mode == "tun" && tun { Ok(()) } else { Err("Android 使用系统 VPN 模式接管流量".into()) };
    }
    if mode == "smart_hybrid" && os != "windows" {
        return Err("智能混合模式目前仅支持 Windows；macOS TUN 需要独立的授权与网络恢复".into());
    }
    if (tun || mode == "tun") && os != "windows" {
        return Err("macOS TUN 尚未就绪：需要独立管理员授权、路由和 DNS 恢复及实机验收；未修改当前网络".into());
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MacTunReadiness {
    pub can_enable: bool,
    pub core_present: bool,
    pub authorization_ready: bool,
    pub network_recovery_ready: bool,
    pub message: String,
}

#[tauri::command]
pub fn get_macos_tun_readiness() -> Result<MacTunReadiness, String> {
    #[cfg(target_os = "macos")]
    {
        let core_present = resolve_core(&crate::storage::resource_dir(), &crate::storage::data_dir(), "auto").is_ok();
        Ok(MacTunReadiness {
            can_enable: false, core_present, authorization_ready: false, network_recovery_ready: false,
            message: "macOS TUN 尚未启用。此检查只读取核心文件；管理员授权和路由/DNS 恢复尚未完成实机验证，当前仍使用应用代理。".into(),
        })
    }
    #[cfg(not(target_os = "macos"))]
    { Err("此就绪检查仅适用于 macOS".into()) }
}

/// 名称包含 Darwin 架构，避免混装后启动错误架构的核心。
pub fn core_names_for(os: &str, arch: &str, mode: &str, avx2: bool) -> Result<Vec<&'static str>, String> {
    match (os, arch) {
        ("windows", _) => Ok(match mode {
            "v3" if !avx2 => return Err("当前 CPU 不支持 AVX2，请选择兼容核心".into()),
            "v3" => vec!["mihomo-v3.exe"],
            "compatible" => vec!["mihomo-compatible.exe"],
            // 旧 standard 配置复用兼容核心；旧文件名仅用于已有安装的回退。
            "standard" => vec!["mihomo-compatible.exe", "mihomo.exe"],
            "auto" if avx2 => vec!["mihomo-v3.exe", "mihomo-compatible.exe", "mihomo.exe"],
            "auto" => vec!["mihomo-compatible.exe", "mihomo.exe"],
            _ => return Err("未知核心类型".into()),
        }),
        ("macos", "aarch64") if matches!(mode, "auto" | "standard") => Ok(vec!["mihomo-darwin-arm64"]),
        ("macos", "x86_64") if matches!(mode, "auto" | "standard") => Ok(vec!["mihomo-darwin-amd64"]),
        ("macos", "aarch64" | "x86_64") => Err("macOS 请使用当前架构的原生核心（自动或标准版）".into()),
        _ => Err("当前系统或架构尚未支持".into()),
    }
}

pub fn core_names(mode: &str) -> Result<Vec<&'static str>, String> {
    core_names_for(std::env::consts::OS, std::env::consts::ARCH, mode, crate::commands::process::check_avx2_support())
}

pub fn resolve_core(resources: &Path, data: &Path, mode: &str) -> Result<(PathBuf, String), String> {
    for name in core_names(mode)? {
        for root in [resources, data] {
            let path = root.join("binaries").join(name);
            if path.is_file() {
                #[cfg(unix)] {
                    use std::os::unix::fs::PermissionsExt;
                    if path.metadata().map_err(|_| "读取核心文件权限失败")?.permissions().mode() & 0o111 == 0 {
                        return Err("Mihomo 核心缺少执行权限，请重新安装匹配架构的完整应用包".into());
                    }
                }
                let label = match name {
                    "mihomo-v3.exe" => "amd64-v3 (AVX2 高性能)",
                    "mihomo-compatible.exe" => "amd64-compatible (通用兼容)",
                    "mihomo-darwin-arm64" => "macOS ARM64 (Apple Silicon)",
                    "mihomo-darwin-amd64" => "macOS AMD64 (Intel)",
                    _ => "mihomo 标准版",
                };
                return Ok((path, label.into()));
            }
        }
    }
    Err(format!("未找到当前系统核心：{}", core_names(mode)?.join(" / ")))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn android_uses_native_vpn_without_desktop_permissions() {
        let android = capabilities_for("android", "aarch64");
        assert!(android.tun);
        assert!(!android.app_proxy && !android.system_proxy && !android.elevation && !android.process_tree);
        assert!(validate_traffic_mode_for("android", "tun", true).is_ok());
        assert!(validate_traffic_mode_for("android", "app_proxy", false).is_err());
        assert!(validate_traffic_mode_for("android", "smart_hybrid", true).is_err());
    }
    #[test]
    fn darwin_architectures_never_select_windows_or_other_architecture() {
        for (arch, file) in [("aarch64", "mihomo-darwin-arm64"), ("x86_64", "mihomo-darwin-amd64")] {
            assert_eq!(core_names_for("macos", arch, "auto", true).unwrap(), vec![file]);
            assert!(core_names_for("macos", arch, "v3", true).is_err());
            let capabilities = capabilities_for("macos", arch);
            assert!(capabilities.app_proxy && capabilities.process_tree);
            assert!(!capabilities.tun && !capabilities.smart_hybrid && !capabilities.dns_guard && !capabilities.elevation);
        }
        assert!(core_names_for("macos", "arm", "auto", false).is_err());
    }
    #[test]
    fn windows_core_preference_and_capabilities_are_preserved() {
        assert_eq!(core_names_for("windows", "x86_64", "auto", true).unwrap()[0], "mihomo-v3.exe");
        assert_eq!(core_names_for("windows", "x86_64", "auto", false).unwrap()[0], "mihomo-compatible.exe");
        assert!(capabilities_for("windows", "x86_64").tun);
        assert!(capabilities_for("windows", "x86_64").smart_hybrid);
    }
    #[test]
    fn windows_legacy_standard_prefers_compatible_and_keeps_old_install_fallback() {
        for avx2 in [false, true] {
            assert_eq!(core_names_for("windows", "x86_64", "standard", avx2).unwrap(),
                vec!["mihomo-compatible.exe", "mihomo.exe"]);
        }
        assert_eq!(core_names_for("windows", "x86_64", "auto", false).unwrap(),
            vec!["mihomo-compatible.exe", "mihomo.exe"]);
        assert_eq!(core_names_for("windows", "x86_64", "auto", true).unwrap(),
            vec!["mihomo-v3.exe", "mihomo-compatible.exe", "mihomo.exe"]);
        assert!(core_names_for("windows", "x86_64", "v3", false).is_err());
    }
    #[cfg(windows)]
    #[test]
    fn windows_standard_resolves_two_core_package_and_legacy_install() {
        let root = std::env::temp_dir().join(format!("procweaver-two-core-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let binaries = root.join("binaries");
        let data = root.join("data");
        std::fs::create_dir_all(&binaries).unwrap();
        let compatible = binaries.join("mihomo-compatible.exe");
        let legacy = binaries.join("mihomo.exe");
        std::fs::write(&compatible, b"compatible fixture").unwrap();
        std::fs::write(binaries.join("mihomo-v3.exe"), b"v3 fixture").unwrap();
        assert!(!legacy.exists());
        for mode in ["standard", "compatible"] {
            let (path, label) = resolve_core(&root, &data, mode).unwrap();
            assert_eq!(path, compatible);
            assert!(label.contains("compatible"));
        }
        // 旧目录即使残留 mihomo.exe，也优先使用新版兼容核心。
        std::fs::write(&legacy, b"legacy fixture").unwrap();
        assert_eq!(resolve_core(&root, &data, "standard").unwrap().0, compatible);
        std::fs::remove_file(&compatible).unwrap();
        assert_eq!(resolve_core(&root, &data, "standard").unwrap().0, legacy);
        std::fs::remove_file(&legacy).unwrap();
        assert!(resolve_core(&root, &data, "standard").is_err());
        std::fs::remove_dir_all(&root).unwrap();
    }
    #[test]
    fn macos_tun_and_windows_only_hybrid_are_rejected_before_settings_change() {
        assert!(validate_traffic_mode_for("macos", "tun", true).unwrap_err().contains("未修改当前网络"));
        assert!(validate_traffic_mode_for("macos", "smart_hybrid", false).unwrap_err().contains("仅支持 Windows"));
        assert!(validate_traffic_mode_for("macos", "app_proxy", true).is_err());
        assert!(validate_traffic_mode_for("macos", "app_proxy", false).is_ok());
        assert!(validate_traffic_mode_for("windows", "tun", true).is_ok());
    }
}

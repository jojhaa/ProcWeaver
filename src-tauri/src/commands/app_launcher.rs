use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Serialize)]
pub struct LaunchResult {
    pub success: bool,
    pub message: String,
}

/// 解除指定 AppContainer 的本地回环隔离 (纯应用层轻量调用系统自带 CheckNetIsolation)
pub fn ensure_loopback_exempt(package_family: &str) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut cmd = Command::new("CheckNetIsolation.exe");
        cmd.args(["LoopbackExempt", "-a", &format!("-n={}", package_family)]);
        cmd.creation_flags(CREATE_NO_WINDOW);
        let _ = cmd.output();
    }
}

/// 获取当前代理混合端口
fn get_proxy_port() -> u16 {
    crate::commands::settings::get_general_settings()
        .map(|s| s.mixed_port)
        .unwrap_or(7890)
}

/// 寻找 ChatGPT 桌面端可执行文件
pub fn find_chatgpt_executable() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        // 1. 优先检查当前用户独立安装路径 (Local AppData)
        if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
            let user_exe = Path::new(&local_app_data)
                .join("Programs")
                .join("ChatGPT")
                .join("ChatGPT.exe");
            if user_exe.exists() {
                return Some(user_exe);
            }
        }

        // 2. 检查 Program Files 标准安装
        if let Ok(prog_files) = std::env::var("ProgramFiles") {
            let pf_exe = Path::new(&prog_files)
                .join("ChatGPT")
                .join("ChatGPT.exe");
            if pf_exe.exists() {
                return Some(pf_exe);
            }

        }
        // 3. 只使用当前用户已注册的商店应用入口，不扫描残留版本目录。
        return super::packaged_app::find("OpenAI.Codex_2p2nqsd0c76g0", "ChatGPT.exe").ok().flatten();
    }
    #[cfg(not(windows))]
    None
}

/// 通用查找常用预设应用路径
#[cfg(target_os = "macos")]
pub fn find_app_executable(preset_id: &str) -> Option<PathBuf> { crate::platform::macos::apps::find(preset_id) }
#[cfg(not(target_os = "macos"))]
pub fn find_app_executable(preset_id: &str) -> Option<PathBuf> {
    let local = std::env::var("LOCALAPPDATA").unwrap_or_default();
    let prog = std::env::var("ProgramFiles").unwrap_or_default();
    let prog_x86 = std::env::var("ProgramFiles(x86)").unwrap_or_default();

    match preset_id {
        "chatgpt" => find_chatgpt_executable(),
        "claude" => {
            let c1 = Path::new(&local).join("Programs").join("Claude").join("Claude.exe");
            if c1.exists() { Some(c1) } else { None }
        }
        "cursor" => {
            let c1 = Path::new(&local).join("Programs").join("cursor").join("Cursor.exe");
            if c1.exists() { Some(c1) } else { None }
        }
        "vscode" => {
            let c1 = Path::new(&local).join("Programs").join("Microsoft VS Code").join("Code.exe");
            if c1.exists() { return Some(c1); }
            let c2 = Path::new(&prog).join("Microsoft VS Code").join("Code.exe");
            if c2.exists() { Some(c2) } else { None }
        }
        "chrome" => {
            let c1 = Path::new(&prog).join("Google").join("Chrome").join("Application").join("chrome.exe");
            if c1.exists() { return Some(c1); }
            let c2 = Path::new(&prog_x86).join("Google").join("Chrome").join("Application").join("chrome.exe");
            if c2.exists() { return Some(c2); }
            let c3 = Path::new(&local).join("Google").join("Chrome").join("Application").join("chrome.exe");
            if c3.exists() { Some(c3) } else { None }
        }
        "msedge" | "edge" => {
            let c1 = Path::new(&prog_x86).join("Microsoft").join("Edge").join("Application").join("msedge.exe");
            if c1.exists() { return Some(c1); }
            let c2 = Path::new(&prog).join("Microsoft").join("Edge").join("Application").join("msedge.exe");
            if c2.exists() { return Some(c2); }
            let c3 = Path::new(&local).join("Microsoft").join("Edge").join("Application").join("msedge.exe");
            if c3.exists() { Some(c3) } else { None }
        }
        "discord" => {
            let c1 = Path::new(&local).join("Discord").join("Update.exe");
            if c1.exists() { Some(c1) } else { None }
        }
        "antigravity" => {
            let c1 = Path::new(&local).join("Programs").join("antigravity").join("Antigravity.exe");
            if c1.exists() { return Some(c1); }
            let c2 = Path::new(&local).join("Programs").join("Antigravity").join("Antigravity.exe");
            if c2.exists() { return Some(c2); }
            let c3 = Path::new(&local).join("Programs").join("Antigravity").join("antigravity.exe");
            if c3.exists() { return Some(c3); }
            let c4 = Path::new(&prog).join("Antigravity").join("Antigravity.exe");
            if c4.exists() { return Some(c4); }
            let c5 = Path::new(&prog).join("Antigravity").join("antigravity.exe");
            if c5.exists() { Some(c5) } else { None }
        }
        "antigravity-ide" => {
            let c1 = Path::new(&local).join("Programs").join("Antigravity IDE").join("Antigravity IDE.exe");
            if c1.exists() { return Some(c1); }
            let c2 = Path::new(&prog).join("Antigravity IDE").join("Antigravity IDE.exe");
            if c2.exists() { return Some(c2); }
            let c3 = Path::new(&local).join("Programs").join("Antigravity IDE").join("Antigravity.exe");
            if c3.exists() { return Some(c3); }
            let c4 = Path::new(&prog).join("Antigravity IDE").join("Antigravity.exe");
            if c4.exists() { Some(c4) } else { None }
        }
        _ => None,
    }
}

/// 启动指定预设应用并注入全套轻量应用层代理环境
#[tauri::command]
pub fn launch_preset_app(preset_id: String) -> Result<LaunchResult, String> {
    let port = get_proxy_port();
    let proxy_url = format!("http://127.0.0.1:{}", port);

    // 如果是 ChatGPT，顺带执行回环豁免
    if preset_id == "chatgpt" {
        ensure_loopback_exempt("OpenAI.Codex_2p2nqsd0c76g0");
    }

    if let Some(exe_path) = find_app_executable(&preset_id) {
        #[cfg(windows)]
        if let Some(application)=super::packaged_app::resolve(&exe_path)? {
            application.activate(&[
                format!("--proxy-server={proxy_url}"),
                "--proxy-bypass-list=<-loopback>;localhost;127.0.0.1;::1".into(),
            ])?;
            return Ok(LaunchResult { success:true, message:super::packaged_app::activation_note().into() });
        }
        #[cfg(target_os = "macos")]
        if crate::platform::macos::apps::requires_system_proxy(&exe_path) && !super::sysproxy::get_system_proxy_status()? {
            return Err("此原生应用需要先启用系统代理；启动后仍须核验实际连接出口".into());
        }
        let mut cmd = Command::new(&exe_path);
        if preset_id == "discord" && exe_path.file_name().map_or(false, |n| n == "Update.exe") {
            cmd.args(["--processStart", "Discord.exe"]);
        }
        #[cfg(target_os = "macos")]
        let supports_args = crate::platform::macos::apps::supports_proxy_arguments(&exe_path);
        #[cfg(not(target_os = "macos"))]
        let supports_args = true;
        if supports_args {
            cmd.arg(format!("--proxy-server={}", proxy_url));
            cmd.arg("--proxy-bypass-list=<-loopback>;localhost;127.0.0.1;::1");
        }
        cmd.env("HTTP_PROXY", &proxy_url);
        cmd.env("HTTPS_PROXY", &proxy_url);
        cmd.env("ALL_PROXY", &proxy_url);
        cmd.env("http_proxy", &proxy_url);
        cmd.env("https_proxy", &proxy_url);
        cmd.env("all_proxy", &proxy_url);
        cmd.env("NODE_USE_ENV_PROXY", "1");
        cmd.env("NO_PROXY", "localhost,127.0.0.1,::1");

        if let Some(parent) = exe_path.parent() {
            cmd.current_dir(parent);
        }

        match cmd.spawn() {
            Ok(_) => Ok(LaunchResult {
                success: true,
                message: format!("「{}」已启动，代理入口 127.0.0.1:{}；目标应用须遵循代理设置，实际出口仍需核验", preset_id, port),
            }),
            Err(e) => Err(format!("启动 {} 失败: {}", preset_id, e)),
        }
    } else if preset_id == "chatgpt" {
        Err("未找到当前用户可用的 ChatGPT 安装入口，请在业务包中重新选择已安装的主程序".into())
    } else {
        Err(format!("未在系统标准路径检测到「{}」的安装，请确认是否已安装该应用", preset_id))
    }
}

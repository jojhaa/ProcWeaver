use std::path::{Path, PathBuf};

pub fn resolve(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() { return Err("应用路径必须是绝对路径".into()); }
    let executable = if path.is_dir() && path.extension().is_some_and(|s| s == "app") {
        let plist = path.join("Contents/Info.plist");
        let name = super::text("/usr/bin/plutil", &["-extract", "CFBundleExecutable", "raw", "-o", "-", &plist.to_string_lossy()])?;
        if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\', '\0', '\n', '\r']) {
            return Err("应用包中的可执行文件名无效".into());
        }
        let root = path.join("Contents/MacOS").canonicalize().map_err(|_| "应用包缺少可执行目录")?;
        let target = root.join(name).canonicalize().map_err(|_| "应用包缺少可执行文件")?;
        if !target.starts_with(root) { return Err("应用可执行文件越过包目录".into()); }
        target
    } else { path.canonicalize().map_err(|_| "应用路径不存在")? };
    use std::os::unix::fs::PermissionsExt;
    let metadata = executable.metadata().map_err(|_| "读取应用文件失败")?;
    if !metadata.is_file() || metadata.permissions().mode() & 0o111 == 0 { return Err("所选文件不能执行".into()); }
    Ok(executable)
}

pub fn find(preset: &str) -> Option<PathBuf> {
    let names: &[&str] = match preset {
        "chatgpt" => &["ChatGPT.app"], "claude" => &["Claude.app"], "cursor" => &["Cursor.app"],
        "code" | "vscode" | "visual studio code" => &["Visual Studio Code.app"],
        "chrome" | "google chrome" => &["Google Chrome.app"], "msedge" | "microsoft edge" => &["Microsoft Edge.app"],
        "discord" => &["Discord.app"], "antigravity" | "antigravity ide" => &["Antigravity.app", "Antigravity IDE.app"],
        _ => &[],
    };
    let mut roots = vec![PathBuf::from("/Applications")];
    if let Some(home) = std::env::var_os("HOME") { roots.insert(0, PathBuf::from(home).join("Applications")); }
    roots.iter().flat_map(|root| names.iter().map(move |name| root.join(name))).find_map(|path| resolve(&path).ok())
}

pub fn choose() -> Result<Option<String>, String> {
    let script = "try\nreturn POSIX path of (choose file with prompt \"选择应用（.app）或可执行文件\")\non error number -128\nreturn \"\"\nend try";
    let output = super::output("/usr/bin/osascript", &["-e", script], std::time::Duration::from_secs(300))?;
    if !output.status.success() { return Err("打开 macOS 应用选择器失败".into()); }
    let path = std::str::from_utf8(&output.stdout).map_err(|_| "应用路径编码无效")?.trim_end();
    if path.is_empty() { return Ok(None); }
    Ok(Some(resolve(Path::new(path))?.to_string_lossy().into_owned()))
}

pub fn supports_proxy_arguments(exe: &Path) -> bool {
    matches!(exe.file_name().and_then(|s| s.to_str()), Some("Google Chrome" | "Microsoft Edge" | "Chromium" | "Electron" | "Cursor" | "Antigravity" | "Code" | "Discord"))
}
pub fn requires_system_proxy(exe: &Path) -> bool {
    !supports_proxy_arguments(exe) && exe.ancestors().any(|path| path.extension().is_some_and(|s| s == "app"))
}

pub fn set_autostart(enable: bool) -> Result<(), String> {
    let home = std::env::var_os("HOME").ok_or("无法定位用户目录")?;
    let directory = PathBuf::from(home).join("Library/LaunchAgents");
    let path = directory.join("com.procweaver.desktop.plist");
    if !enable {
        if path.exists() {
            let content = std::fs::read_to_string(&path).map_err(|_| "读取登录启动项失败")?;
            if !content.contains("ProcWeaver managed login item") { return Err("登录启动项不属于本程序，未覆盖".into()); }
            std::fs::remove_file(path).map_err(|_| "删除登录启动项失败")?;
        }
        return Ok(());
    }
    let exe = std::env::current_exe().map_err(|_| "读取客户端路径失败")?;
    if exe.starts_with("/Volumes") || exe.to_string_lossy().contains("/AppTranslocation/") {
        return Err("请先将 ProcWeaver 移至 Applications 后再启用登录启动".into());
    }
    let escape = |s: &str| s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&apos;");
    let content = format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!-- ProcWeaver managed login item -->\n<plist version=\"1.0\"><dict><key>Label</key><string>com.procweaver.desktop</string><key>ProgramArguments</key><array><string>{}</string></array><key>RunAtLoad</key><true/><key>ProcessType</key><string>Interactive</string></dict></plist>\n", escape(&exe.to_string_lossy()));
    if path.exists() && !std::fs::read_to_string(&path).map_err(|_| "读取登录启动项失败")?.contains("ProcWeaver managed login item") {
        return Err("登录启动项不属于本程序，未覆盖".into());
    }
    std::fs::create_dir_all(directory).map_err(|_| "创建登录启动目录失败")?;
    crate::storage::replace_atomic(&path, content.as_bytes())?;
    if std::fs::read_to_string(path).map_err(|_| "回读登录启动项失败")? != content { return Err("登录启动项回读不一致".into()); }
    Ok(())
}

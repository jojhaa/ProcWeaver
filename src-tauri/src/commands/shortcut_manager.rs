use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Command;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct ShortcutBackup {
    pub file_path: String,
    pub original_arguments: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct ShortcutStatus {
    pub existing_found: bool,
    pub existing_patched: bool,
    pub dedicated_exists: bool,
    pub target_exe_found: bool,
}

fn backup_path() -> PathBuf {
    crate::storage::data_dir().join("config/shortcut-backups.json")
}

fn load_backups() -> HashMap<String, ShortcutBackup> {
    let p = backup_path();
    if let Ok(bytes) = std::fs::read(&p) {
        if let Ok(m) = serde_json::from_slice::<HashMap<String, ShortcutBackup>>(&bytes) {
            return m;
        }
    }
    HashMap::new()
}

fn save_backups(m: &HashMap<String, ShortcutBackup>) {
    let p = backup_path();
    if let Some(parent) = p.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(p, serde_json::to_vec_pretty(m).unwrap_or_default());
}

fn get_proxy_port() -> u16 {
    crate::commands::settings::get_general_settings()
        .map(|s| s.mixed_port)
        .unwrap_or(7890)
}

fn run_powershell(script: &str) -> Result<String, String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut cmd = Command::new("powershell");
        cmd.args(["-NoProfile", "-NonInteractive", "-Command", script]);
        cmd.creation_flags(CREATE_NO_WINDOW);
        let output = cmd.output().map_err(|e| format!("执行 PowerShell 失败: {}", e))?;
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if !output.status.success() && !stderr.is_empty() {
            return Err(format!("PowerShell 错误: {}", stderr));
        }
        Ok(stdout)
    }
    #[cfg(not(windows))]
    {
        let _ = script;
        Ok(String::new())
    }
}

/// 查找桌面目录
fn get_user_desktop_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        if let Ok(profile) = std::env::var("USERPROFILE") {
            let path = PathBuf::from(profile).join("Desktop");
            if path.exists() {
                return Some(path);
            }
        }
    }
    None
}

struct AppShortcutMeta {
    pub display_name: &'static str,
    pub match_keywords: &'static [&'static str],
    pub dedicated_name: &'static str,
}

pub fn normalize_app_id(input: &str) -> String {
    let s = input.trim().to_lowercase();
    let s = s.strip_suffix(".exe").unwrap_or(&s);
    let s = s.strip_suffix("-suite").unwrap_or(s);
    match s {
        "claude" => "claude".to_string(),
        "cursor" => "cursor".to_string(),
        "vscode" | "code" | "visualstudiocode" => "vscode".to_string(),
        "chrome" | "googlechrome" => "chrome".to_string(),
        "msedge" | "edge" => "msedge".to_string(),
        "antigravity" => "antigravity".to_string(),
        "antigravity-ide" | "antigravity_ide" => "antigravity-ide".to_string(),
        "chatgpt" | "codex" => "chatgpt".to_string(),
        other => other.to_string(),
    }
}

fn get_app_meta(app_id: &str) -> Result<AppShortcutMeta, String> {
    let normalized = normalize_app_id(app_id);
    match normalized.as_str() {
        "claude" => Ok(AppShortcutMeta {
            display_name: "Claude",
            match_keywords: &["claude"],
            dedicated_name: "Claude (ProcWeaver 加速).lnk",
        }),
        "cursor" => Ok(AppShortcutMeta {
            display_name: "Cursor",
            match_keywords: &["cursor"],
            dedicated_name: "Cursor (ProcWeaver 加速).lnk",
        }),
        "vscode" => Ok(AppShortcutMeta {
            display_name: "VS Code",
            match_keywords: &["code", "visual studio code"],
            dedicated_name: "VS Code (ProcWeaver 加速).lnk",
        }),
        "chrome" => Ok(AppShortcutMeta {
            display_name: "Google Chrome",
            match_keywords: &["chrome", "google chrome"],
            dedicated_name: "Google Chrome (ProcWeaver 加速).lnk",
        }),
        "msedge" => Ok(AppShortcutMeta {
            display_name: "Microsoft Edge",
            match_keywords: &["edge", "msedge"],
            dedicated_name: "Microsoft Edge (ProcWeaver 加速).lnk",
        }),
        "antigravity" => Ok(AppShortcutMeta {
            display_name: "Antigravity",
            match_keywords: &["antigravity"],
            dedicated_name: "Antigravity (ProcWeaver 加速).lnk",
        }),
        "antigravity-ide" => Ok(AppShortcutMeta {
            display_name: "Antigravity IDE",
            match_keywords: &["antigravity ide"],
            dedicated_name: "Antigravity IDE (ProcWeaver 加速).lnk",
        }),
        "chatgpt" => Ok(AppShortcutMeta {
            display_name: "ChatGPT",
            match_keywords: &["chatgpt", "codex"],
            dedicated_name: "ChatGPT (ProcWeaver 加速).lnk",
        }),
        _ => Err(format!("未识别或不支持快捷方式优化的应用: {}", app_id)),
    }
}

/// 在桌面上寻找应用现有的原生快捷方式 (.lnk)
fn find_desktop_app_lnk(app_id: &str) -> Option<PathBuf> {
    #[cfg(windows)]
    {
        let meta = get_app_meta(app_id).ok()?;
        let check_dirs = [
            get_user_desktop_dir(),
            std::env::var("PUBLIC").ok().map(|p| PathBuf::from(p).join("Desktop")),
        ];

        let mut candidate = None;
        for dir_opt in check_dirs.into_iter().flatten() {
            if dir_opt.exists() {
                if let Ok(entries) = std::fs::read_dir(&dir_opt) {
                    for entry in entries.flatten() {
                        let path = entry.path();
                        if let Some(ext) = path.extension() {
                            if ext.eq_ignore_ascii_case("lnk") {
                                let file_name = path.file_stem().unwrap_or_default().to_string_lossy().to_lowercase();
                                if file_name.contains("加速") {
                                    continue;
                                }
                                // 防冲突隔离：针对 Antigravity 客户端与 Antigravity IDE 互斥判断
                                if app_id == "antigravity" && file_name.contains("ide") {
                                    continue;
                                }
                                if app_id == "antigravity-ide" && !file_name.contains("ide") {
                                    continue;
                                }

                                // 精确匹配优先
                                if file_name == meta.display_name.to_lowercase() {
                                    return Some(path);
                                }

                                // 关键字匹配兜底
                                if meta.match_keywords.iter().any(|k| file_name.contains(k)) && candidate.is_none() {
                                    candidate = Some(path);
                                }
                            }
                        }
                    }
                }
            }
        }
        if candidate.is_some() {
            return candidate;
        }
    }
    None
}

/// 检查专属快捷方式是否存在
fn find_dedicated_app_lnk(app_id: &str) -> Option<PathBuf> {
    let meta = get_app_meta(app_id).ok()?;
    if let Some(desktop) = get_user_desktop_dir() {
        let dedicated = desktop.join(meta.dedicated_name);
        if dedicated.exists() {
            return Some(dedicated);
        }
    }
    None
}

/// 通用：获取快捷方式状态
#[tauri::command]
pub fn get_app_shortcut_status(app_id: String) -> Result<ShortcutStatus, String> {
    let normalized = normalize_app_id(&app_id);
    let mut status = ShortcutStatus::default();
    status.dedicated_exists = find_dedicated_app_lnk(&normalized).is_some();
    status.target_exe_found = crate::commands::app_launcher::find_app_executable(&normalized).is_some();

    if let Some(lnk) = find_desktop_app_lnk(&normalized) {
        status.existing_found = true;
        let script = format!(
            "$sh = New-Object -ComObject WScript.Shell; $sc = $sh.CreateShortcut('{}'); $sc.Arguments",
            lnk.to_string_lossy().replace('\'', "''")
        );
        if let Ok(args) = run_powershell(&script) {
            if args.contains("--proxy-server") {
                status.existing_patched = true;
            }
        }
    }

    Ok(status)
}

/// 兼容旧版：获取 ChatGPT 快捷方式状态
#[tauri::command]
pub fn get_shortcut_status() -> Result<ShortcutStatus, String> {
    get_app_shortcut_status("chatgpt".to_string())
}

/// 通用：改写桌面现有快捷方式，追加代理参数
#[tauri::command]
pub fn patch_app_shortcut(app_id: String) -> Result<String, String> {
    let normalized = normalize_app_id(&app_id);
    let meta = get_app_meta(&normalized)?;
    let lnk = find_desktop_app_lnk(&normalized).ok_or(format!("未在桌面上找到「{}」的原生快捷方式", meta.display_name))?;
    let port = get_proxy_port();
    let proxy_arg = format!("--proxy-server=http://127.0.0.1:{} --proxy-bypass-list=<-loopback>;localhost;127.0.0.1;::1", port);

    // 读取当前参数并保存备份
    let read_script = format!(
        "$sh = New-Object -ComObject WScript.Shell; $sc = $sh.CreateShortcut('{}'); $sc.Arguments",
        lnk.to_string_lossy().replace('\'', "''")
    );
    let current_args = run_powershell(&read_script).unwrap_or_default();

    if !current_args.contains("--proxy-server") {
        let mut backups = load_backups();
        backups.insert(
            app_id.clone(),
            ShortcutBackup {
                file_path: lnk.to_string_lossy().to_string(),
                original_arguments: current_args.clone(),
            },
        );
        save_backups(&backups);
    }

    // 组合新参数
    let new_args = if current_args.contains("--proxy-server") {
        let cleaned = current_args
            .split_whitespace()
            .filter(|a| !a.starts_with("--proxy-server") && !a.starts_with("--proxy-bypass-list"))
            .collect::<Vec<&str>>()
            .join(" ");
        if cleaned.is_empty() {
            proxy_arg
        } else {
            format!("{} {}", cleaned, proxy_arg)
        }
    } else if current_args.trim().is_empty() {
        proxy_arg
    } else {
        format!("{} {}", current_args.trim(), proxy_arg)
    };

    let patch_script = format!(
        "$sh = New-Object -ComObject WScript.Shell; $sc = $sh.CreateShortcut('{}'); $sc.Arguments = '{}'; $sc.Save()",
        lnk.to_string_lossy().replace('\'', "''"),
        new_args.replace('\'', "''")
    );
    run_powershell(&patch_script)?;

    if normalized == "chatgpt" {
        crate::commands::app_launcher::ensure_loopback_exempt("OpenAI.Codex_2p2nqsd0c76g0");
    }

    Ok(format!("已成功优化桌面快捷方式「{}」，代理参数已注入生效", lnk.file_name().unwrap_or_default().to_string_lossy()))
}

/// 兼容旧版：优化 ChatGPT 桌面快捷方式
#[tauri::command]
pub fn patch_existing_shortcut() -> Result<String, String> {
    patch_app_shortcut("chatgpt".to_string())
}

/// 通用：还原桌面现有快捷方式
#[tauri::command]
pub fn restore_app_shortcut(app_id: String) -> Result<String, String> {
    let normalized = normalize_app_id(&app_id);
    let meta = get_app_meta(&normalized)?;
    let lnk = find_desktop_app_lnk(&normalized).ok_or(format!("未在桌面上找到「{}」的快捷方式", meta.display_name))?;

    let mut backups = load_backups();
    let target_args = if let Some(backup) = backups.remove(&normalized) {
        save_backups(&backups);
        backup.original_arguments
    } else {
        let read_script = format!(
            "$sh = New-Object -ComObject WScript.Shell; $sc = $sh.CreateShortcut('{}'); $sc.Arguments",
            lnk.to_string_lossy().replace('\'', "''")
        );
        let current_args = run_powershell(&read_script).unwrap_or_default();
        current_args
            .split_whitespace()
            .filter(|a| !a.starts_with("--proxy-server") && !a.starts_with("--proxy-bypass-list"))
            .collect::<Vec<&str>>()
            .join(" ")
    };

    let restore_script = format!(
        "$sh = New-Object -ComObject WScript.Shell; $sc = $sh.CreateShortcut('{}'); $sc.Arguments = '{}'; $sc.Save()",
        lnk.to_string_lossy().replace('\'', "''"),
        target_args.replace('\'', "''")
    );
    run_powershell(&restore_script)?;

    Ok(format!("已还原桌面快捷方式「{}」为纯净原生状态", lnk.file_name().unwrap_or_default().to_string_lossy()))
}

/// 兼容旧版：还原 ChatGPT 快捷方式
#[tauri::command]
pub fn restore_existing_shortcut() -> Result<String, String> {
    restore_app_shortcut("chatgpt".to_string())
}

/// 通用：创建专属加速快捷方式
#[tauri::command]
pub fn create_dedicated_app_shortcut(app_id: String) -> Result<String, String> {
    let normalized = normalize_app_id(&app_id);
    let meta = get_app_meta(&normalized)?;
    let desktop = get_user_desktop_dir().ok_or("无法定位用户桌面目录")?;
    let target_lnk = desktop.join(meta.dedicated_name);
    let port = get_proxy_port();
    let proxy_args = format!("--proxy-server=http://127.0.0.1:{} --proxy-bypass-list=<-loopback>;localhost;127.0.0.1;::1", port);

    if let Some(exe_path) = crate::commands::app_launcher::find_app_executable(&normalized) {
        let parent = exe_path.parent().unwrap_or(&exe_path);
        let script = format!(
            "$sh = New-Object -ComObject WScript.Shell; $sc = $sh.CreateShortcut('{}'); $sc.TargetPath = '{}'; $sc.Arguments = '{}'; $sc.WorkingDirectory = '{}'; $sc.IconLocation = '{},0'; $sc.Description = '{} 专属应用层加速快捷方式 (由 ProcWeaver 生成)'; $sc.Save()",
            target_lnk.to_string_lossy().replace('\'', "''"),
            exe_path.to_string_lossy().replace('\'', "''"),
            proxy_args.replace('\'', "''"),
            parent.to_string_lossy().replace('\'', "''"),
            exe_path.to_string_lossy().replace('\'', "''"),
            meta.display_name
        );
        run_powershell(&script)?;
    } else if normalized == "chatgpt" {
        let current_exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let parent = current_exe.parent().unwrap_or(&current_exe);
        let script = format!(
            "$sh = New-Object -ComObject WScript.Shell; $sc = $sh.CreateShortcut('{}'); $sc.TargetPath = '{}'; $sc.Arguments = '--launch chatgpt'; $sc.WorkingDirectory = '{}'; $sc.IconLocation = '{},0'; $sc.Description = 'ChatGPT 专属应用层加速快捷方式 (由 ProcWeaver 生成)'; $sc.Save()",
            target_lnk.to_string_lossy().replace('\'', "''"),
            current_exe.to_string_lossy().replace('\'', "''"),
            parent.to_string_lossy().replace('\'', "''"),
            current_exe.to_string_lossy().replace('\'', "''")
        );
        run_powershell(&script)?;
    } else {
        return Err(format!("未检测到「{}」的安装路径，无法生成专属快捷方式", meta.display_name));
    }

    if normalized == "chatgpt" {
        crate::commands::app_launcher::ensure_loopback_exempt("OpenAI.Codex_2p2nqsd0c76g0");
    }

    Ok(format!("已成功在桌面生成「{}」专属快捷方式！", meta.dedicated_name))
}

/// 兼容旧版：创建 ChatGPT 专属快捷方式
#[tauri::command]
pub fn create_dedicated_shortcut() -> Result<String, String> {
    create_dedicated_app_shortcut("chatgpt".to_string())
}

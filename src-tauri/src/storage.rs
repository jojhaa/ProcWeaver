use std::{fs, path::{Path, PathBuf}, sync::OnceLock};
use tauri::Manager;

static DATA: OnceLock<PathBuf> = OnceLock::new();
static RESOURCES: OnceLock<PathBuf> = OnceLock::new();

#[cfg(test)]
pub(crate) fn initialize_test(data: PathBuf, resources: PathBuf) {
    let _ = fs::create_dir_all(data.join("config"));
    let _ = fs::create_dir_all(data.join("core_data"));
    let target_core_data = data.join("core_data");
    let core_data_sources = [
        resources.join("defaults/core_data"),
        resources.join("src-tauri/defaults/core_data"),
        resources.join("core_data"),
    ];
    for src in &core_data_sources {
        if src.exists() {
            let _ = copy_dir_recursive(src, &target_core_data);
            break;
        }
    }
    let _ = DATA.set(data);
    let _ = RESOURCES.set(resources);
}

fn resolve_resources(app: &tauri::App) -> PathBuf {
    if cfg!(debug_assertions) {
        return PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf();
    }

    // 1. 优先检查 Tauri 原生资源目录
    if let Ok(dir) = app.path().resource_dir() {
        if dir.join("binaries/mihomo-compatible.exe").exists() || dir.join("binaries/mihomo-v3.exe").exists() {
            return dir;
        }
    }

    // 2. 检查当前运行的可执行文件同级目录 (绿色免安装 / Portable)
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            if parent.join("binaries/mihomo-compatible.exe").exists() || parent.join("binaries/mihomo-v3.exe").exists() {
                return parent.to_path_buf();
            }

            // 3. 向上逐级回溯寻找包含 binaries 的目录 (例如在 target/release/ 下直接运行时，回溯至工程根目录)
            let mut curr = parent;
            while let Some(up) = curr.parent() {
                if up.join("binaries/mihomo-compatible.exe").exists() || up.join("binaries/mihomo-v3.exe").exists() {
                    return up.to_path_buf();
                }
                curr = up;
            }
        }
    }

    app.path().resource_dir().unwrap_or_else(|_| PathBuf::from("."))
}

pub fn initialize(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let resources = resolve_resources(app);
    
    // 智能判定运行模式：
    // 1. 若可执行文件同级存在 "data" 目录或 "portable" 标记文件，启用纯净绿色便携模式 (数据就地自包含存放)
    // 2. 否则使用 Windows 官方标准独立数据目录: AppData/Local/com.procweaver.desktop
    let mut is_portable = false;
    let mut portable_data_dir = None;
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let data_candidate = parent.join("data");
            let marker_candidate = parent.join("portable");
            if data_candidate.exists() || marker_candidate.exists() {
                is_portable = true;
                portable_data_dir = Some(data_candidate);
            }
        }
    }

    let data = if is_portable {
        portable_data_dir.unwrap()
    } else if cfg!(debug_assertions) {
        resources.clone()
    } else {
        app.path().app_local_data_dir()?
    };
    
    initialize_data(&resources, &data)?;

    DATA.set(data).map_err(|_| "数据路径重复初始化")?;
    RESOURCES.set(resources).map_err(|_| "资源路径重复初始化")?;
    Ok(())
}

fn initialize_data(resources: &Path, data: &Path) -> std::io::Result<()> {
    fs::create_dir_all(data.join("config"))?;
    fs::create_dir_all(data.join("core_data"))?;

    // 仅补齐缺失资源，升级不覆盖用户更新过的规则。复制失败必须中止初始化。
    let target_core_data = data.join("core_data");
    let core_data_sources = [
        resources.join("defaults/core_data"),
        resources.join("src-tauri/defaults/core_data"),
        resources.join("core_data"),
    ];
    for src in &core_data_sources {
        if src.exists() {
            copy_dir_recursive(src, &target_core_data)?;
            break;
        }
    }
    let asn = target_core_data.join("ASN.mmdb");
    let canonical_asn = target_core_data.join("GeoLite2-ASN.mmdb");
    if canonical_asn.is_file() && !asn.exists() { copy_missing_file(&canonical_asn, &asn)?; }
    else if asn.is_file() && !canonical_asn.exists() { copy_missing_file(&asn, &canonical_asn)?; }

    // 准备纯净官方默认配置文件 default.yaml (绝不携带任何测试节点或私人订阅，纯净开箱即用)
    let target = data.join("config/default.yaml");
    if !target.exists() {
        let candidates = [
            resources.join("defaults/default.yaml"),
            resources.join("src-tauri/defaults/default.yaml"),
            resources.join("config/default.yaml"),
        ];
        let mut copied = false;
        for source in &candidates {
            if source.exists() {
                copy_missing_file(source, &target)?;
                copied = true;
                break;
            }
        }
        if !copied && !target.exists() {
            let minimal_default = "mixed-port: 7890\nallow-lan: false\nmode: rule\nlog-level: info\nexternal-controller: 127.0.0.1:9090\nsecret: ''\nproxies: []\nproxy-groups: []\nrules:\n  - MATCH,DIRECT\n";
            write_missing_file(&target, minimal_default.as_bytes())?;
        }
    }

    Ok(())
}

fn write_missing_file(target: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut file = match fs::OpenOptions::new().write(true).create_new(true).open(target) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists && target.is_file() => return Ok(()),
        Err(error) => return Err(error),
    };
    let result = file.write_all(bytes).and_then(|_| file.sync_all());
    drop(file);
    if result.is_err() { let _ = fs::remove_file(target); }
    result
}
fn copy_missing_file(source: &Path, target: &Path) -> std::io::Result<()> {
    if target.is_file() { return Ok(()); }
    write_missing_file(target, &fs::read(source)?)
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    if !src.exists() {
        return Ok(());
    }
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if ty.is_symlink() { return Err(std::io::Error::other("默认资源不允许符号链接")); }
        if ty.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else {
            copy_missing_file(&from, &to)?;
        }
    }
    Ok(())
}


pub fn try_data_dir() -> Option<PathBuf> {
    DATA.get().cloned()
}

pub fn data_dir() -> PathBuf {
    DATA.get().cloned().unwrap_or_else(|| {
        #[cfg(test)]
        {
            std::env::temp_dir().join("netbox-test-data")
        }
        #[cfg(not(test))]
        {
            panic!("应用路径尚未初始化")
        }
    })
}
pub fn resource_dir() -> PathBuf {
    RESOURCES.get().expect("应用路径尚未初始化").clone()
}

/// 同目录原子替换，不先删除有效文件；调用方串行化同一路径写入。
pub(crate) fn replace_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    fs::create_dir_all(path.parent().ok_or("文件缺少父目录")?).map_err(|e| e.to_string())?;
    let mut candidate_name = path.as_os_str().to_owned(); candidate_name.push(".procweaver-new");
    let candidate = PathBuf::from(candidate_name);
    let result = (|| {
        let mut file = fs::File::create(&candidate).map_err(|e| e.to_string())?;
        file.write_all(bytes).and_then(|_| file.sync_all()).map_err(|e| e.to_string())?;
        drop(file);
        if path.exists() {
            let mut backup_name = path.as_os_str().to_owned(); backup_name.push(".procweaver-backup");
            let backup = PathBuf::from(backup_name);
            fs::copy(path, &backup).map_err(|e| e.to_string())?;
            if fs::read(path).map_err(|e| e.to_string())? != fs::read(&backup).map_err(|e| e.to_string())? { return Err("备份校验失败".into()); }
        }
        fs::rename(&candidate, path).map_err(|e| format!("原子替换失败，旧文件保持不变：{e}"))
    })();
    if result.is_err() { let _ = fs::remove_file(candidate); }
    result
}

/// 同目录候选文件；替换失败恢复原文件，保留上一版本供回滚。
pub fn replace(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("文件缺少父目录")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let candidate = path.with_extension("procweaver-new");
    let backup = path.with_extension("procweaver-backup");
    fs::write(&candidate, bytes).map_err(|e| e.to_string())?;
    if path.exists() {
        fs::copy(path, &backup).map_err(|e| e.to_string())?;
        if fs::read(path).map_err(|e| e.to_string())? != fs::read(&backup).map_err(|e| e.to_string())? {
            return Err("备份校验失败".into());
        }
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    if let Err(e) = fs::rename(&candidate, path) {
        if backup.exists() { fs::copy(&backup, path).map_err(|restore| format!("替换失败：{e}；恢复失败：{restore}"))?; }
        return Err(format!("替换失败，已恢复旧文件：{e}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn bootstrap_fixture(name: &str) -> PathBuf {
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!("procweaver-bootstrap-{name}-{}-{stamp}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        root
    }
    fn assert_seed_copied(source: &Path, target: &Path) {
        for entry in fs::read_dir(source).unwrap() {
            let entry = entry.unwrap();
            let dest = target.join(entry.file_name());
            if entry.file_type().unwrap().is_dir() { assert_seed_copied(&entry.path(), &dest); }
            else { assert_eq!(fs::read(entry.path()).unwrap(), fs::read(dest).unwrap()); }
        }
    }
    #[test]
    fn bootstrap_copies_packaged_rules_and_preserves_user_data() {
        let root = bootstrap_fixture("seed");
        let resources = if let Some(path) = std::env::var_os("PROCWEAVER_RELEASE_FIXTURE") {
            PathBuf::from(path)
        } else {
            let path = root.join("resources");
            fs::create_dir_all(path.join("defaults/core_data/ruleset/local-plan")).unwrap();
            fs::write(path.join("defaults/core_data/ASN.mmdb"), b"fixture-asn").unwrap();
            fs::write(path.join("defaults/core_data/ruleset/local-plan/test.yaml"), b"payload: [example.com]").unwrap();
            fs::write(path.join("defaults/default.yaml"), b"rules: [MATCH,DIRECT]").unwrap();
            path
        };
        let data = root.join("installed-data");
        initialize_data(&resources, &data).unwrap();
        assert_seed_copied(&resources.join("defaults/core_data"), &data.join("core_data"));
        assert_eq!(fs::read(data.join("core_data/ASN.mmdb")).unwrap(), fs::read(data.join("core_data/GeoLite2-ASN.mmdb")).unwrap());
        let config = data.join("config/default.yaml");
        fs::write(&config, b"existing-user-config").unwrap();
        fs::write(data.join("core_data/ASN.mmdb"), b"user-updated-asn").unwrap();
        fs::write(data.join("core_data/cache.db"), b"user-cache").unwrap();
        initialize_data(&resources, &data).unwrap();
        assert_eq!(fs::read(&config).unwrap(), b"existing-user-config");
        assert_eq!(fs::read(data.join("core_data/ASN.mmdb")).unwrap(), b"user-updated-asn");
        assert_eq!(fs::read(data.join("core_data/cache.db")).unwrap(), b"user-cache");
        // 便携包直接预置 data；没有 defaults 时仍保留全部预置规则。
        let portable = root.join("portable");
        fs::create_dir_all(&portable).unwrap();
        let portable_data = portable.join("data");
        copy_dir_recursive(&resources.join("defaults/core_data"), &portable_data.join("core_data")).unwrap();
        initialize_data(&portable, &portable_data).unwrap();
        assert_seed_copied(&resources.join("defaults/core_data"), &portable_data.join("core_data"));
        assert!(portable_data.join("config/default.yaml").is_file());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn bootstrap_reports_blocked_seed_destination() {
        let root = bootstrap_fixture("blocked");
        let resources = root.join("resources");
        let data = root.join("data");
        fs::create_dir_all(resources.join("defaults/core_data")).unwrap();
        fs::write(resources.join("defaults/core_data/geoip.dat"), b"seed").unwrap();
        fs::create_dir_all(data.join("core_data/geoip.dat")).unwrap();
        assert!(initialize_data(&resources, &data).is_err());
        assert!(data.join("core_data/geoip.dat").is_dir());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn atomic_replacement_preserves_old_file_on_failure() {
        let dir = std::env::temp_dir().join(format!("procweaver-atomic-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("geo.dat");
        fs::write(&path, b"valid-old").unwrap();
        replace_atomic(&path, b"valid-new").unwrap();
        assert_eq!(fs::read(dir.join("geo.dat.procweaver-backup")).unwrap(), b"valid-old");
        #[cfg(windows)] {
            use std::os::windows::fs::OpenOptionsExt;
            let held = fs::OpenOptions::new().read(true).share_mode(1).open(&path).unwrap();
            assert!(replace_atomic(&path, b"rejected").is_err());
            assert_eq!(fs::read(&path).unwrap(), b"valid-new");
            drop(held);
        }
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn replacement_retains_verified_previous_version() {
        let dir = std::env::temp_dir().join(format!("procweaver-storage-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("profile.yaml");
        fs::write(&path, b"old subscription").unwrap();
        replace(&path, b"new subscription").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"new subscription");
        assert_eq!(fs::read(path.with_extension("procweaver-backup")).unwrap(), b"old subscription");
        fs::remove_dir_all(dir).unwrap();
    }
}

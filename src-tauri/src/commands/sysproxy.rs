#[cfg(windows)]
mod windows {
    use serde::{Deserialize, Serialize};
    use std::{path::Path, sync::Mutex};
    use winreg::{enums::*, types::ToRegValue, RegKey, RegValue};

    const NAMES: [&str; 3] = ["ProxyServer", "ProxyOverride", "ProxyEnable"];
    const BYPASS: &str = "<-loopback>;<local>;localhost;10.*;172.16.*;172.17.*;172.18.*;172.19.*;172.20.*;172.21.*;172.22.*;172.23.*;172.24.*;172.25.*;172.26.*;172.27.*;172.28.*;172.29.*;172.30.*;172.31.*;192.168.*";
    static OWNED: Mutex<Option<Recovery>> = Mutex::new(None);

    #[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
    struct Raw { bytes: Vec<u8>, kind: u32 }
    impl Raw {
        fn from(value: RegValue) -> Self { Self { bytes: value.bytes, kind: value.vtype as u32 } }
        fn value(&self) -> Result<RegValue, String> {
            let kinds = [REG_NONE, REG_SZ, REG_EXPAND_SZ, REG_BINARY, REG_DWORD, REG_DWORD_BIG_ENDIAN,
                REG_LINK, REG_MULTI_SZ, REG_RESOURCE_LIST, REG_FULL_RESOURCE_DESCRIPTOR, REG_RESOURCE_REQUIREMENTS_LIST, REG_QWORD];
            Ok(RegValue { bytes: self.bytes.clone(), vtype: kinds.get(self.kind as usize).ok_or("代理恢复记录类型无效")?.clone() })
        }
    }
    #[derive(Clone, Serialize, Deserialize)]
    struct Recovery {
        owner_pid: u32,
        owner_created: u64,
        port: u16,
        original: [Option<Raw>; 3],
        expected: [Option<Raw>; 3],
    }
    trait Registry {
        fn read(&self, name: &str) -> Result<Option<Raw>, String>;
        fn write(&self, name: &str, value: &Option<Raw>) -> Result<(), String>;
    }
    impl Registry for RegKey {
        fn read(&self, name: &str) -> Result<Option<Raw>, String> {
            match self.get_raw_value(name) {
                Ok(v) => Ok(Some(Raw::from(v))),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
                Err(_) => Err("读取系统代理失败".into()),
            }
        }
        fn write(&self, name: &str, value: &Option<Raw>) -> Result<(), String> {
            let result = match value { Some(v) => self.set_raw_value(name, &v.value()?), None => self.delete_value(name) };
            match result {
                Ok(()) => Ok(()),
                Err(e) if value.is_none() && e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(_) => Err("写入系统代理失败".into()),
            }
        }
    }
    fn key() -> Result<RegKey, String> {
        RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags(
            r"Software\Microsoft\Windows\CurrentVersion\Internet Settings", KEY_READ | KEY_WRITE)
            .map_err(|_| "打开系统代理设置失败".into())
    }
    fn snapshot(reg: &impl Registry) -> Result<[Option<Raw>; 3], String> {
        Ok([reg.read(NAMES[0])?, reg.read(NAMES[1])?, reg.read(NAMES[2])?])
    }
    fn path() -> std::path::PathBuf { crate::storage::data_dir().join("config/system-proxy-recovery.json") }
    fn save(path: &Path, record: &Recovery) -> Result<(), String> {
        crate::storage::replace_atomic(path, &serde_json::to_vec(record).map_err(|_| "生成代理恢复记录失败")?)
            .map_err(|_| "持久化代理恢复记录失败，未接管系统代理".into())
    }
    fn clear(path: &Path) -> Result<(), String> {
        match std::fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err("清理代理恢复记录失败".into()),
        }
    }
    // 服务器所有权已转移时放弃恢复；仍自有时只恢复未被外部修改的字段。
    // 接受已恢复的字段，使部分恢复失败后可重试。
    fn restore(reg: &impl Registry, record: &Recovery) -> Result<(), String> {
        let current = snapshot(reg)?;
        if current[0] != record.expected[0] && current[0] != record.original[0] { return Ok(()); }
        for i in (0..3).rev() {
            if current[i] == record.expected[i] { reg.write(NAMES[i], &record.original[i])?; }
        }
        Ok(())
    }
    fn process_created(pid: u32) -> Result<Option<u64>, String> {
        use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
        use windows_sys::Win32::{Foundation::FILETIME, System::Threading::*};
        unsafe {
            let raw = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | 0x00100000, 0, pid);
            if raw.is_null() {
                return if std::io::Error::last_os_error().raw_os_error() == Some(87) { Ok(None) }
                    else { Err("无法确认原代理宿主状态，保留恢复记录".into()) };
            }
            let handle = OwnedHandle::from_raw_handle(raw);
            if WaitForSingleObject(handle.as_raw_handle(), 0) == 0 { return Ok(None); }
            let mut created: FILETIME = std::mem::zeroed();
            let mut exit = std::mem::zeroed(); let mut kernel = std::mem::zeroed(); let mut user = std::mem::zeroed();
            if GetProcessTimes(handle.as_raw_handle(), &mut created, &mut exit, &mut kernel, &mut user) == 0 { return Err("读取原代理宿主标识失败".into()); }
            Ok(Some(((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64))
        }
    }
    fn recover_file(reg: &impl Registry, path: &Path) -> Result<(), String> {
        if !path.exists() { return Ok(()); }
        let record: Recovery = serde_json::from_slice(&std::fs::read(&path).map_err(|_| "读取代理恢复记录失败")?)
            .map_err(|_| "代理恢复记录损坏，未修改系统代理")?;
        if process_created(record.owner_pid)? == Some(record.owner_created) { return Ok(()); }
        // 原宿主已消失，但端口可能由尚未退出的核心或其他软件占用，暂缓恢复。
        if std::net::TcpStream::connect_timeout(&([127, 0, 0, 1], record.port).into(), std::time::Duration::from_millis(200)).is_ok() { return Ok(()); }
        restore(reg, &record)?;
        sync_connection_settings(false, 7890);
        refresh_system_proxy_cache();
        clear(path)
    }
    pub(super) fn recover() -> Result<(), String> {
        let _guard = OWNED.lock().map_err(|_| "代理状态锁不可用")?;
        let path = path();
        if !path.exists() { return Ok(()); }
        recover_file(&key()?, &path)
    }
    #[link(name = "wininet")]
    extern "system" {
        fn InternetSetOptionW(
            h_internet: *mut std::ffi::c_void,
            dw_option: u32,
            lp_buffer: *mut std::ffi::c_void,
            dw_buffer_length: u32,
        ) -> i32;
    }

    pub(crate) fn refresh_system_proxy_cache() {
        const INTERNET_OPTION_SETTINGS_CHANGED: u32 = 39;
        const INTERNET_OPTION_REFRESH: u32 = 37;
        unsafe {
            InternetSetOptionW(std::ptr::null_mut(), INTERNET_OPTION_SETTINGS_CHANGED, std::ptr::null_mut(), 0);
            InternetSetOptionW(std::ptr::null_mut(), INTERNET_OPTION_REFRESH, std::ptr::null_mut(), 0);
        }
    }

    fn pack_connection_settings(enable: bool, server: &str, bypass: &str) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(64 + server.len() + bypass.len());
        bytes.extend_from_slice(&[0x46, 0x00, 0x00, 0x00]); // 头部标志 (magic version)
        bytes.extend_from_slice(&[0x01, 0x00, 0x00, 0x00]); // counter 计数器
        let flags: u32 = if enable { 0x03 } else { 0x01 }; // flags: 0x01(auto) | 0x02(manual proxy)
        bytes.extend_from_slice(&flags.to_le_bytes());

        if enable && !server.is_empty() {
            bytes.extend_from_slice(&(server.len() as u32).to_le_bytes());
            bytes.extend_from_slice(server.as_bytes());
        } else {
            bytes.extend_from_slice(&0u32.to_le_bytes());
        }

        if enable && !bypass.is_empty() {
            bytes.extend_from_slice(&(bypass.len() as u32).to_le_bytes());
            bytes.extend_from_slice(bypass.as_bytes());
        } else {
            bytes.extend_from_slice(&0u32.to_le_bytes());
        }

        bytes.extend_from_slice(&0u32.to_le_bytes()); // PAC url 长度
        bytes.extend_from_slice(&[0u8; 32]); // 32 字节保留位
        bytes
    }

    fn sync_connection_settings(enable: bool, port: u16) {
        if let Ok(hkcu) = RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags(
            r"Software\Microsoft\Windows\CurrentVersion\Internet Settings\Connections",
            KEY_READ | KEY_WRITE,
        ) {
            let server = format!("127.0.0.1:{}", port);
            let binary = pack_connection_settings(enable, &server, BYPASS);
            let reg_val = RegValue {
                bytes: binary,
                vtype: REG_BINARY,
            };
            let _ = hkcu.set_raw_value("DefaultConnectionSettings", &reg_val);
            let _ = hkcu.set_raw_value("SavedLegacySettings", &reg_val);
        }
    }

    fn sync_user_env_proxy(enable: bool, port: u16) {
        if let Ok(env_key) = RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags(
            r"Environment",
            KEY_READ | KEY_WRITE,
        ) {
            let proxy_url = format!("http://127.0.0.1:{}", port);
            if enable {
                let _ = env_key.set_value("HTTP_PROXY", &proxy_url);
                let _ = env_key.set_value("HTTPS_PROXY", &proxy_url);
                let _ = env_key.set_value("ALL_PROXY", &proxy_url);
                let _ = env_key.set_value("http_proxy", &proxy_url);
                let _ = env_key.set_value("https_proxy", &proxy_url);
                let _ = env_key.set_value("all_proxy", &proxy_url);
                let _ = env_key.set_value("NODE_USE_ENV_PROXY", &"1");
                let _ = env_key.set_value("NO_PROXY", &"localhost,127.0.0.1,::1");
            } else {
                let _ = env_key.delete_value("HTTP_PROXY");
                let _ = env_key.delete_value("HTTPS_PROXY");
                let _ = env_key.delete_value("ALL_PROXY");
                let _ = env_key.delete_value("http_proxy");
                let _ = env_key.delete_value("https_proxy");
                let _ = env_key.delete_value("all_proxy");
                let _ = env_key.delete_value("NODE_USE_ENV_PROXY");
                let _ = env_key.delete_value("NO_PROXY");
            }
        }
        if enable {
            crate::commands::app_launcher::ensure_loopback_exempt("OpenAI.Codex_2p2nqsd0c76g0");
        }
    }

    pub(super) fn set(enable: bool, port: Option<u16>) -> Result<bool, String> {
        let mut owned = OWNED.lock().map_err(|_| "代理状态锁不可用")?;
        if !enable && owned.is_none() { return Ok(false); }
        let reg = key()?;
        if !enable {
            restore(&reg, owned.as_ref().unwrap())?;
            sync_connection_settings(false, 7890);
            sync_user_env_proxy(false, 7890);
            refresh_system_proxy_cache();
            clear(&path())?;
            *owned = None;
            return Ok(false);
        }
        let port = port.unwrap_or(7890);
        if port == 0 { return Err("代理端口不能为零".into()); }
        if let Some(record) = owned.as_ref() {
            if port == record.port && snapshot(&reg)? == record.expected { return Ok(true); }
            // 换端口先完成旧事务，避免崩溃时磁盘记录与旧 ProxyServer 不一致。
            restore(&reg, record)?;
            clear(&path())?;
            *owned = None;
        }
        let original = snapshot(&reg)?;
        if owned.is_none() && path().exists() { return Err("存在未处理的代理恢复记录，请在原核心退出后重新启动应用".into()); }
        let record = Recovery {
            owner_pid: std::process::id(), owner_created: process_created(std::process::id())?.ok_or("当前进程已退出")?, port, original,
            expected: [Some(Raw::from(format!("127.0.0.1:{port}").to_reg_value())), Some(Raw::from(BYPASS.to_reg_value())), Some(Raw::from(1u32.to_reg_value()))],
        };
        save(&path(), &record)?;
        *owned = Some(record.clone());
        for i in 0..3 {
            if let Err(error) = reg.write(NAMES[i], &record.expected[i]) {
                restore(&reg, &record)?; clear(&path())?; *owned = None;
                return Err(error);
            }
        }
        sync_connection_settings(true, port);
        sync_user_env_proxy(true, port);
        refresh_system_proxy_cache();
        Ok(true)
    }
    pub(super) fn status() -> Result<bool, String> {
        let owned = OWNED.lock().map_err(|_| "代理状态锁不可用")?;
        match owned.as_ref() { Some(record) => Ok(snapshot(&key()?)? == record.expected), None => Ok(false) }
    }

    pub(super) fn reset_emergency() -> Result<(), String> {
        if let Ok(reg) = key() {
            let _ = reg.set_value("ProxyEnable", &0u32);
        }
        sync_connection_settings(false, 7890);
        sync_user_env_proxy(false, 7890);
        refresh_system_proxy_cache();
        let _ = std::fs::remove_file(path());
        if let Ok(mut owned) = OWNED.lock() {
            *owned = None;
        }
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::cell::RefCell;
        struct Fake(RefCell<[Option<Raw>; 3]>);
        impl Registry for Fake {
            fn read(&self, name: &str) -> Result<Option<Raw>, String> { Ok(self.0.borrow()[NAMES.iter().position(|n| *n == name).unwrap()].clone()) }
            fn write(&self, name: &str, value: &Option<Raw>) -> Result<(), String> { self.0.borrow_mut()[NAMES.iter().position(|n| *n == name).unwrap()] = value.clone(); Ok(()) }
        }
        #[test]
        fn crash_record_roundtrip_restore_idempotent_and_preserve_external_changes() {
            let record = Recovery { owner_pid: 42, owner_created: 7, port: 7890,
                original: [Some(Raw::from("old:8080".to_reg_value())), None, Some(Raw::from(0u32.to_reg_value()))],
                expected: [Some(Raw::from("127.0.0.1:7890".to_reg_value())), Some(Raw::from(BYPASS.to_reg_value())), Some(Raw::from(1u32.to_reg_value()))] };
            let root = std::env::temp_dir().join(format!("netbox-proxy-recovery-{}", std::process::id()));
            let file = root.join("recovery.json"); save(&file, &record).unwrap();
            let loaded: Recovery = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
            let reg = Fake(RefCell::new(record.expected.clone()));
            restore(&reg, &loaded).unwrap(); assert_eq!(*reg.0.borrow(), record.original);
            restore(&reg, &loaded).unwrap();
            *reg.0.borrow_mut() = record.expected.clone();
            reg.0.borrow_mut()[1] = Some(Raw::from("external-bypass".to_reg_value()));
            let mut expected = record.original.clone(); expected[1] = reg.0.borrow()[1].clone();
            restore(&reg, &loaded).unwrap(); assert_eq!(*reg.0.borrow(), expected);
            *reg.0.borrow_mut() = record.expected.clone();
            reg.0.borrow_mut()[0] = Some(Raw::from("other-proxy:8888".to_reg_value()));
            let external = reg.0.borrow().clone();
            restore(&reg, &loaded).unwrap(); assert_eq!(*reg.0.borrow(), external);
            *reg.0.borrow_mut() = record.expected.clone(); reg.0.borrow_mut()[2] = record.original[2].clone();
            restore(&reg, &loaded).unwrap(); assert_eq!(*reg.0.borrow(), record.original);
            std::fs::remove_dir_all(root).unwrap();
        }

        #[test]
        fn isolated_windows_registry_restores_raw_types_and_missing_values() {
            let name = format!(r"Software\NetBox\Tests\ProxyRecovery-{}", std::process::id());
            let hkcu = RegKey::predef(HKEY_CURRENT_USER);
            let (reg, _) = hkcu.create_subkey(&name).unwrap();
            reg.set_value("ProxyServer", &"original:8080").unwrap();
            reg.set_value("ProxyEnable", &0u32).unwrap();
            let original = snapshot(&reg).unwrap();
            let record = Recovery { owner_pid: std::process::id(), owner_created: process_created(std::process::id()).unwrap().unwrap(), port: 7890, original: original.clone(),
                expected: [Some(Raw::from("127.0.0.1:7890".to_reg_value())), Some(Raw::from(BYPASS.to_reg_value())), Some(Raw::from(1u32.to_reg_value()))] };
            for i in 0..3 { reg.write(NAMES[i], &record.expected[i]).unwrap(); }
            restore(&reg, &record).unwrap();
            assert_eq!(snapshot(&reg).unwrap(), original);
            drop(reg);
            hkcu.delete_subkey_all(&name).unwrap();
        }

        #[test]
        fn recovery_waits_for_owner_and_port_then_restores_after_owner_is_killed() {
            use std::os::windows::process::CommandExt;
            let mut owner = std::process::Command::new("pwsh").args(["-NoProfile", "-Command", "Start-Sleep -Seconds 30"])
                .creation_flags(0x08000000).spawn().unwrap();
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let record = Recovery { owner_pid: owner.id(), owner_created: process_created(owner.id()).unwrap().unwrap(), port: listener.local_addr().unwrap().port(),
                original: [None, None, None], expected: [Some(Raw::from("127.0.0.1:7890".to_reg_value())), Some(Raw::from(BYPASS.to_reg_value())), Some(Raw::from(1u32.to_reg_value()))] };
            let root = std::env::temp_dir().join(format!("netbox-proxy-crash-{}", std::process::id()));
            let file = root.join("recovery.json"); save(&file, &record).unwrap();
            let reg = Fake(RefCell::new(record.expected.clone()));
            recover_file(&reg, &file).unwrap(); assert!(file.exists());
            owner.kill().unwrap(); owner.wait().unwrap();
            recover_file(&reg, &file).unwrap(); assert!(file.exists());
            drop(listener);
            recover_file(&reg, &file).unwrap(); assert!(!file.exists());
            assert_eq!(*reg.0.borrow(), record.original);
            recover_file(&reg, &file).unwrap();
            std::fs::remove_dir_all(root).unwrap();
        }
    }
}

pub fn recover_stale_proxy() -> Result<(), String> {
    #[cfg(windows)] { windows::recover()?; }
    Ok(())
}
pub fn set_system_proxy_raw(enable: bool, port: Option<u16>) -> Result<bool, String> {
    #[cfg(windows)] { windows::set(enable, port) }
    #[cfg(not(windows))] { let _ = port; Ok(enable) }
}

/// 生命周期事务内部使用，不重复获取 LIFECYCLE。
pub(crate) async fn set_system_proxy_locked(enable: bool, port: Option<u16>) -> Result<bool, String> {
    crate::routing_overrides::change_system_proxy(enable, || set_system_proxy_raw(enable, port)).await
}
#[tauri::command]
pub async fn set_system_proxy(app: tauri::AppHandle, enable: bool, port: Option<u16>) -> Result<bool, String> {
    let _lock = super::process::LIFECYCLE.lock().await;
    let res = set_system_proxy_locked(enable, port).await?;
    crate::app_lifecycle::notify_sysproxy_changed(&app, res);
    Ok(res)
}
#[tauri::command]
pub fn get_system_proxy_status() -> Result<bool, String> {
    #[cfg(windows)] { windows::status() }
    #[cfg(not(windows))] { Ok(false) }
}

pub fn reset_system_proxy_emergency() -> Result<(), String> {
    #[cfg(windows)] { windows::reset_emergency()?; }
    Ok(())
}

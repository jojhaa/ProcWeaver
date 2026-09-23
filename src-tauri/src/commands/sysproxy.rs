use serde::{Deserialize, Serialize};
use std::sync::Mutex;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProxyChange { pub timestamp: u64, pub state: String, pub reason: String }

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SystemProxyStatus {
    pub state: String,
    pub bypass_changed: bool,
    pub message: String,
    pub last_change: Option<ProxyChange>,
}
impl SystemProxyStatus {
    pub fn enabled(&self) -> bool { self.state == "enabled" }
}
static LAST_OBSERVED: Mutex<Option<SystemProxyStatus>> = Mutex::new(None);

pub fn system_proxy_snapshot() -> SystemProxyStatus {
    #[cfg(windows)] let result = windows::status();
    #[cfg(not(windows))] let result: Result<SystemProxyStatus, String> = Ok(SystemProxyStatus {
        state: "disabled".into(), bypass_changed: false, message: String::new(), last_change: None,
    });
    let mut status = result.unwrap_or_else(|error| SystemProxyStatus {
        state: "unknown".into(), bypass_changed: false, message: error, last_change: None,
    });
    if let Ok(previous) = LAST_OBSERVED.lock() {
        status.last_change = previous.as_ref().and_then(|s| s.last_change.clone());
    }
    status
}

/// Only lifecycle actions and the background observer record changes; reads never write settings.
pub(crate) fn observe_change(reason: Option<&str>) -> SystemProxyStatus {
    let mut status = system_proxy_snapshot();
    if let Ok(mut previous) = LAST_OBSERVED.lock() {
        let changed = previous.as_ref().is_none_or(|p| p.state != status.state || p.bypass_changed != status.bypass_changed);
        if changed || reason.is_some() {
            let reason = reason.unwrap_or(if previous.is_none() { "首次读取 Windows 实际代理状态" }
                else if status.state == "unknown" { "读取失败，保留现有分流，未执行关闭" }
                else { "检测到系统代理设置变化，来源未知（可能来自外部程序或系统设置）" });
            let event = ProxyChange {
                timestamp: std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64,
                state: status.state.clone(), reason: reason.into(),
            };
            status.last_change = Some(event.clone());
            let path = crate::storage::data_dir().join("config/system-proxy-events.json");
            let mut events: Vec<ProxyChange> = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
            events.push(event);
            if events.len() > 128 { events.drain(..events.len() - 128); }
            if let Err(error) = serde_json::to_vec(&events).map_err(|e| e.to_string())
                .and_then(|bytes| crate::storage::replace_atomic(&path, &bytes).map_err(|e| e.to_string())) {
                eprintln!("[系统代理] 写入状态变更日志失败: {error}");
            }
        }
        *previous = Some(status.clone());
    }
    status
}

#[cfg(windows)]
#[path = "sysproxy/native.rs"]
mod native;

#[cfg(windows)]
mod windows {
    use super::{native, SystemProxyStatus};
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
        #[serde(default)]
        original_native: Option<native::Settings>,
    }
    trait Registry {
        fn read(&self, name: &str) -> Result<Option<Raw>, String>;
        #[cfg(test)]
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
        #[cfg(test)]
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
    #[cfg(test)]
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
    fn recover_file(path: &Path, restore_native: impl FnOnce(&Recovery) -> Result<(), String>) -> Result<(), String> {
        if !path.exists() { return Ok(()); }
        let record: Recovery = serde_json::from_slice(&std::fs::read(path).map_err(|_| "读取代理恢复记录失败")?)
            .map_err(|_| "代理恢复记录损坏，未修改系统代理")?;
        if process_created(record.owner_pid)? == Some(record.owner_created) { return Ok(()); }
        if std::net::TcpStream::connect_timeout(&([127, 0, 0, 1], record.port).into(), std::time::Duration::from_millis(200)).is_ok() { return Ok(()); }
        restore_native(&record)?;
        clear(path)
    }
    pub(super) fn recover() -> Result<(), String> {
        let _guard = OWNED.lock().map_err(|_| "代理状态锁不可用")?;
        if !path().exists() { return Ok(()); }
        recover_file(&path(), restore_native)
    }

    fn same_endpoint(server: &str, port: u16) -> bool {
        let matches = |value: &str| {
            let value = value.trim().to_ascii_lowercase();
            [format!("127.0.0.1:{port}"), format!("localhost:{port}"), format!("[::1]:{port}")].contains(&value)
        };
        if !server.contains('=') { return matches(server); }
        let entries: Vec<_> = server.split(';').filter(|s| !s.trim().is_empty())
            .filter_map(|s| s.trim().split_once('=')).collect();
        entries.iter().any(|(key, _)| key.eq_ignore_ascii_case("http"))
            && entries.iter().any(|(key, _)| key.eq_ignore_ascii_case("https"))
            && entries.iter().all(|(_, value)| matches(value))
    }

    fn normalized_bypass(value: &str) -> Vec<String> {
        let mut parts: Vec<_> = value.split(';').map(|s| s.trim().to_ascii_lowercase()).filter(|s| !s.is_empty()).collect();
        parts.sort(); parts.dedup(); parts
    }

    fn classify(actual: &native::Settings, port: Option<u16>) -> SystemProxyStatus {
        let manual = actual.flags & 2 != 0;
        let automatic = actual.flags & (4 | 8) != 0;
        let enabled = manual && !automatic && port.is_some_and(|p| same_endpoint(&actual.server, p));
        let state = if enabled { "enabled" } else if manual || automatic { "external" } else { "disabled" };
        let bypass_changed = enabled && normalized_bypass(&actual.bypass) != normalized_bypass(BYPASS);
        SystemProxyStatus { state: state.into(), bypass_changed, last_change: None, message: match state {
            "external" => "Windows 当前使用其他代理或自动代理配置，ProcWeaver 未自动覆盖".into(),
            "enabled" if bypass_changed => "系统代理仍已开启；绕过列表发生变化".into(),
            "enabled" => "Windows 系统代理已指向本核心".into(),
            _ => "Windows 系统代理已关闭".into(),
        }}
    }

    fn expected_native(port: u16) -> native::Settings {
        native::Settings { flags: 3, server: format!("127.0.0.1:{port}"), bypass: BYPASS.into(), pac: String::new() }
    }

    fn restore_plan(current: &native::Settings, record: &Recovery) -> Result<Option<native::Settings>, String> {
        use winreg::types::FromRegValue;
        let text = |raw: &Option<Raw>| -> Result<String, String> {
            match raw { Some(raw) => String::from_reg_value(&raw.value()?).map_err(|_| "代理恢复记录字符串无效".into()), None => Ok(String::new()) }
        };
        let original = match record.original_native.clone() {
            Some(value) => value,
            None => native::Settings {
                flags: (current.flags & !2) | match &record.original[2] {
                    Some(raw) => if u32::from_reg_value(&raw.value()?).map_err(|_| "代理恢复记录开关无效")? != 0 { 2 } else { 0 },
                    None => 0,
                },
                server: text(&record.original[0])?, bypass: text(&record.original[1])?, pac: current.pac.clone(),
            },
        };
        // Leave another application's endpoint and automatic configuration intact.
        if !same_endpoint(&current.server, record.port) && current.server != original.server { return Ok(None); }
        if current.flags & (4 | 8) != 0 { return Ok(None); }
        let mut restored = current.clone();
        if same_endpoint(&current.server, record.port) { restored.server = original.server; }
        if normalized_bypass(&current.bypass) == normalized_bypass(BYPASS) { restored.bypass = original.bypass; }
        if current.flags == 3 { restored.flags = original.flags; }
        if current.pac.is_empty() { restored.pac = original.pac; }
        Ok(Some(restored))
    }

    fn restore_native(record: &Recovery) -> Result<(), String> {
        if let Some(restored) = restore_plan(&native::read()?, record)? { native::write(&restored)?; }
        Ok(())
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
                let mut cleared = false;
                for name in ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"] {
                    if env_key.get_value::<String, _>(name).is_ok_and(|value| value == proxy_url) {
                        let _ = env_key.delete_value(name); cleared = true;
                    }
                }
                if cleared {
                    for (name, expected) in [("NODE_USE_ENV_PROXY", "1"), ("NO_PROXY", "localhost,127.0.0.1,::1")] {
                        if env_key.get_value::<String, _>(name).is_ok_and(|value| value == expected) { let _ = env_key.delete_value(name); }
                    }
                }
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
            let record = owned.as_ref().unwrap();
            restore_native(record)?;
            sync_user_env_proxy(false, record.port);
            clear(&path())?;
            *owned = None;
            return Ok(false);
        }
        let port = port.unwrap_or(7890);
        if port == 0 { return Err("代理端口不能为零".into()); }
        if let Some(record) = owned.as_ref() {
            if port == record.port && classify(&native::read()?, Some(port)).enabled() { return Ok(true); }
            restore_native(record)?;
            clear(&path())?;
            *owned = None;
        }
        if path().exists() { return Err("存在未处理的代理恢复记录，请在原核心退出后重新启动应用".into()); }
        let record = Recovery {
            owner_pid: std::process::id(), owner_created: process_created(std::process::id())?.ok_or("当前进程已退出")?,
            port, original: snapshot(&reg)?, original_native: Some(native::read()?),
            expected: [Some(Raw::from(format!("127.0.0.1:{port}").to_reg_value())), Some(Raw::from(BYPASS.to_reg_value())), Some(Raw::from(1u32.to_reg_value()))],
        };
        save(&path(), &record)?;
        *owned = Some(record.clone());
        if let Err(error) = native::write(&expected_native(port)) {
            // Keep the durable record if rollback fails so lifecycle recovery can retry.
            restore_native(&record)?;
            clear(&path())?; *owned = None;
            return Err(error);
        }
        sync_user_env_proxy(true, port);
        Ok(true)
    }
    pub(super) fn status() -> Result<SystemProxyStatus, String> {
        let owned = OWNED.lock().map_err(|_| "代理状态锁不可用")?;
        Ok(classify(&native::read()?, owned.as_ref().map(|r| r.port)))
    }

    pub(super) fn has_recovery() -> bool { OWNED.lock().is_ok_and(|record| record.is_some()) }

    pub(super) fn reset_emergency() -> Result<(), String> {
        // Emergency cleanup also respects ownership; never disable another proxy.
        set(false, None).map(|_| ())
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::cell::RefCell;

        fn recovery_fixture() -> Recovery {
            Recovery { owner_pid: 1, owner_created: 1, port: 7890,
                original: [None, None, None], expected: [None, None, None],
                original_native: Some(native::Settings { flags: 1, server: String::new(), bypass: String::new(), pac: String::new() }) }
        }

        #[test]
        fn changed_bypass_does_not_disable_proxy_or_sandbox() {
            let mut actual = expected_native(7890);
            actual.bypass = format!(";localhost.*;;{BYPASS}");
            let state = classify(&actual, Some(7890));
            assert_eq!(state.state, "enabled"); assert!(state.bypass_changed);
            actual.bypass = format!(";;{BYPASS};;");
            assert!(!classify(&actual, Some(7890)).bypass_changed);
            actual.server = "http=localhost:7890;https=127.0.0.1:7890".into();
            assert!(classify(&actual, Some(7890)).enabled());
            actual.server = "http=localhost:7890;https=other:8080".into();
            assert_eq!(classify(&actual, Some(7890)).state, "external");
        }

        #[test]
        fn actual_flags_endpoint_and_ownership_are_distinct() {
            let mut actual = expected_native(7890);
            assert_eq!(classify(&actual, None).state, "external");
            assert_eq!(classify(&actual, Some(7891)).state, "external");
            actual.flags = 1;
            assert_eq!(classify(&actual, Some(7890)).state, "disabled");
            actual.flags = 3 | 4;
            assert_eq!(classify(&actual, Some(7890)).state, "external");
            actual.flags = 1 | 8;
            assert_eq!(classify(&actual, Some(7890)).state, "external");
        }

        #[test]
        fn restore_preserves_external_bypass_and_never_overwrites_foreign_proxy() {
            let record = recovery_fixture();
            let mut actual = expected_native(7890);
            actual.bypass = "external-bypass".into();
            let restored = restore_plan(&actual, &record).unwrap().unwrap();
            assert_eq!(restored.flags, 1); assert_eq!(restored.bypass, "external-bypass");
            assert_eq!(restore_plan(&restored, &record).unwrap(), Some(restored));
            actual.server = "other-proxy:8888".into();
            assert!(restore_plan(&actual, &record).unwrap().is_none());
            actual = expected_native(7890); actual.flags |= 4;
            assert!(restore_plan(&actual, &record).unwrap().is_none());
        }

        #[test]
        fn restore_retains_original_pac_and_supports_previous_release_record() {
            let mut record = recovery_fixture();
            record.original_native.as_mut().unwrap().flags = 5;
            record.original_native.as_mut().unwrap().pac = "https://pac.example/config".into();
            assert_eq!(restore_plan(&expected_native(7890), &record).unwrap(), record.original_native);
            let legacy = serde_json::json!({"owner_pid":1,"owner_created":1,"port":7890,"original":[null,null,null],"expected":[null,null,null]});
            let legacy: Recovery = serde_json::from_value(legacy).unwrap();
            assert_eq!(restore_plan(&expected_native(7890), &legacy).unwrap().unwrap().flags, 1);
        }

        #[test]
        fn native_query_is_read_only_and_layout_matches_windows() {
            assert_eq!(std::mem::size_of::<usize>(), 8, "当前发布目标为 Windows x64");
            let before = snapshot(&key().unwrap()).unwrap();
            let actual = native::read().unwrap();
            assert!(actual.flags & 15 != 0);
            assert_eq!(snapshot(&key().unwrap()).unwrap(), before);
        }
        struct Fake(RefCell<[Option<Raw>; 3]>);
        impl Registry for Fake {
            fn read(&self, name: &str) -> Result<Option<Raw>, String> { Ok(self.0.borrow()[NAMES.iter().position(|n| *n == name).unwrap()].clone()) }
            fn write(&self, name: &str, value: &Option<Raw>) -> Result<(), String> { self.0.borrow_mut()[NAMES.iter().position(|n| *n == name).unwrap()] = value.clone(); Ok(()) }
        }
        #[test]
        fn crash_record_roundtrip_restore_idempotent_and_preserve_external_changes() {
            let record = Recovery { original_native: None, owner_pid: 42, owner_created: 7, port: 7890,
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
            let record = Recovery { original_native: None, owner_pid: std::process::id(), owner_created: process_created(std::process::id()).unwrap().unwrap(), port: 7890, original: original.clone(),
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
            let record = Recovery { original_native: None, owner_pid: owner.id(), owner_created: process_created(owner.id()).unwrap().unwrap(), port: listener.local_addr().unwrap().port(),
                original: [None, None, None], expected: [Some(Raw::from("127.0.0.1:7890".to_reg_value())), Some(Raw::from(BYPASS.to_reg_value())), Some(Raw::from(1u32.to_reg_value()))] };
            let root = std::env::temp_dir().join(format!("netbox-proxy-crash-{}", std::process::id()));
            let file = root.join("recovery.json"); save(&file, &record).unwrap();
            let reg = Fake(RefCell::new(record.expected.clone()));
            recover_file(&file, |record| restore(&reg, record)).unwrap(); assert!(file.exists());
            owner.kill().unwrap(); owner.wait().unwrap();
            recover_file(&file, |record| restore(&reg, record)).unwrap(); assert!(file.exists());
            drop(listener);
            recover_file(&file, |record| restore(&reg, record)).unwrap(); assert!(!file.exists());
            assert_eq!(*reg.0.borrow(), record.original);
            recover_file(&file, |record| restore(&reg, record)).unwrap();
            std::fs::remove_dir_all(root).unwrap();
        }
    }
}

pub fn recover_stale_proxy() -> Result<(), String> {
    #[cfg(windows)] { windows::recover()?; }
    Ok(())
}
pub fn set_system_proxy_raw(enable: bool, port: Option<u16>) -> Result<bool, String> {
    set_system_proxy_with_reason(enable, port, if enable { "启用系统代理" } else { "核心停止或应用退出，恢复接管前设置" })
}
pub(crate) fn has_owned_proxy() -> bool {
    #[cfg(windows)] { windows::has_recovery() }
    #[cfg(not(windows))] { false }
}
pub(crate) fn set_system_proxy_with_reason(enable: bool, port: Option<u16>, reason: &str) -> Result<bool, String> {
    #[cfg(windows)] let result = windows::set(enable, port);
    #[cfg(not(windows))] let result = { let _ = port; Ok(enable) };
    if result.is_ok() { observe_change(Some(reason)); }
    else { observe_change(Some("系统代理操作失败，已重新读取实际状态")); }
    result
}

/// 生命周期事务内部使用，不重复获取 LIFECYCLE。
pub(crate) async fn set_system_proxy_locked(enable: bool, port: Option<u16>) -> Result<bool, String> {
    if enable && !super::process::ACTIVE.load(std::sync::atomic::Ordering::SeqCst) { return Err("核心尚未运行，不能启用系统代理".into()); }
    crate::routing_overrides::change_system_proxy(enable, || set_system_proxy_with_reason(enable, port, if enable { "用户启用系统代理" } else { "用户关闭系统代理，恢复接管前设置" })).await
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
    let status = system_proxy_snapshot();
    if status.state == "unknown" { Err(status.message) } else { Ok(status.enabled()) }
}

pub fn reset_system_proxy_emergency() -> Result<(), String> {
    #[cfg(windows)] { windows::reset_emergency()?; }
    observe_change(Some("紧急恢复：释放本程序接管的系统代理"));
    Ok(())
}

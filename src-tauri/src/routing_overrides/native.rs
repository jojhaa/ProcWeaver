//! Windows 只读进程快照与 WMI 事件；不改变目标进程、不收集命令行。
use super::tracker::ProcessEntry;
use std::{collections::{HashMap, HashSet}, sync::{LazyLock, Mutex}};
static PATHS: LazyLock<Mutex<HashMap<(u32, u64), String>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
#[cfg(test)]
static PATH_READS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
#[derive(Clone)]
pub struct ProcessRecord { pub pid: u32, pub parent_pid: u32, pub name: String }
#[cfg(windows)]
pub fn inspect(pid: u32, parent_pid: u32, name: String) -> ProcessEntry {
    use windows_sys::Win32::{Foundation::*, System::Threading::*};
    let mut item = ProcessEntry { pid, parent_pid, name, identity: String::new(), created_at: 0,
        executable_path: None, parent_identity: None, ancestors: vec![] };
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() { return item; }
        let mut created: FILETIME = std::mem::zeroed();
        let mut exit: FILETIME = std::mem::zeroed();
        let mut kernel: FILETIME = std::mem::zeroed();
        let mut user: FILETIME = std::mem::zeroed();
        if GetProcessTimes(handle, &mut created, &mut exit, &mut kernel, &mut user) != 0 {
            item.created_at = ((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64;
            item.identity = format!("{pid}:{}", item.created_at);
        }
        if item.created_at > 0 {
            item.executable_path = PATHS.lock().unwrap_or_else(|p| p.into_inner()).get(&(pid, item.created_at)).cloned();
        }
        if item.executable_path.is_none() {
            #[cfg(test)] PATH_READS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let mut buffer = vec![0u16; 512];
            loop {
                let mut length = buffer.len() as u32;
                if QueryFullProcessImageNameW(handle, 0, buffer.as_mut_ptr(), &mut length) != 0 {
                    let path = String::from_utf16_lossy(&buffer[..length as usize]);
                    if item.created_at > 0 {
                        let mut cache = PATHS.lock().unwrap_or_else(|p| p.into_inner());
                        if cache.len() >= 8192 { cache.clear(); }
                        cache.insert((pid, item.created_at), path.clone());
                    }
                    item.executable_path = Some(path); break;
                }
                if GetLastError() != ERROR_INSUFFICIENT_BUFFER || buffer.len() >= 32768 { break; }
                buffer.resize(buffer.len() * 2, 0);
            }
        }
        CloseHandle(handle);
    }
    item
}
#[cfg(windows)]
pub fn process_list() -> Result<Vec<ProcessRecord>, String> {
    use windows_sys::Win32::{Foundation::*, System::Diagnostics::ToolHelp::*};
    unsafe {
        let handle = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if handle == INVALID_HANDLE_VALUE { return Err("读取进程快照失败".into()); }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed(); entry.dwSize = std::mem::size_of_val(&entry) as u32;
        let mut ok = Process32FirstW(handle, &mut entry); let mut result = Vec::new();
        while ok != 0 && result.len() < 8192 {
            let length = entry.szExeFile.iter().position(|c| *c == 0).unwrap_or(entry.szExeFile.len());
            result.push(ProcessRecord { pid: entry.th32ProcessID, parent_pid: entry.th32ParentProcessID, name: String::from_utf16_lossy(&entry.szExeFile[..length]) });
            ok = Process32NextW(handle, &mut entry);
        }
        CloseHandle(handle);
        if ok != 0 { return Err("进程树超过 8192 项，跟踪受限".into()); }
        Ok(result)
    }
}
#[cfg(not(windows))]
pub fn process_list() -> Result<Vec<ProcessRecord>, String> { Err("进程树仅支持 Windows".into()) }

pub fn snapshot() -> Result<Vec<ProcessEntry>, String> {
    let entries: Vec<_> = process_list()?.into_iter().map(|p| inspect(p.pid, p.parent_pid, p.name)).collect();
    let live: HashSet<_> = entries.iter().map(|p| (p.pid, p.created_at)).collect();
    PATHS.lock().unwrap_or_else(|p| p.into_inner()).retain(|key, _| live.contains(key));
    Ok(entries)
}

#[cfg(all(test, windows))]
mod performance_tests {
    use super::*;
    #[test]
    fn performance_repeated_identity_reuses_path() {
        let pid = std::process::id();
        let first = inspect(pid, 0, String::new());
        assert!(!first.identity.is_empty());
        assert!(first.executable_path.is_some());
        let reads = PATH_READS.load(std::sync::atomic::Ordering::Relaxed);
        for _ in 0..50 { assert_eq!(inspect(pid, 0, String::new()).executable_path, first.executable_path); }
        assert_eq!(PATH_READS.load(std::sync::atomic::Ordering::Relaxed), reads);
    }
}

#[cfg(windows)]
pub fn observe() -> Result<(), String> {
    use windows::{core::{BSTR, w}, Win32::System::{Com::*, Wmi::*, Variant::*}};
    unsafe {
        CoInitializeEx(None, COINIT_MULTITHREADED).ok().map_err(|_| "初始化进程事件失败")?;
        struct Apartment;
        impl Drop for Apartment { fn drop(&mut self) { unsafe { CoUninitialize(); } } }
        let _apartment = Apartment;
        let locator: IWbemLocator = CoCreateInstance(&WbemLocator, None, CLSCTX_INPROC_SERVER).map_err(|_| "创建 WMI 服务失败")?;
        let empty = BSTR::new();
        let service = locator.ConnectServer(&BSTR::from("ROOT\\CIMV2"), &empty, &empty, &empty, 0, &empty, None).map_err(|_| "连接 WMI 失败")?;
        CoSetProxyBlanket(&service, 10, 0, None, RPC_C_AUTHN_LEVEL_CALL, RPC_C_IMP_LEVEL_IMPERSONATE, None, EOAC_NONE).map_err(|_| "设置 WMI 访问权限失败")?;
        let events = service.ExecNotificationQuery(&BSTR::from("WQL"), &BSTR::from("SELECT * FROM Win32_ProcessTrace"),
            WBEM_FLAG_RETURN_IMMEDIATELY | WBEM_FLAG_FORWARD_ONLY, None).map_err(|_| "无法订阅进程事件，请检查 WMI 权限；快照补偿不能保证短命进程")?;
        // 订阅成功后建立基线；排队事件与快照按实例身份去重。
        super::tracker::reconcile(snapshot()?, true);
        let mut last = std::time::Instant::now();
        while super::tracker::ENABLED.load(std::sync::atomic::Ordering::Acquire) {
            let mut objects = [None]; let mut returned = 0;
            events.Next(200, &mut objects, &mut returned).ok().map_err(|_| "进程事件订阅中断")?;
            if let Some(object) = objects[0].as_ref() {
                let mut value = VARIANT::default();
                object.Get(w!("ProcessID"), 0, &mut value, None, None).map_err(|_| "进程事件缺少 PID")?;
                let pid = VariantToUInt32(&value).map_err(|_| "进程事件 PID 无效")?;
                let mut timestamp = VARIANT::default();
                object.Get(w!("TIME_CREATED"), 0, &mut timestamp, None, None).map_err(|_| "进程事件缺少时间")?;
                let event_time = VariantToUInt64(&timestamp).map_err(|_| "进程事件时间无效")?;
                let mut class = VARIANT::default();
                object.Get(w!("__CLASS"), 0, &mut class, None, None).map_err(|_| "进程事件类型无效")?;
                let mut text = [0u16; 80]; VariantToString(&class, &mut text).map_err(|_| "进程事件类型无效")?;
                let class = String::from_utf16_lossy(&text[..text.iter().position(|v| *v == 0).unwrap_or(text.len())]);
                if class == "Win32_ProcessStartTrace" {
                    let mut parent = VARIANT::default();
                    object.Get(w!("ParentProcessID"), 0, &mut parent, None, None).map_err(|_| "进程事件缺少父 PID")?;
                    let ppid = VariantToUInt32(&parent).map_err(|_| "父 PID 无效")?;
                    let item = inspect(pid, ppid, String::new());
                    if item.created_at > 0 && item.created_at <= event_time && event_time - item.created_at < 50_000_000 {
                        super::tracker::created(item);
                    } else { super::tracker::limited("部分短命或受保护进程无法核实身份"); }
                } else if class == "Win32_ProcessStopTrace" { super::tracker::exited(pid, event_time); }
            }
            if last.elapsed().as_secs() >= 5 {
                super::tracker::reconcile(snapshot()?, false); last = std::time::Instant::now();
            }
        }
    }
    Ok(())
}

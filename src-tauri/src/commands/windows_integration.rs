//! Native shortcut and command-line operations; never evaluate arguments as shell code.
use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Link {
    pub target: String, pub arguments: String, pub directory: String,
    pub icon: String, pub icon_index: i32, pub description: String,
}
#[cfg(windows)]
fn com<T>(action: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    use windows::Win32::System::Com::*;
    let initialized = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
    // A caller may already own an STA. ShellLink also works in that apartment.
    if initialized.is_err() && initialized.0 != 0x80010106u32 as i32 { return Err("初始化 Windows 原生接口失败".into()); }
    struct Apartment(bool);
    impl Drop for Apartment { fn drop(&mut self) { if self.0 { unsafe { CoUninitialize(); } } } }
    let _apartment = Apartment(initialized.is_ok());
    action()
}
#[cfg(windows)]
fn wide(value: &str) -> Vec<u16> { value.encode_utf16().chain(Some(0)).collect() }
#[cfg(windows)]
fn string(value: &[u16]) -> String { String::from_utf16_lossy(&value[..value.iter().position(|c| *c == 0).unwrap_or(value.len())]) }

pub fn desktop(public: bool) -> Result<PathBuf, String> {
    #[cfg(windows)] { com(|| unsafe {
        use windows::Win32::{UI::Shell::*, System::Com::CoTaskMemFree};
        let pointer = SHGetKnownFolderPath(if public { &FOLDERID_PublicDesktop } else { &FOLDERID_Desktop }, KNOWN_FOLDER_FLAG(0), None).map_err(|_| "无法定位实际桌面目录")?;
        let result = pointer.to_string().map(PathBuf::from).map_err(|_| "桌面路径无效".to_string());
        CoTaskMemFree(Some(pointer.0.cast())); result
    }) }
    #[cfg(not(windows))] { let _ = public; Err("快捷方式仅支持 Windows".into()) }
}
pub fn read_link(path: &Path) -> Result<Link, String> {
    #[cfg(windows)] { com(|| unsafe {
        use windows::{core::{Interface, PCWSTR}, Win32::{System::Com::*, UI::Shell::*}};
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).map_err(|_| "创建快捷方式接口失败")?;
        let file: IPersistFile = link.cast().map_err(|_| "读取快捷方式接口失败")?;
        file.Load(PCWSTR(wide(&path.to_string_lossy()).as_ptr()), STGM_READ).map_err(|_| "无法读取快捷方式")?;
        let mut buffer = vec![0; 32768];
        link.GetPath(&mut buffer, std::ptr::null_mut(), 0).map_err(|_| "无法读取快捷方式目标")?; let target = string(&buffer);
        buffer.fill(0); link.GetArguments(&mut buffer).map_err(|_| "无法读取快捷方式参数")?; let arguments = string(&buffer);
        buffer.fill(0); link.GetWorkingDirectory(&mut buffer).map_err(|_| "无法读取工作目录")?; let directory = string(&buffer);
        buffer.fill(0); link.GetDescription(&mut buffer).map_err(|_| "无法读取快捷方式说明")?; let description = string(&buffer);
        let mut icon_index = 0; buffer.fill(0); link.GetIconLocation(&mut buffer, &mut icon_index).map_err(|_| "无法读取图标")?;
        Ok(Link { target, arguments, directory, description, icon: string(&buffer), icon_index })
    }) }
    #[cfg(not(windows))] { let _ = path; Err("快捷方式仅支持 Windows".into()) }
}
pub fn write_link(path: &Path, value: &Link, preserve: bool) -> Result<(), String> {
    #[cfg(windows)] { com(|| unsafe {
        use windows::{core::{Interface, PCWSTR}, Win32::{System::Com::*, UI::Shell::*}};
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).map_err(|_| "创建快捷方式接口失败")?;
        let file: IPersistFile = link.cast().map_err(|_| "读取快捷方式接口失败")?;
        let filename = wide(&path.to_string_lossy());
        if preserve { file.Load(PCWSTR(filename.as_ptr()), STGM_READWRITE).map_err(|_| "无法读取原快捷方式，未修改")?; }
        link.SetPath(PCWSTR(wide(&value.target).as_ptr())).map_err(|_| "设置快捷方式目标失败")?;
        link.SetArguments(PCWSTR(wide(&value.arguments).as_ptr())).map_err(|_| "设置快捷方式参数失败")?;
        link.SetWorkingDirectory(PCWSTR(wide(&value.directory).as_ptr())).map_err(|_| "设置快捷方式目录失败")?;
        link.SetDescription(PCWSTR(wide(&value.description).as_ptr())).map_err(|_| "设置快捷方式说明失败")?;
        link.SetIconLocation(PCWSTR(wide(&value.icon).as_ptr()), value.icon_index).map_err(|_| "设置快捷方式图标失败")?;
        file.Save(PCWSTR(filename.as_ptr()), true).map_err(|_| "保存快捷方式失败，请检查目录写入权限".to_string())
    }) }
    #[cfg(not(windows))] { let _ = (path,value,preserve); Err("快捷方式仅支持 Windows".into()) }
}

pub fn split_arguments(command: &str) -> Result<Vec<String>, String> {
    #[cfg(windows)] unsafe {
        use windows::{core::PCWSTR, Win32::{UI::Shell::CommandLineToArgvW, Foundation::{HLOCAL, LocalFree}}};
        let mut count = 0;
        let pointer = CommandLineToArgvW(PCWSTR(wide(command).as_ptr()), &mut count);
        if pointer.is_null() { return Err("无法解析应用参数".into()); }
        let result = std::slice::from_raw_parts(pointer, count as usize).iter().map(|p| p.to_string().unwrap_or_default()).collect();
        let _ = LocalFree(Some(HLOCAL(pointer.cast()))); Ok(result)
    }
    #[cfg(not(windows))] { let _ = command; Err("仅支持 Windows".into()) }
}

// Limit WMI reads to the selected executable name. Command lines stay in memory.
pub fn command_lines(name: &str) -> Result<Vec<(u32, String)>, String> {
    if name.contains(['\'', '"', '\\', '/']) { return Err("应用文件名无效".into()); }
    #[cfg(windows)] { com(|| unsafe {
        use windows::{core::{BSTR,w}, Win32::System::{Com::*, Wmi::*, Variant::*}};
        let locator: IWbemLocator = CoCreateInstance(&WbemLocator, None, CLSCTX_INPROC_SERVER).map_err(|_| "创建进程查询失败")?;
        let empty = BSTR::new();
        let service = locator.ConnectServer(&BSTR::from("ROOT\\CIMV2"), &empty,&empty,&empty,0,&empty,None).map_err(|_| "连接进程查询失败")?;
        CoSetProxyBlanket(&service,10,0,None,RPC_C_AUTHN_LEVEL_CALL,RPC_C_IMP_LEVEL_IMPERSONATE,None,EOAC_NONE).map_err(|_| "设置进程查询权限失败")?;
        let rows = service.ExecQuery(&BSTR::from("WQL"), &BSTR::from(format!("SELECT ProcessId,CommandLine FROM Win32_Process WHERE Name='{name}'")), WBEM_FLAG_RETURN_IMMEDIATELY|WBEM_FLAG_FORWARD_ONLY, None).map_err(|_| "查询应用进程失败")?;
        let mut result = Vec::new();
        loop {
            let mut objects = [None]; let mut count = 0;
            let status = rows.Next(1500, &mut objects, &mut count);
            if status.0 == WBEM_S_TIMEDOUT.0 { return Err("查询应用进程超时".into()); }
            status.ok().map_err(|_| "读取应用进程失败")?;
            if count == 0 { break; }
            let object = objects[0].as_ref().ok_or("应用进程查询无效")?;
            let mut value = VARIANT::default(); object.Get(w!("ProcessId"),0,&mut value,None,None).map_err(|_| "进程身份不可读")?;
            let pid = VariantToUInt32(&value).map_err(|_| "进程身份无效")?;
            let mut value = VARIANT::default(); object.Get(w!("CommandLine"),0,&mut value,None,None).map_err(|_| "进程参数不可读")?;
            let mut buffer = vec![0;32768];
            let command = if VariantToString(&value, &mut buffer).is_ok() { string(&buffer) } else { String::new() };
            result.push((pid,command));
            if result.len() > 2048 { return Err("应用进程过多，无法安全核对".into()); }
        } Ok(result)
    }) }
    #[cfg(not(windows))] { let _ = name; Err("仅支持 Windows".into()) }
}

pub fn request_close(pid: u32, identity: &str) -> Result<(), String> {
    #[cfg(windows)] unsafe {
        use windows_sys::Win32::{Foundation::*, System::Threading::*, UI::WindowsAndMessaging::*};
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE, 0, pid);
        if handle.is_null() { return Err("无法核实待重启进程，请手动正常退出".into()); }
        struct Handle(HANDLE); impl Drop for Handle { fn drop(&mut self) { unsafe { CloseHandle(self.0); } } }
        let _guard = Handle(handle);
        let mut c:FILETIME=std::mem::zeroed(); let mut e=c; let mut k=c; let mut u=c;
        if GetProcessTimes(handle,&mut c,&mut e,&mut k,&mut u)==0 || format!("{pid}:{}",((c.dwHighDateTime as u64)<<32)|c.dwLowDateTime as u64)!=identity { return Err("应用实例已改变，请重新检测".into()); }
        unsafe extern "system" fn close(window: HWND, data: LPARAM) -> BOOL {
            let mut owner = 0; GetWindowThreadProcessId(window, &mut owner);
            if owner == data as u32 && IsWindowVisible(window) != 0 { let _ = PostMessageW(window,WM_CLOSE,0,0); } 1
        }
        if WaitForSingleObject(handle,0) == WAIT_TIMEOUT { let _ = EnumWindows(Some(close), pid as LPARAM); }
        Ok(())
    }
    #[cfg(not(windows))] { let _=(pid,identity); Err("仅支持 Windows".into()) }
}

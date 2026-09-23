use serde::{Deserialize, Serialize};
use std::{ffi::c_void, mem::size_of, ptr};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(super) struct Settings {
    pub flags: u32,
    pub server: String,
    pub bypass: String,
    pub pac: String,
}

#[repr(C)]
union Value { number: u32, string: *mut u16, file_time: [u32; 2] }
#[repr(C)]
struct OptionValue { id: u32, value: Value }
#[repr(C)]
struct OptionList { size: u32, connection: *mut u16, count: u32, error: u32, options: *mut OptionValue }

#[link(name = "wininet")]
extern "system" {
    fn InternetQueryOptionW(handle: *mut c_void, option: u32, buffer: *mut c_void, length: *mut u32) -> i32;
    fn InternetSetOptionW(handle: *mut c_void, option: u32, buffer: *mut c_void, length: u32) -> i32;
}
#[link(name = "kernel32")]
extern "system" { fn GlobalFree(memory: *mut c_void) -> *mut c_void; }

fn list(options: &mut [OptionValue]) -> OptionList {
    OptionList { size: size_of::<OptionList>() as u32, connection: ptr::null_mut(), count: options.len() as u32, error: 0, options: options.as_mut_ptr() }
}

fn query(flags_id: u32) -> Result<Settings, String> {
    let mut options = [flags_id, 2, 3, 4].map(|id| OptionValue { id, value: Value { file_time: [0, 0] } });
    let mut list = list(&mut options);
    let mut length = list.size;
    let success = unsafe { InternetQueryOptionW(ptr::null_mut(), 75, (&mut list as *mut OptionList).cast(), &mut length) };
    let error = std::io::Error::last_os_error();
    let mut strings = Vec::new();
    // WinINet owns the returned strings until GlobalFree, including any partial result.
    for option in &options[1..] {
        let raw = unsafe { option.value.string };
        let text = if raw.is_null() { String::new() } else { unsafe {
            let mut len = 0;
            while *raw.add(len) != 0 { len += 1; }
            let text = String::from_utf16_lossy(std::slice::from_raw_parts(raw, len));
            GlobalFree(raw.cast());
            text
        }};
        strings.push(text);
    }
    if success == 0 { return Err(format!("读取 Windows 系统代理失败（错误 {}）", error.raw_os_error().unwrap_or(0))); }
    Ok(Settings { flags: unsafe { options[0].value.number }, server: strings[0].clone(), bypass: strings[1].clone(), pac: strings[2].clone() })
}

pub(super) fn read() -> Result<Settings, String> { query(10).or_else(|_| query(1)) }

pub(super) fn write(settings: &Settings) -> Result<(), String> {
    let wide = |value: &str| value.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
    let mut server = wide(&settings.server);
    let mut bypass = wide(&settings.bypass);
    let mut pac = wide(&settings.pac);
    let mut options = [
        OptionValue { id: 1, value: Value { number: settings.flags } },
        OptionValue { id: 2, value: Value { string: server.as_mut_ptr() } },
        OptionValue { id: 3, value: Value { string: bypass.as_mut_ptr() } },
        OptionValue { id: 4, value: Value { string: pac.as_mut_ptr() } },
    ];
    let mut list = list(&mut options);
    unsafe {
        if InternetSetOptionW(ptr::null_mut(), 75, (&mut list as *mut OptionList).cast(), list.size) == 0 {
            return Err(format!("写入 Windows 系统代理失败（错误 {}）", std::io::Error::last_os_error().raw_os_error().unwrap_or(0)));
        }
        for option in [39, 37] {
            if InternetSetOptionW(ptr::null_mut(), option, ptr::null_mut(), 0) == 0 {
                return Err("系统代理通知失败，请重试并核实实际状态".into());
            }
        }
    }
    let actual = read()?;
    if actual != *settings { return Err("Windows 系统代理回读不一致，未确认变更生效".into()); }
    Ok(())
}

//! WinDivert 2.2 ABI. Dynamically loaded, replaceable LGPL component; no example code copied.
use std::{
    ffi::{c_void, CString},
    path::Path,
    sync::Arc,
};
type Handle = *mut c_void;
#[link(name = "kernel32")]
extern "system" {
    fn LoadLibraryExW(path: *const u16, file: Handle, flags: u32) -> Handle;
    fn GetProcAddress(module: Handle, name: *const u8) -> *mut c_void;
    fn FreeLibrary(module: Handle) -> i32;
}
#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct Address {
    pub timestamp: i64,
    pub flags: u32,
    reserved: u32,
    pub data: [u64; 8],
}
impl Address {
    pub fn inbound(&mut self) {
        self.flags &= !(1 << 17);
    }
}
type Open = unsafe extern "C" fn(*const i8, i32, i16, u64) -> Handle;
type Recv = unsafe extern "C" fn(Handle, *mut c_void, u32, *mut u32, *mut Address) -> i32;
type SendPacket = unsafe extern "C" fn(Handle, *const c_void, u32, *mut u32, *const Address) -> i32;
type Close = unsafe extern "C" fn(Handle) -> i32;
type Shutdown = unsafe extern "C" fn(Handle, i32) -> i32;
type Checksums = unsafe extern "C" fn(*mut c_void, u32, *mut Address, u64) -> i32;
pub struct Api {
    module: Handle,
    open: Open,
    recv: Recv,
    send: SendPacket,
    close: Close,
    shutdown: Shutdown,
    checksums: Checksums,
}
unsafe impl Send for Api {}
unsafe impl Sync for Api {}
impl Drop for Api {
    fn drop(&mut self) {
        unsafe {
            FreeLibrary(self.module);
        }
    }
}
impl Api {
    pub fn load(path: &Path) -> Result<Arc<Self>, String> {
        use std::os::windows::ffi::OsStrExt;
        let name: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        unsafe {
            let module = LoadLibraryExW(name.as_ptr(), std::ptr::null_mut(), 0x100 | 0x800);
            if module.is_null() {
                return Err(format!(
                    "无法加载 WinDivert.dll：{}",
                    std::io::Error::last_os_error()
                ));
            }
            macro_rules! symbol {
                ($name:literal, $ty:ty) => {{
                    let p = GetProcAddress(module, concat!($name, "\0").as_ptr());
                    if p.is_null() {
                        FreeLibrary(module);
                        return Err(format!("WinDivert 缺少接口 {}", $name));
                    }
                    std::mem::transmute::<*mut c_void, $ty>(p)
                }};
            }
            Ok(Arc::new(Self {
                module,
                open: symbol!("WinDivertOpen", Open),
                recv: symbol!("WinDivertRecv", Recv),
                send: symbol!("WinDivertSend", SendPacket),
                close: symbol!("WinDivertClose", Close),
                shutdown: symbol!("WinDivertShutdown", Shutdown),
                checksums: symbol!("WinDivertHelperCalcChecksums", Checksums),
            }))
        }
    }
    pub fn open(
        self: &Arc<Self>,
        filter: &str,
        layer: i32,
        flags: u64,
    ) -> Result<Arc<Device>, String> {
        let filter = CString::new(filter).map_err(|_| "过滤条件无效")?;
        let handle = unsafe { (self.open)(filter.as_ptr(), layer, 113, flags) };
        if handle as isize == -1 {
            let error = std::io::Error::last_os_error();
            return Err(if error.raw_os_error() == Some(5) {
                "进程接管需要管理员权限，请退出后右键以管理员身份运行 ProcWeaver".into()
            } else {
                format!("WinDivert 接管启动失败：{error}")
            });
        }
        Ok(Arc::new(Device {
            api: self.clone(),
            handle,
        }))
    }
}
pub struct Device {
    api: Arc<Api>,
    handle: Handle,
}
unsafe impl Send for Device {}
unsafe impl Sync for Device {}
impl Device {
    pub fn recv(&self, packet: &mut [u8]) -> std::io::Result<(usize, Address)> {
        let mut length = 0;
        let mut address = Address::default();
        if unsafe {
            (self.api.recv)(
                self.handle,
                packet.as_mut_ptr().cast(),
                packet.len() as u32,
                &mut length,
                &mut address,
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error());
        }
        Ok((length as usize, address))
    }
    pub fn send(
        &self,
        packet: &mut [u8],
        address: &mut Address,
        changed: bool,
    ) -> std::io::Result<()> {
        if changed {
            unsafe {
                (self.api.checksums)(packet.as_mut_ptr().cast(), packet.len() as u32, address, 0);
            }
        }
        if unsafe {
            (self.api.send)(
                self.handle,
                packet.as_ptr().cast(),
                packet.len() as u32,
                std::ptr::null_mut(),
                address,
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }
    pub fn shutdown(&self) {
        unsafe {
            (self.api.shutdown)(self.handle, 1);
        }
    }
}
impl Drop for Device {
    fn drop(&mut self) {
        unsafe {
            (self.api.close)(self.handle);
        }
    }
}

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
type GetParam = unsafe extern "C" fn(Handle, i32, *mut u64) -> i32;
pub struct Api {
    module: Handle,
    open: Open,
    recv: Recv,
    send: SendPacket,
    close: Close,
    shutdown: Shutdown,
    checksums: Checksums,
    get_param: GetParam,
    _component_locks: Vec<std::fs::File>,
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
        Self::load_locked(path, Vec::new())
    }
    pub(crate) fn load_locked(path: &Path, locks: Vec<std::fs::File>) -> Result<Arc<Self>, String> {
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
                get_param: symbol!("WinDivertGetParam", GetParam),
                _component_locks: locks,
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
                "WinDivert 访问被拒绝；请检查接管进程权限及系统策略".into()
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
    /// Explicit close is used when reporting verified release rather than merely
    /// requesting it in Drop. Refuse if another worker still owns this handle.
    pub fn close(self: Arc<Self>) -> std::io::Result<()> {
        let mut device = Arc::try_unwrap(self).map_err(|_| std::io::Error::other("驱动句柄仍被本实例工作线程使用"))?;
        let handle = std::mem::replace(&mut device.handle, std::ptr::null_mut());
        if unsafe { (device.api.close)(handle) } == 0 { return Err(std::io::Error::last_os_error()); }
        Ok(())
    }
    pub fn version(&self) -> std::io::Result<(u64, u64)> {
        let (mut major, mut minor) = (0, 0);
        if unsafe { (self.api.get_param)(self.handle, 3, &mut major) } == 0
            || unsafe { (self.api.get_param)(self.handle, 4, &mut minor) } == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok((major, minor))
    }
    pub fn recv(&self, packet: &mut [u8]) -> std::io::Result<(usize, Address)> {
        let capacity: u32 = packet.len().try_into().map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidInput, "收包缓冲区过大"))?;
        let mut length = 0;
        let mut address = Address::default();
        if unsafe {
            (self.api.recv)(
                self.handle,
                if packet.is_empty() { std::ptr::null_mut() } else { packet.as_mut_ptr().cast() },
                capacity,
                &mut length,
                &mut address,
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error());
        }
        if length > capacity { return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "驱动返回的包长度越界")); }
        Ok((length as usize, address))
    }
    pub fn send(
        &self,
        packet: &mut [u8],
        address: &mut Address,
        changed: bool,
    ) -> std::io::Result<()> {
        let length: u32 = packet.len().try_into().map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidInput, "发送包过大"))?;
        if changed {
            if unsafe { (self.api.checksums)(packet.as_mut_ptr().cast(), length, address, 0) } == 0 {
                return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "无法重算网络包校验和"));
            }
        }
        if unsafe {
            (self.api.send)(
                self.handle,
                packet.as_ptr().cast(),
                length,
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
        if self.handle.is_null() { return; }
        unsafe {
            (self.api.close)(self.handle);
        }
    }
}

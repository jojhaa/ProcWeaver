//! Component provenance and non-intercepting driver probe for the isolated helper.
use serde::Serialize;
use std::{fs::{File, OpenOptions}, io::Read, path::{Path, PathBuf}, sync::Arc};
use super::driver::Api;

pub const DLL_SHA256: &str = "c1e060ee19444a259b2162f8af0f3fe8c4428a1c6f694dce20de194ac8d7d9a2";
pub const SYS_SHA256: &str = "8da085332782708d8767bcace5327a6ec7283c17cfb85e40b03cd2323a90ddc2";

#[link(name = "bcrypt")]
extern "system" {
    fn BCryptOpenAlgorithmProvider(handle: *mut *mut std::ffi::c_void, algorithm: *const u16, implementation: *const u16, flags: u32) -> i32;
    fn BCryptHash(handle: *mut std::ffi::c_void, secret: *const u8, secret_len: u32, input: *const u8, input_len: u32, output: *mut u8, output_len: u32) -> i32;
    fn BCryptCloseAlgorithmProvider(handle: *mut std::ffi::c_void, flags: u32) -> i32;
}

pub(crate) fn sha256(bytes: &[u8]) -> Result<String, String> {
    let length: u32 = bytes.len().try_into().map_err(|_| "组件过大")?;
    let mut handle = std::ptr::null_mut();
    let algorithm: Vec<_> = "SHA256\0".encode_utf16().collect();
    unsafe {
        if BCryptOpenAlgorithmProvider(&mut handle, algorithm.as_ptr(), std::ptr::null(), 0) < 0 { return Err("无法初始化组件摘要校验".into()); }
        let mut output = [0u8; 32];
        let code = BCryptHash(handle, std::ptr::null(), 0, bytes.as_ptr(), length, output.as_mut_ptr(), 32);
        BCryptCloseAlgorithmProvider(handle, 0);
        if code < 0 { return Err("组件摘要计算失败".into()); }
        Ok(output.iter().map(|b| format!("{b:02x}")).collect())
    }
}

pub struct VerifiedComponents {
    pub dll: PathBuf,
    // Deny write/delete sharing while the DLL/driver are loaded. These handles
    // outlive the API. No writable replacement between hash check and loading.
    _locks: Vec<File>,
}

pub(crate) fn reject_reparse(path: &Path) -> Result<(), String> {
    use std::os::windows::fs::MetadataExt;
    for ancestor in path.ancestors() {
        let metadata = std::fs::symlink_metadata(ancestor).map_err(|_| "组件路径不存在或不可读取")?;
        if metadata.file_attributes() & 0x400 != 0 { return Err("组件路径不能包含重解析点".into()); }
    }
    Ok(())
}

pub fn verify(directory: &Path) -> Result<VerifiedComponents, String> {
    use std::os::windows::fs::OpenOptionsExt;
    if !cfg!(target_arch = "x86_64") { return Err("首期 WinDivert 仅支持 Windows x64".into()); }
    if !directory.is_absolute() { return Err("组件路径必须为完整路径".into()); }
    reject_reparse(directory)?;
    let mut locks = Vec::new();
    for (name, expected, expected_size) in [("WinDivert.dll", DLL_SHA256, 47616), ("WinDivert64.sys", SYS_SHA256, 94144)] {
        let path = directory.join(name);
        reject_reparse(&path)?;
        let mut file = OpenOptions::new().read(true).share_mode(1).open(path).map_err(|_| format!("{name} 不可读取或正在被替换"))?;
        if file.metadata().map_err(|_| "无法读取组件属性")?.len() != expected_size { return Err(format!("{name} 与批准的官方 2.2.2 组件不一致")); }
        let mut bytes = Vec::new();
        (&mut file).take(expected_size + 1).read_to_end(&mut bytes).map_err(|_| "读取组件失败")?;
        if sha256(&bytes)? != expected { return Err(format!("{name} 摘要不匹配；未加载任何组件")); }
        locks.push(file);
    }
    Ok(VerifiedComponents { dll: directory.join("WinDivert.dll"), _locks: locks })
}

pub struct VerifiedApi {
    pub api: Arc<Api>,
}
impl VerifiedApi {
    pub fn load(directory: &Path) -> Result<Self, String> {
        let components = verify(directory)?;
        let api = Api::load_locked(&components.dll, components._locks)?;
        Ok(Self { api })
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeReport {
    pub driver_major: u64,
    pub driver_minor: u64,
    pub packet_filter: &'static str,
    pub intercepted_traffic: bool,
    pub released_own_handle: bool,
    pub production_ready: bool,
    pub limitation: &'static str,
}

/// Run in a separate native process, never in a UI polling loop. Opening `false`
/// may install/load the official driver but cannot capture, drop or inject traffic.
/// No service stop/delete: another application may share the driver.
pub fn probe(directory: &Path) -> Result<ProbeReport, String> {
    let loaded = VerifiedApi::load(directory)?;
    let device = loaded.api.open("false", 0, 1 | 4)?;
    let (driver_major, driver_minor) = device.version().map_err(|_| "无法读取已加载驱动版本")?;
    if (driver_major, driver_minor) != (2, 2) { return Err("当前共享 WinDivert 驱动版本不兼容".into()); }
    device.close().map_err(|_| "本实例驱动句柄释放未确认")?;
    Ok(ProbeReport { driver_major, driver_minor, packet_filter: "false", intercepted_traffic: false,
        released_own_handle: true, production_ready: false,
        limitation: "仅证明当前机器可打开并关闭原样驱动句柄；未证明规则接管、其他过滤器兼容、卸载或反作弊兼容" })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_sha256_matches_known_vector() {
        assert_eq!(sha256(b"abc").unwrap(), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }
    #[test]
    fn missing_or_tampered_components_are_rejected_without_loading() {
        let directory = std::env::temp_dir().join(format!("pw-wd-component-test-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        assert!(verify(&directory).is_err());
        std::fs::write(directory.join("WinDivert.dll"), vec![0u8; 47616]).unwrap();
        assert!(verify(&directory).err().unwrap().contains("摘要不匹配"));
        std::fs::remove_file(directory.join("WinDivert.dll")).unwrap();
        std::fs::remove_dir(directory).unwrap();
    }
}

//! Fixed-layout compressed resource. Only explicit activation calls prepare().
//! No archive member names are trusted and no external extractor is executed.
use super::preflight;
use std::{
    fs::{File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

pub const RESOURCE: &str = "binaries/windivert/WinDivert-2.2.2-x64.gz";
const DLL_SIZE: usize = 47616;
const SYS_SIZE: usize = 94144;
const TOTAL: usize = DLL_SIZE + SYS_SIZE;

fn decode(bytes: &[u8]) -> Result<Vec<u8>, String> {
    if bytes.is_empty() || bytes.len() > 262144 {
        return Err("WinDivert 压缩资源大小无效".into());
    }
    let mut payload = Vec::with_capacity(TOTAL);
    let mut decoder = flate2::bufread::GzDecoder::new(bytes);
    (&mut decoder)
        .take((TOTAL + 1) as u64)
        .read_to_end(&mut payload)
        .map_err(|_| "WinDivert 压缩资源损坏")?;
    if !decoder.into_inner().is_empty()
        || payload.len() != TOTAL
        || preflight::sha256(&payload[..DLL_SIZE])? != preflight::DLL_SHA256
        || preflight::sha256(&payload[DLL_SIZE..])? != preflight::SYS_SHA256
    {
        return Err("WinDivert 压缩资源内容校验失败；未加载组件".into());
    }
    Ok(payload)
}

pub fn validate_resource(path: &Path) -> Result<(), String> {
    read_payload(path).map(|_| ())
}
fn read_payload(path: &Path) -> Result<Vec<u8>, String> {
    preflight::reject_reparse(path)?;
    let mut bytes = Vec::new();
    File::open(path)
        .map_err(|_| "缺少 WinDivert 压缩资源，请使用完整程序包")?
        .take(262145)
        .read_to_end(&mut bytes)
        .map_err(|_| "读取 WinDivert 压缩资源失败")?;
    decode(&bytes)
}

/// The elevated helper derives the resource from its own executable, never an
/// arbitrary path supplied over IPC. Debug builds additionally use source assets.
pub fn resource() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|_| "无法定位程序")?;
    let path = exe.parent().ok_or("程序目录无效")?.join(RESOURCE);
    if path.is_file() {
        return Ok(path);
    }
    #[cfg(debug_assertions)]
    {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(RESOURCE);
        if path.is_file() {
            return Ok(path);
        }
    }
    Err("缺少 WinDivert 压缩资源，请使用完整程序包".into())
}

// Program Files is used only for the optional privileged component cache. It is
// deliberately outside user-writable portable data. Never modify a driver service.
fn cache_root() -> Result<PathBuf, String> {
    use windows::Win32::{
        System::Com::CoTaskMemFree,
        UI::Shell::{FOLDERID_ProgramFiles, SHGetKnownFolderPath, KF_FLAG_DEFAULT},
    };
    unsafe {
        let value = SHGetKnownFolderPath(&FOLDERID_ProgramFiles, KF_FLAG_DEFAULT, None)
            .map_err(|_| "无法定位受保护组件目录")?;
        let path = value
            .to_string()
            .map(PathBuf::from)
            .map_err(|_| "组件目录无效");
        CoTaskMemFree(Some(value.0.cast()));
        Ok(path?.join(crate::edition::COMPONENTS))
    }
}

pub fn prepare() -> Result<PathBuf, String> {
    let payload = read_payload(&resource()?)?;
    let root = cache_root()?;
    // The parent is OS-protected; creating our child cannot traverse a reparse point.
    preflight::reject_reparse(root.parent().ok_or("组件目录无效")?)?;
    if !root.exists() {
        std::fs::create_dir(&root).map_err(|_| "创建组件缓存需要管理员权限")?;
    }
    preflight::reject_reparse(&root)?;
    protect(&root)?;
    let directory = root.join("WinDivert-2.2.2-x64");
    if directory.exists() {
        preflight::verify(&directory)?;
        return Ok(directory);
    }
    let staging = root.join(format!(
        "prepare-{}-{}",
        std::process::id(),
        super::helper::nonce()?
    ));
    std::fs::create_dir(&staging).map_err(|_| "创建组件准备目录失败")?;
    let result = (|| {
        for (name, data) in [
            ("WinDivert.dll", &payload[..DLL_SIZE]),
            ("WinDivert64.sys", &payload[DLL_SIZE..]),
        ] {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(staging.join(name))
                .map_err(|_| "创建组件文件失败")?;
            file.write_all(data)
                .and_then(|_| file.sync_all())
                .map_err(|_| "写入组件文件失败")?;
        }
        preflight::verify(&staging)?;
        match std::fs::rename(&staging, &directory) {
            Ok(()) => Ok(directory.clone()),
            Err(_) if preflight::verify(&directory).is_ok() => Ok(directory.clone()),
            Err(_) => Err("原子安装 WinDivert 组件失败".into()),
        }
    })();
    // Only the two files created by this invocation; no recursive user-path delete.
    if staging.exists() {
        for name in ["WinDivert.dll", "WinDivert64.sys"] {
            let _ = std::fs::remove_file(staging.join(name));
        }
        let _ = std::fs::remove_dir(&staging);
    }
    result
}

fn protect(path: &Path) -> Result<(), String> {
    use std::{ffi::c_void, os::windows::ffi::OsStrExt};
    #[link(name = "advapi32")]
    extern "system" {
        fn ConvertStringSecurityDescriptorToSecurityDescriptorW(
            text: *const u16,
            revision: u32,
            descriptor: *mut *mut c_void,
            size: *mut u32,
        ) -> i32;
        fn SetFileSecurityW(path: *const u16, info: u32, descriptor: *mut c_void) -> i32;
    }
    let sddl: Vec<u16> = "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FRFX;;;BU)\0"
        .encode_utf16()
        .collect();
    let path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    unsafe {
        let mut descriptor = std::ptr::null_mut();
        if ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            1,
            &mut descriptor,
            std::ptr::null_mut(),
        ) == 0
        {
            return Err("组件目录权限准备失败".into());
        }
        let ok = SetFileSecurityW(path.as_ptr(), 4 | 0x80000000, descriptor);
        windows_sys::Win32::Foundation::LocalFree(descriptor);
        if ok == 0 {
            return Err("无法保护组件目录；请确认管理员授权".into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn compressed_resource_decodes_only_the_two_approved_components() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(RESOURCE);
        let bytes = std::fs::read(path).unwrap();
        assert_eq!(decode(&bytes).unwrap().len(), TOTAL);
        assert!(decode(&bytes[..bytes.len() - 12]).is_err());
        let mut trailing = bytes.clone();
        trailing.push(0);
        assert!(decode(&trailing).is_err());
        assert!(decode(&vec![0; 262145]).is_err());
        let mut invalid = bytes;
        invalid[20] ^= 1;
        assert!(decode(&invalid).is_err());
    }
}

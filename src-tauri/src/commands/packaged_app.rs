//! Registered package entry points must be activated with their package identity.
//! Never launch a package's main EXE directly after activation/preflight fails.
use std::path::{Component, Path, PathBuf};
use windows::{
    core::{w, PCWSTR, PWSTR},
    Win32::{
        Foundation::{ERROR_INSUFFICIENT_BUFFER, ERROR_SUCCESS},
        Storage::Packaging::Appx::*,
        System::Com::*,
        UI::Shell::*,
    },
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PackagedApp {
    pub executable: PathBuf,
    pub aumid: String,
    pub full_name: String,
}
const ACTIVATION_NOTE: &str = "已通过 Windows 应用通道发送代理启动参数；商店应用不继承此启动器的代理环境变量，启动参数与实际连接出口仍需核验";
pub(crate) fn activation_note() -> &'static str {
    ACTIVATION_NOTE
}
fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}
fn failure(stage: &str, error: windows::core::Error) -> String {
    format!("{stage}（Windows 0x{:08X}）", error.code().0 as u32)
}
unsafe fn owned_string(value: PWSTR) -> Result<String, String> {
    if value.is_null() {
        return Ok(String::new());
    }
    let result = value
        .to_string()
        .map_err(|_| "程序包元数据包含无效文本".to_string());
    CoTaskMemFree(Some(value.0.cast()));
    result
}

fn registered_names(family: &str) -> Result<Vec<String>, String> {
    let family = wide(family);
    unsafe {
        let (mut count, mut length) = (0, 0);
        let result = GetPackagesByPackageFamily(
            PCWSTR(family.as_ptr()),
            &mut count,
            None,
            &mut length,
            None,
        );
        if result == ERROR_SUCCESS && count == 0 {
            return Ok(vec![]);
        }
        if result != ERROR_INSUFFICIENT_BUFFER || count > 128 || length > 65536 {
            return Err("无法读取当前用户的程序包注册信息".into());
        }
        let mut names = vec![PWSTR::null(); count as usize];
        let mut buffer = vec![0u16; length as usize];
        let result = GetPackagesByPackageFamily(
            PCWSTR(family.as_ptr()),
            &mut count,
            Some(names.as_mut_ptr()),
            &mut length,
            Some(PWSTR(buffer.as_mut_ptr())),
        );
        if result != ERROR_SUCCESS {
            return Err("程序包注册信息已改变，请重新检测".into());
        }
        names
            .into_iter()
            .take(count as usize)
            .map(|name| name.to_string().map_err(|_| "程序包名称无效".into()))
            .collect()
    }
}
fn registered_path(full_name: &str) -> Result<PathBuf, String> {
    let name = wide(full_name);
    let mut buffer = vec![0u16; 32768];
    let mut length = buffer.len() as u32;
    let result = unsafe {
        GetPackagePathByFullName(
            PCWSTR(name.as_ptr()),
            &mut length,
            Some(PWSTR(buffer.as_mut_ptr())),
        )
    };
    if result != ERROR_SUCCESS {
        return Err("程序包未注册或已更新，请重新选择当前应用".into());
    }
    Ok(PathBuf::from(String::from_utf16_lossy(
        &buffer[..buffer.iter().position(|c| *c == 0).unwrap_or(buffer.len())],
    )))
}
fn child_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(relative);
    if relative.is_empty()
        || relative.contains(':')
        || !path
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
    {
        return Err("程序包主程序路径无效".into());
    }
    Ok(root.join(path))
}
fn same_file_path(left: &Path, right: &Path) -> bool {
    match (std::fs::canonicalize(left), std::fs::canonicalize(right)) {
        (Ok(left), Ok(right)) => {
            crate::platform::same_path(&left.to_string_lossy(), &right.to_string_lossy())
        }
        _ => false,
    }
}
fn manifest_apps(root: &Path) -> Result<Vec<PackagedApp>, String> {
    super::windows_integration::com(|| unsafe {
        let manifest = wide(&root.join("AppxManifest.xml").to_string_lossy());
        let stream = SHCreateStreamOnFileEx(
            PCWSTR(manifest.as_ptr()),
            (STGM_READ | STGM_SHARE_DENY_NONE).0,
            0,
            false,
            None,
        )
        .map_err(|e| failure("无法读取程序包清单", e))?;
        let factory: IAppxFactory = CoCreateInstance(&AppxFactory, None, CLSCTX_INPROC_SERVER)
            .map_err(|e| failure("无法创建程序包读取接口", e))?;
        let reader = factory
            .CreateManifestReader(&stream)
            .map_err(|e| failure("程序包清单无效", e))?;
        let package = reader
            .GetPackageId()
            .map_err(|e| failure("程序包标识不可读", e))?;
        let full_name = owned_string(
            package
                .GetPackageFullName()
                .map_err(|e| failure("程序包名称不可读", e))?,
        )?;
        let family = owned_string(
            package
                .GetPackageFamilyName()
                .map_err(|e| failure("程序包系列不可读", e))?,
        )?;
        if !registered_names(&family)?.contains(&full_name)
            || !same_file_path(&registered_path(&full_name)?, root)
        {
            return Err(
                "所选程序包路径不是当前用户已注册的版本，请重新选择应用；未直接运行包内程序".into(),
            );
        }
        let applications = reader
            .GetApplications()
            .map_err(|e| failure("程序包应用入口不可读", e))?;
        let mut result = Vec::new();
        let mut count = 0;
        while applications
            .GetHasCurrent()
            .map_err(|e| failure("程序包入口枚举失败", e))?
            .as_bool()
        {
            count += 1;
            if count > 128 {
                return Err("程序包应用入口过多".into());
            }
            let app = applications
                .GetCurrent()
                .map_err(|e| failure("程序包入口不可读", e))?;
            let executable = owned_string(
                app.GetStringValue(w!("Executable"))
                    .map_err(|e| failure("程序包主程序不可读", e))?,
            )?;
            if !executable.is_empty() {
                let aumid = owned_string(
                    app.GetAppUserModelId()
                        .map_err(|e| failure("程序包应用身份不可读", e))?,
                )?;
                if aumid.is_empty() {
                    return Err("程序包应用身份为空".into());
                }
                result.push(PackagedApp {
                    executable: child_path(root, &executable)?,
                    aumid,
                    full_name: full_name.clone(),
                });
            }
            let _ = applications
                .MoveNext()
                .map_err(|e| failure("程序包入口枚举失败", e))?;
        }
        Ok(result)
    })
}
pub(crate) fn find(family: &str, filename: &str) -> Result<Option<PathBuf>, String> {
    let mut matches = Vec::new();
    for name in registered_names(family)? {
        for app in manifest_apps(&registered_path(&name)?)? {
            if app
                .executable
                .file_name()
                .is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case(filename))
            {
                matches.push(app.executable);
            }
        }
    }
    matches.sort();
    matches.dedup();
    if matches.len() > 1 {
        return Err("存在多个已注册应用入口，请手动选择主程序".into());
    }
    Ok(matches.pop())
}
pub(crate) fn resolve(executable: &Path) -> Result<Option<PackagedApp>, String> {
    // Resolve path aliases before matching entry points, otherwise a path containing
    // '..' or a junction could accidentally bypass package activation.
    let resolved = std::fs::canonicalize(executable).unwrap_or_else(|_| executable.to_path_buf());
    let executable = resolved.as_path();
    let root = executable
        .ancestors()
        .skip(1)
        .find(|p| p.join("AppxManifest.xml").is_file());
    let Some(root) = root else {
        if executable.components().any(|p| {
            p.as_os_str()
                .to_string_lossy()
                .eq_ignore_ascii_case("WindowsApps")
        }) {
            return Err(
                "无法确认此商店应用的程序包入口，请重新选择已安装的主应用；未直接运行包内程序"
                    .into(),
            );
        }
        return Ok(None);
    };
    let mut matches: Vec<_> = manifest_apps(root)?
        .into_iter()
        .filter(|app| same_file_path(&app.executable, executable))
        .collect();
    if matches.len() > 1 {
        return Err("此可执行文件对应多个程序包入口，无法安全选择".into());
    }
    // CLI/helper binaries which are not application entry points retain normal EXE semantics.
    Ok(matches.pop())
}
pub(crate) fn arguments(args: &[String]) -> Result<String, String> {
    let mut quoted = Vec::new();
    for arg in args {
        if arg.contains('\0') {
            return Err("启动参数包含无效字符".into());
        }
        let mut value = String::from("\"");
        let mut slashes = 0;
        for ch in arg.chars() {
            if ch == '\\' {
                slashes += 1;
                continue;
            }
            value.extend(std::iter::repeat_n(
                '\\',
                if ch == '"' { slashes * 2 + 1 } else { slashes },
            ));
            slashes = 0;
            value.push(ch);
        }
        value.extend(std::iter::repeat_n('\\', slashes * 2));
        value.push('"');
        quoted.push(value);
    }
    let result = quoted.join(" ");
    if result.encode_utf16().count() >= 32767 {
        return Err("程序包启动参数过长".into());
    }
    Ok(result)
}
fn activation_manager() -> Result<IApplicationActivationManager, String> {
    unsafe {
        CoCreateInstance(&ApplicationActivationManager, None, CLSCTX_LOCAL_SERVER)
            .map_err(|e| failure("Windows 应用激活服务不可用", e))
    }
}
pub(crate) fn preflight(executable: &Path, args: &[String]) -> Result<(), String> {
    if resolve(executable)?.is_some() {
        if !executable.is_file() {
            return Err("程序包主程序不存在，请重新选择当前应用".into());
        }
        arguments(args)?;
        super::windows_integration::com(|| {
            activation_manager()?;
            Ok(())
        })?;
    }
    Ok(())
}
impl PackagedApp {
    pub(crate) fn activate(&self, args: &[String]) -> Result<u32, String> {
        let args = wide(&arguments(args)?);
        let aumid = wide(&self.aumid);
        super::windows_integration::com(|| unsafe {
            activation_manager()?
                .ActivateApplication(PCWSTR(aumid.as_ptr()), PCWSTR(args.as_ptr()), AO_NOERRORUI)
                .map_err(|e| failure("商店应用激活失败，未回退到直接 EXE 启动", e))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn activation_arguments_round_trip_without_shell_interpretation() {
        let args: Vec<String> = [
            "",
            "--user-data-dir=D:\\资料 目录\\",
            "--profile-directory=Profile 2",
            "a\\\"b",
            "--proxy-bypass-list=<-loopback>;localhost",
            "& x | y %PATH%",
            "😀",
        ]
        .into_iter()
        .map(String::from)
        .collect();
        let decoded = super::super::windows_integration::split_arguments(&format!(
            "app.exe {}",
            arguments(&args).unwrap()
        ))
        .unwrap();
        assert_eq!(&decoded[1..], args);
        assert!(arguments(&["bad\0arg".into()]).is_err());
        assert!(arguments(&["x".repeat(32767)]).is_err());
    }
    #[test]
    fn package_paths_reject_escape_and_ordinary_exes_remain_direct() {
        let root = Path::new("C:\\Package");
        for path in [
            "../app.exe",
            "C:\\other.exe",
            "\\other.exe",
            "",
            "app/../../other.exe",
            "app.exe:stream",
        ] {
            assert!(child_path(root, path).is_err());
        }
        assert_eq!(
            child_path(root, "app/client.exe").unwrap(),
            root.join("app/client.exe")
        );
        assert!(resolve(&std::env::current_exe().unwrap())
            .unwrap()
            .is_none());
        assert!(resolve(Path::new(
            "C:\\WindowsApps\\ProcWeaverMissingPackage\\app.exe"
        ))
        .is_err());
    }
    #[test]
    fn installed_chatgpt_metadata_is_registered_and_exact_without_launching() {
        let Some(exe) = find("OpenAI.Codex_2p2nqsd0c76g0", "ChatGPT.exe").unwrap() else {
            return;
        };
        let app = resolve(&exe)
            .unwrap()
            .expect("商店主程序不可按普通 EXE 启动");
        assert_eq!(app.aumid, "OpenAI.Codex_2p2nqsd0c76g0!App");
        assert!(app.full_name.starts_with("OpenAI.Codex_"));
        assert!(exe.is_file());
        preflight(&exe, &["--proxy-server=http://127.0.0.1:34000".into()]).unwrap();
        let alias = exe
            .parent()
            .unwrap()
            .join("..")
            .join("app")
            .join("ChatGPT.exe");
        assert_eq!(resolve(&alias).unwrap().unwrap().aumid, app.aumid);
        let helper = exe.parent().unwrap().join("resources").join("codex.exe");
        if helper.is_file() {
            assert!(
                resolve(&helper).unwrap().is_none(),
                "包内 CLI 不是清单声明的主应用入口"
            );
        }
        println!("已核验安装包注册、主程序与 AUMID；未启动、关闭或重启 ChatGPT");
    }
    #[test]
    fn failed_activation_returns_error_without_a_direct_exe_fallback() {
        let app = PackagedApp {
            executable: PathBuf::from("C:\\nonexistent.exe"),
            aumid: "ProcWeaver.NonexistentFixture_0000000000000!App".into(),
            full_name: String::new(),
        };
        assert!(app.activate(&[]).unwrap_err().contains("未回退到直接 EXE"));
    }
}

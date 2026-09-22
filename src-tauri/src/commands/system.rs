use tauri::command;

#[cfg(windows)]
mod platform {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;

    #[link(name = "shell32")]
    extern "system" {
        fn IsUserAnAdmin() -> i32;
        fn ShellExecuteW(
            hwnd: isize,
            lpOperation: *const u16,
            lpFile: *const u16,
            lpParameters: *const u16,
            lpDirectory: *const u16,
            nShowCmd: i32,
        ) -> isize;
    }

    pub fn is_admin() -> bool {
        unsafe { IsUserAnAdmin() != 0 }
    }

    pub fn restart_as_admin() -> Result<(), String> {
        let current_exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let exe_w: Vec<u16> = current_exe.as_os_str().encode_wide().chain(Some(0)).collect();
        let op_w: Vec<u16> = OsStr::new("runas").encode_wide().chain(Some(0)).collect();

        // 收集启动命令行参数 (跳过第一个 argv[0])
        let args: Vec<String> = std::env::args().skip(1).collect();
        let args_str = args.join(" ");
        let args_w: Vec<u16> = OsStr::new(&args_str).encode_wide().chain(Some(0)).collect();

        let working_dir = current_exe.parent().unwrap_or_else(|| std::path::Path::new("."));
        let dir_w: Vec<u16> = working_dir.as_os_str().encode_wide().chain(Some(0)).collect();

        unsafe {
            let ret = ShellExecuteW(
                0,
                op_w.as_ptr(),
                exe_w.as_ptr(),
                if args.is_empty() { std::ptr::null() } else { args_w.as_ptr() },
                dir_w.as_ptr(),
                1,
            );
            if ret > 32 {
                std::process::exit(0);
            } else if ret == 1223 {
                Err("用户取消了 UAC 管理员提权授权".into())
            } else {
                Err(format!("管理员自提权启动失败，ShellExecute 状态代码: {}", ret))
            }
        }
    }
}

#[cfg(not(windows))]
mod platform {
    pub fn is_admin() -> bool {
        true
    }

    pub fn restart_as_admin() -> Result<(), String> {
        Ok(())
    }
}

/// 检测当前运行进程是否拥有 Administrator 管理员权限
#[command]
pub fn check_is_admin() -> bool {
    platform::is_admin()
}

/// 一键唤起 Windows UAC 以管理员身份重新拉起实例并退出当前低权限实例
#[command]
pub fn restart_elevated() -> Result<(), String> {
    platform::restart_as_admin()
}

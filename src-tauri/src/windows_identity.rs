//! 主程序不能借用目标同为 ProcWeaver.exe 的业务快捷方式图标和任务栏分组。
use windows::{core::PCWSTR, Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID};

/// 必须在创建窗口和托盘前调用；沿用打包配置的 identifier，升级后身份不变。
pub fn initialize(identifier: &str) -> windows::core::Result<()> {
    let wide: Vec<u16> = identifier.encode_utf16().chain(Some(0)).collect();
    unsafe { SetCurrentProcessExplicitAppUserModelID(PCWSTR(wide.as_ptr())) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::Win32::{System::Com::CoTaskMemFree, UI::Shell::GetCurrentProcessExplicitAppUserModelID};

    #[test]
    fn native_taskbar_identity_replaces_inherited_launcher_identity() {
        const FLAG: &str = "PROCWEAVER_TASKBAR_IDENTITY_TEST_CHILD";
        if std::env::var_os(FLAG).is_none() {
            // 身份是进程全局状态，在独立子进程测试，不污染其他测试或用户实例。
            let status = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "windows_identity::tests::native_taskbar_identity_replaces_inherited_launcher_identity", "--nocapture"])
                .env(FLAG, "1").status().unwrap();
            assert!(status.success());
            return;
        }
        fn current() -> String {
            unsafe {
                let pointer = GetCurrentProcessExplicitAppUserModelID().unwrap();
                let value = pointer.to_string().unwrap();
                CoTaskMemFree(Some(pointer.0.cast()));
                value
            }
        }
        let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let identifier = config["identifier"].as_str().unwrap();
        initialize("ProcWeaver.Test.BusinessLauncher").unwrap();
        assert_ne!(current(), identifier);
        initialize(identifier).unwrap();
        assert_eq!(current(), identifier);
        initialize(identifier).unwrap();
        assert_eq!(current(), identifier, "重复初始化不得改变主程序身份");
    }
}

pub mod apps;
pub mod guardian;
pub mod processes;
pub mod sysproxy;

use std::{io::Read, process::{Command, Output, Stdio}, time::{Duration, Instant}};

/// 固定系统工具 + 独立 argv；不经过 shell，不把用户值拼进脚本。
pub fn output(program: &str, args: &[&str], timeout: Duration) -> Result<Output, String> {
    let mut child = Command::new(program).args(args).env("LC_ALL", "C")
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()
        .map_err(|_| "无法启动 macOS 系统工具")?;
    let read = |pipe: Box<dyn Read + Send>| std::thread::spawn(move || {
        let mut bytes = Vec::new(); pipe.take(1024 * 1024).read_to_end(&mut bytes).map(|_| bytes)
    });
    let stdout = read(Box::new(child.stdout.take().ok_or("系统工具输出不可读")?));
    let stderr = read(Box::new(child.stderr.take().ok_or("系统工具错误输出不可读")?));
    let start = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|_| "读取系统工具状态失败")? { break status; }
        if start.elapsed() >= timeout {
            let _ = child.kill(); let _ = child.wait();
            return Err("macOS 系统操作超时，未确认成功".into());
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    Ok(Output { status,
        stdout: stdout.join().map_err(|_| "读取系统工具结果失败")?.map_err(|_| "读取系统工具结果失败")?,
        stderr: stderr.join().map_err(|_| "读取系统工具结果失败")?.map_err(|_| "读取系统工具结果失败")? })
}

pub fn text(program: &str, args: &[&str]) -> Result<String, String> {
    let result = output(program, args, Duration::from_secs(8))?;
    if !result.status.success() { return Err("macOS 系统操作失败，请检查当前用户权限；未确认变更生效".into()); }
    String::from_utf8(result.stdout).map(|s| s.trim_end().to_owned()).map_err(|_| "系统工具返回了无效文本".into())
}

//! 独立小进程监视宿主身份；不依赖 GUI 的析构或退出回调。
use std::{io::{BufRead, Write}, process::{Child, Command, Stdio}, sync::Mutex, time::Duration};
use super::processes::inspect;
const FLAG: &str = "--procweaver-core-guardian";
// Keep the child handle until its successor is ready. It also prevents an
// unreaped guardian PID from being mistaken for a different process.
static CURRENT: Mutex<Option<Child>> = Mutex::new(None);

pub fn bind(core: &Child) -> Result<(), String> {
    let parent = inspect(std::process::id(), 0, String::new());
    let child = inspect(core.id(), 0, String::new());
    if parent.identity.is_empty() || child.identity.is_empty() || child.parent_pid != parent.pid {
        return Err("无法确认核心父子身份，未启动核心保护".into());
    }
    let mut guard = Command::new(std::env::current_exe().map_err(|_| "无法读取客户端路径")?)
        .args([FLAG, &parent.pid.to_string(), &parent.identity, &child.pid.to_string(), &child.identity])
        .arg(super::sysproxy::journal_path())
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null())
        .spawn().map_err(|_| "启动核心保护失败")?;
    let stdout = guard.stdout.take().ok_or("核心保护握手失败")?;
    let (send, receive) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut ready = String::new();
        let _ = std::io::BufReader::new(stdout).read_line(&mut ready);
        let _ = send.send(ready == "ready\n");
    });
    if receive.recv_timeout(Duration::from_secs(5)) != Ok(true) {
        let _ = guard.kill(); let _ = guard.wait();
        return Err("核心保护未就绪，已取消启动".into());
    }
    let mut current = match CURRENT.lock() {
        Ok(current) => current,
        Err(_) => {
            let _ = guard.kill(); let _ = guard.wait();
            return Err("核心保护状态锁不可用".into());
        }
    };
    if !matches!(guard.try_wait(), Ok(None)) {
        let _ = guard.kill(); let _ = guard.wait();
        return Err("新核心保护进程已退出，未交接旧保护进程".into());
    }
    if let Some(mut previous) = current.take() {
        // During restart the old guardian covers the gap after the old core
        // stops. The new guardian has acknowledged readiness before retiring it.
        let retired = match previous.try_wait() {
            Ok(Some(_)) => true,
            Ok(None) => previous.kill().is_ok() || previous.try_wait().is_ok_and(|status| status.is_some()),
            Err(_) => false,
        };
        if !retired {
            let _ = guard.kill(); let _ = guard.wait();
            *current = Some(previous);
            return Err("旧核心保护进程未能交接，已取消新核心启动".into());
        }
        let _ = previous.wait();
    }
    *current = Some(guard);
    Ok(())
}

pub fn run_if_requested() -> bool {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) != Some(FLAG) { return false; }
    let run = || -> Option<()> {
        if args.len() != 7 { return None; }
        let parent_pid: u32 = args[2].parse().ok()?;
        let core_pid: u32 = args[4].parse().ok()?;
        let parent = inspect(parent_pid, 0, String::new());
        let core = inspect(core_pid, 0, String::new());
        // 仅允许真实父进程对其刚创建的 Mihomo 子进程建立保护。
        if unsafe { libc::getppid() } as u32 != parent_pid || parent.identity != args[3]
            || core.identity != args[5] || core.parent_pid != parent_pid
            || parent.executable_path.as_deref() != std::env::current_exe().ok()?.to_str()
            || !matches!(std::path::Path::new(core.executable_path.as_deref()?).file_name()?.to_str()?, "mihomo-darwin-arm64" | "mihomo-darwin-amd64") { return None; }
        println!("ready"); let _ = std::io::stdout().flush();
        let journal_path = std::path::Path::new(&args[6]);
        loop {
            let core_alive = inspect(core_pid, 0, String::new()).identity == args[5];
            if inspect(parent_pid, 0, String::new()).identity != args[3] {
                if core_alive {
                    unsafe { libc::kill(core_pid as i32, libc::SIGTERM); }
                    std::thread::sleep(Duration::from_secs(2));
                    if inspect(core_pid, 0, String::new()).identity == args[5] { unsafe { libc::kill(core_pid as i32, libc::SIGKILL); } }
                }
                // Restore only this parent's still-owned endpoint. Permission denial
                // leaves the journal for the next GUI startup to retry.
                if let Err(error) = super::sysproxy::recover_for_dead_owner(journal_path, &args[3]) {
                    eprintln!("核心保护恢复系统代理失败：{error}");
                }
                break;
            }
            // A restart keeps the proxy active while the old core exits. Stay alive
            // until that owner's recovery record is gone, so a crash in the gap
            // cannot leave the system proxy pointed at the stopped core.
            if !core_alive {
                match super::sysproxy::owns_recovery(journal_path, &args[3]) {
                    Ok(false) => break,
                    Ok(true) => {},
                    Err(error) => eprintln!("核心保护读取系统代理恢复记录失败：{error}"),
                }
            }
            std::thread::sleep(Duration::from_millis(250));
        }
        Some(())
    };
    let _ = run();
    true
}

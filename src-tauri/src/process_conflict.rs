//! Older full clients cannot participate in a shared capture lease. Refuse their
//! presence instead of changing their network mode or trying to stop their driver.
fn known_capture_host(name: &str) -> bool {
    matches!(name.to_ascii_lowercase().as_str(), "procweaver.exe" | "netbox.exe" |
        "mihomo.exe" | "mihomo-compatible.exe" | "mihomo-v3.exe")
}

pub(crate) fn check() -> Result<(), String> {
    let processes = crate::routing_overrides::native::process_list()
        .map_err(|_| "无法核实其他接管实例，保持纯应用层；请稍后重试 WinDivert")?;
    for p in processes {
        if p.pid == std::process::id() || !known_capture_host(&p.name) { continue; }
        let identity = crate::routing_overrides::native::inspect(p.pid, p.parent_pid, p.name.clone());
        let verified = identity.created_at > 0 && identity.executable_path.as_ref().is_some_and(|p| !p.is_empty());
        return Err(format!("检测到 {}（PID {}{}）。独立进程版无法确认其 TUN/WinDivert 状态，暂不启用驱动；可继续使用纯应用层。请正常退出冲突客户端后重试。",
            p.name, p.pid, if verified { "，身份已核实" } else { "，身份不可读取" }));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn shared_runtimes_are_not_capture_hosts() {
        assert!(super::known_capture_host("ProcWeaver.EXE"));
        assert!(super::known_capture_host("mihomo-v3.exe"));
        for name in ["node.exe", "cmd.exe", "ProcWeaverProcess.exe", "chrome.exe"] {
            assert!(!super::known_capture_host(name));
        }
    }
}

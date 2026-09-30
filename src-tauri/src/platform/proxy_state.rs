//! macOS networksetup 输出解析和恢复判定，可在 Windows 执行边界测试。
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Proxy { pub enabled: bool, pub server: String, pub port: u16, pub authenticated: bool }
pub fn owner_pid(identity: &str) -> Option<u32> {
    let (pid, created) = identity.split_once(':')?;
    let pid = pid.parse::<u32>().ok()?;
    let created = created.parse::<u64>().ok()?;
    (pid > 0 && created > 0).then_some(pid)
}
pub fn parse(raw: &str) -> Result<Proxy, String> {
    let field = |key| raw.lines().find_map(|line| line.strip_prefix(key).map(str::trim));
    let enabled = match field("Enabled:") { Some("Yes") => true, Some("No") => false, _ => return Err("代理状态不可读".into()) };
    let authenticated = match field("Authenticated Proxy Enabled:") { Some("1") => true, Some("0") => false, _ => return Err("代理认证状态不可读".into()) };
    Ok(Proxy { enabled, authenticated, server: field("Server:").ok_or("代理地址不可读")?.into(),
        port: field("Port:").ok_or("代理端口不可读")?.parse().map_err(|_| "代理端口无效")? })
}
pub fn owns_endpoint(value: &Proxy, port: u16) -> bool { value.server == "127.0.0.1" && value.port == port && !value.authenticated }
pub fn safe_core_handoff(owner_matches: bool, service_matches: bool, current: &[Proxy], port: u16) -> bool {
    owner_matches && service_matches && port > 0 && current.len() == 3 &&
        current.iter().all(|value| value.enabled && owns_endpoint(value, port))
}
pub fn needs_restore(now: &Proxy, original: &Proxy, port: u16) -> bool { now != original && owns_endpoint(now, port) }
pub fn restore_incomplete(now: &Proxy, original: &Proxy, port: u16) -> bool {
    needs_restore(now, original, port)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_disabled_and_authenticated_without_collecting_credentials() {
        assert_eq!(parse("Enabled: No\nServer: \nPort: 0\nAuthenticated Proxy Enabled: 0\n").unwrap(), Proxy { enabled: false, server: String::new(), port: 0, authenticated: false });
        assert!(parse("Enabled: Yes\nServer: external\nPort: 8080\nAuthenticated Proxy Enabled: 1\n").unwrap().authenticated);
        for raw in ["Error: insufficient permission", "Enabled: No\nServer:\nPort: 0", "Enabled: Yes\nServer: host\nPort: 70000\nAuthenticated Proxy Enabled: 0"] { assert!(parse(raw).is_err()); }
    }
    #[test]
    fn restore_owns_only_its_endpoint_and_never_reports_enabled_leftovers_restored() {
        let original = Proxy { enabled: false, server: String::new(), port: 0, authenticated: false };
        let mut current = Proxy { enabled: true, server: "127.0.0.1".into(), port: 7890, authenticated: false };
        assert!(needs_restore(&current, &original, 7890));
        assert!(restore_incomplete(&current, &original, 7890));
        current.enabled = false;
        assert!(restore_incomplete(&current, &original, 7890), "关闭开关后残留的本程序地址和端口仍须恢复");
        current.server = "other-proxy".into();
        assert!(!needs_restore(&current, &original, 7890));
        current.server = "127.0.0.1".into(); current.authenticated = true;
        assert!(!needs_restore(&current, &original, 7890));
    }
    #[test]
    fn recovery_owner_requires_a_real_pid_and_creation_identity() {
        assert_eq!(owner_pid("123:456"), Some(123));
        for value in ["", "123", "0:456", "123:0", "abc:456", "123:abc", "123:456:789"] {
            assert_eq!(owner_pid(value), None);
        }
    }
    #[test]
    fn core_handoff_requires_the_current_owner_service_and_all_live_proxy_endpoints() {
        let active = Proxy { enabled: true, server: "127.0.0.1".into(), port: 7890, authenticated: false };
        let all_active = vec![active.clone(); 3];
        assert!(safe_core_handoff(true, true, &all_active, 7890));
        assert!(!safe_core_handoff(false, true, &all_active, 7890), "旧实例的恢复记录不得供新核心接管");
        assert!(!safe_core_handoff(true, false, &all_active, 7890), "网络服务切换后不得直接启动");
        assert!(!safe_core_handoff(true, true, &[], 7890));
        let mut incomplete = all_active;
        incomplete[1].enabled = false;
        assert!(!safe_core_handoff(true, true, &incomplete, 7890), "部分关闭或残留的代理必须先恢复");
    }
}

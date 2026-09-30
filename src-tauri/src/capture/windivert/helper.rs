//! P0 native helper protocol. Not an application startup path or a production
//! elevation installer. Fixed probe/ping/stop commands cannot intercept traffic.
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::{ffi::c_void, io, os::windows::{io::AsRawHandle, process::CommandExt}, path::Path, process::{Child, Command, Stdio}, time::Duration};
use tokio::{io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt}, net::windows::named_pipe::{ClientOptions, NamedPipeServer, ServerOptions}};
use windows_sys::Win32::{Foundation::{CloseHandle, LocalFree}, Security::{GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER, SECURITY_ATTRIBUTES}, System::Threading::{GetCurrentProcess, OpenProcessToken}};

const VERSION: u32 = 1;
const FRAME_LIMIT: usize = 4096;
const DEADLINE: Duration = Duration::from_secs(5);

#[link(name = "advapi32")]
extern "system" {
    fn ConvertSidToStringSidW(sid: *mut c_void, value: *mut *mut u16) -> i32;
    fn ConvertStringSecurityDescriptorToSecurityDescriptorW(text: *const u16, revision: u32, descriptor: *mut *mut c_void, size: *mut u32) -> i32;
}
#[link(name = "kernel32")]
extern "system" {
    fn GetNamedPipeClientProcessId(pipe: *mut c_void, pid: *mut u32) -> i32;
    fn GetNamedPipeServerProcessId(pipe: *mut c_void, pid: *mut u32) -> i32;
    fn ProcessIdToSessionId(pid: u32, session: *mut u32) -> i32;
}
#[link(name = "bcrypt")]
extern "system" { fn BCryptGenRandom(algorithm: *mut c_void, bytes: *mut u8, size: u32, flags: u32) -> i32; }

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "command", rename_all = "camelCase", deny_unknown_fields)]
pub enum Operation { Ping {}, Probe {}, Stop {} }

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request { pub version: u32, pub sequence: u64, pub operation: Operation }

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Reply { pub version: u32, pub sequence: u64, pub helper_pid: u32, pub result: Result<serde_json::Value, String> }

fn protocol_error(message: &str) -> io::Error { io::Error::new(io::ErrorKind::InvalidData, message) }

async fn read_frame<T: DeserializeOwned>(stream: &mut (impl AsyncRead + Unpin)) -> io::Result<T> {
    tokio::time::timeout(DEADLINE, async {
        let length = stream.read_u32_le().await? as usize;
        if length == 0 || length > FRAME_LIMIT { return Err(protocol_error("控制消息长度无效")); }
        let mut bytes = vec![0; length]; stream.read_exact(&mut bytes).await?;
        serde_json::from_slice(&bytes).map_err(|_| protocol_error("控制消息结构无效"))
    }).await.map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "控制通道超时"))?
}
async fn write_frame<T: Serialize>(stream: &mut (impl AsyncWrite + Unpin), value: &T) -> io::Result<()> {
    let bytes = serde_json::to_vec(value).map_err(|_| protocol_error("控制消息序列化失败"))?;
    if bytes.len() > FRAME_LIMIT { return Err(protocol_error("控制消息超过限制")); }
    tokio::time::timeout(DEADLINE, async {
        stream.write_u32_le(bytes.len() as u32).await?;
        stream.write_all(&bytes).await?; stream.flush().await
    }).await.map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "控制通道发送超时"))?
}

pub(crate) fn nonce() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    if unsafe { BCryptGenRandom(std::ptr::null_mut(), bytes.as_mut_ptr(), 32, 2) } < 0 { return Err("无法创建 helper 会话".into()); }
    Ok(bytes.iter().map(|v| format!("{v:02x}")).collect())
}
pub(crate) fn pipe_name(pid: u32, nonce: &str) -> Result<String, String> {
    if pid == 0 || nonce.len() != 64 || !nonce.bytes().all(|v| v.is_ascii_hexdigit()) { return Err("helper 会话标识无效".into()); }
    Ok(format!(r"\\.\pipe\ProcWeaver.Capture.P0.{pid}.{nonce}"))
}

struct LocalAllocation(*mut c_void);
impl Drop for LocalAllocation { fn drop(&mut self) { unsafe { LocalFree(self.0); } } }

fn user_sid() -> Result<String, String> {
    unsafe {
        let mut token = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 { return Err("无法核实会话用户".into()); }
        let mut size = 0;
        GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut size);
        if size == 0 || size > 8192 { CloseHandle(token); return Err("用户令牌长度无效".into()); }
        let mut bytes = vec![0usize; (size as usize).div_ceil(std::mem::size_of::<usize>())];
        let ok = GetTokenInformation(token, TokenUser, bytes.as_mut_ptr().cast(), size, &mut size);
        CloseHandle(token);
        if ok == 0 { return Err("无法读取会话用户".into()); }
        let user = &*bytes.as_ptr().cast::<TOKEN_USER>();
        let mut text = std::ptr::null_mut();
        if ConvertSidToStringSidW(user.User.Sid, &mut text) == 0 { return Err("无法读取会话用户 SID".into()); }
        let _allocation = LocalAllocation(text.cast());
        let length = (0..256).find(|i| *text.add(*i) == 0).ok_or("用户 SID 无效")?;
        Ok(String::from_utf16_lossy(std::slice::from_raw_parts(text, length)))
    }
}

pub(crate) fn create_server(name: &str) -> Result<NamedPipeServer, String> {
    // Protected DACL: current user, Administrators and SYSTEM only. Remote clients
    // are rejected, and later kernel PID checks prevent same-user impersonation.
    let sddl: Vec<u16> = format!("D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGW;;;{})\0", user_sid()?).encode_utf16().collect();
    unsafe {
        let mut descriptor = std::ptr::null_mut();
        if ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.as_ptr(), 1, &mut descriptor, std::ptr::null_mut()) == 0 {
            return Err("创建控制通道 ACL 失败".into());
        }
        let _allocation = LocalAllocation(descriptor);
        let mut attrs = SECURITY_ATTRIBUTES { nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: descriptor, bInheritHandle: 0 };
        ServerOptions::new().first_pipe_instance(true).reject_remote_clients(true).max_instances(1)
            .create_with_security_attributes_raw(name, (&mut attrs as *mut SECURITY_ATTRIBUTES).cast())
            .map_err(|_| "创建独占 helper 控制通道失败".into())
    }
}

pub(crate) fn same_session(pid: u32) -> bool {
    let (mut own, mut peer) = (0, 0);
    unsafe { ProcessIdToSessionId(std::process::id(), &mut own) != 0 && ProcessIdToSessionId(pid, &mut peer) != 0 && own == peer }
}
fn identity(pid: u32) -> crate::routing_overrides::tracker::ProcessEntry {
    crate::routing_overrides::native::inspect(pid, 0, String::new())
}

struct OwnedChild(Child);
impl Drop for OwnedChild {
    fn drop(&mut self) {
        // A Child handle names our exact process, not a name or a reused PID.
        if self.0.try_wait().ok().flatten().is_none() { let _ = self.0.kill(); }
        let _ = self.0.wait();
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionReport {
    pub authenticated_peer: bool,
    pub probe: serde_json::Value,
    pub helper_exited: bool,
    pub production_ready: bool,
}

/// Local-only prototype: spawn the same diagnostic executable with a fixed entry
/// flag. It deliberately does not restart/elevate the normal UI application.
pub async fn run_probe_session() -> Result<SessionReport, String> {
    let own = identity(std::process::id());
    if own.created_at == 0 { return Err("无法核实宿主进程实例".into()); }
    let nonce = nonce()?;
    let mut pipe = create_server(&pipe_name(own.pid, &nonce)?)?;
    let exe = std::env::current_exe().map_err(|_| "无法定位检查程序")?;
    let mut child = OwnedChild(Command::new(&exe).args(["--helper", &own.pid.to_string(), &own.created_at.to_string(), &nonce])
        .creation_flags(0x08000000).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().map_err(|_| "创建隔离 helper 失败")?);
    let child_identity = identity(child.0.id());
    if child_identity.created_at == 0 || !same_session(child.0.id()) { return Err("无法核实 helper 实例或会话".into()); }
    tokio::time::timeout(DEADLINE, pipe.connect()).await.map_err(|_| "helper 连接超时")?.map_err(|_| "helper 连接失败")?;
    let mut client_pid = 0;
    if unsafe { GetNamedPipeClientProcessId(pipe.as_raw_handle(), &mut client_pid) } == 0 || client_pid != child.0.id()
        || identity(client_pid).created_at != child_identity.created_at { return Err("控制通道客户端身份不匹配".into()); }
    let mut probe = serde_json::Value::Null;
    for (index, operation) in [Operation::Ping {}, Operation::Probe {}, Operation::Stop {}].into_iter().enumerate() {
        let sequence = index as u64 + 1;
        write_frame(&mut pipe, &Request { version: VERSION, sequence, operation }).await.map_err(|e| e.to_string())?;
        let reply: Reply = read_frame(&mut pipe).await.map_err(|e| e.to_string())?;
        if reply.version != VERSION || reply.sequence != sequence || reply.helper_pid != child.0.id() { return Err("helper 回复代次或身份不匹配".into()); }
        let result = reply.result?;
        if sequence == 2 { probe = result; }
    }
    drop(pipe);
    let deadline = tokio::time::Instant::now() + DEADLINE;
    loop {
        if let Some(status) = child.0.try_wait().map_err(|_| "读取 helper 退出状态失败")? {
            if !status.success() { return Err("helper 异常退出".into()); }
            break;
        }
        if tokio::time::Instant::now() >= deadline { return Err("helper 停止超时，已终止本实例检查进程".into()); }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    Ok(SessionReport { authenticated_peer: true, probe, helper_exited: true, production_ready: false })
}

pub async fn serve(parent_pid: u32, parent_created: u64, nonce: &str, components: &Path) -> Result<(), String> {
    let expected = identity(parent_pid);
    let own = identity(std::process::id());
    if parent_created == 0 || expected.created_at != parent_created || !same_session(parent_pid)
        || expected.executable_path.is_none() || expected.executable_path != own.executable_path {
        return Err("helper 宿主实例、程序路径或会话不匹配".into());
    }
    let name = pipe_name(parent_pid, nonce)?;
    let mut pipe = ClientOptions::new().open(name).map_err(|_| "无法连接宿主控制通道")?;
    let mut server_pid = 0;
    if unsafe { GetNamedPipeServerProcessId(pipe.as_raw_handle(), &mut server_pid) } == 0
        || server_pid != parent_pid || identity(parent_pid).created_at != parent_created {
        return Err("控制通道服务端身份不匹配".into());
    }
    let mut expected_sequence = 1u64;
    loop {
        // EOF, invalid input or an idle/lost host ends this helper. No driver
        // handle survives a command: probe() closes it before replying.
        let request: Request = read_frame(&mut pipe).await.map_err(|e| e.to_string())?;
        if request.version != VERSION || request.sequence != expected_sequence { return Err("控制协议版本或请求代次无效".into()); }
        expected_sequence = expected_sequence.checked_add(1).ok_or("控制请求代次耗尽")?;
        let stop = matches!(request.operation, Operation::Stop {});
        let result = match request.operation {
            Operation::Ping {} => Ok(serde_json::json!({"state":"probeOnly","productionReady":false})),
            Operation::Probe {} => super::preflight::probe(components).and_then(|r| serde_json::to_value(r).map_err(|_| "序列化检查结果失败".into())),
            Operation::Stop {} => Ok(serde_json::json!({"state":"stopped"})),
        };
        write_frame(&mut pipe, &Reply { version: VERSION, sequence: request.sequence, helper_pid: std::process::id(), result }).await.map_err(|e| e.to_string())?;
        if stop { return Ok(()); }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn frames_reject_oversize_unknown_command_and_extra_fields() {
        let (mut tx, mut rx) = tokio::io::duplex(8192);
        tx.write_u32_le((FRAME_LIMIT + 1) as u32).await.unwrap();
        assert_eq!(read_frame::<Request>(&mut rx).await.unwrap_err().kind(), io::ErrorKind::InvalidData);
        for body in [r#"{"version":1,"sequence":1,"operation":{"command":"execute","path":"x"}}"#,
            r#"{"version":1,"sequence":1,"operation":{"command":"probe"},"filter":"true"}"#,
            r#"{"version":1,"sequence":1,"operation":{"command":"probe","path":"x"}}"#] {
            let (mut tx, mut rx) = tokio::io::duplex(8192);
            tx.write_u32_le(body.len() as u32).await.unwrap(); tx.write_all(body.as_bytes()).await.unwrap();
            assert!(read_frame::<Request>(&mut rx).await.is_err());
        }
    }
    #[tokio::test]
    async fn frame_roundtrip_and_disconnect_are_bounded() {
        let (mut tx, mut rx) = tokio::io::duplex(8192);
        write_frame(&mut tx, &Request { version:1, sequence:7, operation:Operation::Ping {} }).await.unwrap();
        let value: Request = read_frame(&mut rx).await.unwrap();
        assert_eq!(value.sequence, 7); assert!(matches!(value.operation, Operation::Ping {}));
        drop(tx); assert_eq!(read_frame::<Request>(&mut rx).await.unwrap_err().kind(), io::ErrorKind::UnexpectedEof);
    }
    #[tokio::test]
    async fn native_pipe_namespace_is_exclusive() {
        let name = pipe_name(std::process::id(), &nonce().unwrap()).unwrap();
        let _server = create_server(&name).unwrap();
        assert!(create_server(&name).is_err());
        assert!(pipe_name(1, "../pipe").is_err());
    }
}

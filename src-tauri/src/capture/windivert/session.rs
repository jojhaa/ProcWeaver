//! Authenticated, local, bounded control channel to an explicitly elevated helper.
//! The host never loads a driver. Closing this session stops our helper only.
use super::{
    assets, helper,
    ownership::Identity,
    plan::Plan,
    runtime::{Engine, Stats},
};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::os::windows::io::AsRawHandle;
use std::{
    io,
    sync::{mpsc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::windows::named_pipe::{ClientOptions, NamedPipeServer},
};
const DEADLINE: Duration = Duration::from_secs(8);
const LIMIT: usize = 1048576;
static SESSION: Mutex<Option<Session>> = Mutex::new(None);
static STATS: Mutex<Stats> = Mutex::new(Stats {
    active: false,
    tcp: 0,
    udp: 0,
    dns: 0,
    unknown: 0,
    failures: 0,
});
static ERROR: Mutex<Option<String>> = Mutex::new(None);
#[derive(Serialize, Deserialize)]
#[serde(tag = "command", rename_all = "camelCase", deny_unknown_fields)]
enum Operation {
    Start { plan: Plan, core: Identity },
    Update { plan: Plan },
    Instances { instances: Vec<super::plan::Instance> },
    Pause {},
    Ping {},
    Stop {},
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    version: u32,
    sequence: u64,
    operation: Operation,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Reply {
    version: u32,
    sequence: u64,
    pid: u32,
    result: Result<Stats, String>,
}
type Response = mpsc::Sender<Result<Stats, String>>;
struct Session {
    tx: mpsc::Sender<(Operation, Response)>,
    thread: Option<std::thread::JoinHandle<()>>,
    plan: Plan,
    core: Identity,
    paused: bool,
}
#[link(name = "kernel32")]
extern "system" {
    fn GetNamedPipeClientProcessId(pipe: *mut std::ffi::c_void, pid: *mut u32) -> i32;
    fn GetNamedPipeServerProcessId(pipe: *mut std::ffi::c_void, pid: *mut u32) -> i32;
}
async fn read<T: DeserializeOwned>(s: &mut (impl AsyncRead + Unpin)) -> Result<T, String> {
    tokio::time::timeout(DEADLINE, async {
        let n = s.read_u32_le().await? as usize;
        if n == 0 || n > LIMIT {
            return Err(io::Error::other("控制消息大小无效"));
        }
        let mut data = vec![0; n];
        s.read_exact(&mut data).await?;
        serde_json::from_slice(&data).map_err(|_| io::Error::other("控制消息无效"))
    })
    .await
    .map_err(|_| "接管控制通道超时".to_string())?
    .map_err(|e| e.to_string())
}
async fn write<T: Serialize>(s: &mut (impl AsyncWrite + Unpin), v: &T) -> Result<(), String> {
    let bytes = serde_json::to_vec(v).map_err(|_| "控制消息编码失败")?;
    if bytes.len() > LIMIT {
        return Err("控制消息过大".into());
    }
    tokio::time::timeout(DEADLINE, async {
        s.write_u32_le(bytes.len() as u32).await?;
        s.write_all(&bytes).await?;
        s.flush().await
    })
    .await
    .map_err(|_| "发送接管请求超时".to_string())?
    .map_err(|_| "接管通道已断开".into())
}
pub fn stats() -> Stats {
    STATS.lock().unwrap().clone()
}
pub fn error() -> Option<String> {
    ERROR.lock().unwrap().clone()
}
pub fn stop() {
    if let Some(mut session) = SESSION.lock().unwrap().take() {
        let (tx, rx) = mpsc::channel();
        let _ = session.tx.send((Operation::Stop {}, tx));
        let _ = rx.recv_timeout(DEADLINE + Duration::from_secs(3));
        drop(session.tx);
        if let Some(thread) = session.thread.take() {
            let _ = thread.join();
        }
    }
    STATS.lock().unwrap().active = false;
    *ERROR.lock().unwrap() = None;
}
pub fn pause() {
    if let Some(session) = SESSION.lock().unwrap().as_mut() {
        let (tx, rx) = mpsc::channel();
        session.paused = true;
        let _ = session.tx.send((Operation::Pause {}, tx));
        let _ = rx.recv_timeout(DEADLINE);
    }
}
pub async fn confirm(plan: Plan, core_pid: u32) -> Result<(), String> {
    tokio::task::spawn_blocking(move || confirm_blocking(plan, core_pid))
        .await
        .map_err(|_| "接管任务异常")?
}
/// Observer updates are memory-only: no YAML writes, core reload or new helper.
pub async fn refresh_instances(config: &crate::routing_overrides::model::Overrides,
    state: &crate::routing_overrides::tracker::TrackingStatus, core_pid: u32) -> Result<(), String> {
    let (mut plan, _) = confirmed_plan(core_pid).ok_or("WinDivert 尚未确认当前核心入口")?;
    plan.refresh_instances(config, state)?;
    confirm(plan, core_pid).await
}
fn confirm_blocking(plan: Plan, core_pid: u32) -> Result<(), String> {
    plan.validate()?;
    let core = Identity::inspect(core_pid).ok_or("无法核实当前核心身份")?;
    let mut holder = SESSION.lock().unwrap();
    if let Some(session) = holder.as_mut() {
        if session.core != core {
            return Err("接管核心实例已改变，请重新启用模式".into());
        }
        if let Some(error) = error() {
            return Err(error);
        }
        if session.plan == plan && stats().active && !session.paused {
            return Ok(());
        }
        let (tx, rx) = mpsc::channel();
        let operation = if !session.paused && session.plan.entries == plan.entries && session.plan.targets == plan.targets {
            Operation::Instances { instances: plan.instances.clone() }
        } else { Operation::Update { plan: plan.clone() } };
        session
            .tx
            .send((operation, tx))
            .map_err(|_| "接管辅助进程已停止")?;
        rx.recv_timeout(DEADLINE + Duration::from_secs(1))
            .map_err(|_| "接管配置确认超时")??;
        session.plan = plan;
        session.paused = false;
        return Ok(());
    }
    assets::validate_resource(&assets::resource()?)?;
    let (tx, rx) = mpsc::channel::<(Operation, Response)>();
    let (ready_tx, ready_rx) = mpsc::channel();
    let start_plan = plan.clone();
    let start_core = core.clone();
    let thread = std::thread::spawn(move || {
        let result = (|| {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|_| "创建接管控制器失败".to_string())?;
            let own = Identity::inspect(std::process::id()).ok_or("宿主身份不可读取")?;
            let nonce = helper::nonce()?;
            let name = helper::pipe_name(own.pid, &nonce)?;
            let _enter = runtime.enter();
            let mut pipe = helper::create_server(&name)?;
            let child = Elevated::launch(&own, &nonce)?;
            runtime.block_on(async {
                tokio::time::timeout(Duration::from_secs(15), pipe.connect())
                    .await
                    .map_err(|_| "管理员辅助进程连接超时")?
                    .map_err(|_| "管理员辅助进程连接失败")?;
                let mut pid = 0;
                if unsafe { GetNamedPipeClientProcessId(pipe.as_raw_handle(), &mut pid) } == 0
                    || pid != child.pid
                    || !helper::same_session(pid)
                {
                    return Err("辅助进程身份不匹配".into());
                }
                let id = Identity::inspect(pid).ok_or("辅助进程身份不可读取")?;
                if !id.path.eq_ignore_ascii_case(&own.path) {
                    return Err("辅助程序路径不匹配".into());
                }
                Ok::<(), String>(())
            })?;
            let mut sequence = 0;
            let value = runtime.block_on(exchange(
                &mut pipe,
                child.pid,
                &mut sequence,
                Operation::Start {
                    plan: start_plan,
                    core: start_core,
                },
            ))?;
            *STATS.lock().unwrap() = value;
            *ERROR.lock().unwrap() = None;
            let _ = ready_tx.send(Ok(()));
            loop {
                let (operation, response) = match rx.recv_timeout(Duration::from_millis(800)) {
                    Ok((op, tx)) => (op, Some(tx)),
                    Err(mpsc::RecvTimeoutError::Timeout) => (Operation::Ping {}, None),
                    Err(_) => (Operation::Stop {}, None),
                };
                let stop = matches!(operation, Operation::Stop {});
                let result =
                    runtime.block_on(exchange(&mut pipe, child.pid, &mut sequence, operation));
                if let Ok(value) = &result {
                    *STATS.lock().unwrap() = value.clone();
                }
                let failed = result.as_ref().err().cloned();
                if let Some(tx) = response {
                    let _ = tx.send(result);
                }
                if let Some(error) = failed {
                    return Err(error);
                }
                if stop {
                    break;
                }
            }
            Ok(())
        })();
        if let Err(error) = result {
            let _ = ready_tx.send(Err(error.clone()));
            *ERROR.lock().unwrap() = Some(format!("WinDivert 已停止：{error}；请重新选择模式"));
        }
        STATS.lock().unwrap().active = false;
    });
    // UAC consent is interactive; the worker owns the exact child handle. No
    // timeout is treated as consent and no unrelated process is terminated.
    match ready_rx.recv() {
        Ok(Ok(())) => {
            *holder = Some(Session {
                tx,
                thread: Some(thread),
                plan,
                core,
                paused: false,
            });
            Ok(())
        }
        Ok(Err(error)) => {
            drop(tx);
            let _ = thread.join();
            Err(error)
        }
        Err(_) => {
            drop(tx);
            let _ = thread.join();
            Err("接管辅助进程启动失败".into())
        }
    }
}
async fn exchange(
    pipe: &mut NamedPipeServer,
    pid: u32,
    sequence: &mut u64,
    operation: Operation,
) -> Result<Stats, String> {
    let active_required = !matches!(operation, Operation::Stop {});
    *sequence = sequence.checked_add(1).ok_or("控制会话已耗尽")?;
    write(
        pipe,
        &Request {
            version: 1,
            sequence: *sequence,
            operation,
        },
    )
    .await?;
    let reply: Reply = read(pipe).await?;
    if reply.version != 1 || reply.sequence != *sequence || reply.pid != pid {
        return Err("接管回复身份或代次不匹配".into());
    }
    let stats = reply.result?;
    if active_required && !stats.active {
        return Err("WinDivert 工作线程已停止".into());
    }
    Ok(stats)
}
struct Elevated {
    handle: *mut std::ffi::c_void,
    pid: u32,
}
impl Elevated {
    fn launch(host: &Identity, nonce: &str) -> Result<Self, String> {
        use std::os::windows::ffi::OsStrExt;
        use windows::{
            core::{w, PCWSTR},
            Win32::UI::Shell::{ShellExecuteExW, SHELLEXECUTEINFOW},
        };
        let exe = std::env::current_exe().map_err(|_| "程序路径不可读取")?;
        let file: Vec<u16> = exe.as_os_str().encode_wide().chain(Some(0)).collect();
        let args: Vec<u16> = format!(
            "--procweaver-windivert-helper {} {} {}\0",
            host.pid, host.created_at, nonce
        )
        .encode_utf16()
        .collect();
        let mut info = SHELLEXECUTEINFOW {
            cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
            fMask: 0x40 | 0x100,
            lpVerb: w!("runas"),
            lpFile: PCWSTR(file.as_ptr()),
            lpParameters: PCWSTR(args.as_ptr()),
            nShow: 0,
            ..Default::default()
        };
        unsafe {
            ShellExecuteExW(&mut info).map_err(|_| "未获得管理员授权，WinDivert 未启用")?;
            let handle = info.hProcess.0;
            if handle.is_null() {
                return Err("未取得辅助进程句柄".into());
            }
            let pid = windows_sys::Win32::System::Threading::GetProcessId(handle);
            Ok(Self { handle, pid })
        }
    }
}
impl Drop for Elevated {
    fn drop(&mut self) {
        unsafe {
            use windows_sys::Win32::{
                Foundation::CloseHandle,
                System::Threading::{TerminateProcess, WaitForSingleObject},
            };
            if WaitForSingleObject(self.handle, 3000) != 0 {
                TerminateProcess(self.handle, 1);
                WaitForSingleObject(self.handle, 1000);
            }
            CloseHandle(self.handle);
        }
    }
}

pub(super) fn confirmed_plan(core_pid: u32) -> Option<(Plan, Identity)> {
    let holder = SESSION.lock().unwrap();
    let session = holder.as_ref()?;
    (core_pid != 0 && session.core.pid == core_pid).then(|| (session.plan.clone(), session.core.clone()))
}

// Read-only context labels, not a claim that a particular PID owns a connection.
pub(crate) fn observation_entries(core_pid: u32) -> Vec<super::plan::Entry> {
    let holder = SESSION.lock().unwrap();
    let Some(session) = holder.as_ref() else { return vec![]; };
    if session.paused || session.core.pid != core_pid || Identity::inspect(core_pid).as_ref() != Some(&session.core) { return vec![]; }
    session.plan.entries.clone()
}

pub(super) fn validate_core(plan: &Plan, core: &Identity) -> Result<(), String> {
    if Identity::inspect(core.pid).as_ref() != Some(core) {
        return Err("核心身份改变，拒绝接管".into());
    }
    for port in plan.entries.iter().map(|e| e.port) {
        for protocol in [6, 17] {
            if !super::ports::owned(port, core.pid, protocol) {
                return Err(format!("WinDivert {} 入口 {port} 尚未由当前核心监听，请检查端口是否被占用或受系统限制", if protocol == 6 { "TCP" } else { "UDP" }));
            }
        }
    }
    Ok(())
}
async fn serve(parent: u32, created: u64, nonce: &str) -> Result<(), String> {
    let host = Identity::inspect(parent).ok_or("宿主不存在")?;
    let own = Identity::inspect(std::process::id()).ok_or("辅助进程身份无效")?;
    if created == 0
        || host.created_at != created
        || !host.path.eq_ignore_ascii_case(&own.path)
        || !helper::same_session(parent)
    {
        return Err("接管宿主身份不匹配".into());
    }
    let mut pipe = ClientOptions::new()
        .open(helper::pipe_name(parent, nonce)?)
        .map_err(|_| "无法连接接管宿主")?;
    let mut server = 0;
    if unsafe { GetNamedPipeServerProcessId(pipe.as_raw_handle(), &mut server) } == 0
        || server != parent
    {
        return Err("接管控制通道身份不匹配".into());
    }
    let mut engine: Option<Engine> = None;
    let mut core_identity: Option<Identity> = None;
    let mut sequence = 1;
    let result = async {
        loop {
            let request: Request = read(&mut pipe).await?;
            if request.version != 1 || request.sequence != sequence {
                return Err("接管控制消息代次无效".into());
            }
            sequence += 1;
            if Identity::inspect(parent).as_ref() != Some(&host) {
                return Err("宿主已退出".into());
            }
            let stop = matches!(request.operation, Operation::Stop {});
            let response: Result<Stats, String> = async {
                match request.operation {
                    Operation::Start { plan, core } => {
                        if engine.is_some() {
                            Err("接管已启动".into())
                        } else {
                            plan.validate()?;
                            validate_core(&plan, &core)?;
                            let excluded = vec![host.clone(), own.clone(), core.clone()];
                            let started = tokio::task::spawn_blocking(move || {
                                let directory = assets::prepare()?;
                                Engine::start(plan, &directory, excluded)
                            })
                            .await
                            .map_err(|_| "接管启动任务异常")??;
                            let stats = started.stats();
                            engine = Some(started);
                            core_identity = Some(core);
                            Ok(stats)
                        }
                    }
                    Operation::Update { plan } => {
                        plan.validate()?;
                        let core = core_identity.as_ref().ok_or("核心未绑定")?;
                        validate_core(&plan, core)?;
                        let has_targets = !plan.targets.is_empty() || !plan.instances.is_empty();
                        if engine.as_ref().ok_or("接管尚未启动")?.has_targets() != has_targets
                        {
                            let previous = engine.take();
                            tokio::task::spawn_blocking(move || drop(previous))
                                .await
                                .map_err(|_| "接管停止失败")?;
                            let excluded = vec![host.clone(), own.clone(), core.clone()];
                            engine = Some(
                                tokio::task::spawn_blocking(move || {
                                    let directory = assets::prepare()?;
                                    Engine::start(plan, &directory, excluded)
                                })
                                .await
                                .map_err(|_| "接管启动任务异常")??,
                            );
                        } else {
                            engine.as_ref().unwrap().update(plan)?;
                        }
                        Ok(engine.as_ref().unwrap().stats())
                    }
                    Operation::Instances { instances } => {
                        let core = core_identity.as_ref().ok_or("核心未绑定")?;
                        if Identity::inspect(core.pid).as_ref() != Some(core) { return Err("核心身份改变，拒绝实例更新".into()); }
                        let engine = engine.as_ref().ok_or("接管尚未启动")?;
                        engine.update_instances(instances)?;
                        Ok(engine.stats())
                    }
                    Operation::Pause {} => {
                        let e = engine.as_ref().ok_or("接管尚未启动")?;
                        e.pause();
                        Ok(e.stats())
                    }
                    Operation::Ping {} => {
                        if let Some(core) = &core_identity {
                            if Identity::inspect(core.pid).as_ref() != Some(core) {
                                return Err("核心已退出".into());
                            }
                        }
                        Ok(engine.as_ref().map(Engine::stats).unwrap_or_default())
                    }
                    Operation::Stop {} => {
                        if let Some(e) = engine.take() {
                            tokio::task::spawn_blocking(move || drop(e))
                                .await
                                .map_err(|_| "接管停止失败")?;
                        }
                        Ok(Stats::default())
                    }
                }
            }
            .await;
            let failed = response.is_err();
            write(
                &mut pipe,
                &Reply {
                    version: 1,
                    sequence: request.sequence,
                    pid: std::process::id(),
                    result: response,
                },
            )
            .await?;
            if stop || failed {
                return Ok(());
            }
        }
    }
    .await;
    if let Some(e) = engine.take() {
        let _ = tokio::task::spawn_blocking(move || drop(e)).await;
    }
    result
}

pub fn run_if_requested() -> bool {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) != Some("--procweaver-windivert-helper") {
        return false;
    }
    let result = (|| {
        if args.len() != 5 {
            return Err("辅助进程参数无效".to_string());
        }
        let parent = args[2].parse().map_err(|_| "宿主 PID 无效")?;
        let created = args[3].parse().map_err(|_| "宿主身份无效")?;
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|_| "控制通道运行环境失败")?;
        runtime.block_on(serve(parent, created, &args[4]))
    })();
    std::process::exit(if result.is_ok() { 0 } else { 1 });
}

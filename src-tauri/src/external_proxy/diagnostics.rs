//! Process-edition metadata diagnostics. Packet contents and credentials never enter this sink.
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    fs::{self, File, OpenOptions},
    io::{BufWriter, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc::{self, SyncSender},
        Arc, LazyLock, Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const FILE: &str = "process-proxy.jsonl";
const LIMIT: u64 = 5 * 1024 * 1024;
const ARCHIVES: usize = 3;
const QUEUE: usize = 2048;
static LOG: LazyLock<Mutex<Option<Arc<Log>>>> = LazyLock::new(|| Mutex::new(None));
static NEXT: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub directory: String,
    pub file_name: String,
    pub ready: bool,
    pub error: Option<String>,
    pub dropped: u64,
    pub active_tcp: u64,
    pub active_udp: u64,
    pub active_dns: u64,
    pub last_write_at: u64,
    pub max_file_bytes: u64,
    pub retained_files: usize,
}
struct Shared {
    status: Mutex<Status>,
    dropped: AtomicU64,
    active: [AtomicU64; 3],
    started: Instant,
    session: String,
}
enum Command {
    Line(Vec<u8>),
    Flush(mpsc::Sender<bool>),
    Stop(mpsc::Sender<bool>),
}
pub(crate) struct Log {
    tx: SyncSender<Command>,
    shared: Arc<Shared>,
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn scrub(value: &mut Value) {
    match value {
        Value::Object(fields) => {
            fields.retain(|key, _| {
                let key = key
                    .chars()
                    .filter(|ch| ch.is_ascii_alphanumeric())
                    .collect::<String>()
                    .to_ascii_lowercase();
                !matches!(
                    key.as_str(),
                    "password"
                        | "secret"
                        | "username"
                        | "authorization"
                        | "proxyauthorization"
                        | "cookie"
                        | "token"
                        | "accesstoken"
                        | "refreshtoken"
                        | "apikey"
                        | "credentials"
                        | "headers"
                        | "body"
                        | "payload"
                        | "requestbody"
                        | "responsebody"
                )
            });
            for item in fields.values_mut() {
                scrub(item);
            }
        }
        Value::Array(items) => {
            for item in items {
                scrub(item);
            }
        }
        Value::String(text) => {
            *text = text.chars().take(512).collect();
        }
        _ => {}
    }
}
impl Shared {
    fn envelope(&self, event: &str, level: &str, mut details: Value) -> Vec<u8> {
        scrub(&mut details);
        let mut line = serde_json::to_vec(&json!({"atMs":now(), "uptimeMs":self.started.elapsed().as_millis() as u64,
            "session":self.session, "hostPid":std::process::id(), "event":event, "level":level, "details":details})).unwrap_or_default();
        line.push(b'\n');
        line
    }
    fn counts(&self) -> Value {
        json!({"activeTcp":self.active[0].load(Ordering::Relaxed), "activeUdp":self.active[1].load(Ordering::Relaxed), "activeDns":self.active[2].load(Ordering::Relaxed), "dropped":self.dropped.load(Ordering::Relaxed)})
    }
}
impl Log {
    fn start(directory: PathBuf, limit: u64, archives: usize) -> Arc<Self> {
        let (tx, rx) = mpsc::sync_channel(QUEUE);
        let shared = Arc::new(Shared {
            status: Mutex::new(Status {
                directory: directory.to_string_lossy().into_owned(),
                file_name: FILE.into(),
                ready: false,
                error: None,
                dropped: 0,
                active_tcp: 0,
                active_udp: 0,
                active_dns: 0,
                last_write_at: 0,
                max_file_bytes: limit,
                retained_files: archives + 1,
            }),
            dropped: AtomicU64::new(0),
            active: std::array::from_fn(|_| AtomicU64::new(0)),
            started: Instant::now(),
            session: format!("{}-{}", now(), std::process::id()),
        });
        let worker = shared.clone();
        if std::thread::Builder::new().name("process-diagnostics".into()).spawn(move || {
            let mut sink = None; let mut summary = Instant::now(); let mut flushed = Instant::now(); let mut reported = 0;
            loop {
                let command = rx.recv_timeout(Duration::from_millis(500));
                let disconnected = matches!(command, Err(mpsc::RecvTimeoutError::Disconnected));
                if sink.is_none() {
                    match Sink::open(&directory, limit, archives) {
                        Ok(value) => { sink=Some(value); let mut status=worker.status.lock().unwrap_or_else(|e|e.into_inner()); status.ready=true; status.error=None; }
                        Err(error) => { let mut status=worker.status.lock().unwrap_or_else(|e|e.into_inner()); status.ready=false; status.error=Some(format!("日志文件不可写（{:?} / {:?}）", error.kind(), error.raw_os_error())); }
                    }
                }
                let mut ack = None; let mut stop = disconnected;
                let line = match command {
                    Ok(Command::Line(line)) => Some(line),
                    Ok(Command::Flush(sender)) => { ack=Some(sender); None },
                    Ok(Command::Stop(sender)) => { ack=Some(sender); stop=true; None },
                    Err(_) => None,
                };
                let dropped=worker.dropped.load(Ordering::Relaxed);
                let outcome = if let Some(file)=sink.as_mut() {
                    (|| -> std::io::Result<()> {
                        if let Some(line)=line { file.write(&line)?; }
                        if dropped != reported { file.write(&worker.envelope("log.queue_dropped", "warning", json!({"message":"日志队列超限或写入失败，部分诊断记录未保存", "count":dropped-reported})))?; reported=dropped; }
                        if summary.elapsed()>=Duration::from_secs(30) { file.write(&worker.envelope("sessions.snapshot", "info", worker.counts()))?; summary=Instant::now(); }
                        // Flush at least every 500ms, including before shutdown/export acknowledgements.
                        if ack.is_some() || stop || flushed.elapsed()>=Duration::from_millis(500) { file.flush()?; flushed=Instant::now(); }
                        Ok(())
                    })()
                } else { if line.is_some() { worker.dropped.fetch_add(1,Ordering::Relaxed); } Ok(()) };
                let saved=outcome.is_ok() && sink.is_some();
                if let Err(error)=outcome {
                    worker.dropped.fetch_add(1,Ordering::Relaxed); sink=None;
                    let mut status=worker.status.lock().unwrap_or_else(|e|e.into_inner()); status.ready=false;
                    status.error=Some(format!("日志写入失败（{:?} / {:?}）",error.kind(),error.raw_os_error()));
                } else if sink.is_some() { worker.status.lock().unwrap_or_else(|e|e.into_inner()).last_write_at=now(); }
                if let Some(ack)=ack { let _=ack.send(saved); }
                if stop { worker.status.lock().unwrap_or_else(|e|e.into_inner()).ready=false; break; }
            }
        }).is_err() { shared.status.lock().unwrap_or_else(|e|e.into_inner()).error=Some("无法启动后台日志线程".into()); }
        Arc::new(Self { tx, shared })
    }
    pub(crate) fn emit(&self, event: &str, level: &str, details: Value) {
        let line = self.shared.envelope(event, level, details);
        if line.len() > 8192 || self.tx.try_send(Command::Line(line)).is_err() {
            self.shared.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }
    fn barrier(&self, stop: bool) -> bool {
        let (tx, rx) = mpsc::channel();
        // Only shutdown/UI/test paths wait; network workers always use try_send.
        let mut command = if stop {
            Command::Stop(tx)
        } else {
            Command::Flush(tx)
        };
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            match self.tx.try_send(command) {
                Ok(()) => {
                    return rx
                        .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                        .unwrap_or(false)
                }
                Err(mpsc::TrySendError::Full(value)) if Instant::now() < deadline => {
                    command = value;
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(_) => return false,
            }
        }
    }
    fn status(&self) -> Status {
        let mut status = self
            .shared
            .status
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        status.dropped = self.shared.dropped.load(Ordering::Relaxed);
        status.active_tcp = self.shared.active[0].load(Ordering::Relaxed);
        status.active_udp = self.shared.active[1].load(Ordering::Relaxed);
        status.active_dns = self.shared.active[2].load(Ordering::Relaxed);
        status
    }
}
struct Sink {
    directory: PathBuf,
    writer: Option<BufWriter<File>>,
    size: u64,
    limit: u64,
    archives: usize,
}
impl Sink {
    fn open(directory: &Path, limit: u64, archives: usize) -> std::io::Result<Self> {
        fs::create_dir_all(directory)?;
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(directory.join(FILE))?;
        let size = file.metadata()?.len();
        Ok(Self {
            directory: directory.into(),
            writer: Some(BufWriter::new(file)),
            size,
            limit,
            archives,
        })
    }
    fn flush(&mut self) -> std::io::Result<()> {
        if let Some(writer) = self.writer.as_mut() {
            writer.flush()?;
        }
        Ok(())
    }
    fn write(&mut self, line: &[u8]) -> std::io::Result<()> {
        if self.size > 0 && self.size + line.len() as u64 > self.limit {
            self.flush()?;
            // Close the file before renaming on Windows; only these fixed log names are touched.
            drop(self.writer.take());
            let last = self.directory.join(format!("{FILE}.{}", self.archives));
            if last.exists() {
                fs::remove_file(last)?;
            }
            for index in (1..self.archives).rev() {
                let from = self.directory.join(format!("{FILE}.{index}"));
                if from.exists() {
                    fs::rename(from, self.directory.join(format!("{FILE}.{}", index + 1)))?;
                }
            }
            fs::rename(
                self.directory.join(FILE),
                self.directory.join(format!("{FILE}.1")),
            )?;
            let file = OpenOptions::new()
                .create(true)
                .append(true)
                .open(self.directory.join(FILE))?;
            self.writer = Some(BufWriter::new(file));
            self.size = 0;
        }
        self.writer
            .as_mut()
            .ok_or_else(|| std::io::Error::other("log file closed"))?
            .write_all(line)?;
        self.size += line.len() as u64;
        Ok(())
    }
}
fn logger() -> Option<Arc<Log>> {
    LOG.lock().unwrap_or_else(|e| e.into_inner()).clone()
}
pub(crate) fn initialize(root: &Path) {
    if !crate::edition::PROCESS {
        return;
    }
    let log = Log::start(root.join("logs"), LIMIT, ARCHIVES);
    log.emit("host.started","info",json!({"message":"独立进程版详细日志已启动", "version":env!("CARGO_PKG_VERSION"), "queueCapacity":QUEUE, "maxFileBytes":LIMIT, "retainedFiles":ARCHIVES+1}));
    *LOG.lock().unwrap_or_else(|e| e.into_inner()) = Some(log);
}
pub(crate) fn status() -> Option<Status> {
    logger().map(|log| log.status())
}
pub(crate) fn emit(event: &str, level: &str, details: Value) {
    if let Some(log) = logger() {
        log.emit(event, level, details);
    }
}
pub(crate) async fn shutdown() {
    if let Some(log) = logger() {
        log.emit("host.stopping", "info", log.shared.counts());
        let _ = tokio::task::spawn_blocking(move || log.barrier(true)).await;
    }
}
#[cfg(feature = "process-edition")]
#[tauri::command]
pub(crate) async fn open_process_log_directory(app: tauri::AppHandle) -> Result<(), String> {
    if !crate::edition::PROCESS {
        return Err("详细日志目录仅用于独立进程版".into());
    }
    let log = logger().ok_or("详细日志尚未初始化")?;
    if !tokio::task::spawn_blocking(move || log.barrier(false))
        .await
        .unwrap_or(false)
    {
        return Err("日志刷新失败或超时，请检查日志状态后重试".into());
    }
    use tauri_plugin_opener::OpenerExt;
    let directory = crate::storage::data_dir().join("logs");
    app.opener()
        .open_path(directory.to_string_lossy(), None::<&str>)
        .map_err(|_| "无法打开日志目录，请从进程版数据目录进入 logs".into())
}

#[derive(Clone)]
pub(crate) struct Trace {
    log: Option<Arc<Log>>,
    id: u64,
    record: Option<u64>,
    started: Instant,
}
impl Trace {
    pub(crate) fn new(record: Option<u64>) -> Self {
        Self {
            log: logger(),
            id: NEXT.fetch_add(1, Ordering::Relaxed),
            record,
            started: Instant::now(),
        }
    }
    pub(crate) fn event(&self, event: &str, level: &str, details: Value) {
        if let Some(log) = &self.log {
            log.emit(event,level,json!({"traceId":self.id, "recordId":self.record, "elapsedMs":self.started.elapsed().as_millis() as u64, "data":details}));
        }
    }
    pub(crate) fn step(&self, stage: &'static str) -> Step {
        self.event("stage.started", "info", json!({"stage":stage}));
        Step {
            trace: self.clone(),
            stage,
            started: Instant::now(),
            done: false,
        }
    }
    pub(crate) fn activity(&self, kind: &'static str) -> Activity {
        let index = match kind {
            "udp" => 1,
            "dns" => 2,
            _ => 0,
        };
        if let Some(log) = &self.log {
            log.shared.active[index].fetch_add(1, Ordering::Relaxed);
            self.event(
                "session.started",
                "info",
                json!({"kind":kind,"counts":log.shared.counts()}),
            );
        }
        Activity {
            trace: self.clone(),
            index,
            kind,
        }
    }
}
pub(crate) struct Step {
    trace: Trace,
    stage: &'static str,
    started: Instant,
    done: bool,
}
impl Step {
    pub(crate) fn finish(mut self, ok: bool, details: Value) {
        self.done = true;
        self.trace.event(if ok {"stage.ok"} else {"stage.failed"},if ok {"info"} else {"warning"},json!({"stage":self.stage,"stageMs":self.started.elapsed().as_millis() as u64,"result":details}));
    }
}
impl Drop for Step {
    fn drop(&mut self) {
        if !self.done {
            self.trace.event("stage.cancelled","warning",json!({"stage":self.stage,"stageMs":self.started.elapsed().as_millis() as u64,"message":"阶段未完成，任务被取消或达到外层截止时间"}));
        }
    }
}
pub(crate) struct Activity {
    trace: Trace,
    index: usize,
    kind: &'static str,
}
impl Drop for Activity {
    fn drop(&mut self) {
        if let Some(log) = &self.trace.log {
            log.shared.active[self.index].fetch_sub(1, Ordering::Relaxed);
            self.trace.event(
                "session.released",
                "info",
                json!({"kind":self.kind,"counts":log.shared.counts()}),
            );
        }
    }
}

#[cfg(test)]
#[path = "diagnostics_tests.rs"]
mod tests;

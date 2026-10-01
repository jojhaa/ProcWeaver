use super::model::{Overrides, ProcessRule};
use serde::Serialize;
use std::{collections::{BTreeMap, HashSet}, sync::{Mutex, atomic::{AtomicBool, Ordering}}};

pub static ENABLED: AtomicBool = AtomicBool::new(false);
static TRACKER: Mutex<Tracker> = Mutex::new(Tracker { entries: BTreeMap::new(), unverified: BTreeMap::new(), revision: DerivedRevision { generation: 0, fingerprint: String::new() }, error: None, monitor_error: None, apply_error: None, warning: None, subscribed: false, last_snapshot: None });
const SNAPSHOT_MAX_AGE: std::time::Duration = std::time::Duration::from_secs(15);
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessEntry {
    pub identity: String, pub pid: u32, pub parent_pid: u32, pub name: String,
    #[serde(skip)] pub created_at: u64,
    pub executable_path: Option<String>, pub parent_identity: Option<String>,
    pub ancestors: Vec<(String, String)>,
}
#[derive(Default)]
struct Tracker { entries: BTreeMap<String, ProcessEntry>, unverified: BTreeMap<u32, (String, u64)>, revision: DerivedRevision, error: Option<String>, monitor_error: Option<String>, apply_error: Option<String>, warning: Option<(String, std::time::Instant)>, subscribed: bool, last_snapshot: Option<std::time::Instant> }
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MonitorState { Disabled, Initializing, Current, Degraded, Stale }
impl MonitorState {
    pub fn is_fresh(self) -> bool { matches!(self, Self::Current | Self::Degraded) }
}
pub struct Observation { pub state: MonitorState, pub entries: Vec<ProcessEntry>, pub unverified_names: Vec<String> }
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorChange { pub refresh_all: bool, pub instance_ids: Vec<String> }
#[derive(Default)]
struct DerivedRevision { generation: u64, fingerprint: String }
impl DerivedRevision {
    fn observe(&mut self, derived: &[ProcessRule]) -> u64 {
        let fingerprint = serde_json::to_string(derived).expect("派生规则可序列化");
        if self.fingerprint != fingerprint {
            self.fingerprint = fingerprint;
            self.generation = self.generation.wrapping_add(1);
        }
        self.generation
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackingStatus {
    pub generation: u64, pub subscribed: bool, pub ready: bool, pub error: Option<String>, pub entries: Vec<ProcessEntry>,
    pub monitor_state: MonitorState,
    #[serde(skip)] pub unverified_names: Vec<String>,
    pub derived: Vec<ProcessRule>, pub conflicts: Vec<String>, pub warnings: Vec<String>,
}
fn attach(item: &mut ProcessEntry, entries: &BTreeMap<String, ProcessEntry>) {
    if let Some(parent) = entries.values().find(|p| p.pid == item.parent_pid && p.created_at > 0 && p.created_at < item.created_at) {
        item.parent_identity = Some(parent.identity.clone());
        if let Some(path) = &parent.executable_path { item.ancestors.push((parent.identity.clone(), path.clone())); }
        item.ancestors.extend(parent.ancestors.iter().take(63).cloned());
    }
}
/// Read-only UI snapshots reuse ancestry only for the same verified incarnation.
pub fn enrich_snapshot(mut snapshot: Vec<ProcessEntry>) -> Vec<ProcessEntry> {
    let state = TRACKER.lock().unwrap_or_else(|p| p.into_inner());
    snapshot.sort_by_key(|p| p.created_at);
    let mut current = BTreeMap::new();
    for p in &mut snapshot {
        if p.identity.is_empty() || p.created_at == 0 { continue; }
        if let Some(old) = state.entries.get(&p.identity).filter(|old| old.created_at == p.created_at && old.executable_path == p.executable_path) {
            p.ancestors = old.ancestors.clone(); p.parent_identity = old.parent_identity.clone();
        }
        if p.parent_identity.is_none() { attach(p, &current); }
        current.insert(p.identity.clone(), p.clone());
    }
    snapshot
}
pub fn reconcile(snapshot: Vec<ProcessEntry>, reset: bool) { update_snapshot(snapshot, reset, false); }
pub fn reconcile_observed(snapshot: Vec<ProcessEntry>, reset: bool) { update_snapshot(snapshot, reset, true); }
fn update_snapshot(mut snapshot: Vec<ProcessEntry>, reset: bool, active_only: bool) {
    let mut state = TRACKER.lock().unwrap_or_else(|p| p.into_inner());
    if active_only && !ENABLED.load(Ordering::Acquire) { return; }
    state.last_snapshot = Some(std::time::Instant::now());
    // 未核实对象只参与状态提示，不加入可匹配/继承的实例树。
    state.unverified = snapshot.iter().filter(|p| p.identity.is_empty()).map(|p| (p.pid, (p.name.clone(), 0))).collect();
    if reset { state.error = None; state.monitor_error = None; state.warning = None; state.subscribed = true; }
    snapshot.sort_by_key(|p| p.created_at);
    let live: HashSet<_> = snapshot.iter().filter(|p| !p.identity.is_empty()).map(|p| p.identity.clone()).collect();
    // 不保留已退出实例作为新关系的父节点；已确认子进程自带祖先链。
    state.entries.retain(|id, _| live.contains(id));
    for mut p in snapshot.into_iter().filter(|p| !p.identity.is_empty()) {
        if let Some(old) = state.entries.get(&p.identity) { p.ancestors = old.ancestors.clone(); p.parent_identity = old.parent_identity.clone(); }
        if p.parent_identity.is_none() { attach(&mut p, &state.entries); }
        if p.ancestors.len() >= 64 { state.error = Some("进程祖先超过 64 层，跟踪受限".into()); }
        state.entries.insert(p.identity.clone(), p);
    }
}
pub fn created(mut item: ProcessEntry) {
    let mut state = TRACKER.lock().unwrap_or_else(|p| p.into_inner());
    if !ENABLED.load(Ordering::Acquire) { return; }
    if item.identity.is_empty() { return; }
    state.unverified.remove(&item.pid);
    if state.entries.len() >= 8192 { state.error = Some("进程数量超限".into()); return; }
    if state.entries.contains_key(&item.identity) { return; }
    state.entries.retain(|_, p| p.pid != item.pid);
    attach(&mut item, &state.entries);
    if item.ancestors.len() >= 64 { state.error = Some("进程祖先超过 64 层，跟踪受限".into()); }
    if item.name.is_empty() { item.name = item.executable_path.as_deref().and_then(|p| std::path::Path::new(p).file_name()).map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|| format!("PID {}", item.pid)); }
    state.entries.insert(item.identity.clone(), item);
}
pub fn exited(pid: u32, event_time: u64) {
    let mut state = TRACKER.lock().unwrap_or_else(|p| p.into_inner());
    state.entries.retain(|_, p| p.pid != pid || p.created_at > event_time);
    if state.unverified.get(&pid).is_some_and(|(_, at)| *at <= event_time) { state.unverified.remove(&pid); }
}
pub fn unverified_process(pid: u32, name: String, event_time: u64) {
    let mut state = TRACKER.lock().unwrap_or_else(|p| p.into_inner());
    if !ENABLED.load(Ordering::Acquire) || state.unverified.len() >= 8192 { return; }
    if state.entries.values().any(|p| p.pid == pid && p.created_at > event_time) { return; }
    state.unverified.insert(pid, (name, event_time));
}
// 单个系统进程可能在事件到达前退出，也可能不允许读取身份；这不是核心应用失败。
// 只保留最新一条、最近 30 秒的提示，避免一次漏读永久污染所有套件状态。
pub fn limited(warning: &str) { TRACKER.lock().unwrap_or_else(|p| p.into_inner()).warning = Some((warning.into(), std::time::Instant::now())); }
pub fn disconnected(error: &str) { let mut s = TRACKER.lock().unwrap_or_else(|p| p.into_inner()); s.monitor_error = Some(error.into()); s.subscribed = false; }
pub fn observer_alive() {
    let mut s = TRACKER.lock().unwrap_or_else(|p| p.into_inner());
    if !ENABLED.load(Ordering::Acquire) { return; }
    s.subscribed = true; s.monitor_error = None;
}
/// Packet classification needs one verified instance, not all derived UI rules.
pub fn entry(identity: &str) -> Option<ProcessEntry> {
    TRACKER.lock().unwrap_or_else(|p| p.into_inner()).entries.get(identity).cloned()
}
/// 进程发现独立于启动参数、核心状态及网络出口核验。
pub fn observation() -> Observation {
    let state = TRACKER.lock().unwrap_or_else(|p| p.into_inner());
    Observation { state: state.monitor_state_at(std::time::Instant::now(), ENABLED.load(Ordering::Acquire)), entries: state.entries.values().cloned().collect(), unverified_names: state.unverified_names() }
}
pub fn status(config: &Overrides) -> TrackingStatus {
    let mut state = TRACKER.lock().unwrap_or_else(|p| p.into_inner());
    state.status_at(config, std::time::Instant::now())
}
impl Tracker {
    fn unverified_names(&self) -> Vec<String> {
        let mut names: Vec<_> = self.unverified.values().map(|(name, _)| crate::platform::path_key(name)).collect();
        names.sort(); names.dedup(); names
    }
    fn monitor_state_at(&self, now: std::time::Instant, enabled: bool) -> MonitorState {
        if !enabled { return MonitorState::Disabled; }
        let Some(last) = self.last_snapshot else { return MonitorState::Initializing; };
        if now.saturating_duration_since(last) >= SNAPSHOT_MAX_AGE { return MonitorState::Stale; }
        if self.subscribed { MonitorState::Current } else { MonitorState::Degraded }
    }
    fn status_at(&mut self, config: &Overrides, now: std::time::Instant) -> TrackingStatus {
        let entries: Vec<_> = self.entries.values().cloned().collect();
        let (derived, conflicts) = derive(config, &entries);
        let generation = self.revision.observe(&derived);
        if self.warning.as_ref().is_some_and(|(_, at)| now.saturating_duration_since(*at).as_secs() >= 30) { self.warning = None; }
        let monitor_state = self.monitor_state_at(now, ENABLED.load(Ordering::Acquire));
        TrackingStatus { generation, subscribed: self.subscribed && ENABLED.load(Ordering::Acquire), ready: monitor_state.is_fresh(), monitor_state,
            unverified_names: self.unverified_names(),
            error: self.apply_error.clone().or_else(|| self.error.clone()), entries, derived, conflicts,
            warnings: self.monitor_error.iter().cloned().chain(self.warning.as_ref().map(|(message, _)| message.clone())).collect() }
    }
}
fn is_windows_process_bridge(path: &str) -> bool {
    // 系统控制台宿主和命令启动器只作为继承链中间节点，不自动生成全局路径规则。
    // 不剪断祖先链、不按文件名放行同名业务程序；显式规则仍由调用方优先处理。
    // PowerShell、Node 等可直接联网的解释器不属于此例外。
    #[cfg(windows)] {
        let system_root = std::path::PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into()));
        let path = path.replace('/', "\\");
        let path = path.strip_prefix(r"\\?\").unwrap_or(&path);
        return ["System32", "SysWOW64"].iter().any(|dir|
            ["conhost.exe", "cmd.exe"].iter().any(|exe|
                path.eq_ignore_ascii_case(&system_root.join(dir).join(exe).to_string_lossy())));
    }
    #[cfg(not(windows))] { let _ = path; false }
}

fn inherited_destination(rule: &ProcessRule) -> &str {
    rule.target.as_ref().map(|t| t.name.as_str()).unwrap_or(rule.action.as_str())
}

pub fn conflict_message(conflicts: &[String]) -> Option<String> {
    if conflicts.is_empty() { return None; }
    let details = conflicts.iter().take(4).cloned().collect::<Vec<_>>().join("；");
    let remaining = if conflicts.len() > 4 { format!("；另有 {} 项，请查看进程树诊断", conflicts.len() - 4) } else { String::new() };
    Some(format!("进程树规则无法应用：{details}{remaining}。请为冲突路径设置明确规则，或调整相关根规则的子进程继承"))
}

pub fn derive(config: &Overrides, entries: &[ProcessEntry]) -> (Vec<ProcessRule>, Vec<String>) {
    let config = config.effective();
    let mut derived = BTreeMap::<String, ProcessRule>::new(); let mut conflicts = Vec::new();
    let mut conflicted_paths = HashSet::new();
    if !config.process_enabled { return (vec![], vec![]); }
    let rules: Vec<_> = config.process_rules.iter().filter(|r| r.enabled).collect();
    if !rules.iter().any(|r| r.include_descendants) { return (vec![], vec![]); }
    for p in entries {
        let Some(path) = &p.executable_path else { continue; };
        if rules.iter().any(|r| if r.match_kind == "path" { crate::platform::same_path(&r.match_value,path) } else { crate::platform::same_path(&r.match_value,&p.name) }) { continue; }
        if is_windows_process_bridge(path) { continue; }
        let root = p.ancestors.iter().find_map(|(_, ancestor_path)| {
            let file_name = std::path::Path::new(ancestor_path).file_name().and_then(|f| f.to_str()).unwrap_or("");
            rules.iter().find(|r| {
                r.include_descendants && (
                    if r.match_kind == "path" {
                        crate::platform::same_path(&r.match_value,ancestor_path)
                    } else {
                        crate::platform::same_path(&r.match_value,file_name)
                    }
                )
            })
        });
        let Some(root) = root else { continue; };
        let key = crate::platform::path_key(path);
        if let Some(old) = derived.get_mut(&key) {
            if old.action != root.action || old.target != root.target {
                if !conflicted_paths.insert(key) { continue; }
                conflicts.push(format!("路径 {path}：规则「{}」（{}）与规则「{}」（{}）的继承出口不同，已阻止该路径",
                    old.label, inherited_destination(old), root.label, inherited_destination(root)));
                old.action = "reject".into(); old.target = None;
            }
        } else {
            let mut r = (*root).clone(); r.id = format!("derived:{}", root.id); r.match_kind = "path".into();
            r.match_value = path.clone(); r.include_descendants = false; derived.insert(key, r);
        }
    }
    if derived.len() > 1024 { conflicts.push("派生路径超过 1024 项，跟踪受限".into()); }
    (derived.into_values().take(1024).collect(), conflicts)
}

fn monitoring_required(config: &Overrides) -> bool {
    let effective = config.effective();
    effective.process_enabled && (effective.process_rules.iter().any(|r| r.enabled)
        || effective.bundles.iter().any(|b| b.enabled))
}

fn matches_entry(kind: &str, value: &str, entry: &ProcessEntry) -> bool {
    if kind == "path" { entry.executable_path.as_deref().is_some_and(|p| crate::platform::same_path(value, p)) }
    else { crate::platform::same_path(value, &entry.name) }
}

fn bundle_fingerprint(bundle: &super::model::BundleRoute, rules: &[&ProcessRule], state: &TrackingStatus) -> String {
    let main_name = std::path::Path::new(&bundle.main_exe).file_name().unwrap_or_default().to_string_lossy();
    let entries: Vec<_> = state.entries.iter().filter(|p| {
        rules.iter().any(|r| matches_entry(&r.match_kind, &r.match_value, p) || r.include_descendants && p.ancestors.iter().any(|(_, path)| {
            if r.match_kind == "path" { crate::platform::same_path(&r.match_value, path) }
            else { std::path::Path::new(path).file_name().is_some_and(|name| crate::platform::same_path(&r.match_value, &name.to_string_lossy())) }
        })) || crate::platform::same_path(&main_name, &p.name)
    }).map(|p| (&p.identity, &p.name, &p.executable_path, &p.parent_identity)).collect();
    let unknown: Vec<_> = state.unverified_names.iter().filter(|name| crate::platform::same_path(&main_name, name)).collect();
    serde_json::to_string(&(bundle, rules, entries, unknown)).expect("监控规则可序列化")
}
#[derive(Default)]
struct Notifications { health: Option<(MonitorState, bool)>, bundles: BTreeMap<String, String> }
impl Notifications {
    fn update(&mut self, config: &Overrides, state: &TrackingStatus, running: bool) -> Option<MonitorChange> {
        let effective = config.effective();
        let health = (state.monitor_state, running);
        let refresh_all = self.health != Some(health);
        let mut current: BTreeMap<_, _> = effective.bundles.iter().filter(|b| b.enabled).map(|b| {
            let rules: Vec<_> = effective.process_rules.iter().filter(|r| r.enabled && super::bundles::owner(&r.id, &effective.bundles).is_some_and(|owner| owner.id == b.id)).collect();
            (b.id.clone(), bundle_fingerprint(b, &rules, state))
        }).collect();
        current.extend(crate::external_proxy::monitor_fingerprints(state));
        let mut changed: Vec<_> = current.iter().filter(|(id, value)| self.bundles.get(*id) != Some(*value)).map(|(id, _)| id.clone()).collect();
        changed.extend(self.bundles.keys().filter(|id| !current.contains_key(*id)).cloned());
        self.health = Some(health); self.bundles = current;
        if refresh_all || !changed.is_empty() { Some(MonitorChange { refresh_all, instance_ids: changed }) } else { None }
    }
}

fn clear_observation() {
    let mut s = TRACKER.lock().unwrap_or_else(|p| p.into_inner());
    s.entries.clear(); s.unverified.clear(); s.subscribed = false; s.last_snapshot = None;
    s.warning = None; s.error = None; s.monitor_error = None; s.apply_error = None;
}

pub async fn run(notify: impl Fn(MonitorChange) + Send + 'static) {
    let mut observer: Option<std::thread::JoinHandle<()>> = None;
    let mut previous = String::new();
    let mut notifications = Notifications::default();
    let mut retry_at = std::time::Instant::now();
    let mut snapshot_at = std::time::Instant::now();
    let mut ticks = tokio::time::interval(std::time::Duration::from_secs(1));
    ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        ticks.tick().await;
        let config = if !crate::function_mode::core_features_enabled() { Overrides::default() } else { match super::read() { Ok(c) => c, Err(e) => {
            TRACKER.lock().unwrap_or_else(|p| p.into_inner()).apply_error = Some(e);
            if crate::external_proxy::monitoring_required() { Overrides::default() } else { continue; }
        } } };
        // 本轮扩展 Windows 全局监控；macOS 保持既有快照跟踪的启用条件。
        let enabled = if cfg!(windows) { monitoring_required(&config) || crate::external_proxy::monitoring_required() } else {
            let effective = config.effective();
            cfg!(target_os = "macos") && crate::commands::process::ACTIVE.load(Ordering::SeqCst)
                && effective.process_enabled && effective.process_rules.iter().any(|r| r.enabled && r.include_descendants)
        };
        let was_enabled = ENABLED.swap(enabled, Ordering::AcqRel);
        if !enabled {
            if observer.as_ref().is_some_and(|h| h.is_finished()) { if let Some(h) = observer.take() { let _ = h.join(); } }
            clear_observation(); previous.clear();
            if let Some(change) = notifications.update(&config, &status(&config), crate::commands::process::ACTIVE.load(Ordering::SeqCst)) { notify(change); }
            retry_at = std::time::Instant::now(); snapshot_at = retry_at;
            continue;
        }
        if !was_enabled { retry_at = std::time::Instant::now(); snapshot_at = retry_at; }
        if (observer.is_none() || observer.as_ref().is_some_and(|h| h.is_finished())) && std::time::Instant::now() >= retry_at {
            if let Some(h) = observer.take() { let _ = h.join(); }
            observer = Some(std::thread::spawn(|| {
                #[cfg(any(windows, target_os = "macos"))] if let Err(e) = super::native::observe() { disconnected(&e); }
            }));
            retry_at = std::time::Instant::now() + std::time::Duration::from_secs(30);
        }
        let mut state = status(&config);
        if (!state.subscribed || !state.ready) && std::time::Instant::now() >= snapshot_at {
            if state.monitor_state == MonitorState::Stale { disconnected("监控快照已过期，正在独立补查"); }
            match tokio::task::spawn_blocking(super::native::snapshot).await {
                Ok(Ok(snapshot)) => reconcile_observed(snapshot, false),
                Ok(Err(error)) => disconnected(&error),
                Err(_) => disconnected("进程快照任务失败，下次检查会重试"),
            }
            snapshot_at = std::time::Instant::now() + std::time::Duration::from_secs(5);
            state = status(&config);
        }
        if let Some(change) = notifications.update(&config, &state, crate::commands::process::ACTIVE.load(Ordering::SeqCst)) { notify(change); }
        // 过期观察不可用于增加/删除派生规则；保留核心当前已应用的配置。
        if !state.ready { continue; }
        // 核心停止/正在切换时继续监控，不验证配置、不写运行文件，也不阻塞事件通知。
        if !crate::commands::process::ACTIVE.load(Ordering::SeqCst) {
            previous.clear(); TRACKER.lock().unwrap_or_else(|p| p.into_inner()).apply_error = None; continue;
        }
        if !config.effective().process_rules.iter().any(|r| r.enabled && r.include_descendants) {
            previous.clear(); TRACKER.lock().unwrap_or_else(|p| p.into_inner()).apply_error = None; continue;
        }
        let Ok(_lock) = crate::commands::process::LIFECYCLE.try_lock() else { continue; };
        if !crate::commands::process::ACTIVE.load(Ordering::SeqCst) { previous.clear(); continue; }
        // 观察阶段不占核心锁；应用前拒绝已经过期的配置。
        if !super::read().is_ok_and(|latest| latest.revision == config.revision) { continue; }
        // 实例白名单绑定 PID 与创建时间；路径未变的重启也要更新 helper，
        // 只计算接管范围内的实例，避免无关进程触发核心配置写入。
        let instance_revision: Option<String> = None;
        #[cfg(windows)]
        let instance_revision = if crate::commands::settings::get_general_settings().is_ok_and(|s| s.traffic_mode == crate::capture::windivert::plan::MODE) {
            Some(crate::capture::windivert::plan::instance_revision(&config.effective(), &state))
        } else { instance_revision };
        #[cfg(windows)]
        if let Some(revision) = &instance_revision {
            let fingerprint = serde_json::to_string(&(config.revision, revision)).unwrap_or_default();
            if fingerprint != previous {
                match crate::capture::windivert::session::refresh_instances(&config.effective(), &state,
                    crate::commands::process::PID.load(Ordering::SeqCst)).await {
                    Ok(()) => {
                        previous = fingerprint;
                        super::set_applied(config.revision, state.generation);
                        TRACKER.lock().unwrap_or_else(|p| p.into_inner()).apply_error = None;
                    }
                    Err(error) => TRACKER.lock().unwrap_or_else(|p| p.into_inner()).apply_error = Some(error),
                }
            } else {
                super::set_applied(config.revision, state.generation);
                TRACKER.lock().unwrap_or_else(|p| p.into_inner()).apply_error = None;
            }
            continue;
        }
        let fingerprint = serde_json::to_string(&(config.revision, &state.derived)).unwrap_or_default();
        if fingerprint != previous {
            match super::reapply(&config).await {
                Ok(_) => {
                    previous = fingerprint;
                    super::set_applied(config.revision, state.generation);
                    TRACKER.lock().unwrap_or_else(|p| p.into_inner()).apply_error = None;
                }
                Err(error) => {
                    TRACKER.lock().unwrap_or_else(|p| p.into_inner()).apply_error = Some(error);
                }
            }
        } else {
            super::set_applied(config.revision, state.generation);
            TRACKER.lock().unwrap_or_else(|p| p.into_inner()).apply_error = None;
        }
    }
}

#[cfg(test)]
mod revision_tests {
    use super::*;
    #[test]
    fn discovery_retains_verified_exited_ancestry_but_never_reuses_a_pid() {
        clear_observation();
        let entry = |pid, time, parent, path: &str| ProcessEntry { identity: format!("{pid}:{time}"), pid, created_at: time,
            parent_pid: parent, name: path.rsplit(['\\', '/']).next().unwrap().into(), executable_path: Some(path.into()),
            parent_identity: None, ancestors: vec![] };
        let root = entry(41, 10, 0, r"C:\App\root.exe");
        let child = entry(42, 20, 41, r"C:\Shared\node.exe");
        reconcile(vec![root.clone(), child.clone()], true);
        reconcile(vec![child.clone()], false);
        let snapshot = enrich_snapshot(vec![child.clone()]);
        assert_eq!(snapshot[0].ancestors, vec![(root.identity, root.executable_path.unwrap())]);
        let serialized = serde_json::to_value(&snapshot[0]).unwrap();
        assert_eq!(serialized["ancestors"][0][0], "41:10");
        let reused = entry(42, 30, 999, r"C:\Shared\node.exe");
        assert!(enrich_snapshot(vec![reused])[0].ancestors.is_empty());
        clear_observation();
    }
    fn root_rule() -> ProcessRule {
        ProcessRule { id: "root".into(), enabled: true, label: "目标程序".into(), match_kind: "name".into(),
            match_value: "target.exe".into(), action: "direct".into(), target: None, include_descendants: false, rule_mode: None }
    }
    #[test]
    fn ordinary_targets_are_monitored_without_inheritance_and_respect_feature_gates() {
        let mut config = Overrides { process_enabled: true, process_rules: vec![root_rule()], ..Overrides::default() };
        assert!(monitoring_required(&config), "普通目标不应依赖子进程继承才能开启监控");
        config.process_rules[0].enabled = false; assert!(!monitoring_required(&config));
        config.process_rules[0].enabled = true; config.process_enabled = false; assert!(!monitoring_required(&config));
        config.bundles.push(serde_json::from_value(serde_json::json!({
            "id":"browser", "name":"浏览器", "mainExe":"target.exe", "enabled":true, "mainTarget":null, "dnsTarget":null
        })).unwrap());
        assert!(monitoring_required(&config), "业务包与手动进程规则开关独立");
        config.bundles_enabled = false; assert!(!monitoring_required(&config));
        config.process_enabled = true; assert!(monitoring_required(&config));
        assert!(!monitoring_required(&Overrides::default()));
    }
    #[test]
    fn only_target_lifecycle_and_monitor_health_notify_the_ui() {
        let mut config = Overrides { process_enabled: true, process_rules: vec![root_rule()], ..Overrides::default() };
        for (id, exe) in [("a", "target.exe"), ("b", "second.exe")] {
            config.bundles.push(serde_json::from_value(serde_json::json!({"id":id,"name":id,"mainExe":exe,"enabled":true,"mainTarget":null,"dnsTarget":null})).unwrap());
        }
        let mut tracker = Tracker::default();
        let mut state = tracker.status_at(&config, std::time::Instant::now());
        state.monitor_state = MonitorState::Current;
        let mut notifications = Notifications::default();
        assert!(notifications.update(&config, &state, false).unwrap().refresh_all);
        assert!(notifications.update(&config, &state, false).is_none());
        state.unverified_names.push("unrelated.exe".into());
        assert!(notifications.update(&config, &state, false).is_none());
        state.unverified_names.push("TARGET.exe".into());
        assert_eq!(notifications.update(&config, &state, false).unwrap().instance_ids, ["a"], "同名未核实进程只使所属包待核验");
        state.unverified_names.clear();
        assert_eq!(notifications.update(&config, &state, false).unwrap().instance_ids, ["a"]);
        config.bundles[0].main_exe = std::env::temp_dir().join("selected/target.exe").to_string_lossy().into_owned();
        assert_eq!(notifications.update(&config, &state, false).unwrap().instance_ids, ["a"]);
        let unrelated = ProcessEntry { identity: "1:1".into(), pid: 1, parent_pid: 0, name: "unrelated.exe".into(),
            created_at: 1, executable_path: None, parent_identity: None, ancestors: vec![] };
        state.entries.push(unrelated.clone());
        state.warnings.push("无关系统进程无法读取身份".into());
        config.revision += 1;
        assert!(notifications.update(&config, &state, false).is_none(), "无关进程、配置版本及漏读提示不触发入口查询");
        state.entries.push(ProcessEntry { identity: "2:2".into(), name: "target.exe".into(), ..unrelated });
        let change = notifications.update(&config, &state, false).unwrap();
        assert!(!change.refresh_all); assert_eq!(change.instance_ids, ["a"]);
        assert!(derive(&config, &state.entries).0.is_empty());
        state.entries.last_mut().unwrap().identity = "2:3".into();
        assert_eq!(notifications.update(&config, &state, false).unwrap().instance_ids, ["a"], "PID 复用后是新实例");
        state.entries.pop(); assert_eq!(notifications.update(&config, &state, false).unwrap().instance_ids, ["a"]);
        config.bundles[1].port = 34009; assert_eq!(notifications.update(&config, &state, false).unwrap().instance_ids, ["b"]);
        config.bundles[0].enabled = false; assert_eq!(notifications.update(&config, &state, false).unwrap().instance_ids, ["a"]);
        state.monitor_state = MonitorState::Stale; assert!(notifications.update(&config, &state, false).unwrap().refresh_all);
        assert!(notifications.update(&config, &state, true).unwrap().refresh_all, "核心状态变化需重查连接");
    }
    #[test]
    fn stale_snapshot_is_not_current_even_with_a_live_subscription() {
        let now = std::time::Instant::now();
        let mut tracker = Tracker::default();
        assert_eq!(tracker.monitor_state_at(now, true), MonitorState::Initializing);
        tracker.last_snapshot = Some(now); tracker.subscribed = true;
        assert_eq!(tracker.monitor_state_at(now + std::time::Duration::from_secs(14), true), MonitorState::Current);
        assert_eq!(tracker.monitor_state_at(now + SNAPSHOT_MAX_AGE, true), MonitorState::Stale);
        tracker.subscribed = false;
        assert_eq!(tracker.monitor_state_at(now + SNAPSHOT_MAX_AGE, true), MonitorState::Stale);
        tracker.last_snapshot = Some(now + SNAPSHOT_MAX_AGE);
        assert_eq!(tracker.monitor_state_at(now + SNAPSHOT_MAX_AGE, true), MonitorState::Degraded);
        assert_eq!(tracker.monitor_state_at(now, false), MonitorState::Disabled);
    }
    #[test]
    fn late_exit_does_not_remove_reused_pid_and_snapshot_catches_missed_exit() {
        clear_observation();
        ENABLED.store(true, Ordering::Release);
        let old = ProcessEntry { identity: "42:100".into(), pid: 42, parent_pid: 0, name: "target.exe".into(),
            created_at: 100, executable_path: None, parent_identity: None, ancestors: vec![] };
        reconcile(vec![old.clone()], false);
        let new = ProcessEntry { identity: "42:200".into(), created_at: 200, ..old };
        created(new.clone()); exited(42, 150);
        assert!(entry("42:100").is_none()); assert!(entry(&new.identity).is_some());
        unverified_process(42, "target.exe".into(), 150);
        assert!(observation().unverified_names.is_empty(), "旧 PID 事件不能使新实例降级");
        unverified_process(43, "TARGET.exe".into(), 210);
        assert_eq!(observation().unverified_names, ["target.exe"]);
        assert!(observation().entries.iter().all(|p| p.pid != 43), "未核实对象不进入可匹配实例树");
        exited(43, 209); assert_eq!(observation().unverified_names.len(), 1);
        exited(43, 210); assert!(observation().unverified_names.is_empty());
        reconcile(vec![new.clone(), ProcessEntry { identity:String::new(), pid:43, created_at:0, ..new.clone() }], false);
        assert_eq!(observation().unverified_names, ["target.exe"], "快照保留无法核实的同名对象提示");
        reconcile(vec![], false); assert!(entry(&new.identity).is_none());
        assert!(observation().unverified_names.is_empty(), "完整快照清理已消失的未核实对象");
        ENABLED.store(false, Ordering::Release); clear_observation();
        created(new.clone()); reconcile_observed(vec![new], true);
        unverified_process(43, "target.exe".into(), 211); observer_alive();
        assert!(observation().unverified_names.is_empty()); assert!(!TRACKER.lock().unwrap().subscribed);
        assert!(TRACKER.lock().unwrap().entries.is_empty(), "关闭后不能被尾随事件或快照重新填充");
    }
    #[test]
    fn subscription_failure_is_monitor_warning_not_core_application_failure() {
        let mut tracker = Tracker { monitor_error: Some("事件订阅失败，正在补查".into()), ..Tracker::default() };
        let status = tracker.status_at(&Overrides::default(), std::time::Instant::now());
        assert!(status.error.is_none()); assert_eq!(status.warnings, ["事件订阅失败，正在补查"]);
        tracker.apply_error = Some("真正的核心应用错误".into());
        assert_eq!(tracker.status_at(&Overrides::default(), std::time::Instant::now()).error.as_deref(), Some("真正的核心应用错误"));
    }
    #[test]
    fn transient_identity_warning_is_separate_from_blocking_errors_and_expires() {
        let now = std::time::Instant::now();
        let mut tracker = Tracker::default();
        let config = Overrides::default();
        let before = tracker.status_at(&config, now);
        tracker.warning = Some(("部分短命或受保护进程无法核实身份".into(), now));
        let status = tracker.status_at(&config, now);
        assert!(status.error.is_none(), "单个身份漏读不能伪装为核心应用失败");
        assert_eq!(status.generation, before.generation);
        assert!(status.entries.is_empty()); assert!(status.derived.is_empty(), "不能给未核实进程伪造已接管规则");
        let wire = serde_json::to_value(&status).unwrap();
        assert!(wire["error"].is_null());
        assert_eq!(wire["warnings"][0], "部分短命或受保护进程无法核实身份");
        assert_eq!(status.warnings.len(), 1);

        tracker.apply_error = Some("核心应用失败".into());
        let failed = tracker.status_at(&config, now + std::time::Duration::from_secs(1));
        assert_eq!(failed.error.as_deref(), Some("核心应用失败")); assert_eq!(failed.warnings.len(), 1);
        let expired = tracker.status_at(&config, now + std::time::Duration::from_secs(31));
        assert!(expired.warnings.is_empty()); assert!(tracker.warning.is_none());
        assert_eq!(expired.error.as_deref(), Some("核心应用失败"), "提示过期不能清除真实失败");
        tracker.apply_error = None;
        tracker.error = Some("进程事件订阅中断".into());
        assert_eq!(tracker.status_at(&config, now).error.as_deref(), Some("进程事件订阅中断"));
    }
    #[test]
    fn only_effective_derived_rules_advance_confirmation_generation() {
        let root_path = std::env::current_exe().unwrap().to_string_lossy().into_owned();
        let rule = ProcessRule { id: "root".into(), enabled: true, label: "根规则".into(), match_kind: "path".into(),
            match_value: root_path.clone(), action: "direct".into(), target: None, include_descendants: true, rule_mode: None };
        let mut config = Overrides { process_enabled: true, process_rules: vec![rule], ..Overrides::default() };
        let mut revision = DerivedRevision::default();
        let initial = revision.observe(&derive(&config, &[]).0);
        let unrelated = ProcessEntry { identity: "unrelated".into(), pid: 1, parent_pid: 0, name: "other.exe".into(),
            created_at: 1, executable_path: Some("other.exe".into()), parent_identity: None, ancestors: vec![] };
        assert_eq!(revision.observe(&derive(&config, &[unrelated.clone()]).0), initial);
        let mut root = unrelated.clone(); root.executable_path = Some(root_path.clone());
        assert_eq!(revision.observe(&derive(&config, &[root]).0), initial, "已显式匹配的程序启动无需重新确认");
        let mut child = unrelated.clone(); child.identity = "child".into(); child.ancestors = vec![("root".into(), root_path)];
        let changed = revision.observe(&derive(&config, &[child.clone()]).0);
        assert_eq!(changed, initial + 1);
        let mut second = child.clone(); second.identity = "child-2".into(); second.pid = 2;
        assert_eq!(revision.observe(&derive(&config, &[unrelated, child.clone(), second.clone()]).0), changed, "同一路径新实例和无关进程不改变规则");
        assert_eq!(revision.observe(&derive(&config, &[second]).0), changed, "同路径仍有实例时不撤销规则");
        config.process_rules[0].action = "reject".into();
        assert_eq!(revision.observe(&derive(&config, &[child]).0), changed + 1, "实际动作变更必须重新同步");
        assert_eq!(revision.observe(&derive(&config, &[]).0), changed + 2, "最后一个派生进程退出时移除规则");
    }
}

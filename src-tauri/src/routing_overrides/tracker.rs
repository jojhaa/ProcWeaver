use super::model::{Overrides, ProcessRule};
use serde::Serialize;
use std::{collections::{BTreeMap, HashSet}, sync::{Mutex, atomic::{AtomicBool, Ordering}}};

pub static ENABLED: AtomicBool = AtomicBool::new(false);
static TRACKER: Mutex<Tracker> = Mutex::new(Tracker { entries: BTreeMap::new(), revision: DerivedRevision { generation: 0, fingerprint: String::new() }, error: None, apply_error: None, warning: None, subscribed: false });
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessEntry {
    pub identity: String, pub pid: u32, pub parent_pid: u32, pub name: String,
    #[serde(skip)] pub created_at: u64,
    pub executable_path: Option<String>, pub parent_identity: Option<String>,
    #[serde(skip)] pub ancestors: Vec<(String, String)>,
}
#[derive(Default)]
struct Tracker { entries: BTreeMap<String, ProcessEntry>, revision: DerivedRevision, error: Option<String>, apply_error: Option<String>, warning: Option<(String, std::time::Instant)>, subscribed: bool }
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
    pub generation: u64, pub subscribed: bool, pub error: Option<String>, pub entries: Vec<ProcessEntry>,
    pub derived: Vec<ProcessRule>, pub conflicts: Vec<String>, pub warnings: Vec<String>,
}
fn attach(item: &mut ProcessEntry, entries: &BTreeMap<String, ProcessEntry>) {
    if let Some(parent) = entries.values().find(|p| p.pid == item.parent_pid && p.created_at > 0 && p.created_at < item.created_at) {
        item.parent_identity = Some(parent.identity.clone());
        if let Some(path) = &parent.executable_path { item.ancestors.push((parent.identity.clone(), path.clone())); }
        item.ancestors.extend(parent.ancestors.iter().take(63).cloned());
    }
}
pub fn reconcile(mut snapshot: Vec<ProcessEntry>, reset: bool) {
    let mut state = TRACKER.lock().unwrap_or_else(|p| p.into_inner());
    if reset { state.error = None; state.warning = None; state.subscribed = true; }
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
}
// 单个系统进程可能在事件到达前退出，也可能不允许读取身份；这不是核心应用失败。
// 只保留最新一条、最近 30 秒的提示，避免一次漏读永久污染所有套件状态。
pub fn limited(warning: &str) { TRACKER.lock().unwrap_or_else(|p| p.into_inner()).warning = Some((warning.into(), std::time::Instant::now())); }
pub fn disconnected(error: &str) { let mut s = TRACKER.lock().unwrap_or_else(|p| p.into_inner()); s.error = Some(error.into()); s.subscribed = false; }
/// Packet classification needs one verified instance, not all derived UI rules.
pub fn entry(identity: &str) -> Option<ProcessEntry> {
    TRACKER.lock().unwrap_or_else(|p| p.into_inner()).entries.get(identity).cloned()
}
pub fn status(config: &Overrides) -> TrackingStatus {
    let mut state = TRACKER.lock().unwrap_or_else(|p| p.into_inner());
    state.status_at(config, std::time::Instant::now())
}
impl Tracker {
    fn status_at(&mut self, config: &Overrides, now: std::time::Instant) -> TrackingStatus {
        let entries: Vec<_> = self.entries.values().cloned().collect();
        let (derived, conflicts) = derive(config, &entries);
        let generation = self.revision.observe(&derived);
        if self.warning.as_ref().is_some_and(|(_, at)| now.saturating_duration_since(*at).as_secs() >= 30) { self.warning = None; }
        TrackingStatus { generation, subscribed: self.subscribed && ENABLED.load(Ordering::Acquire),
            error: self.apply_error.clone().or_else(|| self.error.clone()), entries, derived, conflicts,
            warnings: self.warning.as_ref().map(|(message, _)| vec![message.clone()]).unwrap_or_default() }
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
    let mut derived = BTreeMap::<String, ProcessRule>::new(); let mut conflicts = Vec::new();
    let mut conflicted_paths = HashSet::new();
    if !config.process_enabled { return (vec![], vec![]); }
    let rules: Vec<_> = config.process_rules.iter().filter(|r| r.enabled).collect();
    for p in entries {
        let Some(path) = &p.executable_path else { continue; };
        if rules.iter().any(|r| if r.match_kind == "path" { r.match_value.eq_ignore_ascii_case(path) } else { r.match_value.eq_ignore_ascii_case(&p.name) }) { continue; }
        if is_windows_process_bridge(path) { continue; }
        let root = p.ancestors.iter().find_map(|(_, ancestor_path)| {
            let file_name = std::path::Path::new(ancestor_path).file_name().and_then(|f| f.to_str()).unwrap_or("");
            rules.iter().find(|r| {
                r.include_descendants && (
                    if r.match_kind == "path" {
                        r.match_value.eq_ignore_ascii_case(ancestor_path)
                    } else {
                        r.match_value.eq_ignore_ascii_case(file_name)
                    }
                )
            })
        });
        let Some(root) = root else { continue; };
        let key = path.to_lowercase();
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

pub async fn run() {
    let mut observer: Option<std::thread::JoinHandle<()>> = None;
    let mut previous = String::new();
    let mut retry_at = std::time::Instant::now();
    loop {
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        let _lock = crate::commands::process::LIFECYCLE.lock().await;
        let config = match super::read() { Ok(c) => c, Err(e) => {
            TRACKER.lock().unwrap_or_else(|p| p.into_inner()).apply_error = Some(e); continue;
        } };
        let enabled = crate::commands::process::ACTIVE.load(Ordering::SeqCst) && config.process_enabled && config.process_rules.iter().any(|r| r.enabled && r.include_descendants);
        ENABLED.store(enabled, Ordering::Release);
        if !enabled {
            if observer.as_ref().is_some_and(|h| h.is_finished()) { if let Some(h) = observer.take() { let _ = h.join(); } }
            let mut s = TRACKER.lock().unwrap_or_else(|p| p.into_inner()); s.entries.clear(); s.subscribed = false; s.warning = None; previous.clear(); continue;
        }
        if (observer.is_none() || observer.as_ref().is_some_and(|h| h.is_finished())) && std::time::Instant::now() >= retry_at {
            if let Some(h) = observer.take() { let _ = h.join(); }
            observer = Some(std::thread::spawn(|| {
                #[cfg(windows)] if let Err(e) = super::native::observe() { disconnected(&e); }
            }));
            retry_at = std::time::Instant::now() + std::time::Duration::from_secs(30);
        }
        let mut state = status(&config);
        if !state.subscribed {
            if let Ok(snapshot) = super::native::snapshot() { reconcile(snapshot, false); state = status(&config); }
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

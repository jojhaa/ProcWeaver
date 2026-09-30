use super::{context, preflight};
use crate::routing_overrides::{model::Overrides, ownership, tracker::{ProcessEntry, TrackingStatus}};
use serde::{Deserialize, Serialize};
use serde_yaml::Value;
use std::collections::{BTreeMap, BTreeSet};

pub const MODE: &str = "windivert_v1";
pub const KEY: &str = "procweaver-windivert-v1";
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Entry {
    pub kind: String,
    pub value: String,
    pub port: u16,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub owner: String,
}
impl Entry {
    pub fn id(&self) -> Result<String, String> {
        let key = if self.owner.is_empty() { format!("{}:{}", self.kind, self.value.to_ascii_lowercase()) }
            else { serde_json::to_string(&(&self.owner, &self.kind, self.value.to_ascii_lowercase())).map_err(|_| "上下文标识无效")? };
        Ok(preflight::sha256(key.as_bytes())?[..16].into())
    }
    fn matches(&self, path: &str) -> bool {
        match self.kind.as_str() {
            "path" => self.value.eq_ignore_ascii_case(path),
            "name" => self.value.eq_ignore_ascii_case(path.rsplit(['\\', '/']).next().unwrap_or("")),
            "any" => true,
            _ => false,
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Instance {
    pub pid: u32,
    pub created_at: u64,
    pub path: String,
    #[serde(default)]
    pub owner: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Plan {
    pub entries: Vec<Entry>,
    pub targets: Vec<Entry>,
    pub instances: Vec<Instance>,
}
impl Plan {
    pub fn validate(&self) -> Result<(), String> {
        if self.entries.len() > 64 || self.targets.len() > 512 || self.instances.len() > 1024 {
            return Err("WinDivert 接管范围超过容量限制".into());
        }
        for e in self.entries.iter().chain(&self.targets) {
            if !matches!(e.kind.as_str(), "path" | "name" | "any") || e.value.is_empty() || e.value.len() > 32768
                || e.value.chars().any(char::is_control) || !(61000..=64999).contains(&e.port)
                || e.owner.len() > 256 || e.owner.chars().any(char::is_control)
                || (e.kind == "any" && e.value != "*") {
                return Err("WinDivert 进程入口计划无效".into());
            }
        }
        let mut keys = BTreeSet::new();
        let mut ports = BTreeSet::new();
        if self.entries.iter().any(|e| !keys.insert((&e.owner, &e.kind, e.value.to_ascii_lowercase())) || !ports.insert(e.port)) {
            return Err("接管上下文或端口重复".into());
        }
        if self.targets.iter().any(|t| t.kind == "any" || !self.entries.iter().any(|e| e.owner == t.owner && e.port == t.port)) {
            return Err("接管目标缺少对应规则入口".into());
        }
        let mut roots = BTreeSet::new();
        if self.targets.iter().any(|t| !roots.insert((&t.kind, t.value.to_ascii_lowercase()))) {
            return Err("同一启动根匹配多个策略，请使用不同根程序或明确路径绑定".into());
        }
        let mut pids = BTreeSet::new();
        for p in &self.instances {
            if p.pid == 0 || p.created_at == 0 || !pids.insert(p.pid) || p.path.len() > 32768
                || p.path.chars().any(char::is_control) || !std::path::Path::new(&p.path).is_absolute()
                || self.context_for(&p.owner, &p.path).is_none() {
                return Err("WinDivert 实例身份或归属上下文无效".into());
            }
        }
        Ok(())
    }
    fn context_for(&self, owner: &str, path: &str) -> Option<&Entry> {
        ["path", "name", "any"].into_iter().find_map(|kind|
            self.entries.iter().find(|e| e.owner == owner && e.kind == kind && e.matches(path)))
    }
    pub fn port_for(&self, path: &str, pid: u32, created_at: u64) -> Option<u16> {
        if pid == 0 || created_at == 0 { return None; }
        if let Some(instance) = self.instances.iter().find(|p| p.pid == pid && p.created_at == created_at && p.path.eq_ignore_ascii_case(path)) {
            return self.context_for(&instance.owner, path).map(|e| e.port);
        }
        // Explicit roots also work before the observer's next snapshot. Inherited
        // children require the exact verified incarnation in the runtime map.
        let target = ["path", "name"].into_iter().find_map(|kind| self.targets.iter().find(|e| e.kind == kind && e.matches(path)))?;
        self.context_for(&target.owner, path).map(|e| e.port)
    }
    pub fn refresh_instances(&mut self, config: &Overrides, state: &TrackingStatus) -> Result<(), String> {
        self.instances = instances(config, &state.entries);
        self.validate()
    }
}

fn instances(config: &Overrides, entries: &[ProcessEntry]) -> Vec<Instance> {
    let mut result: Vec<_> = entries.iter().filter_map(|p| {
        let rule = ownership::select(config, p)?;
        Some(Instance { pid: p.pid, created_at: p.created_at, path: p.executable_path.clone()?, owner: ownership::key(rule, config) })
    }).collect();
    result.sort_by_key(|p| p.pid);
    result
}
pub fn instance_revision(config: &Overrides, state: &TrackingStatus) -> String {
    serde_json::to_string(&instances(config, &state.entries)).expect("接管实例可序列化")
}

// Predicates divide processes into exact paths, basenames, and an otherwise
// class. Compile those classes before capture; newly spawned executables need
// only an instance-map update. Drop classes identical to their fallback class.
fn compile_policy(yaml: &Value, owner: &str) -> Result<Vec<(Entry, context::CompiledContext)>, String> {
    let mut keys = context::process_keys(yaml)?;
    let mut unique = BTreeSet::new();
    keys.retain(|(k, v)| unique.insert((k.clone(), v.to_ascii_lowercase())));
    let hash = preflight::sha256(serde_yaml::to_string(yaml).map_err(|_| "策略编码失败")?.as_bytes())?;
    let directory = format!(r"C:\__ProcWeaverContext_{}", &hash[..16]);
    let other = format!(r"{directory}\__other_{}.exe", &hash[16..32]);
    if keys.iter().any(|(_, v)| v.eq_ignore_ascii_case(&other) || v.eq_ignore_ascii_case(other.rsplit('\\').next().unwrap())) {
        return Err("进程规则与保留上下文标识冲突".into());
    }
    let compile = |kind: &str, value: &str, path: &str| -> Result<(Entry, context::CompiledContext), String> {
        let entry = Entry { kind: kind.into(), value: value.into(), port: 61000, owner: owner.into() };
        // A common temporary ID makes rule equality independent of listener IDs.
        let compiled = context::compile(yaml, &[context::ProcessContext { id: "compare".into(), executable_path: path.into() }])?.remove(0);
        Ok((entry, compiled))
    };
    let generic = compile("any", "*", &other)?;
    let mut result = vec![generic.clone()];
    let mut names = BTreeMap::new();
    for (_, value) in keys.iter().filter(|(kind, _)| kind == "PROCESS-NAME") {
        let path = format!(r"{directory}\{value}");
        if keys.iter().any(|(k, v)| k == "PROCESS-PATH" && v.eq_ignore_ascii_case(&path)) { return Err("进程条件与保留路径冲突".into()); }
        let candidate = compile("name", value, &path)?;
        names.insert(value.to_ascii_lowercase(), candidate.1.clone());
        if candidate.1 != generic.1 { result.push(candidate); }
    }
    for (_, value) in keys.iter().filter(|(kind, _)| kind == "PROCESS-PATH") {
        let candidate = compile("path", value, value)?;
        let name = value.rsplit(['\\', '/']).next().unwrap_or("").to_ascii_lowercase();
        if &candidate.1 != names.get(&name).unwrap_or(&generic.1) { result.push(candidate); }
    }
    Ok(result)
}

pub fn compose_with_policies(raw: &str, config: &Overrides, policies: &BTreeMap<String, Value>) -> Result<String, String> {
    let yaml: Value = serde_yaml::from_str(raw).map_err(|_| "接管配置无效")?;
    if yaml.get(KEY).is_some() { return Err("配置包含保留 WinDivert 字段".into()); }
    let mut entries = Vec::new();
    let mut compiled = Vec::new();
    let mut used = BTreeSet::new();
    for (owner, policy) in policies {
        for (mut entry, mut rules) in compile_policy(policy, owner)? {
            if entries.len() >= 64 { return Err("完整规则需要超过 64 个进程上下文，未启用 WinDivert".into()); }
            let id = entry.id()?;
            let offset = u16::from_str_radix(&id[..4], 16).map_err(|_| "上下文编号无效")? % 4000;
            entry.port = (0..4000).map(|i| 61000 + (offset + i) % 4000).find(|p| used.insert(*p)).ok_or("接管端口不足")?;
            // Rename generated references only; never replace user rule text.
            rules.reidentify(&id);
            entries.push(entry); compiled.push(rules);
        }
    }
    let mut plan = Plan { entries, targets: vec![], instances: vec![] };
    if config.process_enabled {
        for rule in config.process_rules.iter().filter(|r| ownership::standalone(r, config)) {
            let owner = ownership::key(rule, config);
            let path = if rule.match_kind == "path" { rule.match_value.clone() } else { format!(r"C:\__ProcWeaverRoot\{}", rule.match_value) };
            let port = plan.context_for(&owner, &path).ok_or("目标缺少所属策略上下文")?.port;
            plan.targets.push(Entry { kind: rule.match_kind.clone(), value: rule.match_value.clone(), port, owner });
        }
    }
    plan.refresh_instances(config, &crate::routing_overrides::tracker::status(config))?;
    let mut yaml = context::attach(&yaml, &compiled, &plan.entries.iter().map(|e| e.port).collect::<Vec<_>>())?;
    if yaml["sniffer"].is_null() {
        yaml["sniffer"] = serde_yaml::from_str("enable: true\nparse-pure-ip: true\nsniff:\n  TLS:\n    ports: [443, 8443]\n  HTTP:\n    ports: [80, 8080]\n").map_err(|_| "嗅探配置无效")?;
    }
    yaml[KEY] = serde_yaml::to_value(plan).map_err(|_| "接管计划序列化失败")?;
    serde_yaml::to_string(&yaml).map_err(|_| "接管配置序列化失败".into())
}

#[cfg(test)]
pub fn compose(raw: &str, config: &Overrides) -> Result<String, String> {
    let mut policies = BTreeMap::new();
    for rule in config.process_rules.iter().filter(|r| ownership::standalone(r, config)) {
        let mut selected = config.clone(); selected.process_rules = vec![rule.clone()];
        let raw = crate::routing_overrides::composer::compose_owned(raw, &selected, "default")?;
        policies.insert(ownership::key(rule, config), serde_yaml::from_str(&raw).unwrap());
    }
    compose_with_policies(raw, config, &policies)
}
#[cfg(test)]
mod tests;
#[cfg(test)]
#[path = "plan/instance_tests.rs"]
mod instance_tests;

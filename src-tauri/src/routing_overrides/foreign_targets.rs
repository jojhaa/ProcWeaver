//! Keep saved subscription identities separate from the active subscription.
use super::{composer, model::*};
use serde_yaml::Value;
use std::collections::{BTreeMap, HashSet};

pub const PREFIX: &str = "PW-X-";
pub fn alias(target: &Target) -> String {
    let key = serde_json::to_vec(target).expect("target serialization");
    let hash = key.iter().fold(0xcbf29ce484222325u64, |h, b| (h ^ u64::from(*b)).wrapping_mul(0x100000001b3));
    format!("{PREFIX}{hash:016x}")
}
fn collect_bindings(config: &Overrides, active: &str, enabled_only: bool) -> Vec<Target> {
    let mut targets = Vec::new();
    let mut add = |target: &Target| {
        if target.profile_id != active && !targets.contains(target) { targets.push(target.clone()); }
    };
    for rule in &config.process_rules { if (!enabled_only || (config.process_enabled && rule.enabled)) && rule.action == "proxy" { if let Some(t) = &rule.target { add(t); } } }
    for rule in &config.dns_rules { if !enabled_only || (config.dns_enabled && rule.enabled) { add(&rule.target); } }
    for bundle in &config.bundles {
        // Bundle outlet groups are materialized even while the global switch is off.
        if !enabled_only || bundle.enabled {
            for target in [&bundle.main_target, &bundle.dns_target].into_iter().flatten() { add(target); }
        }
    }
    targets
}
pub fn bindings(config: &Overrides, active: &str) -> Vec<Target> { collect_bindings(config, active, true) }
pub fn saved_bindings(config: &Overrides, active: &str) -> Vec<Target> { collect_bindings(config, active, false) }
pub fn remap(target: &mut Target, config: &Overrides, active: &str) {
    if bindings(config, active).contains(target) {
        *target = Target { profile_id: active.into(), kind: if config.retain_foreign_targets { target.kind.clone() } else { "group".into() }, name: alias(target) };
    }
}
fn source(id: &str) -> Result<std::path::PathBuf, String> {
    if id == "default" { return Ok(crate::storage::data_dir().join("config/default.yaml")); }
    crate::commands::profile::read_profiles_index().into_iter().find(|p| p.id == id)
        .map(|p| crate::storage::data_dir().join(p.file_path)).ok_or("原绑定订阅已移除".into())
}
pub fn available(targets: &[Target]) -> Vec<Target> {
    let mut by_source = BTreeMap::new();
    targets.iter().filter(|t| {
        let candidates = by_source.entry(t.profile_id.clone()).or_insert_with(|| source(&t.profile_id)
            .and_then(|path| super::target_cache::targets(&t.profile_id, &path)).unwrap_or_default());
        candidates.contains(t)
    }).cloned().collect()
}
fn read_source(id: &str) -> Result<Value, String> {
    let path = source(id)?;
    let raw = std::fs::read_to_string(path).map_err(|_| "无法读取原绑定订阅")?;
    let raw = crate::commands::settings::prepare_with(&raw, &crate::commands::settings::get_general_settings()?)?;
    let raw = crate::commands::local_rules::compose(&raw, &crate::commands::local_rules::get_local_rule_plan()?)?;
    composer::targets(&raw, id)?;
    serde_yaml::from_str(&raw).map_err(|_| "原绑定订阅格式无效".into())
}

struct Importer {
    sources: BTreeMap<String, Value>, nodes: Vec<Value>, groups: Vec<Value>,
    imported: Vec<Target>, visiting: Vec<Target>, names: HashSet<String>,
}
impl Importer {
    fn import(&mut self, target: &Target) -> Result<String, String> {
        let name = alias(target);
        if self.imported.contains(target) { return Ok(name); }
        if self.visiting.contains(target) { return Err("原出口包含循环代理依赖，无法保留".into()); }
        if !self.names.insert(name.clone()) { return Err("订阅与保留出口的内部名称冲突".into()); }
        if !self.sources.contains_key(&target.profile_id) { self.sources.insert(target.profile_id.clone(), read_source(&target.profile_id)?); }
        let source = self.sources.get(&target.profile_id).unwrap();
        let section = if target.kind == "node" { "proxies" } else { "proxy-groups" };
        let mut item = source[section].as_sequence().into_iter().flatten()
            .find(|item| item["name"].as_str() == Some(&target.name)).cloned()
            .ok_or_else(|| format!("原出口「{}」已不存在，未改用其他同名节点", target.name))?;
        // Dynamic providers and name filters cannot be renamed without changing
        // their selection semantics. Leave that choice explicit in the dialog.
        if ["use", "include-all", "include-all-proxies", "include-all-providers", "filter", "exclude-filter"]
            .iter().any(|key| item.get(*key).is_some_and(|v| !v.is_null() && v.as_bool() != Some(false) && v.as_str() != Some("") && v.as_sequence().is_none_or(|s| !s.is_empty()))) {
            return Err(format!("原出口「{}」含动态代理源或名称筛选，暂不能跨订阅保留；可选择保留绑定后换绑", target.name));
        }
        self.visiting.push(target.clone());
        if let Some(members) = item["proxies"].as_sequence().cloned() {
            let mut mapped = Vec::new();
            for member in members {
                let member = member.as_str().ok_or("原出口成员格式无效")?;
                mapped.push(Value::from(self.dependency(target, member)?));
            }
            item["proxies"] = Value::Sequence(mapped);
        }
        if let Some(dialer) = item["dialer-proxy"].as_str().map(String::from) { item["dialer-proxy"] = self.dependency(target, &dialer)?.into(); }
        item["name"] = name.clone().into();
        if target.kind == "node" { self.nodes.push(item); }
        else { item["hidden"] = true.into(); self.groups.push(item); }
        self.visiting.pop(); self.imported.push(target.clone());
        Ok(name)
    }
    fn dependency(&mut self, owner: &Target, name: &str) -> Result<String, String> {
        if matches!(name, "DIRECT" | "REJECT" | "REJECT-DROP" | "PASS" | "COMPATIBLE") { return Ok(name.into()); }
        let source = &self.sources[&owner.profile_id];
        let kind = [("proxies", "node"), ("proxy-groups", "group")].into_iter().find_map(|(key, kind)|
            source[key].as_sequence().into_iter().flatten().any(|p| p["name"].as_str() == Some(name)).then_some(kind))
            .ok_or("原出口依赖已不存在，无法保留")?;
        self.import(&Target { profile_id: owner.profile_id.clone(), kind: kind.into(), name: name.into() })
    }
}
pub fn materialize(raw: &str, config: &Overrides, active: &str) -> Result<(String, Overrides), String> {
    let targets = bindings(config, active);
    if targets.is_empty() { return Ok((raw.into(), config.clone())); }
    let mut yaml: Value = serde_yaml::from_str(raw).map_err(|_| "订阅格式无效")?;
    let names = composer::targets(raw, active)?.into_iter().map(|t| t.name).collect();
    let mut importer = Importer { sources: BTreeMap::new(), nodes: vec![], groups: vec![], imported: vec![], visiting: vec![], names };
    for target in &targets {
        if config.retain_foreign_targets { importer.import(target)?; }
        else {
            let name = alias(target);
            if !importer.names.insert(name.clone()) { return Err("订阅与保留出口的内部名称冲突".into()); }
            importer.groups.push(serde_yaml::to_value(serde_json::json!({"name":name,"type":"select","proxies":["REJECT"],"hidden":true})).unwrap());
        }
    }
    // Subscription-wide automatic groups must not absorb the private retained nodes.
    if !importer.nodes.is_empty() {
        if let Some(groups) = yaml["proxy-groups"].as_sequence_mut() {
            for group in groups {
                if group["include-all"].as_bool() == Some(true) || group["include-all-proxies"].as_bool() == Some(true) {
                    let previous = group["exclude-filter"].as_str().unwrap_or("");
                    group["exclude-filter"] = if previous.is_empty() { format!("^{PREFIX}") }
                        else { format!("(?:{previous})|^{PREFIX}") }.into();
                }
            }
        }
    }
    for (section, items) in [("proxies", importer.nodes), ("proxy-groups", importer.groups)] {
        let list = yaml.as_mapping_mut().ok_or("订阅须为对象")?.entry(section.into()).or_insert(Value::Sequence(vec![]))
            .as_sequence_mut().ok_or("订阅出口清单格式无效")?;
        list.extend(items);
    }
    let map = |target: &mut Target| {
        if targets.contains(target) {
            *target = Target { profile_id: active.into(), kind: if config.retain_foreign_targets { target.kind.clone() } else { "group".into() }, name: alias(target) };
        }
    };
    let mut mapped = config.clone();
    for rule in &mut mapped.process_rules { if let Some(target) = &mut rule.target { map(target); } }
    for rule in &mut mapped.dns_rules { map(&mut rule.target); }
    for bundle in &mut mapped.bundles { for target in [&mut bundle.main_target, &mut bundle.dns_target].into_iter().flatten() { map(target); } }
    Ok((serde_yaml::to_string(&yaml).map_err(|_| "生成原绑定出口失败")?, mapped))
}

//! Specialize Mihomo rules for the *original* process before a relay hides it.
//! TCP/UDP compiler: no settings writes, sockets, core reloads or PID lookup.
use serde::{Deserialize, Serialize};
use serde_yaml::{Mapping, Value};
use std::collections::{BTreeMap, HashSet};

const MAX_CONTEXTS: usize = 64;
const MAX_RULES: usize = 16384;
const MAX_DEPTH: usize = 24;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProcessContext {
    pub id: String,
    pub executable_path: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CompiledContext {
    pub id: String,
    pub rules: Vec<String>,
    pub sub_rules: BTreeMap<String, Vec<String>>,
}
impl CompiledContext {
    pub(super) fn reidentify(&mut self, id: &str) {
        let prefix = format!("pw-wd-{}-", self.id);
        let names: BTreeMap<_, _> = self.sub_rules.keys().map(|name| (name.clone(),
            format!("pw-wd-{id}-{}", name.strip_prefix(&prefix).expect("compiled namespace")))).collect();
        let rename = |rules: &mut Vec<String>| {
            for rule in rules {
                if rule.starts_with("SUB-RULE,") {
                    let (condition, name) = rule.rsplit_once(',').expect("compiled SUB-RULE");
                    if let Some(mapped) = names.get(name) { *rule = format!("{condition},{mapped}"); }
                }
            }
        };
        rename(&mut self.rules);
        self.sub_rules = std::mem::take(&mut self.sub_rules).into_iter().map(|(name, mut rules)| {
            rename(&mut rules); (names[&name].clone(), rules)
        }).collect();
        self.id = id.into();
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Condition {
    Constant(bool),
    Atom(String, String, Vec<String>),
    And(Vec<Condition>),
    Or(Vec<Condition>),
    Not(Box<Condition>),
}

// Split only at the current nesting level. Never search-and-replace inside a
// rule string: a process name can also occur in a domain/provider/target name.
fn fields(text: &str) -> Result<Vec<&str>, String> {
    if text.len() > 16384 || text.chars().any(char::is_control) {
        return Err("规则文本过长或包含控制字符".into());
    }
    let (mut depth, mut start) = (0usize, 0usize);
    let mut result = Vec::new();
    for (offset, ch) in text.char_indices() {
        match ch {
            '(' => { depth += 1; if depth > MAX_DEPTH { return Err("规则嵌套超过限制".into()); } }
            ')' => { depth = depth.checked_sub(1).ok_or("规则括号不匹配")?; }
            ',' if depth == 0 => { result.push(text[start..offset].trim()); start = offset + 1; }
            _ => {}
        }
    }
    if depth != 0 { return Err("规则括号不匹配".into()); }
    result.push(text[start..].trim());
    if result.iter().any(|v| v.is_empty()) { return Err("规则含空字段".into()); }
    Ok(result)
}

fn ungroup(text: &str) -> Result<&str, String> {
    let inner = text.strip_prefix('(').and_then(|s| s.strip_suffix(')')).ok_or("组合规则缺少括号")?;
    fields(inner)?;
    Ok(inner)
}

fn parse_condition(parts: &[&str], depth: usize) -> Result<Condition, String> {
    if depth > MAX_DEPTH { return Err("规则嵌套超过限制".into()); }
    let kind = *parts.first().ok_or("规则为空")?;
    if kind == "MATCH" && parts.len() == 1 { return Ok(Condition::Constant(true)); }
    if matches!(kind, "AND" | "OR" | "NOT") {
        if parts.len() < 2 { return Err("组合条件格式无效".into()); }
        // Mihomo accepts both a wrapped operand list and sibling groups.
        // Keep each operand grouped so malformed conditions still fail closed.
        let operands = if parts.len() == 2 {
            fields(ungroup(parts[1])?)?
        } else {
            parts[1..].to_vec()
        };
        let children = operands.into_iter()
            .map(|v| parse_condition(&fields(ungroup(v)?)?, depth + 1)).collect::<Result<Vec<_>, _>>()?;
        return match kind {
            "AND" => Ok(Condition::And(children)),
            "OR" => Ok(Condition::Or(children)),
            "NOT" if children.len() == 1 => Ok(Condition::Not(Box::new(children.into_iter().next().unwrap()))),
            _ => Err("NOT 规则须且只能包含一个条件".into()),
        };
    }
    if parts.len() < 2 { return Err("规则缺少匹配值".into()); }
    // Source / inbound / user metadata changes at a SOCKS relay. Do not silently
    // preserve those predicates as if they referred to the original application.
    if !matches!(kind, "PROCESS-NAME" | "PROCESS-PATH" | "DOMAIN" | "DOMAIN-SUFFIX"
        | "DOMAIN-KEYWORD" | "DOMAIN-WILDCARD" | "GEOSITE"
        | "GEOIP" | "IP-ASN" | "IP-CIDR" | "IP-CIDR6" | "DST-PORT" | "NETWORK" | "RULE-SET") {
        return Err(format!("WinDivert 规则上下文暂不支持 {kind}；未改变原规则"));
    }
    if parts.len() > 3 || parts.get(2).is_some_and(|v| *v != "no-resolve") {
        return Err(format!("{kind} 附加选项不支持"));
    }
    if matches!(kind, "PROCESS-NAME" | "PROCESS-PATH") && parts.len() != 2 {
        return Err("进程条件不支持附加选项".into());
    }
    Ok(Condition::Atom(kind.into(), parts[1].into(), parts[2..].iter().map(|s| s.to_string()).collect()))
}

fn process_equal(actual: &str, expected: &str) -> Result<bool, String> {
    // Mihomo PROCESS-PATH uses string EqualFold, not filesystem equivalence.
    // Normalizing slashes, .. or extended prefixes would change its decisions.
    if actual == expected { return Ok(true); }
    if !actual.is_ascii() || !expected.is_ascii() {
        return Err("进程条件包含尚未核验的 Unicode 大小写比较；未猜测命中结果".into());
    }
    Ok(actual.eq_ignore_ascii_case(expected))
}
fn specialize(condition: Condition, path: &str, providers: &Value) -> Result<Condition, String> {
    use Condition::*;
    let all = matches!(condition, And(_));
    Ok(match condition {
        Atom(kind, value, _) if kind == "PROCESS-PATH" => Constant(process_equal(path, &value)?),
        Atom(kind, value, _) if kind == "PROCESS-NAME" => Constant(process_equal(path.rsplit(['/', '\\']).next().unwrap_or(""), &value)?),
        Atom(ref kind, ref value, _) if kind == "RULE-SET" => {
            // Classical providers may hide PROCESS-* / source predicates and may
            // change asynchronously. Only declared domain/ipcidr providers are safe.
            if !matches!(providers[value]["behavior"].as_str(), Some("domain" | "ipcidr")) {
                return Err(format!("规则集 {value} 无法证明不含原进程条件；不支持动态 classical 规则集"));
            }
            condition
        }
        And(items) | Or(items) => {
            let mut output = Vec::new();
            for item in items {
                match specialize(item, path, providers)? {
                    Constant(v) if v != all => return Ok(Constant(v)),
                    Constant(_) => {}
                    other => output.push(other),
                }
            }
            // This compiler serves only TCP/UDP inlets. An owned policy's
            // transport guard covers both, without changing original predicates.
            if !all && ["TCP", "UDP"].iter().all(|protocol| output.iter().any(|item|
                matches!(item, Atom(kind, value, options) if kind == "NETWORK" && value == protocol && options.is_empty()))) {
                return Ok(Constant(true));
            }
            match output.len() {
                0 => Constant(all),
                1 => output.pop().unwrap(),
                _ if all => And(output),
                _ => Or(output),
            }
        }
        Not(item) => match specialize(*item, path, providers)? {
            Constant(v) => Constant(!v), other => Not(Box::new(other)),
        },
        other => other,
    })
}

fn render(condition: &Condition) -> String {
    use Condition::*;
    match condition {
        Constant(true) => "MATCH".into(),
        Constant(false) => unreachable!("false rules are omitted"),
        Atom(kind, value, options) => std::iter::once(kind.as_str()).chain(std::iter::once(value.as_str()))
            .chain(options.iter().map(String::as_str)).collect::<Vec<_>>().join(","),
        And(items) | Or(items) => format!("{},({})", if matches!(condition, And(_)) { "AND" } else { "OR" },
            items.iter().map(|v| format!("({})", render(v))).collect::<Vec<_>>().join(",")),
        Not(item) => format!("NOT,(({}))", render(item)),
    }
}

struct Compiler<'a> {
    yaml: &'a Value,
    path: &'a str,
    prefix: String,
    visiting: HashSet<String>,
    sub_rules: BTreeMap<String, Vec<String>>,
    count: usize,
}
impl Compiler<'_> {
    fn rules(&mut self, values: &[Value]) -> Result<Vec<String>, String> {
        let mut output = Vec::new();
        for value in values {
            self.count += 1;
            if self.count > MAX_RULES { return Err("规则上下文超过容量限制".into()); }
            let text = value.as_str().ok_or("规则必须为文本")?;
            let parts = fields(text)?;
            if parts.first() == Some(&"SUB-RULE") {
                if parts.len() != 3 { return Err("SUB-RULE 格式不支持".into()); }
                let condition = specialize(parse_condition(&fields(ungroup(parts[1])?)?, 0)?, self.path, &self.yaml["rule-providers"])?;
                if condition == Condition::Constant(false) { continue; }
                let original = parts[2];
                if original.len() > 120 || !original.chars().all(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | '.')) {
                    return Err("子规则名称不能安全映射".into());
                }
                let mapped = format!("{}-{original}", self.prefix);
                if !self.sub_rules.contains_key(&mapped) {
                    if self.visiting.len() >= MAX_DEPTH || !self.visiting.insert(original.into()) { return Err("子规则循环或嵌套超过限制".into()); }
                    let source = self.yaml["sub-rules"][original].as_sequence().ok_or("子规则不存在")?.clone();
                    let rules = self.rules(&source)?;
                    self.visiting.remove(original);
                    self.sub_rules.insert(mapped.clone(), rules);
                }
                let rendered = if condition == Condition::Constant(true) { "OR,((NETWORK,TCP),(NETWORK,UDP))".into() } else { render(&condition) };
                output.push(format!("SUB-RULE,({rendered}),{mapped}"));
                continue;
            }
            if parts.len() < 2 { return Err("规则缺少出口".into()); }
            // Mihomo trailing no-resolve follows the outbound, unlike logical
            // subexpressions where it follows the condition's value.
            let options = parts.last() == Some(&"no-resolve");
            let target_index = parts.len() - 1 - usize::from(options);
            if target_index == 0 { return Err("规则缺少匹配条件".into()); }
            let mut condition_parts = parts[..target_index].to_vec();
            if options { condition_parts.push("no-resolve"); }
            let condition = specialize(parse_condition(&condition_parts, 0)?, self.path, &self.yaml["rule-providers"])?;
            if condition == Condition::Constant(false) { continue; }
            let rendered = render(&condition);
            let rendered = rendered.strip_suffix(",no-resolve").map(|r| format!("{r},{},no-resolve", parts[target_index]))
                .unwrap_or_else(|| format!("{rendered},{}", parts[target_index]));
            output.push(rendered);
            // DIRECT/REJECT support both transports and always terminate. A
            // proxy may decline UDP, so retain its following rejection/fallback.
            if condition == Condition::Constant(true) && matches!(parts[target_index], "DIRECT" | "REJECT") { break; }
        }
        Ok(output)
    }
}

/// Call on the complete composed rules, including exclusions and bundle policy.
/// Identity must be a verified executable path, never the helper's own process.
pub fn compile(yaml: &Value, contexts: &[ProcessContext]) -> Result<Vec<CompiledContext>, String> {
    if contexts.len() > MAX_CONTEXTS { return Err("WinDivert 最多 64 个原进程上下文".into()); }
    let mut ids = HashSet::new();
    let rules = yaml["rules"].as_sequence().ok_or("配置缺少 rules 数组")?;
    contexts.iter().map(|context| {
        if context.id.is_empty() || context.id.len() > 64 || !context.id.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
            || !ids.insert(context.id.clone()) {
            return Err("原进程上下文 ID 无效或重复".into());
        }
        let path = &context.executable_path;
        if path.len() > 32768 || path.chars().any(char::is_control) || !std::path::Path::new(path).is_absolute()
            || path.ends_with(['/', '\\']) { return Err("上下文必须使用已核实的完整程序路径".into()); }
        let mut compiler = Compiler { yaml, path, prefix: format!("pw-wd-{}", context.id), visiting: HashSet::new(), sub_rules: BTreeMap::new(), count: 0 };
        let rules = compiler.rules(rules)?;
        Ok(CompiledContext { id: context.id.clone(), rules, sub_rules: compiler.sub_rules })
    }).collect()
}

/// Exact predicates partition all executable identities into path, name, and
/// otherwise classes. A representative is safe only after collecting every
/// process predicate, including those nested in sub-rules.
pub(crate) fn process_keys(yaml: &Value) -> Result<Vec<(String, String)>, String> {
    fn collect(value: &Condition, keys: &mut std::collections::BTreeSet<(String,String)>) {
        match value {
            Condition::Atom(kind, value, _) if kind == "PROCESS-PATH" || kind == "PROCESS-NAME" => { keys.insert((kind.clone(), value.clone())); }
            Condition::And(items) | Condition::Or(items) => for item in items { collect(item, keys); },
            Condition::Not(item) => collect(item, keys),
            _ => {}
        }
    }
    let mut keys = std::collections::BTreeSet::new();
    let mut sets = vec![yaml["rules"].as_sequence().ok_or("缺少分流规则")?];
    let mut visited = HashSet::new();
    let mut index = 0;
    while index < sets.len() { let rules = sets[index]; index += 1; for rule in rules {
        let parts = fields(rule.as_str().ok_or("规则格式无效")?)?;
        let condition = if parts.first() == Some(&"SUB-RULE") {
            let name = *parts.get(2).ok_or("子规则格式无效")?;
            if visited.insert(name) { sets.push(yaml["sub-rules"][name].as_sequence().ok_or("子规则不存在")?); }
            parse_condition(&fields(ungroup(parts.get(1).ok_or("子规则格式无效")?)?)?, 0)?
        } else {
            let options = parts.last() == Some(&"no-resolve");
            let end = parts.len().checked_sub(1 + usize::from(options)).ok_or("规则格式无效")?;
            let mut p = parts[..end].to_vec(); if options { p.push("no-resolve"); }
            parse_condition(&p, 0)?
        };
        collect(&condition, &mut keys);
    }}
    Ok(keys.into_iter().collect())
}

/// Attach dedicated SOCKS inlets only to a candidate configuration. The caller
/// owns stable context→port allocation and must confirm listeners before capture.
pub fn attach(yaml: &Value, contexts: &[CompiledContext], ports: &[u16]) -> Result<Value, String> {
    if contexts.len() != ports.len() || contexts.len() > MAX_CONTEXTS { return Err("上下文入口数量不一致".into()); }
    let mut next = yaml.clone();
    let mut listeners = match next.get("listeners") { None | Some(Value::Null) => vec![], Some(v) => v.as_sequence().ok_or("listeners 须为数组")?.clone() };
    let mut subrules = match next.get("sub-rules") { None | Some(Value::Null) => Mapping::new(), Some(v) => v.as_mapping().ok_or("sub-rules 须为对象")?.clone() };
    let mut reserved: HashSet<u16> = ["port", "socks-port", "mixed-port", "redir-port", "tproxy-port"]
        .into_iter().filter_map(|key| next[key].as_u64().and_then(|n| u16::try_from(n).ok())).collect();
    for key in [next["external-controller"].as_str(), next["dns"]["listen"].as_str()].into_iter().flatten() {
        if let Some(port) = key.rsplit(':').next().and_then(|v| v.parse().ok()) { reserved.insert(port); }
    }
    for (context, port) in contexts.iter().zip(ports) {
        let name = format!("pw-wd-{}", context.id);
        if *port == 0 || !reserved.insert(*port) || listeners.iter().any(|v| super::super::contains_port(&v["port"], *port)
            || super::super::contains_port(&v["ports"], *port) || v["name"].as_str() == Some(&name)) {
            return Err("WinDivert 上下文入口端口或名称冲突".into());
        }
        for (key, rules) in std::iter::once((&name, &context.rules)).chain(context.sub_rules.iter()) {
            if subrules.insert(Value::from(key.clone()), serde_yaml::to_value(rules).map_err(|_| "上下文序列化失败")?).is_some() {
                return Err("WinDivert 上下文子规则名称冲突".into());
            }
        }
        listeners.push(serde_yaml::to_value(serde_json::json!({"name":name,"type":"socks","listen":"127.0.0.1","port":port,"udp":true,"rule":name})).map_err(|_| "上下文入口序列化失败")?);
    }
    next["listeners"] = listeners.into();
    next["sub-rules"] = subrules.into();
    Ok(next)
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod runtime_tests;

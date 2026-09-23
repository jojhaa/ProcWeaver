use super::model::*;
use serde_yaml::Value;

pub fn targets(raw: &str, profile_id: &str) -> Result<Vec<Target>, String> {
    let yaml: Value = serde_yaml::from_str(raw).map_err(|_| "配置 YAML 无效")?;
    let mut result = Vec::new();
    let mut names = std::collections::HashSet::new();
    for (section, kind) in [("proxies", "node"), ("proxy-groups", "group")] {
        for item in yaml[section].as_sequence().into_iter().flatten() {
            if let Some(name) = item["name"].as_str().filter(|n| safe_atom(n) && !matches!(*n, "DIRECT" | "REJECT" | "GLOBAL" | "RULES")) {
                if !names.insert(name.to_string()) { return Err("节点与策略组存在重名，无法唯一绑定出口".into()); }
                result.push(Target { profile_id: profile_id.into(), kind: kind.into(), name: name.into() });
            }
        }
    }
    Ok(result)
}
pub fn destination<'a>(rule: &'a ProcessRule, available: &[Target]) -> &'a str {
    match rule.action.as_str() {
        "direct" => "DIRECT",
        "proxy" => rule.target.as_ref().filter(|t| available.contains(t)).map(|t| t.name.as_str()).unwrap_or("REJECT"),
        _ => "REJECT",
    }
}

/// 顺序：安全例外由外层最后前置；本层进程规则优先于原有规则。
pub fn compose(raw: &str, config: &Overrides, profile_id: &str, derived: &[ProcessRule]) -> Result<String, String> {
    let config = normalize(config.clone())?;
    if !config.process_enabled && !config.dns_enabled { return Ok(raw.into()); }
    let available = targets(raw, profile_id)?;
    let mut yaml: Value = serde_yaml::from_str(raw).map_err(|_| "配置 YAML 无效")?;
    if config.process_enabled {
        yaml["find-process-mode"] = "always".into();
        let mut prefix = Vec::new();
        for rule in config.process_rules.iter().filter(|r| r.enabled).chain(derived.iter()) {
            let kind = if rule.match_kind == "path" { "PROCESS-PATH" } else { "PROCESS-NAME" };
            let dest = destination(rule, &available);
            if let Some(bundle)=super::bundles::owner(&rule.id,&config.bundles).filter(|b|b.mode=="sandbox") {
                if !bundle.enabled {continue;}
                for pattern in &bundle.domains {
                    let condition=format!("AND,(({kind},{}),({}))",rule.match_value,super::bundles::domain_condition(pattern));
                    prefix.push(format!("{condition},{dest}").into());
                    if dest!="REJECT" && dest!="DIRECT" {prefix.push(format!("{condition},REJECT").into());}
                }
                // 系统开关在 prepare 中解析；仅此包进程的未命中请求可直连，不影响其他进程。
                if bundle.fallback == "direct" { prefix.push(format!("{kind},{},DIRECT",rule.match_value).into()); }
                continue;
            }
            if rule.rule_mode.as_deref() == Some("inherit") && dest != "DIRECT" && dest != "REJECT" {
                let safe_id = rule.id.replace(|c: char| !c.is_ascii_alphanumeric(), "-");
                let sub_name = format!("proc-sandbox-{safe_id}");
                let subrules = yaml.as_mapping_mut().ok_or("配置须为对象")?.entry(Value::from("sub-rules"))
                    .or_insert(Value::Mapping(Default::default())).as_mapping_mut().ok_or("sub-rules 须为对象")?;
                let sub_rules_list = vec![
                    Value::from("GEOSITE,category-ads-all,REJECT"),
                    Value::from("GEOSITE,cn,DIRECT"),
                    Value::from("GEOIP,cn,DIRECT"),
                    Value::from(format!("MATCH,{dest}")),
                    Value::from("MATCH,REJECT"),
                ];
                subrules.insert(Value::from(sub_name.clone()), Value::Sequence(sub_rules_list));
                prefix.push(Value::from(format!("SUB-RULE,({kind},{}),{sub_name}", rule.match_value)));
            } else {
                prefix.push(Value::from(format!("{kind},{},{dest}", rule.match_value)));
                // 不支持 UDP 的代理可能被核心跳过：同一匹配项随后拒绝，禁止落入原有直连。
                if dest != "DIRECT" && dest != "REJECT" { prefix.push(Value::from(format!("{kind},{},REJECT", rule.match_value))); }
            }
        }
        let rules = yaml.as_mapping_mut().ok_or("配置须为对象")?.entry(Value::from("rules"))
            .or_insert(Value::Sequence(vec![])).as_sequence_mut().ok_or("rules 须为数组")?;
        rules.splice(0..0, prefix);
    }
    let dns_rules: Vec<_> = config.dns_rules.iter().filter(|r| config.dns_enabled && r.enabled).collect();
    if !dns_rules.is_empty() {
        for r in &dns_rules { if !available.contains(&r.target) { return Err(format!("域名 {} 的 DNS 出口不可用，请重绑定或禁用该规则", r.domain)); } }
        // 不静默改变已有直连 DNS、hosts 或节点启动解析策略。
        if yaml["dns"]["direct-nameserver"].as_sequence().is_some_and(|v| !v.is_empty())
            && yaml["dns"]["direct-nameserver-follow-policy"].as_bool() != Some(true) {
            return Err("订阅 direct-nameserver 绕过域名策略，请先明确设置 direct-nameserver-follow-policy: true".into());
        }
        if yaml["hosts"].as_mapping().is_some_and(|m| m.keys().any(|k| k.as_str().is_some_and(|s| dns_rules.iter().any(|r| domains_overlap(s, r))))) {
            return Err("指定 DNS 域名与订阅 hosts 冲突，请先移除对应 hosts".into());
        }
        #[cfg(windows)]
        if yaml["dns"]["use-system-hosts"].as_bool() != Some(false) {
            let hosts_path = std::path::PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into())).join("System32/drivers/etc/hosts");
            let hosts = std::fs::read_to_string(hosts_path).map_err(|_| "无法核对系统 hosts，请检查读取权限")?;
            if hosts.lines().flat_map(|line| line.split('#').next().unwrap_or("").split_whitespace().skip(1)).any(|s| dns_rules.iter().any(|r| matches_domain(s, r))) {
                return Err("指定域名命中系统 hosts，无法应用 DNS 策略；请先处理对应 hosts 或显式关闭核心 use-system-hosts".into());
            }
        }
        let was_enabled = yaml["dns"]["enable"].as_bool() == Some(true);
        let dns = yaml.as_mapping_mut().ok_or("配置须为对象")?.entry(Value::from("dns"))
            .or_insert(Value::Mapping(Default::default())).as_mapping_mut().ok_or("dns 须为对象")?;
        dns.insert("enable".into(), true.into());
        dns.entry(Value::from("ipv6")).or_insert(false.into());
        if !was_enabled {
            // 无既有解析器时仅启用内部解析；不新增监听，不改网卡，也不引入 fake-ip。
            dns.insert("enhanced-mode".into(), "redir-host".into());
            dns.insert(Value::from("nameserver"), serde_yaml::to_value(["system"]).unwrap());
            dns.remove(Value::from("fallback"));
        }
        if dns.get(Value::from("proxy-server-nameserver")).is_none_or(|v| v.is_null() || v.as_sequence().is_some_and(|s| s.is_empty())) {
            dns.insert(Value::from("proxy-server-nameserver"), serde_yaml::to_value(["system"]).unwrap());
        }
        let policy = dns.entry(Value::from("nameserver-policy")).or_insert(Value::Mapping(Default::default()))
            .as_mapping_mut().ok_or("nameserver-policy 须为对象")?;
        let original_policy = policy.clone();
        let mut merged_policy = serde_yaml::Mapping::new();
        // 核心会把相邻普通域名合并到同一棵 trie，仅前置域名不能保证覆盖更具体的订阅条目。
        // 使用内联规则集形成独立匹配段：显式 DNS 规则优先，未命中仍按原订阅顺序解析。
        let providers = yaml.as_mapping_mut().ok_or("配置须为对象")?.entry(Value::from("rule-providers"))
            .or_insert(Value::Mapping(Default::default())).as_mapping_mut().ok_or("rule-providers 须为对象")?;
        let mut dns_rules = dns_rules;
        dns_rules.sort_by(|a, b| b.domain.split('.').count().cmp(&a.domain.split('.').count())
            .then_with(|| (a.domain_kind == "suffix").cmp(&(b.domain_kind == "suffix"))));
        let mut index = 0;
        for r in dns_rules {
            let name = loop {
                let name = format!("procweaver-dns-override-{index}"); index += 1;
                if !providers.contains_key(Value::from(name.clone())) { break name; }
            };
            let domain = if r.domain_kind == "suffix" { format!("+.{0}", r.domain) } else { r.domain.clone() };
            providers.insert(name.clone().into(), serde_yaml::to_value(serde_json::json!({
                "type": "inline", "behavior": "domain", "payload": [domain]
            })).map_err(|_| "生成 DNS 域名规则集失败")?);
            merged_policy.insert(format!("rule-set:{name}").into(), format!("{}#{}", r.resolver_url, r.target.name).into());
        }
        merged_policy.extend(original_policy);
        yaml["dns"]["nameserver-policy"] = Value::Mapping(merged_policy);
    }
    serde_yaml::to_string(&yaml).map_err(|_| "合成进程与 DNS 规则失败".into())
}
pub fn matches_domain(value: &str, r: &DnsRule) -> bool {
    let value = value.trim_end_matches('.');
    value.eq_ignore_ascii_case(&r.domain) || (r.domain_kind == "suffix" && value.to_ascii_lowercase().ends_with(&format!(".{}", r.domain)))
}
fn domains_overlap(value: &str, r: &DnsRule) -> bool {
    if value.contains([':', ',', '?']) { return true; } // 无法局部判断的规则集或模式须显式解决。
    let suffix = value.starts_with("+.") || value.starts_with("*.") || value.starts_with('.');
    let bare = value.trim_start_matches(['*', '+', '.']).trim_end_matches('.').to_ascii_lowercase();
    if bare.contains('*') { return true; }
    matches_domain(&bare, r) || (suffix && r.domain.ends_with(&format!(".{bare}")))
}

pub fn safety(raw: &str) -> Result<String, String> {
    let mut yaml: Value = serde_yaml::from_str(raw).map_err(|_| "配置 YAML 无效")?;
    let mut prefix: Vec<Value> = ["IP-CIDR,127.0.0.0/8,DIRECT,no-resolve", "IP-CIDR,10.0.0.0/8,DIRECT,no-resolve", "IP-CIDR,172.16.0.0/12,DIRECT,no-resolve", "IP-CIDR,192.168.0.0/16,DIRECT,no-resolve", "IP-CIDR6,::1/128,DIRECT,no-resolve", "IP-CIDR6,fc00::/7,DIRECT,no-resolve", "IP-CIDR6,fe80::/10,DIRECT,no-resolve"].into_iter().map(Value::from).collect();
    for name in ["mihomo.exe", "mihomo-v3.exe", "mihomo-compatible.exe"] { prefix.push(format!("PROCESS-NAME,{name},DIRECT").into()); }
    let rules = yaml.as_mapping_mut().ok_or("配置须为对象")?.entry(Value::from("rules")).or_insert(Value::Sequence(vec![])).as_sequence_mut().ok_or("rules 须为数组")?;
    rules.splice(0..0, prefix);
    serde_yaml::to_string(&yaml).map_err(|_| "合成安全例外失败".into())
}

/// 强制注入 BT/PT 下载客户端与 Tracker 直连规则，
/// 并在存在真实节点时，确保标准主出站代理组 PROXY 存在并置于首位，兜底规则指向 PROXY。
pub fn ensure_bt_pt_and_proxy_group(raw: &str) -> Result<String, String> {
    let mut yaml: Value = serde_yaml::from_str(raw).map_err(|_| "配置 YAML 无效")?;
    let map = yaml.as_mapping_mut().ok_or("配置须为对象")?;

    // 1. 提取所有真实出站节点名称
    let mut valid_nodes = Vec::new();
    if let Some(proxies) = map.get(Value::from("proxies")).and_then(|v| v.as_sequence()) {
        for p in proxies {
            if let Some(name) = p.get("name").and_then(|n| n.as_str()) {
                let trimmed = name.trim();
                if !trimmed.is_empty()
                    && trimmed != "DIRECT"
                    && trimmed != "REJECT"
                    && trimmed != "GLOBAL"
                    && trimmed != "PROXY"
                    && !trimmed.starts_with(super::foreign_targets::PREFIX)
                {
                    valid_nodes.push(trimmed.to_string());
                }
            }
        }
    }

    if valid_nodes.is_empty() {
        return Ok(raw.into());
    }

    // 2. 当存在真实出站节点时，确保 proxy-groups 中有标准 PROXY select 组，并置于首位
    if !valid_nodes.is_empty() {
        let groups_entry = map.entry(Value::from("proxy-groups"))
            .or_insert(Value::Sequence(Vec::new()));
        
        if let Some(groups) = groups_entry.as_sequence_mut() {
            let mut proxy_group_index = None;
            for (i, g) in groups.iter().enumerate() {
                if let Some(name) = g.get("name").and_then(|n| n.as_str()) {
                    if name == "PROXY" {
                        proxy_group_index = Some(i);
                        break;
                    }
                }
            }

            let mut node_values: Vec<Value> = valid_nodes.iter()
                .map(|n| Value::String(n.clone()))
                .collect();
            node_values.push(Value::String("DIRECT".to_string()));

            let mut proxy_group_map = serde_yaml::Mapping::new();
            proxy_group_map.insert("name".into(), "PROXY".into());
            proxy_group_map.insert("type".into(), "select".into());
            proxy_group_map.insert("proxies".into(), Value::Sequence(node_values));

            if let Some(idx) = proxy_group_index {
                groups.remove(idx);
            }
            groups.insert(0, Value::Mapping(proxy_group_map));
        }

        // 规整 MATCH 兜底规则指向 PROXY
        if let Some(rules) = map.get_mut(Value::from("rules")).and_then(|v| v.as_sequence_mut()) {
            let mut has_match = false;
            for r in rules.iter_mut() {
                if let Some(s) = r.as_str() {
                    if s.starts_with("MATCH,") {
                        has_match = true;
                        let target = s.trim_start_matches("MATCH,").trim();
                        if target != "DIRECT" && target != "REJECT" {
                            *r = Value::String("MATCH,PROXY".to_string());
                        }
                    }
                }
            }
            if !has_match {
                rules.push(Value::String("MATCH,PROXY".to_string()));
            }
        }
    }

    // 3. 强制在 rules 首部注入 BT/PT 下载客户端与 Tracker 规则（保证全部为 DIRECT）
    let bt_pt_rules = [
        "PROCESS-NAME,qbittorrent.exe,DIRECT",
        "PROCESS-NAME,qbittorrent,DIRECT",
        "PROCESS-NAME,transmission-qt.exe,DIRECT",
        "PROCESS-NAME,transmission-daemon.exe,DIRECT",
        "PROCESS-NAME,transmission.exe,DIRECT",
        "PROCESS-NAME,BitComet.exe,DIRECT",
        "PROCESS-NAME,bitcomet.exe,DIRECT",
        "PROCESS-NAME,Thunder.exe,DIRECT",
        "PROCESS-NAME,xunlei.exe,DIRECT",
        "PROCESS-NAME,ThunderPlatform.exe,DIRECT",
        "PROCESS-NAME,deluge.exe,DIRECT",
        "PROCESS-NAME,utorrent.exe,DIRECT",
        "PROCESS-NAME,uTorrent.exe,DIRECT",
        "PROCESS-NAME,fdm.exe,DIRECT",
        "PROCESS-NAME,motrix.exe,DIRECT",
        "PROCESS-NAME,aria2c.exe,DIRECT",
        "DOMAIN-KEYWORD,torrent,DIRECT",
        "DOMAIN-KEYWORD,tracker,DIRECT",
        "DOMAIN-KEYWORD,announce,DIRECT",
        "DOMAIN-KEYWORD,peer_id=,DIRECT",
        "DOMAIN-KEYWORD,info_hash,DIRECT",
    ];

    let rules_entry = map.entry(Value::from("rules"))
        .or_insert(Value::Sequence(Vec::new()));
    if let Some(rules) = rules_entry.as_sequence_mut() {
        let mut to_insert = Vec::new();
        for item in bt_pt_rules {
            if !rules.iter().any(|r| r.as_str() == Some(item)) {
                to_insert.push(Value::String(item.to_string()));
            }
        }
        if !to_insert.is_empty() {
            rules.splice(0..0, to_insert);
        }
    }

    serde_yaml::to_string(&yaml).map_err(|_| "合成BT保护与标准主组失败".into())
}

/// 在 direct_first（白名单直连绝对最高）模式下，
/// 将规则列表中的所有 DIRECT 终点规则提前至所有代理规则之前，保全用户直连免代理特权。
pub fn prioritize_direct_rules(raw: &str) -> Result<String, String> {
    let mut yaml: Value = serde_yaml::from_str(raw).map_err(|_| "配置 YAML 无效")?;
    if let Some(rules) = yaml.get_mut("rules").and_then(|v| v.as_sequence_mut()) {
        let mut directs = Vec::new();
        let mut others = Vec::new();
        for r in rules.drain(..) {
            let is_direct = r.as_str().map_or(false, |s| {
                let parts: Vec<&str> = s.split(',').map(|p| p.trim()).collect();
                parts.len() >= 3 && parts[2].eq_ignore_ascii_case("DIRECT")
            });
            if is_direct {
                directs.push(r);
            } else {
                others.push(r);
            }
        }
        rules.extend(directs);
        rules.extend(others);
    }
    serde_yaml::to_string(&yaml).map_err(|_| "重排直连规则失败".into())
}

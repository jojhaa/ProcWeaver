use super::{model::*, composer};
use serde_yaml::Value;
use std::collections::{BTreeMap, HashSet};

pub const SELECTIONS: &str = "procweaver-bundle-selections";
pub fn group(id: &str, slot: &str) -> String { format!("PW-{}-{slot}", id.as_bytes().iter().map(|b| format!("{b:02x}")).collect::<String>()) }
pub fn listener(id: &str) -> String { group(id, "entry") }
pub fn owner<'a>(id: &str, bundles: &'a [BundleRoute]) -> Option<&'a BundleRoute> {
    let id = id.strip_prefix("derived:").unwrap_or(id);
    bundles.iter().filter(|b| id.starts_with(&format!("bundle-{}-", b.id))).max_by_key(|b| b.id.len())
}

// 端口归属于包 ID；排序、换节点和暂时停用都不重新编号。
pub fn assign_ports(config: &mut Overrides, old: &Overrides) -> Result<(), String> {
    let mut occupied: HashSet<u16> = old.bundles.iter().map(|b| b.port).filter(|p| *p != 0).collect();
    let mut next = old.next_bundle_port.max(34000).max(occupied.iter().max().map(|p| p.saturating_add(1)).unwrap_or(34000));
    for bundle in &mut config.bundles {
        if let Some(previous) = old.bundles.iter().find(|b| b.id == bundle.id && b.port != 0) { bundle.port = previous.port; }
        else {
            bundle.port = (next..60000).find(|p| !occupied.contains(p) && std::net::TcpListener::bind(("127.0.0.1", *p)).is_ok()
                && std::net::UdpSocket::bind(("127.0.0.1", *p)).is_ok()).ok_or("没有可用的业务包入口编号")?;
            occupied.insert(bundle.port);
            next = bundle.port + 1;
        }
    }
    config.next_bundle_port = next;
    Ok(())
}

pub fn materialize(raw: &str, config: &Overrides, profile_id: &str) -> Result<(String, Overrides), String> {
    let available = composer::targets(raw, profile_id)?;
    let mut yaml: Value = serde_yaml::from_str(raw).map_err(|_| "配置 YAML 无效")?;
    if yaml.get(SELECTIONS).is_some() { return Err("订阅包含业务包保留字段".into()); }
    let mut mapped = config.clone();
    let mut selections = BTreeMap::<String, String>::new();
    let groups = yaml.as_mapping_mut().ok_or("配置须为对象")?.entry(Value::from("proxy-groups"))
        .or_insert(Value::Sequence(vec![])).as_sequence_mut().ok_or("proxy-groups 须为数组")?;
    for bundle in &config.bundles {
        for (slot, target) in [("main", &bundle.main_target), ("dns", &bundle.dns_target)] {
            let target = target.as_ref().or(bundle.main_target.as_ref());
            let destination = if bundle.enabled {
                let target = target.filter(|t| available.contains(t)).ok_or_else(|| format!("「{}」出口已失效，请重新绑定", bundle.name))?;
                target.name.as_str()
            } else { "REJECT" };
            let name = group(&bundle.id, slot);
            if available.iter().any(|t| t.name == name) { return Err("订阅与业务包出口组重名".into()); }
            let mut members: Vec<_> = available.iter().map(|t| t.name.clone()).collect();
            members.sort(); members.insert(0, "REJECT".into());
            groups.push(serde_yaml::to_value(serde_json::json!({"name": name, "type":"select", "proxies": members, "hidden":true})).unwrap());
            selections.insert(name, destination.into());
        }
    }
    for rule in &mut mapped.process_rules { map_process(rule, &config.bundles, profile_id); }
    for rule in &mut mapped.dns_rules {
        if let Some(bundle) = config.bundles.iter().filter(|b| rule.id.starts_with(&format!("bundle-dns-{}-", b.id))).max_by_key(|b| b.id.len()) {
            rule.target = Target { profile_id: profile_id.into(), kind: "group".into(), name: group(&bundle.id, "dns") };
        }
    }
    yaml[SELECTIONS] = serde_yaml::to_value(selections).unwrap();
    Ok((serde_yaml::to_string(&yaml).map_err(|_| "生成业务包出口组失败")?, mapped))
}
pub fn map_process(rule: &mut ProcessRule, bundles: &[BundleRoute], profile_id: &str) {
    if rule.action == "proxy" {
        if let Some(bundle) = owner(&rule.id, bundles) {
            rule.target = Some(Target { profile_id: profile_id.into(), kind: "group".into(), name: group(&bundle.id, "main") });
        }
    }
}
pub fn domain_condition(pattern: &str) -> String {
    match pattern.strip_prefix("*.") { Some(domain)=>format!("DOMAIN-SUFFIX,{domain}"), None=>format!("DOMAIN,{pattern}") }
}
pub fn add_listeners(yaml: &mut Value, config: &Overrides, prefix: &Value, fallback: &[Value]) -> Result<(), String> {
    for bundle in &config.bundles {
        if bundle.port == 0 { return Err("业务包入口尚未分配，请重新应用".into()); }
        let name = listener(&bundle.id);
        let mut rules = prefix["rules"].as_sequence().cloned().unwrap_or_default();
        if bundle.enabled && config.process_enabled {
            if bundle.mode == "sandbox" {
                for pattern in &bundle.domains {
                    let condition=domain_condition(pattern);
                    rules.push(format!("{condition},{}",group(&bundle.id,"main")).into());
                    rules.push(format!("{condition},REJECT").into());
                }
                // 原规则快照在业务包注入前取得，不能再次命中本包或其他包的进程绑定。
                if bundle.fallback == "direct" { rules.push("MATCH,DIRECT".into()); }
                else { rules.extend_from_slice(fallback); }
            } else {
                rules.push(format!("MATCH,{}", group(&bundle.id, "main")).into());
                rules.push("MATCH,REJECT".into());
            }
        } else { rules.extend_from_slice(fallback); }
        let subrules = yaml["sub-rules"].as_mapping_mut().ok_or("sub-rules 须为对象")?;
        if subrules.contains_key(Value::from(name.clone())) { return Err("业务包入口与订阅重名".into()); }
        subrules.insert(name.clone().into(), rules.into());
        let listeners = yaml["listeners"].as_sequence_mut().ok_or("listeners 须为数组")?;
        if listeners.iter().any(|l| crate::capture::contains_port(&l["port"], bundle.port) || crate::capture::contains_port(&l["ports"], bundle.port) || l["name"].as_str() == Some(&name)) {
            return Err("业务包入口端口与已有监听冲突".into());
        }
        listeners.push(serde_yaml::to_value(serde_json::json!({"name":name,"type":"mixed","listen":"127.0.0.1","port":bundle.port,"udp":true,"rule":name})).unwrap());
    }
    Ok(())
}
pub fn structural(raw: &str) -> Result<Value, String> {
    let mut yaml: Value = serde_yaml::from_str(raw).map_err(|_| "配置 YAML 无效")?;
    if let Some(map) = yaml.as_mapping_mut() { map.remove(Value::from(SELECTIONS)); map.remove(Value::from("netbox-capture")); }
    Ok(yaml)
}
pub async fn select(raw: &str) -> Result<(), String> {
    let yaml: Value = serde_yaml::from_str(raw).map_err(|_| "配置 YAML 无效")?;
    let selections: BTreeMap<String, String> = if yaml[SELECTIONS].is_null() { BTreeMap::new() }
        else { serde_yaml::from_value(yaml[SELECTIONS].clone()).map_err(|_| "业务包出口映射无效")? };
    if selections.is_empty() { return Ok(()); }
    let port = crate::commands::settings::get_general_settings()?.controller_port;
    let client = crate::commands::mihomo_api::controller_client().timeout(std::time::Duration::from_secs(4)).build().map_err(|_| "核心连接失败")?;
    let root = reqwest::Url::parse(&format!("http://127.0.0.1:{port}/proxies/")).unwrap();
    for (name, target) in selections {
        let mut url = root.clone(); url.path_segments_mut().unwrap().pop_if_empty().push(&name);
        let current: serde_json::Value = client.get(url.clone()).send().await.map_err(|_| "读取业务包出口失败")?
            .error_for_status().map_err(|_| "业务包出口组不存在")?.json().await.map_err(|_| "出口状态无效")?;
        if current["now"].as_str() == Some(&target) { continue; }
        client.put(url.clone()).json(&serde_json::json!({"name":target})).send().await.map_err(|_| "切换业务包出口失败")?
            .error_for_status().map_err(|_| "核心拒绝业务包出口")?;
        let confirmed: serde_json::Value = client.get(url).send().await.map_err(|_| "核验业务包出口失败")?
            .error_for_status().map_err(|_| "核心拒绝出口核验")?.json().await.map_err(|_| "出口状态无效")?;
        if confirmed["now"].as_str() != Some(&target) { return Err("业务包出口未确认，已请求恢复原选择".into()); }
    }
    Ok(())
}

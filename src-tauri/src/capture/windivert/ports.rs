//! Resolve only generated WinDivert inlets at apply time. Offline compilation
//! stays deterministic; host networking and user-defined ports are never changed.
use super::{ownership::Identity, plan::{Entry, Plan, KEY}};
use serde_yaml::Value;
use std::{collections::BTreeSet, net::{TcpListener, UdpSocket}};

pub(super) fn owned(port: u16, pid: u32, protocol: u8) -> bool {
    pid != 0 && super::owner::lookup(super::packet::Flow {
        source: ([127, 0, 0, 1], port).into(),
        destination: ([0, 0, 0, 0], 0).into(), protocol,
    }) == Some(pid)
}

fn reserve(port: u16) -> Option<(TcpListener, UdpSocket)> {
    let tcp = TcpListener::bind(("127.0.0.1", port)).ok()?;
    let udp = UdpSocket::bind(("127.0.0.1", port)).ok()?;
    Some((tcp, udp))
}

fn same_identity(a: &Entry, b: &Entry) -> bool {
    a.owner == b.owner && a.kind == b.kind && a.value.eq_ignore_ascii_case(&b.value)
}

fn configured(yaml: &Value, generated: &BTreeSet<usize>, port: u16) -> bool {
    ["port", "socks-port", "mixed-port", "redir-port", "tproxy-port"].iter()
        .any(|key| crate::capture::contains_port(&yaml[*key], port))
        || [yaml["external-controller"].as_str(), yaml["external-controller-tls"].as_str(), yaml["dns"]["listen"].as_str()]
            .into_iter().flatten().any(|address| address.rsplit(':').next().and_then(|p| p.parse::<u16>().ok()) == Some(port))
        || yaml["listeners"].as_sequence().is_some_and(|items| items.iter().enumerate().any(|(index, listener)|
            !generated.contains(&index) && (crate::capture::contains_port(&listener["port"], port)
                || crate::capture::contains_port(&listener["ports"], port))))
}

pub async fn resolve_for_apply(raw: &str, core_pid: u32) -> Result<String, String> {
    let raw = raw.to_string();
    tokio::task::spawn_blocking(move || {
        let previous = super::session::confirmed_plan(core_pid);
        resolve(&raw, previous.as_ref())
    }).await.map_err(|_| "WinDivert 入口分配任务失败")?
}

fn resolve(raw: &str, previous: Option<&(Plan, Identity)>) -> Result<String, String> {
    let mut yaml: Value = serde_yaml::from_str(raw).map_err(|_| "WinDivert 运行配置无法解析")?;
    if yaml.get(KEY).is_none() { return Ok(raw.into()); }
    let mut plan: Plan = serde_yaml::from_value(yaml[KEY].clone()).map_err(|_| "WinDivert 入口计划无效")?;
    plan.validate()?;
    let listeners = yaml["listeners"].as_sequence().ok_or("WinDivert 缺少入口配置")?;
    let mut generated = BTreeSet::new();
    let mut indices = Vec::new();
    for entry in &plan.entries {
        let name = format!("pw-wd-{}", entry.id()?);
        let matches: Vec<_> = listeners.iter().enumerate().filter(|(_, v)| v["name"].as_str() == Some(&name)).collect();
        if matches.len() != 1 { return Err("WinDivert 入口名称缺失或重复".into()); }
        let (index, listener) = matches[0];
        if listener["type"].as_str() != Some("socks") || listener["listen"].as_str() != Some("127.0.0.1")
            || listener["port"].as_u64() != Some(entry.port as u64) || listener["udp"].as_bool() != Some(true)
            || listener["rule"].as_str() != Some(&name) || !generated.insert(index) {
            return Err("WinDivert 入口与规则上下文不一致".into());
        }
        indices.push(index);
    }
    let previous = previous.filter(|(_, core)| Identity::inspect(core.pid).as_ref() == Some(core));
    let mut used = BTreeSet::new();
    let mut reservations = Vec::new();
    let mut remapped = std::collections::BTreeMap::new();
    for (entry, index) in plan.entries.iter_mut().zip(indices) {
        let reusable = previous.and_then(|(old, core)| old.entries.iter().find(|old| same_identity(entry, old))
            .filter(|old| owned(old.port, core.pid, 6) && owned(old.port, core.pid, 17)).map(|old| old.port));
        let offset = entry.port - 61000;
        let port = reusable.into_iter().chain((0..4000).map(|i| 61000 + (offset + i) % 4000)).find(|port| {
            if used.contains(port) || configured(&yaml, &generated, *port) { return false; }
            if Some(*port) == reusable { return true; }
            if let Some(sockets) = reserve(*port) { reservations.push(sockets); true } else { false }
        }).ok_or("WinDivert 没有可用的本地 TCP/UDP 入口端口（61000–64999）；旧配置未改变")?;
        used.insert(port);
        let original_port = entry.port;
        entry.port = port;
        yaml["listeners"][index]["port"] = port.into();
        remapped.insert((entry.owner.clone(), original_port), port);
    }
    for target in &mut plan.targets {
        target.port = *remapped.get(&(target.owner.clone(), target.port)).ok_or("接管目标入口映射丢失")?;
    }
    plan.validate()?;
    yaml[KEY] = serde_yaml::to_value(plan).map_err(|_| "WinDivert 入口计划无法编码")?;
    // Hold both transports until the complete candidate has been generated.
    // Post-load ownership checks still reject a race before the core binds them.
    serde_yaml::to_string(&yaml).map_err(|_| "WinDivert 运行配置无法生成".into())
}

#[cfg(test)]
mod tests;

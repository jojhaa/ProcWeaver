//! Opt-in, per-bundle loopback DNS. Never changes adapter/system DNS settings.
use super::{model::Endpoint, transport::{self, Destination}, udp::Channel, Engine};
use std::{sync::Arc, time::Duration};
use tokio::{io::{AsyncReadExt, AsyncWriteExt}, net::{TcpListener, TcpStream, UdpSocket}, sync::{watch, Semaphore}};

#[derive(Debug)]
pub(super) struct Question { pub name: String, id: u16, kind: u16, class: u16, end: usize }
impl PartialEq for Question {
    fn eq(&self, other: &Self) -> bool { self.name == other.name && self.id == other.id && self.kind == other.kind && self.class == other.class }
}
fn parse(packet: &[u8], reply: bool) -> Result<Question, String> {
    if packet.len() < 12 || packet.len() > 65535 || (packet[2] & 128 != 0) != reply || packet[2] & 0x78 != 0 || packet[4..6] != [0, 1] { return Err("DNS 查询头无效，仅支持单问题标准查询".into()); }
    let mut at = 12; let mut labels = Vec::new(); let mut end = None; let mut visited = Vec::new(); let mut size = 0;
    loop {
        if visited.len() >= 128 || visited.contains(&at) { return Err("DNS 名称压缩指针循环或过深".into()); }
        visited.push(at);
        let len = *packet.get(at).ok_or("DNS 查询名不完整")? as usize; at += 1;
        if len == 0 { break; }
        if len & 0xc0 == 0xc0 {
            let low = *packet.get(at).ok_or("DNS 名称指针不完整")? as usize;
            if end.is_none() { end = Some(at + 1); }
            at = ((len & 63) << 8) | low;
            if at < 12 || at >= packet.len() { return Err("DNS 名称指针越界".into()); }
            continue;
        }
        size += len + 1;
        if len > 63 || size > 254 { return Err("DNS 查询名过长或标签无效".into()); }
        let part = packet.get(at..at + len).ok_or("DNS 查询名不完整")?; at += len;
        if !part.iter().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_')) { return Err("DNS 查询名无效".into()); }
        labels.push(std::str::from_utf8(part).map_err(|_| "DNS 查询名无效")?.to_ascii_lowercase());
    }
    at = end.unwrap_or(at);
    let tail = packet.get(at..at + 4).ok_or("DNS 查询类型不完整")?;
    Ok(Question { name: labels.join("."), id: u16::from_be_bytes([packet[0], packet[1]]), kind: u16::from_be_bytes([tail[0], tail[1]]), class: u16::from_be_bytes([tail[2], tail[3]]), end: at + 4 })
}
pub(super) fn question(packet: &[u8]) -> Result<Question, String> { parse(packet, false) }
// The connectivity probe never retries over TCP. Validate the complete record
// envelope as well as the echoed question before claiming a UDP response.
pub(super) fn probe_reply(query: &[u8], reply: &[u8]) -> Result<Option<(u8, bool)>, String> {
    let expected = question(query)?;
    let Ok(actual) = parse(reply, true) else { return Ok(None); };
    if actual != expected { return Ok(None); }
    let mut names = std::collections::BTreeSet::new();
    record_name_end(reply, 12, &mut names)?;
    let mut at = actual.end;
    let count: usize = [6, 8, 10].iter().map(|&i| u16::from_be_bytes([reply[i], reply[i + 1]]) as usize).sum();
    for _ in 0..count {
        at = record_name_end(reply, at, &mut names)?;
        let head = reply.get(at..at + 10).ok_or("DNS 响应记录头不完整")?;
        let kind = u16::from_be_bytes([head[0], head[1]]);
        let len = u16::from_be_bytes([head[8], head[9]]) as usize;
        at += 10;
        reply.get(at..at + len).ok_or("DNS 响应记录内容不完整")?;
        if (kind == 1 && len != 4) || (kind == 28 && len != 16) { return Err("DNS 地址记录长度无效".into()); }
        // Register known name-bearing RDATA, including CNAME targets which a
        // later address record may reference. Never accept pointers into label
        // bodies or arbitrary opaque record data.
        let name_start = match kind {
            2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 12 | 14 | 17 | 30 | 39 | 47 => Some(at),
            15 | 18 | 21 | 36 | 64 | 65 => Some(at + 2),
            33 => Some(at + 6),
            24 | 46 => Some(at + 18),
            _ => None,
        };
        if let Some(start) = name_start {
            let mut end = record_name_end(reply, start, &mut names)?;
            if matches!(kind, 6 | 14 | 17) { end = record_name_end(reply, end, &mut names)?; }
            if end > at + len || (kind == 6 && end + 20 != at + len) { return Err("DNS 记录中的名称越界".into()); }
        }
        at += len;
    }
    if at != reply.len() || reply[3] & 0x40 != 0 { return Err("DNS 响应格式无效".into()); }
    Ok(Some((reply[3] & 15, reply[2] & 2 != 0)))
}
fn record_name_end(packet: &[u8], mut at: usize, names: &mut std::collections::BTreeSet<usize>) -> Result<usize, String> {
    let mut end = None; let mut size = 0;
    for _ in 0..128 {
        let len = *packet.get(at).ok_or("DNS 记录名称不完整")? as usize;
        if len == 0 { names.insert(at); return Ok(end.unwrap_or(at + 1)); }
        if len & 0xc0 == 0xc0 {
            let low = *packet.get(at + 1).ok_or("DNS 记录指针不完整")? as usize;
            let target = ((len & 63) << 8) | low;
            if target >= at || !names.contains(&target) { return Err("DNS 记录名称指针无效".into()); }
            names.insert(at);
            end.get_or_insert(at + 2); at = target;
        } else {
            size += len + 1;
            if len > 63 || size > 254 { return Err("DNS 记录名称无效".into()); }
            packet.get(at + 1..at + 1 + len).ok_or("DNS 记录名称不完整")?;
            names.insert(at);
            at += 1 + len;
        }
    }
    Err("DNS 记录名称指针过深".into())
}
pub(super) fn failure(query: &[u8], code: u8) -> Vec<u8> {
    if query.len() < 12 { return vec![]; }
    let mut result = query[..12].to_vec(); result[2] = 0x80 | (query[2] & 1); result[3] = 0x80 | code;
    result[4..12].fill(0);
    if let Ok(q) = question(query) {
        result[5] = 1;
        append_name(&mut result, &q.name);
        result.extend(q.kind.to_be_bytes()); result.extend(q.class.to_be_bytes());
    }
    result
}
fn append_name(packet: &mut Vec<u8>, name: &str) {
    for part in name.split('.').filter(|s| !s.is_empty()) { packet.push(part.len() as u8); packet.extend(part.as_bytes()); }
    packet.push(0);
}
pub(super) fn query(name: &str, id: u16) -> Result<Vec<u8>, String> {
    if !super::model::valid_host(name) || name.parse::<std::net::IpAddr>().is_ok() { return Err("DNS 检测目标须为有效域名".into()); }
    let mut packet = vec![0; 12]; packet[..2].copy_from_slice(&id.to_be_bytes()); packet[2] = 1; packet[5] = 1;
    append_name(&mut packet, name); packet.extend([0, 1, 0, 1]); Ok(packet)
}
fn udp_limit(query: &[u8], q: &Question) -> usize {
    // A single, ordinary EDNS OPT RR immediately after the question. Unknown
    // extensions use the conservative classic DNS UDP size.
    let rest = &query[q.end..];
    if query[6..10] == [0, 0, 0, 0] && query[10..12] == [0, 1] && rest.len() >= 11 && rest[..3] == [0, 0, 41] {
        u16::from_be_bytes([rest[3], rest[4]]).clamp(512, 4096) as usize
    } else { 512 }
}
pub(super) fn fit_udp(query: &[u8], mut response: Vec<u8>) -> Vec<u8> {
    let Ok(q) = question(query) else { return failure(query, 1); };
    if response.len() > udp_limit(query, &q) {
        let code = response.get(3).copied().unwrap_or(2) & 15;
        response = failure(query, code); response[2] |= 2;
    }
    response
}
async fn tcp_exchange(endpoint: Option<&Endpoint>, target: &Destination, query: &[u8], ports: &[u16], trace: &super::diagnostics::Trace) -> Result<Vec<u8>, String> {
    let mut stream = transport::connect_traced(endpoint, target, ports,trace).await?;
    stream.write_u16(query.len() as u16).await.map_err(|_| "DNS TCP 查询失败")?;
    stream.write_all(query).await.map_err(|_| "DNS TCP 查询失败")?;
    let len = stream.read_u16().await.map_err(|_| "DNS TCP 响应不完整")? as usize;
    if len < 12 { return Err("DNS TCP 响应无效".into()); }
    let mut reply = vec![0; len]; stream.read_exact(&mut reply).await.map_err(|_| "DNS TCP 响应不完整")?; Ok(reply)
}
pub(super) async fn exchange(endpoint: Option<&Endpoint>, target: &Destination, query: &[u8], ports: &[u16]) -> Result<Vec<u8>, String> {
    exchange_using(endpoint, target, query, ports, false).await
}
pub(super) async fn exchange_using(endpoint: Option<&Endpoint>, target: &Destination, query: &[u8], ports: &[u16], tcp: bool) -> Result<Vec<u8>, String> {
    exchange_traced(endpoint,target,query,ports,tcp,&super::diagnostics::Trace::new(None)).await
}
pub(super) async fn exchange_traced(endpoint: Option<&Endpoint>, target: &Destination, query: &[u8], ports: &[u16], tcp: bool, trace: &super::diagnostics::Trace) -> Result<Vec<u8>, String> {
    let q = question(query)?;
    let _activity=trace.activity("dns"); let step=trace.step("dns.exchange");
    trace.event("dns.query","info",serde_json::json!({"name":q.name,"resolver":target.authority(),"tcp":tcp,"bytes":query.len(),"budgetMs":10000}));
    let result=tokio::time::timeout(Duration::from_secs(10), async {
        let mut reply = if tcp || endpoint.is_some_and(|e| e.protocol == "http") {
            tcp_exchange(endpoint, target, query, ports,trace).await?
        } else {
            let mut channel = Channel::open_traced(endpoint, target, ports,trace.clone()).await?;
            channel.send(query).await?;
            let mut buffer = vec![0; 65535];
            loop {
                let (_, reply) = channel.receive(&mut buffer).await?;
                if parse(&reply, true).is_ok_and(|r| r == q) { break reply; }
            }
        };
        if parse(&reply, true)? != q { return Err("DNS 响应与查询不匹配".into()); }
        if reply[2] & 2 != 0 {
            // TCP retry follows the very same selected endpoint, never a local
            // or direct fallback when a proxy was selected.
            trace.event("dns.tcp_retry","info",serde_json::json!({"reason":"truncated_response"}));
            reply = tcp_exchange(endpoint, target, query, ports,trace).await?;
            if parse(&reply, true)? != q || reply[2] & 2 != 0 { return Err("DNS TCP 重试仍返回截断或不匹配的响应".into()); }
        }
        Ok(reply)
    }).await.unwrap_or_else(|_|Err("DNS 上游查询超时，未改走本机 DNS 或直连".into()));
    step.finish(result.is_ok(),match &result { Ok(reply)=>serde_json::json!({"responseBytes":reply.len(),"rcode":reply[3]&15}),Err(error)=>serde_json::json!({"error":error}) }); result
}

pub(super) async fn bind(port: u16) -> Result<(TcpListener, UdpSocket), String> {
    if port != 0 {
        let tcp = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).await.map_err(|_| "DNS TCP 端口被占用或不可绑定")?;
        let udp = UdpSocket::bind((std::net::Ipv4Addr::LOCALHOST, port)).await.map_err(|_| "DNS UDP 端口被占用或不可绑定；保留原配置")?;
        return Ok((tcp, udp));
    }
    let first = TcpListener::bind("127.0.0.1:0").await.map_err(|_| "无法分配 DNS TCP 端口")?;
    let seed = first.local_addr().map_err(|_| "无法读取 DNS 入口地址")?.port() as u32;
    let mut first = Some(first);
    // Windows can hand bind(0) the same just-released TCP port repeatedly even
    // when UDP excludes it. Probe distinct, spaced candidates after the first
    // failure; successful sockets remain reserved through atomic apply.
    for step in 0..256u32 {
        let tcp = if let Some(tcp) = first.take() { tcp } else {
            let candidate = (49152 + (seed + step * 127) % 16384) as u16;
            match TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, candidate)).await { Ok(tcp) => tcp, Err(_) => continue }
        };
        let address = tcp.local_addr().map_err(|_| "无法读取 DNS 入口地址")?;
        match UdpSocket::bind(address).await {
            Ok(udp) => return Ok((tcp, udp)),
            Err(_) => continue,
        }
    }
    Err("未找到 TCP/UDP 均可用的 DNS 端口".into())
}
pub(super) async fn listen(runtime: Arc<Engine>, id: String, tcp: TcpListener, udp: UdpSocket, mut stop: watch::Receiver<bool>) {
    let udp = Arc::new(udp); let local_capacity = Arc::new(Semaphore::new(32));
    let mut tasks = tokio::task::JoinSet::new(); let mut buffer = vec![0; 65535];
    loop {
        tokio::select! {
            _ = stop.changed() => break,
            Some(_) = tasks.join_next(), if !tasks.is_empty() => {},
            received = udp.recv_from(&mut buffer) => {
                let Ok((len, source)) = received else { break; };
                if !source.ip().is_loopback() || len > 4096 || question(&buffer[..len]).is_err() { continue; }
                let Ok(local) = local_capacity.clone().try_acquire_owned() else { continue; };
                let Ok(global) = runtime.capacity.clone().try_acquire_owned() else { continue; };
                let data = buffer[..len].to_vec(); let udp = udp.clone(); let runtime = runtime.clone(); let id = id.clone();
                tasks.spawn(async move {
                    let _permits = (local, global);
                    if let Ok(process) = super::identity::inspect_udp(source).await {
                        let reply = handle(&runtime, &id, &process, &data, false).await;
                        // Do not deliver a response to a recycled UDP port.
                        if super::identity::udp_matches(source, &process).await { let _ = udp.send_to(&fit_udp(&data, reply), source).await; }
                    }
                });
            },
            accepted = tcp.accept() => {
                let Ok((stream, source)) = accepted else { break; };
                if !source.ip().is_loopback() { continue; }
                let Ok(local) = local_capacity.clone().try_acquire_owned() else { continue; };
                let Ok(global) = runtime.capacity.clone().try_acquire_owned() else { continue; };
                let runtime = runtime.clone(); let id = id.clone();
                tasks.spawn(async move { let _permits = (local, global); let _ = serve_tcp(runtime, id, stream).await; });
            }
        }
    }
    tasks.abort_all();
    while tasks.join_next().await.is_some() {}
}
async fn handle(runtime: &Engine, id: &str, process: &crate::routing_overrides::tracker::ProcessEntry, query: &[u8], tcp: bool) -> Vec<u8> {
    let Ok(q) = question(query) else { return failure(query, 1); };
    let policy_target = Destination { host: q.name, port: 53 };
    let Ok((endpoint, route, generation, ports)) = runtime.select(id, process, &policy_target) else { return failure(query, 5); };
    let settings = runtime.config().dns;
    if !settings.enabled { return failure(query, 5); }
    let target = Destination { host: settings.server, port: settings.port };
    let record = runtime.record(id, process.pid, &process.name, &policy_target.authority(), &format!("DNS · {route}"), generation, endpoint.as_ref());
    let result = exchange_traced(endpoint.as_ref(), &target, query, &ports, tcp,&super::diagnostics::Trace::new(Some(record))).await;
    let current = runtime.config().dns;
    if !current.enabled || current.server != target.host || current.port != target.port
        || !runtime.select(id, process, &policy_target).is_ok_and(|(now, _, _, _)| now == endpoint) {
        runtime.update(record, "failed", "DNS 出口配置已改变，旧响应已丢弃，请重新查询", (0, 0));
        return failure(query, 2);
    }
    match result {
        Ok(reply) => { runtime.update(record, "response", "DNS 响应已转发", (query.len() as u64, reply.len() as u64)); reply },
        Err(error) => { runtime.update(record, "failed", &error, (0, 0)); failure(query, 2) },
    }
}
async fn serve_tcp(runtime: Arc<Engine>, id: String, mut stream: TcpStream) -> Result<(), String> {
    let source = stream.peer_addr().map_err(|_| "DNS 连接无效")?; let destination = stream.local_addr().map_err(|_| "DNS 入口无效")?;
    for _ in 0..512 {
        let query = tokio::time::timeout(Duration::from_secs(30), async {
            let len = stream.read_u16().await.map_err(|_| "DNS TCP 连接结束")? as usize;
            if !(12..=4096).contains(&len) { return Err("DNS TCP 查询长度无效"); }
            let mut data = vec![0; len]; stream.read_exact(&mut data).await.map_err(|_| "DNS TCP 查询不完整")?; Ok(data)
        }).await.map_err(|_| "DNS TCP 读取超时")??;
        let process = super::identity::inspect(source, destination).await?;
        let response = handle(&runtime, &id, &process, &query, true).await;
        tokio::time::timeout(transport::HANDSHAKE, async {
            stream.write_u16(response.len() as u16).await?; stream.write_all(&response).await
        }).await.map_err(|_| "DNS TCP 回写超时")?.map_err(|_| "DNS TCP 回写失败")?;
    }
    Ok(())
}

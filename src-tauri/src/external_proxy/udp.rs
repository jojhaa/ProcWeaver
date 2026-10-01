//! SOCKS5 UDP associations are scoped to a verified TCP control connection.
use super::{transport::{self, Destination}, model::Endpoint, Engine};
use crate::routing_overrides::tracker::ProcessEntry;
use std::{collections::HashMap, net::{IpAddr, SocketAddr}, sync::Arc, time::Duration};
use tokio::{io::{AsyncReadExt, AsyncWriteExt}, net::{TcpStream, UdpSocket}, sync::{mpsc, watch}};

const MAX_PACKET: usize = 65507;
const IDLE: Duration = Duration::from_secs(120);

pub(super) fn decode(packet: &[u8]) -> Result<(Destination, &[u8]), String> {
    if packet.len() < 4 || packet[..3] != [0, 0, 0] { return Err("UDP 报文无效或使用了不支持的 SOCKS5 分片".into()); }
    let mut at = 4;
    let host = match packet[3] {
        1 => { let bytes: [u8; 4] = packet.get(at..at + 4).ok_or("UDP IPv4 地址不完整")?.try_into().unwrap(); at += 4; std::net::Ipv4Addr::from(bytes).to_string() },
        4 => { let bytes: [u8; 16] = packet.get(at..at + 16).ok_or("UDP IPv6 地址不完整")?.try_into().unwrap(); at += 16; std::net::Ipv6Addr::from(bytes).to_string() },
        3 => { let len = *packet.get(at).ok_or("UDP 域名不完整")? as usize; at += 1;
            let value = std::str::from_utf8(packet.get(at..at + len).ok_or("UDP 域名不完整")?).map_err(|_| "UDP 域名无效")?.to_string(); at += len; value },
        _ => return Err("UDP 地址类型不支持".into()),
    };
    let port = u16::from_be_bytes(packet.get(at..at + 2).ok_or("UDP 端口不完整")?.try_into().unwrap()); at += 2;
    Ok((Destination::new(&host, port)?, &packet[at..]))
}
pub(super) fn encode(destination: &Destination, data: &[u8]) -> Result<Vec<u8>, String> {
    let mut output = vec![0, 0, 0]; transport::encode_destination(destination, &mut output); output.extend(data);
    if output.len() > MAX_PACKET { return Err("UDP 报文超过转发大小限制".into()); } Ok(output)
}

pub(super) struct Channel { socket: UdpSocket, control: Option<TcpStream>, target: Destination }
impl Channel {
    pub async fn open(endpoint: Option<&Endpoint>, target: &Destination, forbidden: &[u16]) -> Result<Self, String> {
        tokio::time::timeout(transport::HANDSHAKE, async {
            if let Some(endpoint) = endpoint {
                if endpoint.protocol != "socks5" { return Err("HTTP 上游不支持普通 UDP 转发，请选择支持 UDP 的 SOCKS5 代理".into()); }
                let mut control = transport::dial(&endpoint.host, endpoint.port, forbidden).await?;
                let local = control.local_addr().map_err(|_| "无法取得 UDP 控制连接地址")?;
                let socket = UdpSocket::bind(SocketAddr::new(local.ip(), 0)).await.map_err(|_| "无法绑定 UDP 转发入口")?;
                transport::socks_authenticate(&mut control, endpoint).await?;
                let address = socket.local_addr().map_err(|_| "无法取得 UDP 地址")?;
                let bound = transport::socks_request(&mut control, 3, &Destination { host: address.ip().to_string(), port: address.port() }).await?;
                if bound.port == 0 { return Err("SOCKS5 上游返回了无效 UDP 端口".into()); }
                let host = if bound.host.parse::<IpAddr>().is_ok_and(|ip| ip.is_unspecified()) {
                    control.peer_addr().map_err(|_| "无法取得 SOCKS5 上游地址")?.ip().to_string()
                } else { bound.host };
                let relay = resolve(&host, bound.port, forbidden, Some(local.is_ipv4())).await?;
                socket.connect(relay).await.map_err(|_| "连接 SOCKS5 UDP 中继失败")?;
                Ok(Self { socket, control: Some(control), target: target.clone() })
            } else {
                let address = resolve(&target.host, target.port, forbidden, None).await?;
                let bind = if address.is_ipv4() { "0.0.0.0:0" } else { "[::]:0" };
                let socket = UdpSocket::bind(bind).await.map_err(|_| "无法绑定直连 UDP 入口")?;
                socket.connect(address).await.map_err(|_| "无法连接直连 UDP 目标")?;
                Ok(Self { socket, control: None, target: target.clone() })
            }
        }).await.map_err(|_| "UDP 上游握手超时".to_string())?
    }
    pub async fn send(&self, data: &[u8]) -> Result<(), String> {
        let encoded;
        let packet = if self.control.is_some() { encoded = encode(&self.target, data)?; &encoded } else { data };
        self.socket.send(packet).await.map_err(|_| "UDP 转发失败，未直连重试")?; Ok(())
    }
    pub async fn receive(&mut self, buffer: &mut [u8]) -> Result<(Destination, Vec<u8>), String> {
        let result = if let Some(control) = &mut self.control {
            tokio::select! {
                _ = control.read_u8() => return Err("SOCKS5 UDP 控制连接已关闭".into()),
                result = self.socket.recv(buffer) => result,
            }
        } else { self.socket.recv(buffer).await };
        let len = result.map_err(|_| "UDP 上游接收失败")?;
        if self.control.is_some() {
            let (source, data) = decode(&buffer[..len])?;
            if source.port != self.target.port || self.target.host.parse::<IpAddr>().is_ok_and(|target| source.host.parse::<IpAddr>().ok() != Some(target)) {
                return Err("UDP 上游响应地址与请求不符".into());
            }
            Ok((source, data.to_vec()))
        } else { Ok((self.target.clone(), buffer[..len].to_vec())) }
    }
}
async fn resolve(host: &str, port: u16, forbidden: &[u16], ipv4: Option<bool>) -> Result<SocketAddr, String> {
    let addresses = tokio::net::lookup_host((host, port)).await.map_err(|_| "UDP 中继或直连目标解析失败")?;
    for address in addresses.take(16) {
        if address.ip().is_unspecified() || address.ip().is_multicast() || address.ip() == IpAddr::V4(std::net::Ipv4Addr::BROADCAST) { continue; }
        if address.ip().is_loopback() && forbidden.contains(&address.port()) { return Err("UDP 目标指向本程序入口，已阻止循环".into()); }
        if ipv4.is_none_or(|v| v == address.is_ipv4()) { return Ok(address); }
    }
    Err("没有可用的 UDP 地址".into())
}

struct Flow { sender: mpsc::Sender<Vec<u8>>, task: tokio::task::AbortHandle, endpoint: Option<Endpoint> }
impl Drop for Flow { fn drop(&mut self) { self.task.abort(); } }
struct Response { policy: Destination, endpoint: Option<Endpoint>, packet: Vec<u8> }
pub(super) async fn associate(runtime: Arc<Engine>, id: String, mut control: TcpStream, mut process: ProcessEntry, requested: Destination, mut stop: watch::Receiver<bool>) -> Result<(), String> {
    let peer = control.peer_addr().map_err(|_| "UDP 控制连接无效")?;
    let requested_ip = requested.host.parse::<IpAddr>().map_err(|_| "UDP 客户端地址必须为 IP")?;
    if !requested_ip.is_unspecified() && requested_ip != peer.ip() { return Err("UDP 客户端地址与控制连接不符".into()); }
    // Authorize the owner before returning an association. Domain policy is
    // evaluated independently for every datagram, never against this bind address.
    runtime.select(&id, &process, &Destination::new("association.invalid", 1)?)?;
    let socket = UdpSocket::bind("127.0.0.1:0").await.map_err(|_| "本地 UDP 入口绑定失败")?;
    let local = socket.local_addr().map_err(|_| "本地 UDP 地址无效")?;
    let mut reply = vec![5, 0, 0]; transport::encode_destination(&Destination { host: local.ip().to_string(), port: local.port() }, &mut reply);
    control.write_all(&reply).await.map_err(|_| "UDP 入口响应失败")?;
    let mut client = None;
    let mut flows: HashMap<String, Flow> = HashMap::new();
    let mut tasks = tokio::task::JoinSet::new();
    let (out, mut responses) = mpsc::channel::<Response>(64);
    let mut packet = vec![0; 65535];
    let mut identity_checked = std::time::Instant::now();
    let expiry = tokio::time::sleep(IDLE); tokio::pin!(expiry);
    loop {
        tokio::select! {
            _ = stop.changed() => break,
            _ = control.read_u8() => break,
            _ = &mut expiry => break,
            Some(_) = tasks.join_next(), if !tasks.is_empty() => {},
            Some(response) = responses.recv() => {
                if runtime.select(&id, &process, &response.policy).is_ok_and(|(endpoint, _, _, _)| endpoint == response.endpoint) {
                    if let Some(client) = client {
                        if super::identity::udp_matches(client, &process).await { let _ = socket.send_to(&response.packet, client).await; }
                    }
                }
            },
            received = socket.recv_from(&mut packet) => {
                let (len, source) = received.map_err(|_| "本地 UDP 接收失败")?;
                if source.ip() != peer.ip() || requested.port != 0 && requested.port != source.port() || client.is_some_and(|c| c != source) { continue; }
                let Ok((target, data)) = decode(&packet[..len]) else { continue; };
                // Cache the process snapshot, but verify the UDP socket's current
                // PID + creation identity on each packet to prevent port reuse.
                if !super::identity::udp_matches(source, &process).await { continue; }
                if identity_checked.elapsed() >= Duration::from_secs(1) {
                    let fresh = super::identity::inspect(peer, control.local_addr().map_err(|_| "控制连接已失效")?).await?;
                    if fresh.identity != process.identity { break; } process = fresh; identity_checked = std::time::Instant::now();
                }
                client = Some(source); expiry.as_mut().reset(tokio::time::Instant::now() + IDLE);
                let query = if target.port == 53 { if data.len() > 4096 { continue; } match super::dns::question(data) { Ok(q) => Some(q), Err(_) => continue } } else { None };
                let policy_target = query.as_ref().map(|q| Destination { host: q.name.clone(), port: 53 }).unwrap_or_else(|| target.clone());
                let (endpoint, route, generation, ports) = runtime.select(&id, &process, &policy_target)?;
                flows.retain(|_, f| !f.sender.is_closed());
                if query.is_some() {
                    if tasks.len() >= 64 { continue; }
                    let Ok(permit) = runtime.capacity.clone().try_acquire_owned() else { continue; };
                    let record = runtime.record(&id, process.pid, &process.name, &policy_target.authority(), &format!("DNS · {route}"), generation, endpoint.as_ref());
                    let runtime = runtime.clone(); let out = out.clone(); let data = data.to_vec();
                    tasks.spawn(async move {
                        let _permit = permit;
                        match super::dns::exchange(endpoint.as_ref(), &target, &data, &ports).await {
                            Ok(response) => { runtime.update(record, "response", "DNS 响应已转发", (data.len() as u64, response.len() as u64)); if let Ok(packet) = encode(&target, &super::dns::fit_udp(&data, response)) { let _ = out.send(Response { policy: policy_target, endpoint, packet }).await; } },
                            Err(error) => { runtime.update(record, "failed", &error, (0, 0)); if let Ok(packet) = encode(&target, &super::dns::failure(&data, 2)) { let _ = out.send(Response { policy: policy_target, endpoint, packet }).await; } },
                        }
                    });
                    continue;
                }
                let key = target.authority();
                if flows.get(&key).is_some_and(|f| f.endpoint != endpoint) { flows.remove(&key); }
                if !flows.contains_key(&key) {
                    if flows.len() >= 32 { continue; }
                    let Ok(permit) = runtime.capacity.clone().try_acquire_owned() else { continue; };
                    let record = runtime.record(&id, process.pid, &process.name, &target.authority(), &format!("UDP · {route}"), generation, endpoint.as_ref());
                    let (sender, input) = mpsc::channel(32);
                    let runtime = runtime.clone(); let out = out.clone();
                    let selected_endpoint = endpoint.clone();
                    let task = tasks.spawn(async move {
                        let _permit = permit;
                        let _record_guard = UdpRecord { runtime: runtime.clone(), record };
                        if let Err(error) = relay(runtime.clone(), record, endpoint, target, ports, input, out).await { runtime.update(record, "failed", &error, (0, 0)); }
                    });
                    flows.insert(key.clone(), Flow { sender, task, endpoint: selected_endpoint });
                }
                if let Some(flow) = flows.get(&key) { let _ = flow.sender.try_send(data.to_vec()); }
            }
        }
    }
    tasks.abort_all();
    while tasks.join_next().await.is_some() {}
    Ok(())
}
struct UdpRecord { runtime: Arc<Engine>, record: u64 }
impl Drop for UdpRecord {
    fn drop(&mut self) {
        if let Some(record) = self.runtime.records.lock().unwrap_or_else(|e| e.into_inner()).iter_mut().find(|r| r.id == self.record && matches!(r.state.as_str(), "active" | "connecting")) {
            record.state = "closed".into(); record.message = "UDP 会话已释放".into();
        }
    }
}
async fn relay(runtime: Arc<Engine>, record: u64, endpoint: Option<Endpoint>, target: Destination, ports: Vec<u16>, mut input: mpsc::Receiver<Vec<u8>>, output: mpsc::Sender<Response>) -> Result<(), String> {
    let mut channel = Channel::open(endpoint.as_ref(), &target, &ports).await?;
    runtime.update(record, "active", "UDP 转发已建立", (0, 0));
    let mut buffer = vec![0; 65535]; let mut totals = (0, 0);
    let mut recorded = std::time::Instant::now() - Duration::from_secs(1);
    let idle = tokio::time::sleep(IDLE); tokio::pin!(idle);
    loop {
        tokio::select! {
            _ = &mut idle => break,
            data = input.recv() => {
                let Some(data) = data else { break; };
                channel.send(&data).await?; totals.0 += data.len() as u64;
                idle.as_mut().reset(tokio::time::Instant::now() + IDLE);
            },
            result = channel.receive(&mut buffer) => {
                let (source, data) = result?; totals.1 += data.len() as u64;
                let _ = output.try_send(Response { policy: target.clone(), endpoint: endpoint.clone(), packet: encode(&source, &data)? });
                if recorded.elapsed() >= Duration::from_secs(1) { runtime.update(record, "active", "UDP 响应已转发", totals); recorded = std::time::Instant::now(); }
                idle.as_mut().reset(tokio::time::Instant::now() + IDLE);
            }
        }
    }
    runtime.update(record, "closed", "UDP 会话结束", totals); Ok(())
}

use super::{
    driver::{Address, Api, Device},
    packet::{self, Flow, Packet},
    socks, Plan, DNS, FAILURES, TCP, UDP, UNKNOWN,
};
use std::{
    collections::HashMap,
    io::{self, Read, Write},
    net::{Shutdown, SocketAddr, TcpListener, TcpStream, UdpSocket},
    path::Path,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc::{self, SyncSender},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
struct Route {
    flow: Flow,
    token: u16,
    port: u16,
    dns: bool,
    claimed: AtomicBool,
    finished: AtomicBool,
    touched: Mutex<Instant>,
}
#[derive(Default)]
struct Tables {
    flows: HashMap<Flow, Arc<Route>>,
    tokens: HashMap<u16, Arc<Route>>,
    udp: HashMap<Flow, (u32, u64, SyncSender<Vec<u8>>)>,
    udp_generation: u64,
    next: u16,
}
struct Shared {
    plan: Plan,
    device: Arc<Device>,
    stop: AtomicBool,
    paused: AtomicBool,
    table: Mutex<Tables>,
    workers: AtomicUsize,
    v4: u16,
    v6: u16,
    proxy_override: Option<Vec<SocketAddr>>,
}
pub struct Engine {
    shared: Arc<Shared>,
    threads: Vec<JoinHandle<()>>,
}
impl Engine {
    /// filter_override is used only by isolated integration tests, never by IPC.
    pub fn start(plan: Plan, path: &Path, filter_override: Option<&str>) -> Result<Self, String> {
        Self::start_inner(plan, path, filter_override, None)
    }
    #[cfg(test)]
    pub(super) fn start_proxy_test(plan: Plan, path: &Path, filter: &str, endpoints: Vec<SocketAddr>) -> Result<Self, String> {
        Self::start_inner(plan, path, Some(filter), Some(endpoints))
    }
    fn start_inner(plan: Plan, path: &Path, filter_override: Option<&str>, proxy_override: Option<Vec<SocketAddr>>) -> Result<Self, String> {
        for (i, r) in plan
            .config
            .process_rules
            .iter()
            .enumerate()
            .filter(|(_, r)| r.enabled && plan.config.process_enabled)
        {
            let _ = r;
            TcpStream::connect_timeout(
                &SocketAddr::from(([127, 0, 0, 1], plan.ports[i])),
                Duration::from_millis(300),
            )
            .map_err(|_| format!("进程专用入口 {} 未就绪，未启用接管", plan.ports[i]))?;
            if filter_override.is_none() {
                verify_listener(plan.ports[i], 6)?;
                verify_listener(plan.ports[i], 17)?;
                verify_listener_at(plan.ports[i], 6, true)?;
                verify_listener_at(plan.ports[i], 17, true)?;
            }
        }
        if filter_override.is_none() && plan.config.dns_enabled {
            verify_listener(plan.dns_port, 6)?;
            verify_listener(plan.dns_port, 17)?;
        }
        let v4 = TcpListener::bind(("0.0.0.0", 0)).map_err(|_| "无法创建 IPv4 重定向入口")?;
        let v6 = TcpListener::bind(("::", 0)).map_err(|_| "无法创建 IPv6 重定向入口")?;
        v4.set_nonblocking(true).map_err(|_| "重定向入口设置失败")?;
        v6.set_nonblocking(true).map_err(|_| "重定向入口设置失败")?;
        let api = Api::load(path)?;
        let device = api.open(
            filter_override.unwrap_or("outbound and (tcp or (!loopback and udp))"),
            0,
            0,
        )?;
        let shared = Arc::new(Shared {
            plan,
            device,
            stop: AtomicBool::new(false),
            paused: AtomicBool::new(false),
            table: Mutex::new(Tables::default()),
            workers: AtomicUsize::new(0),
            v4: v4.local_addr().unwrap().port(),
            v6: v6.local_addr().unwrap().port(),
            proxy_override,
        });
        let mut threads = vec![];
        for listener in [v4, v6] {
            let s = shared.clone();
            threads.push(thread::spawn(move || accept(s, listener)));
        }
        let s = shared.clone();
        threads.push(thread::spawn(move || {
            let failed =
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| network(s.clone())))
                    .is_err();
            if failed || !s.stop.load(Ordering::Acquire) {
                s.stop.store(true, Ordering::Release);
                s.device.shutdown();
                let mut status = super::STATUS.lock().unwrap_or_else(|p| p.into_inner());
                status.active = false;
                status.message = "接管线程异常停止，已解除过滤；请重新启用".into();
            }
        }));
        Ok(Self { shared, threads })
    }
    pub fn stop(self) {
        drop(self);
    }
    pub fn pause(&self) {
        self.shared.paused.store(true, Ordering::Release);
    }
}
impl Drop for Engine {
    fn drop(&mut self) {
        self.shared.stop.store(true, Ordering::Release);
        self.shared.device.shutdown();
        for t in self.threads.drain(..) {
            let _ = t.join();
        }
    }
}
pub(super) fn verify_listener(port: u16, protocol: u8) -> Result<(), String> {
    verify_listener_at(port, protocol, false)
}
fn verify_listener_at(port: u16, protocol: u8, v6: bool) -> Result<(), String> {
    let expected = crate::commands::process::PID.load(Ordering::SeqCst);
    let owner = super::owner::lookup(Flow {
        source: if v6 { SocketAddr::from((std::net::Ipv6Addr::LOCALHOST, port)) } else { SocketAddr::from(([127, 0, 0, 1], port)) },
        destination: if v6 { SocketAddr::from((std::net::Ipv6Addr::UNSPECIFIED, 0)) } else { SocketAddr::from(([0, 0, 0, 0], 0)) },
        protocol,
    });
    if expected == 0 || owner != Some(expected) {
        return Err(format!("专用入口 {port} 不属于当前核心，已拒绝接管"));
    }
    Ok(())
}
fn owner_rule(plan: &Plan, pid: u32) -> Option<usize> {
    if pid == std::process::id() {
        return None;
    }
    let mut p = crate::routing_overrides::native::inspect(pid, 0, String::new());
    let Some(path) = p.executable_path.as_deref() else {
        UNKNOWN.fetch_add(1, Ordering::Relaxed);
        return None;
    };
    p.name = Path::new(path).file_name()?.to_string_lossy().into_owned();
    if let Some(i) = plan.select(&p) {
        return Some(i);
    }
    if !plan
        .config
        .process_rules
        .iter()
        .any(|r| r.enabled && r.include_descendants)
    {
        return None;
    }
    if let Some(known) = crate::routing_overrides::tracker::entry(&p.identity) {
        return plan.select(&known);
    }
    // Consult a synchronous snapshot while the first packet is held. Reconcile
    // preserves already-proven ancestry of an orphan, but never guesses from PID.
    if let Ok(snapshot) = crate::routing_overrides::native::snapshot() {
        crate::routing_overrides::tracker::reconcile(snapshot, false);
    }
    crate::routing_overrides::tracker::entry(&p.identity).and_then(|e| plan.select(&e))
}
fn network(s: Arc<Shared>) {
    let mut bytes = vec![0u8; 65575];
    let mut cleanup = Instant::now();
    let mut local_nat = super::local_proxy::Nat::default();
    let mut proxy_endpoints = s.proxy_override.clone().unwrap_or_else(super::local_proxy::endpoints);
    let mut proxy_refresh = Instant::now();
    loop {
        let (n, mut addr) = match s.device.recv(&mut bytes) {
            Ok(v) => v,
            Err(e) => {
                if !s.stop.load(Ordering::Acquire) {
                    super::record_error("驱动收包", &e);
                }
                break;
            }
        };
        let bytes = &mut bytes[..n];
        if s.stop.load(Ordering::Acquire) && !s.paused.load(Ordering::Acquire) {
            let _ = s.device.send(bytes, &mut addr, false);
            continue;
        }
        let Some(p) = Packet::parse(bytes) else {
            let _ = s.device.send(bytes, &mut addr, false);
            continue;
        };
        if s.proxy_override.is_none() && proxy_refresh.elapsed() > Duration::from_millis(500) {
            proxy_endpoints = super::local_proxy::endpoints(); proxy_refresh = Instant::now();
        }
        if p.flow.protocol == 6 && p.flow.source.ip().is_loopback() && p.flow.destination.ip().is_loopback() {
            // A reused TCP tuple may now belong to a different process/policy.
            // Every new SYN must be classified again, never inherit an old route.
            if p.syn { local_nat.forget(p.flow); }
            let closed = bytes[p.transport + 13] & 5 != 0;
            if let Some(to) = local_nat.translate(p.flow, closed, bytes[p.transport + 13] & 0x10 != 0) {
                if !s.paused.load(Ordering::Acquire) { p.rewrite(bytes, to.source, to.destination); send(&s, bytes, &mut addr, true); }
                continue;
            }
            if p.syn && proxy_endpoints.contains(&p.flow.destination) {
                let pid = super::owner::lookup(p.flow);
                if pid != Some(std::process::id()) && pid != Some(crate::commands::process::PID.load(Ordering::SeqCst)) {
                    if let Some(i) = pid.and_then(|pid| owner_rule(&s.plan, pid)) {
                        if !s.paused.load(Ordering::Acquire) && local_nat.insert(p.flow, s.plan.ports[i]) {
                            TCP.fetch_add(1, Ordering::Relaxed);
                            let to = local_nat.translate(p.flow, false, false).unwrap();
                            p.rewrite(bytes, to.source, to.destination); send(&s, bytes, &mut addr, true);
                        } else { FAILURES.fetch_add(1, Ordering::Relaxed); }
                        continue;
                    }
                }
            }
            send(&s, bytes, &mut addr, false);
            continue;
        }
        if cleanup.elapsed() > Duration::from_secs(10) {
            local_nat.cleanup();
            let mut t = s.table.lock().unwrap();
            t.flows.retain(|_, r| {
                let age = r.touched.lock().unwrap().elapsed();
                if !r.claimed.load(Ordering::Acquire) && age > Duration::from_secs(30) {
                    return false;
                }
                !r.finished.load(Ordering::Acquire) || age < Duration::from_secs(60)
            });
            let active: std::collections::HashSet<_> = t.flows.values().map(|r| r.token).collect();
            t.tokens.retain(|token, _| active.contains(token));
            cleanup = Instant::now();
        }
        if p.flow.protocol == 6 {
            let reply = if p.flow.source.port() == s.v4 || p.flow.source.port() == s.v6 {
                s.table
                    .lock()
                    .unwrap()
                    .tokens
                    .get(&p.flow.destination.port())
                    .cloned()
                    .filter(|r| {
                        r.flow.source.ip() == p.flow.source.ip()
                            && r.flow.destination.ip() == p.flow.destination.ip()
                    })
            } else {
                None
            };
            if let Some(r) = reply {
                if s.paused.load(Ordering::Acquire) {
                    continue;
                }
                *r.touched.lock().unwrap() = Instant::now();
                p.rewrite(bytes, r.flow.destination, r.flow.source);
                addr.inbound();
                send(&s, bytes, &mut addr, true);
                continue;
            }
            let route = {
                let mut t = s.table.lock().unwrap();
                if p.syn
                    && t.flows
                        .get(&p.flow)
                        .is_some_and(|r| r.finished.load(Ordering::Acquire))
                {
                    if let Some(old) = t.flows.remove(&p.flow) {
                        t.tokens.remove(&old.token);
                    }
                }
                t.flows.get(&p.flow).cloned()
            };
            if let Some(r) = route {
                if s.paused.load(Ordering::Acquire) {
                    continue;
                }
                *r.touched.lock().unwrap() = Instant::now();
                reflect(&s, &p, &r, bytes, &mut addr);
                continue;
            }
            if !p.syn {
                send(&s, bytes, &mut addr, false);
                continue;
            }
        }
        let dns_udp = p.flow.protocol == 17
            && p.flow.destination.port() == 53
            && s.plan.dns_matches(&bytes[p.payload..]);
        let dns_tcp =
            p.flow.protocol == 6 && p.flow.destination.port() == 53 && s.plan.config.dns_enabled;
        if !dns_udp && !dns_tcp && packet::local(p.flow.destination.ip()) {
            send(&s, bytes, &mut addr, false);
            continue;
        }
        let pid = super::owner::lookup(p.flow);
        // Exclude only the owned core, not every executable with the same name.
        if pid == Some(std::process::id())
            || pid == Some(crate::commands::process::PID.load(Ordering::SeqCst))
        {
            send(&s, bytes, &mut addr, false);
            continue;
        }
        let choice = pid.and_then(|pid| owner_rule(&s.plan, pid));
        if !dns_udp && !dns_tcp && choice.is_none() {
            if pid.is_none() {
                UNKNOWN.fetch_add(1, Ordering::Relaxed);
            }
            send(&s, bytes, &mut addr, false);
            continue;
        }
        let port = choice.map(|i| s.plan.ports[i]).unwrap_or(0);
        if s.paused.load(Ordering::Acquire) {
            continue;
        }
        if p.flow.protocol == 6 {
            let mut t = s.table.lock().unwrap();
            if t.flows.len() >= 2048 {
                FAILURES.fetch_add(1, Ordering::Relaxed);
                continue;
            }
            let token = (0..55000).find_map(|_| {
                t.next = if t.next < 10000 || t.next >= 64999 {
                    10000
                } else {
                    t.next + 1
                };
                (!t.tokens.contains_key(&t.next)).then_some(t.next)
            });
            let Some(token) = token else {
                FAILURES.fetch_add(1, Ordering::Relaxed);
                continue;
            };
            let r = Arc::new(Route {
                flow: p.flow,
                token,
                port,
                dns: dns_tcp,
                claimed: AtomicBool::new(false),
                finished: AtomicBool::new(false),
                touched: Mutex::new(Instant::now()),
            });
            t.tokens.insert(token, r.clone());
            t.flows.insert(p.flow, r.clone());
            drop(t);
            reflect(&s, &p, &r, bytes, &mut addr);
        } else if dns_udp {
            if !reserve(&s) {
                continue;
            }
            let s = s.clone();
            let payload = bytes[p.payload..].to_vec();
            let template = bytes.to_vec();
            thread::spawn(move || {
                let _slot = Slot(s.clone());
                DNS.fetch_add(1, Ordering::Relaxed);
                let result = (|| -> io::Result<()> {
                    let sock = UdpSocket::bind("127.0.0.1:0")?;
                    sock.connect(("127.0.0.1", s.plan.dns_port))?;
                    sock.set_read_timeout(Some(Duration::from_secs(4)))?;
                    sock.send(&payload)?;
                    let mut answer = vec![0; 65535];
                    let n = sock.recv(&mut answer)?;
                    if n < 12 || answer[..2] != payload[..2] {
                        return Err(io::Error::other("DNS 响应身份不符"));
                    }
                    if let Some(mut reply) = p.udp_reply(&template, &answer[..n]) {
                        addr.inbound();
                        send(&s, &mut reply, &mut addr, true);
                    }
                    Ok(())
                })();
                if let Err(e) = result {
                    super::record_error("DNS 转发", &e);
                }
            });
        } else {
            let mut t = s.table.lock().unwrap();
            let owner = pid.unwrap_or(0);
            if let Some((old, _, tx)) = t.udp.get(&p.flow) {
                if *old == owner {
                    match tx.try_send(bytes[p.payload..].to_vec()) {
                        Ok(()) => {
                            UDP.fetch_add(1, Ordering::Relaxed);
                            continue;
                        }
                        Err(mpsc::TrySendError::Full(_)) => {
                            FAILURES.fetch_add(1, Ordering::Relaxed);
                            continue;
                        }
                        Err(_) => {}
                    }
                }
                t.udp.remove(&p.flow);
            }
            if t.udp.len() >= 512 || !reserve(&s) {
                FAILURES.fetch_add(1, Ordering::Relaxed);
                continue;
            }
            let (tx, rx) = mpsc::sync_channel(64);
            let _ = tx.try_send(bytes[p.payload..].to_vec());
            t.udp_generation = t.udp_generation.wrapping_add(1);
            let generation = t.udp_generation;
            t.udp.insert(p.flow, (owner, generation, tx));
            drop(t);
            let template = bytes.to_vec();
            let shared = s.clone();
            thread::spawn(move || {
                let _slot = Slot(shared.clone());
                if let Err(e) = udp(&shared, p, &template, addr, port, rx) {
                    super::record_error("UDP SOCKS 转发", &e);
                }
                let mut table = shared.table.lock().unwrap();
                if table
                    .udp
                    .get(&p.flow)
                    .is_some_and(|(_, current, _)| *current == generation)
                {
                    table.udp.remove(&p.flow);
                }
            });
            UDP.fetch_add(1, Ordering::Relaxed);
        }
    }
}
fn reflect(s: &Shared, p: &Packet, r: &Route, bytes: &mut [u8], addr: &mut Address) {
    let port = if p.flow.source.is_ipv4() { s.v4 } else { s.v6 };
    p.rewrite(
        bytes,
        SocketAddr::new(r.flow.destination.ip(), r.token),
        SocketAddr::new(r.flow.source.ip(), port),
    );
    addr.inbound();
    send(s, bytes, addr, true);
}
fn send(s: &Shared, bytes: &mut [u8], addr: &mut Address, changed: bool) {
    if changed && s.paused.load(Ordering::Acquire) {
        return;
    }
    if let Err(e) = s.device.send(bytes, addr, changed) {
        super::record_error(if changed { "驱动重定向注入" } else { "驱动原路放行" }, &e);
    }
}
fn reserve(s: &Shared) -> bool {
    if s.workers.fetch_add(1, Ordering::AcqRel) >= 512 {
        s.workers.fetch_sub(1, Ordering::AcqRel);
        FAILURES.fetch_add(1, Ordering::Relaxed);
        false
    } else {
        true
    }
}
struct Slot(Arc<Shared>);
impl Drop for Slot {
    fn drop(&mut self) {
        self.0.workers.fetch_sub(1, Ordering::AcqRel);
    }
}
fn accept(s: Arc<Shared>, listener: TcpListener) {
    while !s.stop.load(Ordering::Acquire) {
        match listener.accept() {
            Ok((stream, peer)) => {
                if stream.set_nonblocking(false).is_err() {
                    continue;
                }
                let r = s
                    .table
                    .lock()
                    .unwrap()
                    .tokens
                    .get(&peer.port())
                    .cloned()
                    .filter(|r| {
                        r.flow.destination.ip() == peer.ip()
                            && stream
                                .local_addr()
                                .is_ok_and(|a| a.ip() == r.flow.source.ip())
                    });
                let Some(r) = r else {
                    continue;
                };
                if r.claimed.swap(true, Ordering::AcqRel) {
                    continue;
                }
                if !reserve(&s) {
                    r.finished.store(true, Ordering::Release);
                    continue;
                }
                let s = s.clone();
                thread::spawn(move || {
                    let _slot = Slot(s.clone());
                    TCP.fetch_add(1, Ordering::Relaxed);
                    let result = if r.dns {
                        dns_tcp(&s, stream, r.flow.destination)
                    } else {
                        tcp(&s, stream, r.port, r.flow.destination)
                    };
                    if let Err(e) = result {
                        if r.dns { super::record_error("TCP DNS 转发", &e); }
                    }
                    r.finished.store(true, Ordering::Release);
                });
            }
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(5))
            }
            Err(_) => break,
        }
    }
}
fn tcp(s: &Arc<Shared>, client: TcpStream, port: u16, destination: SocketAddr) -> io::Result<()> {
    let (upstream, _) = socks::connect(port, destination, false).inspect_err(|e| {
        super::record_error("所选节点 SOCKS 建连", e);
        super::connection_error("所选节点 SOCKS 建连", destination, e);
    })?;
    client.set_read_timeout(None)?;
    upstream.set_read_timeout(None)?;
    client.set_write_timeout(Some(Duration::from_secs(3)))?;
    upstream.set_write_timeout(Some(Duration::from_secs(3)))?;
    let mut from = client.try_clone()?;
    let mut to = upstream.try_clone()?;
    let s2 = s.clone();
    let forward = thread::spawn(move || {
        let result = copy(&s2, &mut from, &mut to, destination, true);
        let _ = from.shutdown(Shutdown::Both);
        let _ = to.shutdown(Shutdown::Both);
        result
    });
    let mut client = client;
    let mut upstream = upstream;
    let back = copy(s, &mut upstream, &mut client, destination, false);
    let _ = client.shutdown(Shutdown::Both);
    let _ = upstream.shutdown(Shutdown::Both);
    let forward = forward
        .join()
        .map_err(|_| io::Error::other("转发线程异常"))?;
    if let Err(e) = back.and(forward) {
        if !super::is_normal_close(&e) {
            super::record_error("TCP 数据传输", &e);
        }
    }
    Ok(())
}
fn copy(s: &Shared, from: &mut TcpStream, to: &mut TcpStream, destination: SocketAddr, from_client: bool) -> io::Result<()> {
    let mut buf = [0; 32768];
    while !s.stop.load(Ordering::Acquire) && !s.paused.load(Ordering::Acquire) {
        match readable(from) {
            Ok(false) => continue,
            Ok(true) => {},
            Err(e) if super::is_normal_close(&e) => {
                let _ = to.shutdown(Shutdown::Both);
                return Ok(());
            }
            Err(e) => return Err(e),
        }
        match from.read(&mut buf) {
            Ok(0) => {
                let _ = to.shutdown(Shutdown::Write);
                return Ok(());
            }
            Ok(n) => {
                if let Err(e) = to.write_all(&buf[..n]) {
                    if super::is_normal_close(&e) {
                        let _ = to.shutdown(Shutdown::Both);
                        return Ok(());
                    }
                    super::connection_error(if from_client { "程序→核心：写入核心" } else { "核心→程序：写入程序" }, destination, &e);
                    return Err(e);
                }
            }
            Err(e) => {
                if super::is_normal_close(&e) {
                    let _ = to.shutdown(Shutdown::Both);
                    return Ok(());
                }
                super::connection_error(if from_client { "程序→核心：读取程序" } else { "核心→程序：读取核心" }, destination, &e);
                return Err(e);
            },
        }
    }
    let _ = to.shutdown(Shutdown::Both);
    Ok(())
}
/// A readiness timeout leaves a TCP connection intact. SO_RCVTIMEO does not
/// provide that guarantee on Windows and must not be used as a polling timer.
fn readable(stream: &TcpStream) -> io::Result<bool> {
    use std::os::windows::io::AsRawSocket;
    #[repr(C)]
    struct PollFd { socket: usize, events: i16, returned: i16 }
    #[link(name = "ws2_32")]
    extern "system" {
        fn WSAPoll(fds: *mut PollFd, count: u32, timeout: i32) -> i32;
        fn WSAGetLastError() -> i32;
    }
    let mut fd = PollFd { socket: stream.as_raw_socket() as usize, events: 0x0100, returned: 0 };
    let result = unsafe { WSAPoll(&mut fd, 1, 250) };
    if result < 0 { return Err(io::Error::from_raw_os_error(unsafe { WSAGetLastError() })); }
    Ok(result > 0)
}
fn udp(
    s: &Arc<Shared>,
    p: Packet,
    template: &[u8],
    mut addr: Address,
    port: u16,
    rx: mpsc::Receiver<Vec<u8>>,
) -> io::Result<()> {
    let (_control, relay) = socks::connect(port, SocketAddr::from(([0, 0, 0, 0], 0)), true)?;
    let socket = UdpSocket::bind("127.0.0.1:0")?;
    socket.connect(relay)?;
    socket.set_read_timeout(Some(Duration::from_millis(20)))?;
    let mut touched = Instant::now();
    let mut response = vec![0; 65575];
    while !s.stop.load(Ordering::Acquire)
        && !s.paused.load(Ordering::Acquire)
        && touched.elapsed() < Duration::from_secs(30)
    {
        for payload in rx.try_iter().take(64) {
            let mut data = vec![0, 0, 0];
            socks::encode(p.flow.destination, &mut data);
            data.extend(payload);
            socket.send(&data)?;
            touched = Instant::now();
        }
        match socket.recv(&mut response) {
            Ok(n) if n >= 4 && response[..3] == [0, 0, 0] => {
                if let Some((origin, head)) = socks::decode(&response[3..n]) {
                    if origin != p.flow.destination {
                        continue;
                    }
                    if let Some(mut reply) = p.udp_reply(template, &response[3 + head..n]) {
                        addr.inbound();
                        send(s, &mut reply, &mut addr, true);
                        touched = Instant::now();
                    }
                }
            }
            Ok(_) => {}
            Err(e)
                if matches!(
                    e.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                ) => {}
            Err(e) => return Err(e),
        }
    }
    Ok(())
}
fn exact(s: &Shared, stream: &mut TcpStream, data: &mut [u8]) -> io::Result<()> {
    let mut pos = 0;
    while pos < data.len() && !s.stop.load(Ordering::Acquire) && !s.paused.load(Ordering::Acquire) {
        if !readable(stream)? { continue; }
        match stream.read(&mut data[pos..]) {
            Ok(0) => return Err(io::ErrorKind::UnexpectedEof.into()),
            Ok(n) => pos += n,
            Err(e) => return Err(e),
        }
    }
    if pos == data.len() {
        Ok(())
    } else {
        Err(io::ErrorKind::Interrupted.into())
    }
}
fn dns_tcp(s: &Shared, mut client: TcpStream, destination: SocketAddr) -> io::Result<()> {
    client.set_read_timeout(None)?;
    client.set_write_timeout(Some(Duration::from_secs(4)))?;
    while !s.stop.load(Ordering::Acquire) && !s.paused.load(Ordering::Acquire) {
        let mut size = [0; 2];
        if let Err(e) = exact(s, &mut client, &mut size) {
            return if e.kind() == io::ErrorKind::UnexpectedEof {
                Ok(())
            } else {
                Err(e)
            };
        }
        let mut query = vec![0; u16::from_be_bytes(size) as usize];
        exact(s, &mut client, &mut query)?;
        let target = if s.plan.dns_matches(&query) {
            DNS.fetch_add(1, Ordering::Relaxed);
            SocketAddr::from(([127, 0, 0, 1], s.plan.dns_port))
        } else {
            destination
        };
        let mut upstream = TcpStream::connect_timeout(&target, Duration::from_secs(3))?;
        upstream.set_read_timeout(Some(Duration::from_secs(4)))?;
        upstream.set_write_timeout(Some(Duration::from_secs(4)))?;
        upstream.write_all(&size)?;
        upstream.write_all(&query)?;
        upstream.read_exact(&mut size)?;
        let mut answer = vec![0; u16::from_be_bytes(size) as usize];
        upstream.read_exact(&mut answer)?;
        client.write_all(&size)?;
        client.write_all(&answer)?;
    }
    Ok(())
}

#[cfg(test)]
mod regression {
    #[test]
    fn readiness_timeouts_preserve_late_data_and_half_close() {
        use std::{net::{TcpListener, TcpStream, Shutdown}, io::{Read, Write}};
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let mut client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (mut server, _) = listener.accept().unwrap();
        for _ in 0..3 { assert!(!super::readable(&client).unwrap()); }
        server.write_all(b"late-response").unwrap();
        assert!(super::readable(&client).unwrap());
        let mut data = [0; 13];
        client.read_exact(&mut data).unwrap();
        assert_eq!(&data, b"late-response");
        server.shutdown(Shutdown::Write).unwrap();
        assert!(super::readable(&client).unwrap());
        assert_eq!(client.read(&mut data).unwrap(), 0);
    }
    #[test]
    fn known_unmatched_instance_does_not_rescan_machine() {
        use crate::routing_overrides::{model::{Overrides, ProcessRule}, native, tracker};
        struct Child(std::process::Child);
        impl Drop for Child { fn drop(&mut self) { let _ = self.0.kill(); let _ = self.0.wait(); } }
        let child = Child(std::process::Command::new("pwsh")
            .args(["-NoProfile", "-Command", "Start-Sleep -Seconds 30"])
            .spawn().unwrap());
        let process = native::inspect(child.0.id(), 0, String::new());
        let identity = process.identity.clone();
        tracker::reconcile(vec![process], false);
        let mut config = Overrides::default();
        config.process_enabled = true;
        config.process_rules.push(ProcessRule {
            id: "unmatched".into(), enabled: true, label: "test".into(),
            match_kind: "path".into(), match_value: "C:\\not-a-real-process.exe".into(),
            action: "direct".into(), target: None, include_descendants: true,
        });
        let before = tracker::status(&config).generation;
        let plan = super::Plan { config, ports: vec![32000], dns_port: 31999 };
        for _ in 0..100 {
            assert!(super::owner_rule(&plan, child.0.id()).is_none());
        }
        assert_eq!(before, tracker::status(&plan.config).generation);
        assert!(tracker::entry(&identity).is_some());
        assert!(tracker::entry(&format!("{}:different-birth", child.0.id())).is_none());
    }
}

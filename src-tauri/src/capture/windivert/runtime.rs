//! Scoped transparent TCP and SOCKS UDP relay. Two receive threads and a bounded
//! Tokio worker pool; no full process-table scan in the packet path.
use super::{
    driver::{Address, Device},
    ownership::{Event, Identity, Index},
    packet::{capture_bypass_destination, Flow, Packet},
    plan::Plan,
    preflight::VerifiedApi,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, RwLock,
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream, UdpSocket},
    sync::{mpsc, Semaphore},
};

#[derive(Default, Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Stats {
    pub active: bool,
    pub tcp: u64,
    pub udp: u64,
    pub dns: u64,
    pub unknown: u64,
    pub failures: u64,
}
struct Route {
    external: Option<crate::external_proxy::captured::Context>,
    flow: Flow,
    token: u16,
    port: u16,
    touched: Mutex<Instant>,
    claimed: AtomicBool,
    finished: AtomicBool,
}
#[derive(Default)]
struct Tables {
    flows: HashMap<Flow, Arc<Route>>,
    tokens: HashMap<u16, Arc<Route>>,
    udp: HashMap<Flow, (u64, super::ownership::Owner, mpsc::Sender<Vec<u8>>)>,
    bypass: HashMap<Flow, Instant>,
    next: u16,
    generation: u64,
}
struct Shared {
    external: bool,
    plan: RwLock<Plan>,
    network: Arc<Device>,
    sockets: Arc<Device>,
    owners: Mutex<Index>,
    table: Mutex<Tables>,
    stop: AtomicBool,
    paused: AtomicBool,
    v4: u16,
    v6: u16,
    excluded: Vec<Identity>,
    worker: tokio::runtime::Handle,
    test_loopback: bool,
    capacity: Arc<Semaphore>,
    tcp: AtomicU64,
    udp: AtomicU64,
    dns: AtomicU64,
    unknown: AtomicU64,
    failures: AtomicU64,
}

pub struct Engine {
    shared: Arc<Shared>,
    threads: Vec<JoinHandle<()>>,
    pool: Option<tokio::runtime::Runtime>,
}
impl Engine {
    pub fn start(
        plan: Plan,
        components: &std::path::Path,
        excluded: Vec<Identity>,
    ) -> Result<Self, String> {
        Self::start_backend(plan, components, excluded, None, false)
    }
    pub(crate) fn start_external(components: &std::path::Path, excluded: Vec<Identity>) -> Result<Self,String> {
        Self::start_backend(Plan {entries:vec![],targets:vec![],instances:vec![]}, components, excluded, None, true)
    }
    #[cfg(test)] pub(crate) fn external_fixture(components:&std::path::Path,excluded:Vec<Identity>,filter:&str)->Result<Self,String>{
        Self::start_backend(Plan{entries:vec![],targets:vec![],instances:vec![]},components,excluded,Some(filter),true)
    }
    #[cfg(test)]
    fn start_inner(
        plan: Plan,
        components: &std::path::Path,
        excluded: Vec<Identity>,
        filter: Option<&str>,
    ) -> Result<Self, String> {
        Self::start_backend(plan,components,excluded,filter,false)
    }
    fn start_backend(plan:Plan,components:&std::path::Path,excluded:Vec<Identity>,filter:Option<&str>,external:bool)->Result<Self,String> {
        plan.validate()?;
        let pool = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .max_blocking_threads(8)
            .enable_all()
            .build()
            .map_err(|_| "创建接管任务池失败")?;
        let guard = pool.enter();
        let v4 = std::net::TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0))
            .map_err(|_| "IPv4 转发入口创建失败")?;
        let v6 = std::net::TcpListener::bind((Ipv6Addr::UNSPECIFIED, 0))
            .map_err(|_| "IPv6 转发入口创建失败")?;
        v4.set_nonblocking(true).map_err(|_| "转发入口配置失败")?;
        v6.set_nonblocking(true).map_err(|_| "转发入口配置失败")?;
        let ports = (
            v4.local_addr().unwrap().port(),
            v6.local_addr().unwrap().port(),
        );
        let v4 = TcpListener::from_std(v4).map_err(|_| "转发入口创建失败")?;
        let v6 = TcpListener::from_std(v6).map_err(|_| "转发入口创建失败")?;
        let loaded = VerifiedApi::load(components)?;
        let sockets = loaded
            .api
            .open("protocol == 6 or protocol == 17", 3, 1 | 4)?;
        if sockets.version().map_err(|_| "驱动版本读取失败")? != (2, 2) {
            return Err("WinDivert 共享驱动版本不兼容".into());
        }
        let default_filter = if !external && plan.targets.is_empty() && plan.instances.is_empty() {
            "false"
        } else {
            "outbound and (tcp or udp)"
        };
        let filter_text = filter
            .unwrap_or(default_filter)
            .replace("{relay4}", &ports.0.to_string())
            .replace("{relay6}", &ports.1.to_string());
        let network_device = loaded.api.open(&filter_text, 0, 0)?;
        let shared = Arc::new(Shared {
            external,
            plan: RwLock::new(plan),
            network: network_device,
            sockets,
            owners: Mutex::new(Index::default()),
            table: Mutex::new(Tables::default()),
            stop: AtomicBool::new(false),
            paused: AtomicBool::new(false),
            v4: ports.0,
            v6: ports.1,
            excluded,
            worker: pool.handle().clone(),
            test_loopback: cfg!(test) && filter.is_some(),
            capacity: Arc::new(Semaphore::new(384)),
            tcp: AtomicU64::new(0),
            udp: AtomicU64::new(0),
            dns: AtomicU64::new(0),
            unknown: AtomicU64::new(0),
            failures: AtomicU64::new(0),
        });
        for listener in [v4, v6] {
            pool.spawn(accept(shared.clone(), listener));
        }
        let s = shared.clone();
        let observer = std::thread::spawn(move || observe(s));
        let s = shared.clone();
        let receiver = std::thread::spawn(move || network(s));
        drop(guard);
        Ok(Self {
            shared,
            threads: vec![observer, receiver],
            pool: Some(pool),
        })
    }
    pub fn update(&self, plan: Plan) -> Result<(), String> {
        if self.shared.stop.load(Ordering::Acquire) {
            return Err("接管工作线程已停止".into());
        }
        plan.validate()?;
        *self.shared.plan.write().unwrap() = plan;
        self.shared.paused.store(false, Ordering::Release);
        Ok(())
    }
    pub fn has_targets(&self) -> bool {
        let plan = self.shared.plan.read().unwrap();
        !plan.targets.is_empty() || !plan.instances.is_empty()
    }
    pub fn update_instances(&self, instances: Vec<super::plan::Instance>) -> Result<(), String> {
        if self.shared.stop.load(Ordering::Acquire) || self.shared.paused.load(Ordering::Acquire) {
            return Err("接管已暂停，不能单独更新实例".into());
        }
        let mut guard = self.shared.plan.write().unwrap();
        let mut next = guard.clone(); next.instances = instances; next.validate()?;
        if guard.targets.is_empty() && guard.instances.is_empty() != next.instances.is_empty() {
            return Err("接管范围改变，需要完整确认".into());
        }
        *guard = next;
        Ok(())
    }
    pub fn pause(&self) {
        self.shared.paused.store(true, Ordering::Release);
    }
    pub fn stats(&self) -> Stats {
        let s = &self.shared;
        Stats {
            active: !s.stop.load(Ordering::Acquire),
            tcp: s.tcp.load(Ordering::Relaxed),
            udp: s.udp.load(Ordering::Relaxed),
            dns: s.dns.load(Ordering::Relaxed),
            unknown: s.unknown.load(Ordering::Relaxed),
            failures: s.failures.load(Ordering::Relaxed),
        }
    }
}
impl Drop for Engine {
    fn drop(&mut self) {
        // Stop accepting new flows, terminate our relays while reverse mappings
        // still exist, then drain queued packets and release only our handles.
        self.shared.paused.store(true, Ordering::Release);
        if let Some(pool) = self.pool.take() {
            pool.shutdown_timeout(Duration::from_secs(2));
        }
        self.shared.stop.store(true, Ordering::Release);
        self.shared.sockets.shutdown();
        self.shared.network.shutdown();
        for thread in self.threads.drain(..) {
            let _ = thread.join();
        }
    }
}
fn observe(s: Arc<Shared>) {
    while let Ok((_, address)) = s.sockets.recv(&mut []) {
        if s.stop.load(Ordering::Acquire) {
            break;
        }
        if let Some(event) = Event::decode(&address) {
            let identity = if event.kind == super::ownership::Kind::Close {
                None
            } else {
                event_identity(&event)
            };
            if s.owners.lock().unwrap().apply(event, identity).is_err() {
                s.failures.fetch_add(1, Ordering::Relaxed);
            }
        }
    }
    if !s.stop.swap(true, Ordering::AcqRel) {
        s.owners.lock().unwrap().invalidate();
        s.failures.fetch_add(1, Ordering::Relaxed);
        s.network.shutdown();
    }
}
fn event_identity(event: &Event) -> Option<Identity> {
    #[link(name = "kernel32")]
    extern "system" {
        fn QueryPerformanceCounter(value: *mut i64) -> i32;
        fn QueryPerformanceFrequency(value: *mut i64) -> i32;
    }
    let id = Identity::inspect(event.pid)?;
    let (mut now, mut frequency) = (0i64, 0i64);
    if unsafe { QueryPerformanceCounter(&mut now) } == 0
        || unsafe { QueryPerformanceFrequency(&mut frequency) } == 0
        || frequency <= 0
        || event.timestamp > now
    {
        return None;
    }
    let wall = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_nanos()
        / 100
        + 116444736000000000;
    let elapsed = (now - event.timestamp) as u128 * 10000000 / frequency as u128;
    let at = wall.checked_sub(elapsed)?;
    // Do not assign an old queued SOCKET event to a process born after it.
    (u128::from(id.created_at) <= at).then_some(id)
}
fn send(s: &Shared, data: &mut [u8], address: &mut Address, changed: bool) {
    if s.network.send(data, address, changed).is_err() {
        s.failures.fetch_add(1, Ordering::Relaxed);
    }
}
fn reflect(s: &Shared, p: &Packet, r: &Route, data: &mut [u8], a: &mut Address) {
    p.rewrite(
        data,
        SocketAddr::new(r.flow.destination.ip(), r.token),
        SocketAddr::new(
            r.flow.source.ip(),
            if r.flow.source.is_ipv4() { s.v4 } else { s.v6 },
        ),
    );
    if a.flags & (1 << 18) == 0 {
        a.inbound();
    }
    send(s, data, a, true);
}
fn network(s: Arc<Shared>) {
    let mut data = vec![0; 65575];
    let mut cleanup = Instant::now();
    let mut diagnostic_summary = Instant::now();
    while let Ok((n, mut address)) = s.network.recv(&mut data) {
        let data = &mut data[..n];
        let Some(packet) = Packet::parse(data) else {
            s.unknown.fetch_add(1, Ordering::Relaxed);
            send(&s, data, &mut address, false);
            continue;
        };
        let flow = packet.flow;
        if cleanup.elapsed() > Duration::from_secs(2) {
            let mut t = s.table.lock().unwrap();
            t.flows.retain(|_, r| {
                let age = r.touched.lock().unwrap().elapsed();
                r.claimed.load(Ordering::Acquire) && !r.finished.load(Ordering::Acquire)
                    || age < Duration::from_secs(30)
            });
            let active: std::collections::HashSet<_> = t.flows.values().map(|r| r.token).collect();
            t.tokens.retain(|k, _| active.contains(k));
            t.bypass
                .retain(|_, at| at.elapsed() < Duration::from_secs(2));
            if s.external && diagnostic_summary.elapsed()>=Duration::from_secs(30) {
                crate::external_proxy::diagnostics::emit("capture.snapshot","info",serde_json::json!({"tcpFlows":t.flows.len(),"udpFlows":t.udp.len(),"bypassedFlows":t.bypass.len(),"permitsAvailable":s.capacity.available_permits(),
                    "tcp":s.tcp.load(Ordering::Relaxed),"udp":s.udp.load(Ordering::Relaxed),"dns":s.dns.load(Ordering::Relaxed),"unknown":s.unknown.load(Ordering::Relaxed),"failures":s.failures.load(Ordering::Relaxed)}));
                diagnostic_summary=Instant::now();
            }
            cleanup = Instant::now();
        }
        if flow.protocol == 6 {
            let reverse = if flow.source.port() == s.v4 || flow.source.port() == s.v6 {
                s.table
                    .lock()
                    .unwrap()
                    .tokens
                    .get(&flow.destination.port())
                    .cloned()
                    .filter(|r| {
                        r.flow.source.ip() == flow.source.ip()
                            && r.flow.destination.ip() == flow.destination.ip()
                    })
            } else {
                None
            };
            if let Some(r) = reverse {
                *r.touched.lock().unwrap() = Instant::now();
                packet.rewrite(data, r.flow.destination, r.flow.source);
                if address.flags & (1 << 18) == 0 {
                    address.inbound();
                }
                send(&s, data, &mut address, true);
                continue;
            }
            let route = s.table.lock().unwrap().flows.get(&flow).cloned();
            if let Some(r) = route {
                if packet.syn && r.finished.load(Ordering::Acquire) {
                    let mut t = s.table.lock().unwrap();
                    t.flows.remove(&flow);
                    t.tokens.remove(&r.token);
                } else {
                    *r.touched.lock().unwrap() = Instant::now();
                    reflect(&s, &packet, &r, data, &mut address);
                    continue;
                }
            }
            if !packet.syn {
                send(&s, data, &mut address, false);
                continue;
            }
        }
        // Local proxy connections keep their existing HTTP/SOCKS protocol and
        // entry. Relays/core cannot be recursively redirected into themselves.
        if (flow.destination.ip().is_loopback()
            || capture_bypass_destination(flow.destination.ip())
            || address.flags & (1 << 18) != 0)
            && !s.test_loopback
            || s.stop.load(Ordering::Acquire)
        {
            send(&s, data, &mut address, false);
            continue;
        }
        if flow.protocol == 17 {
            let cached = s.table.lock().unwrap().udp.get(&flow).cloned();
            if let Some((_, owner, tx)) = cached {
                if s.owners.lock().unwrap().current(&owner) {
                    if tx.try_send(data[packet.payload..].to_vec()).is_err() {
                        s.failures.fetch_add(1, Ordering::Relaxed);
                    } else {
                        s.udp.fetch_add(1, Ordering::Relaxed);
                    }
                    continue;
                }
                s.table.lock().unwrap().udp.remove(&flow);
            }
        }
        if s.table.lock().unwrap().bypass.contains_key(&flow) {
            send(&s, data, &mut address, false);
            continue;
        }
        let mut owner = s.owners.lock().unwrap().resolve(
            flow.source,
            flow.destination,
            flow.protocol,
            address.timestamp,
            Identity::inspect,
        );
        // SOCKET is asynchronous. Hold a bounded first packet briefly; neither
        // scan all processes nor claim guaranteed coverage after this deadline.
        if owner.is_none() {
            for _ in 0..3 {
                std::thread::sleep(Duration::from_millis(1));
                owner = s.owners.lock().unwrap().resolve(
                    flow.source,
                    flow.destination,
                    flow.protocol,
                    address.timestamp,
                    Identity::inspect,
                );
                if owner.is_some() {
                    break;
                }
            }
        }
        let external = if s.external {
            match owner.as_ref().filter(|o|!s.excluded.contains(&o.identity)).map(|o|crate::external_proxy::captured::resolve(&o.identity)).transpose() {
                Ok(context)=>context.flatten(),
                Err(_)=>{s.failures.fetch_add(1,Ordering::Relaxed);continue;}
            }
        } else {None};
        let choice = if s.external {external.as_ref().map(|_|0)} else {owner
            .as_ref()
            .filter(|o| !s.excluded.contains(&o.identity))
            .and_then(|o| {
                s.plan.read().unwrap().port_for(
                    &o.identity.path,
                    o.identity.pid,
                    o.identity.created_at,
                )
            })};
        let Some(port) = choice else {
            if owner.is_none() {
                s.unknown.fetch_add(1, Ordering::Relaxed);
            }
            let mut table = s.table.lock().unwrap();
            if table.bypass.len() < 4096 {
                table.bypass.insert(flow, Instant::now());
            }
            drop(table);
            send(&s, data, &mut address, false);
            continue;
        };
        // A confirmed target must never fall back directly on relay failure.
        if s.paused.load(Ordering::Acquire) {
            s.failures.fetch_add(1, Ordering::Relaxed);
            continue;
        }
        if flow.protocol == 6 {
            let mut t = s.table.lock().unwrap();
            if t.flows.len() >= 1024 {
                s.failures.fetch_add(1, Ordering::Relaxed);
                continue;
            }
            let token = (0..50000).find_map(|_| {
                t.next = if t.next < 10000 || t.next >= 59999 {
                    10000
                } else {
                    t.next + 1
                };
                (!t.tokens.contains_key(&t.next)).then_some(t.next)
            });
            let Some(token) = token else {
                s.failures.fetch_add(1, Ordering::Relaxed);
                continue;
            };
            let route = Arc::new(Route {
                external,
                flow,
                token,
                port,
                touched: Mutex::new(Instant::now()),
                claimed: AtomicBool::new(false),
                finished: AtomicBool::new(false),
            });
            t.tokens.insert(token, route.clone());
            t.flows.insert(flow, route.clone());
            drop(t);
            reflect(&s, &packet, &route, data, &mut address);
        } else {
            let permit = match s.capacity.clone().try_acquire_owned() {
                Ok(p) => p,
                Err(_) => {
                    s.failures.fetch_add(1, Ordering::Relaxed);
                    continue;
                }
            };
            let mut t = s.table.lock().unwrap();
            if t.udp.len() >= 128 {
                s.failures.fetch_add(1, Ordering::Relaxed);
                continue;
            }
            let owner = owner.expect("a selected route has a verified owner");
            let (tx, rx) = mpsc::channel(16);
            let _ = tx.try_send(data[packet.payload..].to_vec());
            t.generation = t.generation.wrapping_add(1);
            let generation = t.generation;
            t.udp.insert(flow, (generation, owner.clone(), tx));
            drop(t);
            let template = data.to_vec();
            let shared = s.clone();
            s.worker.spawn(async move {
                let _permit = permit;
                if udp(
                    shared.clone(),
                    packet,
                    template,
                    address,
                    port,
                    rx,
                    generation,
                    owner,
                    external,
                )
                .await
                .is_err()
                {
                    shared.failures.fetch_add(1, Ordering::Relaxed);
                }
                let mut t = shared.table.lock().unwrap();
                if t.udp.get(&flow).is_some_and(|(g, _, _)| *g == generation) {
                    t.udp.remove(&flow);
                }
            });
            s.udp.fetch_add(1, Ordering::Relaxed);
        }
    }
    if !s.stop.swap(true, Ordering::AcqRel) {
        s.failures.fetch_add(1, Ordering::Relaxed);
        s.sockets.shutdown();
        s.network.shutdown();
    }
}
async fn accept(s: Arc<Shared>, listener: TcpListener) {
    while let Ok((mut stream, peer)) = listener.accept().await {
        let route = s
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
        let Some(route) = route else {
            continue;
        };
        if route.claimed.swap(true, Ordering::AcqRel) {
            continue;
        }
        let Ok(permit) = s.capacity.clone().try_acquire_owned() else {
            route.finished.store(true, Ordering::Release);
            s.failures.fetch_add(1, Ordering::Relaxed);
            continue;
        };
        let shared = s.clone();
        s.worker.spawn(async move {
            let _permit = permit;
            shared.tcp.fetch_add(1, Ordering::Relaxed);
            let result = async {
                if let Some(context)=route.external.clone() {
                    return crate::external_proxy::captured::tcp(context,stream,route.flow.destination).await.map_err(std::io::Error::other);
                }
                let (mut upstream, _) = socks(route.port, route.flow.destination, false).await?;
                tokio::io::copy_bidirectional(&mut stream, &mut upstream).await?;
                Ok::<(), std::io::Error>(())
            }
            .await;
            if result.is_err() {
                shared.failures.fetch_add(1, Ordering::Relaxed);
            }
            route.finished.store(true, Ordering::Release);
            *route.touched.lock().unwrap() = Instant::now();
        });
    }
}
async fn socks(
    port: u16,
    destination: SocketAddr,
    udp: bool,
) -> std::io::Result<(TcpStream, SocketAddr)> {
    tokio::time::timeout(Duration::from_secs(8), async {
        let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).await?;
        stream.write_all(&[5, 1, 0]).await?;
        let mut greeting = [0; 2];
        stream.read_exact(&mut greeting).await?;
        if greeting != [5, 0] {
            return Err(std::io::Error::other("SOCKS 认证失败"));
        }
        let mut request = vec![5, if udp { 3 } else { 1 }, 0];
        super::socks::encode(destination, &mut request);
        stream.write_all(&request).await?;
        let mut prefix = [0; 4];
        stream.read_exact(&mut prefix).await?;
        if prefix[..3] != [5, 0, 0] {
            return Err(std::io::Error::other("SOCKS 入口拒绝连接"));
        }
        let length = match prefix[3] {
            1 => 6,
            4 => 18,
            _ => return Err(std::io::Error::other("SOCKS 回应地址不支持")),
        };
        let mut data = vec![prefix[3]];
        data.resize(length + 1, 0);
        stream.read_exact(&mut data[1..]).await?;
        let (mut relay, _) =
            super::socks::decode(&data).ok_or_else(|| std::io::Error::other("SOCKS 回应无效"))?;
        if relay.ip().is_unspecified() {
            relay.set_ip(if relay.is_ipv4() {
                IpAddr::V4(Ipv4Addr::LOCALHOST)
            } else {
                IpAddr::V6(Ipv6Addr::LOCALHOST)
            });
        }
        Ok((stream, relay))
    })
    .await
    .map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, "SOCKS 入口超时"))?
}
async fn udp(
    s: Arc<Shared>,
    p: Packet,
    template: Vec<u8>,
    mut address: Address,
    port: u16,
    mut rx: mpsc::Receiver<Vec<u8>>,
    generation: u64,
    owner: super::ownership::Owner,
    external: Option<crate::external_proxy::captured::Context>,
) -> std::io::Result<()> {
    if let Some(context)=external {
        let (tx,mut replies)=mpsc::channel(16);
        let mut worker=tokio::spawn(crate::external_proxy::captured::udp(context,p.flow.destination,rx,tx));
        let mut completed=false;
        let result=loop {tokio::select! {
            result=&mut worker=>{completed=true;break result.map_err(std::io::Error::other)?.map_err(std::io::Error::other);},
            payload=replies.recv()=>{let Some(payload)=payload else{break Ok(());};
                if !s.owners.lock().unwrap().current(&owner)||!s.table.lock().unwrap().udp.get(&p.flow).is_some_and(|(g,_,_)|*g==generation){break Ok(());}
                if p.flow.destination.port()==53{s.dns.fetch_add(1,Ordering::Relaxed);}
                if let Some(mut response)=p.udp_reply(&template,&payload){if address.flags&(1<<18)==0{address.inbound();}send(&s,&mut response,&mut address,true);}
            }
        }};
        if !completed {worker.abort();let _=worker.await;}return result;
    }
    let (mut control, relay) =
        socks(port, SocketAddr::from((Ipv4Addr::UNSPECIFIED, 0)), true).await?;
    if !relay.ip().is_loopback() || relay.port() == 0 {
        return Err(std::io::Error::other("SOCKS UDP 入口必须为本机"));
    }
    let socket = UdpSocket::bind(SocketAddr::new(
        if relay.is_ipv4() {
            Ipv4Addr::LOCALHOST.into()
        } else {
            Ipv6Addr::LOCALHOST.into()
        },
        0,
    ))
    .await?;
    socket.connect(relay).await?;
    let mut buffer = vec![0; 65535];
    let mut control_byte = [0];
    loop {
        tokio::select! {
            payload=rx.recv()=>{let Some(payload)=payload else{return Ok(());};
                if p.flow.destination.port()==53&&super::dns::Question::parse_query(&payload).is_some(){s.dns.fetch_add(1,Ordering::Relaxed);}
                socket.send(&super::udp::encode(p.flow.destination,&payload)?).await?;
            },
            length=socket.recv(&mut buffer)=>{let payload=super::udp::decode(&buffer[..length?],p.flow.destination)?;
                if !s.owners.lock().unwrap().current(&owner)||!s.table.lock().unwrap().udp.get(&p.flow).is_some_and(|(g,_,_)|*g==generation){return Ok(());}
                if let Some(mut response)=p.udp_reply(&template,payload){if address.flags&(1<<18)==0{address.inbound();}send(&s,&mut response,&mut address,true);}
            },
            _=control.read(&mut control_byte)=>return Err(std::io::Error::other("SOCKS UDP 控制连接已断开")),
            _=tokio::time::sleep(Duration::from_secs(30))=>return Ok(()),
        }
    }
}

#[cfg(test)]
mod tests;

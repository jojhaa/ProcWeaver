use super::*;
use tokio::{io::{AsyncReadExt, AsyncWriteExt}, net::{TcpListener, TcpStream, UdpSocket}, sync::mpsc};
use std::{net::SocketAddr, time::Duration};

const LIMIT: Duration = Duration::from_secs(4);
struct Fixture { runtime: Arc<Engine>, root: PathBuf }
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("procweaver-external-udp-{}", crate::commands::bundle_launch::id()));
        std::fs::create_dir_all(&root).unwrap(); Self { runtime: Engine::load(root.clone()).unwrap(), root }
    }
    async fn start(&self, port: u16, dns_enabled: bool) -> View {
        let path = std::env::current_exe().unwrap().to_string_lossy().into_owned();
        let mut config = self.runtime.config();
        config.default_endpoint_id = Some("upstream".into()); config.endpoints = vec![endpoint("upstream", port)];
        config.dns.enabled = dns_enabled;
        config.bundles = vec![Bundle { id: "bundle".into(), name: "bundle".into(), main_exe: path.clone(), enabled: true, mode: "strict".into(), domains: vec![],
            members: vec![model::Member { kind: "path".into(), value: path, descendants: true }], endpoint_id: None, fallback: "direct".into(), port: 0, dns_port: 0 }];
        self.runtime.apply(config).await.unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.runtime.stop();
        if self.root.parent() == Some(std::env::temp_dir().as_path()) && self.root.file_name().unwrap().to_string_lossy().starts_with("procweaver-external-udp-") { let _ = std::fs::remove_dir_all(&self.root); }
    }
}
fn endpoint(id: &str, port: u16) -> Endpoint { Endpoint { id: id.into(), name: id.into(), protocol: "socks5".into(), host: "127.0.0.1".into(), port, username: String::new(), secret: String::new() } }
struct Lab { port: u16, task: tokio::task::JoinHandle<()>, events: mpsc::UnboundedReceiver<(u8, transport::Destination)> }
impl Drop for Lab { fn drop(&mut self) { self.task.abort(); } }
async fn lab(marker: u8, truncate: bool, reject_udp: bool, password: bool) -> Lab {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap(); let port = listener.local_addr().unwrap().port();
    let (send, events) = mpsc::unbounded_channel();
    let task = tokio::spawn(async move {
        let mut children = tokio::task::JoinSet::new();
        loop {
            tokio::select! {
                Some(_) = children.join_next(), if !children.is_empty() => {},
                next = listener.accept() => {
                    let Ok((mut tcp, _)) = next else { break; }; let send = send.clone();
                    children.spawn(async move {
                        let mut hello = [0; 3]; tcp.read_exact(&mut hello).await.unwrap();
                        assert_eq!(hello, [5, 1, if password { 2 } else { 0 }]); tcp.write_all(&[5, hello[2]]).await.unwrap();
                        if password {
                            assert_eq!(tcp.read_u8().await.unwrap(), 1);
                            let len = tcp.read_u8().await.unwrap(); let mut user = vec![0; len as usize]; tcp.read_exact(&mut user).await.unwrap(); assert_eq!(user, b"user");
                            let len = tcp.read_u8().await.unwrap(); let mut pass = vec![0; len as usize]; tcp.read_exact(&mut pass).await.unwrap(); assert_eq!(pass, b"pass"); tcp.write_all(&[1, 0]).await.unwrap();
                        }
                        let mut head = [0; 4]; tcp.read_exact(&mut head).await.unwrap();
                        let target = transport::read_address(&mut tcp, head[3]).await.unwrap();
                        send.send((head[1], target.clone())).unwrap();
                        if head[1] == 3 && reject_udp { tcp.write_all(&[5, 7, 0, 1, 0, 0, 0, 0, 0, 0]).await.unwrap(); return; }
                        if head[1] == 1 {
                            tcp.write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0]).await.unwrap();
                            let len = tcp.read_u16().await.unwrap(); let mut query = vec![0; len as usize]; tcp.read_exact(&mut query).await.unwrap();
                            let reply = dns::failure(&query, marker & 15); tcp.write_u16(reply.len() as u16).await.unwrap(); tcp.write_all(&reply).await.unwrap(); return;
                        }
                        assert_eq!(head[1], 3);
                        let udp = UdpSocket::bind("127.0.0.1:0").await.unwrap(); let port = udp.local_addr().unwrap().port();
                        let mut reply = vec![5, 0, 0, 1, 0, 0, 0, 0]; reply.extend(port.to_be_bytes()); tcp.write_all(&reply).await.unwrap();
                        let mut buffer = vec![0; 65535];
                        loop {
                            tokio::select! {
                                _ = tcp.read_u8() => break,
                                received = udp.recv_from(&mut buffer) => {
                                    let (len, from) = received.unwrap(); let (destination, data) = udp::decode(&buffer[..len]).unwrap();
                                    send.send((17, destination.clone())).unwrap();
                                    let mut response = if dns::question(data).is_ok() { dns::failure(data, marker & 15) } else { let mut v = vec![marker]; v.extend(data); v };
                                    if dns::question(data).is_ok() {
                                        let mut wrong = response.clone(); wrong[0] ^= 1;
                                        udp.send_to(&udp::encode(&destination, &wrong).unwrap(), from).await.unwrap();
                                        if truncate { response[2] |= 2; }
                                    }
                                    udp.send_to(&udp::encode(&destination, &response).unwrap(), from).await.unwrap();
                                }
                            }
                        }
                    });
                }
            }
        }
    });
    Lab { port, task, events }
}
async fn associate(port: u16) -> (TcpStream, UdpSocket, SocketAddr) {
    let mut tcp = TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port)).await.unwrap();
    tcp.write_all(&[5, 1, 0]).await.unwrap(); let mut hello = [0; 2]; tcp.read_exact(&mut hello).await.unwrap(); assert_eq!(hello, [5, 0]);
    tcp.write_all(&[5, 3, 0, 1, 0, 0, 0, 0, 0, 0]).await.unwrap();
    let mut head = [0; 4]; tokio::time::timeout(LIMIT, tcp.read_exact(&mut head)).await.unwrap().unwrap(); assert_eq!(&head[..3], &[5, 0, 0]);
    let relay = transport::read_address(&mut tcp, head[3]).await.unwrap();
    let socket = UdpSocket::bind("127.0.0.1:0").await.unwrap(); let address: SocketAddr = relay.authority().parse().unwrap();
    (tcp, socket, address)
}
async fn packet(socket: &UdpSocket, relay: SocketAddr, target: &transport::Destination, data: &[u8]) -> Vec<u8> {
    socket.send_to(&udp::encode(target, data).unwrap(), relay).await.unwrap(); let mut buffer = vec![0; 65535];
    let (len, _) = tokio::time::timeout(LIMIT, socket.recv_from(&mut buffer)).await.unwrap().unwrap(); udp::decode(&buffer[..len]).unwrap().1.to_vec()
}
async fn dns_udp(port: u16, query: &[u8]) -> Vec<u8> {
    let socket = UdpSocket::bind("127.0.0.1:0").await.unwrap(); socket.send_to(query, (std::net::Ipv4Addr::LOCALHOST, port)).await.unwrap();
    let mut buffer = vec![0; 65535]; let len = tokio::time::timeout(LIMIT, socket.recv(&mut buffer)).await.unwrap().unwrap(); buffer.truncate(len); buffer
}

#[test]
fn datagram_codecs_and_dns_parsers_reject_malformed_input_without_panics() {
    for host in ["192.0.2.1", "2001:db8::1", "unresolved.fixture.invalid"] {
        let target = transport::Destination::new(host, 12345).unwrap(); let packet = udp::encode(&target, b"payload").unwrap();
        let (decoded, data) = udp::decode(&packet).unwrap(); assert_eq!(decoded.authority(), target.authority()); assert_eq!(data, b"payload");
        for len in 0..packet.len() - 7 { assert!(udp::decode(&packet[..len]).is_err()); }
        let mut fragment = packet.clone(); fragment[2] = 1; assert!(udp::decode(&fragment).is_err());
        assert!(udp::encode(&target, &vec![0; 65507]).is_err());
    }
    let query = dns::query("fixture.invalid", 42).unwrap();
    let mut compressed = vec![0; 12]; compressed[..12].copy_from_slice(&query[..12]); compressed[2] |= 128;
    compressed.extend([0xc0, 18, 0, 1, 0, 1]); compressed.extend(&query[12..query.len() - 4]);
    assert_eq!(dns::question(&dns::failure(&query, 0)).err(), Some("DNS 查询头无效，仅支持单问题标准查询".into()));
    let mut cycle = query.clone(); cycle[12] = 0xc0; cycle[13] = 12; assert!(dns::question(&cycle).is_err());
    let mut compressed_query = compressed.clone(); compressed_query[2] &= 127; assert_eq!(dns::question(&compressed_query).unwrap().name, "fixture.invalid");
    let error = dns::failure(&compressed_query, 2); assert_eq!(error[3] & 15, 2); assert_eq!(&error[12..], &query[12..]);
    let oversized = { let mut v = dns::failure(&query, 0); v.resize(1000, 0); v };
    let truncated = dns::fit_udp(&query, oversized); assert!(truncated[2] & 2 != 0); assert_eq!(truncated.len(), query.len());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn udp_domain_auth_reuse_upstream_change_and_control_close() {
    let mut first = lab(65, false, false, true).await; let second = lab(66, false, false, false).await;
    let f = Fixture::new(); let view = f.start(first.port, false).await;
    let mut config = f.runtime.config(); config.endpoints[0].username = "user".into(); config.endpoints[0].secret = secrets::protect("pass").unwrap(); f.runtime.apply(config).await.unwrap();
    let (control, socket, relay) = associate(view.states[0].port).await;
    let target = transport::Destination::new("never-resolve.fixture.invalid", 443).unwrap();
    assert_eq!(packet(&socket, relay, &target, b"one").await, b"Aone");
    assert_eq!(packet(&socket, relay, &target, b"two").await, b"Atwo");
    let mut associations = 0; while let Ok((command, _)) = first.events.try_recv() { if command == 3 { associations += 1; } }
    assert_eq!(associations, 1, "multiple packets reuse the upstream UDP association");
    let mut config = f.runtime.config(); config.endpoints[0] = endpoint("upstream", second.port); f.runtime.apply(config).await.unwrap();
    assert_eq!(packet(&socket, relay, &target, b"new").await, b"Bnew");
    drop(control); tokio::time::sleep(Duration::from_millis(100)).await;
    socket.send_to(&udp::encode(&target, b"closed").unwrap(), relay).await.unwrap();
    assert!(!matches!(tokio::time::timeout(Duration::from_millis(200), socket.recv(&mut [0; 100])).await, Ok(Ok(_))));
    let _released = UdpSocket::bind(relay).await.unwrap();
    assert!(!f.root.join("core_data").exists());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dns_udp_and_tcp_ingress_validate_reply_and_retry_truncated_via_same_proxy() {
    let mut upstream = lab(0, true, false, false).await;
    let f = Fixture::new(); let view = f.start(upstream.port, true).await; assert!(view.states[0].dns_ready);
    let query = dns::query("matched.fixture.invalid", 77).unwrap();
    let reply = dns_udp(view.states[0].dns_port, &query).await; assert_eq!(reply, dns::failure(&query, 0)); assert_eq!(reply[2] & 2, 0);
    let mut tcp = TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, view.states[0].dns_port)).await.unwrap();
    for _ in 0..2 {
        tcp.write_u16(query.len() as u16).await.unwrap(); tcp.write_all(&query).await.unwrap();
        let len = tokio::time::timeout(LIMIT, tcp.read_u16()).await.unwrap().unwrap(); let mut reply = vec![0; len as usize]; tcp.read_exact(&mut reply).await.unwrap(); assert_eq!(reply, dns::failure(&query, 0));
    }
    let mut udp_seen = false; let mut tcp_seen = false;
    while let Ok((command, destination)) = upstream.events.try_recv() { if command == 17 { udp_seen = true; assert_eq!(destination.host, "1.1.1.1"); } if command == 1 { tcp_seen = true; assert_eq!(destination.host, "1.1.1.1"); } }
    assert!(udp_seen && tcp_seen);
    let mut config = f.runtime.config(); config.enabled = false; f.runtime.apply(config).await.unwrap();
    assert!(tokio::time::timeout(LIMIT, tcp.read_u8()).await.unwrap().is_err());
    let _tcp = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, view.states[0].dns_port)).await.unwrap();
    let _udp = UdpSocket::bind((std::net::Ipv4Addr::LOCALHOST, view.states[0].dns_port)).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dns_sandbox_queries_choose_bundle_or_default_even_on_one_udp_association() {
    let selected = lab(0, false, false, false).await; let fallback = lab(3, false, false, false).await;
    let f = Fixture::new(); let view = f.start(fallback.port, true).await;
    let mut config = f.runtime.config(); config.endpoints.push(endpoint("special", selected.port));
    config.bundles[0].endpoint_id = Some("special".into()); config.bundles[0].mode = "sandbox".into(); config.bundles[0].domains = vec!["matched.fixture.invalid".into()]; config.bundles[0].fallback = "default".into(); f.runtime.apply(config).await.unwrap();
    let (_control, socket, relay) = associate(view.states[0].port).await;
    let target = transport::Destination::new("192.0.2.53", 53).unwrap();
    for (name, code) in [("matched.fixture.invalid", 0), ("other.fixture.invalid", 3)] {
        let query = dns::query(name, 42).unwrap();
        let reply = packet(&socket, relay, &target, &query).await; assert_eq!(reply[3] & 15, code);
        let native = dns_udp(view.states[0].dns_port, &query).await; assert_eq!(native[3] & 15, code);
    }
    let mut config = f.runtime.config(); config.bundles[0].domains.clear(); f.runtime.apply(config).await.unwrap();
    let reply = packet(&socket, relay, &target, &dns::query("matched.fixture.invalid", 42).unwrap()).await; assert_eq!(reply[3] & 15, 3);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn udp_upstream_rejection_does_not_fall_back_to_direct_and_http_is_explicit() {
    let upstream = lab(0, false, true, false).await; let f = Fixture::new(); let view = f.start(upstream.port, false).await;
    let direct = UdpSocket::bind("127.0.0.1:0").await.unwrap(); let target = transport::Destination::new("127.0.0.1", direct.local_addr().unwrap().port()).unwrap();
    let (_control, socket, relay) = associate(view.states[0].port).await;
    socket.send_to(&udp::encode(&target, b"not-direct").unwrap(), relay).await.unwrap();
    assert!(tokio::time::timeout(Duration::from_millis(500), direct.recv(&mut [0; 100])).await.is_err());
    assert!(f.runtime.view().records.iter().any(|r| r.state == "failed" && r.message.contains("拒绝 UDP")));
    let mut http = endpoint("http", upstream.port); http.protocol = "http".into();
    let error = udp::Channel::open(Some(&http), &target, &[]).await.err().unwrap(); assert!(error.contains("HTTP 上游不支持"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dns_ports_persist_and_conflicts_roll_back_without_stopping_proxy() {
    let upstream = lab(0, false, false, false).await; let f = Fixture::new(); let view = f.start(upstream.port, true).await;
    let dns_port = view.states[0].dns_port; let proxy_port = view.states[0].port;
    let mut config = f.runtime.config(); config.dns.enabled = false; f.runtime.apply(config).await.unwrap();
    let occupied = UdpSocket::bind((std::net::Ipv4Addr::LOCALHOST, dns_port)).await.unwrap();
    let mut config = f.runtime.config(); config.dns.enabled = true; let old = config.revision;
    assert!(f.runtime.apply(config).await.is_err()); assert_eq!(f.runtime.config().revision, old); assert!(f.runtime.view().states[0].ready); assert_eq!(f.runtime.view().states[0].port, proxy_port);
    drop(occupied); let mut config = f.runtime.config(); config.dns.enabled = true;
    let restored = f.runtime.apply(config).await.unwrap(); assert_eq!(restored.states[0].dns_port, dns_port);
    let disk = Engine::load(f.root.clone()).unwrap(); assert_eq!(disk.config().bundles[0].dns_port, dns_port);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn udp_source_binding_and_process_identity_prevent_other_socket_and_pid_reuse() {
    let upstream = lab(90, false, false, false).await; let f = Fixture::new(); let view = f.start(upstream.port, false).await;
    let (_control, socket, relay) = associate(view.states[0].port).await; let target = transport::Destination::new("fixture.invalid", 443).unwrap();
    assert_eq!(packet(&socket, relay, &target, b"bound").await, b"Zbound");
    let other = UdpSocket::bind("127.0.0.1:0").await.unwrap(); other.send_to(&udp::encode(&target, b"wrong-socket").unwrap(), relay).await.unwrap();
    assert!(tokio::time::timeout(Duration::from_millis(150), other.recv(&mut [0; 100])).await.is_err());
    let source = socket.local_addr().unwrap(); let current = identity::inspect_udp(source).await.unwrap(); assert!(identity::udp_matches(source, &current).await);
    let mut recycled = current.clone(); recycled.identity.push('x'); assert!(!identity::udp_matches(source, &recycled).await);
    let mut wrong_pid = current; wrong_pid.pid = wrong_pid.pid.wrapping_add(1); assert!(!identity::udp_matches(source, &wrong_pid).await);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn explicit_direct_dns_and_datagrams_work_without_proxy_and_same_dns_ids_stay_isolated() {
    let upstream = lab(0, false, false, false).await; let f = Fixture::new(); let view = f.start(upstream.port, true).await;
    let resolver = UdpSocket::bind("127.0.0.1:0").await.unwrap(); let resolver_port = resolver.local_addr().unwrap().port();
    let resolver_task = tokio::spawn(async move {
        let mut buffer = [0; 4096];
        for _ in 0..2 { let (len, from) = resolver.recv_from(&mut buffer).await.unwrap(); resolver.send_to(&dns::failure(&buffer[..len], 3), from).await.unwrap(); }
    });
    let mut config = f.runtime.config(); config.dns.server = "127.0.0.1".into(); config.dns.port = resolver_port;
    config.bundles[0].mode = "sandbox".into(); config.bundles[0].domains.clear(); f.runtime.apply(config).await.unwrap();
    let first = dns::query("first.fixture.invalid", 12).unwrap(); let second = dns::query("second.fixture.invalid", 12).unwrap();
    let (a, b) = tokio::join!(dns_udp(view.states[0].dns_port, &first), dns_udp(view.states[0].dns_port, &second));
    assert_eq!(a, dns::failure(&first, 3)); assert_eq!(b, dns::failure(&second, 3)); resolver_task.await.unwrap();
    let echo = UdpSocket::bind("[::1]:0").await.unwrap(); let target = transport::Destination::new("::1", echo.local_addr().unwrap().port()).unwrap();
    let task = tokio::spawn(async move { let mut b = [0; 64]; let (n, from) = echo.recv_from(&mut b).await.unwrap(); echo.send_to(&b[..n], from).await.unwrap(); });
    let (_control, socket, relay) = associate(view.states[0].port).await;
    assert_eq!(packet(&socket, relay, &target, b"ipv6-direct").await, b"ipv6-direct"); task.await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dns_failure_returns_servfail_and_unmatched_owner_is_refused() {
    let upstream = lab(0, false, true, false).await; let f = Fixture::new(); let view = f.start(upstream.port, true).await;
    let query = dns::query("failure.fixture.invalid", 45).unwrap();
    let response = dns_udp(view.states[0].dns_port, &query).await; assert_eq!(response[3] & 15, 2);
    // A TCP DNS client can still use an upstream that denies UDP ASSOCIATE.
    let mut tcp = TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, view.states[0].dns_port)).await.unwrap();
    tcp.write_u16(query.len() as u16).await.unwrap(); tcp.write_all(&query).await.unwrap();
    let len = tokio::time::timeout(LIMIT, tcp.read_u16()).await.unwrap().unwrap(); let mut reply = vec![0; len as usize]; tcp.read_exact(&mut reply).await.unwrap(); assert_eq!(reply[3] & 15, 0);
    let mut config = f.runtime.config(); config.bundles[0].main_exe = "absent.exe".into(); config.bundles[0].members = vec![model::Member { value: "absent.exe".into(), kind: "name".into(), descendants: true }]; f.runtime.apply(config).await.unwrap();
    let response = dns_udp(view.states[0].dns_port, &query).await; assert_eq!(response[3] & 15, 5);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn in_flight_dns_reply_is_rejected_when_resolver_changes() {
    let upstream = lab(0, false, false, false).await; let f = Fixture::new(); let view = f.start(upstream.port, true).await;
    let resolver = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let mut config = f.runtime.config(); config.bundles[0].mode = "sandbox".into(); config.dns.server = "127.0.0.1".into(); config.dns.port = resolver.local_addr().unwrap().port(); f.runtime.apply(config).await.unwrap();
    let query = dns::query("pending.fixture.invalid", 99).unwrap(); let request = query.clone(); let port = view.states[0].dns_port;
    let client = tokio::spawn(async move { dns_udp(port, &request).await });
    let mut buffer = [0; 4096]; let (_, source) = tokio::time::timeout(LIMIT, resolver.recv_from(&mut buffer)).await.unwrap().unwrap();
    let mut config = f.runtime.config(); config.dns.server = "192.0.2.53".into(); f.runtime.apply(config).await.unwrap();
    resolver.send_to(&dns::failure(&query, 0), source).await.unwrap();
    let reply = client.await.unwrap(); assert_eq!(reply[3] & 15, 2);
    assert!(f.runtime.view().records.iter().any(|r| r.state == "failed" && r.message.contains("旧响应已丢弃")));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn http_proxy_dns_uses_tcp_connect_and_accepts_compressed_question_response() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap(); let port = listener.local_addr().unwrap().port();
    let task = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap(); let mut header = Vec::new();
        while !header.ends_with(b"\r\n\r\n") { header.push(stream.read_u8().await.unwrap()); }
        assert!(header.starts_with(b"CONNECT 192.0.2.53:53 HTTP/1.1"));
        stream.write_all(b"HTTP/1.1 200 OK\r\n\r\n").await.unwrap();
        let len = stream.read_u16().await.unwrap(); let mut query = vec![0; len as usize]; stream.read_exact(&mut query).await.unwrap();
        // A valid forward compression pointer with a name stored in the answer.
        let mut reply = query[..12].to_vec(); reply[2] |= 128; reply[7] = 1;
        reply.extend([0xc0, 18, 0, 1, 0, 1]); reply.extend(&query[12..query.len() - 4]);
        reply.extend([0, 1, 0, 1, 0, 0, 0, 30, 0, 4, 192, 0, 2, 1]);
        stream.write_u16(reply.len() as u16).await.unwrap(); stream.write_all(&reply).await.unwrap();
    });
    let mut http = endpoint("http", port); http.protocol = "http".into();
    let query = dns::query("compressed.fixture.invalid", 47).unwrap();
    let reply = dns::exchange(Some(&http), &transport::Destination::new("192.0.2.53", 53).unwrap(), &query, &[]).await.unwrap();
    assert_eq!(&reply[..2], &query[..2]); assert_eq!(reply[12], 0xc0); task.await.unwrap();
}

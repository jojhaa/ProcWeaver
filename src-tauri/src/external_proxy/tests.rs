use super::*;
use tokio::{io::{AsyncReadExt, AsyncWriteExt}, net::{TcpListener, TcpStream}};
use std::time::Duration;

struct Fixture { runtime: Arc<Engine>, path: PathBuf }
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("procweaver-external-test-{}", crate::commands::bundle_launch::id()));
        std::fs::create_dir_all(&path).unwrap();
        Self { runtime: Engine::load(path.clone()).unwrap(), path }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.runtime.stop();
        if self.path.parent() == Some(std::env::temp_dir().as_path()) && self.path.file_name().unwrap().to_string_lossy().starts_with("procweaver-external-test-") { let _ = std::fs::remove_dir_all(&self.path); }
    }
}
fn bundle(id: &str) -> Bundle {
    let path = std::env::current_exe().unwrap().to_string_lossy().into_owned();
    Bundle { id: id.into(), name: id.into(), main_exe: path.clone(), enabled: true, mode: "strict".into(), domains: vec![],
        members: vec![model::Member { kind: "path".into(), value: path, descendants: true }], endpoint_id: None, fallback: "direct".into(), port: 0, dns_port: 0 }
}
fn endpoint(port: u16, protocol: &str) -> Endpoint {
    Endpoint { id: "fixture".into(), name: "fixture".into(), protocol: protocol.into(), host: "127.0.0.1".into(), port, username: String::new(), secret: String::new() }
}
async fn header(stream: &mut TcpStream) -> String {
    tokio::time::timeout(Duration::from_secs(5), async {
        let mut data = Vec::new();
        while !data.ends_with(b"\r\n\r\n") { assert!(data.len() < 32768); data.push(stream.read_u8().await.unwrap()); }
        String::from_utf8(data).unwrap()
    }).await.unwrap()
}
async fn echo_socks() -> (u16, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let task = tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else { break; };
            tokio::spawn(async move {
                let mut greeting = [0; 3]; if stream.read_exact(&mut greeting).await.is_err() { return; }
                assert_eq!(greeting, [5, 1, 0]); stream.write_all(&[5, 0]).await.unwrap();
                let mut head = [0; 4]; stream.read_exact(&mut head).await.unwrap(); assert_eq!(&head[..3], &[5, 1, 0]);
                let _ = transport::read_address(&mut stream, head[3]).await.unwrap();
                stream.write_all(&[5, 0, 0, 1, 127, 0, 0, 1, 0, 0]).await.unwrap();
                let (mut read, mut write) = stream.split(); let _ = tokio::io::copy(&mut read, &mut write).await;
            });
        }
    });
    (port, task)
}
async fn start(f: &Fixture, e: Endpoint) -> View {
    let mut config = f.runtime.config(); config.default_endpoint_id = Some(e.id.clone()); config.endpoints = vec![e]; config.bundles = vec![bundle("first")];
    f.runtime.apply(config).await.unwrap()
}
async fn local_connect(port: u16, target: &str) -> TcpStream {
    let mut stream = TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port)).await.unwrap();
    stream.write_all(format!("CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n\r\n").as_bytes()).await.unwrap();
    let reply = header(&mut stream).await; assert!(reply.starts_with("HTTP/1.1 200"), "{reply}"); stream
}

#[cfg(windows)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn coreless_http_to_socks_stream_survives_upstream_change_and_stops_on_disable() {
    let f = Fixture::new(); let (port, upstream) = echo_socks().await;
    let view = start(&f, endpoint(port, "socks5")).await;
    assert!(!f.path.join("core_data").exists(), "No core configuration is created");
    let entry = view.states[0].port;
    let mut stream = local_connect(entry, "unresolved.fixture.invalid:443").await;
    stream.write_all(b"before").await.unwrap(); let mut echo = [0; 6]; stream.read_exact(&mut echo).await.unwrap(); assert_eq!(&echo, b"before");
    let unavailable = TcpListener::bind("127.0.0.1:0").await.unwrap().local_addr().unwrap().port();
    let mut config = f.runtime.config(); config.endpoints[0].port = unavailable;
    let changed = f.runtime.apply(config).await.unwrap(); assert_eq!(changed.states[0].port, entry);
    stream.write_all(b"after!").await.unwrap(); stream.read_exact(&mut echo).await.unwrap(); assert_eq!(&echo, b"after!");
    let mut fresh = TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, entry)).await.unwrap();
    fresh.write_all(b"CONNECT localhost:443 HTTP/1.1\r\nHost: localhost:443\r\n\r\n").await.unwrap();
    assert!(header(&mut fresh).await.starts_with("HTTP/1.1 502"));
    assert!(f.runtime.view().records.iter().any(|r| r.state == "failed" && r.upstream == "fixture"));
    let mut config = f.runtime.config(); config.bundles[0].enabled = false;
    f.runtime.apply(config).await.unwrap();
    assert!(!f.runtime.view().states[0].ready);
    let result = tokio::time::timeout(Duration::from_secs(2), stream.read_u8()).await.unwrap(); assert!(result.is_err());
    upstream.abort();
}

#[cfg(windows)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn socks_username_password_and_domain_are_forwarded_without_local_dns() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap(); let port = listener.local_addr().unwrap().port();
    let task = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut hello = [0; 3]; stream.read_exact(&mut hello).await.unwrap(); assert_eq!(hello, [5, 1, 2]); stream.write_all(&[5, 2]).await.unwrap();
        assert_eq!(stream.read_u8().await.unwrap(), 1);
        let n = stream.read_u8().await.unwrap(); let mut user = vec![0; n as usize]; stream.read_exact(&mut user).await.unwrap(); assert_eq!(user, b"fixture-user");
        let n = stream.read_u8().await.unwrap(); let mut pass = vec![0; n as usize]; stream.read_exact(&mut pass).await.unwrap(); assert_eq!(pass, b"fixture-pass");
        stream.write_all(&[1, 0]).await.unwrap();
        let mut head = [0; 4]; stream.read_exact(&mut head).await.unwrap(); assert_eq!(head, [5, 1, 0, 3]);
        let target = transport::read_address(&mut stream, head[3]).await.unwrap(); assert_eq!(target.host, "never-resolve.fixture.invalid"); assert_eq!(target.port, 443);
        stream.write_all(&[5, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0]).await.unwrap();
    });
    let mut proxy = endpoint(port, "socks5"); proxy.username = "fixture-user".into(); proxy.secret = secrets::protect("fixture-pass").unwrap();
    transport::connect(Some(&proxy), &transport::Destination::new("never-resolve.fixture.invalid", 443).unwrap(), &[]).await.unwrap();
    task.await.unwrap();
}

#[cfg(windows)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn http_auth_failure_is_explicit_and_credentials_never_enter_public_view() {
    let f = Fixture::new(); let listener = TcpListener::bind("127.0.0.1:0").await.unwrap(); let port = listener.local_addr().unwrap().port();
    let task = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap(); let request = header(&mut stream).await;
        assert!(request.contains("Proxy-Authorization: Basic "));
        assert!(request.starts_with("CONNECT target.fixture.invalid:443 "));
        stream.write_all(b"HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n").await.unwrap();
    });
    let mut proxy = endpoint(port, "http"); proxy.username = "fixture-user".into(); proxy.secret = secrets::protect("fixture-password").unwrap();
    let view = start(&f, proxy).await;
    let mut client = TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, view.states[0].port)).await.unwrap();
    client.write_all(b"CONNECT target.fixture.invalid:443 HTTP/1.1\r\nHost: target.fixture.invalid:443\r\n\r\n").await.unwrap();
    assert!(header(&mut client).await.starts_with("HTTP/1.1 502")); task.await.unwrap();
    let public = serde_json::to_string(&f.runtime.view()).unwrap(); assert!(!public.contains("fixture-password")); assert!(!public.contains("secret"));
    let disk = std::fs::read_to_string(f.path.join("config/external-proxy.json")).unwrap(); assert!(!disk.contains("fixture-password"));
}

#[cfg(windows)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unmatched_process_is_rejected_before_contacting_upstream_including_udp() {
    let f = Fixture::new(); let listener = TcpListener::bind("127.0.0.1:0").await.unwrap(); let port = listener.local_addr().unwrap().port();
    let view = start(&f, endpoint(port, "socks5")).await;
    let entry = view.states[0].port;
    let mut config = f.runtime.config(); config.bundles[0].main_exe = "never-running.exe".into(); config.bundles[0].members = vec![model::Member { value: "never-running.exe".into(), kind: "name".into(), descendants: true }];
    f.runtime.apply(config).await.unwrap();
    let mut stream = TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, entry)).await.unwrap();
    stream.write_all(b"CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n").await.unwrap(); assert!(header(&mut stream).await.starts_with("HTTP/1.1 403"));
    assert!(tokio::time::timeout(Duration::from_millis(50), listener.accept()).await.is_err());
    let mut stream = TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, entry)).await.unwrap();
    stream.write_all(&[5, 1, 0]).await.unwrap(); let mut greeting = [0; 2]; stream.read_exact(&mut greeting).await.unwrap(); assert_eq!(greeting, [5, 0]);
    stream.write_all(&[5, 3, 0, 1, 0, 0, 0, 0, 0, 0]).await.unwrap(); let mut reply = [0; 10]; stream.read_exact(&mut reply).await.unwrap(); assert_eq!(reply[1], 2);
}

#[cfg(windows)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn http_keep_alive_evaluates_each_domain_and_empty_sandbox_uses_fallback() {
    let f = Fixture::new(); let upstream = TcpListener::bind("127.0.0.1:0").await.unwrap(); let direct = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = upstream.local_addr().unwrap().port(); let direct_port = direct.local_addr().unwrap().port();
    let proxy_task = tokio::spawn(async move { let (mut stream, _) = upstream.accept().await.unwrap(); let request = header(&mut stream).await;
        assert!(request.starts_with("GET http://matched.fixture.invalid/ ")); assert!(!request.to_lowercase().contains("proxy-authorization:"));
        stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nproxy").await.unwrap(); });
    let direct_task = tokio::spawn(async move { let (mut stream, _) = direct.accept().await.unwrap(); let request = header(&mut stream).await;
        assert!(request.starts_with("GET / ")); assert!(!request.to_lowercase().contains("proxy-authorization:"));
        stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 6\r\n\r\ndirect").await.unwrap(); });
    start(&f, endpoint(port, "http")).await;
    let mut config = f.runtime.config(); config.bundles[0].mode = "sandbox".into(); config.bundles[0].domains = vec!["matched.fixture.invalid".into()]; let view = f.runtime.apply(config).await.unwrap();
    let mut client = TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, view.states[0].port)).await.unwrap();
    client.write_all(b"GET http://matched.fixture.invalid/ HTTP/1.1\r\nHost: fake.invalid\r\nProxy-Authorization: private-client-token\r\n\r\n").await.unwrap();
    assert!(header(&mut client).await.starts_with("HTTP/1.1 200")); let mut data = [0; 5]; client.read_exact(&mut data).await.unwrap(); assert_eq!(&data, b"proxy");
    let mut config = f.runtime.config(); config.bundles[0].domains.clear(); f.runtime.apply(config).await.unwrap();
    client.write_all(format!("GET http://127.0.0.1:{direct_port}/ HTTP/1.1\r\nHost: localhost\r\n\r\n").as_bytes()).await.unwrap();
    assert!(header(&mut client).await.starts_with("HTTP/1.1 200")); let mut data = [0; 6]; client.read_exact(&mut data).await.unwrap(); assert_eq!(&data, b"direct");
    proxy_task.await.unwrap(); direct_task.await.unwrap();
}

#[cfg(windows)]
#[tokio::test]
async fn occupied_stable_port_and_failed_save_leave_previous_configuration_intact() {
    let f = Fixture::new(); let (port, upstream) = echo_socks().await;
    let first = start(&f, endpoint(port, "socks5")).await;
    let mut stale = f.runtime.config(); stale.revision = 0;
    assert!(f.runtime.apply(stale).await.err().unwrap().contains("已改变"));
    assert_eq!(f.runtime.view().revision, first.revision);
    let before = std::fs::read(f.path.join("config/external-proxy.json")).unwrap();
    let mut invalid = f.runtime.config(); invalid.endpoints[0].port = first.states[0].port;
    assert!(f.runtime.apply(invalid).await.err().unwrap().contains("本程序业务入口"));
    assert_eq!(std::fs::read(f.path.join("config/external-proxy.json")).unwrap(), before);
    assert!(f.runtime.view().states[0].ready);
    // Block the isolated configuration directory, never a user's live data.
    let config_dir = f.path.join("config"); let held_dir = f.path.join("held-config");
    std::fs::rename(&config_dir, &held_dir).unwrap(); std::fs::write(&config_dir, b"blocked").unwrap();
    let mut changed = f.runtime.config(); changed.endpoints[0].name = "not-committed".into();
    assert!(f.runtime.apply(changed).await.err().unwrap().contains("保存失败"));
    assert_eq!(f.runtime.config().endpoints[0].name, "fixture"); assert!(f.runtime.view().states[0].ready);
    std::fs::remove_file(&config_dir).unwrap(); std::fs::rename(&held_dir, &config_dir).unwrap();
    assert_eq!(std::fs::read(f.path.join("config/external-proxy.json")).unwrap(), before);
    let restored = Engine::load(f.path.clone()).unwrap();
    assert!(restored.apply(restored.config()).await.err().unwrap().contains("被占用"));
    assert!(f.runtime.view().states[0].ready);
    upstream.abort();
}

#[test]
fn shared_executable_instances_follow_closest_ancestor_and_reject_ambiguous_roots() {
    let mut a = bundle("a"); a.main_exe = "app-a.exe".into(); a.members = vec![model::Member { value: "app-a.exe".into(), kind: "name".into(), descendants: true }];
    let mut b = a.clone(); b.id = "b".into(); b.main_exe = "app-b.exe".into(); b.members[0].value = "app-b.exe".into();
    let mut process = crate::routing_overrides::tracker::ProcessEntry { pid: 9, parent_pid: 8, identity: "9:10".into(), created_at: 10, name: "node.exe".into(), executable_path: Some(r"C:\shared\node.exe".into()), parent_identity: Some("8:9".into()), ancestors: vec![("8:9".into(), r"C:\apps\app-a.exe".into())] };
    assert_eq!(identity::owner(&[a.clone(), b.clone()], &process), Some("a"));
    process.ancestors[0].1 = r"C:\apps\app-b.exe".into(); assert_eq!(identity::owner(&[a.clone(), b.clone()], &process), Some("b"));
    process.ancestors.clear(); assert_eq!(identity::owner(&[a.clone(), b.clone()], &process), None);
    b.members = a.members.clone(); process.ancestors.push(("8:9".into(), r"C:\apps\app-a.exe".into())); assert_eq!(identity::owner(&[a, b], &process), None);
}

#[test]
fn core_name_rule_cannot_overlap_an_independent_path_and_paused_core_is_ignored() {
    use crate::routing_overrides::model::{Overrides, ProcessRule};
    let mut config = Config { bundles: vec![bundle("first")], ..Config::default() };
    let name = std::path::Path::new(&config.bundles[0].main_exe).file_name().unwrap().to_string_lossy().into_owned();
    let core = Overrides { process_enabled: true, process_rules: vec![ProcessRule { id: "manual".into(), enabled: true, label: "test".into(), match_kind: "name".into(), match_value: name, action: "direct".into(), target: None, include_descendants: false, rule_mode: None }], ..Overrides::default() };
    assert!(validate_core_separation(&config, &core).is_err());
    let mut disabled = core.clone(); disabled.process_enabled = false; assert!(validate_core_separation(&config, &disabled).is_ok());
    config.bundles[0].enabled = false; assert!(validate_core_separation(&config, &core).is_ok());
}

#[cfg(windows)]
#[tokio::test]
async fn rapid_disable_enable_releases_port_and_restart_keeps_the_entry() {
    let f = Fixture::new(); let (port, upstream) = echo_socks().await;
    let first = start(&f, endpoint(port, "socks5")).await; let entry = first.states[0].port;
    for _ in 0..4 {
        let mut config = f.runtime.config(); config.enabled = false; f.runtime.apply(config).await.unwrap();
        let held = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, entry)).await.expect("disable released stable port"); drop(held);
        let mut config = f.runtime.config(); config.enabled = true;
        assert_eq!(f.runtime.apply(config).await.unwrap().states[0].port, entry);
    }
    let mut config = f.runtime.config(); config.enabled = false; f.runtime.apply(config).await.unwrap();
    let restored = Engine::load(f.path.clone()).unwrap(); let mut config = restored.config(); config.enabled = true;
    assert_eq!(restored.apply(config).await.unwrap().states[0].port, entry); restored.stop(); upstream.abort();
}

#[cfg(windows)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn socks_ingress_to_http_connect_preserves_tunnel_bytes() {
    let f = Fixture::new(); let upstream = TcpListener::bind("127.0.0.1:0").await.unwrap(); let port = upstream.local_addr().unwrap().port();
    let task = tokio::spawn(async move {
        let (mut stream, _) = upstream.accept().await.unwrap();
        assert!(header(&mut stream).await.starts_with("CONNECT domain.fixture.invalid:443 "));
        stream.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\nhello").await.unwrap();
        let mut data = [0; 5]; stream.read_exact(&mut data).await.unwrap(); assert_eq!(&data, b"world");
    });
    let view = start(&f, endpoint(port, "http")).await;
    let mut stream = TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, view.states[0].port)).await.unwrap();
    stream.write_all(&[5, 1, 0]).await.unwrap(); let mut greeting = [0; 2]; stream.read_exact(&mut greeting).await.unwrap(); assert_eq!(greeting, [5, 0]);
    let host = b"domain.fixture.invalid"; let mut request = vec![5, 1, 0, 3, host.len() as u8]; request.extend(host); request.extend(443u16.to_be_bytes());
    stream.write_all(&request).await.unwrap(); let mut reply = [0; 10]; stream.read_exact(&mut reply).await.unwrap(); assert_eq!(reply[1], 0);
    let mut data = [0; 5]; stream.read_exact(&mut data).await.unwrap(); assert_eq!(&data, b"hello"); stream.write_all(b"world").await.unwrap(); task.await.unwrap();
}

#[cfg(windows)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn websocket_upgrades_and_sse_streams_before_response_completion() {
    let f = Fixture::new(); let upstream = TcpListener::bind("127.0.0.1:0").await.unwrap(); let port = upstream.local_addr().unwrap().port();
    let (finish, wait) = tokio::sync::oneshot::channel();
    let task = tokio::spawn(async move {
        let (mut ws, _) = upstream.accept().await.unwrap();
        let request = header(&mut ws).await; assert!(request.starts_with("GET http://stream.fixture.invalid/ws ")); assert!(request.to_lowercase().contains("upgrade: websocket"));
        ws.write_all(b"HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: fixture\r\n\r\n").await.unwrap();
        let mut frame = [0; 4]; ws.read_exact(&mut frame).await.unwrap(); assert_eq!(frame, [0x81, 2, b'h', b'i']); ws.write_all(&frame).await.unwrap();
        let (mut sse, _) = upstream.accept().await.unwrap(); assert!(header(&mut sse).await.contains("/events"));
        sse.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n9\r\ndata: 1\n\n\r\n").await.unwrap();
        wait.await.unwrap(); sse.write_all(b"0\r\n\r\n").await.unwrap();
    });
    let view = start(&f, endpoint(port, "http")).await; let entry = view.states[0].port;
    let mut ws = TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, entry)).await.unwrap();
    ws.write_all(b"GET ws://stream.fixture.invalid/ws HTTP/1.1\r\nHost: stream.fixture.invalid\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: fixture\r\nSec-WebSocket-Version: 13\r\n\r\n").await.unwrap();
    assert!(header(&mut ws).await.starts_with("HTTP/1.1 101")); ws.write_all(&[0x81, 2, b'h', b'i']).await.unwrap();
    let mut frame = [0; 4]; tokio::time::timeout(Duration::from_secs(3), ws.read_exact(&mut frame)).await.unwrap().unwrap(); assert_eq!(frame, [0x81, 2, b'h', b'i']);
    let mut sse = TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, entry)).await.unwrap();
    sse.write_all(b"GET http://stream.fixture.invalid/events HTTP/1.1\r\nHost: stream.fixture.invalid\r\n\r\n").await.unwrap(); assert!(header(&mut sse).await.starts_with("HTTP/1.1 200"));
    let mut first = [0; 14]; tokio::time::timeout(Duration::from_secs(3), sse.read_exact(&mut first)).await.unwrap().unwrap(); assert_eq!(&first, b"9\r\ndata: 1\n\n\r\n");
    finish.send(()).unwrap(); task.await.unwrap();
}

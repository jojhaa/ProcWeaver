use super::super::model::{Bundle, Endpoint, Member};
use super::*;
use tokio::net::{TcpListener, UdpSocket};
#[path = "captured_driver_tests.rs"]
mod driver;
struct Fixture {
    context: Context,
    root: std::path::PathBuf,
}
impl Fixture {
    fn new(port: u16, protocol: &str, sandbox: bool) -> Self {
        let root = std::env::temp_dir().join(format!(
            "procweaver-captured-{}",
            crate::commands::bundle_launch::id()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let runtime = Engine::load(root.clone()).unwrap();
        let process = native::inspect(std::process::id(), 0, String::new());
        let path = process.executable_path.clone().unwrap();
        let mut config = runtime.config();
        config.default_endpoint_id = Some("upstream".into());
        config.endpoints = vec![Endpoint {
            id: "upstream".into(),
            name: "fixture".into(),
            protocol: protocol.into(),
            host: "127.0.0.1".into(),
            port,
            username: String::new(),
            secret: String::new(),
        }];
        config.bundles = vec![Bundle {
            id: "bundle".into(),
            name: "fixture".into(),
            main_exe: path.clone(),
            enabled: true,
            mode: if sandbox { "sandbox" } else { "strict" }.into(),
            domains: vec!["match.test".into()],
            members: vec![Member {
                kind: "path".into(),
                value: path,
                descendants: true,
            }],
            endpoint_id: None,
            fallback: "direct".into(),
            port: 0,
            dns_port: 0,
        }];
        *runtime.config.write().unwrap() = config;
        Self {
            context: Context {
                runtime,
                id: "bundle".into(),
                process,
            },
            root,
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.context.runtime.stop();
        if self.root.parent() == Some(std::env::temp_dir().as_path())
            && self
                .root
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("procweaver-captured-")
        {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }
}
async fn pair() -> (TcpStream, TcpStream) {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let c = TcpStream::connect(l.local_addr().unwrap()).await.unwrap();
    let (s, _) = l.accept().await.unwrap();
    (c, s)
}
async fn header(s: &mut TcpStream) -> String {
    let mut out = vec![];
    while !out.ends_with(b"\r\n\r\n") {
        assert!(out.len() < 32768);
        out.push(s.read_u8().await.unwrap());
    }
    String::from_utf8(out).unwrap()
}
fn query() -> Vec<u8> {
    let mut q = vec![0x12, 0x34, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0];
    for label in ["match", "test"] {
        q.push(label.len() as u8);
        q.extend(label.as_bytes());
    }
    q.extend([0, 0, 1, 0, 1]);
    q
}
#[test]
fn identity_proof_rejects_pid_reuse_and_path_changes() {
    let process = native::inspect(std::process::id(), 0, String::new());
    let expected = Identity {
        pid: process.pid,
        created_at: process.created_at,
        path: process.executable_path.clone().unwrap(),
    };
    assert!(matches_identity(&expected, &process));
    let mut changed = process.clone();
    changed.created_at += 1;
    assert!(!matches_identity(&expected, &changed));
    changed = process.clone();
    changed.pid += 1;
    assert!(!matches_identity(&expected, &changed));
    changed = process;
    changed.executable_path = Some("different.exe".into());
    assert!(!matches_identity(&expected, &changed));
}
#[tokio::test]
async fn failed_proxy_never_retries_tcp_direct() {
    let proxy = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let f = Fixture::new(proxy.local_addr().unwrap().port(), "http", false);
    let target = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let reject = tokio::spawn(async move {
        let (mut s, _) = proxy.accept().await.unwrap();
        header(&mut s).await;
        s.write_all(b"HTTP/1.1 502 Bad Gateway\r\n\r\n")
            .await
            .unwrap();
    });
    let (_client, relay) = pair().await;
    assert!(tcp(f.context.clone(), relay, target.local_addr().unwrap())
        .await
        .is_err());
    reject.await.unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(50), target.accept())
            .await
            .is_err()
    );
}
#[tokio::test]
async fn udp_dns_proxy_failure_returns_servfail_without_direct_retry() {
    let proxy = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let f = Fixture::new(proxy.local_addr().unwrap().port(), "http", false);
    let reject = tokio::spawn(async move {
        let (mut s, _) = proxy.accept().await.unwrap();
        assert!(header(&mut s).await.starts_with("CONNECT 192.0.2.53:53 "));
        s.write_all(b"HTTP/1.1 502 Bad Gateway\r\n\r\n")
            .await
            .unwrap();
    });
    let (tx, rx) = mpsc::channel(4);
    let (out, mut replies) = mpsc::channel(4);
    let job = tokio::spawn(udp(
        f.context.clone(),
        "192.0.2.53:53".parse().unwrap(),
        rx,
        out,
    ));
    tx.send(query()).await.unwrap();
    let reply = tokio::time::timeout(Duration::from_secs(2), replies.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(reply[3] & 15, 2);
    assert_eq!(
        f.context
            .runtime
            .records
            .lock()
            .unwrap()
            .back()
            .unwrap()
            .state,
        "failed"
    );
    reject.await.unwrap();
    drop(tx);
    job.await.unwrap().unwrap();
}
#[tokio::test]
async fn transparent_http_preserves_original_ip_prefix_and_process() {
    let upstream = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let f = Fixture::new(upstream.local_addr().unwrap().port(), "http", true);
    let proxy = tokio::spawn(async move {
        let (mut s, _) = upstream.accept().await.unwrap();
        assert!(header(&mut s).await.starts_with("CONNECT 192.0.2.99:443 "));
        s.write_all(b"HTTP/1.1 200 OK\r\n\r\n").await.unwrap();
        let h = header(&mut s).await;
        assert!(h.contains("Host: match.test"));
        s.write_all(b"accepted").await.unwrap();
    });
    let (mut client, relay) = pair().await;
    let context = f.context.clone();
    let task = tokio::spawn(tcp(context, relay, "192.0.2.99:443".parse().unwrap()));
    client.write_all(b"GET / HTTP/1.1\r\nHo").await.unwrap();
    tokio::time::sleep(Duration::from_millis(10)).await;
    client.write_all(b"st: match.test\r\n\r\n").await.unwrap();
    let mut reply = [0; 8];
    tokio::time::timeout(Duration::from_secs(3), client.read_exact(&mut reply))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(&reply, b"accepted");
    drop(client);
    proxy.await.unwrap();
    task.await.unwrap().unwrap();
    let records = f.context.runtime.records.lock().unwrap();
    assert_eq!(records[0].pid, std::process::id());
    assert_eq!(records[0].target, "match.test:443");
    assert!(records[0].route.contains("WinDivert"));
}
#[tokio::test]
async fn sandbox_unmatched_uses_explicit_direct_and_no_upstream() {
    let target = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let destination = target.local_addr().unwrap();
    let forbidden = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let f = Fixture::new(forbidden.local_addr().unwrap().port(), "http", true);
    let service = tokio::spawn(async move {
        let (mut s, _) = target.accept().await.unwrap();
        assert!(header(&mut s).await.contains("Host: other.test"));
        s.write_all(b"direct").await.unwrap();
    });
    let (mut client, relay) = pair().await;
    let task = tokio::spawn(tcp(f.context.clone(), relay, destination));
    client
        .write_all(b"GET / HTTP/1.1\r\nHost: other.test\r\n\r\n")
        .await
        .unwrap();
    let mut out = [0; 6];
    tokio::time::timeout(Duration::from_secs(3), client.read_exact(&mut out))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(&out, b"direct");
    drop(client);
    service.await.unwrap();
    task.await.unwrap().unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(30), forbidden.accept())
            .await
            .is_err()
    );
}
#[tokio::test]
async fn stale_identity_and_http_udp_fail_closed() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let f = Fixture::new(listener.local_addr().unwrap().port(), "http", false);
    let mut stale = f.context.clone();
    stale.process.identity.push('x');
    assert!(!stale.valid());
    assert!(stale
        .select(&Destination::new("match.test", 443).unwrap())
        .is_err());
    let (tx, rx) = mpsc::channel(4);
    let (out, _) = mpsc::channel(4);
    tx.send(b"udp".to_vec()).await.unwrap();
    assert!(udp(
        f.context.clone(),
        "192.0.2.99:123".parse().unwrap(),
        rx,
        out
    )
    .await
    .unwrap_err()
    .contains("HTTP"));
    assert!(
        tokio::time::timeout(Duration::from_millis(30), listener.accept())
            .await
            .is_err()
    );
    assert_eq!(
        f.context
            .runtime
            .records
            .lock()
            .unwrap()
            .back()
            .unwrap()
            .state,
        "failed"
    );
}
#[tokio::test]
async fn native_udp_dns_uses_query_policy_and_http_tcp_tunnel() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let f = Fixture::new(listener.local_addr().unwrap().port(), "http", true);
    let server = tokio::spawn(async move {
        let (mut s, _) = listener.accept().await.unwrap();
        assert!(header(&mut s).await.starts_with("CONNECT 192.0.2.53:53 "));
        s.write_all(b"HTTP/1.1 200 OK\r\n\r\n").await.unwrap();
        let len = s.read_u16().await.unwrap() as usize;
        let mut q = vec![0; len];
        s.read_exact(&mut q).await.unwrap();
        let r = dns::failure(&q, 0);
        s.write_u16(r.len() as u16).await.unwrap();
        s.write_all(&r).await.unwrap();
    });
    let (tx, rx) = mpsc::channel(4);
    let (out, mut replies) = mpsc::channel(4);
    let job = tokio::spawn(udp(
        f.context.clone(),
        "192.0.2.53:53".parse().unwrap(),
        rx,
        out,
    ));
    tx.send(query()).await.unwrap();
    let reply = tokio::time::timeout(Duration::from_secs(3), replies.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(&reply[..2], &[0x12, 0x34]);
    server.await.unwrap();
    drop(tx);
    job.await.unwrap().unwrap();
    assert_eq!(
        f.context.runtime.records.lock().unwrap()[0].target,
        "match.test:53"
    );
}
#[tokio::test]
async fn ordinary_udp_uses_socks_association_and_preserves_original_target() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let f = Fixture::new(listener.local_addr().unwrap().port(), "socks5", false);
    let server = tokio::spawn(async move {
        let (mut s, _) = listener.accept().await.unwrap();
        let mut h = [0; 3];
        s.read_exact(&mut h).await.unwrap();
        assert_eq!(h, [5, 1, 0]);
        s.write_all(&[5, 0]).await.unwrap();
        let mut h = [0; 4];
        s.read_exact(&mut h).await.unwrap();
        assert_eq!(h[1], 3);
        transport::read_address(&mut s, h[3]).await.unwrap();
        let socket = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let mut response = vec![5, 0, 0, 1, 127, 0, 0, 1];
        response.extend(socket.local_addr().unwrap().port().to_be_bytes());
        s.write_all(&response).await.unwrap();
        let mut buffer = vec![0; 65535];
        let (n, from) = socket.recv_from(&mut buffer).await.unwrap();
        let (target, payload) = super::super::udp::decode(&buffer[..n]).unwrap();
        assert_eq!(target.authority(), "192.0.2.99:123");
        assert_eq!(payload, b"udp");
        socket.send_to(&buffer[..n], from).await.unwrap();
        let _ = s.read_u8().await;
    });
    let (tx, rx) = mpsc::channel(4);
    let (out, mut replies) = mpsc::channel(4);
    let job = tokio::spawn(udp(
        f.context.clone(),
        "192.0.2.99:123".parse().unwrap(),
        rx,
        out,
    ));
    tx.send(b"udp".to_vec()).await.unwrap();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(3), replies.recv())
            .await
            .unwrap()
            .unwrap(),
        b"udp"
    );
    drop(tx);
    job.await.unwrap().unwrap();
    server.await.unwrap();
}

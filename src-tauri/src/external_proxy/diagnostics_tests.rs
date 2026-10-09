use super::super::{
    model::Endpoint,
    transport::{self, Destination},
    udp::Channel,
};
use super::*;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, UdpSocket},
};

struct Fixture {
    root: PathBuf,
    log: Arc<Log>,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "procweaver-log-test-{}",
            crate::commands::bundle_launch::id()
        ));
        fs::create_dir_all(&root).unwrap();
        Self {
            log: Log::start(root.clone(), LIMIT, ARCHIVES),
            root,
        }
    }
    fn trace(&self) -> Trace {
        Trace {
            log: Some(self.log.clone()),
            id: NEXT.fetch_add(1, Ordering::Relaxed),
            record: Some(71),
            started: Instant::now(),
        }
    }
    fn rows(&self) -> Vec<Value> {
        assert!(self.log.barrier(false));
        fs::read_to_string(self.root.join(FILE))
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.log.barrier(true);
        if self.root.parent() == Some(std::env::temp_dir().as_path())
            && self
                .root
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("procweaver-log-test-")
        {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
}
fn endpoint(port: u16) -> Endpoint {
    Endpoint {
        id: "test".into(),
        name: "test".into(),
        host: "127.0.0.1".into(),
        port,
        protocol: "socks5".into(),
        username: String::new(),
        secret: String::new(),
    }
}

#[test]
fn metadata_is_redacted_and_session_counts_release_on_cancel() {
    let fixture = Fixture::new();
    let trace = fixture.trace();
    let activity = trace.activity("udp");
    assert_eq!(fixture.log.status().active_udp, 1);
    trace.event("test","info",json!({"password":"DO_NOT_STORE","nested":{"authorization":"AUTH_SECRET","payload":"BODY_SECRET","access_token":"TOKEN_SECRET","headers":{"x-key":"HEADER_SECRET"}},"processName":"target.exe"}));
    {
        let _step = trace.step("test.cancel");
    }
    drop(activity);
    assert_eq!(fixture.log.status().active_udp, 0);
    let rows = fixture.rows();
    let text = serde_json::to_string(&rows).unwrap();
    for secret in [
        "DO_NOT_STORE",
        "AUTH_SECRET",
        "BODY_SECRET",
        "TOKEN_SECRET",
        "HEADER_SECRET",
    ] {
        assert!(!text.contains(secret));
    }
    assert!(rows.iter().any(|row| row["event"] == "stage.cancelled"));
    assert!(rows
        .iter()
        .any(|row| row["event"] == "session.released" && row["details"]["recordId"] == 71));
}

#[test]
fn rotation_is_bounded_and_preserves_unrelated_files() {
    let fixture = Fixture::new();
    assert!(fixture.log.barrier(true));
    fs::write(fixture.root.join("other.txt"), "keep").unwrap();
    let log = Log::start(fixture.root.clone(), 600, 2);
    for number in 0..20 {
        log.emit(
            "rotation",
            "info",
            json!({"number":number,"padding":"x".repeat(100)}),
        );
    }
    assert!(log.barrier(true));
    let files = fs::read_dir(&fixture.root)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    assert_eq!(
        files.iter().filter(|name| name.starts_with(FILE)).count(),
        3
    );
    assert_eq!(
        fs::read_to_string(fixture.root.join("other.txt")).unwrap(),
        "keep"
    );
    for name in files.iter().filter(|name| name.starts_with(FILE)) {
        assert!(fs::metadata(fixture.root.join(name)).unwrap().len() <= 600);
        for line in fs::read_to_string(fixture.root.join(name)).unwrap().lines() {
            serde_json::from_str::<Value>(line).unwrap();
        }
    }
}

#[test]
fn unwritable_log_reports_error_without_blocking_network_producers() {
    let fixture = Fixture::new();
    let blocked = fixture.root.join("blocked");
    fs::write(&blocked, "file").unwrap();
    let log = Log::start(blocked, LIMIT, ARCHIVES);
    let started = Instant::now();
    for _ in 0..100 {
        log.emit("test", "info", json!({}));
    }
    assert!(started.elapsed() < Duration::from_secs(1));
    assert!(!log.barrier(false));
    assert!(!log.status().ready);
    assert!(log.status().error.is_some());
    assert!(log.status().dropped > 0);
    fs::remove_file(fixture.root.join("blocked")).unwrap();
    log.emit("recovered", "info", json!({"message":"恢复写入"}));
    assert!(log.barrier(false));
    assert!(log.status().ready);
    assert!(log.status().error.is_none());
    assert!(fs::read_to_string(fixture.root.join("blocked").join(FILE))
        .unwrap()
        .contains("recovered"));
    assert!(log.barrier(true));
}

#[tokio::test]
async fn dial_failure_records_first_hop_and_failure_kind() {
    let fixture = Fixture::new();
    let trace = fixture.trace();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let result = transport::connect_traced(
        Some(&endpoint(port)),
        &Destination::new("target.invalid", 443).unwrap(),
        &[],
        &trace,
    )
    .await;
    assert!(result.is_err());
    let rows = fixture.rows();
    let error = rows
        .iter()
        .find(|row| row["event"] == "stage.failed" && row["details"]["data"]["stage"] == "dial.tcp")
        .unwrap();
    assert_eq!(error["details"]["recordId"], 71);
    assert_eq!(
        error["details"]["data"]["result"]["address"],
        format!("127.0.0.1:{port}")
    );
    let result = &error["details"]["data"]["result"];
    assert!(
        result["io"]["osCode"].is_number()
            || result["reason"] == "timeout" && result["budgetMs"] == 2000
    );
    assert!(!rows
        .iter()
        .any(|row| row["details"]["data"]["stage"] == "socks.connect"));
}

#[test]
fn logger_is_disabled_in_full_edition() {
    if !crate::edition::PROCESS {
        let root = std::env::temp_dir().join(format!(
            "procweaver-no-log-{}",
            crate::commands::bundle_launch::id()
        ));
        initialize(&root);
        assert!(status().is_none());
        assert!(!root.exists());
    }
    assert_eq!(
        transport::io_detail(&std::io::Error::from_raw_os_error(10061))["osCode"],
        10061
    );
}

#[tokio::test]
async fn socks_rejection_keeps_reply_code_and_never_logs_auth_secret() {
    let fixture = Fixture::new();
    let trace = fixture.trace();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut hello = [0; 3];
        stream.read_exact(&mut hello).await.unwrap();
        stream.write_all(&[5, 0]).await.unwrap();
        let mut header = [0; 4];
        stream.read_exact(&mut header).await.unwrap();
        let _ = transport::read_address(&mut stream, header[3])
            .await
            .unwrap();
        stream
            .write_all(&[5, 5, 0, 1, 0, 0, 0, 0, 0, 0])
            .await
            .unwrap();
    });
    let mut upstream = endpoint(port);
    upstream.secret = "UNUSED_SECRET".into();
    assert!(transport::connect_traced(
        Some(&upstream),
        &Destination::new("target.invalid", 443).unwrap(),
        &[],
        &trace
    )
    .await
    .is_err());
    server.await.unwrap();
    let rows = fixture.rows();
    assert!(rows.iter().any(
        |row| row["event"] == "socks.command_reply" && row["details"]["data"]["replyCode"] == 5
    ));
    assert!(!serde_json::to_string(&rows)
        .unwrap()
        .contains("UNUSED_SECRET"));
}

#[tokio::test]
async fn udp_control_eof_and_unexpected_data_are_distinguished() {
    for send_byte in [false, true] {
        let fixture = Fixture::new();
        let trace = fixture.trace();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let relay = UdpSocket::bind("127.0.0.1:0").await.unwrap();
            let bound = relay.local_addr().unwrap();
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut hello = [0; 3];
            stream.read_exact(&mut hello).await.unwrap();
            stream.write_all(&[5, 0]).await.unwrap();
            let mut header = [0; 4];
            stream.read_exact(&mut header).await.unwrap();
            let _ = transport::read_address(&mut stream, header[3])
                .await
                .unwrap();
            let mut reply = vec![5, 0, 0];
            transport::encode_destination(
                &Destination::new("127.0.0.1", bound.port()).unwrap(),
                &mut reply,
            );
            stream.write_all(&reply).await.unwrap();
            if send_byte {
                stream.write_all(&[7]).await.unwrap();
            }
        });
        let mut channel = Channel::open_traced(
            Some(&endpoint(port)),
            &Destination::new("192.0.2.1", 443).unwrap(),
            &[],
            trace,
        )
        .await
        .unwrap();
        server.await.unwrap();
        assert!(channel.receive(&mut [0; 4096]).await.is_err());
        drop(channel);
        let rows = fixture.rows();
        let reason = if send_byte { "unexpected_data" } else { "eof" };
        assert!(rows
            .iter()
            .any(|row| row["event"] == "udp.control_ended"
                && row["details"]["data"]["reason"] == reason));
    }
}

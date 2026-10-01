//! Explicit admin-only integration; the filter contains only lab-owned ports.
use super::*;
use std::io::{BufRead, Write};
#[test]
fn driver_child() {
    let Ok(destination) = std::env::var("PROCWEAVER_CAPTURE_LAB_DEST") else {
        return;
    };
    let pool = tokio::runtime::Runtime::new().unwrap();
    pool.block_on(async {
        let tcp = tokio::net::TcpSocket::new_v4().unwrap();
        tcp.bind("127.0.0.1:0".parse().unwrap()).unwrap();
        let udp = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let dns = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        println!(
            "PWPORTS {},{},{}",
            tcp.local_addr().unwrap().port(),
            udp.local_addr().unwrap().port(),
            dns.local_addr().unwrap().port()
        );
        std::io::stdout().flush().unwrap();
        let mut line = String::new();
        std::io::stdin().read_line(&mut line).unwrap();
        assert_eq!(line.trim(), "start");
        tokio::time::timeout(Duration::from_secs(12), async {
            let mut tcp = tcp.connect(destination.parse().unwrap()).await.unwrap();
            tcp.write_all(b"driver-tcp").await.unwrap();
            let mut echo = [0; 10];
            tcp.read_exact(&mut echo).await.unwrap();
            assert_eq!(&echo, b"driver-tcp");
            drop(tcp);
            udp.connect("127.0.0.1:123").await.unwrap();
            udp.send(b"driver-udp").await.unwrap();
            let mut data = [0; 256];
            let n = udp.recv(&mut data).await.unwrap();
            assert_eq!(&data[..n], b"driver-udp");
            dns.connect("127.0.0.1:53").await.unwrap();
            dns.send(&query()).await.unwrap();
            let n = dns.recv(&mut data).await.unwrap();
            assert!(n >= 12);
            assert_eq!(data[3] & 15, 4);
        })
        .await
        .unwrap();
    });
}
async fn proxy(mut stream: TcpStream) {
    let mut h = [0; 3];
    if stream.read_exact(&mut h).await.is_err() {
        return;
    }
    assert_eq!(h, [5, 1, 0]);
    stream.write_all(&[5, 0]).await.unwrap();
    let mut h = [0; 4];
    stream.read_exact(&mut h).await.unwrap();
    let _ = transport::read_address(&mut stream, h[3]).await.unwrap();
    if h[1] == 1 {
        stream
            .write_all(&[5, 0, 0, 1, 127, 0, 0, 1, 0, 0])
            .await
            .unwrap();
        let (mut read, mut write) = stream.split();
        let _ = tokio::io::copy(&mut read, &mut write).await;
        return;
    }
    assert_eq!(h[1], 3);
    let socket = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let mut response = vec![5, 0, 0, 1, 127, 0, 0, 1];
    response.extend(socket.local_addr().unwrap().port().to_be_bytes());
    stream.write_all(&response).await.unwrap();
    let mut buffer = vec![0; 65535];
    loop {
        tokio::select! {
            _=stream.read_u8()=>break,
            packet=socket.recv_from(&mut buffer)=>{let(n,from)=packet.unwrap();let(target,data)=crate::external_proxy::udp::decode(&buffer[..n]).unwrap();let reply=if target.port==53{dns::failure(data,4)}else{data.to_vec()};let encoded=crate::external_proxy::udp::encode(&target,&reply).unwrap();socket.send_to(&encoded,from).await.unwrap();}
        }
    }
}
struct ChildGuard(std::process::Child);
impl Drop for ChildGuard {
    fn drop(&mut self) {
        if self.0.try_wait().ok().flatten().is_none() {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}
#[test]
#[ignore = "administrator; real WinDivert limited to this test child's source ports"]
fn real_driver_without_mihomo_forwards_tcp_udp_dns() {
    use crate::capture::windivert::{ownership::Identity, runtime::Engine as Capture};
    use std::os::windows::process::CommandExt;
    assert!(crate::commands::system::check_is_admin());
    assert!(!crate::commands::process::ACTIVE.load(std::sync::atomic::Ordering::SeqCst));
    let pool = tokio::runtime::Runtime::new().unwrap();
    let listener = pool.block_on(TcpListener::bind("127.0.0.1:0")).unwrap();
    let f = Fixture::new(listener.local_addr().unwrap().port(), "socks5", false);
    let service=pool.spawn(async move{let mut jobs=tokio::task::JoinSet::new();loop{tokio::select!{Some(_)=jobs.join_next(),if !jobs.is_empty()=>{},incoming=listener.accept()=>{let Ok((s,_))=incoming else{break;};jobs.spawn(proxy(s));}}}});
    let blackhole = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let mut child = ChildGuard(
        std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "external_proxy::captured::tests::driver::driver_child",
                "--nocapture",
                "--test-threads=1",
            ])
            .env(
                "PROCWEAVER_CAPTURE_LAB_DEST",
                blackhole.local_addr().unwrap().to_string(),
            )
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .creation_flags(0x08000000)
            .spawn()
            .unwrap(),
    );
    let stdout = child.0.stdout.take().unwrap();
    let (send, receive) = std::sync::mpsc::channel();
    let output = std::thread::spawn(move || {
        for line in std::io::BufReader::new(stdout)
            .lines()
            .map_while(Result::ok)
        {
            if let Some((_, ports)) = line.split_once("PWPORTS ") {
                let _ = send.send(ports.to_string());
            }
        }
    });
    let ports = receive.recv_timeout(Duration::from_secs(10)).unwrap();
    let ports: Vec<u16> = ports.split(',').map(|p| p.parse().unwrap()).collect();
    assert_eq!(ports.len(), 3);
    *crate::external_proxy::ENGINE.lock().unwrap() = Some(f.context.runtime.clone());
    let filter=format!("outbound and ((tcp and (tcp.SrcPort == {} or tcp.SrcPort == {{relay4}} or tcp.SrcPort == {{relay6}})) or (udp and (udp.SrcPort == {} or udp.SrcPort == {})))",ports[0],ports[1],ports[2]);
    let directory = crate::capture::windivert::assets::prepare().unwrap();
    let engine = Capture::external_fixture(
        &directory,
        vec![Identity::inspect(std::process::id()).unwrap()],
        &filter,
    )
    .unwrap();
    child
        .0
        .stdin
        .as_mut()
        .unwrap()
        .write_all(b"start\n")
        .unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(18);
    let status = loop {
        if let Some(status) = child.0.try_wait().unwrap() {
            break Some(status);
        }
        if std::time::Instant::now() > deadline {
            break None;
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    let stats = engine.stats();
    drop(engine);
    *crate::external_proxy::ENGINE.lock().unwrap() = None;
    if status.is_none() {
        let _ = child.0.kill();
        let _ = child.0.wait();
    }
    let _ = output.join();
    let mut errors = String::new();
    if let Some(mut stderr) = child.0.stderr.take() {
        use std::io::Read;
        let _ = stderr.read_to_string(&mut errors);
    }
    service.abort();
    pool.shutdown_timeout(Duration::from_secs(1));
    assert!(
        status.is_some_and(|s| s.success()),
        "child failed: {errors}; stats={stats:?}"
    );
    assert_eq!(stats.tcp, 1);
    assert!(stats.udp >= 2);
    assert_eq!(stats.dns, 1);
    let records = f.context.runtime.records.lock().unwrap();
    assert!(records.len() >= 3);
    assert!(records.iter().all(|r| r.pid == child.0.id()));
    assert!(!crate::commands::process::ACTIVE.load(std::sync::atomic::Ordering::SeqCst));
}

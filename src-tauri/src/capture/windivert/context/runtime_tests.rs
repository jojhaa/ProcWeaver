//! Differential check against the bundled core, using only isolated loopback
//! fixtures. This is not WinDivert packet interception or application acceptance.
use super::*;
use std::{io::{Read, Write}, net::{TcpListener, TcpStream, UdpSocket}, os::windows::process::CommandExt, process::{Child, Command, Stdio}, time::{Duration, Instant}};

struct Core(Child, std::path::PathBuf);
impl Drop for Core {
    fn drop(&mut self) {
        let _ = self.0.kill(); let _ = self.0.wait();
        let _ = std::fs::remove_dir_all(&self.1);
    }
}

fn request(port: u16, domain: &str, target: u16) -> bool {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
    stream.set_write_timeout(Some(Duration::from_secs(3))).unwrap();
    stream.write_all(&[5, 1, 0]).unwrap();
    let mut hello = [0u8; 2]; stream.read_exact(&mut hello).unwrap();
    assert_eq!(hello, [5, 0]);
    let mut packet = vec![5, 1, 0, 3, domain.len() as u8];
    packet.extend_from_slice(domain.as_bytes()); packet.extend_from_slice(&target.to_be_bytes());
    stream.write_all(&packet).unwrap();
    let mut reply = [0u8; 4];
    if stream.read_exact(&mut reply).is_err() || reply[1] != 0 { return false; }
    let remaining = match reply[3] { 1 => 6, 4 => 18, _ => panic!("unexpected SOCKS address") };
    let mut address = vec![0u8; remaining]; stream.read_exact(&mut address).unwrap();
    let mut marker = [0u8; 3];
    stream.read_exact(&mut marker).is_ok() && marker == *b"PW!"
}

#[test]
fn real_core_original_process_and_specialized_context_make_same_decisions() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let target = listener.local_addr().unwrap().port();
    listener.set_nonblocking(true).unwrap();
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let stopping = stop.clone();
    let server = std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(20);
        while !stopping.load(std::sync::atomic::Ordering::Acquire) && Instant::now() < deadline {
            match listener.accept() {
                Ok((mut client, _)) => { let _ = client.write_all(b"PW!"); }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(5)),
                Err(_) => break,
            }
        }
    });
    let dns_socket = UdpSocket::bind("127.0.0.1:0").unwrap();
    let dns_target = dns_socket.local_addr().unwrap();
    dns_socket.set_read_timeout(Some(Duration::from_millis(100))).unwrap();
    let dns_stop = stop.clone();
    let dns_server = std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(20);
        let mut bytes = [0u8; 512];
        while !dns_stop.load(std::sync::atomic::Ordering::Acquire) && Instant::now() < deadline {
            if let Ok((length, peer)) = dns_socket.recv_from(&mut bytes) {
                if length >= 12 { bytes[2] |= 0x80; let _ = dns_socket.send_to(&bytes[..length], peer); }
            }
        }
    });
    // Mixed listeners need both transports; TCP port 0 may fall inside a Windows
    // UDP-excluded range and leave this fixture's core only partially listening.
    let reserved: Vec<_> = (0..3).map(|_| crate::storage::reserve_test_mixed_port()).collect();
    let ports: Vec<_> = reserved.iter().map(|s| s.local_addr().unwrap().port()).collect();
    let executable = std::env::current_exe().unwrap().to_string_lossy().to_string();
    let name = std::path::Path::new(&executable).file_name().unwrap().to_string_lossy();
    let mut yaml = serde_yaml::to_value(serde_json::json!({
        "mixed-port":ports[0],"allow-lan":false,"mode":"rule","find-process-mode":"always","log-level":"silent",
        "hosts":{"allowed.pw.invalid":"127.0.0.1","blocked.pw.invalid":"127.0.0.1"},
        "dns":{"enable":false,"use-system-hosts":false},"proxies":[],
        "rule-providers":{"blocked-domains":{"type":"inline","behavior":"domain","payload":["blocked.pw.invalid"]}},
        "rules":[format!("AND,(PROCESS-NAME,{name}),(NETWORK,UDP),DIRECT"),
            format!("AND,(AND,(DST-PORT,{target}),(NETWORK,TCP)),(NOT,((RULE-SET,blocked-domains))),(PROCESS-NAME,{name}),DIRECT"),
            format!("AND,((PROCESS-PATH,{executable}),(DOMAIN,blocked.pw.invalid)),REJECT"),"MATCH,REJECT"]
    })).unwrap();
    let contexts = compile(&yaml, &[
        ProcessContext { id:"original".into(), executable_path:executable },
        ProcessContext { id:"different".into(), executable_path:r"C:\Applications\different.exe".into() },
    ]).unwrap();
    yaml = attach(&yaml, &contexts, &ports[1..]).unwrap();
    let directory = std::env::temp_dir().join(format!("pw-wd-context-runtime-{}", std::process::id()));
    std::fs::create_dir_all(&directory).unwrap();
    std::fs::write(directory.join("config.yaml"), serde_yaml::to_string(&yaml).unwrap()).unwrap();
    drop(reserved);
    let child = Command::new(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries/mihomo-compatible.exe"))
        .arg("-d").arg(&directory).creation_flags(0x08000000).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
    let mut core = Core(child, directory);
    let deadline = Instant::now() + Duration::from_secs(5);
    while !ports.iter().all(|port| TcpStream::connect(("127.0.0.1", *port)).is_ok()) {
        assert!(core.0.try_wait().unwrap().is_none(), "isolated core exited");
        assert!(Instant::now() < deadline, "isolated core not ready");
        std::thread::sleep(Duration::from_millis(25));
    }
    for domain in ["allowed.pw.invalid", "blocked.pw.invalid"] {
        let original = request(ports[0], domain, target);
        let specialized = request(ports[1], domain, target);
        assert_eq!(original, domain == "allowed.pw.invalid", "original {domain}");
        assert_eq!(specialized, original, "specialized {domain}");
        assert!(!request(ports[2], domain, target), "different process must not inherit helper's identity");
    }
    let query = b"\x12\x34\x01\x00\x00\x01\x00\x00\x00\x00\x00\x00\x02pw\x07invalid\x00\x00\x01\x00\x01";
    let question = super::super::dns::Question::parse_query(query).unwrap();
    for port in &ports[..2] {
        let association = super::super::udp::Association::connect(*port, dns_target, Duration::from_secs(1)).unwrap();
        association.send(query).unwrap();
        let mut reply = Vec::new(); association.receive(&mut reply).unwrap();
        assert!(question.matches_reply(&reply));
    }
    let wrong_process = super::super::udp::Association::connect(ports[2], dns_target, Duration::from_millis(300)).unwrap();
    wrong_process.send(query).unwrap();
    assert!(wrong_process.receive(&mut Vec::new()).is_err(), "UDP must retain original process separation");
    stop.store(true, std::sync::atomic::Ordering::Release);
    server.join().unwrap();
    dns_server.join().unwrap();
}

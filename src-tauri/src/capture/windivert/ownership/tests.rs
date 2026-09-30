use super::*;
fn identity(pid: u32) -> Identity { Identity { pid, created_at:100, path:format!(r"C:\fixture\{pid}.exe") } }
fn event(endpoint: u64, pid: u32) -> Event { Event { kind:Kind::Bind, timestamp:10, endpoint, pid,
    local:"0.0.0.0:45678".parse().unwrap(), remote:"0.0.0.0:0".parse().unwrap(), protocol:17 } }
fn resolve(index: &Index) -> Option<Owner> { index.resolve("192.0.2.1:45678".parse().unwrap(), "192.0.2.53:53".parse().unwrap(), 17, 20, |pid| Some(identity(pid))) }
#[test]
fn udp_shared_socket_unverified_owner_and_pid_reuse_are_not_guessed() {
    let mut index = Index::default(); index.apply(event(1, 42), Some(identity(42))).unwrap();
    assert_eq!(resolve(&index).unwrap().identity.pid, 42);
    assert!(index.resolve("192.0.2.1:45678".parse().unwrap(), "192.0.2.53:53".parse().unwrap(), 17, 20,
        |pid| Some(Identity { created_at:101, ..identity(pid) })).is_none());
    index.apply(event(2, 43), None).unwrap(); assert!(resolve(&index).is_none());
    let mut closed = event(2, 43); closed.kind = Kind::Close; closed.timestamp = 11;
    index.apply(closed, None).unwrap(); assert!(resolve(&index).is_some());
    index.apply(event(2, 43), Some(identity(43))).unwrap(); // delayed BIND after CLOSE
    assert_eq!(index.len(), 1); assert!(!index.entries.contains_key(&2)); assert_eq!(resolve(&index).unwrap().endpoint, 1);
}
#[test]
fn tcp_requires_remote_and_newer_network_event_and_late_close_cannot_delete_reused_endpoint() {
    let mut index = Index::default(); let mut connected = event(1, 42);
    connected.kind = Kind::Connect; connected.protocol = 6; connected.remote = "192.0.2.5:443".parse().unwrap();
    index.apply(connected.clone(), Some(identity(42))).unwrap();
    let local = "192.0.2.1:45678".parse().unwrap();
    assert!(index.resolve(local, connected.remote, 6, 9, |p| Some(identity(p))).is_none());
    assert!(index.resolve(local, "192.0.2.6:443".parse().unwrap(), 6, 20, |p| Some(identity(p))).is_none());
    connected.pid = 43; connected.timestamp = 12;
    index.apply(connected.clone(), Some(identity(43))).unwrap();
    connected.pid = 42; connected.kind = Kind::Close; connected.timestamp = 11;
    index.apply(connected.clone(), None).unwrap();
    assert_eq!(index.resolve(local, connected.remote, 6, 20, |p| Some(identity(p))).unwrap().identity.pid, 43);
}
#[test]
fn overload_invalidates_index_instead_of_silently_evicting_a_shared_owner() {
    let mut index = Index::default();
    for endpoint in 1..=MAX_ENDPOINTS { let mut e = event(endpoint as u64, 42); e.local.set_port(endpoint as u16); index.apply(e, Some(identity(42))).unwrap(); }
    assert!(index.apply(event(MAX_ENDPOINTS as u64 + 1, 42), Some(identity(42))).is_err());
    assert_eq!(index.len(), MAX_ENDPOINTS); assert!(resolve(&index).is_none());
}
#[test]
fn decode_socket_host_order_and_reject_network_metadata() {
    let mut raw = Address::default(); raw.flags = 3 | (4 << 8) | (1 << 20); raw.timestamp = 10;
    let mut bytes = [0u8; 64]; bytes[..8].copy_from_slice(&1u64.to_ne_bytes()); bytes[16..20].copy_from_slice(&42u32.to_ne_bytes());
    bytes[20..24].copy_from_slice(&1u32.to_ne_bytes()); // ::1
    bytes[36..40].copy_from_slice(&0x100u32.to_ne_bytes()); bytes[48..52].copy_from_slice(&0x20010db8u32.to_ne_bytes());
    bytes[52..54].copy_from_slice(&45678u16.to_ne_bytes()); bytes[54..56].copy_from_slice(&53u16.to_ne_bytes()); bytes[56] = 17;
    for (word, v) in raw.data.iter_mut().zip(bytes.chunks_exact(8)) { *word = u64::from_ne_bytes(v.try_into().unwrap()); }
    let e = Event::decode(&raw).unwrap(); assert_eq!(e.local, "[::1]:45678".parse().unwrap()); assert_eq!(e.remote, "[2001:db8::100]:53".parse().unwrap());
    raw.flags = 0; assert!(Event::decode(&raw).is_none());
}

#[test]
#[ignore = "requires administrator; observes SOCKET events of this fixture PID only"]
fn real_driver_socket_events_attribute_tcp_udp_ipv4_ipv6() {
    use crate::capture::windivert::{lab::Capture, preflight::VerifiedApi};
    use std::{net::{TcpListener, TcpStream, UdpSocket}, sync::mpsc, thread, time::{Duration, Instant}};
    let loaded = VerifiedApi::load(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries/windivert")).unwrap();
    let pid = std::process::id(); let current = Identity::inspect(pid).unwrap();
    let device = loaded.api.open(&format!("processId == {pid} and (protocol == 6 or protocol == 17)"), 3, 1 | 4).unwrap();
    let worker_device = device.clone(); let (sender, receiver) = mpsc::sync_channel(64);
    let worker = thread::spawn(move || {
        let mut bytes = []; // SOCKET events have metadata, no packet payload.
        while let Ok((_, raw)) = worker_device.recv(&mut bytes) {
            if let Some(event) = Event::decode(&raw) { if sender.try_send(event).is_err() { return Err(std::io::Error::other("fixture socket event queue overflow")); } }
        }
        Ok(())
    });
    let mut capture = Capture::new(device, worker);
    let mut tcp = Vec::new(); let mut udp = Vec::new(); let mut flows = Vec::new();
    for ip in [IpAddr::V4(Ipv4Addr::LOCALHOST), IpAddr::V6(Ipv6Addr::LOCALHOST)] {
        let server = TcpListener::bind((ip, 0)).unwrap();
        let client = TcpStream::connect(server.local_addr().unwrap()).unwrap();
        flows.push((client.local_addr().unwrap(), client.peer_addr().unwrap(), 6));
        tcp.push(client); tcp.push(server.accept().unwrap().0);
        let target = UdpSocket::bind((ip, 0)).unwrap();
        let client = UdpSocket::bind((ip, 0)).unwrap(); client.connect(target.local_addr().unwrap()).unwrap();
        client.send(b"socket attribution").unwrap();
        flows.push((client.local_addr().unwrap(), client.peer_addr().unwrap(), 17));
        udp.push(client); udp.push(target);
    }
    let mut index = Index::default(); let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let found = flows.iter().all(|(local, remote, protocol)| index.resolve(*local, *remote, *protocol, i64::MAX, Identity::inspect)
            .is_some_and(|owner| owner.identity == current));
        if found { break; }
        assert!(Instant::now() < deadline, "socket attribution incomplete: {flows:?}; {} endpoints", index.len());
        if let Ok(event) = receiver.recv_timeout(Duration::from_millis(100)) {
            let identity = Identity::inspect(event.pid); index.apply(event, identity).unwrap();
        }
    }
    capture.stop().unwrap();
}

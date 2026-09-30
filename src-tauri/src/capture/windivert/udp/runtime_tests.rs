use super::*;
use std::{io::{Read, Write}, net::TcpListener, sync::mpsc, thread, time::Instant};

fn accept(listener: &TcpListener) -> TcpStream {
    listener.set_nonblocking(true).unwrap(); let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        match listener.accept() {
            Ok((stream, _)) => { stream.set_nonblocking(false).unwrap(); stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap(); stream.set_write_timeout(Some(Duration::from_secs(2))).unwrap(); return stream; }
            Err(e) if e.kind() == io::ErrorKind::WouldBlock && Instant::now() < deadline => thread::sleep(Duration::from_millis(5)),
            result => panic!("fixture accept: {result:?}"),
        }
    }
}
fn associate(stream: &mut TcpStream, relay: SocketAddr) {
    let mut hello = [0; 3]; stream.read_exact(&mut hello).unwrap(); assert_eq!(hello, [5, 1, 0]);
    stream.write_all(&[5, 0]).unwrap(); let mut request = [0; 10]; stream.read_exact(&mut request).unwrap(); assert_eq!(&request[..4], &[5, 3, 0, 1]);
    let mut reply = vec![5, 0, 0]; super::super::socks::encode(relay, &mut reply); stream.write_all(&reply).unwrap();
}
#[test]
fn two_associations_reject_crossed_relay_packets_even_with_identical_dns_id() {
    let listeners: Vec<_> = (0..2).map(|_| TcpListener::bind("127.0.0.1:0").unwrap()).collect();
    let ports: Vec<_> = listeners.iter().map(|v| v.local_addr().unwrap().port()).collect();
    let destination: SocketAddr = "192.0.2.53:53".parse().unwrap();
    let worker = thread::spawn(move || {
        let mut controls = Vec::new(); let mut relays = Vec::new(); let mut peers = Vec::new();
        for listener in listeners {
            let relay = UdpSocket::bind("127.0.0.1:0").unwrap(); relay.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
            let mut control = accept(&listener); associate(&mut control, relay.local_addr().unwrap());
            let mut bytes = [0; 512]; let (n, peer) = relay.recv_from(&mut bytes).unwrap();
            assert_eq!(decode(&bytes[..n], destination).unwrap(), b"\x12\x34same-query");
            controls.push(control); relays.push(relay); peers.push(peer);
        }
        // Wrong relay's datagram must never surface on the connected socket.
        for i in 0..2 { relays[1 - i].send_to(&encode(destination, b"\x12\x34wrong-context").unwrap(), peers[i]).unwrap(); }
        thread::sleep(Duration::from_millis(30));
        for i in 0..2 { relays[i].send_to(&encode(destination, &[0x12, 0x34, i as u8]).unwrap(), peers[i]).unwrap(); }
    });
    let a = Association::connect(ports[0], destination, Duration::from_secs(2)).unwrap(); a.send(b"\x12\x34same-query").unwrap();
    let b = Association::connect(ports[1], destination, Duration::from_secs(2)).unwrap(); b.send(b"\x12\x34same-query").unwrap();
    let mut response = Vec::new();
    a.receive(&mut response).unwrap(); assert_eq!(response, [0x12, 0x34, 0]);
    b.receive(&mut response).unwrap(); assert_eq!(response, [0x12, 0x34, 1]);
    worker.join().unwrap();
}
#[test]
fn caller_deadline_bounds_socks_handshake_and_drop_closes_control() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap(); let port = listener.local_addr().unwrap().port();
    let worker = thread::spawn(move || { let _stream = accept(&listener); thread::sleep(Duration::from_millis(500)); });
    let started = Instant::now();
    assert!(Association::connect(port, "192.0.2.53:53".parse().unwrap(), Duration::from_millis(100)).is_err());
    assert!(started.elapsed() < Duration::from_millis(450), "ignored caller's handshake deadline"); worker.join().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap(); let port = listener.local_addr().unwrap().port();
    let (sender, receiver) = mpsc::channel();
    let worker = thread::spawn(move || {
        let relay = UdpSocket::bind("127.0.0.1:0").unwrap(); let mut control = accept(&listener);
        associate(&mut control, relay.local_addr().unwrap());
        sender.send(control.read(&mut [0; 1]).unwrap()).unwrap();
    });
    let association = Association::connect(port, "192.0.2.53:53".parse().unwrap(), Duration::from_secs(1)).unwrap();
    drop(association); assert_eq!(receiver.recv_timeout(Duration::from_secs(2)).unwrap(), 0); worker.join().unwrap();
}
#[test]
fn rejected_udp_association_never_sends_a_direct_datagram() {
    let target = UdpSocket::bind("127.0.0.1:0").unwrap(); target.set_read_timeout(Some(Duration::from_millis(150))).unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap(); let port = listener.local_addr().unwrap().port();
    let worker = thread::spawn(move || {
        let mut control = accept(&listener); let mut hello = [0; 3]; control.read_exact(&mut hello).unwrap();
        control.write_all(&[5, 0]).unwrap(); let mut request = [0; 10]; control.read_exact(&mut request).unwrap();
        control.write_all(&[5, 7, 0, 1]).unwrap();
    });
    assert!(Association::connect(port, target.local_addr().unwrap(), Duration::from_secs(1)).is_err());
    assert!(target.recv_from(&mut [0; 256]).is_err()); worker.join().unwrap();
}

#[test]
fn ipv6_unspecified_relay_keeps_its_address_family() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap(); let port = listener.local_addr().unwrap().port();
    let destination: SocketAddr = "[2001:db8::53]:53".parse().unwrap();
    let worker = thread::spawn(move || {
        let relay = UdpSocket::bind("[::1]:0").unwrap(); relay.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        let mut control = accept(&listener);
        associate(&mut control, SocketAddr::new(Ipv6Addr::UNSPECIFIED.into(), relay.local_addr().unwrap().port()));
        let mut bytes = [0; 512]; let (n, peer) = relay.recv_from(&mut bytes).unwrap();
        assert!(peer.is_ipv6()); assert_eq!(decode(&bytes[..n], destination).unwrap(), b"IPv6");
        relay.send_to(&bytes[..n], peer).unwrap();
    });
    let association = Association::connect(port, destination, Duration::from_secs(1)).unwrap();
    association.send(b"IPv6").unwrap(); let mut response = Vec::new(); association.receive(&mut response).unwrap();
    assert_eq!(response, b"IPv6"); worker.join().unwrap();
}

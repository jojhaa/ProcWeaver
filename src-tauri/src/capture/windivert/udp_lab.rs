//! Native P0 UDP/DNS experiment; only one reserved loopback tuple is diverted.
use super::{dns::Question, lab::Capture, packet::Packet, preflight::VerifiedApi, udp::Association};
use std::{io::{self, Read, Write}, net::{IpAddr, Ipv4Addr, Ipv6Addr, TcpListener, TcpStream, UdpSocket}, thread, time::{Duration, Instant}};

fn accept(listener: TcpListener) -> io::Result<TcpStream> {
    listener.set_nonblocking(true)?;
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match listener.accept() {
            Ok((stream, _)) => { stream.set_nonblocking(false)?; stream.set_read_timeout(Some(Duration::from_secs(3)))?; stream.set_write_timeout(Some(Duration::from_secs(3)))?; return Ok(stream); }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock && Instant::now() < deadline => thread::sleep(Duration::from_millis(5)),
            Err(error) => return Err(error),
        }
    }
}

fn transfer(ip: IpAddr, payload: &[u8]) -> Result<(), String> {
    let target = UdpSocket::bind((ip, 0)).map_err(|e| e.to_string())?;
    target.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
    let original = target.local_addr().unwrap();
    let application = UdpSocket::bind((ip, 0)).map_err(|e| e.to_string())?;
    application.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    application.connect(original).unwrap();
    let source = application.local_addr().unwrap();
    let socks_listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let socks_port = socks_listener.local_addr().unwrap().port();
    let socks_udp = UdpSocket::bind("127.0.0.1:0").unwrap();
    socks_udp.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
    let socks_udp_port = socks_udp.local_addr().unwrap().port();
    let target_worker = thread::spawn(move || -> io::Result<()> {
        let mut bytes = vec![0; 65535];
        let (length, client) = target.recv_from(&mut bytes)?;
        // Unknown/compressed DNS and non-DNS payloads still travel as UDP.
        if Question::parse_query(&bytes[..length]).is_some() { bytes[2] |= 0x80; }
        target.send_to(&bytes[..length], client)?;
        Ok(())
    });
    let proxy_worker = thread::spawn(move || -> io::Result<()> {
        let mut control = accept(socks_listener)?;
        let mut hello = [0; 3]; control.read_exact(&mut hello)?;
        if hello != [5, 1, 0] { return Err(io::Error::other("invalid SOCKS greeting")); }
        control.write_all(&[5, 0])?;
        let mut request = [0; 10]; control.read_exact(&mut request)?;
        if request[..4] != [5, 3, 0, 1] { return Err(io::Error::other("UDP ASSOCIATE was not used")); }
        let mut reply = vec![5, 0, 0, 1, 127, 0, 0, 1]; reply.extend_from_slice(&socks_udp_port.to_be_bytes());
        control.write_all(&reply)?;
        let mut frame = vec![0; 65535];
        let (length, relay) = socks_udp.recv_from(&mut frame)?;
        let query = super::udp::decode(&frame[..length], original)?;
        let outgoing = UdpSocket::bind((ip, 0))?;
        outgoing.set_read_timeout(Some(Duration::from_secs(3)))?;
        outgoing.connect(original)?; outgoing.send(query)?;
        let mut response = vec![0; 65535]; let length = outgoing.recv(&mut response)?;
        socks_udp.send_to(&super::udp::encode(original, &response[..length])?, relay)?;
        Ok(())
    });
    let loaded = VerifiedApi::load(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries/windivert"))?;
    let family = if ip.is_ipv4() { "ip" } else { "ipv6" };
    let filter = format!("outbound and loopback and udp and {family}.SrcAddr == {ip} and {family}.DstAddr == {ip} and udp.SrcPort == {} and udp.DstPort == {}", source.port(), original.port());
    let device = loaded.api.open(&filter, 0, 0)?;
    let worker_device = device.clone();
    let capture_worker = thread::spawn(move || -> io::Result<()> {
        let mut bytes = vec![0; 65575];
        let (length, mut address) = worker_device.recv(&mut bytes)?;
        let bytes = &bytes[..length];
        let packet = Packet::parse(bytes).ok_or_else(|| io::Error::other("UDP packet parsing failed"))?;
        if packet.flow.source != source || packet.flow.destination != original || packet.flow.protocol != 17
            || super::owner::lookup(packet.flow) != Some(std::process::id()) {
            return Err(io::Error::other("UDP fixture attribution mismatch"));
        }
        let query = &bytes[packet.payload..];
        let question = Question::parse_query(query);
        let association = Association::connect(socks_port, original, Duration::from_secs(3))?;
        association.send(query)?;
        let mut response = Vec::new(); association.receive(&mut response)?;
        if question.is_some_and(|question| !question.matches_reply(&response)) { return Err(io::Error::other("DNS answer identity mismatch")); }
        let mut reply = packet.udp_reply(bytes, &response).ok_or_else(|| io::Error::other("UDP reply cannot be encoded"))?;
        // Loopback is always outbound in WinDivert. The narrow filter does not
        // recapture this reversed reply tuple or the relay's own UDP socket.
        worker_device.send(&mut reply, &mut address, true)?;
        Ok(())
    });
    let mut capture = Capture::new(device, capture_worker);
    application.send(payload).map_err(|e| e.to_string())?;
    let mut expected = payload.to_vec();
    if Question::parse_query(payload).is_some() { expected[2] |= 0x80; }
    let mut reply = vec![0; 65535];
    let result = application.recv(&mut reply).map_err(|e| e.to_string())
        .and_then(|length| (reply[..length] == expected).then_some(()).ok_or("application UDP payload changed".into()));
    let captured = capture.stop().map_err(|e| e.to_string());
    let proxy = proxy_worker.join().map_err(|_| "SOCKS fixture panicked")?.map_err(|e| e.to_string());
    let target = target_worker.join().map_err(|_| "DNS fixture panicked")?.map_err(|e| e.to_string());
    if result.is_err() || captured.is_err() || proxy.is_err() || target.is_err() {
        return Err(format!("application={result:?}; capture={captured:?}; proxy={proxy:?}; dns={target:?}"));
    }
    Ok(())
}

#[test]
#[ignore = "requires administrator; one reserved UDP loopback tuple only; explicitly invoke"]
fn real_driver_udp_dns_ipv4_ipv6_preserves_question_and_source() {
    let dns = b"\x12\x34\x01\x00\x00\x01\x00\x00\x00\x00\x00\x00\x02pw\x07invalid\x00\x00\x01\x00\x01";
    let opaque_dns = b"\x12\x34\x01\x00\x00\x01\x00\x00\x00\x00\x00\x00\xc0\x0c\x00\x01\x00\x01";
    let large = vec![0x5a; 60000];
    for ip in [IpAddr::V4(Ipv4Addr::LOCALHOST), IpAddr::V6(Ipv6Addr::LOCALHOST)] {
        for payload in [dns.as_slice(), opaque_dns.as_slice(), b"opaque UDP", large.as_slice()] {
            transfer(ip, payload).unwrap_or_else(|error| panic!("{ip}, {} bytes: {error}", payload.len()));
        }
    }
}

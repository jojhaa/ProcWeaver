//! Explicitly invoked P0 experiment. The driver filter includes only the exact
//! reserved loopback client tuple and relay return tuple, never user traffic.
use super::{lab::Capture, packet::Packet, preflight::VerifiedApi, socks};
use std::{io::{self, Read, Write}, net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpListener, TcpStream}, sync::{atomic::{AtomicUsize, Ordering}, Arc}, thread, time::{Duration, Instant}};

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

async fn transfer(ip: IpAddr) -> Result<(), String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let echo = TcpListener::bind((ip, 0)).map_err(|e| e.to_string())?;
    let original = echo.local_addr().unwrap();
    let relay = TcpListener::bind((ip, 0)).map_err(|e| e.to_string())?;
    let redirected = relay.local_addr().unwrap();
    let socks_listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).map_err(|e| e.to_string())?;
    let socks_port = socks_listener.local_addr().unwrap().port();
    let application = if ip.is_ipv4() { tokio::net::TcpSocket::new_v4() } else { tokio::net::TcpSocket::new_v6() }.map_err(|e| e.to_string())?;
    application.bind(SocketAddr::new(ip, 0)).map_err(|e| e.to_string())?;
    let source = application.local_addr().unwrap();
    let component_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries/windivert");
    let loaded = VerifiedApi::load(&component_dir)?;
    let family = if ip.is_ipv4() { "ip" } else { "ipv6" };
    let filter = format!("outbound and loopback and tcp and {family}.SrcAddr == {ip} and {family}.DstAddr == {ip} and ((tcp.SrcPort == {} and tcp.DstPort == {}) or (tcp.SrcPort == {} and tcp.DstPort == {}))", source.port(), original.port(), redirected.port(), source.port());
    let device = loaded.api.open(&filter, 0, 0)?;
    let packets = Arc::new(AtomicUsize::new(0));
    let classified = Arc::new(AtomicUsize::new(0));
    let received = packets.clone(); let owners = classified.clone(); let worker_device = device.clone();
    let worker = thread::spawn(move || {
        let mut bytes = vec![0u8; 65575];
        loop {
            let (length, mut address) = match worker_device.recv(&mut bytes) {
                Ok(value) => value,
                Err(error) if error.raw_os_error() == Some(232) => return Ok(()), // ERROR_NO_DATA after drain
                Err(error) => return Err(error),
            };
            let bytes = &mut bytes[..length];
            let packet = Packet::parse(bytes).ok_or_else(|| io::Error::other("unexpected packet in scoped fixture filter"))?;
            received.fetch_add(1, Ordering::Relaxed);
            if packet.flow.source == source && packet.flow.destination == original {
                if packet.syn {
                    if super::owner::lookup(packet.flow) != Some(std::process::id()) {
                        // Attribution failure is visible; no unrelated destination
                        // or different process is redirected by this test.
                        worker_device.send(bytes, &mut address, false)?;
                        continue;
                    }
                    owners.fetch_add(1, Ordering::Relaxed);
                }
                packet.rewrite(bytes, source, redirected);
            } else if packet.flow.source == redirected && packet.flow.destination == source {
                packet.rewrite(bytes, original, source);
            } else { return Err(io::Error::other("filter tuple mismatch")); }
            worker_device.send(bytes, &mut address, true)?;
        }
    });
    let mut capture = Capture::new(device, worker);

    let payload: Vec<u8> = (0..65536).map(|index| (index % 251) as u8).collect();
    let target_payload = payload.clone();
    let echo_worker = thread::spawn(move || -> io::Result<()> {
        let mut client = accept(echo)?;
        let mut bytes = vec![0; target_payload.len()]; client.read_exact(&mut bytes)?;
        if bytes != target_payload { return Err(io::Error::other("target data changed")); }
        client.write_all(&bytes)
    });
    let proxy_worker = thread::spawn(move || -> io::Result<()> {
        let mut client = accept(socks_listener)?;
        let mut hello = [0; 3]; client.read_exact(&mut hello)?;
        if hello != [5, 1, 0] { return Err(io::Error::other("invalid SOCKS greeting")); }
        client.write_all(&[5, 0])?;
        let mut header = [0; 4]; client.read_exact(&mut header)?;
        let length = match header { [5, 1, 0, 1] => 6, [5, 1, 0, 4] => 18, _ => return Err(io::Error::other("invalid SOCKS request")) };
        let mut encoded = vec![header[3]]; encoded.resize(length + 1, 0); client.read_exact(&mut encoded[1..])?;
        if socks::decode(&encoded).map(|v| v.0) != Some(original) { return Err(io::Error::other("original destination lost")); }
        let mut target = TcpStream::connect_timeout(&original, Duration::from_secs(3))?;
        target.set_read_timeout(Some(Duration::from_secs(3)))?; target.set_write_timeout(Some(Duration::from_secs(3)))?;
        client.write_all(&[5, 0, 0, 1, 127, 0, 0, 1, 0, 0])?;
        let mut bytes = vec![0; 65536]; client.read_exact(&mut bytes)?; target.write_all(&bytes)?;
        target.read_exact(&mut bytes)?; client.write_all(&bytes)
    });
    let relay_worker = thread::spawn(move || -> io::Result<()> {
        let mut client = accept(relay)?;
        let (mut upstream, _) = socks::connect(socks_port, original, false)?;
        let mut bytes = vec![0; 65536]; client.read_exact(&mut bytes)?; upstream.write_all(&bytes)?;
        upstream.read_exact(&mut bytes)?; client.write_all(&bytes)
    });
    let result = tokio::time::timeout(Duration::from_secs(5), async {
        let mut client = application.connect(original).await?;
        client.write_all(&payload).await?;
        let mut received = vec![0; payload.len()]; client.read_exact(&mut received).await?;
        if received != payload { return Err(io::Error::other("application data changed")); }
        Ok::<_, io::Error>(())
    }).await.map_err(|_| "transparent fixture timed out".to_string()).and_then(|r| r.map_err(|e| e.to_string()));
    let stop_result = capture.stop().map_err(|e| e.to_string());
    let workers = [echo_worker, proxy_worker, relay_worker].into_iter().map(|worker| worker.join()
        .map_err(|_| "fixture worker panicked".to_string()).and_then(|r| r.map_err(|e| e.to_string()))).collect::<Vec<_>>();
    if let Err(error) = result { return Err(format!("application={error}; capture={stop_result:?}; workers={workers:?}; packets={}; attributed={}", packets.load(Ordering::Relaxed), classified.load(Ordering::Relaxed))); }
    stop_result?;
    for worker in workers { worker?; }
    if classified.load(Ordering::Relaxed) == 0 || packets.load(Ordering::Relaxed) < 3 { return Err("no verified capture/attribution evidence".into()); }
    Ok(())
}

#[tokio::test]
#[ignore = "requires administrator; exact loopback fixture filter only; explicitly invoke"]
async fn real_driver_tcp_ipv4_ipv6_preserves_original_socks_destination_and_bytes() {
    for ip in [IpAddr::V4(Ipv4Addr::LOCALHOST), IpAddr::V6(Ipv6Addr::LOCALHOST)] {
        transfer(ip).await.unwrap_or_else(|error| panic!("{ip}: {error}"));
    }
}

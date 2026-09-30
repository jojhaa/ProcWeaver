use super::*;
use crate::capture::windivert::plan::Entry;

async fn mock_socks(mut stream: TcpStream, counter: Arc<AtomicU64>) -> std::io::Result<()> {
    let mut greeting = [0; 3];
    stream.read_exact(&mut greeting).await?;
    assert_eq!(greeting, [5, 1, 0]);
    stream.write_all(&[5, 0]).await?;
    let mut header = [0; 4];
    stream.read_exact(&mut header).await?;
    let length = if header[3] == 1 { 6 } else { 18 };
    let mut endpoint = vec![header[3]];
    endpoint.resize(length + 1, 0);
    stream.read_exact(&mut endpoint[1..]).await?;
    let (destination, _) = crate::capture::windivert::socks::decode(&endpoint).unwrap();
    if header[1] == 1 {
        assert!(
            destination.ip().is_loopback()
                || destination.ip() == "192.0.2.123".parse::<IpAddr>().unwrap()
        );
        counter.fetch_add(1, Ordering::Relaxed);
        stream.write_all(&[5, 0, 0, 1, 127, 0, 0, 1, 0, 0]).await?;
        let (mut read, mut write) = stream.into_split();
        tokio::io::copy(&mut read, &mut write).await?;
    } else {
        assert_eq!(header[1], 3);
        let socket = UdpSocket::bind("127.0.0.1:0").await?;
        let mut reply = vec![5, 0, 0];
        crate::capture::windivert::socks::encode(socket.local_addr()?, &mut reply);
        stream.write_all(&reply).await?;
        let mut data = vec![0; 65535];
        let mut closed = [0];
        loop {
            tokio::select! {
                packet=socket.recv_from(&mut data)=>{let(n,peer)=packet?;counter.fetch_add(1,Ordering::Relaxed);socket.send_to(&data[..n],peer).await?;},
                _=stream.read(&mut closed)=>return Ok(())
            }
        }
    }
    Ok(())
}

#[test]
#[ignore = "administrator; captures only exact owned fixture tuples"]
fn real_runtime_tcp_udp_dns_and_stop_use_owned_flows_only() {
    let route = std::net::UdpSocket::bind("0.0.0.0:0").unwrap();
    route.connect("192.0.2.123:53").unwrap();
    let local = route.local_addr().unwrap().ip();
    drop(route);
    for ip in [
        IpAddr::V4(Ipv4Addr::LOCALHOST),
        IpAddr::V6(Ipv6Addr::LOCALHOST),
        local,
    ] {
        let pool = tokio::runtime::Runtime::new().unwrap();
        let listener = (61000..65000)
            .find_map(|port| std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, port)).ok())
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        listener.set_nonblocking(true).unwrap();
        let count = Arc::new(AtomicU64::new(0));
        {
            let _guard = pool.enter();
            let listener = TcpListener::from_std(listener).unwrap();
            let count = count.clone();
            pool.spawn(async move {
                while let Ok((stream, _)) = listener.accept().await {
                    let count = count.clone();
                    tokio::spawn(async move {
                        let _ = mock_socks(stream, count).await;
                    });
                }
            });
        }
        let client = pool.block_on(async {
            let client = if ip.is_ipv4() {
                tokio::net::TcpSocket::new_v4().unwrap()
            } else {
                tokio::net::TcpSocket::new_v6().unwrap()
            };
            client.bind(SocketAddr::new(ip, 0)).unwrap();
            client
        });
        let tcp_port = client.local_addr().unwrap().port();
        let udp = pool
            .block_on(UdpSocket::bind(SocketAddr::new(ip, 0)))
            .unwrap();
        let udp_port = udp.local_addr().unwrap().port();
        // The original TCP endpoint never echoes. A bypass cannot satisfy the test.
        let original = std::net::TcpListener::bind(SocketAddr::new(ip, 0)).unwrap();
        let destination = if ip.is_loopback() {
            original.local_addr().unwrap()
        } else {
            "192.0.2.123:443".parse().unwrap()
        };
        let own = Identity::inspect(std::process::id()).unwrap();
        let entry = Entry {
            owner: String::new(),
            kind: "path".into(),
            value: own.path,
            port,
        };
        let plan = Plan {
            entries: vec![entry.clone()],
            targets: vec![entry],
            instances: vec![],
        };
        let filter=format!("outbound and ((tcp and (tcp.SrcPort == {tcp_port} or tcp.SrcPort == {{relay4}} or tcp.SrcPort == {{relay6}})) or (udp and udp.SrcPort == {udp_port}))");
        let engine = Engine::start_inner(
            plan,
            &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries/windivert"),
            vec![],
            Some(&filter),
        )
        .unwrap();
        let result=pool.block_on(async{tokio::time::timeout(Duration::from_secs(12),async{
            let mut tcp=client.connect(destination).await?;let message=vec![0x5a;65536];tcp.write_all(&message).await?;let mut reply=vec![0;message.len()];tcp.read_exact(&mut reply).await?;assert_eq!(reply,message);drop(tcp);
            udp.connect(SocketAddr::new(destination.ip(),53)).await?;
            let query=b"\x12\x34\x01\x00\x00\x01\x00\x00\x00\x00\x00\x00\x02pw\x07invalid\x00\x00\x01\x00\x01";
            udp.send(query).await?;let mut response=[0;128];let n=udp.recv(&mut response).await?;assert_eq!(&response[..n],query);
            Ok::<(),std::io::Error>(())
        }).await});
        let stats = engine.stats();
        drop(engine);
        assert!(result.is_ok(), "{ip}: {result:?}, stats={stats:?}");
        assert!(result.unwrap().is_ok(), "stats={stats:?}");
        assert_eq!(stats.tcp, 1);
        assert_eq!(stats.dns, 1);
        assert!(count.load(Ordering::Relaxed) >= 2);
        drop(udp);
        pool.shutdown_timeout(Duration::from_secs(1));
    }
}

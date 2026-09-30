use std::{
    io::{self, Read, Write},
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpStream},
    time::{Duration, Instant},
};
pub fn encode(address: SocketAddr, out: &mut Vec<u8>) {
    match address.ip() {
        IpAddr::V4(v) => {
            out.push(1);
            out.extend(v.octets());
        }
        IpAddr::V6(v) => {
            out.push(4);
            out.extend(v.octets());
        }
    }
    out.extend(address.port().to_be_bytes());
}
pub fn decode(input: &[u8]) -> Option<(SocketAddr, usize)> {
    let (ip, n): (IpAddr, usize) = match *input.first()? {
        1 => (
            Ipv4Addr::from(<[u8; 4]>::try_from(input.get(1..5)?).ok()?).into(),
            5,
        ),
        4 => (
            Ipv6Addr::from(<[u8; 16]>::try_from(input.get(1..17)?).ok()?).into(),
            17,
        ),
        _ => return None,
    };
    Some((
        SocketAddr::new(ip, u16::from_be_bytes([*input.get(n)?, *input.get(n + 1)?])),
        n + 2,
    ))
}
pub fn connect(
    port: u16,
    destination: SocketAddr,
    udp: bool,
) -> io::Result<(TcpStream, SocketAddr)> {
    connect_with_timeout(port, destination, udp, Duration::from_secs(8))
}
pub fn connect_with_timeout(port: u16, destination: SocketAddr, udp: bool, timeout: Duration) -> io::Result<(TcpStream, SocketAddr)> {
    if port == 0 || timeout.is_zero() || timeout > Duration::from_secs(30) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "SOCKS 入口或超时无效"));
    }
    let deadline = Instant::now() + timeout;
    let mut stream = TcpStream::connect_timeout(
        &SocketAddr::from(([127, 0, 0, 1], port)),
        timeout.min(Duration::from_secs(3)),
    )?;
    write_until(&mut stream, &[5, 1, 0], deadline)?;
    let mut hello = [0; 2];
    read_until(&mut stream, &mut hello, deadline)?;
    if hello != [5, 0] {
        return Err(io::Error::other("本地 SOCKS 握手失败"));
    }
    let mut request = vec![5, if udp { 3 } else { 1 }, 0];
    encode(destination, &mut request);
    write_until(&mut stream, &request, deadline)?;
    let mut head = [0; 4];
    read_until(&mut stream, &mut head, deadline)?;
    if head[0] != 5 || head[1] != 0 || head[2] != 0 {
        return Err(io::Error::other("所选出口拒绝连接"));
    }
    let n = match head[3] {
        1 => 6,
        4 => 18,
        _ => return Err(io::Error::other("本地 SOCKS 地址类型无效")),
    };
    let mut address = vec![head[3]];
    address.resize(n + 1, 0);
    read_until(&mut stream, &mut address[1..], deadline)?;
    let (mut address, _) =
        decode(&address).ok_or_else(|| io::Error::other("本地 SOCKS 地址无效"))?;
    if address.ip().is_unspecified() {
        address.set_ip(if address.is_ipv6() { Ipv6Addr::LOCALHOST.into() } else { Ipv4Addr::LOCALHOST.into() });
    }
    Ok((stream, address))
}

fn remaining(deadline: Instant) -> io::Result<Duration> {
    deadline.checked_duration_since(Instant::now()).filter(|v| !v.is_zero())
        .ok_or_else(|| io::Error::new(io::ErrorKind::TimedOut, "本地 SOCKS 握手超时"))
}
fn read_until(stream: &mut TcpStream, mut bytes: &mut [u8], deadline: Instant) -> io::Result<()> {
    while !bytes.is_empty() {
        stream.set_read_timeout(Some(remaining(deadline)?))?;
        match stream.read(bytes) {
            Ok(0) => return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "SOCKS 控制通道提前关闭")),
            Ok(n) => bytes = &mut bytes[n..],
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        }
    }
    Ok(())
}
fn write_until(stream: &mut TcpStream, mut bytes: &[u8], deadline: Instant) -> io::Result<()> {
    while !bytes.is_empty() {
        stream.set_write_timeout(Some(remaining(deadline)?))?;
        match stream.write(bytes) {
            Ok(0) => return Err(io::Error::new(io::ErrorKind::WriteZero, "SOCKS 控制通道未完整发送")),
            Ok(n) => bytes = &bytes[n..],
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

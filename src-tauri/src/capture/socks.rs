use std::{
    io::{self, Read, Write},
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpStream},
    time::Duration,
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
    let mut stream = TcpStream::connect_timeout(
        &SocketAddr::from(([127, 0, 0, 1], port)),
        Duration::from_secs(3),
    )?;
    stream.set_read_timeout(Some(Duration::from_secs(8)))?;
    stream.set_write_timeout(Some(Duration::from_secs(8)))?;
    stream.write_all(&[5, 1, 0])?;
    let mut hello = [0; 2];
    stream.read_exact(&mut hello)?;
    if hello != [5, 0] {
        return Err(io::Error::other("本地 SOCKS 握手失败"));
    }
    let mut request = vec![5, if udp { 3 } else { 1 }, 0];
    encode(destination, &mut request);
    stream.write_all(&request)?;
    let mut head = [0; 4];
    stream.read_exact(&mut head)?;
    if head[0] != 5 || head[1] != 0 {
        return Err(io::Error::other("所选出口拒绝连接"));
    }
    let n = match head[3] {
        1 => 6,
        4 => 18,
        _ => return Err(io::Error::other("本地 SOCKS 地址类型无效")),
    };
    let mut address = vec![head[3]];
    address.resize(n + 1, 0);
    stream.read_exact(&mut address[1..])?;
    let (mut address, _) =
        decode(&address).ok_or_else(|| io::Error::other("本地 SOCKS 地址无效"))?;
    if address.ip().is_unspecified() {
        address.set_ip(Ipv4Addr::LOCALHOST.into());
    }
    Ok((stream, address))
}

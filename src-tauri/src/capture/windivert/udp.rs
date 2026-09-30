//! SOCKS5 UDP transport shared by capture workers. A failed association is an
//! error, never an instruction to send the original datagram directly.
use std::{io, net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpStream, UdpSocket}, time::Duration};

pub const MAX_PAYLOAD: usize = 65000;

pub fn encode(destination: SocketAddr, payload: &[u8]) -> io::Result<Vec<u8>> {
    if payload.len() > MAX_PAYLOAD { return Err(io::Error::new(io::ErrorKind::InvalidInput, "UDP 数据报超过接管上限")); }
    let mut frame = vec![0, 0, 0]; // RSV, FRAG=0; fragmented SOCKS UDP is unsupported.
    super::socks::encode(destination, &mut frame); frame.extend_from_slice(payload);
    Ok(frame)
}
pub fn decode(frame: &[u8], expected: SocketAddr) -> io::Result<&[u8]> {
    if frame.get(..3) != Some(&[0, 0, 0]) { return Err(io::Error::new(io::ErrorKind::InvalidData, "SOCKS UDP 保留位或分片无效")); }
    let (source, length) = super::socks::decode(&frame[3..]).ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "SOCKS UDP 地址无效"))?;
    if source != expected { return Err(io::Error::new(io::ErrorKind::InvalidData, "SOCKS UDP 回包目标与原连接不符")); }
    let payload = &frame[3 + length..];
    if payload.len() > MAX_PAYLOAD { return Err(io::Error::new(io::ErrorKind::InvalidData, "SOCKS UDP 回包过大")); }
    Ok(payload)
}

pub struct Association {
    // RFC 1928: closing the control connection ends the UDP association.
    _control: TcpStream,
    socket: UdpSocket,
    destination: SocketAddr,
}
impl Association {
    pub fn connect(context_port: u16, destination: SocketAddr, timeout: Duration) -> io::Result<Self> {
        if context_port == 0 || destination.port() == 0 || timeout.is_zero() || timeout > Duration::from_secs(30) {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "UDP 接管入口、目标或超时无效"));
        }
        // Inlet is always this instance's verified local Mihomo SOCKS listener.
        let (control, relay) = super::socks::connect_with_timeout(context_port, SocketAddr::from((Ipv4Addr::UNSPECIFIED, 0)), true, timeout)?;
        if !relay.ip().is_loopback() || relay.port() == 0 {
            return Err(io::Error::new(io::ErrorKind::PermissionDenied, "本地核心返回了非回环 UDP 入口"));
        }
        let bind = match relay.ip() { IpAddr::V4(_) => IpAddr::V4(Ipv4Addr::LOCALHOST), IpAddr::V6(_) => IpAddr::V6(Ipv6Addr::LOCALHOST) };
        let socket = UdpSocket::bind((bind, 0))?;
        socket.connect(relay)?; // OS rejects datagrams from a different sender.
        socket.set_read_timeout(Some(timeout))?; socket.set_write_timeout(Some(timeout))?;
        Ok(Self { _control: control, socket, destination })
    }
    pub fn send(&self, payload: &[u8]) -> io::Result<()> {
        let frame = encode(self.destination, payload)?;
        if self.socket.send(&frame)? != frame.len() { return Err(io::Error::new(io::ErrorKind::WriteZero, "UDP 数据报未完整发送")); }
        Ok(())
    }
    pub fn receive(&self, output: &mut Vec<u8>) -> io::Result<()> {
        let mut bytes = vec![0u8; 65535];
        let length = self.socket.recv(&mut bytes)?;
        let payload = decode(&bytes[..length], self.destination)?;
        output.clear(); output.extend_from_slice(payload);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ipv4_ipv6_and_dns_payload_are_lossless() {
        let payload = b"\x12\x34\x01\x00\x00\x01\x00\x00\x00\x00\x00\x00\x02pw\x07invalid\x00\x00\x01\x00\x01";
        for address in ["192.0.2.53:53", "[2001:db8::53]:53"] {
            let address = address.parse().unwrap();
            assert_eq!(decode(&encode(address, payload).unwrap(), address).unwrap(), payload);
        }
    }
    #[test]
    fn rejects_wrong_association_fragment_and_malformed_frames() {
        let original: SocketAddr = "192.0.2.53:53".parse().unwrap();
        let mut frame = encode(original, b"message").unwrap();
        assert!(decode(&frame, "192.0.2.54:53".parse().unwrap()).is_err());
        frame[2] = 1; assert!(decode(&frame, original).is_err());
        for length in 0..10 { assert!(decode(&frame[..length.min(frame.len())], original).is_err()); }
        assert!(encode(original, &vec![0; MAX_PAYLOAD + 1]).is_err());
    }
}

#[cfg(test)]
mod runtime_tests;

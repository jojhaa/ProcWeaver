use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Flow {
    pub source: SocketAddr,
    pub destination: SocketAddr,
    pub protocol: u8,
}
#[derive(Clone, Copy)]
pub struct Packet {
    pub flow: Flow,
    pub transport: usize,
    pub payload: usize,
    pub syn: bool,
}
impl Packet {
    pub fn parse(bytes: &[u8]) -> Option<Self> {
        let version = bytes.first()? >> 4;
        let (source, destination, protocol, offset) = match version {
            4 if bytes.len() >= 20 => {
                let n = (bytes[0] as usize & 15) * 4;
                if n < 20
                    || bytes.len() < n
                    || u16::from_be_bytes([bytes[6], bytes[7]]) & 0x3fff != 0
                {
                    return None;
                }
                (
                    IpAddr::V4(Ipv4Addr::new(bytes[12], bytes[13], bytes[14], bytes[15])),
                    IpAddr::V4(Ipv4Addr::new(bytes[16], bytes[17], bytes[18], bytes[19])),
                    bytes[9],
                    n,
                )
            }
            6 if bytes.len() >= 40 => {
                let mut next = bytes[6];
                let mut n = 40;
                for _ in 0..8 {
                    if !matches!(next, 0 | 43 | 60) {
                        break;
                    }
                    let size = (*bytes.get(n + 1)? as usize + 1) * 8;
                    next = *bytes.get(n)?;
                    n += size;
                    if n > bytes.len() {
                        return None;
                    }
                }
                (
                    IpAddr::V6(Ipv6Addr::from(<[u8; 16]>::try_from(&bytes[8..24]).ok()?)),
                    IpAddr::V6(Ipv6Addr::from(<[u8; 16]>::try_from(&bytes[24..40]).ok()?)),
                    next,
                    n,
                )
            }
            _ => return None,
        };
        if !matches!(protocol, 6 | 17) || bytes.len() < offset + if protocol == 6 { 20 } else { 8 }
        {
            return None;
        }
        let port = |n| u16::from_be_bytes([bytes[n], bytes[n + 1]]);
        let payload = offset
            + if protocol == 6 {
                (bytes[offset + 12] >> 4) as usize * 4
            } else {
                8
            };
        if payload > bytes.len() || (protocol == 6 && payload < offset + 20) {
            return None;
        }
        Some(Self {
            flow: Flow {
                source: SocketAddr::new(source, port(offset)),
                destination: SocketAddr::new(destination, port(offset + 2)),
                protocol,
            },
            transport: offset,
            payload,
            syn: protocol == 6 && bytes[offset + 13] & 0x12 == 2,
        })
    }
    pub fn rewrite(&self, bytes: &mut [u8], source: SocketAddr, destination: SocketAddr) {
        match (source.ip(), destination.ip()) {
            (IpAddr::V4(s), IpAddr::V4(d)) => {
                bytes[12..16].copy_from_slice(&s.octets());
                bytes[16..20].copy_from_slice(&d.octets());
            }
            (IpAddr::V6(s), IpAddr::V6(d)) => {
                bytes[8..24].copy_from_slice(&s.octets());
                bytes[24..40].copy_from_slice(&d.octets());
            }
            _ => unreachable!(),
        }
        bytes[self.transport..self.transport + 2].copy_from_slice(&source.port().to_be_bytes());
        bytes[self.transport + 2..self.transport + 4]
            .copy_from_slice(&destination.port().to_be_bytes());
    }
    pub fn udp_reply(&self, template: &[u8], data: &[u8]) -> Option<Vec<u8>> {
        if data.len() > 65000 {
            return None;
        }
        let mut out = template[..self.payload].to_vec();
        out.extend_from_slice(data);
        self.rewrite(&mut out, self.flow.destination, self.flow.source);
        let len = out.len();
        if out[0] >> 4 == 4 {
            out[2..4].copy_from_slice(&(len as u16).to_be_bytes());
        } else {
            out[4..6].copy_from_slice(&((len - 40) as u16).to_be_bytes());
        }
        out[self.transport + 4..self.transport + 6]
            .copy_from_slice(&((8 + data.len()) as u16).to_be_bytes());
        Some(out)
    }
}
pub fn local(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => {
            v.is_loopback()
                || v.is_private()
                || v.is_link_local()
                || v.is_unspecified()
                || v.is_multicast()
                || v.is_broadcast()
        }
        IpAddr::V6(v) => {
            v.is_loopback()
                || v.is_unspecified()
                || v.is_multicast()
                || (v.segments()[0] & 0xfe00 == 0xfc00)
                || (v.segments()[0] & 0xffc0 == 0xfe80)
                || v.to_ipv4_mapped().is_some_and(|v| local(v.into()))
        }
    }
}

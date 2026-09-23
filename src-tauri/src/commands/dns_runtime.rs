//! 核对最终运行配置的 DNS 监听；不以其他进程的 DNS 响应冒充本核心就绪。
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::atomic::{AtomicU16, Ordering};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub fn parse_listen(value: &str) -> Result<SocketAddr, String> {
    let value = value.trim();
    let normalized = if value.bytes().all(|c| c.is_ascii_digit()) || value.starts_with(':') {
        format!("0.0.0.0:{}", value.strip_prefix(':').unwrap_or(value))
    } else if let Some(port) = value.strip_prefix("localhost:") {
        format!("127.0.0.1:{port}")
    } else {
        value.to_string()
    };
    normalized
        .parse::<SocketAddr>()
        .ok()
        .filter(|addr| addr.port() != 0)
        .ok_or_else(|| {
            "DNS 监听地址无效，请填写 IP:端口（IPv6 使用 [::1]:端口），端口范围 1~65535".into()
        })
}

fn listener(raw: &str) -> Result<Option<SocketAddr>, String> {
    let yaml: serde_yaml::Value = serde_yaml::from_str(raw).map_err(|_| "DNS 运行配置无法解析")?;
    if yaml["dns"]["enable"].as_bool() != Some(true) {
        return Ok(None);
    }
    match yaml["dns"].get("listen") {
        None | Some(serde_yaml::Value::Null) => Ok(None),
        Some(serde_yaml::Value::String(value)) if value.trim().is_empty() => Ok(None),
        Some(serde_yaml::Value::String(value)) => parse_listen(value).map(Some),
        _ => Err("DNS 监听地址须为字符串".into()),
    }
}

fn probe_address(addr: SocketAddr) -> SocketAddr {
    if addr.ip().is_unspecified() {
        SocketAddr::new(
            if addr.is_ipv4() {
                Ipv4Addr::LOCALHOST.into()
            } else {
                Ipv6Addr::LOCALHOST.into()
            },
            addr.port(),
        )
    } else {
        addr
    }
}

// IPv6 通配监听可能服务 IPv4；实际可达性仍由后续 UDP/TCP 协议探测确认。
fn overlaps(a: SocketAddr, b: SocketAddr) -> bool {
    a.port() == b.port()
        && (a.ip() == b.ip()
            || (a.is_ipv4() == b.is_ipv4() && (a.ip().is_unspecified() || b.ip().is_unspecified()))
            || a.ip() == IpAddr::V6(Ipv6Addr::UNSPECIFIED)
            || b.ip() == IpAddr::V6(Ipv6Addr::UNSPECIFIED))
}

#[cfg(windows)]
fn owners(tcp: bool) -> Result<Vec<(SocketAddr, u32)>, String> {
    use windows_sys::Win32::NetworkManagement::IpHelper::*;
    use windows_sys::Win32::Networking::WinSock::{AF_INET, AF_INET6};
    // 系统表为 DWORD 计数和连续 ROW；读取时校验边界并使用未对齐读取。
    unsafe fn rows<T: Copy>(tcp: bool, family: u32) -> Result<Vec<T>, String> {
        let mut size = 0u32;
        let read = |ptr, size: *mut u32| unsafe {
            if tcp {
                GetExtendedTcpTable(ptr, size, 0, family, TCP_TABLE_OWNER_PID_LISTENER, 0)
            } else {
                GetExtendedUdpTable(ptr, size, 0, family, UDP_TABLE_OWNER_PID, 0)
            }
        };
        read(std::ptr::null_mut(), &mut size);
        for _ in 0..3 {
            if size < 4 || size > 16 * 1024 * 1024 {
                return Err("DNS 监听归属表大小异常".into());
            }
            let mut aligned = vec![0u32; (size as usize).div_ceil(4)];
            let status = read(aligned.as_mut_ptr().cast(), &mut size);
            if status == 122 {
                continue;
            } // ERROR_INSUFFICIENT_BUFFER：网络表发生变化。
            if status != 0 {
                return Err(format!("无法读取 DNS 监听归属（系统代码 {status}）"));
            }
            let data = std::slice::from_raw_parts(aligned.as_ptr().cast::<u8>(), aligned.len() * 4);
            let count = u32::from_ne_bytes(data[..4].try_into().unwrap()) as usize;
            let width = std::mem::size_of::<T>();
            if count > (data.len() - 4) / width {
                return Err("DNS 监听归属表不完整".into());
            }
            return Ok((0..count)
                .map(|i| std::ptr::read_unaligned(data.as_ptr().add(4 + i * width).cast::<T>()))
                .collect());
        }
        Err("DNS 监听归属表持续变化，请重试".into())
    }
    let mut result = Vec::new();
    unsafe {
        if tcp {
            for row in rows::<MIB_TCPROW_OWNER_PID>(true, AF_INET as u32)? {
                result.push((
                    SocketAddr::new(
                        Ipv4Addr::from(row.dwLocalAddr.to_ne_bytes()).into(),
                        u16::from_be(row.dwLocalPort as u16),
                    ),
                    row.dwOwningPid,
                ));
            }
            for row in rows::<MIB_TCP6ROW_OWNER_PID>(true, AF_INET6 as u32)? {
                result.push((
                    SocketAddr::V6(std::net::SocketAddrV6::new(
                        Ipv6Addr::from(row.ucLocalAddr),
                        u16::from_be(row.dwLocalPort as u16),
                        0,
                        row.dwLocalScopeId,
                    )),
                    row.dwOwningPid,
                ));
            }
        } else {
            for row in rows::<MIB_UDPROW_OWNER_PID>(false, AF_INET as u32)? {
                result.push((
                    SocketAddr::new(
                        Ipv4Addr::from(row.dwLocalAddr.to_ne_bytes()).into(),
                        u16::from_be(row.dwLocalPort as u16),
                    ),
                    row.dwOwningPid,
                ));
            }
            for row in rows::<MIB_UDP6ROW_OWNER_PID>(false, AF_INET6 as u32)? {
                result.push((
                    SocketAddr::V6(std::net::SocketAddrV6::new(
                        Ipv6Addr::from(row.ucLocalAddr),
                        u16::from_be(row.dwLocalPort as u16),
                        0,
                        row.dwLocalScopeId,
                    )),
                    row.dwOwningPid,
                ));
            }
        }
    }
    Ok(result)
}

fn ownership(addr: SocketAddr, pid: u32, tcp: bool) -> Result<bool, String> {
    #[cfg(windows)]
    {
        let matching: Vec<_> = owners(tcp)?
            .into_iter()
            .filter(|(endpoint, _)| overlaps(*endpoint, addr))
            .collect();
        if let Some((_, owner)) = matching.iter().find(|(_, owner)| *owner != pid) {
            return Err(format!(
                "DNS {} 端口 {} 被其他进程（PID {owner}）占用，请先释放端口或修改 DNS 监听地址",
                if tcp { "TCP" } else { "UDP" },
                addr.port()
            ));
        }
        Ok(pid != 0 && matching.iter().any(|(_, owner)| *owner == pid))
    }
    #[cfg(not(windows))]
    {
        let _ = (addr, pid, tcp);
        Ok(false)
    }
}

pub async fn preflight(raw: &str, owned_pid: u32) -> Result<(), String> {
    let Some(addr) = listener(raw)? else {
        return Ok(());
    };
    tokio::task::spawn_blocking(move || {
        let udp_owned = ownership(addr, owned_pid, false)?;
        let tcp_owned = ownership(addr, owned_pid, true)?;
        let _udp =
            if udp_owned {
                None
            } else {
                Some(std::net::UdpSocket::bind(addr).map_err(|_| {
                    format!("DNS UDP 监听 {addr} 无法绑定，请检查端口占用及本机地址")
                })?)
            };
        let _tcp =
            if tcp_owned {
                None
            } else {
                Some(std::net::TcpListener::bind(addr).map_err(|_| {
                    format!("DNS TCP 监听 {addr} 无法绑定，请检查端口占用及本机地址")
                })?)
            };
        Ok(())
    })
    .await
    .map_err(|_| "DNS 端口预检任务失败")?
}

fn valid_response(query: &[u8], response: &[u8]) -> bool {
    response.len() >= 12 && response[..2] == query[..2] && response[2] & 0xf8 == 0x80
}

async fn probe(addr: SocketAddr, tcp: bool) -> Result<(), String> {
    static QUERY_ID: AtomicU16 = AtomicU16::new(0x6150);
    let mut query = [0u8; 12];
    query[..2].copy_from_slice(&QUERY_ID.fetch_add(1, Ordering::Relaxed).to_be_bytes());
    // 空 question 应由 DNS 协议层直接回复错误，不依赖上游网络和 DNS 缓存。
    let exchange = async {
        let mut data = [0u8; 4096];
        let length = if tcp {
            let mut stream = tokio::net::TcpStream::connect(addr).await?;
            stream
                .write_all(&(query.len() as u16).to_be_bytes())
                .await?;
            stream.write_all(&query).await?;
            let length = stream.read_u16().await? as usize;
            if length > data.len() {
                return Err(std::io::Error::other("DNS response too large"));
            }
            stream.read_exact(&mut data[..length]).await?;
            length
        } else {
            let local = if addr.is_ipv4() {
                "127.0.0.1:0"
            } else {
                "[::1]:0"
            };
            let socket = tokio::net::UdpSocket::bind(local).await?;
            socket.connect(addr).await?;
            socket.send(&query).await?;
            socket.recv(&mut data).await?
        };
        if valid_response(&query, &data[..length]) {
            Ok(())
        } else {
            Err(std::io::Error::other("Invalid DNS response"))
        }
    };
    match tokio::time::timeout(Duration::from_millis(300), exchange).await {
        Ok(Ok(())) => Ok(()),
        _ => Err(format!(
            "DNS {} 监听 {addr} 未返回有效协议响应",
            if tcp { "TCP" } else { "UDP" }
        )),
    }
}

#[cfg(not(windows))]
async fn confirm_address(_addr: SocketAddr, _pid: u32) -> Result<(), String> {
    Err("当前平台暂不支持 DNS 监听进程归属核验".into())
}

#[cfg(windows)]
async fn confirm_address(addr: SocketAddr, pid: u32) -> Result<(), String> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    loop {
        let owned = tokio::task::spawn_blocking(move || {
            Ok::<_, String>(ownership(addr, pid, false)? && ownership(addr, pid, true)?)
        })
        .await
        .map_err(|_| "DNS 监听核对任务失败")??;
        if owned {
            let (udp, tcp) = tokio::join!(
                probe(probe_address(addr), false),
                probe(probe_address(addr), true)
            );
            udp?;
            tcp?;
            return Ok(());
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(format!(
                "核心 DNS 监听 {addr} 未就绪（须同时具备 UDP/TCP），本次配置未确认生效"
            ));
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

pub async fn confirm(raw: &str, pid: u32) -> Result<(), String> {
    if let Some(addr) = listener(raw)? {
        confirm_address(addr, pid).await?;
    }
    Ok(())
}

pub async fn confirm_guard(raw: &str, pid: u32) -> Result<(), String> {
    let addr = listener(raw)?.ok_or("核心未配置 DNS 监听，不能启用系统 DNS 护航")?;
    if addr.port() != 53
        || !(addr.ip().is_unspecified() || addr.ip() == IpAddr::V4(Ipv4Addr::LOCALHOST))
    {
        return Err("DNS 护航要求本核心在 127.0.0.1:53 提供服务；当前配置不满足，请先在 DNS 设置中配置并确认 53 端口可用".into());
    }
    confirm_address(SocketAddr::from((Ipv4Addr::LOCALHOST, 53)), pid).await
}

#[cfg(test)]
mod tests;

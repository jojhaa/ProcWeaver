//! User-triggered probes through a saved endpoint. No configuration writes,
//! direct fallback, or implicit switch from UDP to TCP.
use super::{dns, model::Endpoint, transport::{self, Destination}, udp::Channel};
use std::time::Duration;
use tokio::sync::Semaphore;

static CAPACITY: Semaphore = Semaphore::const_new(4);
const COOKIE: [u8; 4] = [0x21, 0x12, 0xa4, 0x42];

pub(super) async fn run(endpoint: &Endpoint, target: Destination, protocol: &str, query_name: Option<&str>, timeout_ms: u64, ports: &[u16]) -> Result<String, String> {
    if !(1000..=30000).contains(&timeout_ms) { return Err("检测超时须在 1 至 30 秒之间".into()); }
    if !matches!(protocol, "tcp" | "udp_dns" | "udp_stun") { return Err("未知的检测协议".into()); }
    if protocol != "tcp" && endpoint.protocol != "socks5" { return Err("UDP 检测需要支持 UDP ASSOCIATE 的 SOCKS5 上游".into()); }
    let _permit = CAPACITY.try_acquire().map_err(|_| "已有较多连接检测，请稍后重试")?;
    let work = async {
        if protocol == "tcp" {
            transport::connect(Some(endpoint), &target, ports).await?;
            return Ok("TCP 目标隧道建立成功；未验证 TLS、网页内容或应用实际接入".into());
        }
        let transaction = transaction_id()?;
        let query = if protocol == "udp_dns" {
            let name = query_name.ok_or("请填写 DNS 检测查询域名")?.trim().trim_end_matches('.');
            dns::query(name, u16::from_be_bytes([transaction[0], transaction[1]]))?
        } else { stun_request(&transaction) };
        let mut channel = Channel::open(Some(endpoint), &target, ports).await?;
        channel.send(&query).await?;
        let mut buffer = vec![0; 65535];
        // A bounded retry tolerates a lost datagram without generating a stream
        // of background probes. The overall timeout also includes the handshake.
        let retry = tokio::time::sleep(Duration::from_secs(1)); tokio::pin!(retry);
        let mut retried = false;
        loop {
            tokio::select! {
                _ = &mut retry, if !retried => { retried = true; channel.send(&query).await?; },
                received = channel.receive(&mut buffer) => {
                    let (_, reply) = received?;
                    if protocol == "udp_dns" {
                        if let Some((code, truncated)) = dns::probe_reply(&query, &reply)? {
                            if !matches!(code, 0 | 3) { return Err(format!("UDP 已收到匹配响应，但 DNS 查询失败（RCODE {code}）")); }
                            return Ok(if truncated { "UDP 往返成功；DNS 返回截断响应，本次未转为 TCP".into() }
                                else if code == 3 { "UDP 往返成功；DNS 返回域名不存在（NXDOMAIN）".into() }
                                else { "UDP 与 DNS 查询往返成功；已校验事务及响应记录，未验证应用实际接入".into() });
                        }
                    } else if let Some(message) = stun_reply(&reply, &transaction)? { return Ok(message); }
                }
            }
        }
    };
    tokio::time::timeout(Duration::from_millis(timeout_ms), work).await.map_err(|_| -> String {
        if protocol == "tcp" { "TCP 检测超时，代理握手或目标连接未完成".into() }
        else { "UDP 检测超时，未完成代理握手或未收到有效响应；请检查上游 UDP 支持及目标服务，未改走 TCP 或直连".into() }
    })?
}

#[cfg(windows)]
fn transaction_id() -> Result<[u8; 12], String> {
    #[link(name = "bcrypt")]
    extern "system" { fn BCryptGenRandom(algorithm: *mut std::ffi::c_void, bytes: *mut u8, size: u32, flags: u32) -> i32; }
    let mut id = [0; 12];
    if unsafe { BCryptGenRandom(std::ptr::null_mut(), id.as_mut_ptr(), id.len() as u32, 2) } < 0 { return Err("无法生成安全的检测事务标识".into()); }
    Ok(id)
}
#[cfg(not(windows))]
fn transaction_id() -> Result<[u8; 12], String> { Err("独立 UDP 检测暂仅支持 Windows".into()) }

fn stun_request(id: &[u8; 12]) -> Vec<u8> {
    let mut packet = vec![0, 1, 0, 0]; packet.extend(COOKIE); packet.extend(id); packet
}
fn stun_reply(packet: &[u8], id: &[u8; 12]) -> Result<Option<String>, String> {
    if packet.len() < 20 || packet[4..8] != COOKIE || packet[8..20] != *id { return Ok(None); }
    let message = u16::from_be_bytes([packet[0], packet[1]]);
    if !matches!(message, 0x0101 | 0x0111) { return Ok(None); }
    let len = u16::from_be_bytes([packet[2], packet[3]]) as usize;
    if len % 4 != 0 || len + 20 != packet.len() { return Err("STUN 响应长度无效".into()); }
    let mut at = 20; let mut mapped = false; let mut error_code = None;
    while at < packet.len() {
        let head = packet.get(at..at + 4).ok_or("STUN 属性头不完整")?;
        let kind = u16::from_be_bytes([head[0], head[1]]);
        let size = u16::from_be_bytes([head[2], head[3]]) as usize;
        let value = packet.get(at + 4..at + 4 + size).ok_or("STUN 属性不完整")?;
        let next = at + 4 + (size + 3) / 4 * 4;
        if next > packet.len() { return Err("STUN 属性填充不完整".into()); }
        match kind {
            0x0020 => {
                if value.len() < 4 || value[0] != 0 || !matches!((value[1], value.len()), (1, 8) | (2, 20)) || u16::from_be_bytes([value[2], value[3]]) ^ 0x2112 == 0 { return Err("STUN 映射地址无效".into()); }
                mapped = true;
            }
            0x0009 => {
                if value.len() < 4 || value[0..2] != [0, 0] || !(3..=6).contains(&value[2]) || value[3] > 99 { return Err("STUN 错误码格式无效".into()); }
                error_code = Some(value[2] as u16 * 100 + value[3] as u16);
            }
            0x8028 => {
                if size != 4 || next != packet.len() || value != (crc32(&packet[..at]) ^ 0x5354554e).to_be_bytes() { return Err("STUN 响应指纹校验失败".into()); }
            }
            // MAPPED-ADDRESS / MESSAGE-INTEGRITY / UNKNOWN-ATTRIBUTES may be
            // present, but do not substitute for XOR-MAPPED-ADDRESS.
            0x0001 | 0x0008 | 0x000a | 0x001c => {},
            kind if kind >= 0x8000 => {},
            _ => return Err("STUN 响应包含不支持的必需属性".into()),
        }
        at = next;
    }
    if message == 0x0111 { return Err(format!("UDP 已收到匹配响应，但 STUN 服务拒绝请求（错误码 {}）", error_code.ok_or("STUN 错误响应缺少错误码")?)); }
    if !mapped { return Err("STUN 成功响应缺少有效的映射地址".into()); }
    Ok(Some("UDP / STUN 往返成功；已校验事务及映射地址，未验证应用实际接入".into()))
}
fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = !0u32;
    for &byte in bytes { crc ^= byte as u32; for _ in 0..8 { crc = (crc >> 1) ^ (0xedb88320u32 & 0u32.wrapping_sub(crc & 1)); } }
    !crc
}

#[cfg(all(test, windows))]
#[path = "probe_tests.rs"]
mod tests;

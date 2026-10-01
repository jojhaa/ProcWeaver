//! TCP connectors. No implicit direct fallback and no target DNS lookup when a
//! proxy is selected. All handshake input and wait times are bounded.
use super::model::Endpoint;
use base64::{engine::general_purpose::STANDARD, Engine};
use std::{net::IpAddr, time::Duration};
use tokio::{io::{AsyncReadExt, AsyncWriteExt}, net::TcpStream};

pub const HANDSHAKE: Duration = Duration::from_secs(15);
#[derive(Clone, Debug)]
pub struct Destination { pub host: String, pub port: u16 }
impl Destination {
    pub fn new(host: &str, port: u16) -> Result<Self, String> {
        let host = host.trim_start_matches('[').trim_end_matches(']').trim_end_matches('.').to_ascii_lowercase();
        if !super::model::valid_host(&host) || port == 0 { return Err("目标地址或端口无效".into()); }
        Ok(Self { host, port })
    }
    pub fn authority(&self) -> String {
        if self.host.parse::<std::net::Ipv6Addr>().is_ok() { format!("[{}]:{}", self.host, self.port) } else { format!("{}:{}", self.host, self.port) }
    }
}
pub fn auth(endpoint: &Endpoint) -> Result<Option<String>, String> {
    if endpoint.username.is_empty() { return Ok(None); }
    let password = super::secrets::reveal(&endpoint.secret)?;
    Ok(Some(format!("Basic {}", STANDARD.encode(format!("{}:{password}", endpoint.username)))))
}
pub async fn dial(host: &str, port: u16, forbidden: &[u16]) -> Result<TcpStream, String> {
    // Resolve the selected proxy (or an explicitly direct destination) ourselves
    // so aliases for our own entry cannot form a recursive proxy loop.
    let addresses = tokio::net::lookup_host((host, port)).await.map_err(|_| "代理地址或直连目标解析失败")?;
    let mut count = 0;
    for address in addresses.take(16) {
        if address.ip().is_loopback() && forbidden.contains(&address.port()) { return Err("目标指向本程序业务入口，已阻止代理循环".into()); }
        count += 1;
        // A black-holed IPv6 route must not consume the full handshake budget
        // before a working IPv4 address is tried (or vice versa).
        if let Ok(Ok(stream)) = tokio::time::timeout(Duration::from_secs(2), TcpStream::connect(address)).await { let _ = stream.set_nodelay(true); return Ok(stream); }
    }
    Err(if count == 0 { "地址未返回可用 IP" } else { "连接代理或直连目标失败" }.into())
}
pub async fn connect(endpoint: Option<&Endpoint>, destination: &Destination, forbidden: &[u16]) -> Result<TcpStream, String> {
    tokio::time::timeout(HANDSHAKE, async {
        let Some(endpoint) = endpoint else { return dial(&destination.host, destination.port, forbidden).await; };
        let mut stream = dial(&endpoint.host, endpoint.port, forbidden).await?;
        match endpoint.protocol.as_str() {
            "socks5" => socks_connect(&mut stream, endpoint, destination).await?,
            "http" => http_connect(&mut stream, endpoint, destination).await?,
            _ => return Err("代理协议不受支持".into()),
        }
        Ok(stream)
    }).await.map_err(|_| "代理连接或握手超时".to_string())?
}
async fn http_connect(stream: &mut TcpStream, endpoint: &Endpoint, destination: &Destination) -> Result<(), String> {
    let authority = destination.authority();
    let auth = auth(endpoint)?.map(|v| format!("Proxy-Authorization: {v}\r\n")).unwrap_or_default();
    stream.write_all(format!("CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n{auth}\r\n").as_bytes()).await.map_err(|_| "发送 HTTP 代理握手失败")?;
    // Read exactly the header, preserving all tunnel bytes in the socket.
    let mut header = Vec::new();
    while !header.ends_with(b"\r\n\r\n") {
        if header.len() >= 16384 { return Err("HTTP 代理响应头过大".into()); }
        header.push(stream.read_u8().await.map_err(|_| "HTTP 代理提前关闭握手")?);
    }
    let line = std::str::from_utf8(&header).map_err(|_| "HTTP 代理响应无效")?.split("\r\n").next().unwrap_or("");
    let mut fields = line.split_ascii_whitespace();
    if !matches!(fields.next(), Some("HTTP/1.0" | "HTTP/1.1")) { return Err("HTTP 代理响应版本无效".into()); }
    match fields.next() {
        Some(code) if code.len() == 3 && code.starts_with('2') && code.bytes().all(|b| b.is_ascii_digit()) => Ok(()),
        Some("407") => Err("HTTP 代理认证失败或认证方式不受支持（支持 Basic）".into()),
        _ => Err("HTTP 代理拒绝建立目标隧道".into()),
    }
}
async fn socks_connect(stream: &mut TcpStream, endpoint: &Endpoint, destination: &Destination) -> Result<(), String> {
    socks_authenticate(stream, endpoint).await?;
    socks_request(stream, 1, destination).await?;
    Ok(())
}
pub(super) async fn socks_authenticate(stream: &mut TcpStream, endpoint: &Endpoint) -> Result<(), String> {
    let method = if endpoint.username.is_empty() { 0 } else { 2 };
    stream.write_all(&[5, 1, method]).await.map_err(|_| "发送 SOCKS5 握手失败")?;
    let mut reply = [0; 2]; stream.read_exact(&mut reply).await.map_err(|_| "读取 SOCKS5 握手失败")?;
    if reply != [5, method] { return Err("SOCKS5 代理不支持所选认证方式".into()); }
    if method == 2 {
        let password = super::secrets::reveal(&endpoint.secret)?;
        if password.is_empty() || password.len() > 255 || endpoint.username.len() > 255 { return Err("SOCKS5 认证信息无效".into()); }
        let mut request = vec![1, endpoint.username.len() as u8]; request.extend(endpoint.username.as_bytes());
        request.push(password.len() as u8); request.extend(password.as_bytes());
        stream.write_all(&request).await.map_err(|_| "发送 SOCKS5 认证失败")?;
        stream.read_exact(&mut reply).await.map_err(|_| "读取 SOCKS5 认证失败")?;
        if reply != [1, 0] { return Err("SOCKS5 用户名或密码被拒绝".into()); }
    }
    Ok(())
}
pub(super) async fn socks_request(stream: &mut TcpStream, command: u8, destination: &Destination) -> Result<Destination, String> {
    let mut request = vec![5, command, 0]; encode_destination(destination, &mut request);
    stream.write_all(&request).await.map_err(|_| "发送 SOCKS5 目标失败")?;
    let mut header = [0; 4]; stream.read_exact(&mut header).await.map_err(|_| "读取 SOCKS5 连接结果失败")?;
    if header[..3] != [5, 0, 0] { return Err(if command == 3 { "SOCKS5 上游拒绝 UDP ASSOCIATE（可能未启用 UDP）" } else { "SOCKS5 代理拒绝连接目标" }.into()); }
    read_address(stream, header[3]).await
}
pub fn encode_destination(destination: &Destination, output: &mut Vec<u8>) {
    match destination.host.parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => { output.push(1); output.extend(ip.octets()); }
        Ok(IpAddr::V6(ip)) => { output.push(4); output.extend(ip.octets()); }
        Err(_) => { output.extend([3, destination.host.len() as u8]); output.extend(destination.host.as_bytes()); }
    }
    output.extend(destination.port.to_be_bytes());
}
pub async fn read_address(stream: &mut TcpStream, kind: u8) -> Result<Destination, String> {
    let host = match kind {
        1 => { let mut b = [0; 4]; stream.read_exact(&mut b).await.map_err(|_| "SOCKS5 地址不完整")?; std::net::Ipv4Addr::from(b).to_string() }
        4 => { let mut b = [0; 16]; stream.read_exact(&mut b).await.map_err(|_| "SOCKS5 地址不完整")?; std::net::Ipv6Addr::from(b).to_string() }
        3 => { let len = stream.read_u8().await.map_err(|_| "SOCKS5 地址不完整")?; let mut b = vec![0; len as usize];
            stream.read_exact(&mut b).await.map_err(|_| "SOCKS5 地址不完整")?; String::from_utf8(b).map_err(|_| "SOCKS5 域名格式无效")? }
        _ => return Err("SOCKS5 地址类型不受支持".into()),
    };
    let port = stream.read_u16().await.map_err(|_| "SOCKS5 端口不完整")?;
    // BND.PORT is allowed to be zero in an upstream CONNECT response.
    if !super::model::valid_host(&host) { return Err("SOCKS5 地址格式无效".into()); }
    Ok(Destination { host, port })
}

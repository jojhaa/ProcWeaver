//! TCP connectors. No implicit direct fallback and no target DNS lookup when a
//! proxy is selected. All handshake input and wait times are bounded.
use super::model::Endpoint;
use super::diagnostics::Trace;
use serde_json::json;
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
pub(super) fn io_detail(error: &std::io::Error) -> serde_json::Value {
    json!({"kind":format!("{:?}",error.kind()),"osCode":error.raw_os_error()})
}
fn log_io(trace: Option<&Trace>, stage: &str, error: &std::io::Error) {
    if let Some(trace)=trace { trace.event("io.failed","warning",json!({"stage":stage,"io":io_detail(error)})); }
}
pub(super) async fn dial_traced(host: &str, port: u16, forbidden: &[u16], trace: &Trace) -> Result<TcpStream, String> {
    // Resolve the selected proxy (or an explicitly direct destination) ourselves
    // so aliases for our own entry cannot form a recursive proxy loop.
    let step=trace.step("dial.resolve");
    let addresses = match tokio::net::lookup_host((host, port)).await {
        Ok(addresses) => { step.finish(true,json!({"host":host,"port":port})); addresses },
        Err(error) => { step.finish(false,io_detail(&error)); return Err("代理地址或直连目标解析失败".into()); },
    };
    let mut count = 0;
    for address in addresses.take(16) {
        if address.ip().is_loopback() && forbidden.contains(&address.port()) { trace.event("dial.loop_blocked","warning",json!({"address":address.to_string()})); return Err("目标指向本程序业务入口，已阻止代理循环".into()); }
        count += 1;
        // A black-holed IPv6 route must not consume the full handshake budget
        // before a working IPv4 address is tried (or vice versa).
        let step=trace.step("dial.tcp");
        match tokio::time::timeout(Duration::from_secs(2), TcpStream::connect(address)).await {
            Ok(Ok(stream)) => { let _=stream.set_nodelay(true); step.finish(true,json!({"address":address.to_string(),"attempt":count})); return Ok(stream); },
            Ok(Err(error)) => step.finish(false,json!({"address":address.to_string(),"attempt":count,"io":io_detail(&error)})),
            Err(_) => step.finish(false,json!({"address":address.to_string(),"attempt":count,"reason":"timeout","budgetMs":2000})),
        }
    }
    Err(if count == 0 { "地址未返回可用 IP" } else { "连接代理或直连目标失败" }.into())
}
pub async fn connect(endpoint: Option<&Endpoint>, destination: &Destination, forbidden: &[u16]) -> Result<TcpStream, String> {
    connect_traced(endpoint,destination,forbidden,&Trace::new(None)).await
}
pub(super) async fn connect_traced(endpoint: Option<&Endpoint>, destination: &Destination, forbidden: &[u16], trace: &Trace) -> Result<TcpStream, String> {
    trace.event("tcp.connect_started","info",json!({"target":destination.authority(),"via":endpoint.map(|e|json!({"protocol":e.protocol,"host":e.host,"port":e.port})),"budgetMs":HANDSHAKE.as_millis() as u64}));
    let result=tokio::time::timeout(HANDSHAKE, async {
        let Some(endpoint) = endpoint else { return dial_traced(&destination.host, destination.port, forbidden,trace).await; };
        let mut stream = dial_traced(&endpoint.host, endpoint.port, forbidden,trace).await?;
        match endpoint.protocol.as_str() {
            "socks5" => {
                let step=trace.step("socks.authenticate");
                let result=socks_authenticate_traced(&mut stream,endpoint,Some(trace)).await;
                step.finish(result.is_ok(),json!({"error":result.as_ref().err()})); result?;
                let step=trace.step("socks.connect");
                let result=socks_request_traced(&mut stream,1,destination,Some(trace)).await;
                step.finish(result.is_ok(),json!({"error":result.as_ref().err()})); result?;
            },
            "http" => { let step=trace.step("http.connect"); let result=http_connect(&mut stream,endpoint,destination,Some(trace)).await; step.finish(result.is_ok(),json!({"error":result.as_ref().err()})); result?; },
            _ => return Err("代理协议不受支持".into()),
        }
        Ok(stream)
    }).await.unwrap_or_else(|_|Err("代理连接或握手超时".into()));
    trace.event(if result.is_ok(){"tcp.connect_ok"}else{"tcp.connect_failed"},if result.is_ok(){"info"}else{"warning"},json!({"error":result.as_ref().err()})); result
}
async fn http_connect(stream: &mut TcpStream, endpoint: &Endpoint, destination: &Destination, trace: Option<&Trace>) -> Result<(), String> {
    let authority = destination.authority();
    let auth = auth(endpoint)?.map(|v| format!("Proxy-Authorization: {v}\r\n")).unwrap_or_default();
    stream.write_all(format!("CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n{auth}\r\n").as_bytes()).await.map_err(|error| { log_io(trace,"http.connect_write",&error); "发送 HTTP 代理握手失败" })?;
    // Read exactly the header, preserving all tunnel bytes in the socket.
    let mut header = Vec::new();
    while !header.ends_with(b"\r\n\r\n") {
        if header.len() >= 16384 { return Err("HTTP 代理响应头过大".into()); }
        header.push(stream.read_u8().await.map_err(|error| { log_io(trace,"http.connect_read",&error); "HTTP 代理提前关闭握手" })?);
    }
    let line = std::str::from_utf8(&header).map_err(|_| "HTTP 代理响应无效")?.split("\r\n").next().unwrap_or("");
    let mut fields = line.split_ascii_whitespace();
    if !matches!(fields.next(), Some("HTTP/1.0" | "HTTP/1.1")) { return Err("HTTP 代理响应版本无效".into()); }
    let code=fields.next();
    if let Some(trace)=trace { trace.event("http.proxy_status","info",json!({"status":code.and_then(|code|code.parse::<u16>().ok())})); }
    match code {
        Some(code) if code.len() == 3 && code.starts_with('2') && code.bytes().all(|b| b.is_ascii_digit()) => Ok(()),
        Some("407") => Err("HTTP 代理认证失败或认证方式不受支持（支持 Basic）".into()),
        _ => Err("HTTP 代理拒绝建立目标隧道".into()),
    }
}
pub(super) async fn socks_authenticate_traced(stream: &mut TcpStream, endpoint: &Endpoint, trace: Option<&Trace>) -> Result<(), String> {
    let method = if endpoint.username.is_empty() { 0 } else { 2 };
    stream.write_all(&[5, 1, method]).await.map_err(|error| { log_io(trace,"socks.greeting_write",&error); "发送 SOCKS5 握手失败" })?;
    let mut reply = [0; 2]; stream.read_exact(&mut reply).await.map_err(|error| { log_io(trace,"socks.greeting_read",&error); "读取 SOCKS5 握手失败" })?;
    if let Some(trace)=trace { trace.event("socks.method_reply","info",json!({"version":reply[0],"method":reply[1]})); }
    if reply != [5, method] { return Err("SOCKS5 代理不支持所选认证方式".into()); }
    if method == 2 {
        let password = super::secrets::reveal(&endpoint.secret)?;
        if password.is_empty() || password.len() > 255 || endpoint.username.len() > 255 { return Err("SOCKS5 认证信息无效".into()); }
        let mut request = vec![1, endpoint.username.len() as u8]; request.extend(endpoint.username.as_bytes());
        request.push(password.len() as u8); request.extend(password.as_bytes());
        stream.write_all(&request).await.map_err(|error| { log_io(trace,"socks.auth_write",&error); "发送 SOCKS5 认证失败" })?;
        stream.read_exact(&mut reply).await.map_err(|error| { log_io(trace,"socks.auth_read",&error); "读取 SOCKS5 认证失败" })?;
        if let Some(trace)=trace { trace.event("socks.auth_reply","info",json!({"status":reply[1]})); }
        if reply != [1, 0] { return Err("SOCKS5 用户名或密码被拒绝".into()); }
    }
    Ok(())
}
pub(super) async fn socks_request_traced(stream: &mut TcpStream, command: u8, destination: &Destination, trace: Option<&Trace>) -> Result<Destination, String> {
    let mut request = vec![5, command, 0]; encode_destination(destination, &mut request);
    stream.write_all(&request).await.map_err(|error| { log_io(trace,"socks.command_write",&error); "发送 SOCKS5 目标失败" })?;
    let mut header = [0; 4]; stream.read_exact(&mut header).await.map_err(|error| { log_io(trace,"socks.command_read",&error); "读取 SOCKS5 连接结果失败" })?;
    if let Some(trace)=trace { trace.event("socks.command_reply",if header[1]==0{"info"}else{"warning"},json!({"command":command,"version":header[0],"replyCode":header[1],"addressType":header[3]})); }
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

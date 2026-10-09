use super::{Engine, transport::{self, Destination}};
use crate::routing_overrides::tracker::ProcessEntry;
use http_body_util::{BodyExt, Full, combinators::BoxBody};
use hyper::{body::{Bytes, Incoming}, Request, Response, Method, StatusCode, header, service::service_fn};
use hyper_util::rt::{TokioIo, TokioTimer};
use std::{convert::Infallible, sync::Arc, time::Duration};
use tokio::{net::{TcpListener, TcpStream}, io::{AsyncReadExt, AsyncWriteExt}, sync::{watch, OwnedSemaphorePermit, Semaphore}};
type Body = BoxBody<Bytes, hyper::Error>;
fn response(status: StatusCode, text: &str) -> Response<Body> {
    Response::builder().status(status).header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(Full::new(Bytes::from(text.to_string())).map_err(|never| match never {}).boxed()).unwrap()
}

pub(super) async fn listen(runtime: Arc<Engine>, id: String, listener: TcpListener, mut stop: watch::Receiver<bool>) {
    let capacity = Arc::new(Semaphore::new(64));
    let mut tasks = tokio::task::JoinSet::new();
    loop {
        tokio::select! {
            _ = stop.changed() => break,
            Some(_) = tasks.join_next(), if !tasks.is_empty() => {},
            accepted = listener.accept() => {
                let Ok((stream, peer)) = accepted else { break; };
                if !peer.ip().is_loopback() { continue; }
                let Ok(global) = runtime.capacity.clone().try_acquire_owned() else { continue; };
                let Ok(local) = capacity.clone().try_acquire_owned() else { continue; };
                let permits = Arc::new((global, local));
                let runtime = runtime.clone(); let id = id.clone(); let mut stop = stop.clone();
                tasks.spawn(async move {
                    if *stop.borrow() { return; }
                    let service_stop = stop.clone();
                    tokio::select! {
                        _ = stop.changed() => {},
                        _ = serve(runtime, id, stream, service_stop, permits) => {},
                    }
                });
            }
        }
    }
    tasks.abort_all();
    while tasks.join_next().await.is_some() {}
}
async fn serve(runtime: Arc<Engine>, id: String, stream: TcpStream, stop: watch::Receiver<bool>, permits: Arc<(OwnedSemaphorePermit, OwnedSemaphorePermit)>) {
    let Ok(source) = stream.peer_addr() else { return; };
    let Ok(destination) = stream.local_addr() else { return; };
    let identity = super::identity::inspect(source, destination).await;
    let process = match identity {
        Ok(value) => value,
        Err(error) => { let record = runtime.record(&id, 0, "未知", "", "身份核验", 0, None); runtime.update(record, "failed", &error, (0, 0)); return; }
    };
    let mut first = [0];
    if !matches!(tokio::time::timeout(transport::HANDSHAKE, stream.peek(&mut first)).await, Ok(Ok(1))) { return; }
    if first[0] == 5 {
        socks(runtime, id, stream, process, stop, permits).await;
    } else {
        let service = service_fn(move |request| http(runtime.clone(), id.clone(), process.clone(), request, stop.clone(), permits.clone()));
        let _ = hyper::server::conn::http1::Builder::new().timer(TokioTimer::new()).header_read_timeout(transport::HANDSHAKE)
            .max_buf_size(32768).serve_connection(TokioIo::new(stream), service).with_upgrades().await;
    }
}
fn selected(runtime: &Engine, id: &str, process: &ProcessEntry, destination: &Destination) -> Result<(Option<super::model::Endpoint>, Vec<u16>, u64), String> {
    match runtime.select(id, process, destination) {
        Ok((endpoint, route, generation, ports)) => {
            let record = runtime.record(id, process.pid, process.executable_path.as_deref().unwrap_or(""), &destination.authority(), &route, generation, endpoint.as_ref());
            Ok((endpoint, ports, record))
        }
        Err(error) => {
            let record = runtime.record(id, process.pid, process.executable_path.as_deref().unwrap_or(""), &destination.authority(), "拒绝", 0, None);
            runtime.update(record, "failed", &error, (0, 0)); Err(error)
        }
    }
}
async fn tunnel<A, B>(runtime: Arc<Engine>, record: u64, mut client: A, mut upstream: B, mut stop: watch::Receiver<bool>, _permits: Arc<(OwnedSemaphorePermit, OwnedSemaphorePermit)>)
where A: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin, B: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin {
    let trace=super::diagnostics::Trace::new(Some(record)); let _activity=trace.activity("tcp");
    if *stop.borrow() { runtime.update(record, "closed", "业务包已停用", (0, 0)); return; }
    runtime.update(record, "active", "TCP 隧道已建立", (0, 0));
    tokio::select! {
        _ = stop.changed() => { trace.event("tcp.tunnel_end","info",serde_json::json!({"reason":"bundle_stop"})); runtime.update(record, "closed", "业务包已停用", (0, 0)); },
        result = tokio::io::copy_bidirectional(&mut client, &mut upstream) => match result {
            Ok(bytes) => { trace.event("tcp.tunnel_end","info",serde_json::json!({"reason":"streams_completed","uploaded":bytes.0,"downloaded":bytes.1})); runtime.update(record, "closed", "连接结束", bytes); },
            Err(error) => { trace.event("tcp.copy_failed","warning",transport::io_detail(&error)); runtime.update(record, "failed", "隧道连接中断，未直连重试", (0, 0)); },
        }
    }
}
fn strip_hop(headers: &mut hyper::HeaderMap, upgrade: bool) {
    let nominated = headers.get_all(header::CONNECTION).iter().filter_map(|v| v.to_str().ok()).flat_map(|s| s.split(',')).map(|s| s.trim().to_string()).collect::<Vec<_>>();
    for name in nominated { if !upgrade || !name.eq_ignore_ascii_case("upgrade") { headers.remove(name); } }
    for name in ["connection", "proxy-connection", "proxy-authorization", "proxy-authenticate", "keep-alive", "te", "trailer", "transfer-encoding"] { headers.remove(name); }
    if upgrade { headers.insert(header::CONNECTION, hyper::header::HeaderValue::from_static("upgrade")); }
    else { headers.remove(header::UPGRADE); }
}
async fn http(runtime: Arc<Engine>, id: String, process: ProcessEntry, mut request: Request<Incoming>, stop: watch::Receiver<bool>, permits: Arc<(OwnedSemaphorePermit, OwnedSemaphorePermit)>) -> Result<Response<Body>, Infallible> {
    let connect = request.method() == Method::CONNECT;
    let destination = (|| {
        let authority = request.uri().authority().ok_or("代理请求必须包含完整目标地址")?;
        if authority.as_str().contains('@') { return Err("目标地址不能包含认证信息".into()); }
        if !connect && !matches!(request.uri().scheme_str(), Some("http" | "ws")) { return Err("HTTPS 请求请使用 CONNECT 隧道".into()); }
        let port = if connect { authority.port_u16().ok_or("CONNECT 缺少端口")? } else { authority.port_u16().unwrap_or(80) };
        Destination::new(authority.host(), port)
    })();
    let destination = match destination { Ok(d) => d, Err(error) => return Ok(response(StatusCode::BAD_REQUEST, &error)) };
    let (endpoint, ports, record) = match selected(&runtime, &id, &process, &destination) { Ok(v) => v, Err(error) => return Ok(response(StatusCode::FORBIDDEN, &error)) };
    let trace=super::diagnostics::Trace::new(Some(record));
    if connect {
        match transport::connect_traced(endpoint.as_ref(), &destination, &ports,&trace).await {
            Ok(upstream) => {
                let upgraded = hyper::upgrade::on(&mut request);
                tokio::spawn(async move {
                    match tokio::time::timeout(transport::HANDSHAKE, upgraded).await {
                        Ok(Ok(client)) => tunnel(runtime, record, TokioIo::new(client), upstream, stop, permits).await,
                        _ => runtime.update(record, "failed", "客户端未完成隧道升级", (0, 0)),
                    }
                });
                return Ok(response(StatusCode::OK, ""));
            }
            Err(error) => { runtime.update(record, "failed", &error, (0, 0)); return Ok(response(StatusCode::BAD_GATEWAY, &error)); }
        }
    }
    let upgrade = request.headers().get(header::UPGRADE).is_some_and(|v| v.as_bytes().eq_ignore_ascii_case(b"websocket"));
    let client_upgrade = upgrade.then(|| hyper::upgrade::on(&mut request));
    let result = async {
        let forward = endpoint.as_ref().is_some_and(|e| e.protocol == "http");
        let stream = if forward {
            let e = endpoint.as_ref().unwrap();
            tokio::time::timeout(transport::HANDSHAKE, transport::dial_traced(&e.host, e.port, &ports,&trace)).await.map_err(|_| "HTTP 代理连接超时")??
        } else { transport::connect_traced(endpoint.as_ref(), &destination, &ports,&trace).await? };
        strip_hop(request.headers_mut(), upgrade);
        request.headers_mut().insert(header::HOST, destination.authority().parse().map_err(|_| "目标请求头无效")?);
        if forward {
            if request.uri().scheme_str() == Some("ws") {
                let mut parts = request.uri().clone().into_parts(); parts.scheme = Some(hyper::http::uri::Scheme::HTTP);
                *request.uri_mut() = hyper::Uri::from_parts(parts).map_err(|_| "WebSocket 地址无效")?;
            }
            if let Some(auth) = transport::auth(endpoint.as_ref().unwrap())? { request.headers_mut().insert(header::PROXY_AUTHORIZATION, auth.parse().map_err(|_| "代理认证格式无效")?); }
        } else {
            *request.uri_mut() = request.uri().path_and_query().map(|p| p.as_str()).unwrap_or("/").parse().map_err(|_| "请求路径无效")?;
        }
        let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream)).await.map_err(|_| "HTTP 转发握手失败")?;
        let mut connection_stop = stop.clone();
        tokio::spawn(async move { tokio::select! { _ = connection_stop.changed() => {}, _ = connection.with_upgrades() => {} } });
        let mut result = tokio::time::timeout(Duration::from_secs(60), sender.send_request(request)).await.map_err(|_| "目标响应头超时")?.map_err(|_| "HTTP 请求转发失败")?;
        if forward && result.status() == StatusCode::PROXY_AUTHENTICATION_REQUIRED { return Err("HTTP 代理认证失败或认证方式不受支持（支持 Basic）".to_string()); }
        if result.status() == StatusCode::SWITCHING_PROTOCOLS {
            let Some(client_upgrade) = client_upgrade else { return Err("目标返回了未请求的协议升级".into()); };
            let upstream_upgrade = hyper::upgrade::on(&mut result);
            let runtime = runtime.clone();
            tokio::spawn(async move {
                match tokio::time::timeout(transport::HANDSHAKE, async { tokio::try_join!(client_upgrade, upstream_upgrade) }).await {
                    Ok(Ok((client, upstream))) => tunnel(runtime, record, TokioIo::new(client), TokioIo::new(upstream), stop, permits).await,
                    _ => runtime.update(record, "failed", "WebSocket 升级失败", (0, 0)),
                }
            });
        } else { runtime.update(record, "response", &format!("HTTP {}；响应体流式转发", result.status().as_u16()), (0, 0)); }
        let switching = result.status() == StatusCode::SWITCHING_PROTOCOLS;
        strip_hop(result.headers_mut(), switching);
        Ok::<_, String>(result.map(|body| body.boxed()))
    }.await;
    Ok(match result { Ok(value) => value, Err(error) => { runtime.update(record, "failed", &error, (0, 0)); response(StatusCode::BAD_GATEWAY, &error) } })
}
async fn socks(runtime: Arc<Engine>, id: String, mut stream: TcpStream, process: ProcessEntry, stop: watch::Receiver<bool>, permits: Arc<(OwnedSemaphorePermit, OwnedSemaphorePermit)>) {
    let target = tokio::time::timeout(transport::HANDSHAKE, async {
        if stream.read_u8().await.map_err(|_| "SOCKS5 请求不完整")? != 5 { return Err("SOCKS5 版本无效"); }
        let count = stream.read_u8().await.map_err(|_| "SOCKS5 请求不完整")?;
        let mut methods = vec![0; count as usize]; stream.read_exact(&mut methods).await.map_err(|_| "SOCKS5 请求不完整")?;
        if !methods.contains(&0) { let _ = stream.write_all(&[5, 255]).await; return Err("本地入口使用进程身份核验，无需 SOCKS5 认证"); }
        stream.write_all(&[5, 0]).await.map_err(|_| "SOCKS5 响应失败")?;
        let mut head = [0; 4]; stream.read_exact(&mut head).await.map_err(|_| "SOCKS5 请求不完整")?;
        let target = transport::read_address(&mut stream, head[3]).await.map_err(|_| "SOCKS5 目标地址无效")?;
        if head[0] != 5 || head[2] != 0 || !matches!(head[1], 1 | 3) { let _ = stream.write_all(&[5, 7, 0, 1, 0, 0, 0, 0, 0, 0]).await; return Err("SOCKS5 请求无效或使用了不支持的 BIND"); }
        Ok((head[1], target))
    }).await;
    let (command, destination) = match target {
        Ok(Ok((command, d))) if command == 3 || d.port != 0 => (command, d),
        _ => { let record = runtime.record(&id, process.pid, &process.name, "", "SOCKS5 请求", 0, None); runtime.update(record, "failed", "请求无效、超时或使用了不支持的 BIND", (0, 0)); return; }
    };
    if command == 3 {
        // Return a protocol error before moving the control socket if ownership
        // cannot be established. It is never sufficient to know the local port.
        if runtime.select(&id, &process, &Destination { host: "association.invalid".into(), port: 1 }).is_err() {
            let _ = stream.write_all(&[5, 2, 0, 1, 0, 0, 0, 0, 0, 0]).await; return;
        }
        let record = runtime.record(&id, process.pid, &process.name, "UDP ASSOCIATE", "UDP 入口", 0, None);
        match super::udp::associate(runtime.clone(), id, stream, process, destination, stop).await {
            Ok(()) => runtime.update(record, "closed", "UDP 关联已关闭", (0, 0)),
            Err(error) => runtime.update(record, "failed", &error, (0, 0)),
        }
        return;
    }
    let (endpoint, ports, record) = match selected(&runtime, &id, &process, &destination) {
        Ok(value) => value,
        Err(_) => { let _ = stream.write_all(&[5, 2, 0, 1, 0, 0, 0, 0, 0, 0]).await; return; }
    };
    match transport::connect_traced(endpoint.as_ref(), &destination, &ports,&super::diagnostics::Trace::new(Some(record))).await {
        Ok(upstream) => {
            if stream.write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0]).await.is_ok() { tunnel(runtime, record, stream, upstream, stop, permits).await; }
        }
        Err(error) => { runtime.update(record, "failed", &error, (0, 0)); let _ = stream.write_all(&[5, 1, 0, 1, 0, 0, 0, 0, 0, 0]).await; }
    }
}

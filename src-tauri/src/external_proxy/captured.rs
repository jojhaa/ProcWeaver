//! Trusted in-process entry for WinDivert. Never accepts a PID supplied by IPC.
use super::{
    dns, identity,
    transport::{self, Destination},
    udp::Channel,
    Engine,
};
use crate::{
    capture::windivert::ownership::Identity,
    routing_overrides::{
        native,
        tracker::{self, ProcessEntry},
    },
};
use std::{net::SocketAddr, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    sync::mpsc,
};

#[derive(Clone)]
pub(crate) struct Context {
    runtime: Arc<Engine>,
    id: String,
    process: ProcessEntry,
}
pub(crate) fn resolve(expected: &Identity) -> Result<Option<Context>, String> {
    if expected.pid == std::process::id() {
        return Ok(None);
    }
    let Some(runtime) = super::ENGINE
        .lock()
        .map_err(|_| "读取独立代理失败")?
        .as_ref()
        .cloned()
    else {
        return Ok(None);
    };
    let current = native::inspect(expected.pid, 0, String::new());
    let proof = ProcessEntry {
        identity: format!("{}:{}", expected.pid, expected.created_at),
        pid: expected.pid,
        parent_pid: 0,
        name: expected
            .path
            .rsplit(['\\', '/'])
            .next()
            .unwrap_or("")
            .into(),
        created_at: expected.created_at,
        executable_path: Some(expected.path.clone()),
        parent_identity: None,
        ancestors: vec![],
    };
    let process = tracker::entry(&proof.identity)
        .filter(|p| {
            p.executable_path
                .as_deref()
                .is_some_and(|v| crate::platform::same_path(v, &expected.path))
        })
        .unwrap_or(proof);
    let config = runtime.config.read().map_err(|_| "读取独立代理规则失败")?;
    if !config.enabled {
        return Ok(None);
    }
    let Some(id) = identity::owner(&config.bundles, &process).map(str::to_string) else {
        return Ok(None);
    };
    if !matches_identity(expected, &current) {
        return Err("已匹配业务包的原始进程身份失效，拒绝直连放行".into());
    }
    drop(config);
    Ok(Some(Context {
        runtime,
        id,
        process,
    }))
}
fn matches_identity(expected: &Identity, current: &ProcessEntry) -> bool {
    current.created_at == expected.created_at
        && current.pid == expected.pid
        && current
            .executable_path
            .as_deref()
            .is_some_and(|p| crate::platform::same_path(p, &expected.path))
}
impl Context {
    fn valid(&self) -> bool {
        let current = native::inspect(self.process.pid, 0, String::new());
        let config = self
            .runtime
            .config
            .read()
            .unwrap_or_else(|e| e.into_inner());
        current.identity == self.process.identity
            && current.executable_path == self.process.executable_path
            && config.enabled
            && identity::owner(&config.bundles, &self.process) == Some(self.id.as_str())
    }
    fn select(
        &self,
        target: &Destination,
    ) -> Result<(Option<super::model::Endpoint>, Vec<u16>, u64, u64), String> {
        if !self.valid() {
            return Err("原始进程身份已改变或业务包已停用".into());
        }
        let (endpoint, reason, revision, ports) =
            self.runtime.select(&self.id, &self.process, target)?;
        let record = self.runtime.record(
            &self.id,
            self.process.pid,
            self.process.executable_path.as_deref().unwrap_or(""),
            &target.authority(),
            &format!("WinDivert · {reason}"),
            revision,
            endpoint.as_ref(),
        );
        Ok((endpoint, ports, revision, record))
    }
    async fn dns(&self, target: &Destination, query: &[u8], tcp: bool) -> Result<Vec<u8>, String> {
        let question = dns::question(query)?;
        let policy = Destination::new(&question.name, 53)?;
        let (endpoint, ports, revision, record) = self.select(&policy)?;
        let result = dns::exchange_using(endpoint.as_ref(), target, query, &ports, tcp).await;
        match result {
            Ok(reply) if self.valid() && self.runtime.config().revision == revision => {
                self.runtime.update(
                    record,
                    "response",
                    "原始进程 DNS 响应已转发",
                    (query.len() as u64, reply.len() as u64),
                );
                Ok(reply)
            }
            Ok(_) => {
                self.runtime
                    .update(record, "failed", "配置或进程已改变，丢弃旧响应", (0, 0));
                Err("配置或进程已改变".into())
            }
            Err(e) => {
                self.runtime.update(record, "failed", &e, (0, 0));
                Err(e)
            }
        }
    }
}
#[cfg(test)]
#[path = "captured_tests.rs"]
mod tests;
pub(crate) async fn tcp(
    context: Context,
    mut client: TcpStream,
    destination: SocketAddr,
) -> Result<(), String> {
    let _permit = context
        .runtime
        .capacity
        .clone()
        .try_acquire_owned()
        .map_err(|_| "独立代理连接已达上限")?;
    let target = Destination::new(&destination.ip().to_string(), destination.port())?;
    if destination.port() == 53 {
        loop {
            let len = match tokio::time::timeout(Duration::from_secs(30), client.read_u16()).await {
                Ok(Ok(v)) => v as usize,
                _ => return Ok(()),
            };
            if !(12..=65535).contains(&len) {
                return Err("DNS TCP 帧长度无效".into());
            }
            let mut query = vec![0; len];
            tokio::time::timeout(Duration::from_secs(5), client.read_exact(&mut query))
                .await
                .map_err(|_| "DNS TCP 查询超时")?
                .map_err(|_| "DNS TCP 查询不完整")?;
            let reply = context.dns(&target, &query, true).await?;
            client
                .write_u16(reply.len() as u16)
                .await
                .map_err(|_| "DNS TCP 写入失败")?;
            client
                .write_all(&reply)
                .await
                .map_err(|_| "DNS TCP 写入失败")?;
        }
    }
    let sniff = context
        .runtime
        .config()
        .bundles
        .iter()
        .any(|b| b.id == context.id && b.mode == "sandbox" && !b.domains.is_empty());
    let mut prefix = Vec::new();
    let mut policy = target.clone();
    if sniff {
        let deadline = tokio::time::Instant::now() + Duration::from_millis(500);
        let mut buffer = [0; 4096];
        loop {
            let count = match tokio::time::timeout_at(deadline, client.read(&mut buffer)).await {
                Ok(Ok(n)) if n > 0 => n,
                _ => break,
            };
            prefix.extend_from_slice(&buffer[..count]);
            match super::sniff::inspect(&prefix) {
                super::sniff::Found::NeedMore => {}
                super::sniff::Found::Done(host) => {
                    if let Some(host) = host {
                        policy.host = host;
                    }
                    break;
                }
            }
        }
    }
    let (endpoint, ports, _, record) = context.select(&policy)?;
    let result:Result<(u64,u64),String>=async {
        let mut upstream=transport::connect(endpoint.as_ref(),&target,&ports).await?;
        if !context.valid(){return Err("业务包已停用或进程身份改变".into());}
        upstream.write_all(&prefix).await.map_err(|_|"转发首包失败")?;
        context.runtime.update(record,"active","已建立独立透明 TCP 隧道",(prefix.len()as u64,0));
        let copy=tokio::io::copy_bidirectional(&mut client,&mut upstream);tokio::pin!(copy);
        let mut interval=tokio::time::interval(Duration::from_secs(1));
        loop {tokio::select! {
            r=&mut copy=>return r.map(|(up,down)|(up+prefix.len()as u64,down)).map_err(|_|"透明 TCP 连接中断，未直连重试".into()),
            _=interval.tick()=>if !context.valid(){return Err("业务包已停用或原始进程退出".into());}
        }}
    }.await;
    match result {
        Ok(bytes) => {
            context.runtime.update(record, "closed", "连接结束", bytes);
            Ok(())
        }
        Err(e) => {
            context.runtime.update(record, "failed", &e, (0, 0));
            Err(e)
        }
    }
}
pub(crate) async fn udp(
    context: Context,
    destination: SocketAddr,
    mut requests: mpsc::Receiver<Vec<u8>>,
    responses: mpsc::Sender<Vec<u8>>,
) -> Result<(), String> {
    let _permit = context
        .runtime
        .capacity
        .clone()
        .try_acquire_owned()
        .map_err(|_| "独立代理连接已达上限")?;
    let target = Destination::new(&destination.ip().to_string(), destination.port())?;
    if destination.port() == 53 {
        let mut queries = tokio::task::JoinSet::new();
        loop {
            tokio::select! {
                query=requests.recv()=>{let Some(query)=query else{return Ok(());};if queries.len()>=16{continue;}
                    let context=context.clone();let target=target.clone();let responses=responses.clone();
                    queries.spawn(async move {
                        let reply = match context.dns(&target,&query,false).await {
                            Ok(reply) => reply,
                            Err(_) if context.valid() => dns::failure(&query,2),
                            Err(_) => return,
                        };
                        let _ = responses.send(dns::fit_udp(&query,reply)).await;
                    });
                },
                _=queries.join_next(),if !queries.is_empty()=>{},
                _=tokio::time::sleep(Duration::from_secs(30))=>return Ok(()),
            }
        }
    }
    let (endpoint, ports, revision, record) = context.select(&target)?;
    let result:Result<(u64,u64),String>=async {
        let mut channel=Channel::open(endpoint.as_ref(),&target,&ports).await?;
        context.runtime.update(record,"active","UDP 关联已建立",(0,0));
        let mut buffer=vec![0;65535];let mut bytes=(0,0);let mut check=tokio::time::interval(Duration::from_secs(1));
        let mut last=tokio::time::Instant::now();
        loop {tokio::select! {
            packet=requests.recv()=>{let Some(packet)=packet else{return Ok(bytes);};if !context.valid()||context.runtime.config().revision!=revision{return Err("UDP 配置或原始进程已改变".into());}channel.send(&packet).await?;bytes.0+=packet.len() as u64;last=tokio::time::Instant::now();},
            reply=channel.receive(&mut buffer)=>{let (_,reply)=reply?;if !context.valid()||context.runtime.config().revision!=revision{return Err("UDP 配置或原始进程已改变".into());}bytes.1+=reply.len() as u64;if responses.send(reply).await.is_err(){return Ok(bytes);}last=tokio::time::Instant::now();},
            _=check.tick()=>{if last.elapsed()>Duration::from_secs(30){return Ok(bytes);}if !context.valid()||context.runtime.config().revision!=revision{return Err("UDP 配置或原始进程已改变".into());}}
        }}
    }.await;
    match result {
        Ok(bytes) => {
            context
                .runtime
                .update(record, "closed", "UDP 关联结束", bytes);
            Ok(())
        }
        Err(e) => {
            context.runtime.update(record, "failed", &e, (0, 0));
            Err(e)
        }
    }
}

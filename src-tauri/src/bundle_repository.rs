//! Bounded HTTPS JSON transport for user-configured rule repositories.
use std::{collections::HashMap, sync::{LazyLock, Mutex}, time::{Duration, Instant}};
use crate::commands::process::CoreStateMutex;
static REQUESTS: LazyLock<tokio::sync::Semaphore> = LazyLock::new(|| tokio::sync::Semaphore::new(4));
const MAX_BYTES: usize = 1024 * 1024;
enum RequestEntry { Active(tokio::sync::oneshot::Sender<()>), Cancelled(Instant) }
static PENDING: LazyLock<Mutex<HashMap<String, RequestEntry>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
struct RequestGuard(String);
impl Drop for RequestGuard {
    fn drop(&mut self) { if let Ok(mut pending) = PENDING.lock() { pending.remove(&self.0); } }
}
fn valid_request_id(id: &str) -> bool { !id.is_empty() && id.len() <= 80 && id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-') }
fn begin_request(id: String) -> Result<(RequestGuard, tokio::sync::oneshot::Receiver<()>), String> {
    if !valid_request_id(&id) { return Err("仓库请求标识无效".into()); }
    let mut pending = PENDING.lock().map_err(|_| "读取仓库请求状态失败")?;
    pending.retain(|_, entry| !matches!(entry, RequestEntry::Cancelled(at) if at.elapsed() > Duration::from_secs(60)));
    if let Some(entry) = pending.get(&id) {
        return Err(match entry { RequestEntry::Cancelled(_) => "请求已取消", RequestEntry::Active(_) => "仓库请求标识重复" }.into());
    }
    if pending.len() >= 128 { return Err("仓库请求繁忙，请稍后重试".into()); }
    let (sender, receiver) = tokio::sync::oneshot::channel();
    pending.insert(id.clone(), RequestEntry::Active(sender));
    Ok((RequestGuard(id), receiver))
}
#[tauri::command]
pub fn cancel_bundle_repository_request(request_id: String) -> Result<(), String> {
    if !valid_request_id(&request_id) { return Err("仓库请求标识无效".into()); }
    let mut pending = PENDING.lock().map_err(|_| "读取仓库请求状态失败")?;
    pending.retain(|_, entry| !matches!(entry, RequestEntry::Cancelled(at) if at.elapsed() > Duration::from_secs(60)));
    if let Some(RequestEntry::Active(sender)) = pending.remove(&request_id) { let _ = sender.send(()); }
    // Keep a short tombstone when cancellation arrives before the read command starts.
    if pending.len() < 128 { pending.insert(request_id, RequestEntry::Cancelled(Instant::now())); }
    Ok(())
}

fn allowed_url(url: &reqwest::Url) -> bool {
    url.scheme() == "https" && url.host_str().is_some() && url.username().is_empty() && url.password().is_none() && url.fragment().is_none() && url.as_str().len() <= 2048
}
async fn read_body(mut response: reqwest::Response, max_bytes: usize) -> Result<String, String> {
    if !response.status().is_success() {
        return Err(match response.status().as_u16() {
            401 | 403 => "仓库拒绝访问或请求额度已用尽；当前仅支持公开仓库".into(),
            404 => "仓库、分支或目录不存在，请检查地址".into(),
            429 => "仓库请求过于频繁，请稍后重试".into(),
            code => format!("仓库请求失败（HTTP {code}）"),
        });
    }
    if response.content_length().is_some_and(|n| n > max_bytes as u64) { return Err("仓库响应超过大小上限（单文件最多 1 MB）".into()); }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "仓库响应读取失败或超时")? {
        if bytes.len() + chunk.len() > max_bytes { return Err("仓库响应超过大小上限（单文件最多 1 MB）".into()); }
        bytes.extend_from_slice(&chunk);
    }
    String::from_utf8(bytes).map_err(|_| "仓库文件须为 UTF-8 文本".into())
}
#[tauri::command]
pub async fn read_bundle_repository_file(url: String, max_bytes: usize, request_id: String, state: tauri::State<'_, CoreStateMutex>) -> Result<String, String> {
    if max_bytes == 0 || max_bytes > MAX_BYTES { return Err("仓库响应大小限制无效".into()); }
    let url = reqwest::Url::parse(&url).map_err(|_| "仓库地址无效")?;
    if !allowed_url(&url) { return Err("仓库须使用不含账号密码的 HTTPS 地址".into()); }
    let (_guard, cancelled) = begin_request(request_id)?;
    tokio::select! {
        biased;
        _ = cancelled => Err("请求已取消".into()),
        result = fetch_file(url, max_bytes, &state) => result,
    }
}
async fn fetch_file(url: reqwest::Url, max_bytes: usize, state: &CoreStateMutex) -> Result<String, String> {
    let _permit = tokio::time::timeout(Duration::from_secs(15), REQUESTS.acquire()).await.map_err(|_| "仓库请求繁忙，请稍后重试")?.map_err(|_| "仓库请求已关闭")?;
    let proxy_port = { let guard = state.lock().map_err(|_| "读取网络状态失败")?; guard.child.as_ref().map(|_| guard.mixed_port) };
    let mut builder = reqwest::Client::builder().user_agent(concat!("ProcWeaver/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(6)).timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 || !allowed_url(attempt.url()) { attempt.error("仓库重定向地址无效") } else { attempt.follow() }
        }));
    if let Some(port) = proxy_port { builder = builder.proxy(reqwest::Proxy::all(format!("http://127.0.0.1:{port}")).map_err(|_| "本地代理地址无效")?); }
    let client = builder.build().map_err(|_| "无法创建仓库网络连接")?;
    let response = client.get(url).header(reqwest::header::ACCEPT, "application/json").send().await.map_err(|_| "无法连接仓库或请求超时，请检查网络")?;
    read_body(response, max_bytes).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn repository_transport_rejects_unsafe_urls() {
        for url in ["http://example.test/x", "file:///C:/file", "https://user:secret@example.test/x", "https://example.test/x#token"] { assert!(!allowed_url(&reqwest::Url::parse(url).unwrap())); }
        assert!(allowed_url(&reqwest::Url::parse("https://api.github.com/repos/a/b/contents/Rules?ref=main").unwrap()));
    }
    #[tokio::test]
    async fn repository_cancellation_releases_active_and_queued_requests() {
        let id = "repository-test-active".to_owned();
        let (guard, receiver) = begin_request(id.clone()).unwrap();
        assert!(begin_request(id.clone()).is_err());
        cancel_bundle_repository_request(id.clone()).unwrap();
        receiver.await.unwrap();
        drop(guard);
        assert!(!PENDING.lock().unwrap().contains_key(&id));
        let early = "repository-test-early".to_owned();
        cancel_bundle_repository_request(early.clone()).unwrap();
        assert!(begin_request(early.clone()).err().unwrap().contains("取消"));
        PENDING.lock().unwrap().remove(&early);
    }
    #[tokio::test]
    async fn repository_response_limits_and_errors() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        async fn response(status: &str, body: Vec<u8>, declared: Option<usize>) -> Result<String, String> {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap(); let address = listener.local_addr().unwrap();
            let header = format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", declared.unwrap_or(body.len()));
            let server = tokio::spawn(async move { let (mut socket, _) = listener.accept().await.unwrap(); let mut buf = [0u8; 4096]; let _ = socket.read(&mut buf).await; let _ = socket.write_all(header.as_bytes()).await; let _ = socket.write_all(&body).await; });
            let response = reqwest::Client::builder().no_proxy().timeout(Duration::from_secs(3)).build().unwrap().get(format!("http://{address}")).send().await.unwrap();
            let result = read_body(response, MAX_BYTES).await; server.await.unwrap(); result
        }
        assert_eq!(response("200 OK", br#"{"packages":[]}"#.to_vec(), None).await.unwrap(), r#"{"packages":[]}"#);
        assert!(response("403 Forbidden", b"secret upstream body".to_vec(), None).await.unwrap_err().contains("公开仓库"));
        assert!(response("200 OK", vec![], Some(MAX_BYTES + 1)).await.unwrap_err().contains("1 MB"));
        assert!(response("200 OK", vec![255], None).await.unwrap_err().contains("UTF-8"));
    }
}

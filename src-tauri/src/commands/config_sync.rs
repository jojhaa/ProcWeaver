use serde::Deserialize;
const MAX: usize = 8 * 1024 * 1024;
#[derive(Deserialize)]
pub struct SyncConnection { url: String, username: String, password: String }
#[tauri::command]
pub async fn sync_config_remote(connection: SyncConnection, content: Option<String>, etag: Option<String>) -> Result<serde_json::Value, String> {
    let url = reqwest::Url::parse(&connection.url).map_err(|_| "同步地址无效")?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() || url.query().is_some()
        || connection.username.len()>256 || connection.password.len()>1024 {
        return Err("同步需要 HTTPS 文件地址，凭据请填写在独立字段".into());
    }
    // Never forward user credentials across redirects to a different host.
    let client = reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(45)).build().map_err(|_| "同步客户端初始化失败")?;
    exchange(connection, content, etag, url, client).await
}
async fn exchange(connection: SyncConnection, content: Option<String>, etag: Option<String>, url: reqwest::Url, client: reqwest::Client) -> Result<serde_json::Value, String> {
    let uploading = content.is_some();
    let mut request = if let Some(content) = content {
        if content.len() > MAX { return Err("同步文件超过 8 MB".into()); }
        let envelope: serde_json::Value = serde_json::from_str(&content).map_err(|_| "只能同步加密备份")?;
        if envelope["format"] != "ProcWeaver encrypted configuration v1" || !envelope["data"].is_string() { return Err("只能同步加密备份".into()); }
        let request = client.put(url).header("Content-Type", "application/json").body(content);
        match etag.as_deref() {
            Some(value) if value.starts_with('"') && value.ends_with('"') && value.len() <= 256 => request.header("If-Match", value),
            None | Some("") => request.header("If-None-Match", "*"),
            _ => return Err("服务器未提供强 ETag，无法安全覆盖远端配置".into()),
        }
    } else { client.get(url) };
    if !connection.username.is_empty() { request = request.basic_auth(connection.username, Some(connection.password)); }
    let mut response = request.send().await.map_err(|_| "同步连接失败，请检查地址和网络")?;
    if response.status() == reqwest::StatusCode::PRECONDITION_FAILED { return Err("远端配置已变化，请先下载预览，再决定恢复或上传".into()); }
    if !uploading && response.status() == reqwest::StatusCode::NOT_FOUND { return Ok(serde_json::json!({"content":"","etag":""})); }
    if !response.status().is_success() { return Err(format!("同步失败：HTTP {}", response.status().as_u16())); }
    let tag = response.headers().get(reqwest::header::ETAG).and_then(|h| h.to_str().ok()).unwrap_or("").to_owned();
    if uploading { return Ok(serde_json::json!({"content":"","etag":tag})); }
    if response.content_length().is_some_and(|size| size > MAX as u64) { return Err("远端备份超过 8 MB".into()); }
    let mut bytes=Vec::new();
    while let Some(chunk)=response.chunk().await.map_err(|_| "读取同步内容失败")? {
        if bytes.len()+chunk.len()>MAX { return Err("远端备份超过 8 MB".into()); } bytes.extend_from_slice(&chunk);
    }
    let content=String::from_utf8(bytes).map_err(|_| "同步内容不是 UTF-8")?;
    Ok(serde_json::json!({"content":content,"etag":tag}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    #[tokio::test]
    async fn conditional_upload_does_not_overwrite_a_changed_remote() {
        let listener=std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url=format!("http://{}/backup",listener.local_addr().unwrap());
        let server=std::thread::spawn(move || {
            for (method,condition,response) in [
                ("GET", "", "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"),
                ("PUT", "if-none-match: *", "HTTP/1.1 201 Created\r\nETag: \"v1\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"),
                ("PUT", "if-match: \"v1\"", "HTTP/1.1 412 Precondition Failed\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            ] {
                let (mut socket,_) = listener.accept().unwrap(); socket.set_read_timeout(Some(std::time::Duration::from_secs(5))).unwrap();
                let mut bytes=Vec::new(); let mut part=[0u8;4096];
                loop { let n=socket.read(&mut part).unwrap(); assert!(n>0); bytes.extend_from_slice(&part[..n]);
                    if let Some(end)=bytes.windows(4).position(|v|v==b"\r\n\r\n") {
                        let headers=String::from_utf8_lossy(&bytes[..end]).to_lowercase();
                        let length=headers.lines().find_map(|v|v.strip_prefix("content-length: ").and_then(|v|v.parse::<usize>().ok())).unwrap_or(0);
                        if bytes.len()>=end+4+length { break; }
                    }
                }
                let request=String::from_utf8(bytes).unwrap(); assert!(request.starts_with(method)); assert!(request.to_lowercase().contains(condition));
                socket.write_all(response.as_bytes()).unwrap();
            }
        });
        let connection=||SyncConnection{url:url.clone(),username:String::new(),password:String::new()};
        let client=reqwest::Client::builder().no_proxy().build().unwrap();
        let parsed=reqwest::Url::parse(&url).unwrap();
        let missing=exchange(connection(),None,None,parsed.clone(),client.clone()).await.unwrap(); assert_eq!(missing["content"], "");
        let content=serde_json::json!({"format":"ProcWeaver encrypted configuration v1","data":"test-ciphertext"}).to_string();
        let created=exchange(connection(),Some(content.clone()),None,parsed.clone(),client.clone()).await.unwrap(); assert_eq!(created["etag"], "\"v1\"");
        let conflict=exchange(connection(),Some(content),Some("\"v1\"".into()),parsed,client).await.unwrap_err(); assert!(conflict.contains("远端配置已变化"));
        server.join().unwrap();
    }
    #[tokio::test]
    async fn insecure_or_credential_bearing_urls_are_rejected_before_network_access() {
        for url in ["http://example.invalid/backup", "https://user:password@example.invalid/backup", "https://example.invalid/backup?token=secret"] {
            let connection=SyncConnection{url:url.into(),username:String::new(),password:String::new()};
            assert!(sync_config_remote(connection,None,None).await.unwrap_err().contains("HTTPS"));
        }
    }
}

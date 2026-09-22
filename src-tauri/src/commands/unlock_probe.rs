use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UnlockItem {
    pub id: String,
    pub name: String,
    pub category: String, // "AI" | "Media"
    pub status: String,   // "unlocked" | "restricted" | "blocked" | "failed"
    pub info: String,
    pub latency_ms: Option<u64>,
}

fn build_client(proxy_port: Option<u16>, timeout_ms: u64) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .connect_timeout(Duration::from_millis(1500))
        .timeout(Duration::from_millis(timeout_ms))
        .redirect(reqwest::redirect::Policy::limited(3))
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36");

    if let Some(port) = proxy_port {
        if let Ok(p) = reqwest::Proxy::all(&format!("http://127.0.0.1:{}", port)) {
            builder = builder.proxy(p);
        }
    }
    builder.build().map_err(|e| e.to_string())
}

async fn check_openai(proxy_port: Option<u16>) -> UnlockItem {
    let start = Instant::now();
    let client = match build_client(proxy_port, 2800) {
        Ok(c) => c,
        Err(_) => return UnlockItem {
            id: "openai".into(),
            name: "OpenAI / ChatGPT".into(),
            category: "AI".into(),
            status: "failed".into(),
            info: "客户端初始化失败".into(),
            latency_ms: None,
        },
    };

    match client.get("https://chatgpt.com").send().await {
        Ok(resp) => {
            let lat = start.elapsed().as_millis() as u64;
            let status_code = resp.status().as_u16();
            if status_code == 200 || status_code == 302 || status_code == 307 {
                let text = resp.text().await.unwrap_or_default();
                if text.contains("unsupported_country") || text.contains("cf_chl_opt") || text.contains("Just a moment...") {
                    UnlockItem {
                        id: "openai".into(),
                        name: "OpenAI / ChatGPT".into(),
                        category: "AI".into(),
                        status: "blocked".into(),
                        info: "受限 · 命中 Cloudflare 风控墙".into(),
                        latency_ms: Some(lat),
                    }
                } else {
                    UnlockItem {
                        id: "openai".into(),
                        name: "OpenAI / ChatGPT".into(),
                        category: "AI".into(),
                        status: "unlocked".into(),
                        info: "已解锁 · 支持 GPT-4o / Canvas".into(),
                        latency_ms: Some(lat),
                    }
                }
            } else if status_code == 403 {
                UnlockItem {
                    id: "openai".into(),
                    name: "OpenAI / ChatGPT".into(),
                    category: "AI".into(),
                    status: "blocked".into(),
                    info: "已阻断 · 节点所在地区被列入黑名单".into(),
                    latency_ms: Some(lat),
                }
            } else {
                UnlockItem {
                    id: "openai".into(),
                    name: "OpenAI / ChatGPT".into(),
                    category: "AI".into(),
                    status: "restricted".into(),
                    info: format!("响应状态异常 ({})", status_code),
                    latency_ms: Some(lat),
                }
            }
        }
        Err(_) => UnlockItem {
            id: "openai".into(),
            name: "OpenAI / ChatGPT".into(),
            category: "AI".into(),
            status: "failed".into(),
            info: "连接超时或无响应".into(),
            latency_ms: None,
        },
    }
}

async fn check_claude(proxy_port: Option<u16>) -> UnlockItem {
    let start = Instant::now();
    let client = match build_client(proxy_port, 2800) {
        Ok(c) => c,
        Err(_) => return UnlockItem {
            id: "claude".into(),
            name: "Claude (Anthropic)".into(),
            category: "AI".into(),
            status: "failed".into(),
            info: "客户端初始化失败".into(),
            latency_ms: None,
        },
    };

    match client.get("https://claude.ai/login").send().await {
        Ok(resp) => {
            let lat = start.elapsed().as_millis() as u64;
            let code = resp.status().as_u16();
            if code == 200 || code == 302 {
                let text = resp.text().await.unwrap_or_default();
                if text.contains("App unavailable") || text.contains("temporarily unavailable") {
                    UnlockItem {
                        id: "claude".into(),
                        name: "Claude (Anthropic)".into(),
                        category: "AI".into(),
                        status: "restricted".into(),
                        info: "地区限制 · 暂不可用".into(),
                        latency_ms: Some(lat),
                    }
                } else {
                    UnlockItem {
                        id: "claude".into(),
                        name: "Claude (Anthropic)".into(),
                        category: "AI".into(),
                        status: "unlocked".into(),
                        info: "已解锁 · 支持 Claude 3.5 Sonnet".into(),
                        latency_ms: Some(lat),
                    }
                }
            } else if code == 403 {
                UnlockItem {
                    id: "claude".into(),
                    name: "Claude (Anthropic)".into(),
                    category: "AI".into(),
                    status: "blocked".into(),
                    info: "已阻断 · IP 被 Anthropic 拒绝".into(),
                    latency_ms: Some(lat),
                }
            } else {
                UnlockItem {
                    id: "claude".into(),
                    name: "Claude (Anthropic)".into(),
                    category: "AI".into(),
                    status: "restricted".into(),
                    info: format!("HTTP {}", code),
                    latency_ms: Some(lat),
                }
            }
        }
        Err(_) => UnlockItem {
            id: "claude".into(),
            name: "Claude (Anthropic)".into(),
            category: "AI".into(),
            status: "failed".into(),
            info: "连接超时".into(),
            latency_ms: None,
        },
    }
}

async fn check_gemini(proxy_port: Option<u16>) -> UnlockItem {
    let start = Instant::now();
    let client = match build_client(proxy_port, 2800) {
        Ok(c) => c,
        Err(_) => return UnlockItem {
            id: "gemini".into(),
            name: "Google Gemini".into(),
            category: "AI".into(),
            status: "failed".into(),
            info: "初始化失败".into(),
            latency_ms: None,
        },
    };

    match client.get("https://gemini.google.com").send().await {
        Ok(resp) => {
            let lat = start.elapsed().as_millis() as u64;
            let code = resp.status().as_u16();
            if code == 200 || code == 302 {
                let url = resp.url().as_str();
                if url.contains("location_error") || url.contains("unsupported") {
                    UnlockItem {
                        id: "gemini".into(),
                        name: "Google Gemini".into(),
                        category: "AI".into(),
                        status: "restricted".into(),
                        info: "当前国家/地区尚未开放".into(),
                        latency_ms: Some(lat),
                    }
                } else {
                    UnlockItem {
                        id: "gemini".into(),
                        name: "Google Gemini".into(),
                        category: "AI".into(),
                        status: "unlocked".into(),
                        info: "已解锁 · 支持 Gemini 1.5 Pro".into(),
                        latency_ms: Some(lat),
                    }
                }
            } else {
                UnlockItem {
                    id: "gemini".into(),
                    name: "Google Gemini".into(),
                    category: "AI".into(),
                    status: "blocked".into(),
                    info: format!("HTTP 状态 {}", code),
                    latency_ms: Some(lat),
                }
            }
        }
        Err(_) => UnlockItem {
            id: "gemini".into(),
            name: "Google Gemini".into(),
            category: "AI".into(),
            status: "failed".into(),
            info: "连接超时".into(),
            latency_ms: None,
        },
    }
}

async fn check_copilot(proxy_port: Option<u16>) -> UnlockItem {
    let start = Instant::now();
    let client = match build_client(proxy_port, 2800) {
        Ok(c) => c,
        Err(_) => return UnlockItem {
            id: "copilot".into(),
            name: "Microsoft Copilot".into(),
            category: "AI".into(),
            status: "failed".into(),
            info: "初始化失败".into(),
            latency_ms: None,
        },
    };

    match client.get("https://copilot.microsoft.com").send().await {
        Ok(resp) => {
            let lat = start.elapsed().as_millis() as u64;
            let code = resp.status().as_u16();
            if code == 200 || code == 302 {
                UnlockItem {
                    id: "copilot".into(),
                    name: "Microsoft Copilot".into(),
                    category: "AI".into(),
                    status: "unlocked".into(),
                    info: "已解锁 · 正常响应".into(),
                    latency_ms: Some(lat),
                }
            } else {
                UnlockItem {
                    id: "copilot".into(),
                    name: "Microsoft Copilot".into(),
                    category: "AI".into(),
                    status: "restricted".into(),
                    info: format!("HTTP {}", code),
                    latency_ms: Some(lat),
                }
            }
        }
        Err(_) => UnlockItem {
            id: "copilot".into(),
            name: "Microsoft Copilot".into(),
            category: "AI".into(),
            status: "failed".into(),
            info: "连接超时".into(),
            latency_ms: None,
        },
    }
}

async fn check_netflix(proxy_port: Option<u16>) -> UnlockItem {
    let start = Instant::now();
    let client = match build_client(proxy_port, 3000) {
        Ok(c) => c,
        Err(_) => return UnlockItem {
            id: "netflix".into(),
            name: "Netflix (奈飞)".into(),
            category: "Media".into(),
            status: "failed".into(),
            info: "初始化失败".into(),
            latency_ms: None,
        },
    };

    match client.get("https://www.netflix.com/title/81280792").send().await {
        Ok(resp) => {
            let lat = start.elapsed().as_millis() as u64;
            let code = resp.status().as_u16();
            if code == 200 {
                UnlockItem {
                    id: "netflix".into(),
                    name: "Netflix (奈飞)".into(),
                    category: "Media".into(),
                    status: "unlocked".into(),
                    info: "原生全解锁 · 支持非自制剧".into(),
                    latency_ms: Some(lat),
                }
            } else if code == 403 || code == 404 || resp.url().as_str().contains("/browse") {
                UnlockItem {
                    id: "netflix".into(),
                    name: "Netflix (奈飞)".into(),
                    category: "Media".into(),
                    status: "restricted".into(),
                    info: "仅限自制剧 (Originals Only)".into(),
                    latency_ms: Some(lat),
                }
            } else {
                UnlockItem {
                    id: "netflix".into(),
                    name: "Netflix (奈飞)".into(),
                    category: "Media".into(),
                    status: "blocked".into(),
                    info: format!("受限 (HTTP {})", code),
                    latency_ms: Some(lat),
                }
            }
        }
        Err(_) => UnlockItem {
            id: "netflix".into(),
            name: "Netflix (奈飞)".into(),
            category: "Media".into(),
            status: "failed".into(),
            info: "连接超时".into(),
            latency_ms: None,
        },
    }
}

async fn check_youtube(proxy_port: Option<u16>) -> UnlockItem {
    let start = Instant::now();
    let client = match build_client(proxy_port, 2800) {
        Ok(c) => c,
        Err(_) => return UnlockItem {
            id: "youtube".into(),
            name: "YouTube Premium".into(),
            category: "Media".into(),
            status: "failed".into(),
            info: "初始化失败".into(),
            latency_ms: None,
        },
    };

    match client.get("https://www.youtube.com/premium").send().await {
        Ok(resp) => {
            let lat = start.elapsed().as_millis() as u64;
            let code = resp.status().as_u16();
            if code == 200 {
                UnlockItem {
                    id: "youtube".into(),
                    name: "YouTube Premium".into(),
                    category: "Media".into(),
                    status: "unlocked".into(),
                    info: "已解锁 · 支持会员购买与后台播放".into(),
                    latency_ms: Some(lat),
                }
            } else {
                UnlockItem {
                    id: "youtube".into(),
                    name: "YouTube Premium".into(),
                    category: "Media".into(),
                    status: "restricted".into(),
                    info: format!("HTTP {}", code),
                    latency_ms: Some(lat),
                }
            }
        }
        Err(_) => UnlockItem {
            id: "youtube".into(),
            name: "YouTube Premium".into(),
            category: "Media".into(),
            status: "failed".into(),
            info: "连接超时".into(),
            latency_ms: None,
        },
    }
}

async fn check_disney(proxy_port: Option<u16>) -> UnlockItem {
    let start = Instant::now();
    let client = match build_client(proxy_port, 2800) {
        Ok(c) => c,
        Err(_) => return UnlockItem {
            id: "disney".into(),
            name: "Disney+".into(),
            category: "Media".into(),
            status: "failed".into(),
            info: "初始化失败".into(),
            latency_ms: None,
        },
    };

    match client.get("https://www.disneyplus.com").send().await {
        Ok(resp) => {
            let lat = start.elapsed().as_millis() as u64;
            let code = resp.status().as_u16();
            if code == 200 || code == 301 || code == 302 {
                UnlockItem {
                    id: "disney".into(),
                    name: "Disney+".into(),
                    category: "Media".into(),
                    status: "unlocked".into(),
                    info: "已解锁 · 支持流式播放".into(),
                    latency_ms: Some(lat),
                }
            } else {
                UnlockItem {
                    id: "disney".into(),
                    name: "Disney+".into(),
                    category: "Media".into(),
                    status: "restricted".into(),
                    info: "地区限制或被阻断".into(),
                    latency_ms: Some(lat),
                }
            }
        }
        Err(_) => UnlockItem {
            id: "disney".into(),
            name: "Disney+".into(),
            category: "Media".into(),
            status: "failed".into(),
            info: "连接超时".into(),
            latency_ms: None,
        },
    }
}

async fn check_tiktok(proxy_port: Option<u16>) -> UnlockItem {
    let start = Instant::now();
    let client = match build_client(proxy_port, 2800) {
        Ok(c) => c,
        Err(_) => return UnlockItem {
            id: "tiktok".into(),
            name: "TikTok".into(),
            category: "Media".into(),
            status: "failed".into(),
            info: "初始化失败".into(),
            latency_ms: None,
        },
    };

    match client.get("https://www.tiktok.com").send().await {
        Ok(resp) => {
            let lat = start.elapsed().as_millis() as u64;
            let code = resp.status().as_u16();
            if code == 200 {
                UnlockItem {
                    id: "tiktok".into(),
                    name: "TikTok".into(),
                    category: "Media".into(),
                    status: "unlocked".into(),
                    info: "已解锁 · 正常刷短视频与推流".into(),
                    latency_ms: Some(lat),
                }
            } else {
                UnlockItem {
                    id: "tiktok".into(),
                    name: "TikTok".into(),
                    category: "Media".into(),
                    status: "blocked".into(),
                    info: format!("HTTP {}", code),
                    latency_ms: Some(lat),
                }
            }
        }
        Err(_) => UnlockItem {
            id: "tiktok".into(),
            name: "TikTok".into(),
            category: "Media".into(),
            status: "failed".into(),
            info: "连接超时".into(),
            latency_ms: None,
        },
    }
}

async fn check_recaptcha(proxy_port: Option<u16>) -> UnlockItem {
    let start = Instant::now();
    let client = match build_client(proxy_port, 2800) {
        Ok(c) => c,
        Err(_) => return UnlockItem {
            id: "recaptcha".into(),
            name: "Google 搜索 / 纯净度".into(),
            category: "Media".into(),
            status: "failed".into(),
            info: "初始化失败".into(),
            latency_ms: None,
        },
    };

    match client.get("https://www.google.com/recaptcha/api2/demo").send().await {
        Ok(resp) => {
            let lat = start.elapsed().as_millis() as u64;
            let code = resp.status().as_u16();
            if code == 200 {
                UnlockItem {
                    id: "recaptcha".into(),
                    name: "Google 搜索 / 纯净度".into(),
                    category: "Media".into(),
                    status: "unlocked".into(),
                    info: "纯净 · 无验证码阻断与流量拦截".into(),
                    latency_ms: Some(lat),
                }
            } else {
                UnlockItem {
                    id: "recaptcha".into(),
                    name: "Google 搜索 / 纯净度".into(),
                    category: "Media".into(),
                    status: "restricted".into(),
                    info: "频繁触发人机验证".into(),
                    latency_ms: Some(lat),
                }
            }
        }
        Err(_) => UnlockItem {
            id: "recaptcha".into(),
            name: "Google 搜索 / 纯净度".into(),
            category: "Media".into(),
            status: "failed".into(),
            info: "连接超时".into(),
            latency_ms: None,
        },
    }
}

#[tauri::command]
pub async fn probe_unlock_matrix(proxy_port: Option<u16>) -> Result<Vec<UnlockItem>, String> {
    let (c1, c2, c3, c4, c5, c6, c7, c8, c9) = tokio::join!(
        check_openai(proxy_port),
        check_claude(proxy_port),
        check_gemini(proxy_port),
        check_copilot(proxy_port),
        check_netflix(proxy_port),
        check_youtube(proxy_port),
        check_disney(proxy_port),
        check_tiktok(proxy_port),
        check_recaptcha(proxy_port),
    );

    Ok(vec![c1, c2, c3, c4, c5, c6, c7, c8, c9])
}

use super::*;
#[test]
fn diagnostics_are_bounded_and_do_not_expose_error_text() {
    let old = STATUS.lock().unwrap().recent_errors.clone();
    STATUS.lock().unwrap().recent_errors.clear();
    let error = std::io::Error::other("fixture-private-token-and-url");
    for _ in 0..20 { connection_error("核心→程序：读取核心", "203.0.113.1:443".parse().unwrap(), &error); }
    let state = status();
    assert_eq!(state.recent_errors.len(), 12);
    let json = serde_json::to_string(&state.recent_errors).unwrap();
    assert!(!json.contains("fixture-private"));
    assert!(json.contains("203.0.113.1:443"));
    STATUS.lock().unwrap().recent_errors = old;
}
#[test]
fn normal_socket_disconnect_is_not_recorded_as_error() {
    let old = STATUS.lock().unwrap().recent_errors.clone();
    let old_last = STATUS.lock().unwrap().last_error.clone();
    STATUS.lock().unwrap().recent_errors.clear();
    STATUS.lock().unwrap().last_error = None;
    let rst_error = std::io::Error::from_raw_os_error(10054);
    let abort_error = std::io::Error::from_raw_os_error(10053);
    let broken_pipe = std::io::Error::new(std::io::ErrorKind::BrokenPipe, "pipe broken");
    connection_error("核心→程序：读取核心", "203.0.113.1:443".parse().unwrap(), &rst_error);
    connection_error("程序→核心：读取程序", "203.0.113.2:443".parse().unwrap(), &abort_error);
    connection_error("程序→核心：写入核心", "203.0.113.3:443".parse().unwrap(), &broken_pipe);
    record_error("TCP 数据传输", &rst_error);
    record_error("TCP 数据传输", &abort_error);
    let state = status();
    assert_eq!(state.recent_errors.len(), 0);
    assert_eq!(state.last_error, None);
    STATUS.lock().unwrap().recent_errors = old;
    STATUS.lock().unwrap().last_error = old_last;
}
// Explicit opt-in diagnostic: never reads a user's configuration in normal tests.
#[test]
#[ignore = "requires NETBOX_CAPTURE_LIVE_CONFIG, administrator and public network"]
fn native_live_selected_node() {
    let source = std::env::var("NETBOX_CAPTURE_LIVE_CONFIG").expect("explicit live config required");
    let original: Value = serde_yaml::from_str(&std::fs::read_to_string(source).unwrap()).unwrap();
    let mut chosen: Plan = serde_yaml::from_value(original["netbox-capture"].clone()).unwrap();
    chosen.config.process_rules.truncate(1);
    chosen.config.process_rules[0].match_kind = "path".into();
    chosen.config.process_rules[0].match_value = std::env::current_exe().unwrap().to_string_lossy().into_owned();
    chosen.config.process_rules[0].include_descendants = true;
    chosen.config.process_rules[0].enabled = true;
    chosen.config.process_enabled = true;
    chosen.config.dns_enabled = false;
    let profile = chosen.config.process_rules[0].target.as_ref().unwrap().profile_id.clone();
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf();
    let dir = std::env::temp_dir().join(format!("netbox-live-capture-{}", std::process::id()));
    std::fs::create_dir_all(dir.join("config")).unwrap();
    crate::storage::initialize_test(dir.clone(), root.clone());
    let mut base: Value = serde_yaml::from_str("mode: rule\nmixed-port: 0\nexternal-controller: ''\nlog-level: silent\nrules: ['MATCH,DIRECT']\n").unwrap();
    base["proxies"] = original["proxies"].clone();
    base["proxy-groups"] = original["proxy-groups"].clone();
    let raw = compose(&serde_yaml::to_string(&base).unwrap(), &chosen.config, &profile).unwrap();
    let parsed: Value = serde_yaml::from_str(&raw).unwrap();
    let applied: Plan = serde_yaml::from_value(parsed["netbox-capture"].clone()).unwrap();
    struct Config(std::path::PathBuf);
    impl Drop for Config { fn drop(&mut self) { let _ = std::fs::remove_file(&self.0); } }
    let _config = Config(dir.join("config.yaml"));
    std::fs::write(&_config.0, raw).unwrap();
    struct Core(std::process::Child);
    impl Drop for Core { fn drop(&mut self) { let _ = self.0.kill(); let _ = self.0.wait(); } }
    let core = Core(std::process::Command::new(root.join("src-tauri/binaries/mihomo-v3.exe"))
        .args(["-d"]).arg(&dir).arg("-f").arg(dir.join("config.yaml"))
        .stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn().unwrap());
    for _ in 0..100 { if std::net::TcpStream::connect("127.0.0.1:32000").is_ok() {break;} std::thread::sleep(Duration::from_millis(100)); }
    crate::commands::process::PID.store(core.0.id(), Ordering::SeqCst);
    let probe = |proxy: bool| {
        let started = std::time::Instant::now();
        let url = std::env::var("NETBOX_CAPTURE_TEST_URL").unwrap_or_else(|_| "https://api.ipify.org".into());
        assert!(["https://api.ipify.org", "https://api6.ipify.org", "https://api64.ipify.org"].contains(&url.as_str()));
        let setup = if proxy { "$h.Proxy=[Net.WebProxy]::new('socks5://127.0.0.1:32000')" } else { "$h.UseProxy=$false" };
        let script = format!("$ErrorActionPreference='Stop'; $h=[Net.Http.HttpClientHandler]::new(); {setup}; $c=[Net.Http.HttpClient]::new($h); $c.Timeout=[TimeSpan]::FromSeconds(15); try {{ $c.GetStringAsync('{url}').GetAwaiter().GetResult() }} finally {{$c.Dispose()}}");
        let out = std::process::Command::new("pwsh").args(["-NoProfile", "-Command", &script]).output().unwrap();
        eprintln!("proxy={proxy} elapsed_ms={} success={} body={} error={}", started.elapsed().as_millis(), out.status.success(), String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
        out
    };
    let before = probe(true);
    assert!(before.status.success(), "baseline node failed before capture");
    let capture = engine::Engine::start(applied, &root.join("src-tauri/binaries/windivert/WinDivert.dll"), None).unwrap();
    let during = probe(true);
    let transparent = probe(false);
    let chrome_path = std::path::Path::new("C:/Program Files/Google/Chrome/Application/chrome.exe");
    let mut chrome = std::process::Command::new(chrome_path)
        .args(["--headless=new", "--no-proxy-server", "--disable-background-networking", "--disable-sync", "--disable-extensions", "--no-first-run", "--dump-dom", "--timeout=10000"])
        .arg(format!("--user-data-dir={}", dir.join("chrome").display()))
        .arg(std::env::var("NETBOX_CAPTURE_TEST_URL").unwrap_or_else(|_| "https://api.ipify.org".into()))
        .stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null()).spawn().unwrap();
    let started = std::time::Instant::now();
    while chrome.try_wait().unwrap().is_none() {
        if started.elapsed() > Duration::from_secs(20) { let _ = chrome.kill(); break; }
        std::thread::sleep(Duration::from_millis(100));
    }
    let chrome = chrome.wait_with_output().unwrap();
    let expected = String::from_utf8_lossy(&before.stdout).trim().to_string();
    let chrome_matches = chrome.status.success() && String::from_utf8_lossy(&chrome.stdout).contains(&expected);
    eprintln!("Chrome no-proxy public exit matches selected node: {chrome_matches}");
    if let Ok(page) = std::env::var("NETBOX_CAPTURE_TEST_PAGE") {
        assert!(["https://ipip.la/", "https://ping0.cc/"].contains(&page.as_str()));
        for mode in ["socks", "transparent", "tcp-only"] {
            let log = dir.join(format!("{mode}.json"));
            let mut cmd = std::process::Command::new(chrome_path);
            cmd.args(["--headless=new", "--disable-background-networking", "--disable-sync", "--disable-extensions", "--disable-component-update", "--no-first-run", "--dump-dom", "--timeout=15000"])
                .arg(format!("--user-data-dir={}", dir.join(mode).display()))
                .arg(format!("--log-net-log={}", log.display()));
            if mode == "socks" { cmd.arg("--proxy-server=socks5://127.0.0.1:32000"); }
            else { cmd.arg("--no-proxy-server"); }
            if mode == "tcp-only" { cmd.arg("--disable-quic"); }
            let started = std::time::Instant::now();
            let mut browser = cmd.arg(&page).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null()).spawn().unwrap();
            let mut output = browser.stdout.take().unwrap();
            let reader = std::thread::spawn(move || { let mut text = String::new(); let _ = output.read_to_string(&mut text); text });
            let mut timeout = false;
            while browser.try_wait().unwrap().is_none() {
                if started.elapsed() > Duration::from_secs(22) { timeout = true; let _ = browser.kill(); break; }
                std::thread::sleep(Duration::from_millis(100));
            }
            let _ = browser.wait();
            let html = reader.join().unwrap();
            std::fs::write(dir.join(format!("{mode}.html")), &html).unwrap();
            let mut errors = std::collections::BTreeMap::new();
            if let Ok(raw) = std::fs::read_to_string(&log) {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) {
                    if let Some(events) = value["events"].as_array() {
                        for event in events { if let Some(code) = event["params"]["net_error"].as_i64().filter(|v| *v < 0) { *errors.entry(code).or_insert(0) += 1; } }
                    }
                }
            }
            eprintln!("page={page} mode={mode} elapsed_ms={} timeout={timeout} browser_error={} net_errors={errors:?}", started.elapsed().as_millis(), html.contains("chrome-error://"));
        }
    }
    capture.stop();
    eprintln!("TCP={} failures={} unknown={}", TCP.load(Ordering::Relaxed), FAILURES.load(Ordering::Relaxed), UNKNOWN.load(Ordering::Relaxed));
    assert!(during.status.success(), "core connection failed during capture");
    assert!(transparent.status.success(), "transparent connection failed");
    assert_eq!(before.stdout, transparent.stdout, "selected exit changed");
    assert!(chrome_matches, "Chrome public exit did not match selected node");
}
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::{atomic::AtomicBool, Arc},
    time::Duration,
};
fn plan(path: String, port: u16) -> Plan {
    Plan {
        config: Overrides {
            process_enabled: true,
            process_rules: vec![ProcessRule {
                id: "capture-test".into(),
                enabled: true,
                label: "隔离接管测试".into(),
                match_kind: "path".into(),
                match_value: path,
                action: "proxy".into(),
                target: Some(Target {
                    profile_id: "default".into(),
                    kind: "node".into(),
                    name: "test-node".into(),
                }),
                include_descendants: true,
                rule_mode: None,
            }],
            ..Overrides::default()
        },
        ports: vec![port],
        dns_port: 31999,
    }
}
#[test]
fn pid_instance_selection_and_dns_boundaries() {
    assert!(contains_port(&Value::from("31000-32500,40000"), 32000));
    assert!(!contains_port(&Value::from("31000-31999"), 32000));
    let mut p = plan("C:\\root.exe".into(), 1234);
    let mut child = ProcessEntry {
        identity: "20:50".into(),
        pid: 20,
        parent_pid: 10,
        name: "child.exe".into(),
        created_at: 50,
        executable_path: Some("C:\\child.exe".into()),
        parent_identity: Some("10:30".into()),
        ancestors: vec![("10:30".into(), "C:\\root.exe".into())],
    };
    assert_eq!(p.select(&child), Some(0));
    child.ancestors.clear();
    assert_eq!(p.select(&child), None);
    p.config.dns_enabled = true;
    p.config.dns_rules.push(DnsRule {
        id: "dns".into(),
        enabled: true,
        domain_kind: "suffix".into(),
        domain: "example.com".into(),
        resolver_url: "https://192.0.2.53/dns-query".into(),
        target: p.config.process_rules[0].target.clone().unwrap(),
    });
    let query = |name: &str| {
        let mut b = vec![0, 1, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0];
        for part in name.split('.') {
            b.push(part.len() as u8);
            b.extend(part.as_bytes());
        }
        b.extend([0, 0, 1, 0, 1]);
        b
    };
    assert!(p.dns_matches(&query("a.example.com")));
    assert!(!p.dns_matches(&query("badexample.com")));
    assert!(!p.dns_matches(&[0; 11]));
    assert_eq!(std::mem::size_of::<driver::Address>(), 80);
}
/// Explicit opt-in because this opens a real Windows packet filter. The filter
/// only matches an RFC5737 test destination; no registry, DNS or TUN is modified.
#[test]
#[ignore = "requires administrator; run explicitly for real WinDivert acceptance"]
fn native_child_first_connection_without_proxy() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    listener.set_nonblocking(true).unwrap();
    let done = Arc::new(AtomicBool::new(false));
    let d = done.clone();
    let upstream = std::thread::spawn(move || {
        let mut observed = vec![];
        while !d.load(Ordering::Acquire) {
            match listener.accept() {
                Ok((mut socket, _)) => {
                    socket.set_nonblocking(false).unwrap();
                    socket
                        .set_read_timeout(Some(Duration::from_secs(3)))
                        .unwrap();
                    let mut hello = [0; 3];
                    if socket.read_exact(&mut hello).is_err() {
                        continue;
                    }
                    assert_eq!(hello, [5, 1, 0]);
                    socket.write_all(&[5, 0]).unwrap();
                    let mut header = [0; 4];
                    socket.read_exact(&mut header).unwrap();
                    let mut request = header.to_vec();
                    request.resize(if header[3] == 4 { 22 } else { 10 }, 0);
                    socket.read_exact(&mut request[4..]).unwrap();
                    observed.push(request);
                    socket.write_all(&[5, 0, 0, 1, 127, 0, 0, 1, 0, 0]).unwrap();
                    let mut data = [0; 64];
                    let n = socket.read(&mut data).unwrap();
                    assert_eq!(&data[..n], b"netbox-transparent");
                    // Slow first byte must not poison the client socket through
                    // repeated Windows SO_RCVTIMEO polling.
                    std::thread::sleep(Duration::from_secs(1));
                    socket.write_all(b"selected-node-ok").unwrap();
                }
                Err(_) => std::thread::sleep(Duration::from_millis(5)),
            }
        }
        observed
    });
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("binaries/windivert/WinDivert.dll");
    let config = plan(
        std::env::current_exe()
            .unwrap()
            .to_string_lossy()
            .into_owned(),
        port,
    );
    let capture=engine::Engine::start(config.clone(),&path,Some("outbound and tcp and ((ip and ip.DstAddr == 203.0.113.123) or (ipv6 and ipv6.DstAddr == 2001:db8::123))")).unwrap();
    let output=std::process::Command::new("pwsh").args(["-NoProfile","-Command", "$ErrorActionPreference='Stop'; $c=[Net.Sockets.TcpClient]::new(); if(-not $c.ConnectAsync('203.0.113.123',18081).Wait(8000)){throw 'connect timeout'}; $s=$c.GetStream(); $s.ReadTimeout=8000; $b=[Text.Encoding]::ASCII.GetBytes('netbox-transparent'); $s.Write($b); $r=[byte[]]::new(64); $n=$s.Read($r); [Text.Encoding]::ASCII.GetString($r,0,$n); $c.Dispose()"])
        .output().unwrap();
    let v6=std::process::Command::new("pwsh").args(["-NoProfile","-Command", "$ErrorActionPreference='Stop'; $c=[Net.Sockets.TcpClient]::new([Net.Sockets.AddressFamily]::InterNetworkV6); if(-not $c.ConnectAsync('2001:db8::123',18081).Wait(8000)){throw 'connect timeout'}; $s=$c.GetStream(); $s.ReadTimeout=8000; $b=[Text.Encoding]::ASCII.GetBytes('netbox-transparent'); $s.Write($b); $r=[byte[]]::new(64); $n=$s.Read($r); [Text.Encoding]::ASCII.GetString($r,0,$n); $c.Dispose()"])
        .output().unwrap();
    capture.pause();
    let replacement = engine::Engine::start(
        config,
        &path,
        Some("outbound and tcp and ip and ip.DstAddr == 203.0.113.123"),
    )
    .unwrap();
    capture.stop();
    let replaced=std::process::Command::new("pwsh").args(["-NoProfile","-Command", "$ErrorActionPreference='Stop'; $c=[Net.Sockets.TcpClient]::new(); if(-not $c.ConnectAsync('203.0.113.123',18081).Wait(8000)){throw 'connect timeout'}; $s=$c.GetStream(); $s.ReadTimeout=8000; $s.Write([Text.Encoding]::ASCII.GetBytes('netbox-transparent')); $r=[byte[]]::new(64); $n=$s.Read($r); [Text.Encoding]::ASCII.GetString($r,0,$n); $c.Dispose()"])
        .output().unwrap();
    replacement.stop();
    done.store(true, Ordering::Release);
    let observed = upstream.join().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        String::from_utf8_lossy(&output.stdout).contains("selected-node-ok"),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    assert!(
        v6.status.success(),
        "IPv6: {}",
        String::from_utf8_lossy(&v6.stderr)
    );
    assert!(String::from_utf8_lossy(&v6.stdout).contains("selected-node-ok"));
    assert!(
        replaced.status.success(),
        "{}",
        String::from_utf8_lossy(&replaced.stderr)
    );
    assert!(String::from_utf8_lossy(&replaced.stdout).contains("selected-node-ok"));
    assert_eq!(observed.len(), 3);
    assert_eq!(observed[0], [5, 1, 0, 1, 203, 0, 113, 123, 70, 161]);
    assert_eq!(observed[1][3], 4);
    assert!(TCP.load(Ordering::Relaxed) > 0);
}

#[test]
#[ignore = "requires administrator and actual Mihomo; isolated storage and RFC5737 traffic"]
fn native_mihomo_selected_node_and_udp_dns() {
    const FLAG: &str = "NETBOX_CAPTURE_NATIVE";
    if std::env::var_os(FLAG).is_none() {
        let result = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "capture::tests::native_mihomo_selected_node_and_udp_dns",
                "--ignored",
                "--nocapture",
            ])
            .env(FLAG, "1")
            .status()
            .unwrap();
        assert!(result.success());
        return;
    }
    let directory =
        std::env::temp_dir().join(format!("netbox-capture-native-{}", std::process::id()));
    std::fs::create_dir_all(directory.join("config")).unwrap();
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf();
    crate::storage::initialize_test(directory.clone(), root.clone());
    let mock = TcpListener::bind("127.0.0.1:0").unwrap();
    let mock_port = mock.local_addr().unwrap().port();
    mock.set_nonblocking(true).unwrap();
    let done = Arc::new(AtomicBool::new(false));
    let d = done.clone();
    let http = std::thread::spawn(move || {
        let mut hits = 0;
        while !d.load(Ordering::Acquire) {
            match mock.accept() {
                Ok((mut stream, _)) => {
                    stream.set_nonblocking(false).unwrap();
                    stream
                        .set_read_timeout(Some(Duration::from_secs(3)))
                        .unwrap();
                    let mut request = vec![];
                    let mut b = [0; 1];
                    while request.len() < 8192 && stream.read_exact(&mut b).is_ok() {
                        request.push(b[0]);
                        if request.ends_with(b"\r\n\r\n") {
                            break;
                        }
                    }
                    if !String::from_utf8_lossy(&request).starts_with("CONNECT 203.0.113.123:18081") {
                        let _ = stream.write_all(b"HTTP/1.1 502 Test target only\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                        continue;
                    }
                    hits += 1;
                    stream
                        .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                        .unwrap();
                    let mut data = [0; 4096];
                    let mut n = stream.read(&mut data).unwrap();
                    if n == 0 { continue; } // Chrome may abandon a speculative connection.
                    while n < 5 { let got = stream.read(&mut data[n..]).unwrap(); if got == 0 { break; } n += got; }
                    if data[0] == b'n' { while n < b"netbox-transparent".len() { let got=stream.read(&mut data[n..]).unwrap(); if got==0 {break;} n+=got; } }
                    if &data[..n] == b"netbox-transparent" {
                        stream.write_all(b"mihomo-selected-node-ok").unwrap();
                    } else {
                        if !data[..n].starts_with(b"GET /") { continue; }
                        let html = b"<html><body>chrome-selected-node-ok</body></html>";
                        write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",html.len()).unwrap();
                        stream.write_all(html).unwrap();
                    }
                }
                Err(_) => std::thread::sleep(Duration::from_millis(5)),
            }
        }
        hits
    });
    let plan0 = plan(
        std::env::current_exe()
            .unwrap()
            .to_string_lossy()
            .into_owned(),
        32000,
    );
    let base=format!("mixed-port: 0\nexternal-controller: ''\nmode: rule\nlog-level: warning\nproxies:\n- {{name: test-node, type: http, server: 127.0.0.1, port: {mock_port}}}\nrules: ['MATCH,REJECT']\n");
    let raw = compose(&base, &plan0.config, "default").unwrap();
    std::fs::write(directory.join("config.yaml"), &raw).unwrap();
    let parsed: serde_yaml::Value = serde_yaml::from_str(&raw).unwrap();
    let applied: Plan = serde_yaml::from_value(parsed["netbox-capture"].clone()).unwrap();
    let executable = root.join("src-tauri/binaries/mihomo-v3.exe");
    let validate = std::process::Command::new(&executable)
        .arg("-t")
        .arg("-d")
        .arg(&directory)
        .arg("-f")
        .arg(directory.join("config.yaml"))
        .output()
        .unwrap();
    assert!(
        validate.status.success(),
        "{} {}",
        String::from_utf8_lossy(&validate.stdout),
        String::from_utf8_lossy(&validate.stderr)
    );
    struct Child(std::process::Child);
    impl Drop for Child {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let _core = Child(
        std::process::Command::new(executable)
            .arg("-d")
            .arg(&directory)
            .arg("-f")
            .arg(directory.join("config.yaml"))
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap(),
    );
    for _ in 0..80 {
        if std::net::TcpStream::connect("127.0.0.1:32000").is_ok() {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    crate::commands::process::PID.store(_core.0.id(), Ordering::SeqCst);
    engine::verify_listener(32000, 6).unwrap();
    engine::verify_listener(32000, 17).unwrap();
    assert!(
        engine::verify_listener(mock_port, 6).is_err(),
        "不得把其他进程的 SOCKS / HTTP 服务当成本核心入口"
    );
    let capture = engine::Engine::start(
        applied,
        &root.join("src-tauri/binaries/windivert/WinDivert.dll"),
        None,
    )
    .unwrap();
    let output=std::process::Command::new("pwsh").args(["-NoProfile","-Command","$ErrorActionPreference='Stop'; $c=[Net.Sockets.TcpClient]::new(); if(-not $c.ConnectAsync('203.0.113.123',18081).Wait(8000)){throw 'connect timeout'}; $s=$c.GetStream(); $s.ReadTimeout=8000; $s.Write([Text.Encoding]::ASCII.GetBytes('netbox-transparent')); $r=[byte[]]::new(64); $n=$s.Read($r); [Text.Encoding]::ASCII.GetString($r,0,$n); $c.Dispose()"])
        .output().unwrap();
    capture.stop();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("mihomo-selected-node-ok"));
    let chrome_path = std::path::Path::new("C:/Program Files/Google/Chrome/Application/chrome.exe");
    // Restrict the full-filter fixture to this test's process tree. Other Chrome
    // instances on the developer's desktop must never enter the mock node.
    let mut chrome_plan = plan(std::env::current_exe().unwrap().to_string_lossy().into_owned(), 32000);
    chrome_plan.config.process_rules[0].include_descendants = true;
    let capture = engine::Engine::start(
        chrome_plan,
        &root.join("src-tauri/binaries/windivert/WinDivert.dll"),
        None,
    )
    .unwrap();
    let mut chrome = std::process::Command::new(chrome_path)
        .args([
            "--headless=new",
            "--no-proxy-server",
            "--disable-features=HttpsUpgrades,HttpsFirstModeV2",
            "--disable-background-networking",
            "--disable-sync",
            "--disable-extensions",
            "--disable-component-update",
            "--no-first-run",
            "--dump-dom",
            "--timeout=10000",
        ])
        .arg(format!(
            "--user-data-dir={}",
            directory.join("chrome-test").display()
        ))
        .arg("http://203.0.113.123:18081/")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let started = std::time::Instant::now();
    while chrome.try_wait().unwrap().is_none() {
        if started.elapsed() > Duration::from_secs(20) {
            let _ = chrome.kill();
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let chrome = chrome.wait_with_output().unwrap();
    capture.stop();
    done.store(true, Ordering::Release);
    let hits = http.join().unwrap();
    assert!(
        chrome.status.success(),
        "Chrome: {}",
        String::from_utf8_lossy(&chrome.stderr)
    );
    assert!(
        String::from_utf8_lossy(&chrome.stdout).contains("chrome-selected-node-ok"),
        "{}",
        String::from_utf8_lossy(&chrome.stdout)
    );
    assert!(hits >= 2);
    drop(_core);
    // UDP SOCKS association, original source restoration and DNS interception.
    let udp_relay = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
    let relay_port = udp_relay.local_addr().unwrap().port();
    udp_relay
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    let control = TcpListener::bind("127.0.0.1:0").unwrap();
    let control_port = control.local_addr().unwrap().port();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let server = std::thread::spawn(move || {
        // Engine readiness probe closes immediately.
        let (probe, _) = control.accept().unwrap();
        drop(probe);
        let (mut stream, _) = control.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut hello = [0; 3];
        stream.read_exact(&mut hello).unwrap();
        stream.write_all(&[5, 0]).unwrap();
        let mut command = [0; 10];
        stream.read_exact(&mut command).unwrap();
        assert_eq!(command[1], 3);
        let mut reply = vec![5, 0, 0, 1, 127, 0, 0, 1];
        reply.extend(relay_port.to_be_bytes());
        stream.write_all(&reply).unwrap();
        let mut data = [0; 512];
        let (n, peer) = udp_relay.recv_from(&mut data).unwrap();
        assert_eq!(&data[10..n], b"udp-transparent");
        let mut response = data[..10].to_vec();
        response.extend(b"udp-node-ok");
        udp_relay.send_to(&response, peer).unwrap();
        let _ = release_rx.recv_timeout(Duration::from_secs(8));
    });
    let capture = engine::Engine::start(
        plan(
            std::env::current_exe()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            control_port,
        ),
        &root.join("src-tauri/binaries/windivert/WinDivert.dll"),
        Some("outbound and ip and ip.DstAddr == 203.0.113.123 and udp"),
    )
    .unwrap();
    let output=std::process::Command::new("pwsh").args(["-NoProfile","-Command","$ErrorActionPreference='Stop'; $c=[Net.Sockets.UdpClient]::new(); $c.Client.ReceiveTimeout=5000; $c.Connect('203.0.113.123',18082); $b=[Text.Encoding]::ASCII.GetBytes('udp-transparent'); $null=$c.Send($b,$b.Length); $remote=[Net.IPEndPoint]::new([Net.IPAddress]::Any,0); $r=$c.Receive([ref]$remote); [Text.Encoding]::ASCII.GetString($r); $remote.ToString(); $c.Dispose()"])
        .output().unwrap();
    capture.stop();
    let _ = release_tx.send(());
    server.join().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let text = String::from_utf8_lossy(&output.stdout);
    assert!(
        text.contains("udp-node-ok") && text.contains("203.0.113.123:18082"),
        "{text}"
    );
    let dns = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
    let dns_port = dns.local_addr().unwrap().port();
    dns.set_read_timeout(Some(Duration::from_secs(6))).unwrap();
    let dns_tcp = TcpListener::bind(("127.0.0.1", dns_port)).unwrap();
    let dns_tcp_server = std::thread::spawn(move || {
        let (mut stream, _) = dns_tcp.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(6)))
            .unwrap();
        let mut size = [0; 2];
        stream.read_exact(&mut size).unwrap();
        let mut query = vec![0; u16::from_be_bytes(size) as usize];
        stream.read_exact(&mut query).unwrap();
        query[2] |= 0x80;
        stream.write_all(&size).unwrap();
        stream.write_all(&query).unwrap();
    });
    let dns_server = std::thread::spawn(move || {
        let mut query = [0; 512];
        let (n, peer) = dns.recv_from(&mut query).unwrap();
        assert!(query[..n].windows(7).any(|s| s == b"example"));
        query[2] |= 0x80;
        dns.send_to(&query[..n], peer).unwrap();
    });
    let mut config = plan("C:\\does-not-exist.exe".into(), 0);
    config.config.process_enabled = false;
    config.config.dns_enabled = true;
    config.dns_port = dns_port;
    config.config.dns_rules.push(DnsRule {
        id: "dns".into(),
        enabled: true,
        domain_kind: "suffix".into(),
        domain: "example.com".into(),
        resolver_url: "https://192.0.2.53/dns-query".into(),
        target: config.config.process_rules[0].target.clone().unwrap(),
    });
    let capture = engine::Engine::start(
        config,
        &root.join("src-tauri/binaries/windivert/WinDivert.dll"),
        Some("outbound and ip and ip.DstAddr == 203.0.113.123 and (udp or tcp)"),
    )
    .unwrap();
    let output=std::process::Command::new("pwsh").args(["-NoProfile","-Command","$ErrorActionPreference='Stop'; $c=[Net.Sockets.UdpClient]::new(); $c.Client.ReceiveTimeout=5000; $c.Connect('203.0.113.123',53); $q=[byte[]](0,42,1,0,0,1,0,0,0,0,0,0,7,101,120,97,109,112,108,101,3,99,111,109,0,0,1,0,1); $null=$c.Send($q,$q.Length); $remote=[Net.IPEndPoint]::new([Net.IPAddress]::Any,0); $a=$c.Receive([ref]$remote); if($a[1]-ne 42 -or ($a[2]-band 128)-eq 0){throw 'bad DNS reply'}; 'dns-node-ok'; $remote.ToString(); $c.Dispose()"])
        .output().unwrap();
    let tcp_dns=std::process::Command::new("pwsh").args(["-NoProfile","-Command","$ErrorActionPreference='Stop'; $c=[Net.Sockets.TcpClient]::new(); if(-not $c.ConnectAsync('203.0.113.123',53).Wait(5000)){throw 'timeout'}; $s=$c.GetStream(); $s.ReadTimeout=5000; $q=[byte[]](0,29,0,42,1,0,0,1,0,0,0,0,0,0,7,101,120,97,109,112,108,101,3,99,111,109,0,0,1,0,1); $s.Write($q); $r=[byte[]]::new(31); $s.ReadExactly($r); if($r[3]-ne 42 -or ($r[4]-band 128)-eq 0){throw 'bad DNS'}; 'tcp-dns-ok'; $c.Dispose()"])
        .output().unwrap();
    capture.stop();
    dns_server.join().unwrap();
    dns_tcp_server.join().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let text = String::from_utf8_lossy(&output.stdout);
    assert!(
        text.contains("dns-node-ok") && text.contains("203.0.113.123:53"),
        "{text}"
    );
    assert!(DNS.load(Ordering::Relaxed) > 0);
    assert!(
        tcp_dns.status.success(),
        "{}",
        String::from_utf8_lossy(&tcp_dns.stderr)
    );
    assert!(String::from_utf8_lossy(&tcp_dns.stdout).contains("tcp-dns-ok"));
    std::fs::remove_dir_all(directory).unwrap();
}

use super::*;

#[cfg(windows)]
fn reserve_dns_port() -> (std::net::TcpListener, std::net::UdpSocket) {
    for _ in 0..128 {
        // Avoid Windows UDP-excluded ranges in the ephemeral TCP pool.
        let tcp = crate::storage::reserve_test_mixed_port();
        if let Ok(udp) = std::net::UdpSocket::bind(tcp.local_addr().unwrap()) {
            return (tcp, udp);
        }
    }
    panic!("未找到同时可用的 TCP/UDP 测试端口");
}

#[test]
fn listener_config_and_guard_boundaries() {
    for value in [
        "1053",
        ":1053",
        "0.0.0.0:1053",
        "127.0.0.1:1053",
        "[::1]:1053",
        "[::]:1053",
        "localhost:1053",
    ] {
        assert_eq!(parse_listen(value).unwrap().port(), 1053, "{value}");
    }
    for value in [
        "",
        "0",
        "65536",
        "0.0.0.0:0",
        "no-address:53",
        "::1:53",
        ":",
        "::1053",
    ] {
        assert!(parse_listen(value).is_err(), "{value}");
    }
    assert_eq!(
        listener("dns: {enable: true}").unwrap(),
        None,
        "内部解析不要求外部监听"
    );
    assert_eq!(
        listener("dns: {enable: false, listen: 'invalid'}").unwrap(),
        None
    );
    assert!(listener("dns: {enable: true, listen: 1053}").is_err());
    let runtime = tokio::runtime::Runtime::new().unwrap();
    for raw in [
        "dns: {enable: false}",
        "dns: {enable: true}",
        "dns: {enable: true, listen: '127.0.0.1:1053'}",
        "dns: {enable: true, listen: '192.0.2.1:53'}",
    ] {
        assert!(runtime
            .block_on(confirm_guard(raw, std::process::id()))
            .is_err());
    }
}

#[test]
fn response_must_be_dns_reply_for_this_probe() {
    let query = [0x12, 0x34, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    let mut response = query;
    response[2] = 0x80;
    response[3] = 1;
    assert!(valid_response(&query, &response));
    assert!(!valid_response(&query, &query));
    assert!(!valid_response(&query, b"HTTP/1.1 200 OK"));
    response[0] = 0x56;
    assert!(!valid_response(&query, &response));
    assert!(!valid_response(&query, &[0x12, 0x34]));
}

#[test]
fn closed_udp_and_tcp_without_dns_response_fail() {
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        let tcp = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = tcp.local_addr().unwrap();
        assert!(
            probe(addr, false).await.is_err(),
            "UDP recv 的内部错误不能视为就绪"
        );
        let server = tokio::spawn(async move {
            let (mut stream, _) = tcp.accept().await.unwrap();
            stream.write_all(b"HTTP/1.1 200 OK\r\n\r\n").await.unwrap();
        });
        assert!(
            probe(addr, true).await.is_err(),
            "仅 TCP 可连接不能视为 DNS 服务"
        );
        server.await.unwrap();
    });
}

#[cfg(windows)]
#[test]
fn foreign_port_owner_is_not_accepted_as_our_core() {
    let (tcp, _udp) = reserve_dns_port();
    let addr = tcp.local_addr().unwrap();
    assert!(ownership(addr, std::process::id(), false).unwrap());
    assert!(ownership(addr, std::process::id(), true).unwrap());
    let raw = format!("dns: {{enable: true, listen: '{addr}'}}");
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        assert!(preflight(&raw, 0).await.unwrap_err().contains("其他进程"));
        assert!(confirm(&raw, u32::MAX)
            .await
            .unwrap_err()
            .contains("其他进程"));
    });
}

#[cfg(windows)]
#[test]
fn native_dns_startup_reload_and_conflict_are_verified() {
    const FLAG: &str = "PROCWEAVER_DNS_RUNTIME_TEST_CHILD";
    if std::env::var_os(FLAG).is_none() {
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "commands::dns_runtime::tests::native_dns_startup_reload_and_conflict_are_verified",
                "--nocapture",
            ])
            .env(FLAG, "1")
            .status()
            .unwrap();
        assert!(status.success());
        return;
    }
    use crate::commands::{process, settings};
    let directory =
        std::env::temp_dir().join(format!("procweaver-dns-runtime-{}", std::process::id()));
    std::fs::create_dir_all(directory.join("config")).unwrap();
    let resources = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_owned();
    crate::storage::initialize_test(directory.clone(), resources);
    // Exercise legacy fixed listening before testing the opt-in automatic policy below.
    std::fs::write(directory.join("config/dns-preferences.json"), b"{}").unwrap();
    std::fs::write(
        directory.join("config/local-rules.json"),
        r#"{"enabled":false,"providers":[]}"#,
    )
    .unwrap();
    let reserve = reserve_dns_port;
    let mixed = reserve();
    let controller = reserve();
    let dns = reserve();
    let next_dns = reserve();
    let prefs = settings::GeneralSettings {
        mixed_port: mixed.0.local_addr().unwrap().port(),
        controller_port: controller.0.local_addr().unwrap().port(),
        ..Default::default()
    };
    std::fs::write(
        directory.join("config/preferences.json"),
        serde_json::to_vec(&prefs).unwrap(),
    )
    .unwrap();
    let dns_addr = dns.0.local_addr().unwrap();
    let next_addr = next_dns.0.local_addr().unwrap();
    let make_raw = |addr| {
        format!("mode: rule\nlog-level: silent\nproxies: []\nrules: ['MATCH,DIRECT']\ndns:\n  enable: true\n  listen: '{addr}'\n  enhanced-mode: redir-host\n  nameserver: ['192.0.2.1']\n")
    };
    let source = directory.join("config/default.yaml");
    // Common subscription form: wildcard DNS must work with LAN sharing disabled.
    let source_raw = make_raw(SocketAddr::new(Ipv4Addr::UNSPECIFIED.into(), dns_addr.port()));
    std::fs::write(&source, &source_raw).unwrap();
    let state = std::sync::Mutex::new(process::CoreState {
        child: None,
        mixed_port: prefs.mixed_port,
        controller_port: prefs.controller_port,
        active_core: None,
        active_core_path: None,
        core_mode: None,
        started_at: None,
    });
    struct Cleanup<'a>(&'a std::sync::Mutex<process::CoreState>);
    impl Drop for Cleanup<'_> {
        fn drop(&mut self) {
            if let Some(mut child) = self.0.lock().unwrap().child.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
            process::ACTIVE.store(false, Ordering::SeqCst);
            process::PID.store(0, Ordering::SeqCst);
        }
    }
    let cleanup = Cleanup(&state);
    drop(mixed);
    drop(controller);
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        // 真实护航入口已持有生命周期锁，内部检查不能再次加锁或修改网卡。
        let error = tokio::time::timeout(
            Duration::from_secs(1),
            crate::commands::dns_adapter::toggle_dns_guard(true),
        )
        .await
        .expect("护航入口不可因重复获取生命周期锁而挂起")
        .unwrap_err();
        assert!(error.contains("未运行"), "{error}");
        // 实际生产启动路径：DNS TCP 被占用时不得创建一个假成功的核心。
        let error = process::start_core_transaction(Some("compatible".into()), &state)
            .await
            .unwrap_err();
        assert!(error.contains("DNS"), "{error}");
        assert!(state.lock().unwrap().child.is_none());
        assert_eq!(process::read_core_status(&state).unwrap().last_start_error.as_deref(), Some(error.as_str()));
        // The same save transaction used by IPC must work offline with a busy port.
        let offline = super::super::dns::get_dns_settings().unwrap();
        super::super::dns::save_dns_settings_transaction(offline, &state).await.unwrap();
        assert!(state.lock().unwrap().child.is_none());
        drop(dns);
        let started = process::start_core_transaction(Some("compatible".into()), &state)
            .await
            .unwrap();
        let mut pid = started.pid.unwrap();
        assert!(process::read_core_status(&state).unwrap().last_start_error.is_none());
        let path = directory.join("core_data/config.yaml");
        let original = std::fs::read_to_string(&path).unwrap();
        assert_eq!(listener(&original).unwrap(), Some(dns_addr));
        assert_eq!(std::fs::read_to_string(&source).unwrap(), source_raw, "运行合成不得修改原始订阅");
        confirm(&original, pid).await.unwrap(); // 故意配置不可达上游，协议就绪不应访问它。
        let previous_preferences = std::fs::read(directory.join("config/dns-preferences.json")).unwrap();
        let rejected = super::super::dns::DnsSettings { listener_mode: Some(super::super::dns::DnsListenerMode::Fixed), listen: next_addr.to_string(), ..Default::default() };
        let error = super::super::dns::save_dns_settings_transaction(rejected, &state).await.unwrap_err();
        assert!(error.contains("旧 DNS 设置和核心已恢复"), "{error}");
        assert_eq!(std::fs::read(directory.join("config/dns-preferences.json")).unwrap(), previous_preferences);
        let recovered = process::read_core_status(&state).unwrap();
        assert!(recovered.running && recovered.last_start_error.is_none());
        pid = recovered.pid.unwrap();
        confirm(&original, pid).await.unwrap();
        let mut candidate: serde_yaml::Value = serde_yaml::from_str(&original).unwrap();
        candidate["dns"]["listen"] = next_addr.to_string().into();
        let candidate = serde_yaml::to_string(&candidate).unwrap();
        let error = crate::routing_overrides::apply_runtime(&candidate)
            .await
            .unwrap_err();
        assert!(error.contains("DNS"), "{error}");
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            original,
            "冲突预检不能覆盖旧运行配置"
        );
        confirm(&original, pid).await.unwrap();
        drop(next_dns);
        let udp_occupied = std::net::UdpSocket::bind(next_addr).unwrap();
        assert!(crate::routing_overrides::apply_runtime(&candidate)
            .await
            .unwrap_err()
            .contains("UDP"));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
        drop(udp_occupied);
        crate::routing_overrides::apply_runtime(&candidate)
            .await
            .unwrap();
        confirm(&candidate, pid).await.unwrap();
        assert!(ownership(next_addr, pid, false).unwrap());
        assert!(ownership(next_addr, pid, true).unwrap());
        crate::routing_overrides::apply_runtime(&original)
            .await
            .unwrap();
        confirm(&original, pid).await.unwrap();
        // 同一核心的 HTTP 控制端口不能冒充 DNS TCP；验证加载后的协议失败与真实回滚。
        let mut wrong_service: serde_yaml::Value = serde_yaml::from_str(&original).unwrap();
        wrong_service["dns"]["listen"] = format!("127.0.0.1:{}", prefs.controller_port).into();
        let error = crate::routing_overrides::apply_runtime(
            &serde_yaml::to_string(&wrong_service).unwrap(),
        )
        .await
        .unwrap_err();
        assert!(
            error.contains("DNS") && error.contains("已恢复旧运行配置"),
            "{error}"
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
        confirm(&original, pid).await.unwrap();
        // 无 listen 的应用层内部 DNS 配置仍可正常应用，不强制要求 53/1053。
        let mut internal: serde_yaml::Value = serde_yaml::from_str(&original).unwrap();
        internal["dns"]
            .as_mapping_mut()
            .unwrap()
            .remove(serde_yaml::Value::from("listen"));
        let internal = serde_yaml::to_string(&internal).unwrap();
        crate::routing_overrides::apply_runtime(&internal)
            .await
            .unwrap();
        confirm(&internal, pid).await.unwrap();
        // Production startup with automatic internal DNS works even while the old
        // subscription DNS port belongs to another service. The source remains intact.
        process::stop_owned_child(&mut state.lock().unwrap()).unwrap();
        let held_tcp = std::net::TcpListener::bind(dns_addr).unwrap();
        let held_udp = std::net::UdpSocket::bind(dns_addr).unwrap();
        std::fs::write(directory.join("config/dns-preferences.json"), b"{\"listenerMode\":\"auto\"}").unwrap();
        let started = process::start_core_transaction(Some("compatible".into()), &state).await.unwrap();
        assert!(started.last_start_error.is_none());
        let automatic = std::fs::read_to_string(&path).unwrap();
        assert_eq!(listener(&automatic).unwrap(), None);
        assert_eq!(std::fs::read_to_string(&source).unwrap(), source_raw);
        // Real runtime application allocates a free TCP+UDP endpoint and remembers
        // it only after readiness, leaving proxy and business listeners unchanged.
        let mut movable: serde_yaml::Value = serde_yaml::from_str(&automatic).unwrap();
        movable["procweaver-dns-listener"]["movable"] = true.into();
        movable["dns"]["listen"] = dns_addr.to_string().into();
        let movable = serde_yaml::to_string(&movable).unwrap();
        crate::routing_overrides::apply_runtime(&movable).await.unwrap();
        let applied = std::fs::read_to_string(&path).unwrap();
        let address = listener(&applied).unwrap().unwrap();
        assert_ne!(address, dns_addr);
        confirm(&applied, started.pid.unwrap()).await.unwrap();
        let cache = std::fs::read(directory.join("config/dns-listener-runtime.json")).unwrap();
        let cached: serde_json::Value = serde_json::from_slice(&cache).unwrap();
        assert_eq!(cached["port"], address.port());
        let mut failed: serde_yaml::Value = serde_yaml::from_str(&applied).unwrap();
        failed["netbox-capture"] = "invalid capture plan".into();
        assert!(crate::routing_overrides::apply_runtime(&serde_yaml::to_string(&failed).unwrap()).await.is_err());
        assert_eq!(std::fs::read(directory.join("config/dns-listener-runtime.json")).unwrap(), cache);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), applied);
        // Full composition must keep stable proxy/bundle entries while synchronizing
        // the capture plan with the final automatic DNS listener.
        use crate::routing_overrides::model::{Overrides, DnsRule, Target};
        let bundle_socket = reserve();
        let bundle_port = bundle_socket.0.local_addr().unwrap().port();
        let node = Target { profile_id: "default".into(), kind: "node".into(), name: "fixture".into() };
        let definition = Overrides { dns_enabled: true, dns_rules: vec![DnsRule {
            id: "dns-fixture".into(), enabled: true, domain_kind: "suffix".into(), domain: "dns-fixture.example.test".into(),
            resolver_url: "https://resolver.example.test/dns-query".into(), target: node.clone(),
        }], bundles: vec![serde_json::from_value(serde_json::json!({
            "id":"listener-fixture","name":"listener-fixture","mainExe":"fixture.exe","enabled":true,
            "mainTarget":node,"dnsTarget":null,"port":bundle_port,"mode":"strict"
        })).unwrap()], ..Default::default() };
        let raw = source_raw.replace("proxies: []", "proxies: [{name: fixture, type: socks5, server: 127.0.0.1, port: 9}]");
        let composed = crate::routing_overrides::prepare(&raw, &definition, "default").unwrap();
        crate::commands::profile::validate_config(&composed).unwrap();
        drop(bundle_socket);
        crate::routing_overrides::apply_runtime(&composed).await.unwrap();
        let actual: serde_yaml::Value = serde_yaml::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let address = parse_listen(actual["dns"]["listen"].as_str().unwrap()).unwrap();
        assert_eq!(actual["netbox-capture"]["dns_port"].as_u64(), Some(address.port() as u64));
        assert_eq!(actual["mixed-port"].as_u64(), Some(prefs.mixed_port as u64));
        assert!(actual["listeners"].as_sequence().unwrap().iter().any(|l| l["port"].as_u64() == Some(bundle_port as u64)));
        assert!(std::net::TcpStream::connect(("127.0.0.1", bundle_port)).is_ok());
        drop((held_tcp, held_udp));
    });
    drop(cleanup);
    std::fs::remove_dir_all(directory).unwrap();
}

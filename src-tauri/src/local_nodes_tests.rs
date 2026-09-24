use super::*;
use serde_json::json;
#[test]
fn node_import_rejects_unknown_fields_and_foreign_config() {
    assert!(preview_local_nodes("proxies: []\nrules: []".into()).is_err());
    assert!(preview_local_nodes("type: naive\nserver: example.test\nport: 443".into()).is_err());
    assert!(preview_local_nodes("type: http\nserver: example.test\nport: 70000".into()).is_err());
    assert!(preview_local_nodes("type: http\nserver: example.test\nport: 80\ndialer-proxy: other".into()).is_err());
    let nodes = preview_local_nodes("proxies:\n- {name: 测试, type: http, server: example.test, port: 443, tls: true}".into()).unwrap();
    assert_eq!(nodes[0].name, "测试"); assert_eq!(nodes[0].config["tls"], true);
    for kind in ["direct", "reject", "dns", "rematch"] { assert!(validate_node(&json!({"type":kind})).is_err()); }
    assert!(validate_node(&json!({"type":"ssh","server":"127.0.0.1","port":22,"username":"fixture","private-key":"C:/private.pem"})).is_err());
    assert!(validate_node(&json!({"type":"tailscale","state-dir":"../outside"})).is_err());
    assert!(validate_node(&json!({"type":"zerotier","network":"8056c2e21c000001","planet":"C:/planet"})).is_err());
    assert!(validate_node(&json!({"type":"hysteria2","server":"127.0.0.1","port":443,"realm-opts":{"enable":true,"private-key":"C:/key.pem"}})).is_err());
    assert!(validate_node(&json!({"type":"mieru","server":"127.0.0.1","port-range":"443-442","transport":"TCP","username":"u","password":"p"})).is_err());
    assert!(validate_node(&json!({"type":"wireguard","private-key":"fake","peers":[]})).is_err());
    let overlay = Store { revision: 1, nodes: vec![Node { id:"a1".into(), name:"overlay".into(), config:json!({"type":"tailscale","hostname":"fixture"}) }, Node { id:"a2".into(), name:"overlay2".into(), config:json!({"type":"tailscale","hostname":"fixture2"}) }] };
    let composed: serde_yaml::Value = serde_yaml::from_str(&compose("proxies: []", &overlay).unwrap()).unwrap();
    assert_eq!(composed["proxies"][0]["state-dir"].as_str(), Some("local-node-state/PW-L-a1"));
    assert_eq!(composed["proxies"][1]["state-dir"].as_str(), Some("local-node-state/PW-L-a2"));
}
#[test]
fn local_node_identity_survives_rename_and_source_change() {
    let node = Node { id: "a1".into(), name: "本地一".into(), config: json!({"type":"http","server":"127.0.0.1","port":9}) };
    let mut renamed = node.clone(); renamed.name = "改名后".into();
    assert_eq!(node.target(), renamed.target());
    let raw = "proxies: []\nproxy-groups: []\nrules: [MATCH,DIRECT]";
    let materialized = compose(raw, &Store { revision: 1, nodes: vec![node.clone()] }).unwrap();
    let yaml: serde_yaml::Value = serde_yaml::from_str(&materialized).unwrap();
    assert_eq!(yaml["proxies"][0]["name"].as_str(), Some(node.alias().as_str()));
    assert_eq!(yaml["proxy-groups"][0]["proxies"][0].as_str(), Some(node.alias().as_str()));
    for active in ["default", "subscription-a", "subscription-b"] {
        let mut target = node.target(); remap(&mut target, active); assert_eq!(target.profile_id, active); assert_eq!(target.name, node.alias());
    }
    assert!(compose(&materialized, &Store { revision: 1, nodes: vec![node] }).is_err(), "reserved alias collision must be explicit");
}

#[cfg(windows)]
#[test]
fn native_local_nodes_validate_apply_rename_switch_and_rollback() {
    const NAME: &str = "local_nodes::tests::native_local_nodes_validate_apply_rename_switch_and_rollback";
    const FLAG: &str = "PROCWEAVER_LOCAL_NODE_TEST";
    if std::env::var_os(FLAG).is_none() {
        let status = std::process::Command::new(std::env::current_exe().unwrap()).args(["--exact", NAME, "--nocapture"]).env(FLAG, "1").status().unwrap(); assert!(status.success()); return;
    }
    let dir = std::env::temp_dir().join(format!("procweaver-local-nodes-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    crate::storage::initialize_test(dir.clone(), std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_owned());
    let free = || crate::storage::reserve_test_mixed_port().local_addr().unwrap().port();
    let preferences = crate::commands::settings::GeneralSettings { mixed_port: free(), controller_port: free(), ..Default::default() };
    std::fs::write(dir.join("config/preferences.json"), serde_json::to_vec(&preferences).unwrap()).unwrap();
    std::fs::write(dir.join("config/local-rules.json"), r#"{"enabled":false,"providers":[]}"#).unwrap();
    std::fs::write(dir.join("config/default.yaml"), "proxies: []\nrules: ['MATCH,DIRECT']\n").unwrap();
    // All offered protocols are validated by the bundled binary, using fake keys
    // and loopback destinations. Validation does not contact remote proxy servers.
    let uuid = "00000000-0000-4000-8000-000000000001";
    let key = "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=";
    let options = [json!({"type":"vmess","uuid":uuid,"alterId":0,"cipher":"auto"}), json!({"type":"vless","uuid":uuid}),
        json!({"type":"vless","uuid":uuid,"flow":"xtls-rprx-vision","tls":true,"servername":"front.example.test","client-fingerprint":"iOS","reality-opts":{"public-key":key.trim_end_matches('='),"short-id":"57fb"}}),
        json!({"type":"ss","cipher":"aes-128-gcm","password":"fixture"}), json!({"type":"trojan","password":"fixture"}),
        json!({"type":"hysteria2","password":"fixture"}), json!({"type":"wireguard","ip":"10.0.0.2","private-key":key,"public-key":key}),
        json!({"type":"socks5"}), json!({"type":"http","tls":true}), json!({"type":"tuic","uuid":uuid,"password":"fixture"}), json!({"type":"tuic","token":"fixture"}), json!({"type":"anytls","password":"fixture"})];
    let mut options = options.to_vec();
    options.extend([
        json!({"type":"ssr","cipher":"aes-128-ctr","password":"fixture","protocol":"auth_aes128_sha1","obfs":"plain"}),
        json!({"type":"hysteria","auth-str":"fixture","up":"10 Mbps","down":"50 Mbps","obfs":"fixture"}),
        json!({"type":"snell","psk":"fixture","version":3}), json!({"type":"ssh","username":"fixture","password":"fixture"}),
        json!({"type":"mieru","username":"fixture","password":"fixture","transport":"TCP"}),
        json!({"type":"shadowquic","username":"fixture","password":"fixture"}), json!({"type":"gost-relay","username":"fixture","password":"fixture"}),
        json!({"type":"sudoku","key":"fixture"}), json!({"type":"trusttunnel","username":"fixture","password":"fixture"}),
        json!({"type":"tailscale","hostname":"fixture","control-url":"http://127.0.0.1:9"}),
        json!({"type":"zerotier","network":"8056c2e21c000001"}),
        json!({"type":"easytier","network-name":"fixture","network-secret":"fixture","peers":["tcp://127.0.0.1:9"],"no-listener":true}),
        // Self-signed, synthetic test material; no remote service uses these keys.
        json!({"type":"masque","ip":"10.0.0.2","private-key":"MHcCAQEEIEevK61yKlnpvleNeuvISHRdmOQoFCaaVdONN+2E8Y4moAoGCCqGSM49AwEHoUQDQgAEZznCjKm9UB/51z6WjDJXBHsSCgo14hzEaEmFhROmJvkXrGDGVY8Y6c/I8RjM5Avzp0KVgdesiSwcQbMteysdVA==","public-key":"MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEZznCjKm9UB/51z6WjDJXBHsSCgo14hzEaEmFhROmJvkXrGDGVY8Y6c/I8RjM5Avzp0KVgdesiSwcQbMteysdVA=="}),
        json!({"type":"openvpn","proto":"udp","ca":"-----BEGIN CERTIFICATE-----\nMIIBOTCB4KADAgECAghAmtDGXfCmazAKBggqhkjOPQQDAjAiMSAwHgYDVQQDExdw\ncm9jd2VhdmVyLXRlc3QuaW52YWxpZDAgFw0yMDAxMDEwMDAwMDBaGA8yMTAwMDEw\nMTAwMDAwMFowIjEgMB4GA1UEAxMXcHJvY3dlYXZlci10ZXN0LmludmFsaWQwWTAT\nBgcqhkjOPQIBBggqhkjOPQMBBwNCAARnOcKMqb1QH/nXPpaMMlcEexIKCjXiHMRo\nSYWFE6Ym+ResYMZVjxjpz8jxGMzkC/OnQpWB16yJLBxBsy17Kx1UMAoGCCqGSM49\nBAMCA0gAMEUCIE8t0ovym0Wme0DXAcLHKyv5hyq7q5gHYjTQnsVVC0FcAiEAxYUX\n8aH8Rmo2UzNYbKlPW5lSqQXe7+XmRAjfyXGgHm4=\n-----END CERTIFICATE-----","cert":"-----BEGIN CERTIFICATE-----\nMIIBOTCB4KADAgECAghAmtDGXfCmazAKBggqhkjOPQQDAjAiMSAwHgYDVQQDExdw\ncm9jd2VhdmVyLXRlc3QuaW52YWxpZDAgFw0yMDAxMDEwMDAwMDBaGA8yMTAwMDEw\nMTAwMDAwMFowIjEgMB4GA1UEAxMXcHJvY3dlYXZlci10ZXN0LmludmFsaWQwWTAT\nBgcqhkjOPQIBBggqhkjOPQMBBwNCAARnOcKMqb1QH/nXPpaMMlcEexIKCjXiHMRo\nSYWFE6Ym+ResYMZVjxjpz8jxGMzkC/OnQpWB16yJLBxBsy17Kx1UMAoGCCqGSM49\nBAMCA0gAMEUCIE8t0ovym0Wme0DXAcLHKyv5hyq7q5gHYjTQnsVVC0FcAiEAxYUX\n8aH8Rmo2UzNYbKlPW5lSqQXe7+XmRAjfyXGgHm4=\n-----END CERTIFICATE-----","key":"-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgR68rrXIqWem+V416\n68hIdF2Y5CgUJppV04037YTxjiahRANCAARnOcKMqb1QH/nXPpaMMlcEexIKCjXi\nHMRoSYWFE6Ym+ResYMZVjxjpz8jxGMzkC/OnQpWB16yJLBxBsy17Kx1U\n-----END PRIVATE KEY-----"}),
    ]);
    let nodes: Vec<_> = options.into_iter().enumerate().map(|(i, mut config)| { if !OVERLAYS.contains(&config["type"].as_str().unwrap()) { config["server"] = "127.0.0.1".into(); config["port"] = 9.into(); } Node { id: format!("{i:x}"), name: format!("fixture-{i}"), config } }).collect();
    let fixture = Store { revision: 0, nodes }; check_store(&fixture).unwrap();
    let raw = compose("proxies: []\nrules: ['MATCH,DIRECT']\n", &fixture).unwrap();
    if let Err(error) = profile::validate_config(&raw) {
        let validation = dir.join("protocol-validation.yaml"); std::fs::write(&validation, &raw).unwrap();
        let output = std::process::Command::new(profile::validation_core().unwrap()).arg("-t").arg("-d").arg(dir.join("core_data")).arg("-f").arg(&validation).output().unwrap();
        panic!("protocol fixture validation: {error}; {} {}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
    }
    let state = std::sync::Mutex::new(process::CoreState { child: None, mixed_port: preferences.mixed_port, controller_port: preferences.controller_port, active_core: None, active_core_path: None, core_mode: None, started_at: None });
    struct Cleanup<'a>(&'a std::sync::Mutex<process::CoreState>);
    impl Drop for Cleanup<'_> { fn drop(&mut self) { if let Ok(mut guard) = self.0.lock() { let _ = process::stop_owned_child(&mut guard); } } }
    let _cleanup = Cleanup(&state);
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap(); let upstream_port = upstream.local_addr().unwrap().port();
        let server = tokio::spawn(async move { loop { let (mut socket, _) = upstream.accept().await.unwrap(); tokio::spawn(async move {
            let mut header = Vec::new(); let mut b = [0];
            while !header.ends_with(b"\r\n\r\n") && header.len() < 8192 { if socket.read_exact(&mut b).await.is_err() { return; } header.push(b[0]); }
            if socket.write_all(b"HTTP/1.1 200 Connection established\r\n\r\n").await.is_err() { return; }
            if socket.read_exact(&mut b).await.is_ok() { let _ = socket.write_all(b"local-ok\n").await; }
        }); } });
        let draft = |id: Option<String>, name: &str| Draft { id, name: name.into(), config: json!({"type":"http","server":"127.0.0.1","port":upstream_port}) };
        let saved = save_local_nodes(0, vec![draft(None, "自定义入口")], vec![]).await.unwrap();
        assert!(!saved.running); let node = read().unwrap().nodes[0].clone();
        let mut rules = Overrides::default();
        rules.bundles.push(routing_overrides::model::BundleRoute { id: "local-test".into(), name: "测试包".into(), main_exe: "fixture.exe".into(), enabled: true, main_target: Some(node.target()), dns_target: None, port: 0, mode: "strict".into(), domains: vec![], fallback: "rules".into() });
        let rules = routing_overrides::save(rules, vec![]).await.unwrap(); let port = rules.config.bundles[0].port;
        process::start_core_transaction(Some("compatible".into()), &state).await.unwrap();
        async fn verify(port: u16) {
            let mut socket = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
            socket.write_all(b"CONNECT 192.0.2.44:443 HTTP/1.1\r\nHost: 192.0.2.44:443\r\n\r\n").await.unwrap();
            let mut header = Vec::new(); let mut b = [0];
            while !header.ends_with(b"\r\n\r\n") { tokio::time::timeout(std::time::Duration::from_secs(5), socket.read_exact(&mut b)).await.unwrap().unwrap(); header.push(b[0]); assert!(header.len() < 8192); }
            socket.write_all(b"?").await.unwrap(); let mut answer = [0; 9]; tokio::time::timeout(std::time::Duration::from_secs(5), socket.read_exact(&mut answer)).await.unwrap().unwrap(); assert_eq!(&answer, b"local-ok\n");
        }
        verify(port).await;
        let renamed = save_local_nodes(saved.revision, vec![draft(Some(node.id.clone()), "重命名入口")], vec![]).await.unwrap();
        assert_eq!(read().unwrap().nodes[0].alias(), node.alias()); assert_eq!(routing_overrides::read().unwrap().bundles[0].main_target, Some(node.target())); verify(port).await;
        assert!(save_local_nodes(saved.revision, vec![draft(None, "过时保存")], vec![]).await.err().unwrap().contains("其他页面"));
        assert!(save_local_nodes(renamed.revision, vec![], vec![node.id.clone()]).await.err().unwrap().contains("测试包"));
        // Applying another source does not need cross-subscription retention for local targets.
        let next = "proxies: []\nrules: ['MATCH,DIRECT']\n";
        let candidate = routing_overrides::prepare(next, &routing_overrides::read().unwrap(), "other-source").unwrap();
        { let _lock = process::LIFECYCLE.lock().await; routing_overrides::apply_runtime(&candidate).await.unwrap(); }
        verify(port).await;
        // Failed disk commit must restore exactly the old running file.
        let before = std::fs::read_to_string(dir.join("core_data/config.yaml")).unwrap();
        use std::os::windows::fs::OpenOptionsExt;
        let locked = std::fs::OpenOptions::new().read(true).share_mode(1).open(path()).unwrap();
        assert!(save_local_nodes(renamed.revision, vec![draft(Some(node.id.clone()), "不能保存")], vec![]).await.is_err()); drop(locked);
        assert_eq!(std::fs::read_to_string(dir.join("core_data/config.yaml")).unwrap(), before); assert_eq!(read().unwrap().nodes[0].name, "重命名入口"); verify(port).await;
        process::stop_owned_child(&mut state.lock().unwrap()).unwrap();
        process::start_core_transaction(Some("compatible".into()), &state).await.unwrap(); verify(port).await;
        let mut config = routing_overrides::read().unwrap(); config.bundles.clear(); routing_overrides::save(config, vec![]).await.unwrap();
        let deleted = save_local_nodes(renamed.revision, vec![], vec![node.id]).await.unwrap(); assert!(deleted.nodes.is_empty());
        process::stop_owned_child(&mut state.lock().unwrap()).unwrap(); server.abort();
    });
    std::fs::remove_dir_all(dir).unwrap();
}

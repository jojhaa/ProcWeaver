//! Isolated real-core proof of owner context selection, without loading WinDivert.
use super::*;
use crate::capture::windivert::plan::{Plan, KEY};
use std::{os::windows::process::CommandExt, process::{Child, Command, Stdio}, time::Duration};

struct Core(Child);
impl Drop for Core { fn drop(&mut self) { let _ = self.0.kill(); let _ = self.0.wait(); } }

#[test]
fn same_path_instance_owners_reach_distinct_core_outlets_and_preserve_fallback() {
    const NAME: &str = "routing_overrides::instance_runtime_tests::same_path_instance_owners_reach_distinct_core_outlets_and_preserve_fallback";
    if std::env::var_os("PW_INSTANCE_CORE_TEST").is_none() {
        assert!(Command::new(std::env::current_exe().unwrap()).args(["--exact", NAME, "--nocapture"])
            .env("PW_INSTANCE_CORE_TEST", "1").creation_flags(0x08000000).status().unwrap().success()); return;
    }
    let dir = std::env::temp_dir().join(format!("pw-instance-core-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    crate::storage::initialize_test(dir.clone(), std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf());
    let reserved: Vec<_> = (0..4).map(|_| crate::storage::reserve_test_mixed_port()).collect();
    let ports: Vec<_> = reserved.iter().map(|s| s.local_addr().unwrap().port()).collect();
    let preferences = settings::GeneralSettings { mixed_port: ports[0], controller_port: ports[1], traffic_mode: "windivert_v1".into(), ..Default::default() };
    std::fs::write(dir.join("config/preferences.json"), serde_json::to_vec(&preferences).unwrap()).unwrap();
    std::fs::write(dir.join("config/local-rules.json"), r#"{"enabled":false,"providers":[]}"#).unwrap();
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut proxies = vec![]; let mut servers = vec![];
        for name in ["ExitA", "ExitB", "Original"] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            proxies.push(serde_json::json!({"name":name,"type":"http","server":"127.0.0.1","port":listener.local_addr().unwrap().port()}));
            servers.push(tokio::spawn(async move { loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                tokio::spawn(async move {
                    let mut header = vec![]; let mut byte = [0];
                    while header.len() < 8192 && !header.ends_with(b"\r\n\r\n") {
                        if socket.read_exact(&mut byte).await.is_err() { return; } header.push(byte[0]);
                    }
                    if socket.write_all(b"HTTP/1.1 200 Connection established\r\n\r\n").await.is_err() { return; }
                    if socket.read_exact(&mut byte).await.is_ok() { let _ = socket.write_all(format!("{name}\n").as_bytes()).await; }
                });
            }}));
        }
        let target = |name: &str| Target { profile_id: "default".into(), kind: "node".into(), name: name.into() };
        let mut config = Overrides { process_enabled: true, ..Default::default() };
        for (i, id, exit) in [(2, "a", "ExitA"), (3, "b", "ExitB")] {
            let path = format!(r"C:\{id}\app.exe");
            config.bundles.push(BundleRoute { id: id.into(), name: id.into(), main_exe: path.clone(), enabled: true,
                main_target: Some(target(exit)), dns_target: None, port: ports[i], mode: "sandbox".into(),
                domains: vec!["selected.example.test".into()], fallback: "rules".into() });
            config.process_rules.push(ProcessRule { id: format!("bundle-{id}-root"), enabled: true, label: id.into(),
                match_kind: "path".into(), match_value: path, action: "proxy".into(), target: Some(target(exit)), include_descendants: true, rule_mode: Some("inherit".into()) });
        }
        let raw = serde_yaml::to_string(&serde_json::json!({"proxies":proxies,"dns":{"enable":false,"use-system-hosts":false},
            "rules":["DOMAIN,excluded.example.test,Original", "PROCESS-NAME,node.exe,Original", "MATCH,REJECT"]})).unwrap();
        let child = |pid, id: &str| tracker::ProcessEntry { identity: format!("{pid}:100"), pid, created_at: 100, parent_pid: 1,
            name: "node.exe".into(), executable_path: Some(r"C:\Shared\node.exe".into()), parent_identity: Some("1:10".into()),
            ancestors: vec![("1:10".into(), format!(r"C:\{id}\app.exe"))] };
        tracker::reconcile(vec![child(201, "a"), child(202, "b")], true);
        assert_eq!(tracker::status(&config).conflicts.len(), 1, "legacy path rules cannot separate these roots");
        let prepared = prepare_plan(&raw, &config, "default", false, &crate::local_nodes::Store::default()).unwrap();
        let resolved = crate::capture::windivert::ports::resolve_for_apply(&prepared, 0).await.unwrap();
        let yaml: serde_yaml::Value = serde_yaml::from_str(&resolved).unwrap();
        let plan: Plan = serde_yaml::from_value(yaml[KEY].clone()).unwrap();
        let path = r"C:\Shared\node.exe";
        let a = plan.port_for(path, 201, 100).unwrap(); let b = plan.port_for(path, 202, 100).unwrap(); assert_ne!(a, b);
        assert!(plan.port_for(path, 203, 100).is_none());
        assert!(!yaml["rules"].as_sequence().unwrap().iter().any(|r| r.as_str().is_some_and(|s| s.contains(path))), "no inherited global path rule");
        // Changing all child PIDs and paths cannot alter the core configuration.
        let mut new_child = child(211, "a"); new_child.executable_path = Some(r"D:\new\worker.exe".into()); new_child.name = "worker.exe".into();
        tracker::reconcile(vec![new_child, child(212, "b")], true);
        let after = prepare_plan(&raw, &config, "default", false, &crate::local_nodes::Store::default()).unwrap();
        assert_eq!(bundles::structural(&prepared).unwrap(), bundles::structural(&after).unwrap());
        let restored = crate::capture::current_instance_plan(&yaml).unwrap();
        assert!(restored.port_for(path, 201, 100).is_none(), "rollback must not restore an exited PID from disk");
        assert_eq!(restored.port_for(r"D:\new\worker.exe", 211, 100), plan.entries.iter().find(|e| e.owner == "bundle:a" && e.kind == "any").map(|e| e.port));
        assert_eq!(restored.port_for(path, 212, 100), Some(b));
        let mut missing_policy = yaml.clone(); missing_policy.as_mapping_mut().unwrap().remove(serde_yaml::Value::from("netbox-capture"));
        assert!(crate::capture::current_instance_plan(&missing_policy).is_err());
        std::fs::write(dir.join("config.yaml"), &resolved).unwrap(); drop(reserved);
        let child = Command::new(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries/mihomo-compatible.exe"))
            .arg("-d").arg(&dir).creation_flags(0x08000000).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
        let mut core = Core(child);
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while tokio::net::TcpStream::connect(("127.0.0.1", b)).await.is_err() {
            assert!(core.0.try_wait().unwrap().is_none()); assert!(tokio::time::Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        // Select package exits in the isolated core, never the user's controller.
        bundles::select(&resolved).await.unwrap();
        async fn marker(port: u16, domain: &str) -> String {
            tokio::time::timeout(Duration::from_secs(5), async {
                let mut socket = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
                socket.write_all(&[5,1,0]).await.unwrap(); let mut hello = [0;2]; socket.read_exact(&mut hello).await.unwrap(); assert_eq!(hello, [5,0]);
                let mut req = vec![5,1,0,3,domain.len() as u8]; req.extend_from_slice(domain.as_bytes()); req.extend_from_slice(&443u16.to_be_bytes());
                socket.write_all(&req).await.unwrap(); let mut reply = [0;10]; socket.read_exact(&mut reply).await.unwrap(); assert_eq!(reply[1], 0);
                socket.write_all(b"?").await.unwrap(); let mut line = vec![]; let mut byte = [0];
                while line.len() < 32 { socket.read_exact(&mut byte).await.unwrap(); if byte[0] == b'\n' { break; } line.push(byte[0]); }
                String::from_utf8(line).unwrap()
            }).await.expect("isolated route probe timeout")
        }
        assert_eq!(marker(a, "selected.example.test").await, "ExitA");
        assert_eq!(marker(b, "selected.example.test").await, "ExitB");
        for port in [a, b] {
            assert_eq!(marker(port, "unmatched.example.test").await, "Original", "fallback must see original node.exe");
        }
        // Single selector change keeps the other package's context and original fallback.
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let mut url = reqwest::Url::parse(&format!("http://127.0.0.1:{}/proxies/", preferences.controller_port)).unwrap();
        url.path_segments_mut().unwrap().pop_if_empty().push(&bundles::group("a", "main"));
        client.put(url).json(&serde_json::json!({"name":"Original"})).send().await.unwrap().error_for_status().unwrap();
        assert_eq!(marker(a, "selected.example.test").await, "Original");
        assert_eq!(marker(b, "selected.example.test").await, "ExitB");
        drop(core); for server in servers { server.abort(); }
        println!("shared path: A/B distinct exits; original process fallback; unrelated instance bypass; stable core structure; single-package switch passed");
    });
    let _ = std::fs::remove_dir_all(dir);
}

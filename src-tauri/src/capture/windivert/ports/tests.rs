use super::*;
use crate::routing_overrides::model::{Overrides, ProcessRule};
use std::{io::{Read, Write}, os::windows::process::CommandExt, process::{Child, Command, Stdio}, time::{Duration, Instant}};

fn fixture(names: &[&str]) -> String {
    let config = Overrides { process_enabled: true, process_rules: names.iter().enumerate().map(|(i, name)| ProcessRule {
        id: format!("test{i}"), enabled: true, label: "fixture".into(), match_kind: "name".into(),
        match_value: (*name).into(), action: "direct".into(), target: None, include_descendants: false, rule_mode: None,
    }).collect(), ..Overrides::default() };
    let rules: Vec<_> = names.iter().map(|name| format!("PROCESS-NAME,{name},DIRECT")).chain(["MATCH,REJECT".into()]).collect();
    super::super::plan::compose(&serde_yaml::to_string(&serde_json::json!({"rules":rules})).unwrap(), &config).unwrap()
}

fn plan(raw: &str) -> Plan { serde_yaml::from_value(serde_yaml::from_str::<Value>(raw).unwrap()[KEY].clone()).unwrap() }

fn sockets() -> (TcpListener, UdpSocket) { (61000..65000).find_map(reserve).expect("fixture needs a free paired port") }
fn relocate(raw: &str, ports: &[u16]) -> String {
    let mut yaml: Value = serde_yaml::from_str(raw).unwrap();
    let mut plan: Plan = serde_yaml::from_value(yaml[KEY].clone()).unwrap();
    assert_eq!(plan.entries.len(), ports.len());
    for (entry, port) in plan.entries.iter_mut().zip(ports) {
        let name = format!("pw-wd-{}", entry.id().unwrap());
        for listener in yaml["listeners"].as_sequence_mut().unwrap() {
            if listener["name"].as_str() == Some(&name) { listener["port"] = (*port).into(); }
        }
        for target in &mut plan.targets { if target.owner == entry.owner && target.port == entry.port { target.port = *port; } }
        entry.port = *port;
    }
    yaml[KEY] = serde_yaml::to_value(plan).unwrap();
    serde_yaml::to_string(&yaml).unwrap()
}

#[test]
fn skips_tcp_udp_and_configured_ports_without_rewriting_user_listeners() {
    let (tcp, udp1) = sockets(); let tcp_port = tcp.local_addr().unwrap().port(); drop(udp1);
    let (tcp2, udp) = sockets(); let udp_port = udp.local_addr().unwrap().port(); drop(tcp2);
    let (tcp3, udp3) = sockets(); let config_port = tcp3.local_addr().unwrap().port(); drop((tcp3, udp3));
    let raw = relocate(&fixture(&["port-a.exe", "port-b.exe", "port-c.exe"]), &[tcp_port, udp_port, config_port]);
    let mut yaml: Value = serde_yaml::from_str(&raw).unwrap();
    let user_listener = serde_yaml::to_value(serde_json::json!({"name":"user-port","type":"http","listen":"127.0.0.1","port":config_port})).unwrap();
    yaml["listeners"].as_sequence_mut().unwrap().push(user_listener.clone());
    let raw = serde_yaml::to_string(&yaml).unwrap();
    let result = resolve(&raw, None).unwrap(); let plan = plan(&result);
    for entry in &plan.entries {
        assert!(![tcp_port, udp_port, config_port].contains(&entry.port));
        assert!(reserve(entry.port).is_some());
        assert!(plan.targets.iter().any(|t| t.owner == entry.owner && t.port == entry.port));
    }
    let result: Value = serde_yaml::from_str(&result).unwrap();
    assert_eq!(result["rules"], yaml["rules"]);
    assert_eq!(result["sub-rules"], yaml["sub-rules"]);
    assert_eq!(result["listeners"].as_sequence().unwrap().last(), Some(&user_listener));
}

#[test]
fn reuses_only_confirmed_identity_with_both_owned_transports() {
    let raw = fixture(&["port-reuse.exe"]);
    let original = plan(&raw).entries[0].port;
    let held = (61000..65000).filter(|p| *p != original).find_map(reserve).unwrap();
    let port = held.0.local_addr().unwrap().port();
    let old = plan(&relocate(&raw, &[port]));
    let core = Identity::inspect(std::process::id()).unwrap();
    let previous = (old.clone(), core.clone());
    assert_eq!(plan(&resolve(&raw, Some(&previous)).unwrap()).entries[0].port, port);
    let mut stale = core.clone(); stale.created_at += 1;
    assert_ne!(plan(&resolve(&raw, Some(&(old.clone(), stale))).unwrap()).entries[0].port, port);
    let (tcp, udp) = held; drop(udp);
    assert_ne!(plan(&resolve(&raw, Some(&(old, core))).unwrap()).entries[0].port, port);
    drop(tcp);
}

#[test]
fn rejects_exhaustion_and_mismatched_generated_inlets_before_apply() {
    let raw = fixture(&["port-exhaustion.exe"]);
    let mut yaml: Value = serde_yaml::from_str(&raw).unwrap();
    yaml["listeners"].as_sequence_mut().unwrap().push(serde_yaml::from_str("name: user-range\nports: 61000-64999\n").unwrap());
    assert!(resolve(&serde_yaml::to_string(&yaml).unwrap(), None).unwrap_err().contains("没有可用"));
    yaml["listeners"][0]["udp"] = false.into();
    assert!(resolve(&serde_yaml::to_string(&yaml).unwrap(), None).unwrap_err().contains("不一致"));
    assert_eq!(resolve("rules: ['MATCH,DIRECT']\n", None).unwrap(), "rules: ['MATCH,DIRECT']\n");
}

struct Core(Child, std::path::PathBuf);
impl Drop for Core {
    fn drop(&mut self) { let _ = self.0.kill(); let _ = self.0.wait(); let _ = std::fs::remove_dir_all(&self.1); }
}

#[test]
fn real_core_resolved_ports_bind_tcp_udp_and_survive_reload() {
    let pool = tokio::runtime::Runtime::new().unwrap();
    let mixed = crate::storage::reserve_test_mixed_port(); let mixed_port = mixed.local_addr().unwrap().port();
    let controller = crate::storage::reserve_test_mixed_port(); let controller_port = controller.local_addr().unwrap().port();
    let raw = fixture(&["port-native.exe"]);
    let blocked = sockets(); let blocked_port = blocked.0.local_addr().unwrap().port();
    let mut yaml: Value = serde_yaml::from_str(&relocate(&raw, &[blocked_port])).unwrap();
    yaml["mixed-port"] = mixed_port.into(); yaml["external-controller"] = format!("127.0.0.1:{controller_port}").into();
    yaml["log-level"] = "silent".into(); yaml["dns"] = serde_yaml::from_str("enable: false\n").unwrap();
    yaml["proxies"] = Value::Sequence(vec![]);
    let raw = serde_yaml::to_string(&yaml).unwrap();
    let resolved = pool.block_on(resolve_for_apply(&raw, 0)).unwrap();
    let resolved_plan = plan(&resolved);
    let port = resolved_plan.entries[0].port; assert_ne!(port, blocked_port);
    let directory = std::env::temp_dir().join(format!("pw-wd-inlets-{}", std::process::id()));
    std::fs::create_dir_all(&directory).unwrap(); let path = directory.join("config.yaml");
    std::fs::write(&path, &resolved).unwrap(); drop((mixed, controller));
    let child = Command::new(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries/mihomo-compatible.exe"))
        .arg("-d").arg(&directory).creation_flags(0x08000000).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
    let mut core = Core(child, directory);
    let deadline = Instant::now() + Duration::from_secs(5);
    while !owned(port, core.0.id(), 6) || !owned(port, core.0.id(), 17) {
        assert!(core.0.try_wait().unwrap().is_none(), "isolated core exited");
        assert!(Instant::now() < deadline, "core must own TCP and UDP inlets");
        std::thread::sleep(Duration::from_millis(20));
    }
    let identity = Identity::inspect(core.0.id()).unwrap();
    super::super::session::validate_core(&resolved_plan, &identity).unwrap();
    drop(blocked); // Preferred hash/original port can become free during a reload.
    let previous = (resolved_plan.clone(), identity.clone());
    let next = resolve(&raw, Some(&previous)).unwrap();
    assert_eq!(plan(&next), resolved_plan);
    std::fs::write(&path, &next).unwrap();
    pool.block_on(async {
        let response = reqwest::Client::builder().no_proxy().timeout(Duration::from_secs(3)).build().unwrap()
            .put(format!("http://127.0.0.1:{controller_port}/configs?force=true"))
            .json(&serde_json::json!({"path":path.to_string_lossy()})).send().await.unwrap();
        assert!(response.status().is_success());
    });
    super::super::session::validate_core(&resolved_plan, &identity).unwrap();
    let tcp = TcpListener::bind("127.0.0.1:0").unwrap(); let tcp_target = tcp.local_addr().unwrap();
    tcp.set_nonblocking(true).unwrap();
    let worker = std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if let Ok((mut stream, _)) = tcp.accept() { stream.write_all(b"PW!").unwrap(); return; }
            std::thread::sleep(Duration::from_millis(10));
        }
        panic!("TCP fixture not reached");
    });
    let (mut stream, _) = super::super::socks::connect_with_timeout(port, tcp_target, false, Duration::from_secs(2)).unwrap();
    let mut marker = [0; 3]; stream.read_exact(&mut marker).unwrap(); assert_eq!(&marker, b"PW!"); worker.join().unwrap();
    let udp = UdpSocket::bind("127.0.0.1:0").unwrap(); let udp_target = udp.local_addr().unwrap();
    udp.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
    let worker = std::thread::spawn(move || {
        let mut bytes = [0; 512]; let (length, peer) = udp.recv_from(&mut bytes).unwrap();
        bytes[2] |= 0x80; udp.send_to(&bytes[..length], peer).unwrap();
    });
    let association = super::super::udp::Association::connect(port, udp_target, Duration::from_secs(2)).unwrap();
    let query = b"\x12\x34\x01\x00\x00\x01\x00\x00\x00\x00\x00\x00\x02pw\x07invalid\x00\x00\x01\x00\x01";
    association.send(query).unwrap(); let mut reply = Vec::new(); association.receive(&mut reply).unwrap();
    assert!(super::super::dns::Question::parse_query(query).unwrap().matches_reply(&reply)); worker.join().unwrap();
    let impostor = Identity::inspect(std::process::id()).unwrap();
    assert!(super::super::session::validate_core(&resolved_plan, &impostor).is_err());
}

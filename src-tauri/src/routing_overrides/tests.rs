use super::*;
use serde_yaml::Value;
fn rule(path: &str) -> ProcessRule { ProcessRule { id: path.into(), enabled: true, label: path.into(), match_kind: "path".into(), match_value: path.into(), action: "proxy".into(), target: Some(target("node")), include_descendants: true, rule_mode: None } }
fn target(name: &str) -> Target { Target { profile_id: "default".into(), kind: "node".into(), name: name.into() } }
fn config() -> Overrides { Overrides { process_enabled: true, process_rules: vec![rule(r"C:\apps\root.exe")], ..Overrides::default() } }
const RAW: &str = "proxies:\n- {name: node, type: socks5, server: 127.0.0.1, port: 1, udp: false}\nrules: ['DOMAIN,example.net,DIRECT', 'MATCH,DIRECT']\n";

#[cfg(windows)]
#[test]
fn native_bundle_outlet_is_independent_of_public_selection() {
    const FLAG: &str = "PROCWEAVER_BUNDLE_ROUTE_TEST";
    if std::env::var_os(FLAG).is_none() {
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "routing_overrides::tests::native_bundle_outlet_is_independent_of_public_selection", "--nocapture"])
            .env(FLAG, "1").status().unwrap();
        assert!(status.success()); return;
    }
    use std::{io::{Read, Write}, net::{TcpListener, TcpStream}, sync::{Arc, atomic::AtomicBool}, time::Duration};
    use std::os::windows::process::CommandExt;
    let dir = std::env::temp_dir().join(format!("procweaver-bundle-route-{}", std::process::id()));
    std::fs::create_dir_all(dir.join("config")).unwrap();
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf();
    crate::storage::initialize_test(dir.clone(), root.clone());
    std::fs::write(dir.join("config/local-rules.json"), r#"{"enabled":false,"providers":[]}"#).unwrap();
    let reserve = || TcpListener::bind("127.0.0.1:0").unwrap();
    let mixed = reserve(); let mixed_port = mixed.local_addr().unwrap().port();
    let controller = reserve(); let controller_port = controller.local_addr().unwrap().port();
    let done = Arc::new(AtomicBool::new(false));
    struct Finish(Arc<AtomicBool>);
    impl Drop for Finish { fn drop(&mut self) { self.0.store(true, Ordering::SeqCst); } }
    let _finish = Finish(done.clone());
    let mut servers = vec![];
    let mut ports = vec![];
    for marker in ["bundle-HK", "public-JP", "public-SG"] {
        let listener = reserve(); ports.push(listener.local_addr().unwrap().port());
        listener.set_nonblocking(true).unwrap();
        let done = done.clone();
        servers.push(std::thread::spawn(move || {
            while !done.load(Ordering::SeqCst) {
                let Ok((mut stream, _)) = listener.accept() else { std::thread::sleep(Duration::from_millis(5)); continue; };
                stream.set_nonblocking(false).unwrap();
                stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
                fn header(stream: &mut TcpStream) -> Vec<u8> {
                    let mut data = vec![]; let mut byte = [0];
                    while data.len() < 16384 && stream.read_exact(&mut byte).is_ok() {
                        data.push(byte[0]); if data.ends_with(b"\r\n\r\n") { break; }
                    }
                    data
                }
                let request = header(&mut stream);
                if request.is_empty() { continue; }
                if request.starts_with(b"CONNECT ") {
                    if stream.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n").is_err() { continue; }
                    if header(&mut stream).is_empty() { continue; }
                }
                let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{marker}", marker.len());
            }
        }));
    }
    let raw = format!("mode: rule\nlog-level: silent\nproxies:\n- {{name: HK-fixture, type: http, server: 127.0.0.1, port: {}}}\n- {{name: JP-fixture, type: http, server: 127.0.0.1, port: {}}}\n- {{name: SG-fixture, type: http, server: 127.0.0.1, port: {}}}\nproxy-groups:\n- {{name: PROXY, type: select, proxies: [JP-fixture, SG-fixture]}}\nrules: ['DOMAIN-SUFFIX,example.net,PROXY', 'MATCH,PROXY']\n", ports[0], ports[1], ports[2]);
    let mut c = config();
    c.process_rules[0].id = "bundle-fixture-process".into();
    c.process_rules[0].match_kind = "name".into();
    c.process_rules[0].match_value = std::env::current_exe().unwrap().file_name().unwrap().to_string_lossy().into_owned();
    c.process_rules[0].include_descendants = false;
    c.process_rules[0].rule_mode = Some("strict".into());
    c.process_rules[0].target = Some(Target { profile_id: "actual-subscription".into(), kind: "node".into(), name: "HK-fixture".into() });
    for priority in ["domain_first", "direct_first", "process_first"] {
        let prefs = settings::GeneralSettings { mixed_port, controller_port, routing_priority: priority.into(), ..Default::default() };
        std::fs::write(dir.join("config/preferences.json"), serde_json::to_vec(&prefs).unwrap()).unwrap();
        let prepared = prepare(&raw, &c, "actual-subscription").unwrap();
        let yaml: Value = serde_yaml::from_str(&prepared).unwrap();
        let rules = yaml["rules"].as_sequence().unwrap();
        let process_position = rules.iter().position(|r| r.as_str().is_some_and(|r| r.starts_with("PROCESS-NAME,proc_weaver_lib-") && r.ends_with(",HK-fixture"))).unwrap();
        let domain_position = rules.iter().position(|r| r.as_str() == Some("DOMAIN-SUFFIX,example.net,PROXY")).unwrap();
        assert!(process_position < domain_position, "{priority}");
        assert_eq!(yaml["find-process-mode"].as_str(), Some("always"));
        std::fs::write(dir.join("config.yaml"), prepared.replace("log-level: silent", "log-level: debug")).unwrap();
    }
    let missing: Value = serde_yaml::from_str(&prepare(&raw, &c, "different-subscription").unwrap()).unwrap();
    assert!(missing["rules"].as_sequence().unwrap().iter().any(|r| r.as_str().is_some_and(|r| r.starts_with("PROCESS-NAME,proc_weaver_lib-") && r.ends_with(",REJECT"))));
    drop(mixed); drop(controller);
    struct Core(std::process::Child);
    impl Drop for Core { fn drop(&mut self) { let _ = self.0.kill(); let _ = self.0.wait(); } }
    let core_log = std::fs::File::create(dir.join("core.log")).unwrap();
    eprintln!("隔离测试日志：{}", dir.join("core.log").display());
    let _core = Core(std::process::Command::new(root.join("binaries/mihomo-v3.exe"))
        .arg("-d").arg(dir.join("core_data")).arg("-f").arg(dir.join("config.yaml"))
        .creation_flags(0x08000000).stdout(core_log.try_clone().unwrap()).stderr(core_log).spawn().unwrap());
    for _ in 0..100 { if TcpStream::connect(("127.0.0.1", controller_port)).is_ok() { break; } std::thread::sleep(Duration::from_millis(50)); }
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        let control = reqwest::Client::builder().no_proxy().timeout(Duration::from_secs(5)).build().unwrap();
        let selected = reqwest::Client::builder().proxy(reqwest::Proxy::http(format!("http://127.0.0.1:{mixed_port}")).unwrap())
            .pool_max_idle_per_host(0).timeout(Duration::from_secs(5)).build().unwrap();
        for (public, expected) in [("JP-fixture", "public-JP"), ("SG-fixture", "public-SG")] {
            control.put(format!("http://127.0.0.1:{controller_port}/proxies/PROXY"))
                .json(&serde_json::json!({"name":public})).send().await.unwrap().error_for_status().unwrap();
            let body = selected.get("http://198.51.100.42/").send().await.unwrap().error_for_status().unwrap().text().await.unwrap();
            assert_eq!(body, "bundle-HK", "套件出口必须独立于 {public}");
            let script = format!("$ErrorActionPreference='Stop';$h=[Net.Http.HttpClientHandler]::new();$h.Proxy=[Net.WebProxy]::new('http://127.0.0.1:{mixed_port}');$c=[Net.Http.HttpClient]::new($h);$c.Timeout=[TimeSpan]::FromSeconds(5);try{{$c.GetStringAsync('http://198.51.100.42/').GetAwaiter().GetResult()}}finally{{$c.Dispose()}}");
            let output = std::process::Command::new("pwsh").args(["-NoProfile", "-Command", &script]).creation_flags(0x08000000).output().unwrap();
            assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
            assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), expected, "未匹配进程必须遵循公共出口");
        }
    });
    done.store(true, Ordering::SeqCst);
    for server in servers { server.join().unwrap(); }
}

#[test]
fn composer_preserves_sources_and_blocks_missing_or_udp_fallback() {
    let c = config(); let output = composer::compose(RAW, &c, "default", &[]).unwrap();
    let value: Value = serde_yaml::from_str(&output).unwrap();
    assert_eq!(value["rules"][0].as_str(), Some(r"PROCESS-PATH,C:\apps\root.exe,node"));
    assert_eq!(value["rules"][1].as_str(), Some(r"PROCESS-PATH,C:\apps\root.exe,REJECT"));
    assert_eq!(value["rules"][2].as_str(), Some("DOMAIN,example.net,DIRECT"));
    assert!(value["tun"].is_null());
    let missing: Value = serde_yaml::from_str(&composer::compose(RAW, &c, "different-subscription", &[]).unwrap()).unwrap();
    assert_eq!(missing["rules"][0].as_str(), Some(r"PROCESS-PATH,C:\apps\root.exe,REJECT"));
    assert_eq!(composer::compose(RAW, &Overrides::default(), "default", &[]).unwrap(), RAW);
}
#[test]
fn composer_sub_rules_sandbox_and_direct_prioritization() {
    let mut c = config();
    c.process_rules[0].rule_mode = Some("inherit".into());
    let output = composer::compose(RAW, &c, "default", &[]).unwrap();
    let value: Value = serde_yaml::from_str(&output).unwrap();
    let first_rule = value["rules"][0].as_str().unwrap();
    assert!(first_rule.starts_with(r"SUB-RULE,(PROCESS-PATH,C:\apps\root.exe),proc-sandbox-"));
    let subrules = &value["sub-rules"];
    assert!(subrules.is_mapping());

    // 测试 prioritize_direct_rules
    let mixed_raw = "rules:\n- DOMAIN,proxy.com,PROXY\n- DOMAIN,direct1.com,DIRECT\n- PROCESS-NAME,test.exe,PROXY\n- DOMAIN-SUFFIX,direct2.com,DIRECT\n";
    let prioritized = composer::prioritize_direct_rules(mixed_raw).unwrap();
    let p_val: Value = serde_yaml::from_str(&prioritized).unwrap();
    let p_rules: Vec<&str> = p_val["rules"].as_sequence().unwrap().iter().map(|r| r.as_str().unwrap()).collect();
    assert_eq!(p_rules[0], "DOMAIN,direct1.com,DIRECT");
    assert_eq!(p_rules[1], "DOMAIN-SUFFIX,direct2.com,DIRECT");
    assert_eq!(p_rules[2], "DOMAIN,proxy.com,PROXY");
    assert_eq!(p_rules[3], "PROCESS-NAME,test.exe,PROXY");
}
#[test]
fn validation_rejects_injection_duplicates_and_dns_credentials() {
    let mut c = config(); c.process_rules[0].match_value.push_str(",DIRECT"); assert!(normalize(c).is_err());
    let mut c = config(); c.process_rules.push(c.process_rules[0].clone()); assert!(normalize(c).is_err());
    let mut c = config(); c.process_rules[0].match_kind = "name".into(); c.process_rules[0].match_value = "path/app.exe".into(); assert!(normalize(c).is_err());
    let mut c = config(); c.process_rules[0].match_kind = "unknown".into(); c.process_rules[0].match_value = "app.exe".into(); assert!(normalize(c).is_err());
    for resolver in ["http://example.com/dns-query", "https://u:p@example.com/dns-query", "https://example.com/dns-query#DIRECT", "tls://example.com/path"] {
        let c = Overrides { dns_rules: vec![DnsRule { id: "dns".into(), enabled: true, domain_kind: "exact".into(), domain: "Example.COM.".into(), resolver_url: resolver.into(), target: target("node") }], ..Overrides::default() };
        assert!(normalize(c).is_err(), "{resolver}");
    }
}
#[test]
fn bundle_domain_scope_is_validated_and_inherited_by_children() {
    let mut c=config();c.process_rules[0].id="bundle-browser-main".into();c.process_rules[0].rule_mode=Some("inherit".into());
    c.bundles.push(BundleRoute{id:"browser".into(),name:"测试".into(),main_exe:"root.exe".into(),enabled:true,main_target:Some(target("node")),dns_target:None,port:34000,mode:"sandbox".into(),domains:vec!["*.Example.NET.".into(),"*.example.net".into()],fallback:"rules".into()});
    let normalized=normalize(c.clone()).unwrap();assert_eq!(normalized.bundles[0].domains,vec!["*.example.net"]);
    let mut child=c.process_rules[0].clone();child.id="derived:bundle-browser-main".into();child.match_value=r"C:\apps\child.exe".into();
    let parsed:Value=serde_yaml::from_str(&composer::compose(RAW,&c,"default",&[child]).unwrap()).unwrap();
    let rules=parsed["rules"].as_sequence().unwrap();
    assert!(rules.iter().any(|r|r.as_str()==Some(r"AND,((PROCESS-PATH,C:\apps\child.exe),(DOMAIN-SUFFIX,example.net)),node")));
    assert!(rules.iter().any(|r|r.as_str()==Some(r"AND,((PROCESS-PATH,C:\apps\root.exe),(DOMAIN-SUFFIX,example.net)),REJECT")));
    for invalid in ["*.example.net,DIRECT","*example.net","https://example.net","127.0.0.1","*.example..net"] {
        let mut bad=c.clone();bad.bundles[0].domains=vec![invalid.into()];assert!(normalize(bad).is_err(),"{invalid}");
    }
    c.bundles[0].domains.clear();
    let empty:Value=serde_yaml::from_str(&composer::compose(RAW,&c,"default",&[]).unwrap()).unwrap();
    assert_eq!(empty["rules"][0].as_str(),Some("DOMAIN,example.net,DIRECT"),"空清单不可退化为全进程代理");
    c.bundles[0].fallback="direct".into();
    let direct:Value=serde_yaml::from_str(&composer::compose(RAW,&c,"default",&[]).unwrap()).unwrap();
    assert_eq!(direct["rules"][0].as_str(),Some(r"PROCESS-PATH,C:\apps\root.exe,DIRECT"));
    let mut legacy=serde_json::to_value(&c.bundles[0]).unwrap();legacy.as_object_mut().unwrap().remove("fallback");
    assert_eq!(serde_json::from_value::<BundleRoute>(legacy).unwrap().fallback,"rules","旧包不能静默改为直连");
    c.bundles[0].fallback="system,DIRECT".into();assert!(normalize(c).is_err());
}
#[test]
fn dns_binding_conflicts_fail_before_apply() {
    let c = Overrides { dns_enabled: true, dns_rules: vec![DnsRule { id: "dns".into(), enabled: true, domain_kind: "suffix".into(), domain: "example.com".into(), resolver_url: "https://192.0.2.53/dns-query".into(), target: target("node") }], ..Overrides::default() };
    let output: Value = serde_yaml::from_str(&composer::compose(RAW, &c, "default", &[]).unwrap()).unwrap();
    assert_eq!(output["dns"]["nameserver-policy"]["rule-set:procweaver-dns-override-0"].as_str(), Some("https://192.0.2.53/dns-query#node"));
    assert_eq!(output["rule-providers"]["procweaver-dns-override-0"]["payload"][0].as_str(), Some("+.example.com"));
    assert_eq!(output["dns"]["nameserver"][0].as_str(), Some("system"));
    assert_eq!(output["dns"]["enhanced-mode"].as_str(), Some("redir-host"));
    assert!(composer::compose(RAW, &c, "other", &[]).is_err());
    assert!(composer::compose(&format!("{RAW}dns:\n  direct-nameserver: [system]\n"), &c, "default", &[]).is_err());
}
#[test]
fn dns_override_precedes_subscription_without_removing_its_policies() {
    let raw = format!("{RAW}rule-providers:\n  procweaver-dns-override-0: {{type: inline, behavior: domain, payload: ['+.other.test']}}\ndns:\n  enable: true\n  nameserver: [system]\n  nameserver-policy:\n    'geosite:cn': 'https://192.0.2.1/dns-query'\n    'rule-set:procweaver-dns-override-0': 'https://192.0.2.2/dns-query'\n    '+.example.com': 'https://192.0.2.3/dns-query'\n    'api.example.com': 'https://192.0.2.4/dns-query'\n    '*.example.com,other.test': 'https://192.0.2.5/dns-query'\n");
    let original: Value = serde_yaml::from_str(&raw).unwrap();
    let c = Overrides { dns_enabled: true, dns_rules: vec![DnsRule { id: "dns".into(), enabled: true, domain_kind: "suffix".into(), domain: "example.com".into(), resolver_url: "https://192.0.2.53/dns-query".into(), target: target("node") }], ..Overrides::default() };
    let output: Value = serde_yaml::from_str(&composer::compose(&raw, &c, "default", &[]).unwrap()).unwrap();
    let policy = output["dns"]["nameserver-policy"].as_mapping().unwrap();
    assert_eq!(policy.keys().next().unwrap().as_str(), Some("rule-set:procweaver-dns-override-1"));
    assert_eq!(policy.len(), 6);
    for (key, value) in original["dns"]["nameserver-policy"].as_mapping().unwrap() { assert_eq!(policy.get(key), Some(value)); }
    assert_eq!(output["rule-providers"]["procweaver-dns-override-0"], original["rule-providers"]["procweaver-dns-override-0"]);
    assert_eq!(output["rule-providers"]["procweaver-dns-override-1"]["type"].as_str(), Some("inline"));
    assert_eq!(composer::compose(&raw, &Overrides::default(), "default", &[]).unwrap(), raw, "停用必须从原订阅恢复");
    let hosts = format!("{raw}hosts:\n  api.example.com: 192.0.2.1\n");
    assert!(composer::compose(&hosts, &c, "default", &[]).unwrap_err().contains("hosts"));
}
fn entry(id: &str, path: &str, ancestors: &[&str]) -> tracker::ProcessEntry {
    tracker::ProcessEntry { identity: id.into(), pid: 10, parent_pid: 1, name: "child.exe".into(), created_at: 10, executable_path: Some(path.into()), parent_identity: None, ancestors: ancestors.iter().enumerate().map(|(i,p)| (i.to_string(), (*p).into())).collect() }
}
#[test]
fn inheritance_nearest_ancestor_explicit_priority_orphan_and_conflict() {
    let mut c = config();
    let p = entry("child", r"C:\apps\child.exe", &[r"C:\apps\root.exe"]);
    let (derived, errors) = tracker::derive(&c, &[p.clone()]); assert!(errors.is_empty()); assert_eq!(derived.len(), 1);
    let mut nested = rule(r"C:\apps\middle.exe"); nested.action = "direct".into(); nested.target = None; c.process_rules.push(nested);
    let deep = entry("grandchild", r"C:\apps\child.exe", &[r"C:\apps\middle.exe", r"C:\apps\root.exe"]);
    assert_eq!(tracker::derive(&c, &[deep.clone()]).0[0].action, "direct");
    // 已退出祖先不在当前快照，但已确认的祖先链仍可继承。
    assert_eq!(tracker::derive(&c, &[p.clone()]).0[0].action, "proxy");
    let (derived, errors) = tracker::derive(&c, &[p, deep]); assert_eq!(errors.len(), 1); assert_eq!(derived[0].action, "reject");
    let mut explicit = rule(r"C:\apps\child.exe"); explicit.include_descendants = false; c.process_rules.push(explicit);
    assert!(tracker::derive(&c, &[entry("child", r"C:\apps\child.exe", &[r"C:\apps\root.exe"])]).0.is_empty());
    c.process_enabled = false; assert!(tracker::derive(&c, &[]).0.is_empty());
}

#[cfg(windows)]
#[test]
fn shared_system_console_hosts_do_not_conflict_or_break_business_descendants() {
    let root = std::path::PathBuf::from(std::env::var_os("SystemRoot").unwrap());
    let console = root.join("System32/conhost.exe").to_string_lossy().replace('/', "\\");
    let wow_console = root.join("SysWOW64/conhost.exe").to_string_lossy().replace('/', "\\");
    let mut first = rule(r"C:\apps\openai.exe"); first.label = "OpenAI 套件".into(); first.target = Some(target("JP03"));
    let mut second = rule(r"C:\apps\antigravity.exe"); second.label = "反重力套件".into(); second.target = Some(target("JP08"));
    let mut c = Overrides { process_enabled: true, process_rules: vec![first, second], ..Overrides::default() };
    let entries = vec![
        entry("host-a", &console, &[r"C:\apps\openai.exe"]),
        entry("host-b", &console.to_uppercase(), &[r"C:\apps\antigravity.exe"]),
        entry("host-c", &wow_console, &[r"C:\apps\openai.exe"]),
        entry("host-d", &wow_console, &[r"C:\apps\antigravity.exe"]),
        entry("child", r"C:\apps\worker.exe", &[&console, r"C:\apps\openai.exe"]),
    ];
    let (derived, errors) = tracker::derive(&c, &entries);
    assert!(errors.is_empty(), "{errors:?}"); assert_eq!(derived.len(), 1);
    assert_eq!(derived[0].match_value, r"C:\apps\worker.exe");
    assert_eq!(derived[0].target.as_ref().unwrap().name, "JP03");
    // 同名非系统程序与真正联网的共享解释器仍然拒绝歧义；重复实例不刷屏。
    for path in [r"C:\apps\conhost.exe", r"C:\Program Files\PowerShell\7\pwsh.exe"] {
        let mut shared = vec![entry("a", path, &[r"C:\apps\openai.exe"]), entry("b", path, &[r"C:\apps\antigravity.exe"])];
        shared.push(shared[1].clone());
        let (derived, errors) = tracker::derive(&c, &shared);
        assert_eq!(derived[0].action, "reject"); assert_eq!(errors.len(), 1);
        let message = tracker::conflict_message(&errors).unwrap();
        for expected in [path, "OpenAI 套件", "反重力套件", "JP03", "JP08"] { assert!(message.contains(expected), "{message}"); }
    }
    // 显式指定系统控制台的用户规则仍存在于合成配置中，不被自动继承例外删除。
    let mut explicit = rule(&console); explicit.action = "direct".into(); explicit.target = None;
    c.process_rules.push(explicit);
    let value: Value = serde_yaml::from_str(&composer::compose(RAW, &c, "default", &tracker::derive(&c, &entries).0).unwrap()).unwrap();
    assert!(value["rules"].as_sequence().unwrap().iter().any(|r| r.as_str() == Some(&format!("PROCESS-PATH,{console},DIRECT"))));
}

#[test]
fn test_ensure_bt_pt_and_proxy_group() {
    let raw = r#"
proxies:
  - { name: "HK01", type: ss, server: 1.1.1.1, port: 443, cipher: aes-128-gcm, password: "123" }
  - { name: "JP02", type: ss, server: 2.2.2.2, port: 443, cipher: aes-128-gcm, password: "123" }
proxy-groups:
  - { name: "🚀 节点选择", type: select, proxies: ["HK01", "JP02"] }
rules:
  - "DOMAIN-SUFFIX,google.com,🚀 节点选择"
  - "MATCH,🚀 节点选择"
"#;
    let output = composer::ensure_bt_pt_and_proxy_group(raw).unwrap();
    let val: Value = serde_yaml::from_str(&output).unwrap();
    
    // 验证 PROXY 主组排在第 0 位且为 select
    assert_eq!(val["proxy-groups"][0]["name"].as_str(), Some("PROXY"));
    assert_eq!(val["proxy-groups"][0]["type"].as_str(), Some("select"));
    let proxy_members: Vec<&str> = val["proxy-groups"][0]["proxies"].as_sequence().unwrap().iter().map(|p| p.as_str().unwrap()).collect();
    assert!(proxy_members.contains(&"HK01"));
    assert!(proxy_members.contains(&"JP02"));
    assert!(proxy_members.contains(&"DIRECT"));

    // 验证 BT / PT 直连规则强制排在首部
    let rules: Vec<&str> = val["rules"].as_sequence().unwrap().iter().map(|r| r.as_str().unwrap()).collect();
    assert!(rules.contains(&"PROCESS-NAME,qbittorrent.exe,DIRECT"));
    assert!(rules.contains(&"DOMAIN-KEYWORD,torrent,DIRECT"));
    assert!(rules.contains(&"DOMAIN-KEYWORD,tracker,DIRECT"));

    // 验证兜底规则 MATCH 统一指向受控 PROXY 组
    let last_rule = rules.last().unwrap();
    assert_eq!(*last_rule, "MATCH,PROXY");
}


#[cfg(windows)]
#[test]
fn native_events_discover_future_child_without_open_page() {
    use std::os::windows::process::CommandExt;
    tracker::ENABLED.store(true, Ordering::Release);
    let observer = std::thread::spawn(native::observe);
    let root = std::env::current_exe().unwrap();
    let mut c = config(); c.process_rules[0] = rule(&root.to_string_lossy());
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(12);
    while !tracker::status(&c).subscribed && !observer.is_finished() && std::time::Instant::now() < deadline { std::thread::sleep(std::time::Duration::from_millis(100)); }
    if !tracker::status(&c).subscribed { tracker::ENABLED.store(false, Ordering::Release); panic!("事件订阅失败：{:?}", observer.join().unwrap()); }
    let mut child = std::process::Command::new("pwsh").args(["-NoLogo", "-NoProfile", "-Command", "Start-Sleep -Seconds 15"]).creation_flags(0x08000000).spawn().unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(8);
    let mut found = false;
    while std::time::Instant::now() < deadline {
        let status = tracker::status(&c);
        if status.entries.iter().any(|p| p.pid == child.id()) && status.derived.iter().any(|r| r.match_value.to_lowercase().ends_with("pwsh.exe")) { found = true; break; }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    let _ = child.kill(); let _ = child.wait(); tracker::ENABLED.store(false, Ordering::Release);
    let observed = observer.join().unwrap(); assert!(observed.is_ok(), "{observed:?}"); assert!(found, "未来子进程未继承");
}

#[cfg(windows)]
#[test]
fn native_save_revision_rollback_and_dns_proxy_egress() {
    const FLAG: &str = "NETBOX_ROUTING_NATIVE_TEST";
    if std::env::var_os(FLAG).is_none() {
        let status = std::process::Command::new(std::env::current_exe().unwrap()).args(["--exact", "routing_overrides::tests::native_save_revision_rollback_and_dns_proxy_egress", "--nocapture"]).env(FLAG, "1").status().unwrap();
        assert!(status.success()); return;
    }
    let dir = std::env::temp_dir().join(format!("netbox-routing-test-{}", std::process::id()));
    std::fs::create_dir_all(dir.join("config")).unwrap();
    crate::storage::initialize_test(dir.clone(), std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf());
    let mixed_port = {
        let mut p = 0;
        for _ in 0..100 {
            if let Ok(l) = std::net::TcpListener::bind("127.0.0.1:0") {
                let port = l.local_addr().unwrap().port();
                if let Ok(u) = std::net::UdpSocket::bind(format!("127.0.0.1:{}", port)) {
                    drop(u); drop(l); p = port; break;
                }
            }
        }
        if p == 0 { 39123 } else { p }
    };
    let controller_port = {
        let mut p = 0;
        for _ in 0..100 {
            if let Ok(l) = std::net::TcpListener::bind("127.0.0.1:0") {
                let port = l.local_addr().unwrap().port();
                if port != mixed_port {
                    if let Ok(u) = std::net::UdpSocket::bind(format!("127.0.0.1:{}", port)) {
                        drop(u); drop(l); p = port; break;
                    }
                }
            }
        }
        if p == 0 { 39124 } else { p }
    };
    let preferences = settings::GeneralSettings { mixed_port, controller_port, ..Default::default() };
    std::fs::write(dir.join("config/preferences.json"), serde_json::to_vec(&preferences).unwrap()).unwrap();
    let state = std::sync::Mutex::new(process::CoreState { child: None, mixed_port: preferences.mixed_port, controller_port: preferences.controller_port, active_core: None, active_core_path: None, core_mode: None, started_at: None });
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_port = listener.local_addr().unwrap().port(); let (tx, mut rx) = tokio::sync::mpsc::channel(32);
        let server = tokio::spawn(async move { loop { let (mut stream, _) = listener.accept().await.unwrap(); let tx = tx.clone(); tokio::spawn(async move { let mut bytes = [0u8; 4096]; if let Ok(n) = stream.read(&mut bytes).await { let _ = tx.send(String::from_utf8_lossy(&bytes[..n]).into_owned()).await; let _ = stream.write_all(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n").await; } }); } });
        let raw = format!("proxies:\n- {{name: node, type: http, server: 127.0.0.1, port: {proxy_port}}}\nhosts:\n  udp-sink.test: 127.0.0.1\nrules: ['MATCH,DIRECT']\nrule-providers:\n  subscription-dns: {{type: inline, behavior: domain, payload: ['+.example.com', '+.untouched.test']}}\ndns:\n  enable: true\n  nameserver: [system]\n  nameserver-policy:\n    'rule-set:subscription-dns': 'https://192.0.2.56/dns-query#node'\n    'api.sub.example.com': 'https://192.0.2.57/dns-query#node'\n    '+.example.com': 'https://192.0.2.58/dns-query#node'\n");
        std::fs::write(dir.join("config/default.yaml"), &raw).unwrap();
        std::fs::write(dir.join("config/other.yaml"), &raw).unwrap();
        let profiles: Vec<_> = ["default", "other"].iter().map(|id| profile::ProfileItem { id: (*id).into(), name: (*id).into(), url: String::new(), file_path: format!("config/{id}.yaml"), updated_at: String::new(), node_count: 1, is_selected: *id == "default", ..Default::default() }).collect();
        std::fs::write(profile::get_profiles_index_file(), serde_json::to_vec(&profiles).unwrap()).unwrap();
        process::start_core_transaction(Some("compatible".into()), &state).await.unwrap();
        let mut c = config(); c.dns_enabled = true; c.dns_rules.push(DnsRule { id: "dns".into(), enabled: true, domain_kind: "suffix".into(), domain: "example.com".into(), resolver_url: "https://192.0.2.53/dns-query".into(), target: target("node") });
        c.process_rules[0] = rule(&std::env::current_exe().unwrap().to_string_lossy());
        for (id, kind, domain, ip) in [("specific", "suffix", "sub.example.com", "192.0.2.54"), ("exact", "exact", "api.sub.example.com", "192.0.2.55")] {
            c.dns_rules.push(DnsRule { id: id.into(), enabled: true, domain_kind: kind.into(), domain: domain.into(), resolver_url: format!("https://{ip}/dns-query"), target: target("node") });
        }
        let saved = save(c.clone(), vec![]).await.unwrap(); assert_eq!(saved.config.revision, 1);
        assert!(profile::select_profile("other".into()).await.is_err(), "同名节点不可越过订阅身份绑定");
        assert!(profile::read_profiles_index().iter().any(|p| p.id == "default" && p.is_selected));
        assert!(save(c, vec![]).await.unwrap_err_string().contains("其他页面"));
        let original = std::fs::read(path()).unwrap(); let source = std::fs::read(dir.join("config/default.yaml")).unwrap();
        let mut invalid = saved.config.clone(); invalid.dns_rules[0].target.profile_id = "different".into();
        assert!(save(invalid, vec![]).await.is_err()); assert_eq!(std::fs::read(path()).unwrap(), original);
        assert_eq!(std::fs::read(dir.join("config/default.yaml")).unwrap(), source);
        let client = crate::commands::mihomo_api::controller_client().timeout(std::time::Duration::from_secs(6)).build().unwrap();
        let routed = reqwest::Client::builder().proxy(reqwest::Proxy::http(format!("http://127.0.0.1:{}", preferences.mixed_port)).unwrap()).timeout(std::time::Duration::from_secs(4)).build().unwrap();
        while rx.try_recv().is_ok() {}
        let _ = routed.get("http://192.0.2.21/process-test").send().await;
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(4);
        let mut process_seen = false;
        while let Ok(Some(request)) = tokio::time::timeout_at(deadline, rx.recv()).await {
            if request.starts_with("CONNECT 192.0.2.21:80") {
                process_seen = true;
                break;
            }
        }
        assert!(process_seen, "真实进程路径未命中指定节点");
        let query = client.get(format!("http://127.0.0.1:{}/dns/query?name=future.example.com&type=A", preferences.controller_port)).send().await;
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(3);
        let mut dns_seen = false;
        while let Ok(Some(request)) = tokio::time::timeout_at(deadline, rx.recv()).await { if request.starts_with("CONNECT 192.0.2.53:443") { dns_seen = true; break; } }
        assert!(dns_seen, "DNS 未经绑定代理"); drop(query);
        for (domain, expected) in [("deep.sub.example.com", "192.0.2.54"), ("api.sub.example.com", "192.0.2.55"), ("untouched.test", "192.0.2.56")] {
            while rx.try_recv().is_ok() {}
            let _ = client.get(format!("http://127.0.0.1:{}/dns/query?name={domain}&type=A", preferences.controller_port)).send().await;
            let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
            let mut found = false;
            while let Ok(Some(request)) = tokio::time::timeout_at(deadline, rx.recv()).await { if request.starts_with(&format!("CONNECT {expected}:443")) { found = true; break; } }
            assert!(found, "DNS 精确/后缀优先级未命中 {expected}");
        }
        // 用本机 UDP 接收器证明保护有效，并以移除保护后的直连作为阳性对照。
        async fn udp_attempt(mixed_port: u16, sink_port: u16) {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let udp = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
            let mut tcp = tokio::net::TcpStream::connect(("127.0.0.1", mixed_port)).await.unwrap();
            tcp.write_all(&[5,1,0]).await.unwrap(); let mut answer = [0u8;2]; tcp.read_exact(&mut answer).await.unwrap(); assert_eq!(answer,[5,0]);
            let mut associate = vec![5,3,0,1,127,0,0,1]; associate.extend(udp.local_addr().unwrap().port().to_be_bytes()); tcp.write_all(&associate).await.unwrap();
            let mut response = [0u8;10]; tcp.read_exact(&mut response).await.unwrap(); assert_eq!(response[1],0);
            let relay = u16::from_be_bytes([response[8],response[9]]);
            let name = b"udp-sink.test"; let mut packet = vec![0,0,0,3,name.len() as u8]; packet.extend(name); packet.extend(sink_port.to_be_bytes()); packet.extend(b"routing-udp-test");
            udp.send_to(&packet, ("127.0.0.1", relay)).await.unwrap(); tokio::time::sleep(std::time::Duration::from_millis(600)).await;
        }
        let production_config = std::fs::read_to_string(dir.join("core_data/config.yaml")).unwrap();
        let mut fixture: Value = serde_yaml::from_str(&production_config).unwrap();
        // 本地通信本就优先直连；仅测试夹具去除这一例外，以便用回环接收器观测后续分流。
        fixture["rules"].as_sequence_mut().unwrap().retain(|r| r.as_str() != Some("IP-CIDR,127.0.0.0/8,DIRECT,no-resolve"));
        apply_runtime(&serde_yaml::to_string(&fixture).unwrap()).await.unwrap();
        let sink = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap(); let sink_port = sink.local_addr().unwrap().port();
        udp_attempt(preferences.mixed_port, sink_port).await;
        let mut packet = [0u8;128]; assert!(tokio::time::timeout(std::time::Duration::from_millis(200), sink.recv_from(&mut packet)).await.is_err(), "不支持 UDP 的固定节点泄漏到直连");
        let guarded = std::fs::read_to_string(dir.join("core_data/config.yaml")).unwrap();
        let mut unguarded: Value = serde_yaml::from_str(&guarded).unwrap();
        unguarded["rules"].as_sequence_mut().unwrap().retain(|r| !r.as_str().is_some_and(|r| r.starts_with("PROCESS-PATH,") && r.ends_with(",REJECT")));
        apply_runtime(&serde_yaml::to_string(&unguarded).unwrap()).await.unwrap();
        udp_attempt(preferences.mixed_port, sink_port).await;
        assert!(tokio::time::timeout(std::time::Duration::from_secs(2), sink.recv_from(&mut packet)).await.is_ok(), "UDP 阳性对照未到达，不能证明阻止行为");
        apply_runtime(&production_config).await.unwrap();
        // Windows 文件共享锁阻止最终持久化，必须恢复核心运行配置。
        use std::os::windows::fs::OpenOptionsExt;
        let locked = std::fs::OpenOptions::new().read(true).share_mode(1).open(path()).unwrap();
        let before_runtime = std::fs::read(dir.join("core_data/config.yaml")).unwrap();
        let mut next = saved.config; next.process_rules[0].action = "direct".into(); next.process_rules[0].target = None;
        assert!(save(next, vec![]).await.is_err()); drop(locked);
        assert_eq!(std::fs::read(path()).unwrap(), original); assert_eq!(std::fs::read(dir.join("core_data/config.yaml")).unwrap(), before_runtime);
        // 未来子进程在没有页面的情况下由后台任务生成并热加载路径规则。
        use std::os::windows::process::CommandExt;
        let background = tokio::spawn(tracker::run());
        let mut child = std::process::Command::new("pwsh").args(["-NoProfile", "-Command", "Start-Sleep -Seconds 20"]).creation_flags(0x08000000).spawn().unwrap();
        let started = tokio::time::Instant::now(); let mut inherited = false;
        while started.elapsed().as_secs() < 12 {
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            let value: serde_json::Value = client.get(format!("http://127.0.0.1:{}/rules", preferences.controller_port)).send().await.unwrap().json().await.unwrap();
            inherited = value["rules"].as_array().is_some_and(|rules| rules.iter().any(|r| r["type"] == "ProcessPath" && r["payload"].as_str().is_some_and(|p| p.to_lowercase().ends_with("pwsh.exe")) && r["proxy"] == "node"));
            if inherited { break; }
        }
        println!("未来子进程发现并热加载耗时：{} ms", started.elapsed().as_millis());
        let _ = child.kill(); let _ = child.wait(); background.abort(); tracker::ENABLED.store(false, Ordering::Release);
        assert!(inherited, "未来子进程规则未自动热加载");
        process::stop_owned_child(&mut state.lock().unwrap()).unwrap(); server.abort();
    });
    std::fs::remove_dir_all(dir).unwrap();
}

trait ErrorText { fn unwrap_err_string(self) -> String; }
impl ErrorText for Result<View, String> { fn unwrap_err_string(self) -> String { match self { Ok(_) => panic!("应失败"), Err(e) => e } } }

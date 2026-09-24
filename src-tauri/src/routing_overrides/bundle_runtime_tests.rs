use super::*;
#[cfg(windows)]
#[test]
fn native_bundle_entries_switch_only_one_selector_and_rollback() {
    const NAME:&str="routing_overrides::bundle_runtime_tests::native_bundle_entries_switch_only_one_selector_and_rollback";
    const FLAG:&str="PROCWEAVER_BUNDLE_TEST";
    if std::env::var_os(FLAG).is_none() {
        let status=std::process::Command::new(std::env::current_exe().unwrap()).args(["--exact",NAME,"--nocapture"]).env(FLAG,"1").status().unwrap(); assert!(status.success()); return;
    }
    let dir=std::env::temp_dir().join(format!("procweaver-bundle-runtime-{}",std::process::id())); std::fs::create_dir_all(&dir).unwrap();
    crate::storage::initialize_test(dir.clone(),std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf());
    let free=||crate::storage::reserve_test_mixed_port().local_addr().unwrap().port();
    let preferences=settings::GeneralSettings{mixed_port:free(),controller_port:free(),..Default::default()};
    std::fs::write(dir.join("config/preferences.json"),serde_json::to_vec(&preferences).unwrap()).unwrap();
    std::fs::write(dir.join("config/local-rules.json"),r#"{"enabled":false,"providers":[]}"#).unwrap();
    let state=std::sync::Mutex::new(process::CoreState{child:None,mixed_port:preferences.mixed_port,controller_port:preferences.controller_port,active_core:None,active_core_path:None,core_mode:None,started_at:None});
    // Always reap our isolated core on assertions; never touch another running core.
    struct Cleanup<'a>(&'a std::sync::Mutex<process::CoreState>);
    impl Drop for Cleanup<'_>{fn drop(&mut self){if let Ok(mut state)=self.0.lock(){let _=process::stop_owned_child(&mut state);}}}
    let _cleanup=Cleanup(&state);
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        use tokio::io::{AsyncReadExt,AsyncWriteExt};
        let mut definitions=String::from("proxies:\n"); let mut servers=vec![];
        for name in ["node-a","node-b","node-c"] {
            let server=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap(); let port=server.local_addr().unwrap().port();
            definitions.push_str(&format!("- {{name: {name}, type: http, server: 127.0.0.1, port: {port}}}\n"));
            servers.push(tokio::spawn(async move {loop {let (mut socket,_)=server.accept().await.unwrap();tokio::spawn(async move {
                let mut request=vec![];let mut byte=[0];
                while request.len()<8192 && !request.ends_with(b"\r\n\r\n") {if socket.read_exact(&mut byte).await.is_err(){return;}request.push(byte[0]);}
                if !request.starts_with(b"CONNECT "){return;}
                if socket.write_all(b"HTTP/1.1 200 Connection established\r\n\r\n").await.is_err(){return;}
                let mut probe=[0];if socket.read_exact(&mut probe).await.is_err() || probe!=[b'?']{return;}
                if socket.write_all(format!("{name}\n").as_bytes()).await.is_err(){return;}
                let (mut reader,mut writer)=socket.split();let _=tokio::io::copy(&mut reader,&mut writer).await;
            });}}));
        }
        let direct=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();let fallback_port=direct.local_addr().unwrap().port();
        servers.push(tokio::spawn(async move {loop {let (mut socket,_)=direct.accept().await.unwrap();tokio::spawn(async move {
            let mut byte=[0];if socket.read_exact(&mut byte).await.is_ok() {let _=socket.write_all(b"direct\n").await;}
        });}}));
        definitions.push_str("hosts:\n");
        for i in 0..32 {definitions.push_str(&format!("  fallback-{i}.example.test: 127.0.0.1\n"));}
        definitions.push_str("rules: ['DOMAIN,original.example.test,node-b', 'MATCH,PROXY']\n"); std::fs::write(dir.join("config/default.yaml"),&definitions).unwrap();
        process::start_core_transaction(Some("compatible".into()),&state).await.unwrap();
        let target=|name:&str|Target{profile_id:"default".into(),kind:"node".into(),name:name.into()};
        let mut config=Overrides{process_enabled:true,..Default::default()};
        for (id,node) in [("a","node-a"),("b","node-b"),("c","node-c")] {
            config.bundles.push(BundleRoute{id:id.into(),name:format!("包{id}"),main_exe:format!("fixture-{id}.exe"),enabled:true,main_target:Some(target(node)),dns_target:Some(target(node)),port:0,mode:"strict".into(),domains:vec![],fallback:"rules".into()});
            config.process_rules.push(ProcessRule{id:format!("bundle-{id}-fixture-{id}.exe"),enabled:true,label:id.into(),match_kind:"name".into(),match_value:format!("fixture-{id}.exe"),action:"proxy".into(),target:Some(target(node)),include_descendants:false,rule_mode:Some("strict".into())});
        }
        let exe=std::env::current_exe().unwrap().file_name().unwrap().to_string_lossy().into_owned();
        for (id,main_exe,domains) in [("sandbox",exe,vec!["*.selected.example.test".into(),"exact.example.test".into()]),("empty","empty-fixture.exe".into(),vec![])] {
            config.bundles.push(BundleRoute{id:id.into(),name:id.into(),main_exe:main_exe.clone(),enabled:true,main_target:Some(target("node-a")),dns_target:Some(target("node-a")),port:0,mode:"sandbox".into(),domains,fallback:"rules".into()});
            config.process_rules.push(ProcessRule{id:format!("bundle-{id}-main"),enabled:true,label:id.into(),match_kind:"name".into(),match_value:main_exe,action:"proxy".into(),target:Some(target("node-a")),include_descendants:false,rule_mode:Some("inherit".into())});
        }
        let saved=save(config,vec![]).await.unwrap();let ports:Vec<_>=saved.config.bundles.iter().map(|b|b.port).collect();
        async fn connect_to(port:u16,destination:&str,expected:&str)->tokio::net::TcpStream {
            use tokio::io::{AsyncReadExt,AsyncWriteExt};
            let mut socket=tokio::net::TcpStream::connect(("127.0.0.1",port)).await.unwrap();
            socket.write_all(format!("CONNECT {destination} HTTP/1.1\r\nHost: {destination}\r\n\r\n").as_bytes()).await.unwrap();
            let mut header=vec![];let mut byte=[0];while !header.ends_with(b"\r\n\r\n"){tokio::time::timeout(std::time::Duration::from_secs(5),socket.read_exact(&mut byte)).await.unwrap().unwrap();header.push(byte[0]);assert!(header.len()<8192);}
            assert!(String::from_utf8_lossy(&header).contains("200"));socket.write_all(b"?").await.unwrap();let mut line=vec![0;expected.len()+1];tokio::time::timeout(std::time::Duration::from_secs(5),socket.read_exact(&mut line)).await.unwrap().unwrap();assert_eq!(String::from_utf8_lossy(&line),format!("{expected}\n")); socket
        }
        async fn connect(port:u16,expected:&str)->tokio::net::TcpStream {connect_to(port,"192.0.2.123:443",expected).await}
        let control=reqwest::Client::builder().no_proxy().timeout(std::time::Duration::from_secs(4)).build().unwrap();
        for public in ["node-c","node-b"] {
            control.put(format!("http://127.0.0.1:{}/proxies/PROXY",preferences.controller_port)).json(&serde_json::json!({"name":public})).send().await.unwrap().error_for_status().unwrap();
            for port in [ports[3],preferences.mixed_port] {
                let _root=connect_to(port,"selected.example.test:443","node-a").await;
                let _sub=connect_to(port,"sub.selected.example.test:443","node-a").await;
                let _exact=connect_to(port,"exact.example.test:443","node-a").await;
                let _original=connect_to(port,"original.example.test:443","node-b").await;
                let _other=connect_to(port,"unmatched.example.test:443",public).await;
                let _not_exact=connect_to(port,"sub.exact.example.test:443",public).await;
                let _numeric=connect(port,public).await;
            }
            let _empty=connect_to(ports[4],"selected.example.test:443",public).await;
            let _strict=connect_to(ports[1],"unmatched.example.test:443","node-b").await;
        }
        // A different process using the common entry must not inherit this process's bundle.
        use std::os::windows::process::CommandExt;
        let script=format!(r#"$ErrorActionPreference='Stop'
$client=[Net.Sockets.TcpClient]::new('127.0.0.1',{})
try {{
  $stream=$client.GetStream();$stream.ReadTimeout=5000
  $request=[Text.Encoding]::ASCII.GetBytes("CONNECT selected.example.test:443 HTTP/1.1`r`nHost: selected.example.test:443`r`n`r`n")
  $stream.Write($request,0,$request.Length)
  $reader=[IO.StreamReader]::new($stream)
  $line=$reader.ReadLine();if($line -notmatch '200'){{throw 'CONNECT failed'}}
  while($reader.ReadLine() -ne ''){{}}
  $stream.WriteByte(63);$reader.ReadLine()
}} finally {{$client.Dispose()}}
"#,preferences.mixed_port);
        let output=std::process::Command::new("pwsh").args(["-NoProfile","-Command",&script]).creation_flags(0x08000000).output().unwrap();
        assert!(output.status.success(),"{}",String::from_utf8_lossy(&output.stderr));
        assert_eq!(String::from_utf8_lossy(&output.stdout).trim(),"node-b","未命中进程仍走原规则");
        let direct=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();let direct_port=direct.local_addr().unwrap().port();
        let direct_server=tokio::spawn(async move {let(mut socket,_)=direct.accept().await.unwrap();let mut byte=[0];socket.read_exact(&mut byte).await.unwrap();socket.write_all(b"direct\n").await.unwrap();});
        let _direct=connect_to(ports[3],&format!("127.0.0.1:{direct_port}"),"direct").await;direct_server.await.unwrap();
        println!("沙盒真实分流：进程与域名共同命中、根/子域名、精确域名、未命中沿用原规则、空清单、强锁、原直连、公共节点切换和非匹配进程均通过");
        // Isolated switch transaction: mock only the OS registry write; the actual core reload and sockets are real.
        // Local hosts provide positive DIRECT probes; original-rule probes use non-private destinations
        // because the original plan intentionally routes private IPs directly regardless of the switch.
        let query=std::sync::atomic::AtomicUsize::new(0);
        let destination=||format!("fallback-{}.example.test:{fallback_port}",query.fetch_add(1,Ordering::SeqCst));
        let mut follow=saved.config.clone();follow.bundles[3].fallback="system".into();follow.bundles[4].fallback="system".into();
        follow.bundles[0].fallback="system".into(); // Strong mode ignores fallback.
        let saved=save(follow,vec![]).await.unwrap();
        for port in [ports[3],ports[4],preferences.mixed_port] {let _off=connect_to(port,&destination(),"direct").await;}
        let mut kept=connect(ports[1],"node-b").await;
        let before_switch=std::fs::read_to_string(dir.join("core_data/config.yaml")).unwrap();
        {
            let _lock=process::LIFECYCLE.lock().await;
            let failed=change_system_proxy(true,||Err("模拟系统写入失败".into())).await.unwrap_err();assert!(failed.contains("已恢复原路由"));
        }
        assert_eq!(std::fs::read_to_string(dir.join("core_data/config.yaml")).unwrap(),before_switch);
        let _rolled_back=connect_to(ports[3],&destination(),"direct").await;
        for enabled in [true,false,true] {
            {let _lock=process::LIFECYCLE.lock().await;assert_eq!(change_system_proxy(enabled,||Ok(enabled)).await.unwrap(),enabled);}
            assert_eq!(*SYSTEM_PROXY_ROUTED.lock().unwrap(),Some(enabled),"显式切换也更新最近成功的回退状态，避免外部立即改回时漏处理");
            // Public original selector changes must never replace the bundle's selected target.
            control.put(format!("http://127.0.0.1:{}/proxies/PROXY",preferences.controller_port)).json(&serde_json::json!({"name":"node-b"})).send().await.unwrap().error_for_status().unwrap();
            for port in [ports[3],preferences.mixed_port] {
                let _matched=connect_to(port,"selected.example.test:443","node-a").await;
                let address=if enabled {"unmatched.example.test:443".into()}else{destination()};
                let _fallback=connect_to(port,&address,if enabled {"node-b"}else{"direct"}).await;
            }
            let address=if enabled {"unmatched.example.test:443".into()}else{destination()};
            let _empty=connect_to(ports[4],&address,if enabled {"node-b"}else{"direct"}).await;
            let actual:serde_yaml::Value=serde_yaml::from_str(&std::fs::read_to_string(dir.join("core_data/config.yaml")).unwrap()).unwrap();
            let process_direct=format!("PROCESS-NAME,{},DIRECT",saved.config.bundles[3].main_exe);
            assert_eq!(actual["rules"].as_sequence().unwrap().iter().any(|r|r.as_str()==Some(&process_direct)),!enabled);
            let entry=&actual["sub-rules"][bundles::listener("sandbox")];
            assert_eq!(entry.as_sequence().unwrap().last().unwrap().as_str(),Some(if enabled {"MATCH,PROXY"}else{"MATCH,DIRECT"}));
            let _strong=connect(ports[0],"node-a").await;
            kept.write_all(b"alive").await.unwrap();let mut echo=[0;5];tokio::time::timeout(std::time::Duration::from_secs(3),kept.read_exact(&mut echo)).await.unwrap().unwrap();assert_eq!(&echo,b"alive");
        }
        // Observer reconciliation uses actual status; read errors and bypass changes keep routing.
        let proxy_status=|state:&str,bypass_changed:bool|crate::commands::sysproxy::SystemProxyStatus {
            state:state.into(),bypass_changed,message:String::new(),last_change:None,
        };
        {
            let _lock=process::LIFECYCLE.lock().await;
            reconcile_system_proxy(&proxy_status("enabled",false)).await.unwrap();
            let before=std::fs::read_to_string(dir.join("core_data/config.yaml")).unwrap();
            reconcile_system_proxy(&proxy_status("unknown",false)).await.unwrap();
            reconcile_system_proxy(&proxy_status("enabled",true)).await.unwrap();
            assert_eq!(std::fs::read_to_string(dir.join("core_data/config.yaml")).unwrap(),before);
        }
        let _retained=connect_to(ports[3],"unmatched.example.test:443","node-b").await;
        {let _lock=process::LIFECYCLE.lock().await;reconcile_system_proxy(&proxy_status("disabled",false)).await.unwrap();}
        let _off_after_observation=connect_to(ports[3],&destination(),"direct").await;
        {let _lock=process::LIFECYCLE.lock().await;reconcile_system_proxy(&proxy_status("enabled",false)).await.unwrap();}
        let _on_after_observation=connect_to(ports[3],"unmatched.example.test:443","node-b").await;
        println!("系统代理观察器：读取未知与绕过项变化不改变路由；实际关闭/开启才切换回退：通过");
        let mut direct_only=saved.config.clone();direct_only.bundles[3].fallback="direct".into();
        let saved=save(direct_only,vec![]).await.unwrap();
        {let _lock=process::LIFECYCLE.lock().await;change_system_proxy(true,||Ok(true)).await.unwrap();}
        for port in [ports[3],preferences.mixed_port] {let _always_direct=connect_to(port,&destination(),"direct").await;}
        let _empty_on=connect_to(ports[4],"unmatched.example.test:443","node-b").await;
        // Concurrent save and switch use the same lifecycle lock and cannot leave a half-applied plan.
        let concurrent=saved.config.clone();
        let (saved,switched)=tokio::join!(save(concurrent,vec![]),async {let _lock=process::LIFECYCLE.lock().await;change_system_proxy(false,||Ok(false)).await});
        let saved=saved.unwrap();assert_eq!(switched.unwrap(),false);
        let _concurrent=connect_to(ports[4],&destination(),"direct").await;
        // A core/API failure must occur before the OS write callback.
        let mut unreachable=preferences.clone();unreachable.controller_port=free();
        std::fs::write(dir.join("config/preferences.json"),serde_json::to_vec(&unreachable).unwrap()).unwrap();
        let called=std::sync::atomic::AtomicBool::new(false);
        {let _lock=process::LIFECYCLE.lock().await;assert!(change_system_proxy(true,||{called.store(true,Ordering::SeqCst);Ok(true)}).await.is_err());}
        assert!(!called.load(Ordering::SeqCst));
        std::fs::write(dir.join("config/preferences.json"),serde_json::to_vec(&preferences).unwrap()).unwrap();
        {let _lock=process::LIFECYCLE.lock().await;reapply(&saved.config).await.unwrap();}
        println!("沙盒回退真实验证：开=原规则/关=直连、命中出口不变、空清单、始终直连、强锁忽略开关、其他包长连接保持、系统写入失败回滚、并发保存、核心失败不写系统代理：通过");
        let _a=connect(ports[0],"node-a").await; let mut b=connect(ports[1],"node-b").await;let _c=connect(ports[2],"node-c").await;
        let before=std::fs::read_to_string(dir.join("core_data/config.yaml")).unwrap();
        let mut changed=saved.config.clone(); changed.bundles[0].main_target=Some(target("node-c"));changed.bundles[0].dns_target=Some(target("node-c"));changed.process_rules[0].target=Some(target("node-c"));
        let switched=save(changed,vec![]).await.unwrap();
        let after=std::fs::read_to_string(dir.join("core_data/config.yaml")).unwrap();
        assert_eq!(bundles::structural(&before).unwrap(),bundles::structural(&after).unwrap(),"单独换节点不能走配置重载");
        assert_eq!(ports,switched.config.bundles.iter().map(|b|b.port).collect::<Vec<_>>());
        let _new_a=connect(ports[0],"node-c").await; let _new_b=connect(ports[1],"node-b").await;
        b.write_all(b"keep-b-alive").await.unwrap();let mut echoed=[0;12];tokio::time::timeout(std::time::Duration::from_secs(3),b.read_exact(&mut echoed)).await.unwrap().unwrap();assert_eq!(&echoed,b"keep-b-alive");
        use std::os::windows::fs::OpenOptionsExt;
        let locked=std::fs::OpenOptions::new().read(true).share_mode(1).open(path()).unwrap();
        let mut failed=switched.config.clone();failed.bundles[0].main_target=Some(target("node-a"));failed.process_rules[0].target=Some(target("node-a"));
        assert!(save(failed,vec![]).await.is_err());drop(locked);
        assert_eq!(std::fs::read_to_string(dir.join("core_data/config.yaml")).unwrap(),after);let _restored=connect(ports[0],"node-c").await;
        process::stop_owned_child(&mut state.lock().unwrap()).unwrap();
        process::start_core_transaction(Some("compatible".into()),&state).await.unwrap();
        let _restarted=connect(ports[0],"node-c").await;let _other=connect(ports[1],"node-b").await;
        let _restart_fallback=connect_to(ports[4],&destination(),"direct").await;
        // Pausing preserves definitions and ports, while new connections use the
        // original rules. It must remain paused across a native core restart.
        let before_pause=read().unwrap(); let mut paused=before_pause.clone(); paused.bundles_enabled=false;
        let paused=save(paused,vec![]).await.unwrap();
        assert_eq!(serde_json::to_value(&before_pause.bundles).unwrap(),serde_json::to_value(&paused.config.bundles).unwrap());
        assert_eq!(before_pause.process_rules,paused.config.process_rules);
        let _fallback=connect_to(ports[0],"original.example.test:443","node-b").await;
        assert!(crate::commands::bundle_launch::get_bundle_entry_states(vec!["a".into()]).await.unwrap().is_empty());
        process::stop_owned_child(&mut state.lock().unwrap()).unwrap();
        process::start_core_transaction(Some("compatible".into()),&state).await.unwrap();
        let _paused_restart=connect_to(ports[0],"original.example.test:443","node-b").await;
        let mut resume=paused.config; resume.bundles_enabled=true; save(resume,vec![]).await.unwrap();
        let _restored_bundle=connect(ports[0],"node-c").await;
        process::stop_owned_child(&mut state.lock().unwrap()).unwrap();for server in servers {server.abort();}
        println!("三个真实入口独立分流；A 换节点无重载且 B 长连接保持；持久化失败恢复；核心重启恢复选择：通过");
    });
    std::fs::remove_dir_all(dir).unwrap();
}

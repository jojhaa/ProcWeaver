use super::*;
use std::{io::{Read,Write},net::{TcpListener,TcpStream},sync::{Arc,atomic::{AtomicBool,Ordering}},time::Duration};

#[test]
#[ignore = "requires Windows administrator and WinDivert; never changes system proxy"]
fn system_proxy_process_priority_native() {
    let original = TcpListener::bind("127.0.0.1:0").unwrap();
    let original_port = original.local_addr().unwrap().port();
    let selected = TcpListener::bind("127.0.0.1:0").unwrap();
    let selected_port = selected.local_addr().unwrap().port();
    let ordinary = TcpListener::bind("127.0.0.1:0").unwrap();
    let ordinary_port = ordinary.local_addr().unwrap().port();
    let reserved = TcpListener::bind("127.0.0.1:0").unwrap();
    let mixed_port = reserved.local_addr().unwrap().port();
    let done = Arc::new(AtomicBool::new(false));
    fn serve(listener: TcpListener, done: Arc<AtomicBool>, marker: &'static str, tunnel: bool) -> std::thread::JoinHandle<usize> {
        listener.set_nonblocking(true).unwrap();
        std::thread::spawn(move || {
            let mut hits=0;
            while !done.load(Ordering::Acquire) {
                if let Ok((mut s,_))=listener.accept() {
                    s.set_nonblocking(false).unwrap(); s.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
                    let read_header=|s: &mut TcpStream| {let mut data=vec![];let mut b=[0];while data.len()<16384 && s.read_exact(&mut b).is_ok(){data.push(b[0]);if data.ends_with(b"\r\n\r\n"){break}};data};
                    let header=read_header(&mut s);
                    if tunnel {
                        assert!(header.starts_with(b"CONNECT "));
                        s.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n").unwrap();
                        assert!(read_header(&mut s).starts_with(b"GET "));
                    }
                    write!(s,"HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{marker}",marker.len()).unwrap();hits+=1;
                } else {std::thread::sleep(Duration::from_millis(5));}
            } hits
        })
    }
    let original_thread=serve(original,done.clone(),"original-proxy",false);
    let selected_thread=serve(selected,done.clone(),"selected-node",true);
    let ordinary_thread=serve(ordinary,done.clone(),"ordinary-local",false);
    let root=std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let dir=std::env::temp_dir().join(format!("netbox-local-proxy-{}",std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let config=format!("mode: rule\nlog-level: silent\nlisteners:\n- {{name: select, type: mixed, listen: '127.0.0.1', port: {mixed_port}, udp: true, rule: chosen}}\n- {{name: select6, type: mixed, listen: '::1', port: {mixed_port}, udp: true, rule: chosen}}\nproxies:\n- {{name: chosen-node, type: http, server: 127.0.0.1, port: {selected_port}}}\nsub-rules:\n  chosen: ['MATCH,chosen-node']\nrules: ['MATCH,REJECT']\n");
    std::fs::write(dir.join("config.yaml"),config).unwrap();drop(reserved);
    struct Core(std::process::Child);
    impl Drop for Core{fn drop(&mut self){let _=self.0.kill();let _=self.0.wait();}}
    let core=Core(std::process::Command::new(root.join("binaries/mihomo-v3.exe")).arg("-d").arg(&dir).arg("-f").arg(dir.join("config.yaml")).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn().unwrap());
    crate::commands::process::PID.store(core.0.id(), Ordering::SeqCst);
    for _ in 0..100 {if TcpStream::connect(("127.0.0.1",mixed_port)).is_ok(){break}std::thread::sleep(Duration::from_millis(50));}
    let plan=Plan{config: crate::routing_overrides::model::Overrides{process_enabled:true,process_rules:vec![crate::routing_overrides::model::ProcessRule{id:"root".into(),enabled:true,label:"root".into(),match_kind:"path".into(),match_value:std::env::current_exe().unwrap().to_string_lossy().into_owned(),action:"proxy".into(),target:None,include_descendants:true}],..Default::default()},ports:vec![mixed_port],dns_port:31999};
    let mut unmatched = plan.clone(); unmatched.config.process_rules[0].match_value="C:\\not-a-real-program.exe".into();
    let filter="outbound and (tcp or (!loopback and udp))".to_string();
    let capture=engine::Engine::start_proxy_test(plan,&root.join("binaries/windivert/WinDivert.dll"),&filter,vec![([127,0,0,1],original_port).into(),("::1".parse::<std::net::Ipv6Addr>().unwrap(),original_port).into()]).unwrap();
    let mut baseline=TcpStream::connect(("127.0.0.1",original_port)).unwrap();baseline.set_read_timeout(Some(Duration::from_secs(5))).unwrap();baseline.write_all(b"GET http://example.test/ HTTP/1.1\r\nHost: example.test\r\n\r\n").unwrap();let mut body=String::new();baseline.read_to_string(&mut body).unwrap();assert!(body.contains("original-proxy"));
    for proxy in [format!("http://127.0.0.1:{original_port}"),format!("socks5://127.0.0.1:{original_port}"),format!("http://[::1]:{original_port}")] {
        let script=format!("$ErrorActionPreference='Stop';$h=[Net.Http.HttpClientHandler]::new();$h.Proxy=[Net.WebProxy]::new('{proxy}');$c=[Net.Http.HttpClient]::new($h);$c.Timeout=[TimeSpan]::FromSeconds(8);try{{$c.GetStringAsync('http://203.0.113.123:18081/').GetAwaiter().GetResult()}}finally{{$c.Dispose()}}");
        let out=std::process::Command::new("pwsh").args(["-NoProfile","-Command",&script]).output().unwrap();
        assert!(out.status.success(),"{proxy}: {}",String::from_utf8_lossy(&out.stderr));assert!(String::from_utf8_lossy(&out.stdout).contains("selected-node"));
    }
    let connect_script=format!("$ErrorActionPreference='Stop';$c=[Net.Sockets.TcpClient]::new('127.0.0.1',{original_port});$s=$c.GetStream();$s.ReadTimeout=8000;$s.Write([Text.Encoding]::ASCII.GetBytes(\"CONNECT 203.0.113.123:18081 HTTP/1.1`r`nHost: 203.0.113.123:18081`r`n`r`n\"));$header='';while(-not $header.EndsWith(\"`r`n`r`n\")){{$n=$s.ReadByte();if($n -lt 0){{throw 'closed'}};$header += [char]$n;if($header.Length -gt 16384){{throw 'header limit'}}}};if($header -notmatch '200'){{throw 'CONNECT rejected'}};$s.Write([Text.Encoding]::ASCII.GetBytes(\"GET / HTTP/1.1`r`nHost: example.test`r`nConnection: close`r`n`r`n\"));$r=[IO.StreamReader]::new($s);$r.ReadToEnd();$c.Dispose()");
    let result=std::process::Command::new("pwsh").args(["-NoProfile","-Command",&connect_script]).output().unwrap();
    assert!(result.status.success(),"CONNECT: {}",String::from_utf8_lossy(&result.stderr));
    assert!(String::from_utf8_lossy(&result.stdout).contains("selected-node"));
    let probe=|port:u16| {let script=format!("$ErrorActionPreference='Stop';$h=[Net.Http.HttpClientHandler]::new();$h.Proxy=[Net.WebProxy]::new('http://127.0.0.1:{port}');$c=[Net.Http.HttpClient]::new($h);$c.Timeout=[TimeSpan]::FromSeconds(8);try{{$c.GetStringAsync('http://203.0.113.123/').GetAwaiter().GetResult()}}finally{{$c.Dispose()}}");std::process::Command::new("pwsh").args(["-NoProfile","-Command",&script]).output().unwrap()};
    let ordinary=probe(ordinary_port); assert!(ordinary.status.success()); assert!(String::from_utf8_lossy(&ordinary.stdout).contains("ordinary-local"));
    capture.stop();
    let capture=engine::Engine::start_proxy_test(unmatched,&root.join("binaries/windivert/WinDivert.dll"),&filter,vec![([127,0,0,1],original_port).into()]).unwrap();
    let bypass=probe(original_port); assert!(bypass.status.success()); assert!(String::from_utf8_lossy(&bypass.stdout).contains("original-proxy"));
    capture.stop();drop(core);done.store(true,Ordering::Release);
    assert_eq!(original_thread.join().unwrap(),2);assert_eq!(selected_thread.join().unwrap(),4);assert_eq!(ordinary_thread.join().unwrap(),1);
}

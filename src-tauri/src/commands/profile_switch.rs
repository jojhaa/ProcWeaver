use super::profile;
use crate::routing_overrides::{self as routing, foreign_targets, model::Target};
use serde::{Deserialize, Serialize};
use std::{fs, sync::atomic::Ordering};
#[cfg(test)] static FAIL_INDEX_SAVE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BindingDecision { pub mode: String, pub revision: u64, pub current_profile_id: String }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AffectedBinding { pub target: Target, pub subscription_name: String }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchPreview {
    pub profile_id: String, pub profile_name: String, pub current_profile_id: String, pub revision: u64,
    pub affected: Vec<AffectedBinding>, pub can_keep: bool, pub keep_error: Option<String>,
}
pub fn uses_saved_source(config: &routing::model::Overrides, id: &str) -> bool {
    config.retain_foreign_targets && foreign_targets::bindings(config, "").iter().any(|target| target.profile_id == id)
}
pub fn runtime_source_for_change(item: &profile::ProfileItem) -> Result<Option<std::path::PathBuf>, String> {
    if item.is_selected { return Ok(Some(profile::get_base_dir().join(&item.file_path))); }
    Ok(uses_saved_source(&routing::read()?, &item.id).then(|| routing::current_source().1))
}
#[tauri::command]
pub async fn preview_profile_switch(id: String) -> Result<SwitchPreview, String> {
    let lock = profile::PROFILE_WRITE.lock().await;
    tokio::task::spawn_blocking(move || {
        let _lock = lock;
        let list = profile::read_profiles_index();
        let next = list.iter().find(|p| p.id == id).ok_or("订阅不存在")?;
        let config = routing::read()?;
        let affected = foreign_targets::bindings(&config, &id).into_iter().map(|target| AffectedBinding {
            subscription_name: list.iter().find(|p| p.id == target.profile_id).map(|p| p.name.clone()).unwrap_or_else(|| "原订阅已移除".into()), target,
        }).collect::<Vec<_>>();
        let mut keep = config.clone(); keep.retain_foreign_targets = true;
        let keep_error = if affected.is_empty() { None } else {
            fs::read_to_string(profile::get_base_dir().join(&next.file_path)).map_err(|_| "读取候选订阅失败".to_string())
                .and_then(|raw| foreign_targets::materialize(&raw, &keep, &id)).err()
        };
        Ok(SwitchPreview { profile_id: id, profile_name: next.name.clone(), current_profile_id: routing::current_source().0,
            revision: config.revision, affected, can_keep: keep_error.is_none(), keep_error })
    }).await.map_err(|_| "订阅切换检查失败")?
}

pub async fn select(id: String, decision: Option<BindingDecision>) -> Result<bool, String> {
    let _lock = profile::PROFILE_WRITE.lock().await;
    let mut list = profile::read_profiles_index();
    let next = list.iter().find(|p| p.id == id).ok_or("订阅不存在")?;
    if next.is_selected { return Ok(true); }
    let path = profile::get_base_dir().join(&next.file_path);
    let old = routing::read()?;
    let mut config = old.clone();
    let affected = foreign_targets::bindings(&old, &id);
    if let Some(decision) = decision {
        if decision.revision != old.revision || decision.current_profile_id != routing::current_source().0 {
            return Err("订阅或分流规则已改变，请取消后重新选择订阅".into());
        }
        config.retain_foreign_targets = match decision.mode.as_str() {
            "keep" => true, "hold" => false, _ => return Err("原绑定出口处理方式无效".into()),
        };
    } else if !affected.is_empty() {
        return Err("此订阅切换涉及已绑定出口，请先选择继续使用原节点或保留绑定后换绑".into());
    }
    let changed = config.retain_foreign_targets != old.retain_foreign_targets;
    if changed { config.revision = old.revision.checked_add(1).ok_or("规则修订号已耗尽")?; }
    let config_path = crate::storage::data_dir().join("config/routing-overrides.json");
    let old_bytes = match fs::read(&config_path) {
        Ok(bytes) => Some(bytes), Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(_) => return Err("读取分流恢复数据失败，未切换".into()),
    };
    let old_runtime = if super::process::ACTIVE.load(Ordering::SeqCst) {
        Some(fs::read_to_string(crate::storage::data_dir().join("core_data/config.yaml")).map_err(|_| "读取运行恢复数据失败，未切换")?)
    } else { None };
    profile::apply_profile_with_overrides(&path.to_string_lossy(), &config).await?;
    for item in &mut list { item.is_selected = item.id == id; }
    let commit = (|| {
        if changed { crate::storage::replace_atomic(&config_path, &serde_json::to_vec_pretty(&config).map_err(|_| "保存出口处理方式失败")?)?; }
        #[cfg(test)] if FAIL_INDEX_SAVE.swap(false, Ordering::SeqCst) { return Err("测试模拟索引保存失败".into()); }
        profile::write_profiles_index(&list)
    })();
    if let Err(error) = commit {
        let mut failures = Vec::new();
        if changed {
            let restored = if let Some(bytes) = old_bytes { crate::storage::replace_atomic(&config_path, &bytes) }
                else { fs::remove_file(&config_path).or_else(|e| if e.kind() == std::io::ErrorKind::NotFound { Ok(()) } else { Err(e) }).map_err(|_| "清理候选分流配置失败".into()) };
            if let Err(e) = restored { failures.push(e); }
        }
        if let Some(raw) = old_runtime { if let Err(e) = routing::apply_runtime(&raw).await { failures.push(e); } }
        routing::set_applied(old.revision, routing::tracker::status(&old).generation);
        return Err(if failures.is_empty() { format!("切换保存失败，已恢复原运行配置：{error}") }
            else { format!("切换保存失败：{error}；恢复异常：{}", failures.join("；")) });
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{commands::{process, settings}, routing_overrides::{model::*, bundles}};
    #[cfg(windows)]
    #[test]
    fn subscription_switch_choices_preserve_identity_and_runtime() {
        const NAME: &str = "commands::profile_switch::tests::subscription_switch_choices_preserve_identity_and_runtime";
        const FLAG: &str = "PROCWEAVER_PROFILE_BINDING_TEST";
        if std::env::var_os(FLAG).is_none() {
            assert!(std::process::Command::new(std::env::current_exe().unwrap()).args(["--exact", NAME, "--nocapture"]).env(FLAG,"1").status().unwrap().success()); return;
        }
        let root = std::env::temp_dir().join(format!("procweaver-profile-binding-{}",std::process::id()));
        crate::storage::initialize_test(root.clone(),std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf());
        let mut used = std::collections::HashSet::new();
        let mut free = || loop {
            let tcp = std::net::TcpListener::bind("127.0.0.1:0").unwrap(); let port = tcp.local_addr().unwrap().port();
            if used.insert(port) && std::net::UdpSocket::bind(("127.0.0.1",port)).is_ok() { break port; }
        };
        let prefs = settings::GeneralSettings { mixed_port: free(), controller_port: free(), ..Default::default() };
        let entry = free();
        fs::write(root.join("config/preferences.json"),serde_json::to_vec(&prefs).unwrap()).unwrap();
        fs::write(root.join("config/local-rules.json"),r#"{"enabled":false,"providers":[]}"#).unwrap();
        let state = std::sync::Mutex::new(process::CoreState { child:None,mixed_port:prefs.mixed_port,controller_port:prefs.controller_port,active_core:None,active_core_path:None,core_mode:None,started_at:None });
        struct Cleanup<'a>(&'a std::sync::Mutex<process::CoreState>);
        impl Drop for Cleanup<'_> { fn drop(&mut self) { if let Ok(mut state)=self.0.lock() { let _=process::stop_owned_child(&mut state); } } }
        let cleanup = Cleanup(&state);
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            use tokio::io::{AsyncReadExt,AsyncWriteExt};
            let mut servers = vec![];
            for id in ["old","new"] {
                let server = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap(); let port = server.local_addr().unwrap().port();
                fs::write(root.join(format!("config/{id}.yaml")),format!("proxies:\n- {{name: Same, type: http, server: 127.0.0.1, port: {port}}}\nproxy-groups:\n- {{name: OldGroup, type: select, proxies: [Same]}}\n- {{name: PROXY, type: select, proxies: [Same]}}\n- {{name: All, type: select, include-all: true, exclude-filter: '^Excluded$'}}\nrules: ['MATCH,PROXY']\n")).unwrap();
                servers.push(tokio::spawn(async move { loop {
                    let (mut socket,_) = server.accept().await.unwrap();
                    tokio::spawn(async move {
                        let mut header = vec![]; let mut byte=[0];
                        while !header.ends_with(b"\r\n\r\n") && header.len()<8192 { if socket.read_exact(&mut byte).await.is_err() { return; } header.push(byte[0]); }
                        if !header.starts_with(b"CONNECT ") { return; }
                        if socket.write_all(b"HTTP/1.1 200 Connection established\r\n\r\n").await.is_err() { return; }
                        if socket.read_exact(&mut byte).await.is_ok() { let _=socket.write_all(format!("{id}\n").as_bytes()).await; }
                    });
                }}));
            }
            let list: Vec<_> = ["old","new"].iter().map(|id| profile::ProfileItem { id:(*id).into(),name:(*id).into(),file_path:format!("config/{id}.yaml"),is_selected:*id=="old",..Default::default() }).collect();
            profile::write_profiles_index(&list).unwrap();
            let target = Target { profile_id:"old".into(),kind:"node".into(),name:"Same".into() };
            let mut config = Overrides { process_enabled:true,dns_enabled:true,..Default::default() };
            config.process_rules.push(ProcessRule{id:"bundle-bound-main".into(),enabled:true,label:"测试应用".into(),match_kind:"name".into(),match_value:"fixture-browser.exe".into(),action:"proxy".into(),target:Some(target.clone()),include_descendants:false,rule_mode:Some("strict".into())});
            config.dns_rules.push(DnsRule{id:"manual-dns".into(),enabled:true,domain_kind:"exact".into(),domain:"bound.example.test".into(),resolver_url:"https://192.0.2.53/dns-query".into(),target:target.clone()});
            config.bundles.push(BundleRoute{id:"bound".into(),name:"测试包".into(),main_exe:"fixture-browser.exe".into(),enabled:true,main_target:Some(target.clone()),dns_target:Some(target.clone()),port:entry,mode:"strict".into(),domains:vec![],fallback:"rules".into()});
            fs::write(root.join("config/routing-overrides.json"),serde_json::to_vec(&config).unwrap()).unwrap();
            async fn probe(port:u16)->Result<String,String> {
                let mut socket=tokio::net::TcpStream::connect(("127.0.0.1",port)).await.map_err(|e|e.to_string())?;
                socket.write_all(b"CONNECT 192.0.2.123:443 HTTP/1.1\r\nHost: 192.0.2.123:443\r\n\r\n").await.unwrap();
                let mut header=vec![]; let mut byte=[0];
                while !header.ends_with(b"\r\n\r\n") && header.len()<8192 {
                    tokio::time::timeout(std::time::Duration::from_secs(3),socket.read_exact(&mut byte)).await.map_err(|_|"timeout")?.map_err(|_|"closed")?;header.push(byte[0]);
                }
                if !String::from_utf8_lossy(&header).contains("200") { return Err("rejected".into()); }
                socket.write_all(b"?").await.unwrap(); let mut value=vec![];
                while !value.ends_with(b"\n") && value.len()<32 {
                    tokio::time::timeout(std::time::Duration::from_secs(3),socket.read_exact(&mut byte)).await.map_err(|_|"timeout")?.map_err(|_|"closed")?;value.push(byte[0]);
                }
                Ok(String::from_utf8_lossy(&value).trim().into())
            }
            async fn decision(id:&str,mode:&str)->BindingDecision {
                let preview=preview_profile_switch(id.into()).await.unwrap();
                if mode=="keep" { assert!(preview.can_keep,"{:?}",preview.keep_error); }
                BindingDecision{mode:mode.into(),revision:preview.revision,current_profile_id:preview.current_profile_id}
            }
            process::start_core_transaction(Some("compatible".into()),&state).await.unwrap();
            assert_eq!(probe(entry).await.unwrap(),"old");
            assert!(select("new".into(),None).await.unwrap_err().contains("先选择"));
            select("new".into(),Some(decision("new","keep").await)).await.unwrap();
            assert_eq!(routing::current_source().0,"new"); assert_eq!(probe(entry).await.unwrap(),"old"); assert_eq!(probe(prefs.mixed_port).await.unwrap(),"new");
            let retained=routing::read().unwrap(); assert_eq!(retained.bundles[0].main_target,Some(target.clone())); assert!(retained.retain_foreign_targets);
            let view=routing::view().unwrap(); assert!(view.unavailable_rules.is_empty()); assert!(view.preserved_targets.contains(&target));
            let all:serde_json::Value=crate::commands::mihomo_api::controller_client().build().unwrap()
                .get(format!("http://127.0.0.1:{}/proxies/All",prefs.controller_port)).send().await.unwrap().json().await.unwrap();
            assert_eq!(all["all"],serde_json::json!(["Same"]), "automatic subscription groups must not collect retained nodes");
            assert!(profile::delete_profile("old".into()).await.unwrap_err().contains("仍用于"));
            let original_source=fs::read_to_string(root.join("config/old.yaml")).unwrap();
            let next_source=fs::read_to_string(root.join("config/new.yaml")).unwrap();
            profile::save_profile_content("old".into(),next_source).await.unwrap();
            assert_eq!(probe(entry).await.unwrap(),"new", "retained source edits must reach the running core");
            profile::save_profile_content("old".into(),original_source.clone()).await.unwrap();
            assert_eq!(probe(entry).await.unwrap(),"old");
            assert!(profile::save_profile_content("old".into(),original_source.replace("Same","Gone")).await.is_err());
            assert_eq!(fs::read_to_string(root.join("config/old.yaml")).unwrap(),original_source);
            assert_eq!(probe(entry).await.unwrap(),"old");
            let runtime:serde_yaml::Value=serde_yaml::from_str(&fs::read_to_string(root.join("core_data/config.yaml")).unwrap()).unwrap();
            let public=runtime["proxy-groups"].as_sequence().unwrap().iter().find(|g|g["name"].as_str()==Some("PROXY")).unwrap();
            assert!(!public["proxies"].as_sequence().unwrap().iter().any(|p|p.as_str().unwrap_or("").starts_with(foreign_targets::PREFIX)));
            assert_eq!(runtime[bundles::SELECTIONS][bundles::group("bound","main")].as_str(),Some(foreign_targets::alias(&target).as_str()));
            process::stop_owned_child(&mut state.lock().unwrap()).unwrap();
            process::start_core_transaction(Some("compatible".into()),&state).await.unwrap(); assert_eq!(probe(entry).await.unwrap(),"old");
            select("old".into(),None).await.unwrap();
            let before=fs::read(root.join("config/routing-overrides.json")).unwrap();
            let mut stale=decision("new","keep").await; stale.revision+=1;
            assert!(select("new".into(),Some(stale)).await.unwrap_err().contains("已改变"));
            assert_eq!(routing::current_source().0,"old");
            FAIL_INDEX_SAVE.store(true,Ordering::SeqCst);
            assert!(select("new".into(),Some(decision("new","hold").await)).await.unwrap_err().contains("已恢复"));
            assert_eq!(routing::current_source().0,"old"); assert_eq!(fs::read(root.join("config/routing-overrides.json")).unwrap(),before);
            assert_eq!(probe(entry).await.unwrap(),"old"); assert_eq!(probe(prefs.mixed_port).await.unwrap(),"old");
            select("new".into(),Some(decision("new","hold").await)).await.unwrap();
            assert_eq!(routing::read().unwrap().bundles[0].main_target,Some(target.clone()));
            assert!(probe(entry).await.is_err()); assert_eq!(probe(prefs.mixed_port).await.unwrap(),"new");
            let view=routing::view().unwrap(); assert!(view.unavailable_rules.contains(&"bundle:bound".into())); assert!(view.unavailable_rules.contains(&"manual-dns".into()));
            let stopped=fs::read_to_string(root.join("core_data/config.yaml")).unwrap();
            assert!(stopped.contains(&format!("#{}",foreign_targets::alias(&target))));
            select("old".into(),None).await.unwrap(); assert_eq!(probe(entry).await.unwrap(),"old");
            // Static groups retain their own source members, including same-name nodes.
            let mut group_config=routing::read().unwrap(); group_config.retain_foreign_targets=true;
            group_config.bundles[0].main_target=Some(Target{kind:"group".into(),name:"OldGroup".into(),..target.clone()});
            let raw=fs::read_to_string(root.join("config/new.yaml")).unwrap();
            let imported=foreign_targets::materialize(&raw,&group_config,"new").unwrap().0;
            assert!(imported.contains(&foreign_targets::alias(&Target{kind:"group".into(),name:"OldGroup".into(),..target.clone()})));
            let mut disabled=group_config.clone(); disabled.process_enabled=false; disabled.dns_enabled=false;
            let (materialized,mapped)=foreign_targets::materialize(&raw,&disabled,"new").unwrap();
            assert!(bundles::materialize(&materialized,&mapped,"new").is_ok());
            disabled.bundles[0].enabled=false;
            assert!(foreign_targets::bindings(&disabled,"new").is_empty());
            assert!(foreign_targets::saved_bindings(&disabled,"new").contains(&target));
            // Missing/dynamic sources must leave an explicit safe hold option.
            group_config.bundles[0].main_target=Some(target.clone());
            fs::write(root.join("config/old.yaml"),original_source.replace("port:","dialer-proxy: Same, port:")).unwrap();
            assert!(foreign_targets::materialize(&raw,&group_config,"new").unwrap_err().contains("循环"));
            fs::write(root.join("config/old.yaml"),original_source.replace("proxies: [Same]","proxies: [Same], include-all: true")).unwrap();
            group_config.bundles[0].main_target=Some(Target{kind:"group".into(),name:"OldGroup".into(),..target.clone()});
            assert!(foreign_targets::materialize(&raw,&group_config,"new").unwrap_err().contains("动态"));
            fs::remove_file(root.join("config/old.yaml")).unwrap();
            let preview=preview_profile_switch("new".into()).await.unwrap(); assert!(!preview.can_keep);
            select("new".into(),Some(decision("new","hold").await)).await.unwrap();
            assert!(probe(entry).await.is_err()); assert_eq!(probe(prefs.mixed_port).await.unwrap(),"new");
            for server in servers { server.abort(); }
            process::stop_owned_child(&mut state.lock().unwrap()).unwrap();
        });
        drop(cleanup); fs::remove_dir_all(root).unwrap();
    }
}

use serde::{Deserialize, Serialize};
use std::{collections::{HashMap, VecDeque}, path::{Path, PathBuf}, sync::{LazyLock, Mutex}, time::{Duration, Instant}};
use tauri::{Emitter, Manager};
use super::{windows_integration as native, process};
use crate::routing_overrides::{self, model::BundleRoute};

static LAUNCH: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static CONFIRMATIONS: LazyLock<Mutex<HashMap<String, Confirmation>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static REQUESTS: Mutex<VecDeque<LaunchRequest>> = Mutex::new(VecDeque::new());
#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
#[serde(rename_all="camelCase")]
pub struct LaunchRequest { pub instance_id: String, pub shortcut_id: Option<String> }
#[derive(Clone, Serialize)]
#[serde(rename_all="camelCase")]
pub struct LaunchOutcome {
    pub state: String, pub message: String, pub confirmation: Option<String>,
    pub entry: String, pub process_count: usize,
}
#[derive(Clone,Serialize)]
#[serde(rename_all="camelCase")]
pub struct EntryStatus {
    pub instance_id:String, pub state:String, pub message:String, pub chains:Vec<String>,
    pub connection_state:String, pub connection_message:String,
    pub instance_key:String,
    pub monitor_message:String,
    pub monitor_state:Option<routing_overrides::tracker::MonitorState>,
    pub identity_state:String, pub identity_message:String,
}
#[cfg(any(windows, test))]
fn monitor_report(main_exe:&str,selected:Option<&Path>,observation:&routing_overrides::tracker::Observation)->(String,String,String) {
    use routing_overrides::tracker::MonitorState;
    let message=match observation.state {
        MonitorState::Disabled=>"监控未开启，尚未核验当前进程",
        MonitorState::Initializing=>"正在建立进程快照；尚未确认目标是否运行",
        MonitorState::Stale=>"数据已过期（超过 15 秒未取得有效快照），旧记录不能代表当前运行状态",
        MonitorState::Current=>"事件监听正常，进程快照有效",
        MonitorState::Degraded=>"事件监听降级，正以有效快照补查；短命进程可能漏检",
    }.to_string();
    if !observation.state.is_fresh() { return (message,"unverified".into(),"当前身份未核实，等待监控恢复".into()); }
    let name=Path::new(main_exe).file_name().unwrap_or_default().to_string_lossy();
    if observation.unverified_names.iter().any(|n|crate::platform::same_path(&name,n)) {
        return (message,"unverified".into(),"发现同名进程，但实例身份无法读取；暂不能完整核实程序归属，未准备重启".into());
    }
    let candidates:Vec<_>=observation.entries.iter().filter(|p|!p.identity.is_empty() && crate::platform::same_path(&name,&p.name)).collect();
    if candidates.is_empty() { return (message,"not_seen".into(),"当前未发现可核实的同名进程".into()); }
    let unreadable=candidates.iter().filter(|p|p.executable_path.is_none()).count();
    let confirmed=candidates.iter().filter(|p|selected.is_some_and(|exe|p.executable_path.as_deref().is_some_and(|path|crate::platform::same_path(path,&exe.to_string_lossy())))).count();
    let paths:std::collections::HashSet<_>=candidates.iter().filter_map(|p|p.executable_path.as_deref()).map(crate::platform::path_key).collect();
    if unreadable>0 { return (message,"instance_verified".into(),format!("已发现 {} 个同名实例（含辅助进程），其中 {unreadable} 个路径不可读；无法完整确认程序归属，暂不准备重启",candidates.len())); }
    if selected.is_none() { return (message,if paths.len()>1{"ambiguous"}else{"instance_verified"}.into(),format!("发现 {} 个同名实例、{} 个程序路径；请先选择本包主程序，不能仅凭名称确认归属",candidates.len(),paths.len())); }
    if confirmed==0 { return (message,"other_path".into(),"发现同名程序，但路径与本包所选程序不同，未计为本包实例".into()); }
    let other=candidates.len()-confirmed;
    (message,"path_verified".into(),format!("已确认 {confirmed} 个目标路径实例（含辅助进程）；不代表已接入代理{}",if other>0 {format!("；另有 {other} 个其他路径同名实例未计入")}else{String::new()}))
}
fn instance_key(running:&[Instance],port:u16)->String {
    if running.is_empty() {return String::new();}
    let mut identities:Vec<_>=running.iter().map(|p|p.identity.as_str()).collect(); identities.sort_unstable();
    format!("{port}:{}",identities.join("|"))
}
fn application_status(running:&[Instance],port:u16)->(&'static str,String) {
    #[cfg(windows)]
    if super::settings::get_general_settings().is_ok_and(|s|s.traffic_mode==crate::capture::windivert::plan::MODE) {
        return if crate::capture::windivert::session::stats().active {
            ("capture",format!("WinDivert 模式，发现 {} 个主实例；无需为代理参数重启，实际接管范围及新连接出口请查看连接记录",running.len()))
        } else { ("capture_pending","WinDivert 尚未接管；启动核心并完成管理员授权后核验，不按启动参数要求重启应用".into()) };
    }
    let connected=running.iter().filter(|p|proxy_matches(&p.args,port)).count();
    if running.is_empty() { ("idle","未检测到所选程序的主实例（已检查默认及自定义资料目录）".into()) }
    else if connected==running.len() { ("connected",format!("检测到 {} 个主实例，启动参数均已接入本包入口；实际连接另行核验",running.len())) }
    else if connected>0 { ("partial",format!("{} / {} 个主实例已接入；其余资料实例未接入，请从对应快捷方式检测，重启需确认",connected,running.len())) }
    else { ("restart_required",format!("检测到 {} 个主实例未使用本包入口；点击检测并启动应用，重启时会请求确认",running.len())) }
}
fn observe_connections(result:&mut [EntryStatus],value:&serde_json::Value)->Result<(),String> {
    let connections=value["connections"].as_array().ok_or("核心连接记录格式无效，无法核验分流")?;
    for status in result {
        let name=routing_overrides::bundles::listener(&status.instance_id);
        let group=routing_overrides::bundles::group(&status.instance_id,"main");
        status.chains.clear();
        for connection in connections {
            let chains:Vec<_>=connection["chains"].as_array().into_iter().flatten().filter_map(|s|s.as_str()).collect();
            if connection["metadata"]["inboundName"].as_str()==Some(&name) || chains.contains(&group.as_str()) {
                let chain=chains.into_iter().filter(|s|!s.starts_with("PW-")).collect::<Vec<_>>().join(" → ");
                let host=connection["metadata"]["host"].as_str().filter(|s|!s.is_empty()).or(connection["metadata"]["destinationIP"].as_str()).unwrap_or("未知目标");
                let rule=connection["rule"].as_str().unwrap_or("未知规则");
                let line=format!("{host} · {rule} → {}",if chain.is_empty(){"出口未返回"}else{&chain});
                if !status.chains.contains(&line) {status.chains.push(line);}
                if status.chains.len() == 4 { break; }
            }
        }
        status.connection_state=if status.chains.is_empty(){"idle"}else{"observed"}.into();
        status.connection_message=if status.chains.is_empty(){"本次未观察到本包活动连接；请发起新请求后查看连接记录"}else{"已观察到本包连接（可能含旧连接；最多展示 4 项，完整规则见连接记录）"}.into();
    }
    Ok(())
}
async fn read_connections()->Result<serde_json::Value,String> {
    let port=super::settings::get_general_settings()?.controller_port;
    let client=super::mihomo_api::controller_client().timeout(Duration::from_secs(2)).build().map_err(|_|"无法建立连接记录查询")?;
    client.get(format!("http://127.0.0.1:{port}/connections")).send().await.map_err(|_|"读取核心连接记录失败或超时，无法核验分流")?
        .error_for_status().map_err(|_|"核心拒绝读取连接记录，请检查控制接口状态")?
        .json().await.map_err(|_|"核心连接记录响应无效，无法核验分流".into())
}
#[tauri::command]
pub async fn get_bundle_entry_states(instance_ids:Vec<String>)->Result<Vec<EntryStatus>,String> {
    if instance_ids.len()>128{return Err("一次最多检测 128 个业务包".into());}
    let bundles=routing_overrides::read()?.effective().bundles;
    let selected:Vec<_>=bundles.into_iter().filter(|b|instance_ids.contains(&b.id) && b.enabled).collect();
    let mut result=tokio::task::spawn_blocking(move|| {
        #[cfg(windows)] let observation=routing_overrides::tracker::observation();
        let plans:Vec<_>=selected.into_iter().map(|bundle| {
            let exe=resolve_executable(&bundle);
            #[cfg(windows)] let report=monitor_report(&bundle.main_exe,exe.as_deref().ok(),&observation);
            #[cfg(not(windows))] let report=(String::new(),String::new(),String::new());
            (bundle,exe,report)
        }).collect();
        let mut names:Vec<_>=plans.iter().filter(|(_,_,report)|!cfg!(windows) || report.1=="path_verified")
            .filter_map(|(_,exe,_)|exe.as_ref().ok()?.file_name().map(|n|n.to_string_lossy().into_owned())).collect();
        names.sort(); names.dedup();
        let rows=native::process_command_lines(&names.iter().map(String::as_str).collect::<Vec<_>>());
        let mut checked: HashMap<PathBuf, Result<Vec<Instance>, String>> = HashMap::new();
        plans.into_iter().map(|(bundle,exe,(monitor_message,identity_state,identity_message))| {
        let outcome=(||{
            if cfg!(windows) && identity_state!="path_verified" {
                return Ok((if matches!(identity_state.as_str(),"not_seen"|"other_path"){"idle"}else{"unverified"},identity_message.clone(),String::new()));
            }
            let exe=exe?;
            let running=checked.entry(exe.clone()).or_insert_with(|| match &rows {
                Ok(rows)=>instances_from_commands(&exe,None,rows.iter().filter(|row|crate::platform::same_path(&row.name,&exe.file_name().unwrap_or_default().to_string_lossy())).map(|row|(row.pid,row.command.as_str()))),
                Err(error)=>Err(error.clone()),
            });
            match running { Ok(running) => {
                let (state,message)=application_status(running,bundle.port);
                #[cfg(target_os = "macos")]
                let (state,message)=if !running.is_empty() && !crate::platform::macos::apps::supports_proxy_arguments(&exe) {
                    ("unverified", "已识别应用；原生 GUI 使用系统代理，命令行使用代理环境变量，实际接入以连接记录为准".into())
                } else { (state,message) };
                Ok::<_,String>((state,message,instance_key(running,bundle.port)))
            }, Err(error) => Err(error.clone()) }
        })();
        let (state,message,instance_key)=outcome.unwrap_or_else(|message|("unverified",message,String::new()));
        #[cfg(windows)] let monitor_state=Some(observation.state);
        #[cfg(not(windows))] let monitor_state=None;
        EntryStatus{instance_id:bundle.id,state:state.into(),message,instance_key,monitor_message,monitor_state,identity_state,identity_message,chains:vec![],connection_state:"core_stopped".into(),connection_message:"核心未运行，无法核验连接分流".into()}
    }).collect::<Vec<_>>() }).await.map_err(|_|"应用检测任务失败")?;
    if process::ACTIVE.load(std::sync::atomic::Ordering::SeqCst) {
        let observed=read_connections().await.and_then(|value|observe_connections(&mut result,&value));
        if let Err(error)=observed {
            for status in &mut result {status.chains.clear();status.connection_state="error".into();status.connection_message=error.clone();}
        }
    }
    Ok(result)
}
#[derive(Clone)]
struct Instance { pid: u32, identity: String, args: Vec<String> }
struct Confirmation { request: LaunchRequest, exe: PathBuf, directory: String, args: Vec<String>, instances: Vec<Instance>, expires: Instant, port: u16, main_exe: String, enabled: bool }
impl Confirmation {
    fn matches(&self,request:&LaunchRequest,bundle:&BundleRoute)->bool {
        self.expires>Instant::now() && self.request==*request && self.port==bundle.port
            && self.main_exe==bundle.main_exe && self.enabled==bundle.enabled
    }
    fn preflight(&self)->Result<(),String> {
        #[cfg(windows)]
        super::packaged_app::preflight(&self.exe,&proxy_args(self.args.clone(),self.port))?;
        Ok(())
    }
    fn close_after_preflight(&self, close:impl Fn(&Instance)->Result<(),String>)->Result<(),String> {
        self.preflight()?;
        for instance in &self.instances { close(instance)?; }
        Ok(())
    }
}

pub fn id() -> String {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    format!("{:x}-{:x}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos(), NEXT.fetch_add(1,std::sync::atomic::Ordering::Relaxed))
}
fn valid_id(id: &str) -> bool { !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b==b'-' || b==b'_') }
pub fn parse_request(args: &[String]) -> Option<LaunchRequest> {
    let start = args.iter().position(|s| s == "--launch-bundle")?;
    let instance_id = args.get(start+1)?.clone(); if !valid_id(&instance_id) { return None; }
    let shortcut_id = args.iter().position(|s| s=="--shortcut").and_then(|i| args.get(i+1)).cloned();
    if shortcut_id.as_ref().is_some_and(|id| !valid_id(id)) { return None; }
    Some(LaunchRequest { instance_id, shortcut_id })
}
pub fn dispatch(app: &tauri::AppHandle, args: Vec<String>) {
    if let Some(request) = parse_request(&args) {
        let mut pending=REQUESTS.lock().unwrap_or_else(|p|p.into_inner());
        if pending.len()>=16 && !pending.contains(&request) {
            drop(pending); crate::app_lifecycle::show(app);
            let _=app.emit("procweaver-bundle-launch-overflow","等待处理的应用启动请求已达 16 项，请处理当前提示后再次点击快捷方式");
            return;
        }
        if !pending.contains(&request) { pending.push_back(request); }
        drop(pending); crate::app_lifecycle::show(app); let _=app.emit("procweaver-bundle-launch",());
    }
}
#[tauri::command]
pub fn take_bundle_launch_requests() -> Vec<LaunchRequest> { REQUESTS.lock().unwrap_or_else(|p|p.into_inner()).drain(..).collect() }
pub fn route(id: &str) -> Result<BundleRoute,String> {
    routing_overrides::read()?.effective().bundles.into_iter().find(|b| b.id==id).ok_or("业务包尚未保存或已移除，请先在业务包页面应用规则".into())
}
pub fn resolve_executable(bundle: &BundleRoute) -> Result<PathBuf,String> {
    let supplied=PathBuf::from(&bundle.main_exe);
    #[cfg(target_os = "macos")]
    if supplied.is_absolute() { return crate::platform::macos::apps::resolve(&supplied); }
    if supplied.is_absolute() && supplied.is_file() { return Ok(supplied); }
    let paths=app_paths()?;
    if let Some(path)=paths.get(&bundle.id).filter(|p|Path::new(p).is_file() && Path::new(p).file_name().unwrap_or_default().to_string_lossy().eq_ignore_ascii_case(Path::new(&bundle.main_exe).file_name().unwrap_or_default().to_string_lossy().as_ref())) { return Ok(PathBuf::from(path)); }
    let preset=super::shortcut_manager::normalize_app_id(&bundle.main_exe);
    super::app_launcher::find_app_executable(&preset).ok_or("未找到应用，请选择该业务包的主程序（Windows EXE / macOS 应用）".into())
}
fn app_paths() -> Result<HashMap<String,String>,String> {
    let path=crate::storage::data_dir().join("config/bundle-app-paths.json");
    match std::fs::read(path) {
        Ok(bytes)=>serde_json::from_slice(&bytes).map_err(|_|"本机应用路径文件损坏，未覆盖".into()),
        Err(e) if e.kind()==std::io::ErrorKind::NotFound=>Ok(HashMap::new()),
        Err(_)=>Err("读取本机应用路径失败".into()),
    }
}
#[tauri::command]
pub async fn choose_bundle_executable(instance_id:String) -> Result<Option<String>,String> {
    let bundle=route(&instance_id)?;
    let Some(path)=super::routing_overrides::choose_routing_executable().await? else {return Ok(None)};
    if !Path::new(&path).file_name().is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case(Path::new(&bundle.main_exe).file_name().unwrap_or_default().to_string_lossy().as_ref())) { return Err("所选程序文件名与业务包主程序不一致".into()); }
    let mut paths=app_paths()?; paths.insert(instance_id,path.clone());
    crate::storage::replace_atomic(&crate::storage::data_dir().join("config/bundle-app-paths.json"), &serde_json::to_vec_pretty(&paths).map_err(|_|"保存应用路径失败")?)?;
    Ok(Some(path))
}
pub fn option(args:&[String], key:&str)->Option<String> {
    let prefix=format!("{key}=");
    args.iter().enumerate().rev().find_map(|(i,arg)|arg.strip_prefix(&prefix).map(String::from).or_else(||if arg==key {args.get(i+1).cloned()}else{None}))
}
pub fn proxy_matches(args:&[String], port:u16)->bool {
    option(args,"--proxy-server").is_some_and(|v|v==format!("http://127.0.0.1:{port}") || v==format!("127.0.0.1:{port}"))
        && !args.iter().any(|s|s=="--no-proxy-server" || s=="--proxy-auto-detect" || s.starts_with("--proxy-pac-url"))
}
fn proxy_args(args:Vec<String>,port:u16)->Vec<String> {
    let mut output=Vec::new(); let mut skip=false;
    for arg in args {
        if skip {skip=false;continue;}
        if ["--proxy-server","--proxy-bypass-list","--proxy-pac-url"].contains(&arg.as_str()) {skip=true;continue;}
        if ["--proxy-server=","--proxy-bypass-list=","--proxy-pac-url="].iter().any(|p|arg.starts_with(p)) || ["--no-proxy-server","--proxy-auto-detect"].contains(&arg.as_str()) {continue;}
        output.push(arg);
    }
    output.push(format!("--proxy-server=http://127.0.0.1:{port}"));
    output.push("--proxy-bypass-list=<-loopback>;localhost;127.0.0.1;::1".into()); output
}
fn with_shortcut_args(running:&[String],shortcut:&[String])->Vec<String> {
    let mut result=running.to_vec();
    // Chromium shares a main process between profile directories under the same
    // user-data-dir. Explicit shortcut profile options must win over that process's
    // original profile, including when reusing its already-correct proxy entry.
    for key in ["--profile-directory","--user-data-dir"] {
        if option(shortcut,key).is_some() {
            let mut skip=false; result.retain(|arg|{if skip{skip=false;return false;}if arg==key{skip=true;return false;}!arg.starts_with(&format!("{key}="))});
        }
    }
    result.extend_from_slice(shortcut); result
}
fn spawn_application(exe:&Path,directory:&str,args:Vec<String>,port:u16)->Result<&'static str,String> {
    #[cfg(target_os = "macos")]
    let args=if crate::platform::macos::apps::supports_proxy_arguments(exe) { proxy_args(args,port) } else { args };
    #[cfg(not(target_os = "macos"))]
    let args=proxy_args(args,port);
    #[cfg(windows)]
    if let Some(application)=super::packaged_app::resolve(exe)? {
        application.activate(&args)?;
        return Ok(super::packaged_app::activation_note());
    }
    let proxy=format!("http://127.0.0.1:{port}");let mut command=std::process::Command::new(exe);
    command.args(args);
    for key in ["HTTP_PROXY","HTTPS_PROXY","ALL_PROXY","http_proxy","https_proxy","all_proxy"] {command.env(key,&proxy);}
    command.env("NO_PROXY","localhost,127.0.0.1,::1").env("no_proxy","localhost,127.0.0.1,::1").env("NODE_USE_ENV_PROXY","1");
    if !directory.is_empty(){command.current_dir(directory);}else if let Some(dir)=exe.parent(){command.current_dir(dir);}
    command.spawn().map_err(|e|format!("启动应用失败：{e}"))?;
    Ok("已使用业务包入口启动，沿用现有用户资料；启动成功不等于实际连接出口已验证")
}
fn instances(exe:&Path,args:Option<&[String]>)->Result<Vec<Instance>,String> {
    let name=exe.file_name().ok_or("应用路径无效")?.to_string_lossy();
    let commands=native::command_lines(&name)?;
    instances_from_commands(exe,args,commands.iter().map(|(pid,command)|(*pid,command.as_str())))
}
fn instances_from_commands<'a>(exe:&Path,args:Option<&[String]>,commands:impl Iterator<Item=(u32,&'a str)>)->Result<Vec<Instance>,String> {
    let name=exe.file_name().ok_or("应用路径无效")?.to_string_lossy();
    let mut result=Vec::new(); let requested=args.and_then(|args|option(args,"--user-data-dir"));
    for (pid,command) in commands {
        let entry=routing_overrides::native::inspect(pid,0,name.to_string());
        if entry.identity.is_empty() {
            if routing_overrides::native::snapshot()?.iter().any(|p|p.pid==pid) {return Err("已有应用实例身份不可读，未尝试重复启动；请正常退出后重试".into());}
            continue;
        }
        let path=entry.executable_path.ok_or("应用身份不可读，请手动正常退出后再启动")?;
        if !crate::platform::same_path(&path,&exe.to_string_lossy()) {continue;}
        if command.trim().is_empty() {return Err("应用参数不可读，无法核实是否接入；请正常退出应用后重试".into());}
        let arguments=native::split_arguments(&command)?;
        if option(&arguments,"--type").is_some() {continue;}
        if args.is_some() && option(&arguments,"--user-data-dir").map(|s|crate::platform::path_key(&s)) != requested.as_ref().map(|s|crate::platform::path_key(s)) {continue;}
        result.push(Instance {pid,identity:entry.identity,args:arguments.into_iter().skip(1).collect()});
    } Ok(result)
}
async fn ready(app:&tauri::AppHandle,id:&str,allow_start:bool)->Result<BundleRoute,String> {
    let _lock=process::LIFECYCLE.lock().await;
    let bundle=route(id)?;
    let config=routing_overrides::read()?;
    if bundle.enabled && !config.effective().process_enabled {return Err("业务包分流尚未启用，请先应用业务包规则".into());}
    if allow_start {process::start_core_locked(None,&app.state()).await?;}
    else if !process::ACTIVE.load(std::sync::atomic::Ordering::SeqCst) {return Err("核心已停止，未尝试热替换；请启动核心后重新检测".into());}
    let raw=std::fs::read_to_string(crate::storage::data_dir().join("core_data/config.yaml")).map_err(|_|"读取运行配置失败")?;
    crate::capture::confirm_runtime(&raw).await?;
    if bundle.port==0 {return Err("业务包入口未分配".into());}
    let view=routing_overrides::view()?;
    if view.applied_revision!=Some(config.revision) {return Err("业务包配置尚未应用，未启动应用".into());}
    Ok(bundle)
}

#[tauri::command]
pub async fn launch_bundle_app(app:tauri::AppHandle, request:LaunchRequest, confirmation:Option<String>, prepare_only:Option<bool>)->Result<LaunchOutcome,String> {
    let _launch=LAUNCH.lock().await;
    let prepare_only=prepare_only.unwrap_or(false);
    if cfg!(target_os = "macos") && prepare_only { return Err("macOS 首版暂不提供自动热替换，请手动检测并启动应用".into()); }
    if prepare_only && (confirmation.is_some() || request.shortcut_id.is_some()) {return Err("自动检测只允许准备主程序的重启确认".into());}
    let bundle=ready(&app,&request.instance_id,!prepare_only && confirmation.is_none()).await?;
    if prepare_only && !bundle.enabled {return Err("业务包已停用，未尝试热替换".into());}
    let entry=format!("127.0.0.1:{}",bundle.port);
    let mut plan=if let Some(token)=confirmation {
        let plan=CONFIRMATIONS.lock().unwrap_or_else(|p|p.into_inner()).remove(&token).ok_or("重启确认已失效，请重新检测")?;
        if !plan.matches(&request,&bundle) {return Err("配置或确认已改变，请重新检测".into());}
        let exe=plan.exe.clone(); let args=plan.args.clone();
        let current=tokio::task::spawn_blocking(move||instances(&exe,Some(&args))).await.map_err(|_|"检测任务失败")??;
        let mut before:Vec<_>=plan.instances.iter().map(|p|p.identity.clone()).collect(); before.sort();
        let mut now:Vec<_>=current.iter().map(|p|p.identity.clone()).collect(); now.sort();
        if before!=now {return Err("应用实例已改变，请重新检测后确认；未关闭任何新实例".into());}
        let plan=tokio::task::spawn_blocking(move|| {
            plan.close_after_preflight(|instance|native::request_close(instance.pid,&instance.identity))?;
            Ok::<_,String>(plan)
        }).await.map_err(|_|"重启预检任务失败，未确认应用关闭状态")??;
        let expires=Instant::now()+Duration::from_secs(15);
        loop {
            if plan.instances.iter().all(|p|routing_overrides::native::inspect(p.pid,0,String::new()).identity!=p.identity) {break;}
            if Instant::now()>=expires {return Err("应用仍有后台进程或退出确认窗口；请手动正常退出后重试，未强制结束".into());}
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        plan
    } else {
        let selected=super::bundle_shortcuts::launch_source(&request)?;
        let exe=selected.as_ref().map(|l|PathBuf::from(&l.target)).map(Ok).unwrap_or_else(||resolve_executable(&bundle))?;
        let args=if let Some(link)=&selected {native::split_arguments(&format!("app.exe {}",link.arguments))?.into_iter().skip(1).collect()}else{vec![]};
        let directory=selected.as_ref().map(|l|l.directory.clone()).unwrap_or_default();
        #[cfg(target_os = "macos")]
        if !crate::platform::macos::apps::supports_proxy_arguments(&exe) {
            // 原生 GUI 应用不能凭 Chromium 参数假装接入。系统代理由用户单独开启。
            if crate::platform::macos::apps::requires_system_proxy(&exe) && !super::sysproxy::get_system_proxy_status()? {
                return Err("此应用不支持自动注入浏览器代理参数。请先开启系统代理，再检测并启动；业务分流以核心连接记录为准".into());
            }
            let probe=exe.clone();
            let running=tokio::task::spawn_blocking(move||instances(&probe,None)).await.map_err(|_|"检测任务失败")??;
            if !running.is_empty() {
                if running.len()>1 { return Err("发现多个原生应用主实例，请先正常退出多余实例后重新检测".into()); }
                let count=running.len();
                let args=running[0].args.clone();
                let plan=Confirmation{request:request.clone(),exe,directory,args,instances:running,expires:Instant::now()+Duration::from_secs(120),port:bundle.port,main_exe:bundle.main_exe.clone(),enabled:bundle.enabled};
                let token=id(); let mut confirmations=CONFIRMATIONS.lock().unwrap_or_else(|p|p.into_inner());
                confirmations.retain(|_,p|p.expires>Instant::now()); confirmations.insert(token.clone(),plan);
                return Ok(LaunchOutcome{state:"restart_required".into(),message:"应用已在运行，无法确认其启动时的代理环境。请保存工作后正常关闭并重启；重启后仍需通过连接记录核验实际出口".into(),confirmation:Some(token),entry,process_count:count});
            }
            if prepare_only {return Ok(LaunchOutcome{state:"not_running".into(),message:"应用已退出".into(),confirmation:None,entry,process_count:0});}
            spawn_application(&exe,&directory,args,bundle.port)?;
            return Ok(LaunchOutcome{state:"launched".into(),message:"已启动应用并传入代理环境；原生 GUI 通过系统代理接入，应用是否遵循代理及实际出口仍需核验".into(),confirmation:None,entry,process_count:1});
        }
        let probe_exe=exe.clone(); let probe_args=args.clone(); let explicit_profile=selected.is_some();
        let running=tokio::task::spawn_blocking(move||instances(&probe_exe,if explicit_profile{Some(&probe_args)}else{None})).await.map_err(|_|"检测应用任务失败")??;
        // Background detection must never reopen an app which exited after polling.
        if prepare_only && running.is_empty() {
            return Ok(LaunchOutcome{state:"not_running".into(),message:"应用已退出，未自动启动；需要时请手动启动应用".into(),confirmation:None,entry,process_count:0});
        }
        #[cfg(windows)]
        if !running.is_empty() && super::settings::get_general_settings()?.traffic_mode==crate::capture::windivert::plan::MODE {
            if !crate::capture::windivert::session::stats().active {return Err("WinDivert 尚未接管；请先启动核心并完成管理员授权，未重启应用".into());}
            return Ok(LaunchOutcome{state:"reused".into(),message:"保留已有应用实例；WinDivert 按明确规则接管新连接，无需补代理启动参数。实际出口以连接记录为准".into(),confirmation:None,entry,process_count:running.len()});
        }
        if !running.is_empty() && running.iter().all(|p|proxy_matches(&p.args,bundle.port)) {
            if selected.is_some() {spawn_application(&exe,&directory,args,bundle.port)?;}
            return Ok(LaunchOutcome{state:"reused".into(),message:"已有实例的启动参数已接入此业务包入口，继续沿用现有资料；实际连接出口仍以连接记录为准".into(),confirmation:None,entry,process_count:running.len()});
        }
        let args=if running.len()==1 {with_shortcut_args(&running[0].args,&args)}else{args};
        if running.len()>1 {return Err("发现多个主实例，无法安全选择资料；请通过对应资料的桌面快捷方式接入，或先正常退出这些实例".into());}
        let plan=Confirmation{request:request.clone(),exe,directory,args,instances:running,expires:Instant::now()+Duration::from_secs(120),port:bundle.port,main_exe:bundle.main_exe.clone(),enabled:bundle.enabled};
        let plan=tokio::task::spawn_blocking(move|| {plan.preflight()?;Ok::<_,String>(plan)}).await.map_err(|_|"启动入口预检失败")??;
        if !plan.instances.is_empty() {
            let count=plan.instances.len(); let token=id(); let mut confirmations=CONFIRMATIONS.lock().unwrap_or_else(|p|p.into_inner());
            confirmations.retain(|_,p|p.expires>Instant::now()); confirmations.insert(token.clone(),plan);
            return Ok(LaunchOutcome{state:"restart_required".into(),message:"现有实例没有使用此业务包入口。需要正常关闭并重启，沿用原资料目录；同一浏览器资料目录中的多个 Profile 共用主进程，其窗口也会收到关闭请求。请先保存工作。若从快捷方式启动，将保留该快捷方式指定的 Profile。退出确认或后台模式可能需要您手动处理。".into(),confirmation:Some(token),entry,process_count:count});
        } plan
    };
    // Config may have changed while the user was closing the app. Resolve the entry again.
    let current=ready(&app,&request.instance_id,false).await?;
    if current.port!=plan.port || current.main_exe!=plan.main_exe || current.enabled!=plan.enabled {return Err("业务包配置已改变，请重新启动".into());}
    let exe=plan.exe.clone(); let args=plan.args.clone();
    if !tokio::task::spawn_blocking(move||instances(&exe,Some(&args))).await.map_err(|_|"启动前核验失败")??.is_empty() {return Err("应用又启动了新实例，请重新检测，未重复启动".into());}
    let message=tokio::task::spawn_blocking(move||spawn_application(&plan.exe,&plan.directory,std::mem::take(&mut plan.args),plan.port)).await.map_err(|_|"应用启动任务失败")??;
    Ok(LaunchOutcome{state:"launched".into(),message:message.into(),confirmation:None,entry,process_count:1})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(windows)]
    #[test] fn package_preflight_failure_never_closes_existing_instances() {
        let mut plan=Confirmation{request:LaunchRequest{instance_id:"package-fixture".into(),shortcut_id:None},
            exe:PathBuf::from("C:\\WindowsApps\\ProcWeaverMissingPackage\\app.exe"),directory:String::new(),args:vec![],
            instances:vec![Instance{pid:42,identity:"42:100".into(),args:vec![]}],expires:Instant::now()+Duration::from_secs(120),port:34000,main_exe:"app.exe".into(),enabled:true};
        let closed=std::cell::Cell::new(false);
        assert!(plan.close_after_preflight(|_|{closed.set(true);Ok(())}).unwrap_err().contains("程序包入口"));
        assert!(!closed.get());
        assert!(spawn_application(&plan.exe,"",vec![],plan.port).unwrap_err().contains("程序包入口"));
        plan.exe=std::env::current_exe().unwrap();
        plan.close_after_preflight(|_|{closed.set(true);Ok(())}).unwrap();
        assert!(closed.get(),"普通程序仍应进入既有的已确认关闭流程");
    }
    #[test] fn discovery_does_not_claim_proxy_entry_or_hide_unknown_paths() {
        use routing_overrides::tracker::{Observation,MonitorState};
        let process = routing_overrides::tracker::ProcessEntry { identity:"42:100".into(),pid:42,parent_pid:7,
            name:"browser.exe".into(),created_at:100,executable_path:Some(std::env::temp_dir().join("portable/browser.exe").to_string_lossy().into_owned()),
            parent_identity:None,ancestors:vec![] };
        let mut observation=Observation {state:MonitorState::Initializing,entries:vec![],unverified_names:vec![]};
        assert_eq!(monitor_report("browser.exe",None,&observation).1,"unverified");
        observation.state=MonitorState::Current;
        assert_eq!(monitor_report("browser.exe",None,&observation).1,"not_seen");
        observation.entries.push(process.clone());
        assert_eq!(monitor_report("browser.exe",None,&observation).1,"instance_verified");
        let path=PathBuf::from(process.executable_path.as_ref().unwrap());
        let seen=monitor_report("browser.exe",Some(&path),&observation);
        assert_eq!(seen.1,"path_verified"); assert!(seen.2.contains("不代表已接入代理"));
        observation.unverified_names.push("other.exe".into());
        assert_eq!(monitor_report("browser.exe",Some(&path),&observation).1,"path_verified");
        observation.unverified_names.push("BROWSER.exe".into());
        assert_eq!(monitor_report("browser.exe",Some(&path),&observation).1,"unverified");
        observation.unverified_names.clear();
        observation.state=MonitorState::Degraded;
        assert!(monitor_report("browser.exe",Some(&path),&observation).0.contains("短命进程可能漏检"));
        let other=routing_overrides::tracker::ProcessEntry { identity:"43:101".into(),executable_path:Some(std::env::temp_dir().join("other/browser.exe").to_string_lossy().into_owned()),..process.clone() };
        observation.entries.push(other);
        assert_eq!(monitor_report("browser.exe",None,&observation).1,"ambiguous");
        assert!(monitor_report("browser.exe",Some(&path),&observation).2.contains("1 个其他路径"));
        let third=std::env::temp_dir().join("third/browser.exe");
        assert_eq!(monitor_report("browser.exe",Some(&third),&observation).1,"other_path");
        observation.entries[1].executable_path=None;
        assert_eq!(monitor_report("browser.exe",Some(&path),&observation).1,"instance_verified");
        observation.state=MonitorState::Stale;
        let stale=monitor_report("browser.exe",Some(&path),&observation);
        assert_eq!(stale.1,"unverified"); assert!(stale.0.contains("数据已过期")); assert!(!stale.2.contains("已确认"));
    }
    #[test] fn connection_probe_distinguishes_empty_invalid_and_observed() {
        let mut states=vec![EntryStatus{instance_id:"browser".into(),state:"connected".into(),message:String::new(),instance_key:String::new(),monitor_message:String::new(),monitor_state:None,identity_state:String::new(),identity_message:String::new(),chains:vec![],connection_state:String::new(),connection_message:String::new()}];
        assert!(observe_connections(&mut states,&serde_json::json!({"error":"unauthorized"})).is_err());
        observe_connections(&mut states,&serde_json::json!({"connections":[]})).unwrap();
        assert_eq!(states[0].connection_state,"idle");
        observe_connections(&mut states,&serde_json::json!({"connections":[
            {"metadata":{"inboundName":routing_overrides::bundles::listener("browser"),"host":"unmatched.example"},"chains":["original-node"],"rule":"RuleSet"},
            {"metadata":{"host":"matched.example"},"chains":["chosen-node",routing_overrides::bundles::group("browser","main")],"rule":"AND"},
            {"metadata":{"host":"other.example"},"chains":["unrelated-node"],"rule":"Match"}
        ]})).unwrap();
        assert_eq!(states[0].connection_state,"observed");assert_eq!(states[0].chains.len(),2);
        assert!(states[0].chains[0].contains("unmatched.example · RuleSet → original-node"));
        assert!(states[0].chains[1].contains("matched.example · AND → chosen-node"));
    }
    #[test] fn restart_prompt_identity_tracks_creation_and_entry_not_enumeration_order() {
        let one=Instance{pid:1,identity:"1:100".into(),args:vec![]};
        let two=Instance{pid:2,identity:"2:200".into(),args:vec![]};
        let key=instance_key(&[one.clone(),two.clone()],34000);
        assert_eq!(key,instance_key(&[two,one.clone()],34000));
        assert_ne!(instance_key(&[one.clone()],34000),instance_key(&[one.clone()],34001));
        let reused_pid=Instance{identity:"1:300".into(),..one.clone()};
        assert_ne!(instance_key(&[one],34000),instance_key(&[reused_pid],34000));
        assert!(instance_key(&[],34000).is_empty());
    }
    #[test] fn restart_confirmation_rejects_changed_app_disabled_bundle_and_expiry() {
        let request=LaunchRequest{instance_id:"browser".into(),shortcut_id:None};
        let mut bundle:BundleRoute=serde_json::from_value(serde_json::json!({"id":"browser","name":"浏览器","mainExe":"chrome.exe","enabled":true,"mainTarget":null,"dnsTarget":null,"port":34000})).unwrap();
        let mut plan=Confirmation{request:request.clone(),exe:PathBuf::from("chrome.exe"),directory:String::new(),args:vec![],instances:vec![],expires:Instant::now()+Duration::from_secs(120),port:34000,main_exe:"chrome.exe".into(),enabled:true};
        assert!(plan.matches(&request,&bundle));
        bundle.enabled=false; assert!(!plan.matches(&request,&bundle)); bundle.enabled=true;
        bundle.main_exe="other.exe".into(); assert!(!plan.matches(&request,&bundle)); bundle.main_exe="chrome.exe".into();
        bundle.port=34001; assert!(!plan.matches(&request,&bundle)); bundle.port=34000;
        let other=LaunchRequest{instance_id:"another".into(),shortcut_id:None}; assert!(!plan.matches(&other,&bundle));
        plan.expires=Instant::now()-Duration::from_secs(1); assert!(!plan.matches(&request,&bundle));
    }
    #[test] fn profiles_with_mixed_entries_are_not_all_connected() {
        let one=Instance{pid:1,identity:"one".into(),args:vec!["--proxy-server=127.0.0.1:34000".into()]};
        let two=Instance{pid:2,identity:"two".into(),args:vec!["--user-data-dir=D:\\fixture".into()]};
        assert_eq!(application_status(&[one.clone()],34000).0,"connected");
        assert_eq!(application_status(&[one,two],34000).0,"partial");
    }
    #[test] fn proxy_flags_are_exact_and_preserve_profiles(){
        let args=vec!["--user-data-dir=C:\\资料 目录".into(),"--profile-directory=Profile 2".into(),"--proxy-server".into(),"http://127.0.0.1:7890".into(),"--no-proxy-server".into()];
        let result=proxy_args(args,34000); assert!(proxy_matches(&result,34000)); assert!(!proxy_matches(&result,7890));
        assert_eq!(option(&result,"--user-data-dir").as_deref(),Some("C:\\资料 目录")); assert_eq!(option(&result,"--profile-directory").as_deref(),Some("Profile 2"));
    }
    #[test] fn argv_requests_reject_paths(){
        assert!(parse_request(&["exe".into(),"--launch-bundle".into(),"../bad".into()]).is_none());
        assert_eq!(parse_request(&["exe".into(),"--launch-bundle".into(),"inst-test".into(),"--shortcut".into(),"abc-123".into()]).unwrap().instance_id,"inst-test");
    }
    #[test] fn explicit_shortcut_profile_wins_in_shared_browser_process(){
        let running=vec!["--profile-directory=Default".into(),"--user-data-dir=D:\\用户资料".into()];
        let shortcut=vec!["--profile-directory".into(),"Profile 2".into(),"https://example.invalid/".into()];
        let args=with_shortcut_args(&running,&shortcut);
        assert_eq!(option(&args,"--profile-directory").as_deref(),Some("Profile 2"));
        assert_eq!(option(&args,"--user-data-dir").as_deref(),Some("D:\\用户资料"));
        assert!(args.contains(&"https://example.invalid/".into()));
    }
    #[cfg(windows)]
    #[test] fn native_chrome_existing_profile_and_entry_detection(){
        use std::os::windows::process::CommandExt;
        let exe=super::super::app_launcher::find_app_executable("chrome").expect("此 Windows 回归需要已安装 Chrome");
        let dir=std::env::temp_dir().join(format!("procweaver-browser-fixture-{}",id()));std::fs::create_dir(&dir).unwrap();
        let args=vec![format!("--user-data-dir={}",dir.display()),"--profile-directory=Default".into(),"--headless=new".into(),"--no-first-run".into(),"--disable-background-networking".into(),"--disable-component-update".into(),"--remote-debugging-port=0".into(),"--proxy-server=http://127.0.0.1:34000".into(),"about:blank".into()];
        let child=std::process::Command::new(&exe).args(&args).creation_flags(0x08000000).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn().unwrap();
        struct Owned(std::process::Child);impl Drop for Owned{fn drop(&mut self){let _=self.0.kill();let _=self.0.wait();}}
        let owned=Owned(child);let limit=Instant::now()+Duration::from_secs(10);let running=loop{
            let found=instances(&exe,Some(&args)).unwrap();if !found.is_empty(){break found;}assert!(Instant::now()<limit,"未发现隔离 Chrome 实例");std::thread::sleep(Duration::from_millis(100));
        };
        assert_eq!(running.len(),1);assert!(proxy_matches(&running[0].args,34000));assert!(!proxy_matches(&running[0].args,34001));
        assert!(instances(&exe,None).unwrap().iter().any(|p|p.identity==running[0].identity),"默认检测必须发现自定义资料目录的隔离实例");
        assert_eq!(option(&running[0].args,"--user-data-dir"),option(&args,"--user-data-dir"));
        assert!(native::request_close(running[0].pid,"wrong-creation-identity").is_err());
        assert_eq!(routing_overrides::native::inspect(running[0].pid,0,String::new()).identity,running[0].identity);
        drop(owned);
        for _ in 0..30 {if std::fs::remove_dir_all(&dir).is_ok(){break;}std::thread::sleep(Duration::from_millis(100));}
        println!("隔离 Chrome：现有资料参数识别、正确/错误代理入口区分、创建身份校验通过；未操作用户浏览器会话");
    }
}

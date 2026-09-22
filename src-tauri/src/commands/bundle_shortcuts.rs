use super::{bundle_launch::{self,LaunchRequest}, windows_integration::{self as native, Link}};
use serde::{Deserialize,Serialize};
use std::{path::{Path,PathBuf},sync::Mutex};
static EDIT: Mutex<()> = Mutex::new(());
#[derive(Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
struct Record { id:String, bundle_id:String, path:String, backup:Option<String>, original:Link, managed:Link, dedicated:bool }
#[derive(Clone,Serialize)]
#[serde(rename_all="camelCase")]
pub struct Candidate { pub path:String, pub label:String }
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct Status { pub desktop:String, pub candidates:Vec<Candidate>, pub managed:Vec<Managed>, pub executable_found:bool }
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct Managed { pub id:String, pub path:String, pub dedicated:bool, pub verified:bool, pub backup:Option<String> }
fn registry_path()->PathBuf {crate::storage::data_dir().join("config/bundle-shortcuts.json")}
fn read()->Result<Vec<Record>,String> {
    match std::fs::read(registry_path()) {
        Ok(bytes)=>serde_json::from_slice(&bytes).map_err(|_|"快捷方式记录损坏，未覆盖".into()),
        Err(e) if e.kind()==std::io::ErrorKind::NotFound=>Ok(vec![]),
        Err(_)=>Err("读取快捷方式记录失败".into()),
    }
}
fn save(records:&[Record])->Result<(),String> {crate::storage::replace_atomic(&registry_path(),&serde_json::to_vec_pretty(records).map_err(|_|"序列化快捷方式记录失败")?)}
fn same_path(a:&str,b:&str)->bool {a.replace('/',"\\").eq_ignore_ascii_case(&b.replace('/',"\\"))}
fn candidates(exe:&Path,records:&[Record])->Result<Vec<Candidate>,String> {
    let mut result=vec![];
    for desktop in [native::desktop(false)?,native::desktop(true)?] {
        if !desktop.exists(){continue;}
        for item in std::fs::read_dir(&desktop).map_err(|_|"无法读取桌面快捷方式")?.flatten() {
            let path=item.path();
            if path.extension().is_none_or(|s|!s.eq_ignore_ascii_case("lnk")) || records.iter().any(|r|same_path(&r.path,&path.to_string_lossy())) {continue;}
            if let Ok(link)=native::read_link(&path) {
                if same_path(&link.target,&exe.to_string_lossy()) {result.push(Candidate{path:path.to_string_lossy().into(),label:path.file_name().unwrap_or_default().to_string_lossy().into()});}
            }
        }
    }
    result.sort_by(|a,b|a.path.cmp(&b.path)); Ok(result)
}
#[tauri::command]
pub async fn get_bundle_shortcuts(instance_id:String)->Result<Status,String> {
    tokio::task::spawn_blocking(move||{
        let _guard=EDIT.lock().map_err(|_|"快捷方式操作繁忙")?;
        let bundle=bundle_launch::route(&instance_id)?; let records=read()?;
        let exe=bundle_launch::resolve_executable(&bundle).ok();
        let candidates=if let Some(exe)=&exe {candidates(exe,&records)?}else{vec![]};
        let current=std::env::current_exe().map_err(|_|"无法读取程序路径")?;
        let managed=records.iter().filter(|r|r.bundle_id==instance_id).map(|r|Managed{id:r.id.clone(),path:r.path.clone(),dedicated:r.dedicated,backup:r.backup.clone(),verified:native::read_link(Path::new(&r.path)).is_ok_and(|link|link==r.managed && same_path(&link.target,&current.to_string_lossy()))}).collect();
        Ok(Status{desktop:native::desktop(false)?.to_string_lossy().into(),candidates,managed,executable_found:exe.is_some()})
    }).await.map_err(|_|"快捷方式检测任务失败")?
}
fn managed_link(original:&Link,executable:&Path,bundle_id:&str,id:&str)->Link {
    Link{target:executable.to_string_lossy().into(),arguments:format!("--launch-bundle {bundle_id} --shortcut {id}"),
        directory:executable.parent().unwrap_or(executable).to_string_lossy().into(),
        icon:if original.icon.is_empty(){original.target.clone()}else{original.icon.clone()}, icon_index:original.icon_index,
        description:"由 ProcWeaver 按业务包启动，保留应用原有用户资料".into()}
}
fn write_verified(path:&Path,link:&Link,preserve:bool)->Result<(),String> {
    native::write_link(path,link,preserve)?;
    if native::read_link(path)?!=*link {return Err("快捷方式写入后核对不一致".into());} Ok(())
}
fn backup(path:&Path,id:&str)->Result<PathBuf,String> {
    use std::io::Write;
    let destination=path.with_extension(format!("lnk.procweaver-{id}.bak"));
    let bytes=std::fs::read(path).map_err(|_|"读取完整快捷方式失败")?;
    let mut file=std::fs::OpenOptions::new().write(true).create_new(true).open(&destination).map_err(|_|"无法在原位置建立完整备份，未修改快捷方式")?;
    file.write_all(&bytes).and_then(|_|file.sync_all()).map_err(|_|"写入快捷方式备份失败，未修改原文件")?;
    if std::fs::read(&destination).map_err(|_|"读取备份失败")?!=bytes {return Err("快捷方式备份核对失败，未修改原文件".into());} Ok(destination)
}
fn restore_file(path:&Path,backup:&Path)->Result<(),String> {
    let bytes=std::fs::read(backup).map_err(|_|"完整备份不可读，未改动快捷方式")?;
    crate::storage::replace_atomic(path,&bytes)?;
    if std::fs::read(path).map_err(|_|"还原核验失败")?!=bytes {return Err("快捷方式还原核验失败".into());} Ok(())
}
#[tauri::command]
pub async fn change_bundle_shortcut(instance_id:String,action:String,candidate:Option<String>,record_id:Option<String>)->Result<String,String> {
    tokio::task::spawn_blocking(move||{
        let _guard=EDIT.lock().map_err(|_|"快捷方式操作繁忙")?;
        let mut records=read()?;
        if action=="restore" {
            let index=records.iter().position(|r|r.bundle_id==instance_id && Some(&r.id)==record_id.as_ref()).ok_or("没有找到此业务包的快捷方式备份")?;
            let record=&records[index];
            let path=Path::new(&record.path); let backup=record.backup.as_ref().ok_or("专属快捷方式没有需要还原的原文件")?;
            let current=native::read_link(path)?;
            if current!=record.managed && current!=record.original {return Err("快捷方式已被其他程序或用户修改，未覆盖；可在原位置取回完整备份".into());}
            restore_file(path,Path::new(backup))?;
            let message=format!("已完整还原：{}；备份保留在原位置",record.path);
            records.remove(index); save(&records)?; return Ok(message);
        }
        if action!="patch" && action!="create" {return Err("快捷方式操作无效".into());}
        let bundle=bundle_launch::route(&instance_id)?; let exe=bundle_launch::resolve_executable(&bundle)?;
        let current=std::env::current_exe().map_err(|_|"无法读取 ProcWeaver 程序路径")?;
        if let Some(index)=records.iter().position(|r|r.bundle_id==instance_id && r.dedicated==(action=="create") && (candidate.is_none() || candidate.as_ref()==Some(&r.path))) {
            let record=&mut records[index]; let path=PathBuf::from(&record.path);
            let existing=if path.exists(){Some(native::read_link(&path)?)}else{None};
            if existing.as_ref().is_some_and(|link|*link!=record.managed && *link!=record.original) || (existing.is_none() && !record.dedicated) {return Err("此快捷方式已被修改或移走，请先检查或还原，未覆盖".into());}
            let updated=managed_link(&record.original,&current,&instance_id,&record.id);
            if existing.as_ref()==Some(&updated) {return Ok(format!("快捷方式已核验并接入本包：{}",record.path));}
            let previous=if path.exists(){Some(std::fs::read(&path).map_err(|_|"读取快捷方式恢复副本失败")?)}else{None};
            let old_records=records.clone();records[index].managed=updated.clone();save(&records)?;
            if let Err(error)=write_verified(&path,&updated,existing.is_some()) {
                if let Some(bytes)=previous {crate::storage::replace_atomic(&path,&bytes)?;}
                save(&old_records)?;return Err(error);
            }
            return Ok(format!("快捷方式已核验并接入本包：{}",path.display()));
        }
        let available=candidates(&exe,&records)?;
        let selected=if let Some(path)=candidate {
            Some(available.iter().find(|p|p.path==path).ok_or("快捷方式目标或归属已改变，请重新检测")?.path.clone())
        }else if action=="patch" {
            if available.len()!=1 {return Err(if available.is_empty(){"实际桌面未找到指向此应用的快捷方式，请创建业务包快捷方式"}else{"存在多个资料快捷方式，请先选择要接入的一项"}.into());}
            Some(available[0].path.clone())
        }else {None};
        let original=if let Some(path)=&selected {native::read_link(Path::new(path))?}else{Link{target:exe.to_string_lossy().into(),directory:exe.parent().unwrap_or(&exe).to_string_lossy().into(),icon:exe.to_string_lossy().into(),..Link::default()}};
        if !same_path(&original.target,&exe.to_string_lossy()){return Err("快捷方式主程序不匹配".into());}
        let id=bundle_launch::id();
        let destination=if action=="patch" {PathBuf::from(selected.ok_or("未选择原快捷方式")?)}else{
            let safe:String=bundle.name.chars().map(|c|if "<>:\"/\\|?*".contains(c)||c.is_control(){'_'}else{c}).take(60).collect();
            native::desktop(false)?.join(format!("{safe} (ProcWeaver-{}).lnk",&id[id.len().saturating_sub(8)..]))
        };
        if action=="create" && destination.exists(){return Err("目标文件已存在，未覆盖".into());}
        let backup=if action=="patch"{Some(backup(&destination,&id)?.to_string_lossy().into_owned())}else{None};
        let managed=managed_link(&original,&current,&instance_id,&id);
        let record=Record{id,bundle_id:instance_id,path:destination.to_string_lossy().into(),backup,original,managed:managed.clone(),dedicated:action=="create"};
        records.push(record.clone()); save(&records)?; // Recoverable even if the app exits during ShellLink save.
        if let Err(error)=write_verified(&destination,&managed,action=="patch") {
            if let Some(backup)=&record.backup {restore_file(&destination,Path::new(backup)).map_err(|restore|format!("{error}；还原失败：{restore}"))?;}
            return Err(error);
        }
        Ok(format!("已写入并核验：{}。双击将读取本包当前出口；沿用应用原有资料。",destination.display()))
    }).await.map_err(|_|"快捷方式操作任务失败")?
}
pub fn launch_source(request:&LaunchRequest)->Result<Option<Link>,String> {
    let Some(id)=&request.shortcut_id else{return Ok(None)};
    let records=read()?; let record=records.into_iter().find(|r|r.id==*id && r.bundle_id==request.instance_id).ok_or("快捷方式关联已移除，请重新创建")?;
    let bundle=bundle_launch::route(&request.instance_id)?;
    let actual=Path::new(&record.original.target).file_name().unwrap_or_default().to_string_lossy();
    let expected=Path::new(&bundle.main_exe).file_name().unwrap_or_default().to_string_lossy();
    if !actual.eq_ignore_ascii_case(&expected){return Err("业务包主程序已改变，请重新创建快捷方式".into());}
    if !Path::new(&record.original.target).is_file(){return Err("应用原路径已失效，请重新选择主程序并创建快捷方式".into());}
    Ok(Some(record.original))
}

#[cfg(all(test,windows))]
mod tests {
    use super::*;
    #[test] fn native_link_full_backup_restore_and_profile_arguments(){
        let dir=std::env::temp_dir().join(format!("procweaver-link-test-{}",bundle_launch::id())); std::fs::create_dir(&dir).unwrap();
        let path=dir.join("资料 图标.lnk"); let exe=std::env::current_exe().unwrap();
        let original=Link{target:exe.to_string_lossy().into(),arguments:"--profile-directory=\"Profile 2\" --user-data-dir=\"D:\\浏览器 资料\" https://example.invalid/".into(),directory:dir.to_string_lossy().into(),icon:exe.to_string_lossy().into(),icon_index:0,description:"原说明".into()};
        write_verified(&path,&original,false).unwrap(); let before=std::fs::read(&path).unwrap();
        let backup=backup(&path,"test").unwrap(); let managed=managed_link(&original,&exe,"bundle-test","shortcut-test");
        write_verified(&path,&managed,true).unwrap(); assert_eq!(native::read_link(&path).unwrap(),managed);
        restore_file(&path,&backup).unwrap(); assert_eq!(std::fs::read(&path).unwrap(),before);
        restore_file(&path,&backup).unwrap(); assert_eq!(native::read_link(&path).unwrap(),original);
        let args=native::split_arguments(&format!("exe {}",original.arguments)).unwrap(); assert!(args.contains(&"--profile-directory=Profile 2".into()));
        assert_eq!(native::desktop(false).unwrap().is_absolute(),true);
        std::fs::remove_dir_all(dir).unwrap(); // Only the uniquely created, owned temporary fixture.
    }
}

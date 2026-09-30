use std::sync::OnceLock;
use tauri::wry::prelude::{jni::{JavaVM, objects::{GlobalRef, JValue}}, JNIEnv, JObject, JString};

static HOST: OnceLock<(JavaVM, GlobalRef)> = OnceLock::new();
pub fn register(env: &mut JNIEnv, host: &JObject) -> Result<(), String> {
    if HOST.get().is_none() {
        let vm = env.get_java_vm().map_err(|_| "Android 运行时不可用")?;
        let object = env.new_global_ref(host).map_err(|_| "Android 后台桥初始化失败")?;
        let _ = HOST.set((vm, object));
    }
    Ok(())
}
pub fn call<T: serde::de::DeserializeOwned>(command: &str, args: impl serde::Serialize) -> Result<T, String> {
    let (vm, host) = HOST.get().ok_or("Android 后台服务尚未初始化")?;
    let mut env = vm.attach_current_thread().map_err(|_| "Android 后台线程不可用")?;
    let command = env.new_string(command).map_err(|_| "后台操作无效")?;
    let args = env.new_string(serde_json::to_string(&args).map_err(|_| "后台参数无效")?).map_err(|_| "后台参数无效")?;
    let result = env.call_method(host.as_obj(), "command", "(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;",
        &[JValue::Object(command.as_ref()), JValue::Object(args.as_ref())]);
    if result.is_err() { let _ = env.exception_clear(); return Err("Android 后台操作失败".into()); }
    let result = JString::from(result.unwrap().l().map_err(|_| "后台结果无效")?);
    let json: String = env.get_string(&result).map_err(|_| "后台结果无效")?.into();
    serde_json::from_str(&json).map_err(|_| "后台结果格式无效".into())
}

#[no_mangle]
pub extern "system" fn Java_com_procweaver_mobile_NativeRuntime_tick(mut env: JNIEnv, host: JObject, files: JString) {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| -> Result<(), String> {
        register(&mut env, &host)?;
        let directory: String = env.get_string(&files).map_err(|_| "应用目录无效")?.into();
        crate::storage::initialize_android(directory.into())?;
        tauri::async_runtime::block_on(async { tokio::time::timeout(std::time::Duration::from_secs(540), async {
            let profiles = crate::commands::profile::run_due_updates().await;
            let geo = crate::commands::geo::run_due_update().await;
            profiles.and(geo)
        }).await.map_err(|_| "后台更新超时，下次重试".to_string())? })
    })).unwrap_or_else(|_| Err("后台更新任务异常".into()));
    if let Err(error) = result { let _ = env.throw_new("java/lang/IllegalStateException", error); }
}

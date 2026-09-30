//! System/always-on entry point: no Activity, WebView or Tauri plugin is required.
use tauri::wry::prelude::{jni::{objects::JValue, sys::jint}, JNIEnv, JObject, JString};
use crate::commands::process;

#[no_mangle]
pub extern "system" fn Java_com_procweaver_mobile_NativeRuntime_start(
    mut env: JNIEnv, _this: JObject, files: JString, core: JObject, service: JObject, fd: jint,
) {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| -> Result<(), String> {
        super::background::register(&mut env, &_this)?;
        // Do not wait on a UI start that is itself awaiting this service's worker.
        let _lock = process::LIFECYCLE.try_lock().map_err(|_| "配置正在更新，请稍后重新连接")?;
        let directory: String = env.get_string(&files).map_err(|_| "应用目录无效")?.into();
        crate::storage::initialize_android(directory.into())?;
        let prepared = process::prepare_current_runtime()?;
        let home = crate::storage::data_dir().join("core_data");
        crate::storage::replace_atomic(&home.join("config.yaml"), prepared.as_bytes())?;
        let home = env.new_string(home.to_string_lossy()).map_err(|_| "创建核心路径失败")?;
        let config = env.new_string(&prepared).map_err(|_| "创建运行配置失败")?;
        // Keep the shared lifecycle lock through native startup, so a concurrent save
        // cannot be acknowledged as offline while an older snapshot starts forwarding.
        let value = env.call_method(&core, "start",
            "(Ljava/lang/String;Ljava/lang/String;ILcom/procweaver/mobile/ProcWeaverVpnService;)Ljava/lang/String;",
            &[JValue::Object(home.as_ref()), JValue::Object(config.as_ref()), JValue::Int(fd), JValue::Object(&service)])
            .and_then(|value| value.l()).map_err(|_| "核心启动调用失败")?;
        let error = JString::from(value);
        let error: String = env.get_string(&error).map_err(|_| "核心返回无效")?.into();
        if !error.is_empty() { return Err("核心启动失败，请检查订阅和规则".into()); }
        process::ACTIVE.store(true, std::sync::atomic::Ordering::SeqCst);
        process::PID.store(std::process::id(), std::sync::atomic::Ordering::SeqCst);
        if let Ok(config) = crate::routing_overrides::read() {
            crate::routing_overrides::set_applied(config.revision, crate::routing_overrides::tracker::status(&config).generation);
        }
        Ok(())
    })).unwrap_or_else(|_| Err("系统启动配置准备失败".into()));
    if let Err(error) = result {
        if !env.exception_check().unwrap_or(true) { let _ = env.throw_new("java/lang/IllegalStateException", error); }
    }
}

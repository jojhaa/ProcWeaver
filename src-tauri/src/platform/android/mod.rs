use serde::{de::DeserializeOwned, Serialize};
use std::sync::OnceLock;
use tauri::{plugin::{Builder, PluginHandle, TauriPlugin}, Wry};

static PLUGIN: OnceLock<PluginHandle<Wry>> = OnceLock::new();

mod system_start;
mod background;

pub fn init() -> TauriPlugin<Wry> {
    Builder::new("procweaver-vpn").setup(|_, api| {
        let handle = api.register_android_plugin("com.procweaver.mobile", "VpnPlugin")?;
        PLUGIN.set(handle).map_err(|_| "Android VPN bridge initialized twice")?;
        Ok(())
    }).build()
}

pub fn call<T: DeserializeOwned>(command: &str, args: impl Serialize) -> Result<T, String> {
    if let Some(plugin) = PLUGIN.get() { plugin.run_mobile_plugin(command, args).map_err(|e| e.to_string()) }
    else { background::call(command, args) }
}

pub async fn call_async<T: DeserializeOwned + Send + 'static>(command: &str, args: impl Serialize) -> Result<T, String> {
    if let Some(plugin) = PLUGIN.get() { plugin.run_mobile_plugin_async(command, args).await.map_err(|e| e.to_string()) }
    else {
        let command = command.to_owned();
        let args = serde_json::to_value(args).map_err(|_| "Android 参数无效")?;
        tokio::task::spawn_blocking(move || background::call(&command, args)).await.map_err(|_| "后台调用任务失败")?
    }
}

pub fn validate(raw: &str) -> Result<(), String> {
    call::<serde_json::Value>("validate", serde_json::json!({"config": raw})).map(|_| ())
}

pub fn controller_secret() -> Result<String, String> {
    std::fs::read_to_string(crate::storage::data_dir().join("controller-token"))
        .map(|s| s.trim().to_owned()).map_err(|_| "Android 控制接口凭据不可用".into())
}

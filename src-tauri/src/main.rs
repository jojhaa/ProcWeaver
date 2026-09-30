// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(windows)]
    if proc_weaver_lib::capture::windivert::session::run_if_requested() { return; }
    #[cfg(target_os = "macos")]
    if proc_weaver_lib::platform::macos::guardian::run_if_requested() { return; }
    proc_weaver_lib::run();
}

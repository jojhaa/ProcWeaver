#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
fn main() {
    proc_weaver_lib::process_app::run();
}

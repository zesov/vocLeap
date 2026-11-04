#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#![cfg_attr(not(target_os = "android"), allow(dead_code))]

#[cfg(not(target_os = "android"))]
fn main() {
    app_lib::run();
}
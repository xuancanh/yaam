// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// Delegate the desktop binary entry point to the shared Tauri library bootstrap.
fn main() {
    // detached-session host/attach invocations reuse this binary — they must
    // never boot the full app
    if app_lib::detach_entry() {
        return;
    }
    app_lib::run();
}

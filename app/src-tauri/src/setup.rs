//! Platform and plugin setup run once at startup, kept out of the builder in
//! `lib.rs` so the composition root stays readable.
use tauri::App;

/// Set the dock icon in dev and enable logging in debug builds.
pub fn init(app: &App) -> Result<(), Box<dyn std::error::Error>> {
    // `tauri dev` runs a bare binary (no .app bundle), so macOS falls back to a
    // generic dock icon that doesn't match the bundled app — set it here.
    #[cfg(target_os = "macos")]
    {
        use objc2::{AnyThread, MainThreadMarker};
        use objc2_app_kit::{NSApplication, NSImage};
        use objc2_foundation::NSData;
        if let Some(mtm) = MainThreadMarker::new() {
            let data = NSData::with_bytes(include_bytes!("../icons/icon.png"));
            if let Some(img) = NSImage::initWithData(NSImage::alloc(), &data) {
                unsafe { NSApplication::sharedApplication(mtm).setApplicationIconImage(Some(&img)) };
            }
        }
    }
    if cfg!(debug_assertions) {
        app.handle().plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .build(),
        )?;
    }
    Ok(())
}

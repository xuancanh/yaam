//! File-type icons: return the OS's own icon for a path (the macOS Finder
//! icon via NSWorkspace) as a base64 PNG, so the file explorer can show real
//! system icons. Other platforms return an error and the frontend falls back
//! to its glyph set. The frontend caches per extension, so each file type is
//! fetched once per app run.
use base64::{engine::general_purpose::STANDARD as B64, Engine};

#[cfg(target_os = "macos")]
fn icon_png(path: &str) -> Result<Vec<u8>, String> {
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSWorkspace};
    use objc2_foundation::{NSDictionary, NSString};
    // NSWorkspace hands back a multi-representation NSImage (16…1024px); a
    // TIFF round-trip is the sanctioned drawing-free way to get bitmap bytes.
    let img = NSWorkspace::sharedWorkspace().iconForFile(&NSString::from_str(path));
    let tiff = img
        .TIFFRepresentation()
        .ok_or("icon has no bitmap representation")?;
    let rep = NSBitmapImageRep::imageRepWithData(&tiff).ok_or("could not decode icon bitmap")?;
    let png = unsafe { rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new()) }
        .ok_or("png encoding failed")?;
    Ok(png.to_vec())
}

/// Base64 PNG of the OS icon for `path`. macOS only — callers fall back to
/// their own glyphs when this errors.
#[tauri::command]
pub fn file_icon(path: String) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        icon_png(&path).map(|b| B64.encode(b))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (path, &B64);
        Err("system file icons are only available on macOS".into())
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::file_icon;
    use base64::{engine::general_purpose::STANDARD as B64, Engine};

    #[test]
    fn returns_a_png_for_a_real_file() {
        let b64 = file_icon("/bin/ls".into()).expect("icon");
        let bytes = B64.decode(b64).expect("valid base64");
        assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
    }

    #[test]
    fn a_directory_gets_the_folder_icon_without_error() {
        // any path works — unknown paths get the generic document icon
        assert!(file_icon("/tmp".into()).is_ok());
    }
}

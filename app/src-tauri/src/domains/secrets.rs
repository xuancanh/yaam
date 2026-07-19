//! OS keychain storage for credentials (API keys, MCP auth headers). Secrets
//! are redacted from the plaintext state file and kept here instead — macOS
//! Keychain, Windows Credential Manager, or the Linux Secret Service. Each
//! secret is one keychain entry under this service, keyed by an opaque account.
use keyring::Entry;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

const SERVICE: &str = "dev.yaam.conductor";
const MAX_ACCOUNT_BYTES: usize = 512;
const MAX_SECRET_BYTES: usize = 1024 * 1024;
const ACL_BACKUP_PREFIX: &str = "__yaam_acl_backup__.";

fn cache() -> &'static Mutex<HashMap<String, String>> {
    static CACHE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cache_get(account: &str) -> Option<String> {
    cache()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(account)
        .cloned()
}

fn cache_set(account: &str, value: Option<String>) {
    let mut values = cache().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(value) = value {
        values.insert(account.to_string(), value);
    } else {
        values.remove(account);
    }
}

fn entry(account: &str) -> Result<Entry, String> {
    if account.is_empty()
        || account.len() > MAX_ACCOUNT_BYTES
        || account.chars().any(char::is_control)
    {
        return Err("secret key is empty, oversized, or contains control characters".into());
    }
    Entry::new(SERVICE, account).map_err(|e| e.to_string())
}

fn delete_entry(account: &str) -> Result<(), String> {
    match entry(account)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(err.to_string()),
    }
}

#[cfg(target_os = "macos")]
fn macos_get(account: &str) -> Result<Option<String>, String> {
    use security_framework::os::macos::keychain::SecKeychain;

    // SecKeychain's interaction flag is process-global. Serialize the short
    // non-interactive probe so another YAAM secret operation cannot restore it
    // early while this one is still checking an ACL.
    static KEYCHAIN_INTERACTION: Mutex<()> = Mutex::new(());
    let credential = entry(account)?;
    let silent = {
        let _serialized = KEYCHAIN_INTERACTION
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let _no_ui = SecKeychain::disable_user_interaction().map_err(|e| e.to_string())?;
        credential.get_password()
    };
    match silent {
        Ok(value) => return Ok(Some(value)),
        Err(keyring::Error::NoEntry) => {
            // If a previous ACL refresh was interrupted after deleting the old
            // item, recover from its current-binary-owned backup.
            let backup = format!("{ACL_BACKUP_PREFIX}{account}");
            if let Ok(value) = entry(&backup)?.get_password() {
                entry(account)?
                    .set_password(&value)
                    .map_err(|e| e.to_string())?;
                let _ = delete_entry(&backup);
                return Ok(Some(value));
            }
            return Ok(None);
        }
        Err(_) => {}
    }

    // The item exists but this rebuilt/ad-hoc-signed binary is absent from its
    // legacy file-keychain ACL. One authorized read is unavoidable. Recreate
    // the item afterward so the current binary becomes its trusted creator;
    // subsequent webview reloads and app reopens stay silent for this build.
    let value = credential.get_password().map_err(|e| e.to_string())?;
    let backup = format!("{ACL_BACKUP_PREFIX}{account}");
    if let Err(err) = entry(&backup)?.set_password(&value) {
        log::warn!("could not stage Keychain ACL refresh for {account}: {err}");
        return Ok(Some(value));
    }
    if let Err(err) = credential.delete_credential() {
        let _ = delete_entry(&backup);
        log::warn!("could not replace legacy Keychain ACL for {account}: {err}");
        return Ok(Some(value));
    }
    if let Err(err) = entry(account)?.set_password(&value) {
        // The backup deliberately remains so the next read can recover it.
        log::error!("could not recreate Keychain item {account}; recovery backup retained: {err}");
        return Ok(Some(value));
    }
    let _ = delete_entry(&backup);
    Ok(Some(value))
}

#[cfg(not(target_os = "macos"))]
fn platform_get(account: &str) -> Result<Option<String>, String> {
    match entry(account)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(err.to_string()),
    }
}

#[cfg(target_os = "macos")]
fn platform_get(account: &str) -> Result<Option<String>, String> {
    macos_get(account)
}

/// Store (or replace) a secret. An empty value deletes the entry.
#[tauri::command]
pub fn secret_set(account: String, value: String) -> Result<(), String> {
    if value.len() > MAX_SECRET_BYTES {
        return Err("secret value exceeds 1 MB".to_string());
    }
    if value.is_empty() {
        delete_entry(&account)?;
        let _ = delete_entry(&format!("{ACL_BACKUP_PREFIX}{account}"));
        cache_set(&account, None);
        return Ok(());
    }
    entry(&account)?
        .set_password(&value)
        .map_err(|e| e.to_string())?;
    let _ = delete_entry(&format!("{ACL_BACKUP_PREFIX}{account}"));
    cache_set(&account, Some(value));
    Ok(())
}

/// Retrieve a secret; a missing entry returns None rather than erroring.
#[tauri::command]
pub fn secret_get(account: String) -> Result<Option<String>, String> {
    entry(&account)?; // validate even when a cached value exists
    if let Some(value) = cache_get(&account) {
        return Ok(Some(value));
    }
    let value = platform_get(&account)?;
    if let Some(value) = &value {
        cache_set(&account, Some(value.clone()));
    }
    Ok(value)
}

/// Delete a secret (no-op when absent).
#[tauri::command]
pub fn secret_delete(account: String) -> Result<(), String> {
    delete_entry(&account)?;
    let _ = delete_entry(&format!("{ACL_BACKUP_PREFIX}{account}"));
    cache_set(&account, None);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{cache_get, cache_set, entry, ACL_BACKUP_PREFIX};

    #[test]
    fn validates_keychain_account_names_before_os_access() {
        assert!(entry("").is_err());
        assert!(entry("line\nbreak").is_err());
        assert!(entry(&"x".repeat(513)).is_err());
        assert!(entry("remote.device.phone-1.token").is_ok());
        assert!(entry(&format!("{ACL_BACKUP_PREFIX}master.apiKey")).is_ok());
    }

    #[test]
    fn process_cache_can_be_replaced_and_cleared() {
        let account = "test.process-cache";
        cache_set(account, Some("one".into()));
        assert_eq!(cache_get(account).as_deref(), Some("one"));
        cache_set(account, Some("two".into()));
        assert_eq!(cache_get(account).as_deref(), Some("two"));
        cache_set(account, None);
        assert!(cache_get(account).is_none());
    }
}

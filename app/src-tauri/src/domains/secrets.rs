//! OS keychain storage for credentials (API keys, MCP auth headers). Secrets
//! are redacted from the plaintext state file and kept here instead — macOS
//! Keychain, Windows Credential Manager, or the Linux Secret Service. Each
//! secret is one keychain entry under this service, keyed by an opaque account.
use keyring::Entry;

const SERVICE: &str = "dev.yaam.conductor";
const MAX_ACCOUNT_BYTES: usize = 512;
const MAX_SECRET_BYTES: usize = 1024 * 1024;

fn entry(account: &str) -> Result<Entry, String> {
    if account.is_empty() || account.len() > MAX_ACCOUNT_BYTES || account.chars().any(char::is_control) {
        return Err("secret key is empty, oversized, or contains control characters".into());
    }
    Entry::new(SERVICE, account).map_err(|e| e.to_string())
}

/// Store (or replace) a secret. An empty value deletes the entry.
#[tauri::command]
pub fn secret_set(account: String, value: String) -> Result<(), String> {
    if value.len() > MAX_SECRET_BYTES { return Err("secret value exceeds 1 MB".to_string()); }
    let e = entry(&account)?;
    if value.is_empty() {
        return match e.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(err.to_string()),
        };
    }
    e.set_password(&value).map_err(|e| e.to_string())
}

/// Retrieve a secret; a missing entry returns None rather than erroring.
#[tauri::command]
pub fn secret_get(account: String) -> Result<Option<String>, String> {
    match entry(&account)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Delete a secret (no-op when absent).
#[tauri::command]
pub fn secret_delete(account: String) -> Result<(), String> {
    match entry(&account)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::entry;

    #[test]
    fn validates_keychain_account_names_before_os_access() {
        assert!(entry("").is_err());
        assert!(entry("line\nbreak").is_err());
        assert!(entry(&"x".repeat(513)).is_err());
        assert!(entry("remote.device.phone-1.token").is_ok());
    }
}

//! OS keychain storage for credentials (API keys, MCP auth headers). Secrets
//! are redacted from the plaintext state file and kept here instead — macOS
//! Keychain, Windows Credential Manager, or the Linux Secret Service. Each
//! secret is one keychain entry under this service, keyed by an opaque account.
use keyring::Entry;

const SERVICE: &str = "dev.yaam.conductor";

fn entry(account: &str) -> Result<Entry, String> {
    if account.is_empty() {
        return Err("empty secret key".into());
    }
    Entry::new(SERVICE, account).map_err(|e| e.to_string())
}

/// Store (or replace) a secret. An empty value deletes the entry.
#[tauri::command]
pub fn secret_set(account: String, value: String) -> Result<(), String> {
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

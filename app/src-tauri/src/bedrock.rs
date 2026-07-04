// AWS Bedrock bridge for the Master brain. Uses the standard AWS credential
// chain (env vars, ~/.aws profiles, SSO, IMDS), which caches and auto-refreshes
// temporary credentials on its own. On an auth failure we additionally run the
// user's optional refresh command (e.g. `aws sso login`), rebuild the client so
// the chain re-reads credentials from disk, and retry once.
use aws_config::{BehaviorVersion, Region};
use aws_sdk_bedrockruntime::error::DisplayErrorContext;
use aws_sdk_bedrockruntime::{primitives::Blob, Client};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::State;

#[derive(Default)]
pub struct BedrockState {
    clients: Mutex<HashMap<String, Client>>,
}

async fn make_client(region: &str, profile: &str) -> Client {
    let mut loader = aws_config::defaults(BehaviorVersion::latest())
        .region(Region::new(region.to_string()));
    if !profile.is_empty() {
        loader = loader.profile_name(profile);
    }
    Client::new(&loader.load().await)
}

async fn invoke(client: &Client, model: &str, body: &str) -> Result<String, String> {
    let res = client
        .invoke_model()
        .model_id(model)
        .content_type("application/json")
        .accept("application/json")
        .body(Blob::new(body.as_bytes().to_vec()))
        .send()
        .await
        .map_err(|e| format!("{}", DisplayErrorContext(&e)))?;
    Ok(String::from_utf8_lossy(res.body().as_ref()).to_string())
}

fn is_auth_error(msg: &str) -> bool {
    let m = msg.to_lowercase();
    m.contains("expired")
        || m.contains("credential")
        || m.contains("security token")
        || m.contains("unauthorized")
        || m.contains("accessdenied")
        || m.contains("no providers in chain")
        || m.contains("dispatch failure")
}

#[tauri::command]
pub async fn bedrock_invoke(
    state: State<'_, BedrockState>,
    region: String,
    profile: String,
    refresh_cmd: String,
    model: String,
    body: String,
) -> Result<String, String> {
    let key = format!("{region}|{profile}");
    let client = {
        let cached = state.clients.lock().unwrap().get(&key).cloned();
        match cached {
            Some(c) => c,
            None => {
                let c = make_client(&region, &profile).await;
                state.clients.lock().unwrap().insert(key.clone(), c.clone());
                c
            }
        }
    };

    let first = invoke(&client, &model, &body).await;
    let err = match first {
        Ok(out) => return Ok(out),
        Err(e) if is_auth_error(&e) => e,
        Err(e) => return Err(e),
    };

    // credentials look stale — refresh (optional command through a login shell,
    // so aws/corporate CLIs resolve), rebuild the client, retry once
    if !refresh_cmd.is_empty() {
        let cmd = refresh_cmd.clone();
        let out = tauri::async_runtime::spawn_blocking(move || {
            std::process::Command::new("/bin/sh").args(["-lc", &cmd]).output()
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("refresh command failed to run: {e}"))?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            return Err(format!(
                "bedrock auth failed and the refresh command exited with {}: {}",
                out.status.code().unwrap_or(-1),
                if stderr.is_empty() { err.clone() } else { stderr }
            ));
        }
    }
    state.clients.lock().unwrap().remove(&key);
    let client = make_client(&region, &profile).await;
    state
        .clients
        .lock()
        .unwrap()
        .insert(key, client.clone());
    invoke(&client, &model, &body).await
}

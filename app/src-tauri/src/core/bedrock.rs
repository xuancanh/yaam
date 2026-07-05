//! AWS Bedrock bridge for the Master brain. Credentials come from either:
//!  - a credential command whose stdout holds AWS credentials (JSON like
//!    `aws configure export-credentials` / `claude default-credential-export`,
//!    a nested { Credentials: … } payload, or AWS_* env-style lines), or
//!  - the standard AWS credential chain (env vars, ~/.aws profiles, SSO, IMDS),
//!    which caches and auto-refreshes temporary credentials on its own.
//! Clients are cached until the exported credentials expire. On an auth failure
//! we run the user's optional refresh command (e.g. `aws sso login`), rebuild
//! the client (re-running the credential command), and retry once.
use aws_config::{BehaviorVersion, Region};
use aws_sdk_bedrockruntime::config::Credentials;
use aws_sdk_bedrockruntime::error::DisplayErrorContext;
use aws_sdk_bedrockruntime::{primitives::Blob, Client};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

#[derive(Clone)]
struct CachedClient {
    client: Client,
    /// when the exported credentials lapse; None = chain-managed (no expiry here)
    expires: Option<SystemTime>,
}

#[derive(Default)]
pub struct BedrockState {
    clients: Mutex<HashMap<String, CachedClient>>,
}

/// Parse ISO text or epoch seconds/milliseconds into a credential expiry time.
fn parse_expiration(v: &serde_json::Value) -> Option<SystemTime> {
    if let Some(s) = v.as_str() {
        let dt = aws_smithy_types::DateTime::from_str(s, aws_smithy_types::date_time::Format::DateTime).ok()?;
        return SystemTime::try_from(dt).ok();
    }
    if let Some(n) = v.as_f64() {
        // heuristics: epoch millis vs seconds
        let secs = if n > 1e12 { n / 1000.0 } else { n };
        return Some(std::time::UNIX_EPOCH + Duration::from_secs_f64(secs));
    }
    None
}

/// Parse AWS credentials out of credential-command output.
fn parse_aws_creds(raw: &str) -> Result<Credentials, String> {
    let text = raw.trim();

    if let Ok(v) = serde_json::from_str::<serde_json::Value>(text) {
        // creds may sit at the top level or nested (aws sts / SDK responses)
        let obj = v
            .get("Credentials")
            .or_else(|| v.get("credentials"))
            .unwrap_or(&v);
        let get = |names: &[&str]| -> Option<String> {
            names
                .iter()
                .find_map(|n| obj.get(*n).and_then(|x| x.as_str()))
                .map(str::to_string)
        };
        let access = get(&["AccessKeyId", "accessKeyId", "aws_access_key_id", "AWS_ACCESS_KEY_ID"]);
        let secret = get(&["SecretAccessKey", "secretAccessKey", "aws_secret_access_key", "AWS_SECRET_ACCESS_KEY"]);
        let session = get(&["SessionToken", "sessionToken", "aws_session_token", "AWS_SESSION_TOKEN"]);
        let expires = ["Expiration", "expiration", "Expires", "expiresAt", "expires_at"]
            .iter()
            .find_map(|n| obj.get(*n))
            .and_then(parse_expiration);
        return match (access, secret) {
            (Some(a), Some(s)) => Ok(Credentials::new(a, s, session, expires, "yaam-credential-command")),
            _ => Err("credential command output is JSON but has no AccessKeyId/SecretAccessKey".to_string()),
        };
    }

    // env-style lines: `export AWS_ACCESS_KEY_ID=…` / `AWS_ACCESS_KEY_ID="…"`
    let mut map: HashMap<String, String> = HashMap::new();
    for line in text.lines() {
        let l = line.trim().trim_start_matches("export ").trim();
        if let Some((k, val)) = l.split_once('=') {
            map.insert(
                k.trim().to_uppercase(),
                val.trim().trim_matches('"').trim_matches('\'').to_string(),
            );
        }
    }
    match (map.get("AWS_ACCESS_KEY_ID"), map.get("AWS_SECRET_ACCESS_KEY")) {
        (Some(a), Some(s)) => Ok(Credentials::new(
            a.clone(),
            s.clone(),
            map.get("AWS_SESSION_TOKEN").cloned(),
            None,
            "yaam-credential-command",
        )),
        _ => Err(
            "credential command output is neither AWS credentials JSON nor AWS_* env lines"
                .to_string(),
        ),
    }
}

/// Run a credential or refresh command in a login shell without blocking async tasks.
async fn run_shell(cmd: String) -> Result<String, String> {
    let out = tauri::async_runtime::spawn_blocking(move || {
        std::process::Command::new("/bin/sh").args(["-lc", &cmd]).output()
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| format!("command failed to run: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "command exited with {}: {}",
            out.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// Build a Bedrock client from exported credentials or the standard AWS chain.
async fn make_client(region: &str, profile: &str, cred_cmd: &str) -> Result<CachedClient, String> {
    let mut loader =
        aws_config::defaults(BehaviorVersion::latest()).region(Region::new(region.to_string()));
    let mut expires = None;
    if !cred_cmd.is_empty() {
        let creds = parse_aws_creds(&run_shell(cred_cmd.to_string()).await?)?;
        // match Claude Code's documented caching: until the stated expiration,
        // or one hour when the command reports none
        expires = Some(
            creds
                .expiry()
                .unwrap_or_else(|| SystemTime::now() + Duration::from_secs(3600)),
        );
        loader = loader.credentials_provider(creds);
    } else if !profile.is_empty() {
        loader = loader.profile_name(profile);
    }
    Ok(CachedClient { client: Client::new(&loader.load().await), expires })
}

/// Invoke one Bedrock model and return its response body as UTF-8 text.
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

/// Classify SDK error text that can be recovered by refreshing credentials.
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

/// Keep cached clients only when credentials outlive the five-minute safety margin.
fn still_fresh(c: &CachedClient) -> bool {
    match c.expires {
        // rebuild five minutes early (Claude Code's documented margin) so a
        // request never rides an expiring token
        Some(t) => t > SystemTime::now() + Duration::from_secs(300),
        None => true,
    }
}

/// Invoke Bedrock with a cached client, refreshing credentials and retrying once.
#[allow(clippy::too_many_arguments)]
pub async fn invoke_model(
    state: &BedrockState,
    region: String,
    profile: String,
    refresh_cmd: String,
    cred_cmd: String,
    model: String,
    body: String,
) -> Result<String, String> {
    let key = format!("{region}|{profile}|{cred_cmd}");
    let cached = state
        .clients
        .lock()
        .unwrap()
        .get(&key)
        .filter(|c| still_fresh(c))
        .cloned();
    let client = match cached {
        Some(c) => c,
        None => {
            let c = make_client(&region, &profile, &cred_cmd).await?;
            state.clients.lock().unwrap().insert(key.clone(), c.clone());
            c
        }
    };

    let err = match invoke(&client.client, &model, &body).await {
        Ok(out) => return Ok(out),
        Err(e) if is_auth_error(&e) => e,
        Err(e) => return Err(e),
    };

    // credentials look stale — refresh (optional command through a login shell,
    // so aws/corporate CLIs resolve), rebuild the client, retry once
    if !refresh_cmd.is_empty() {
        run_shell(refresh_cmd)
            .await
            .map_err(|e| format!("bedrock auth failed ({err}) and the refresh command also failed: {e}"))?;
    }
    state.clients.lock().unwrap().remove(&key);
    let client = make_client(&region, &profile, &cred_cmd).await?;
    state.clients.lock().unwrap().insert(key, client.clone());
    invoke(&client.client, &model, &body).await
}

#[cfg(test)]
mod tests {
    use super::parse_aws_creds;

    #[test]
    /// Accept the shape emitted by `aws configure export-credentials`.
    fn parses_export_credentials_json() {
        let c = parse_aws_creds(
            r#"{"Version":1,"AccessKeyId":"AKIA1","SecretAccessKey":"S1","SessionToken":"T1","Expiration":"2030-01-01T00:00:00Z"}"#,
        )
        .unwrap();
        assert_eq!(c.access_key_id(), "AKIA1");
        assert_eq!(c.session_token(), Some("T1"));
        assert!(c.expiry().is_some());
    }

    #[test]
    /// Accept nested camel-case credentials and millisecond expirations.
    fn parses_nested_and_camel_case() {
        let c = parse_aws_creds(
            r#"{"credentials":{"accessKeyId":"AKIA2","secretAccessKey":"S2","sessionToken":"T2","expiration":1893456000000}}"#,
        )
        .unwrap();
        assert_eq!(c.access_key_id(), "AKIA2");
        assert!(c.expiry().is_some());
    }

    #[test]
    /// Accept shell-style AWS environment assignments.
    fn parses_env_lines() {
        let c = parse_aws_creds(
            "export AWS_ACCESS_KEY_ID=AKIA3\nexport AWS_SECRET_ACCESS_KEY=\"S3\"\nexport AWS_SESSION_TOKEN='T3'\n",
        )
        .unwrap();
        assert_eq!(c.access_key_id(), "AKIA3");
        assert_eq!(c.session_token(), Some("T3"));
    }

    #[test]
    /// Reject non-AWS API-key output before constructing a Bedrock client.
    fn rejects_api_key_output() {
        assert!(parse_aws_creds("sk-ant-api-abc").is_err());
        assert!(parse_aws_creds(r#"{"apiKey":"sk-ant-api-abc"}"#).is_err());
    }
}

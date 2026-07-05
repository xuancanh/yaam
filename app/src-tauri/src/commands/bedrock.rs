//! IPC handler for the AWS Bedrock bridge.
use crate::core::bedrock::{self, BedrockState};
use tauri::State;

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn bedrock_invoke(
    state: State<'_, BedrockState>,
    region: String,
    profile: String,
    refresh_cmd: String,
    cred_cmd: String,
    model: String,
    body: String,
) -> Result<String, String> {
    bedrock::invoke_model(&state, region, profile, refresh_cmd, cred_cmd, model, body).await
}

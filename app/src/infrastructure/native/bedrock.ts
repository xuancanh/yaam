// AWS Bedrock adapter: delegate a SigV4-authenticated InvokeModel request to
// Rust (credential chain + refresh command live backend-side). Desktop only.
import { invoke } from '@tauri-apps/api/core'
import { isTauri } from './base'

/** Delegate a SigV4-authenticated Bedrock InvokeModel request to Rust. */
export async function bedrockInvoke(region: string, profile: string, refreshCmd: string, credCmd: string, model: string, body: string): Promise<string> {
  if (!isTauri) throw new Error('Bedrock requires the desktop app')
  return await invoke<string>('bedrock_invoke', { region, profile, refreshCmd, credCmd, model, body })
}

// Remote companion adapter: token-authed LAN server (Rust tiny_http) a phone
// can open to watch the fleet and answer approvals. The frontend publishes
// state snapshots and drains the decision queue; execution stays local.
import { invoke } from '@tauri-apps/api/core'
import { isTauri } from './base'

export interface RemoteInfo {
  url: string
  token: string
}

export interface RemoteDecision {
  /** 'master' (tool approval) or 'chat' (ask-mode approval) */
  kind: string
  id: string
  agent_id: string
  ok: boolean
}

/** Start (or return the already-running) companion server. */
export async function remoteStart(port?: number): Promise<RemoteInfo> {
  if (!isTauri) throw new Error('the remote companion requires the desktop app')
  return await invoke<RemoteInfo>('remote_start', { port: port ?? null })
}

export async function remoteStop(): Promise<void> {
  if (!isTauri) return
  await invoke('remote_stop')
}

/** Publish the latest fleet snapshot (JSON) for phones to poll. */
export async function remotePublish(json: string): Promise<void> {
  if (!isTauri) return
  await invoke('remote_publish', { json })
}

/** Drain approve/deny decisions queued by remote clients. */
export async function remoteTakeDecisions(): Promise<RemoteDecision[]> {
  if (!isTauri) return []
  return await invoke<RemoteDecision[]>('remote_take_decisions')
}

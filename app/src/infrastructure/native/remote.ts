// Remote companion adapter: axum LAN server (Rust) serving the mobile web app
// plus a JSON API. Access needs the per-start URL token AND a per-device token
// minted only by an explicit pairing approval on this desktop. The frontend
// publishes state snapshots and drains the command queue; execution stays local.
import { invoke } from '@tauri-apps/api/core'
import { isTauri } from './base'

export interface RemoteInfo {
  url: string
  token: string
  /** one connect URL per reachable interface: lan · tailscale · wireguard · vpn · public */
  urls: { label: string; url: string }[]
}

/** One action a paired phone asked the desktop to perform. */
export interface RemoteCommand {
  /** chat_send · task_chat · task_move · task_start · session_input ·
   *  session_stop · session_resume · approve_master · approve_chat */
  kind: string
  id: string
  agent_id: string
  text: string
  ok: boolean
}

/** A device awaiting the user's explicit pairing approval. */
export interface RemotePairRequest {
  id: string
  name: string
  at: number
}

/** A paired device; persisted in settings and re-hydrated into the server. */
export interface RemotePairedDevice {
  id: string
  name: string
  token: string
  at: number
}

/** Start (or return the already-running) companion server. `token` is the
 *  persisted URL token so links survive restarts; omit to mint a fresh one. */
export async function remoteStart(port?: number, token?: string): Promise<RemoteInfo> {
  if (!isTauri) throw new Error('the remote companion requires the desktop app')
  return await invoke<RemoteInfo>('remote_start', { port: port ?? null, token: token ?? null })
}

export async function remoteStop(): Promise<void> {
  if (!isTauri) return
  await invoke('remote_stop')
}

/** Publish the latest snapshot (JSON) for paired phones to poll. */
export async function remotePublish(json: string): Promise<void> {
  if (!isTauri) return
  await invoke('remote_publish', { json })
}

/** True while a phone is plausibly watching (SSE subscriber or recent poll) —
 *  building/serializing snapshots for nobody is pure main-thread waste. */
export async function remoteActive(): Promise<boolean> {
  if (!isTauri) return false
  return await invoke<boolean>('remote_active')
}

/** Drain commands queued by paired devices. */
export async function remoteTakeCommands(): Promise<RemoteCommand[]> {
  if (!isTauri) return []
  return await invoke<RemoteCommand[]>('remote_take_commands')
}

/** Pairing requests awaiting approval on this desktop. */
export async function remotePendingPairs(): Promise<RemotePairRequest[]> {
  if (!isTauri) return []
  return await invoke<RemotePairRequest[]>('remote_pending_pairs')
}

/** Approve a pairing request — mints and returns the device token. */
export async function remoteApprovePair(deviceId: string): Promise<RemotePairedDevice> {
  if (!isTauri) throw new Error('pairing requires the desktop app')
  return await invoke<RemotePairedDevice>('remote_approve_pair', { deviceId })
}

export async function remoteDenyPair(deviceId: string): Promise<void> {
  if (!isTauri) return
  await invoke('remote_deny_pair', { deviceId })
}

/** Answer an rpc request (fs/git browsing) — the phone polls /api/rpc for it. */
export async function remoteRespond(id: string, json: string): Promise<void> {
  if (!isTauri) return
  await invoke('remote_respond', { id, json })
}

/** Hydrate the server's paired-device set from the persisted settings copy. */
export async function remoteSetDevices(devices: RemotePairedDevice[]): Promise<void> {
  if (!isTauri) return
  await invoke('remote_set_devices', { devices })
}

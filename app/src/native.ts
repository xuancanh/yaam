// Bridge to the Tauri backend. Falls back to no-ops when running in a plain
// browser (e.g. `npm run dev` opened directly) so the simulated agents still work.
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog'
import { fetch as tauriFetch } from '@tauri-apps/plugin-http'

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

export interface SessionData {
  id: string
  /** raw PTY bytes, decoded from base64 */
  bytes: Uint8Array
}

export interface SessionExit {
  id: string
  code: number | null
}

/** Ask Tauri to launch a command or direct terminal shell in a real PTY. */
export async function spawnSession(id: string, command: string, cwd?: string, rows?: number, cols?: number, terminalShell?: string): Promise<void> {
  if (!isTauri) throw new Error('Real sessions require the desktop app')
  await invoke('spawn_session', { id, command, terminalShell: terminalShell || null, cwd: cwd || null, rows: rows ?? null, cols: cols ?? null })
}

/** Write raw input bytes to a live native PTY. */
export async function writeSession(id: string, data: string): Promise<void> {
  if (!isTauri) return
  await invoke('write_session', { id, data })
}

/** Resize a live native PTY to match its xterm viewport. */
export async function resizeSession(id: string, rows: number, cols: number): Promise<void> {
  if (!isTauri) return
  await invoke('resize_session', { id, rows, cols }).catch(() => {})
}

/** Discover the CLI conversation id created after a YAAM session launched. */
export async function detectCliSession(kind: string, cwd: string | undefined, sinceMs: number): Promise<string | null> {
  if (!isTauri) return null
  return await invoke<string | null>('detect_cli_session', { kind, cwd: cwd || null, sinceMs })
}

/** Return native PTY ids that are still owned by the backend. */
export async function liveSessions(): Promise<string[]> {
  if (!isTauri) return []
  return await invoke<string[]>('live_sessions')
}

/** Terminate and unregister one native PTY process. */
export async function killSession(id: string): Promise<void> {
  if (!isTauri) return
  await invoke('kill_session', { id })
}

/** Decode base64 PTY event payloads without assuming browser text encoding. */
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

/** Subscribe to decoded PTY output and return an unsubscribe function. */
export function onSessionData(cb: (e: SessionData) => void): () => void {
  if (!isTauri) return () => {}
  let alive = true
  let unlisten = () => {}
  listen<{ id: string; data: string }>('session-data', e => {
    cb({ id: e.payload.id, bytes: b64ToBytes(e.payload.data) })
  }).then(fn => {
    if (alive) unlisten = fn
    else fn()
  })
  return () => { alive = false; unlisten() }
}

/** Subscribe to native process-exit events and return an unsubscribe function. */
export function onSessionExit(cb: (e: SessionExit) => void): () => void {
  if (!isTauri) return () => {}
  let alive = true
  let unlisten = () => {}
  listen<SessionExit>('session-exit', e => cb(e.payload)).then(fn => {
    if (alive) unlisten = fn
    else fn()
  })
  return () => { alive = false; unlisten() }
}

/** Open the native directory picker when available. */
export async function pickFolder(defaultPath?: string): Promise<string | null> {
  if (!isTauri) return null
  const picked = await openDialog({ directory: true, multiple: false, defaultPath: defaultPath || undefined })
  return typeof picked === 'string' ? picked : null
}

/** Fetch text through Tauri's HTTP plugin so desktop requests are not blocked by CORS. */
export async function httpGetText(url: string): Promise<string> {
  const res = await (isTauri ? tauriFetch : fetch)(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return await res.text()
}

/** POST text (JSON-RPC etc.) through Tauri's HTTP plugin; returns body + headers of interest. */
export async function httpPostText(url: string, body: string, headers: Record<string, string>): Promise<{ text: string; contentType: string; mcpSessionId: string | null }> {
  const res = await (isTauri ? tauriFetch : fetch)(url, { method: 'POST', headers, body })
  const text = await res.text()
  if (!res.ok) throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`)
  return { text, contentType: res.headers.get('content-type') ?? '', mcpSessionId: res.headers.get('mcp-session-id') }
}

export interface ExecResult {
  code: number
  output: string
}

/** One-shot shell execution with timeout + output cap (chat agents' run_command). */
export async function execCommand(cmd: string, cwd?: string, timeoutMs?: number): Promise<ExecResult> {
  if (!isTauri) throw new Error('running commands requires the desktop app')
  return await invoke<ExecResult>('exec_command', { cmd, cwd: cwd || null, timeoutMs: timeoutMs ?? null })
}

export interface ChatSearchHit {
  chatId: string
  msgId: string
  role: string
  text: string
  score: number
}

/** Rebuild the embedded tantivy index from all chat messages. */
export async function chatSearchReindex(docs: { chatId: string; msgId: string; role: string; text: string }[]): Promise<number> {
  if (!isTauri) return 0
  return await invoke<number>('chat_search_reindex', {
    docs: docs.map(d => ({ chat_id: d.chatId, msg_id: d.msgId, role: d.role, text: d.text })),
  })
}

/** Full-text search across chats via the embedded engine. */
export async function chatSearch(query: string, limit?: number): Promise<ChatSearchHit[]> {
  if (!isTauri) return []
  const hits = await invoke<{ chat_id: string; msg_id: string; role: string; text: string; score: number }[]>('chat_search', { query, limit: limit ?? null })
  return hits.map(h => ({ chatId: h.chat_id, msgId: h.msg_id, role: h.role, text: h.text, score: h.score }))
}

/** Open the native single-file picker when available. */
export async function pickFile(): Promise<string | null> {
  if (!isTauri) return null
  const picked = await openDialog({ multiple: false, filters: [{ name: 'YAAM addon', extensions: ['json'] }] })
  return typeof picked === 'string' ? picked : null
}

/** Ask the user for a native destination path for an exported file. */
export async function pickSavePath(defaultName: string): Promise<string | null> {
  if (!isTauri) return null
  return await saveDialog({ defaultPath: defaultName, filters: [{ name: 'YAAM addon', extensions: ['json'] }] })
}

/** Read a UTF-8 file through the native backend. */
export async function readTextFile(path: string): Promise<string> {
  return await invoke<string>('read_text_file', { path })
}

/** Write a UTF-8 file through the native backend. */
export async function writeTextFile(path: string, contents: string): Promise<void> {
  await invoke('write_text_file', { path, contents })
}

/** Run the configured credential command; returns trimmed stdout. */
/** Run a configured credential-export command in the native login shell. */
export async function runCredentialCommand(cmd: string): Promise<string> {
  if (!isTauri) throw new Error('credential commands require the desktop app')
  return await invoke<string>('run_credential_command', { cmd })
}

/** Call Claude on AWS Bedrock via the backend (SigV4 + credential chain). */
/** Delegate a SigV4-authenticated Bedrock InvokeModel request to Rust. */
export async function bedrockInvoke(region: string, profile: string, refreshCmd: string, credCmd: string, model: string, body: string): Promise<string> {
  if (!isTauri) throw new Error('Bedrock requires the desktop app')
  return await invoke<string>('bedrock_invoke', { region, profile, refreshCmd, credCmd, model, body })
}

export interface DirEntryInfo {
  name: string
  path: string
  isDir: boolean
}

/** List one directory through the backend for the workspace file tree. */
export async function listDir(path: string): Promise<DirEntryInfo[]> {
  if (!isTauri) return []
  const raw = await invoke<{ name: string; path: string; is_dir: boolean }[]>('list_dir', { path })
  return raw.map(e => ({ name: e.name, path: e.path, isDir: e.is_dir }))
}

export interface GitStatusResult {
  root: string
  files: { path: string; status: string }[]
}

/** Read porcelain git status plus the repository root for a session directory. */
export async function gitStatus(cwd: string): Promise<GitStatusResult> {
  if (!isTauri) throw new Error('git requires the desktop app')
  return await invoke<GitStatusResult>('git_status', { cwd })
}

/** Return the working-tree diff for one repository-relative file. */
export async function gitFileDiff(cwd: string, path: string): Promise<string> {
  if (!isTauri) throw new Error('git requires the desktop app')
  return await invoke<string>('git_file_diff', { cwd, path })
}

/** Return the complete working-tree diff for a session directory. */
export async function gitDiff(cwd: string): Promise<string> {
  if (!isTauri) throw new Error('git diff requires the desktop app')
  return await invoke<string>('git_diff', { cwd })
}

// Serialize state writes: a debounced save and a teardown flush can otherwise
// hit the backend concurrently and race on the temp file. Chaining guarantees
// one write completes before the next starts, and coalesces queued writes to
// the latest payload so a burst doesn't pile up stale saves.
let saveChain: Promise<void> = Promise.resolve()
let queuedJson: string | null = null

/** Persist the serialized app state through Tauri, with localStorage fallback.
 *  Rejects on failure so callers can surface the error. */
export function saveStateFile(json: string): Promise<void> {
  if (!isTauri) {
    localStorage.setItem('conductor-state', json)
    return Promise.resolve()
  }
  queuedJson = json
  saveChain = saveChain.then(async () => {
    if (queuedJson === null) return // already written by an earlier link
    const payload = queuedJson
    queuedJson = null
    await invoke('save_state', { json: payload })
  })
  return saveChain
}

/** Load serialized app state through Tauri, with localStorage fallback. */
export async function loadStateFile(): Promise<string | null> {
  if (!isTauri) return localStorage.getItem('conductor-state')
  return await invoke<string | null>('load_state')
}

/** Load the previous state snapshot (the .bak) — used to recover when the
 *  primary file is present but unparseable. */
export async function loadStateBackup(): Promise<string | null> {
  if (!isTauri) return null
  return await invoke<string | null>('load_state_backup')
}

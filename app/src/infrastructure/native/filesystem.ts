// Filesystem + process-exec adapter: native file/dir pickers, scoped text/binary
// file read/write (workspace-root authorization happens in Rust), directory
// listing for the file tree, the credential-export command, and one-shot shell
// execution. Browser build: pickers/list return empty, exec/credential throw.
import { invoke } from '@tauri-apps/api/core'
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog'
import { isTauri } from './base'
import { expectObjectArray } from './validate'

/** Open the native directory picker when available. */
export async function pickFolder(defaultPath?: string): Promise<string | null> {
  if (!isTauri) return null
  const picked = await openDialog({ directory: true, multiple: false, defaultPath: defaultPath || undefined })
  return typeof picked === 'string' ? picked : null
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

/** Open the native single-file picker when available. */
export async function pickFile(extensions: string[] = ['json'], label = 'YAAM addon'): Promise<string | null> {
  if (!isTauri) return null
  const picked = await openDialog({ multiple: false, filters: [{ name: label, extensions }] })
  return typeof picked === 'string' ? picked : null
}

/** Ask the user for a native destination path for an exported file. */
export async function pickSavePath(defaultName: string, extensions: string[] = ['json'], label = 'YAAM addon'): Promise<string | null> {
  if (!isTauri) return null
  return await saveDialog({ defaultPath: defaultName, filters: [{ name: label, extensions }] })
}

/** Open the native multi-file picker (any file type). */
export async function pickFiles(): Promise<string[]> {
  if (!isTauri) return []
  const picked = await openDialog({ multiple: true })
  if (Array.isArray(picked)) return picked.filter((p): p is string => typeof p === 'string')
  return typeof picked === 'string' ? [picked] : []
}

/** Read any file as base64 through the native backend (size-capped there).
 *  The viewer/import path for binary formats — PDFs, office docs, images. */
export async function readFileB64(path: string, root?: string, maxBytes?: number): Promise<string> {
  return await invoke<string>('read_file_b64', { path, root, maxBytes })
}

/** Read a UTF-8 file through the native backend. When `root` is given, the
 *  backend authorizes the path against that workspace root (symlink-safe). */
export async function readTextFile(path: string, root?: string): Promise<string> {
  return await invoke<string>('read_text_file', { path, root })
}

/** Write a UTF-8 file through the native backend. When `root` is given, the
 *  backend rejects a target that canonically escapes that workspace root — the
 *  authoritative scope check, since a symlink under the root can point outside
 *  it while the lexical path still looks workspace-local. */
export async function writeTextFile(path: string, contents: string, root?: string): Promise<void> {
  await invoke('write_text_file', { path, contents, root })
}

/** Run a configured credential-export command in the native login shell. */
export async function runCredentialCommand(cmd: string): Promise<string> {
  if (!isTauri) throw new Error('credential commands require the desktop app')
  return await invoke<string>('run_credential_command', { cmd })
}

export interface DirEntryInfo {
  name: string
  path: string
  isDir: boolean
}

/** List one directory through the backend for the workspace file tree. */
export async function listDir(path: string): Promise<DirEntryInfo[]> {
  if (!isTauri) return []
  const raw = await invoke('list_dir', { path })
  const entries = expectObjectArray(raw, ['name', 'path', 'is_dir'], 'listDir')
  return entries.map(e => ({ name: e.name as string, path: e.path as string, isDir: e.is_dir as boolean }))
}

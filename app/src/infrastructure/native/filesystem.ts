// Filesystem + process-exec adapter: native file/dir pickers, scoped text/binary
// file read/write (workspace-root authorization happens in Rust), directory
// listing for the file tree, the credential-export command, and one-shot shell
// execution. Browser build: pickers/list return empty, exec/credential throw.
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog'
import { isTauri } from './base'
import { expectObject, expectObjectArray } from './validate'

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

export interface TextRange {
  /** the requested 1-based line window */
  lines: string[]
  /** total lines in the file */
  total: number
  /** 1-based line number of the first returned line */
  start: number
}

/** Read a 1-based line window of a text file (paging for large files) without
 *  marshalling the whole file across IPC. */
export async function readTextRange(path: string, offset: number, limit: number, root?: string): Promise<TextRange> {
  if (!isTauri) return { lines: [], total: 0, start: Math.max(1, offset) }
  const raw = await invoke('read_text_range', { path, offset, limit, root })
  const o = expectObject(raw, ['lines', 'total', 'start'], 'readTextRange')
  return { lines: o.lines as string[], total: o.total as number, start: o.start as number }
}

/** Write a UTF-8 file through the native backend. When `root` is given, the
 *  backend rejects a target that canonically escapes that workspace root — the
 *  authoritative scope check, since a symlink under the root can point outside
 *  it while the lexical path still looks workspace-local. */
export async function writeTextFile(path: string, contents: string, root?: string): Promise<void> {
  await invoke('write_text_file', { path, contents, root })
}

export async function createDir(root: string, path: string): Promise<void> {
  await invoke('create_dir', { root, path })
}

export async function movePath(root: string, from: string, to: string): Promise<void> {
  await invoke('move_path', { root, from, to })
}

export async function copyPath(root: string, from: string, to: string): Promise<void> {
  await invoke('copy_path', { root, from, to })
}

export async function deletePath(root: string, path: string): Promise<void> {
  await invoke('delete_path', { root, path })
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
export async function listDir(path: string, root?: string): Promise<DirEntryInfo[]> {
  if (!isTauri) return []
  const raw = await invoke('list_dir', { path, root })
  const entries = expectObjectArray(raw, ['name', 'path', 'is_dir'], 'listDir')
  return entries.map(e => ({ name: e.name as string, path: e.path as string, isDir: e.is_dir as boolean }))
}

/** A coalesced batch of filesystem changes under a watched root. */
export interface FsChange {
  root: string
  paths: string[]
}

// The backend keeps ONE watcher per canonical root, so two panes watching the
// same folder share it — refcount here so the first unmount doesn't tear the
// watch out from under the surviving pane. Counted by the raw root string
// (panes on the same session share it verbatim).
const watchRefs = new Map<string, number>()
const watchKeys = new Map<string, Promise<string>>()

/** Start (or join) a recursive native watch on a workspace root. Resolves to
 *  the canonical root key stamped on every `fs-change` event for this root, so
 *  the caller can filter the shared event stream. In the browser build (where
 *  the file pane polls instead) it resolves to the input unchanged. */
export async function watchDir(root: string): Promise<string> {
  if (!isTauri) return root
  watchRefs.set(root, (watchRefs.get(root) ?? 0) + 1)
  let key = watchKeys.get(root)
  if (!key) {
    key = invoke<string>('watch_dir', { root }).catch(() => root)
    watchKeys.set(root, key)
  }
  return key
}

/** Release one watch on a workspace root; the native watcher stops when the
 *  last holder lets go. No-op outside Tauri. */
export async function unwatchDir(root: string): Promise<void> {
  if (!isTauri) return
  const n = (watchRefs.get(root) ?? 0) - 1
  if (n > 0) {
    watchRefs.set(root, n)
    return
  }
  watchRefs.delete(root)
  const pending = watchKeys.get(root)
  watchKeys.delete(root)
  if (pending) await pending.catch(() => {}) // never unwatch before the watch landed
  await invoke('unwatch_dir', { root })
}

/** Subscribe to coalesced filesystem-change batches and return an unsubscribe
 *  function. No-op (never fires) outside Tauri. */
export function onFsChange(cb: (e: FsChange) => void): () => void {
  if (!isTauri) return () => {}
  let alive = true
  let unlisten = () => {}
  listen<FsChange>('fs-change', e => cb(e.payload)).then(fn => {
    if (alive) unlisten = fn
    else fn()
  })
  return () => { alive = false; unlisten() }
}

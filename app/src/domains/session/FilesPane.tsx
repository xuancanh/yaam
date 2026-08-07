// VS Code-style file explorer + viewer for one agent session, hosted as a
// docked panel beside the session (the terminal/chat itself is rendered by the
// host pane — never here, since a session's xterm element is a singleton).
// Git-aware: changed files are tinted in the tree and the viewer's gutter can
// switch from line numbers to change markers (green = new, amber = modified,
// red = deletion).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { highlight, langForFile } from '../../core/highlight'
import { isTauri, onFsChange, openPath, previewClear, previewStash, unwatchDir, watchDir } from '../../core/native'
import type { DirEntryInfo, OpenPathMode } from '../../core/native'
import { sessionFs } from './remote-native'
import type { SessionFs } from './remote-native'
import { b64ToBytes, extractFileText } from '../../shared/filetext'
import { renderDocx, renderOdp, renderOdt, renderPptx, renderWorkbook } from '../../shared/office-render'
import type { OfficeRender } from '../../shared/office-render'
import { IMG_MIME, MEDIA_MIME, isCsv, parseCsv, viewKind } from '../../shared/file-preview'
import { CodeEditor } from './lazy-editor'
import { parseDiffLines } from './diff-marks'
import { filterPaths } from './quick-open'
import type { Agent } from '../../core/types'
import { IC, Icon } from '../../components/ui'
import { confirmAction } from '../../components/Confirm'
import { FileIcon } from '../../components/FileIcon'
import { Markdown } from '../../components/Markdown'
import { ContextMenu } from '../../components/ContextMenu'
import { artifactSrcDoc } from '../chat/artifacts'
import { requestAttach } from '../chat/attach-bus'
import { onOpenFileRequest } from './open-file-bus'
import { Divider } from './Divider'

// UI state survives tab switches / pane moves (components remount freely)
interface FilesState {
  /** the ACTIVE tab's path (null = no tab open) */
  file: string | null
  gutter: 'numbers' | 'git'
  expanded: string[]
  /** open editor tabs, in order */
  tabs: string[]
  /** path → unsaved editor text (a draft exists ⇔ the tab shows a dirty dot) */
  drafts: Record<string, string>
  /** path → explicit view/edit choice (absent = kind default: text opens in edit) */
  modes: Record<string, 'edit' | 'view'>
  /** explorer shows dotfiles (default true; the header eye toggles) */
  showHidden?: boolean
}
const stateCache = new Map<string, FilesState>()
// drag-adjusted explorer-column share (per session / folder); absent = the
// fixed default width until the user first drags the divider
const explorerSplitCache = new Map<string, number>()

/** Return the persistent per-session file-browser cache, creating it on demand. */
function cached(id: string): FilesState {
  let st = stateCache.get(id)
  if (!st) {
    st = { file: null, gutter: 'git', expanded: [], tabs: [], drafts: {}, modes: {}, showHidden: true }
    stateCache.set(id, st)
  } else {
    // entries created by an older bundle (HMR) predate the tab fields
    st.tabs ??= []
    st.drafts ??= {}
    st.modes ??= {}
    st.showHidden ??= true
  }
  return st
}

/** Last path segment (basename). */
function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/** Rebuild a path-keyed record with remapped keys (rename retargeting), or —
 *  with dropEmpty — drop entries whose key maps to '' (delete). Returns the
 *  original record when nothing changed. */
function remapKeys<V>(rec: Record<string, V>, remap: (path: string) => string, dropEmpty = false): Record<string, V> {
  let changed = false
  const out: Record<string, V> = {}
  for (const [k, v] of Object.entries(rec)) {
    const nk = remap(k)
    if (nk !== k) changed = true
    if (dropEmpty && nk === '') continue
    out[nk] = v
  }
  return changed ? out : rec
}

/** escape a literal string for use inside a RegExp */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Wrap case-insensitive `query` matches in <mark> inside highlighted HTML,
 *  touching only the text between tags so the token markup stays intact. */
function markMatches(html: string, query: string, current: boolean): string {
  const re = new RegExp(escapeRe(query), 'gi')
  const cls = current ? 'find-mark find-mark-current' : 'find-mark'
  return html.split(/(<[^>]*>)/g).map(seg =>
    seg.startsWith('<') ? seg : seg.replace(re, m => `<mark class="${cls}">${m}</mark>`),
  ).join('')
}

const GIT_COLORS: Record<string, string> = {
  '??': 'var(--green)', A: 'var(--green)', M: 'var(--amber)', AM: 'var(--amber)',
  MM: 'var(--amber)', D: 'var(--red-soft)', R: 'var(--amber)', UU: 'var(--red-soft)',
}

/** Map porcelain git status to a shared gutter/tree color. */
function gitColor(status: string | undefined): string | null {
  if (!status) return null
  return GIT_COLORS[status] ?? 'var(--amber)'
}

interface GitInfo {
  root: string
  /** absolute path → porcelain status */
  byPath: Map<string, string>
  /** absolute dir paths containing at least one change */
  dirs: Set<string>
}

// Rows are virtualized (only the visible window is in the DOM), so this is a
// safety ceiling on total rows rather than a render budget — far above the old
// full-render cap. ROW_H is the fixed per-row height the windowing math relies
// on; it must match the row styles below.
const MAX_LINES = 200_000
const ROW_H = 20
const OVERSCAN = 24

// ---------------------------------------------------------------- tree

/** A refresh request for mounted tree levels: bump `tick` to re-list in place;
 *  `dirs` limits the re-list to those directories (null = every level). */
interface TreeRefresh { tick: number; dirs: Set<string> | null }

/** Pending inline tree input: a create lands as the first child of `dir`; a
 *  rename replaces the target row's label. */
type TreeEditing =
  | { kind: 'file' | 'folder'; dir: string }
  | { kind: 'rename'; path: string; isDir: boolean }

/** Explorer CRUD callbacks shared by the tree rows, the context menu, and the
 *  header buttons. Owned by `useTreeOps`. */
interface TreeCrud {
  editing: TreeEditing | null
  beginCreate(dir: string, kind: 'file' | 'folder'): void
  beginRename(path: string, isDir: boolean): void
  requestDelete(path: string, isDir: boolean): void
  commit(raw: string): void
  cancel(): void
}

/** Parent directory of a '/'-separated absolute path ('/' at the top). */
function parentDir(path: string): string {
  const ix = path.lastIndexOf('/')
  return ix > 0 ? path.slice(0, ix) : '/'
}

/** VSCode-style inline name input at tree-row height: Enter commits, Esc
 *  cancels, blur commits (VSCode behavior — a no-op commit is dropped by the
 *  caller). `selectStem` selects the basename minus its extension (rename). */
function TreeInputRow({ depth, isDir, name, initial, selectStem, onCommit, onCancel }: {
  depth: number
  isDir: boolean
  /** display name for the icon while typing (create rows use the typed value) */
  name: string
  initial: string
  selectStem?: boolean
  onCommit: (value: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState(initial)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    if (selectStem) {
      const dot = initial.lastIndexOf('.')
      el.setSelectionRange(0, dot > 0 ? dot : initial.length)
    } else {
      el.select()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: `2px 8px 2px ${8 + depth * 13}px` }}>
      <span style={{ width: 12, flexShrink: 0 }} />
      <FileIcon name={name} path={name} isDir={isDir} size={13} />
      <input
        ref={ref}
        value={value}
        spellCheck={false}
        onChange={e => setValue(e.target.value)}
        onBlur={() => onCommit(value)}
        onKeyDown={e => {
          e.stopPropagation()
          if (e.key === 'Enter') onCommit(value)
          else if (e.key === 'Escape') onCancel()
        }}
        style={{
          flex: 1, minWidth: 0, fontSize: 12, padding: '1px 5px', borderRadius: 4,
          background: 'var(--panel)', border: '1px solid var(--accent)', outline: 'none',
          color: 'var(--text)', fontFamily: 'inherit',
        }}
      />
    </div>
  )
}

/** Recursively render one directory level and lazily loaded descendants. */
function TreeLevel({ dir, depth, expanded, toggleDir, openFile, selected, git, refresh, onAttachFile, onMenu, fs, crud, showHidden = true }: {
  dir: string
  depth: number
  expanded: Set<string>
  toggleDir: (path: string) => void
  openFile: (path: string) => void
  selected: string | null
  git: GitInfo | null
  /** re-list signal — levels update in place (no remount, no placeholder flash) */
  refresh: TreeRefresh
  /** chat hosts: attach this file to the conversation (design's ＋ chip) */
  onAttachFile?: (path: string) => void
  /** right-click context menu (CRUD everywhere; native open entries local-only) */
  onMenu?: (ev: React.MouseEvent, path: string, isDir: boolean) => void
  /** local or remote (ssh) fs adapter for the owning session */
  fs: SessionFs
  /** explorer CRUD state — inline create/rename inputs driven by the host */
  crud?: TreeCrud
  /** include dotfiles (default true) — filtered at render, not at fetch */
  showHidden?: boolean
}) {
  const [entries, setEntries] = useState<DirEntryInfo[] | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    fs.listDir(dir)
      .then(es => { if (live) { setEntries(es.filter(e => e.name !== '.git')); setErr(null) } })
      .catch(e => { if (live) setErr(e instanceof Error ? e.message : String(e)) })
    return () => { live = false }
  }, [dir, fs])

  // targeted refresh: keep the current listing on screen while re-fetching, and
  // skip entirely when the change batch didn't touch this directory
  useEffect(() => {
    if (refresh.tick === 0) return
    if (refresh.dirs && !refresh.dirs.has(dir)) return
    let live = true
    fs.listDir(dir)
      .then(es => { if (live) { setEntries(es.filter(e => e.name !== '.git')); setErr(null) } })
      .catch(e => { if (live) setErr(e instanceof Error ? e.message : String(e)) })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh])

  if (err) return <div style={{ padding: `3px 8px 3px ${14 + depth * 13}px`, fontSize: 11, color: 'var(--red-soft)' }}>{err}</div>
  if (!entries) return <div style={{ padding: `3px 8px 3px ${14 + depth * 13}px`, fontSize: 11, color: 'var(--faint)' }}>…</div>

  const creating = crud?.editing && crud.editing.kind !== 'rename' && crud.editing.dir === dir ? crud.editing : null
  const visible = showHidden ? entries : entries.filter(e => !e.name.startsWith('.'))

  return (
    <>
      {creating && (
        <TreeInputRow
          depth={depth}
          isDir={creating.kind === 'folder'}
          name={creating.kind === 'folder' ? 'new-folder' : 'new-file'}
          initial=""
          onCommit={crud!.commit}
          onCancel={crud!.cancel}
        />
      )}
      {visible.map(e => {
        const color = e.isDir
          ? (git?.dirs.has(e.path) ? 'var(--amber)' : null)
          : gitColor(git?.byPath.get(e.path))
        const isOpen = expanded.has(e.path)
        const isSel = selected === e.path
        const renaming = crud?.editing?.kind === 'rename' && crud.editing.path === e.path
        return (
          <div key={e.path}>
            {renaming ? (
              <TreeInputRow
                depth={depth}
                isDir={e.isDir}
                name={e.name}
                initial={e.name}
                selectStem={!e.isDir}
                onCommit={crud!.commit}
                onCancel={crud!.cancel}
              />
            ) : (
            <button
              className="palette-item"
              onClick={() => (e.isDir ? toggleDir(e.path) : openFile(e.path))}
              onContextMenu={onMenu ? ev => onMenu(ev, e.path, e.isDir) : undefined}
              style={{
                width: '100%', display: 'flex', alignItems: 'center', gap: 6, border: 'none',
                textAlign: 'left', padding: `3px 8px 3px ${8 + depth * 13}px`, borderRadius: 6,
                background: isSel ? 'var(--accent-soft)' : 'transparent',
                color: color ?? (isSel ? 'var(--text)' : 'var(--mut2)'),
                fontSize: 12.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}
              title={e.path}
            >
              <span style={{ width: 12, flexShrink: 0, fontSize: 8.5, color: 'var(--dim)' }}>
                {e.isDir ? (isOpen ? '▾' : '▸') : ''}
              </span>
              <FileIcon name={e.name} path={e.path} isDir={e.isDir} size={13} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{e.name}</span>
              {!e.isDir && color && <span style={{ marginLeft: 'auto', fontSize: 9.5, flexShrink: 0, color }}>●</span>}
              {!e.isDir && onAttachFile && (
                <span
                  role="button"
                  title="Attach to chat"
                  onClick={ev => { ev.stopPropagation(); onAttachFile(e.path) }}
                  style={{
                    marginLeft: color ? 4 : 'auto', flexShrink: 0, width: 18, height: 18, borderRadius: 5,
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    background: 'var(--accent-soft)', color: 'var(--accent)', fontSize: 12, fontWeight: 700,
                  }}
                >
                  +
                </span>
              )}
            </button>
            )}
            {e.isDir && isOpen && (
              <TreeLevel dir={e.path} depth={depth + 1} expanded={expanded} toggleDir={toggleDir} openFile={openFile} selected={selected} git={git} refresh={refresh} onAttachFile={onAttachFile} onMenu={onMenu} fs={fs} crud={crud} showHidden={showHidden} />
            )}
          </div>
        )
      })}
      {visible.length === 0 && (
        <div style={{ padding: `3px 8px 3px ${20 + depth * 13}px`, fontSize: 11, color: 'var(--faint)' }}>empty</div>
      )}
    </>
  )
}

// ---------------------------------------------------------------- context menu

interface TreeMenuState { x: number; y: number; path: string; isDir: boolean; local: boolean }

/** Right-click menu for tree rows: CRUD everywhere (local + ssh), with the
 *  native "open in Finder / app / VS Code" hand-offs appended for local files. */
function TreeContextMenu({ menu, onClose, crud }: { menu: TreeMenuState; onClose: () => void; crud: TreeCrud }) {
  const items: { label: string; mode: OpenPathMode }[] = menu.isDir
    ? [
        { label: 'Open in Finder', mode: 'default' },
        { label: 'Open in VS Code', mode: 'vscode' },
      ]
    : [
        { label: 'Open in default app', mode: 'default' },
        { label: 'Reveal in Finder', mode: 'reveal' },
        { label: 'Open in VS Code', mode: 'vscode' },
      ]
  return (
    <ContextMenu x={menu.x} y={menu.y} width={196} label={`File actions for ${menu.path}`} onClose={onClose}>
      {menu.isDir && (
        <>
          <button role="menuitem" className="context-menu-item" onClick={() => { crud.beginCreate(menu.path, 'file'); onClose() }}>
            New File…
          </button>
          <button role="menuitem" className="context-menu-item" onClick={() => { crud.beginCreate(menu.path, 'folder'); onClose() }}>
            New Folder…
          </button>
        </>
      )}
      <button role="menuitem" className="context-menu-item" onClick={() => { crud.beginRename(menu.path, menu.isDir); onClose() }}>
        Rename…
      </button>
      <button role="menuitem" className="context-menu-item" onClick={() => { crud.requestDelete(menu.path, menu.isDir); onClose() }}>
        Delete
      </button>
      {menu.local && (
        <>
          <div style={{ height: 1, background: 'var(--line)', margin: '4px 8px' }} />
          {items.map(it => (
            <button
              key={it.mode}
              role="menuitem"
              className="context-menu-item"
              onClick={() => { void openPath(menu.path, it.mode); onClose() }}
            >
              {it.label}
            </button>
          ))}
        </>
      )}
    </ContextMenu>
  )
}

// ---------------------------------------------------------------- tree CRUD

/** Explorer file operations (create / rename / delete) shared by FilesPane and
 *  FolderExplorer. Owns the inline-editing state and runs the ops through the
 *  session's fs adapter; the host supplies how to expand/refresh the tree and
 *  how to keep open tabs in sync (retarget on rename, close on delete). */
function useTreeOps({ fs, expandDirs, collapsePath, refreshDirs, onAfter, onDeletePath, onRenamePath, onCreatedFile }: {
  fs: SessionFs
  /** add dirs to the expanded set */
  expandDirs: (dirs: string[]) => void
  /** drop a path (and everything under it) from the expanded set */
  collapsePath: (path: string) => void
  /** targeted tree re-list for the touched directories */
  refreshDirs: (dirs: Set<string>) => void
  /** runs after every successful op (git status refresh) */
  onAfter?: () => void
  /** a path (file or dir) was deleted — close tabs at/under it */
  onDeletePath?: (path: string) => void
  /** a path was renamed — retarget tabs at/under it */
  onRenamePath?: (from: string, to: string, isDir: boolean) => void
  /** a new file was created — the host opens it (VSCode parity) */
  onCreatedFile?: (path: string) => void
}): { crud: TreeCrud; opErr: string | null; clearOpErr: () => void } {
  const [editing, setEditing] = useState<TreeEditing | null>(null)
  const [opErr, setOpErr] = useState<string | null>(null)

  const beginCreate = (dir: string, kind: 'file' | 'folder') => {
    setOpErr(null)
    expandDirs([dir]) // VSCode auto-expands the target so the input is visible
    setEditing({ kind, dir })
  }
  const beginRename = (path: string, isDir: boolean) => {
    setOpErr(null)
    setEditing({ kind: 'rename', path, isDir })
  }

  const commit = (raw: string) => {
    const ed = editing
    setEditing(null)
    const name = raw.trim().replace(/^\/+|\/+$/g, '')
    if (!ed || !name) return
    void (async () => {
      try {
        if (ed.kind === 'rename') {
          // rename is basename-only — it can never relocate the entry
          if (name.includes('/')) throw new Error('Rename takes a plain name — no slashes.')
          const dir = parentDir(ed.path)
          if (name === baseName(ed.path)) return
          const to = `${dir}/${name}`
          await fs.movePath(ed.path, to)
          onRenamePath?.(ed.path, to, ed.isDir)
          refreshDirs(new Set([dir]))
        } else {
          // slashes create nested paths (writeTextFile/createDir make parents)
          const target = `${ed.dir}/${name}`
          const chain: string[] = []
          let d = ed.dir
          for (const seg of name.split('/').slice(0, -1)) { d = `${d}/${seg}`; chain.push(d) }
          if (ed.kind === 'folder') {
            await fs.createDir(target)
          } else {
            await fs.writeTextFile(target, '')
            onCreatedFile?.(target)
          }
          if (chain.length) expandDirs(chain)
          refreshDirs(new Set([ed.dir, ...chain]))
        }
        onAfter?.()
      } catch (e) {
        setOpErr(e instanceof Error ? e.message : String(e))
      }
    })()
  }

  const requestDelete = (path: string, isDir: boolean) => {
    void confirmAction({
      title: `Delete ${baseName(path)} permanently?`,
      detail: isDir
        ? 'The folder and everything inside it will be deleted from disk. There is no trash — this cannot be undone.'
        : 'The file will be deleted from disk. There is no trash — this cannot be undone.',
      confirmLabel: 'Delete permanently',
    }).then(ok => {
      if (!ok) return
      void (async () => {
        try {
          await fs.deletePath(path)
          // the confirm above already covers any unsaved drafts in these tabs
          onDeletePath?.(path)
          collapsePath(path)
          refreshDirs(new Set([parentDir(path)]))
          onAfter?.()
        } catch (e) {
          setOpErr(e instanceof Error ? e.message : String(e))
        }
      })()
    })
  }

  return { crud: { editing, beginCreate, beginRename, requestDelete, commit, cancel: () => setEditing(null) }, opErr, clearOpErr: () => setOpErr(null) }
}

// ---------------------------------------------------------------- explorer chrome

const IC_NEW_FILE = ['M13 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V9z', 'M13 3v6h6', 'M12 13v5', 'M9.5 15.5h5']
const IC_NEW_FOLDER = ['M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z', 'M12 11v5', 'M9.5 13.5h5']
const IC_COLLAPSE = ['M7 11l5-5 5 5', 'M7 18l5-5 5 5']
const IC_REFRESH = ['M21 12a9 9 0 11-2.6-6.4', 'M21 4v5h-5']

const IC_EYE = ['M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z', 'M12 9.5a2.5 2.5 0 100 5 2.5 2.5 0 000-5z']
const IC_EYE_OFF = ['M4 4l16 16', 'M9.9 5.2A10.6 10.6 0 0112 5c6.5 0 10 7 10 7a17 17 0 01-3.2 3.9M6.1 6.9A16.7 16.7 0 002 12s3.5 7 10 7c1.2 0 2.3-.2 3.3-.6']

/** The EXPLORER header row with the VSCode-style action cluster. */
function ExplorerHeader({ root, refreshTitle, onNewFile, onNewFolder, onRefresh, onCollapseAll, showHidden, onToggleHidden }: {
  root: string
  refreshTitle: string
  onNewFile: () => void
  onNewFolder: () => void
  onRefresh: () => void
  onCollapseAll: () => void
  showHidden: boolean
  onToggleHidden: () => void
}) {
  const btn = { width: 22, height: 22, borderRadius: 5 } as const
  return (
    <div style={{
      height: 30, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 7, padding: '0 6px 0 10px',
      borderBottom: '1px solid var(--line)',
    }}>
      <span className="mono" style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: 0.6, color: 'var(--dim)' }}>EXPLORER</span>
      <span className="mono" style={{ fontSize: 10, color: 'var(--faint)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={root}>
        {root.slice(root.lastIndexOf('/') + 1) || root}
      </span>
      <div style={{ marginLeft: 'auto', display: 'flex', gap: 1, flexShrink: 0 }}>
        <button className="icon-btn" title="New File (slashes create nested folders)" onClick={onNewFile} style={btn}>
          <Icon paths={IC_NEW_FILE} size={12} stroke={1.7} />
        </button>
        <button className="icon-btn" title="New Folder" onClick={onNewFolder} style={btn}>
          <Icon paths={IC_NEW_FOLDER} size={12} stroke={1.7} />
        </button>
        <button className="icon-btn" title={showHidden ? 'Showing dotfiles — click to hide' : 'Dotfiles hidden — click to show'} onClick={onToggleHidden} style={{ ...btn, color: showHidden ? undefined : 'var(--accent)' }}>
          <Icon paths={showHidden ? IC_EYE : IC_EYE_OFF} size={12} stroke={1.6} />
        </button>
        <button className="icon-btn" title={refreshTitle} onClick={onRefresh} style={btn}>
          <Icon paths={IC_REFRESH} size={12} stroke={1.8} />
        </button>
        <button className="icon-btn" title="Collapse All" onClick={onCollapseAll} style={btn}>
          <Icon paths={IC_COLLAPSE} size={12} stroke={1.7} />
        </button>
      </div>
    </div>
  )
}

/** A failed tree op surfaces as a dismissible red line under the header. */
function TreeOpError({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div style={{
      flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6, padding: '5px 10px',
      fontSize: 11, color: 'var(--red-soft)', borderBottom: '1px solid var(--line)',
    }}>
      <span style={{ flex: 1, minWidth: 0 }}>{message}</span>
      <button className="icon-btn" title="Dismiss" onClick={onDismiss} style={{ width: 16, height: 16, borderRadius: 4, flexShrink: 0 }}>
        <Icon paths={IC.close} size={9} stroke={2} />
      </button>
    </div>
  )
}

// ---------------------------------------------------------------- quick open

// recursive file lists per pane — re-walking on every ⌘P would be wasteful,
// and never per keystroke; the overlay's refresh icon re-indexes on demand
const quickOpenCache = new Map<string, string[]>()

/** VSCode-style ⌘P overlay anchored to the top of the explorer column. */
function QuickOpen({ root, fs, cacheKey, onPick, onClose }: {
  root: string
  fs: SessionFs
  cacheKey: string
  onPick: (path: string) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [sel, setSel] = useState(0)
  const [files, setFiles] = useState<string[] | null>(quickOpenCache.get(cacheKey) ?? null)
  const [err, setErr] = useState<string | null>(null)
  const [indexing, setIndexing] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const reindex = useCallback(async () => {
    if (!fs.listFilesRecursive) { setErr('file search is unavailable for this session'); return }
    setIndexing(true)
    try {
      const list = await fs.listFilesRecursive(root)
      quickOpenCache.set(cacheKey, list)
      setFiles(list)
      setErr(null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setIndexing(false)
    }
  }, [fs, root, cacheKey])

  useEffect(() => {
    inputRef.current?.focus()
    if (files === null && !indexing) void reindex()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const matches = useMemo(() => filterPaths(query, files ?? []), [query, files])
  useEffect(() => setSel(0), [query])
  useEffect(() => {
    listRef.current?.querySelector(`[data-ix="${sel}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [sel])

  const pick = (rel: string | undefined) => {
    if (!rel) return
    onPick(`${root.replace(/\/+$/, '')}/${rel}`)
    onClose()
  }

  return (
    // mousedown is swallowed so clicks never blur the input (closing the
    // overlay); the click handlers themselves still fire
    <div
      onMouseDown={e => e.preventDefault()}
      style={{
        position: 'absolute', top: 34, left: 6, right: 6, zIndex: 30, overflow: 'hidden',
        background: 'var(--panel2)', border: '1px solid var(--line2)', borderRadius: 10,
        boxShadow: '0 14px 40px rgba(0,0,0,.5)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '5px 6px 5px 10px', borderBottom: '1px solid var(--line)' }}>
        <input
          ref={inputRef}
          value={query}
          placeholder="Go to file…"
          spellCheck={false}
          className="mono"
          onChange={e => setQuery(e.target.value)}
          onBlur={onClose}
          onKeyDown={e => {
            e.stopPropagation()
            if (e.key === 'ArrowDown') { e.preventDefault(); setSel(s => Math.min(s + 1, matches.length - 1)) }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(s => Math.max(s - 1, 0)) }
            else if (e.key === 'Enter') { e.preventDefault(); pick(matches[sel]) }
            else if (e.key === 'Escape') { e.preventDefault(); onClose() }
          }}
          style={{ flex: 1, minWidth: 0, background: 'transparent', border: 'none', outline: 'none', color: 'var(--text)', fontSize: 12 }}
        />
        <button className="icon-btn" title="Re-index files" onClick={() => void reindex()} style={{ width: 22, height: 22, borderRadius: 5, flexShrink: 0 }}>
          <Icon paths={IC_REFRESH} size={11} stroke={1.8} />
        </button>
      </div>
      <div ref={listRef} style={{ maxHeight: 280, overflowY: 'auto', padding: 4 }}>
        {err ? (
          <div style={{ padding: '8px 10px', fontSize: 11, color: 'var(--red-soft)' }}>{err}</div>
        ) : files === null ? (
          <div style={{ padding: '8px 10px', fontSize: 11, color: 'var(--faint)' }}>{indexing ? 'Indexing…' : '…'}</div>
        ) : matches.length === 0 ? (
          <div style={{ padding: '8px 10px', fontSize: 11, color: 'var(--faint)' }}>No matching files</div>
        ) : matches.map((rel, i) => {
          const name = baseName(rel)
          const dir = rel.slice(0, rel.length - name.length)
          return (
            <button
              key={rel}
              data-ix={i}
              className="palette-item"
              title={rel}
              onClick={() => pick(rel)}
              onMouseEnter={() => setSel(i)}
              style={{
                width: '100%', display: 'flex', alignItems: 'baseline', gap: 6, border: 'none',
                textAlign: 'left', padding: '4px 8px', borderRadius: 6, whiteSpace: 'nowrap', overflow: 'hidden',
                background: i === sel ? 'var(--accent-soft)' : 'transparent',
                color: i === sel ? 'var(--text)' : 'var(--mut)', fontSize: 12,
              }}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                <span style={{ color: i === sel ? 'var(--text)' : 'var(--text2)' }}>{name}</span>
                {dir && <span className="mono" style={{ fontSize: 10, color: 'var(--faint)' }}> {dir}</span>}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- tabs + breadcrumbs

/** VSCode-style tab strip: one tab per open file, dirty dots for drafts,
 *  middle-click or × closes. Duplicate basenames get a parent-dir prefix. */
function FileTabs({ tabs, active, drafts, onSelect, onClose }: {
  tabs: string[]
  active: string | null
  drafts: Record<string, string>
  onSelect: (path: string) => void
  onClose: (path: string) => void
}) {
  const names = tabs.map(baseName)
  return (
    <div style={{
      height: 32, flexShrink: 0, display: 'flex', alignItems: 'stretch', overflowX: 'auto',
      background: 'var(--bg2)', borderBottom: '1px solid var(--line)',
    }}>
      {tabs.map((t, i) => {
        const isActive = t === active
        const dirty = drafts[t] !== undefined
        // disambiguate shared basenames the way VSCode does (parent segment)
        const dup = names.indexOf(names[i]) !== i
        const dir = t.slice(0, t.lastIndexOf('/'))
        return (
          <div
            key={t}
            role="button"
            tabIndex={0}
            title={t}
            onClick={() => onSelect(t)}
            onAuxClick={e => { if (e.button === 1) onClose(t) }}
            onKeyDown={e => { if (e.key === 'Enter') onSelect(t) }}
            style={{
              display: 'flex', alignItems: 'center', gap: 6, padding: '0 7px 0 10px', flexShrink: 0,
              maxWidth: 210, cursor: 'pointer', fontSize: 12, whiteSpace: 'nowrap',
              background: isActive ? 'var(--bg3)' : 'transparent',
              color: isActive ? 'var(--text)' : 'var(--mut2)',
              borderRight: '1px solid var(--line)',
              boxShadow: isActive ? 'inset 0 -2px 0 var(--accent)' : 'none',
            }}
          >
            <FileIcon name={names[i]} path={t} isDir={false} size={13} />
            {dup && <span className="mono" style={{ fontSize: 10, color: 'var(--faint)', flexShrink: 0 }}>{baseName(dir)}/</span>}
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{names[i]}</span>
            {dirty && <span style={{ color: 'var(--amber)', fontSize: 9, flexShrink: 0 }} title="Unsaved changes">●</span>}
            <span
              role="button"
              title={dirty ? 'Close (discards unsaved changes)' : 'Close'}
              onClick={e => { e.stopPropagation(); onClose(t) }}
              style={{
                width: 16, height: 16, borderRadius: 4, flexShrink: 0,
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: 'var(--dim)',
              }}
            >
              <Icon paths={IC.close} size={10} stroke={2} />
            </span>
          </div>
        )
      })}
    </div>
  )
}

/** Static path breadcrumb for the active file, relative to the explorer root. */
function Breadcrumbs({ path, root }: { path: string; root: string }) {
  const rel = path.startsWith(root + '/') ? path.slice(root.length + 1) : path
  const segs = rel.split('/')
  return (
    <div
      className="mono"
      style={{
        height: 24, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 5, padding: '0 12px',
        fontSize: 10.5, color: 'var(--dim)', background: 'var(--bg3)', borderBottom: '1px solid var(--line)',
        overflow: 'hidden', whiteSpace: 'nowrap',
      }}
      title={path}
    >
      {segs.map((s, i) => (
        <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
          {i > 0 && <span style={{ color: 'var(--faint)' }}>›</span>}
          <span style={i === segs.length - 1 ? { color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis' } : undefined}>{s}</span>
        </span>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------- viewer

/** Load and display one file with syntax highlighting and optional diff gutter. */
function FileViewer({ path, gutter, onToggleGutter, onClose, git, onAttachFile, fs, bare, initialMode, draft, onModeChange, onDocChange, onDiscard }: {
  path: string
  gutter: 'numbers' | 'git'
  onToggleGutter: () => void
  onClose: () => void
  git: GitInfo | null
  onAttachFile?: (path: string) => void
  fs: SessionFs
  /** hosted under a tab strip + breadcrumbs that already show the file name —
   *  drop the header's own icon/name/close so it reads once, not three times */
  bare?: boolean
  /** the tab's remembered view/edit choice; absent = kind default (text → edit) */
  initialMode?: 'edit' | 'view'
  /** unsaved buffer restored when the tab remounts (takes precedence over disk) */
  draft?: string
  onModeChange?: (mode: 'edit' | 'view') => void
  /** editor buffer changed (host mirrors it into its per-tab drafts) */
  onDocChange?: (text: string, dirty: boolean) => void
  /** the editor's "Discard & close" dropped the unsaved buffer */
  onDiscard?: () => void
}) {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const kind = viewKind(name)
  const isMdFile = /\.(md|markdown|mdx)$/i.test(name)
  const isCsvFile = isCsv(name)
  const [content, setContent] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [marks, setMarks] = useState<{ added: Set<number>; modified: Set<number>; deletedAfter: Set<number> } | null>(null)
  const [mdView, setMdView] = useState<'rendered' | 'raw'>('rendered')
  // csv/tsv render as a table by default; 'raw' shows the plain source rows
  const [csvView, setCsvView] = useState<'table' | 'raw'>('table')
  const [dataUrl, setDataUrl] = useState<string | null>(null)
  // rich office render (docx html / workbook tables); null = extracted-text fallback
  const [office, setOffice] = useState<OfficeRender | null>(null)
  const [sheetIx, setSheetIx] = useState(0)
  // html files render live in a sandboxed iframe; 'source' shows/edits markup
  const [htmlView, setHtmlView] = useState<'rendered' | 'source'>('rendered')
  // opt-in: render the live page faithfully (external scripts, eval, network)
  // instead of the locked-down no-network CSP. Still sandboxed to an opaque
  // origin, so a trusted page still can't reach into the app.
  const [htmlTrusted, setHtmlTrusted] = useState(false)
  // bumped by the refresh button to remount the preview iframe (re-run scripts)
  const [reloadKey, setReloadKey] = useState(0)
  // custom-scheme URL the HTML preview loads from (Tauri only, so the page gets
  // its own policy container instead of inheriting the app CSP). null → not yet
  // stashed, or a browser build that falls back to srcDoc.
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  // text files open straight in the editor (VSCode-style); the toggle in the
  // header switches back to the read-only viewer. Mode is per-tab: the host
  // remembers the choice per path and hands it back via `initialMode`.
  // markdown and csv default to their rendered previews (view mode) — the
  // pencil opens the editor; every other text file opens straight into it
  const [editing, setEditingState] = useState(() => (initialMode ? initialMode === 'edit' : kind === 'text' && !isMdFile && !isCsvFile))
  const setEditing = (v: boolean) => { setEditingState(v); onModeChange?.(v ? 'edit' : 'view') }
  const editingRef = useRef(false)
  editingRef.current = editing
  const contentRef = useRef<string | null>(null)
  // detects a real path change inside the load effect (vs. a git-status-driven
  // reload of the same file, which must not reset the mode or scroll)
  const prevPathRef = useRef(path)
  // virtualized code view: track the scroll viewport so only visible rows render
  const scrollRef = useRef<HTMLDivElement>(null)
  const [view, setView] = useState({ top: 0, h: 0 })

  // in-file search (⌘F / the toolbar loupe) over the virtualized code view:
  // Enter / Shift+Enter step through matching lines, Esc closes
  const [findOpen, setFindOpen] = useState(false)
  const [findQ, setFindQ] = useState('')
  const [findIx, setFindIx] = useState(0)
  const findInputRef = useRef<HTMLInputElement>(null)

  const status = git?.byPath.get(path)
  const lang = langForFile(name)
  const isMd = isMdFile
  const rendered = isMd && mdView === 'rendered'
  const rel = git && path.startsWith(git.root + '/') ? path.slice(git.root.length + 1) : null

  // Read the selected file and its diff, ignoring stale async completions.
  const load = useCallback(async () => {
    // never clobber an open editor buffer — but the FIRST load must always go
    // through, since the editor needs the disk snapshot as its baseline
    if (editingRef.current && contentRef.current !== null) return
    try {
      if (kind === 'image' || kind === 'pdf' || kind === 'video' || kind === 'audio') {
        // rendered natively from a data URL; no diff/polling semantics
        const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
        const mime = kind === 'pdf' ? 'application/pdf' : IMG_MIME[ext] ?? MEDIA_MIME[ext]
        setDataUrl(`data:${mime};base64,${await fs.readFileB64(path)}`)
        setErr(null)
        return
      }
      if (kind === 'office') {
        // rich render first (docx → formatted HTML, workbooks → tables);
        // fall back to the dependency-free text extraction
        const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
        const bytes = b64ToBytes(await fs.readFileB64(path))
        try {
          if (ext === 'docx') { setOffice(await renderDocx(bytes)); setErr(null); return }
          if (ext === 'odt') { setOffice(await renderOdt(bytes)); setErr(null); return }
          if (ext === 'pptx') { setOffice(await renderPptx(bytes)); setErr(null); return }
          if (ext === 'odp') { setOffice(await renderOdp(bytes)); setErr(null); return }
          if (ext === 'xlsx' || ext === 'xls' || ext === 'ods') { setOffice(await renderWorkbook(bytes)); setErr(null); return }
        } catch { /* fall through to extracted text */ }
        setOffice(null)
        const extracted = await extractFileText(name, bytes)
        const text = extracted.text ?? '(no text extracted)'
        if (text !== contentRef.current) {
          contentRef.current = text
          setContent(text)
        }
        setErr(null)
        return
      }
      const text = await fs.readTextFile(path)
      if (text !== contentRef.current) {
        contentRef.current = text
        setContent(text)
      }
      setErr(null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      return
    }
    if (kind === 'text' && git && rel) {
      if (git.byPath.get(path) === '??') {
        // untracked: every line is new
        setMarks({ added: new Set([-1]), modified: new Set(), deletedAfter: new Set() })
      } else {
        try {
          setMarks(parseDiffLines(await fs.gitFileDiff(git.root, rel)))
        } catch {
          setMarks(null)
        }
      }
    } else {
      setMarks(null)
    }
  }, [path, git, rel, kind, name, fs])

  // load on open, then keep it fresh — the agent edits files while you watch.
  // Desktop app: a native fs watch drives reloads (event-driven, no timer). We
  // reload on any change under the workspace rather than string-matching the
  // path, because the watcher reports canonicalized paths that may not equal the
  // tree's — and re-reading one open file is cheap. Browser build: poll, since
  // watch events never fire there. Images/PDFs load once (no cheap change
  // detection over base64 payloads).
  useEffect(() => {
    const pathChanged = prevPathRef.current !== path
    prevPathRef.current = path
    contentRef.current = null
    setContent(null)
    setErr(null)
    setMarks(null)
    setDataUrl(null)
    setOffice(null)
    setSheetIx(0)
    setMdView('rendered')
    setHtmlView('rendered')
    setHtmlTrusted(false)
    // reset the mode only when a different file is opened in this same viewer
    // (no remount) — a same-file reload must never kick the user out of editing
    if (pathChanged) {
      setEditingState(kind === 'text' && !isMdFile && !isCsvFile)
      setCsvView('table')
      setFindOpen(false)
      setFindQ('')
      setFindIx(0)
    }
    void load()
    if (kind === 'image' || kind === 'pdf' || kind === 'video' || kind === 'audio') return
    if (isTauri) return onFsChange(() => void load())
    const iv = window.setInterval(() => void load(), 4000)
    return () => window.clearInterval(iv)
  }, [load, kind, path, isMdFile, isCsvFile])

  // Stash the rendered HTML on the backend and load it through the custom
  // scheme so it escapes the app's inherited CSP (Tauri only). Re-stashes when
  // the file, the trust toggle, or the manual reload changes; the browser build
  // keeps previewUrl null and falls back to srcDoc.
  useEffect(() => {
    if (!isTauri || kind !== 'html' || htmlView !== 'rendered' || editing || content === null) {
      setPreviewUrl(null)
      return
    }
    let alive = true
    let stashedId: string | null = null
    const doc = artifactSrcDoc({ kind: 'html', source: content }, { trusted: htmlTrusted })
    void previewStash(doc).then(res => {
      if (!res) return
      if (!alive) { void previewClear(res.id); return }
      stashedId = res.id
      setPreviewUrl(res.url)
    })
    return () => { alive = false; if (stashedId) void previewClear(stashedId) }
  }, [kind, htmlView, editing, content, htmlTrusted, reloadKey])

  const allLines = (content ?? '').split('\n')
  const truncated = allLines.length > MAX_LINES
  const lines = truncated ? allLines.slice(0, MAX_LINES) : allLines
  const untracked = !!marks?.added.has(-1)
  const changed = (marks?.added.size ?? 0) + (marks?.modified.size ?? 0) > 0 || untracked

  // Resolve one source line's added, modified, or deletion-adjacent marker.
  const gutterFor = (n: number): { color: string | null; label: string } => {
    if (!marks) return { color: null, label: '' }
    if (untracked || marks.added.has(n)) return { color: 'var(--green)', label: 'new' }
    if (marks.modified.has(n)) return { color: 'var(--amber)', label: 'changed' }
    if (marks.deletedAfter.has(n)) return { color: 'var(--red-soft)', label: 'lines deleted after this' }
    return { color: null, label: '' }
  }

  // Windowed range: render only the rows in view (plus overscan) so a large file
  // costs a constant amount of DOM and highlighting regardless of length. Spacers
  // above/below reserve the full scroll height at the fixed ROW_H.
  const first = Math.max(0, Math.floor(view.top / ROW_H) - OVERSCAN)
  const last = Math.min(lines.length, Math.ceil((view.top + (view.h || 600)) / ROW_H) + OVERSCAN)

  // csv table preview: parsed rows, capped so a huge export can't flood the DOM
  const csvTable = useMemo(() => {
    if (!isCsvFile || csvView !== 'table' || editing || content === null) return null
    const rows = parseCsv(content, /\.tsv$/i.test(name) ? '\t' : ',')
    return { rows: rows.slice(0, 2001), truncated: rows.length > 2001, total: rows.length }
  }, [isCsvFile, csvView, editing, content, name])

  // true when the virtualized code view is what's on screen (the only surface
  // the find bar can search and mark)
  const codeView = !err && content !== null && !editing && !rendered
    && kind !== 'image' && kind !== 'pdf' && kind !== 'video' && kind !== 'audio'
    && !(kind === 'office' && office) && !(kind === 'html' && htmlView === 'rendered')
    && !csvTable

  const findMatches = useMemo(() => {
    if (!findOpen || !findQ) return { lines: [] as number[], total: 0 }
    const q = findQ.toLowerCase()
    const arr = (content ?? '').split('\n')
    const ls: number[] = []
    let total = 0
    for (let i = 0; i < Math.min(arr.length, MAX_LINES); i++) {
      let ix = arr[i].toLowerCase().indexOf(q)
      if (ix < 0) continue
      ls.push(i)
      while (ix >= 0) { total++; ix = arr[i].toLowerCase().indexOf(q, ix + q.length) }
    }
    return { lines: ls, total }
  }, [content, findQ, findOpen])
  const curFindLine = findMatches.lines.length
    ? findMatches.lines[Math.min(findIx, findMatches.lines.length - 1)]
    : -1

  const stepFind = (dir: 1 | -1) => {
    const n = findMatches.lines.length
    if (n) setFindIx(ix => (Math.min(ix, n - 1) + dir + n) % n)
  }

  // center the current match in the viewport
  useEffect(() => {
    if (!findOpen || curFindLine < 0) return
    const el = scrollRef.current
    if (el) el.scrollTop = Math.max(0, curFindLine * ROW_H - el.clientHeight / 2)
  }, [findIx, curFindLine, findOpen])

  useEffect(() => {
    if (findOpen) { findInputRef.current?.focus(); findInputRef.current?.select() }
  }, [findOpen])

  // Track the viewport height (for the window size) and reset scroll to the top
  // when a different file is opened — but not on same-file reloads, so watching
  // an edited file doesn't yank the reader back to line 1.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const measure = () => setView(v => (v.h === el.clientHeight ? v : { ...v, h: el.clientHeight }))
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    measure()
    return () => ro.disconnect()
  }, [content, rendered, err, kind])
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0
    setView(v => ({ ...v, top: 0 }))
  }, [path])

  return (
    <div
      style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg3)' }}
      onKeyDown={e => {
        if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'f' && codeView) {
          e.preventDefault()
          setFindOpen(true)
          findInputRef.current?.focus()
          findInputRef.current?.select()
        }
      }}
    >
      <div style={{
        height: 34, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8, padding: '0 10px',
        background: 'var(--panel)', borderBottom: '1px solid var(--line)',
      }}>
        {!bare && (
          <>
            <FileIcon name={name} path={path} isDir={false} size={14} />
            <span className="mono" style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={path}>
              {rel ?? name}
            </span>
          </>
        )}
        {status && (
          <span className="mono" style={{
            fontSize: 9.5, fontWeight: 700, padding: '1px 6px', borderRadius: 4, flexShrink: 0,
            color: gitColor(status) ?? 'var(--mut)', border: `1px solid ${gitColor(status) ?? 'var(--line2)'}`,
          }}>
            {status === '??' ? 'NEW' : status}
          </span>
        )}
        {content !== null && <span className="mono" style={{ fontSize: 10, color: 'var(--faint)', flexShrink: 0 }}>{allLines.length} lines{kind === 'office' ? ' · extracted text' : ''}</span>}
        <div style={{ flex: 1 }} />
        {onAttachFile && (
          <button
            className="open-btn"
            title="Attach this file to the chat"
            onClick={() => onAttachFile(path)}
            style={{ padding: '4px 10px', fontSize: 11, flexShrink: 0 }}
          >
            ＋ Add to chat
          </button>
        )}
        {isCsvFile && !editing && (
          <button
            className="icon-btn"
            title={csvView === 'table' ? 'Table preview — click for the raw source' : 'Raw source — click for the table preview'}
            onClick={() => setCsvView(v => (v === 'table' ? 'raw' : 'table'))}
            style={{ width: 26, height: 26, borderRadius: 6, color: csvView === 'table' ? 'var(--accent)' : undefined }}
          >
            <Icon paths={['M4 5h16v14H4z', 'M4 10h16', 'M10 5v14', 'M16 5v14']} size={14} stroke={1.6} />
          </button>
        )}
        {isMd && (
          <button
            className="icon-btn"
            title={rendered ? 'Rendered markdown — click for raw source' : 'Raw source — click for rendered markdown'}
            onClick={() => setMdView(v => (v === 'rendered' ? 'raw' : 'rendered'))}
            style={{ width: 26, height: 26, borderRadius: 6, color: rendered ? 'var(--accent)' : undefined }}
          >
            <span className="mono" style={{ fontSize: 10, fontWeight: 700 }}>M↓</span>
          </button>
        )}
        {kind === 'html' && htmlView === 'rendered' && !editing && (
          <>
            <button
              className="icon-btn"
              title="Reload the preview (re-runs the page's scripts)"
              onClick={() => { setReloadKey(k => k + 1); void load() }}
              style={{ width: 26, height: 26, borderRadius: 6 }}
            >
              <Icon paths={['M20 11a8 8 0 10-.6 3', 'M20 4v5h-5']} size={14} stroke={1.7} />
            </button>
            <button
              className="icon-btn"
              title={htmlTrusted
                ? 'Network + full JavaScript ENABLED — click to lock down (no network, inline scripts only)'
                : 'Locked down (no network, inline scripts only) — click to allow network + full JavaScript'}
              onClick={() => { setHtmlTrusted(v => !v); setReloadKey(k => k + 1) }}
              style={{ width: 26, height: 26, borderRadius: 6, color: htmlTrusted ? 'var(--accent)' : undefined }}
            >
              <Icon paths={htmlTrusted
                ? ['M12 2a10 10 0 100 20 10 10 0 000-20z', 'M2 12h20', 'M12 2a15 15 0 010 20', 'M12 2a15 15 0 000 20']
                : ['M6 10V8a6 6 0 0111.6-2', 'M5 10h14v10H5z']} size={14} stroke={1.7} />
            </button>
          </>
        )}
        {kind === 'html' && !editing && (
          <button
            className="icon-btn"
            title={htmlView === 'rendered' ? 'Live page (sandboxed) — click for the markup' : 'Markup — click for the live page'}
            onClick={() => setHtmlView(v => (v === 'rendered' ? 'source' : 'rendered'))}
            style={{ width: 26, height: 26, borderRadius: 6, color: htmlView === 'rendered' ? 'var(--accent)' : undefined }}
          >
            <Icon paths={['M4 5h16v14H4z', 'M4 9h16', 'M7 7h.01']} size={14} stroke={1.7} />
          </button>
        )}
        {(kind === 'text' || kind === 'html') && content !== null && !editing && (
          <button
            className="icon-btn"
            title="Edit this file (⌘S saves in place — local or over SSH)"
            onClick={() => { setHtmlView('source'); setEditing(true) }}
            style={{ width: 26, height: 26, borderRadius: 6 }}
          >
            <Icon paths={['M12 20h9', 'M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z']} size={13} stroke={1.7} />
          </button>
        )}
        {codeView && (
          <button
            className="icon-btn"
            title="Find in file (⌘F)"
            onClick={() => setFindOpen(v => !v)}
            style={{ width: 26, height: 26, borderRadius: 6, color: findOpen ? 'var(--accent)' : undefined }}
          >
            <Icon paths={['M11 4a7 7 0 100 14 7 7 0 000-14z', 'M21 21l-4.8-4.8']} size={13} stroke={1.8} />
          </button>
        )}
        <button
          className="icon-btn"
          title={gutter === 'numbers' ? 'Gutter: line numbers — click for git change markers' : 'Gutter: git change markers — click for line numbers'}
          onClick={onToggleGutter}
          style={{ width: 26, height: 26, borderRadius: 6, color: gutter === 'git' ? 'var(--accent)' : undefined }}
        >
          {gutter === 'git'
            ? <Icon paths={['M6 3v12', 'M6 15a3 3 0 103 3', 'M18 9a3 3 0 10-3-3', 'M6 21v0']} size={14} stroke={1.7} />
            : <span className="mono" style={{ fontSize: 12, fontWeight: 700 }}>#</span>}
        </button>
        {!bare && (
          <button className="icon-btn" title="Close file" onClick={onClose} style={{ width: 26, height: 26, borderRadius: 6 }}>
            <Icon paths={IC.close} size={13} stroke={1.8} />
          </button>
        )}
      </div>

      {findOpen && codeView && (
        <div style={{
          height: 30, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 7, padding: '0 10px',
          background: 'var(--panel2)', borderBottom: '1px solid var(--line)',
        }}>
          <Icon paths={['M11 4a7 7 0 100 14 7 7 0 000-14z', 'M21 21l-4.8-4.8']} size={11} stroke={1.8} />
          <input
            ref={findInputRef}
            className="mono"
            value={findQ}
            placeholder="Find in file…"
            spellCheck={false}
            onChange={e => { setFindQ(e.target.value); setFindIx(0) }}
            onKeyDown={e => {
              e.stopPropagation()
              if (e.key === 'Enter') { e.preventDefault(); stepFind(e.shiftKey ? -1 : 1) }
              else if (e.key === 'Escape') { e.preventDefault(); setFindOpen(false) }
            }}
            style={{ flex: 1, minWidth: 0, background: 'transparent', border: 'none', outline: 'none', color: 'var(--text)', fontSize: 12 }}
          />
          <span className="mono" style={{ flexShrink: 0, fontSize: 10.5, color: findQ && !findMatches.total ? 'var(--red-soft)' : 'var(--dim)' }}>
            {findQ
              ? findMatches.total
                ? `${findMatches.total} match${findMatches.total === 1 ? '' : 'es'} · line ${Math.min(findIx, findMatches.lines.length - 1) + 1}/${findMatches.lines.length}`
                : 'no matches'
              : ''}
          </span>
          <button className="icon-btn" title="Previous match (Shift+Enter)" onClick={() => stepFind(-1)} style={{ width: 22, height: 22, borderRadius: 5, flexShrink: 0 }}>
            <Icon paths={['M6 14l6-6 6 6']} size={11} stroke={1.8} />
          </button>
          <button className="icon-btn" title="Next match (Enter)" onClick={() => stepFind(1)} style={{ width: 22, height: 22, borderRadius: 5, flexShrink: 0 }}>
            <Icon paths={['M6 10l6 6 6-6']} size={11} stroke={1.8} />
          </button>
          <button className="icon-btn" title="Close find (Esc)" onClick={() => setFindOpen(false)} style={{ width: 22, height: 22, borderRadius: 5, flexShrink: 0 }}>
            <Icon paths={IC.close} size={10} stroke={2} />
          </button>
        </div>
      )}

      {err ? (
        <div style={{ padding: 18, fontSize: 12, color: 'var(--red-soft)' }}>
          Can't display this file — {err.includes('stream did not contain valid UTF-8') ? 'it is binary or not UTF-8 text.' : err}
        </div>
      ) : editing && content !== null ? (
        <CodeEditor
          path={path}
          initial={draft ?? content}
          baseline={content}
          onSave={async text => {
            await fs.writeTextFile(path, text)
            contentRef.current = text
            setContent(text)
          }}
          onDocChange={onDocChange}
          onClose={() => { onDiscard?.(); setEditing(false); void load() }}
        />
      ) : kind === 'office' && office ? (
        office.kind === 'docx' ? (
          <iframe
            title={name}
            sandbox=""
            srcDoc={artifactSrcDoc({
              kind: 'html',
              source: `<meta charset="utf-8"><style>body{font-family:system-ui,sans-serif;max-width:760px;margin:24px auto;padding:0 20px;line-height:1.6;color:#1c1f26;background:#fff}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px 8px}img{max-width:100%}</style>${office.html ?? ''}`,
            })}
            style={{ flex: 1, width: '100%', minHeight: 0, border: 'none', background: '#fff' }}
          />
        ) : office.kind === 'slides' ? (
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            {(office.slides?.length ?? 0) > 1 && (
              <div style={{ display: 'flex', gap: 2, padding: '6px 10px 0', flexShrink: 0, overflowX: 'auto' }}>
                {office.slides!.map((sl, i) => (
                  <button
                    key={i}
                    onClick={() => setSheetIx(i)}
                    title={sl.title ?? `Slide ${i + 1}`}
                    style={{
                      border: '1px solid var(--line2)', borderRadius: 7, padding: '3px 10px', fontSize: 11, fontWeight: 600,
                      cursor: 'pointer', whiteSpace: 'nowrap',
                      background: sheetIx === i ? 'var(--panel2)' : 'transparent',
                      color: sheetIx === i ? 'var(--accent)' : 'var(--mut)',
                    }}
                  >
                    {i + 1}
                  </button>
                ))}
              </div>
            )}
            <div style={{ flex: 1, minHeight: 0, overflow: 'auto', display: 'flex', justifyContent: 'center', padding: 16 }}>
              <div
                className="slide-html"
                dangerouslySetInnerHTML={{ __html: office.slides?.[sheetIx]?.html ?? '<div>empty presentation</div>' }}
              />
            </div>
          </div>
        ) : (
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            {(office.sheets?.length ?? 0) > 1 && (
              <div style={{ display: 'flex', gap: 2, padding: '6px 10px 0', flexShrink: 0, overflowX: 'auto' }}>
                {office.sheets!.map((sh, i) => (
                  <button
                    key={sh.name}
                    onClick={() => setSheetIx(i)}
                    style={{
                      border: '1px solid var(--line2)', borderRadius: 7, padding: '3px 10px', fontSize: 11, fontWeight: 600,
                      cursor: 'pointer', whiteSpace: 'nowrap',
                      background: sheetIx === i ? 'var(--panel2)' : 'transparent',
                      color: sheetIx === i ? 'var(--accent)' : 'var(--mut)',
                    }}
                  >
                    {sh.name}
                  </button>
                ))}
              </div>
            )}
            <div
              className="sheet-html"
              style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 12 }}
              dangerouslySetInnerHTML={{ __html: office.sheets?.[sheetIx]?.html ?? '<div>empty workbook</div>' }}
            />
          </div>
        )
      ) : kind === 'html' && htmlView === 'rendered' ? (
        content !== null ? (
          // Isolation boundary: the preview loads from a distinct scheme origin
          // (Tauri) or an opaque srcdoc origin (browser) and is sandboxed, so it
          // can never reach into the app. `htmlTrusted` drops the no-network CSP
          // (external scripts + network, opt-in per file) and, on its own scheme
          // origin, grants same-origin so storage-using pages work.
          isTauri ? (
            previewUrl ? (
              <iframe
                key={previewUrl}
                title={name}
                sandbox={htmlTrusted ? 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals' : 'allow-scripts'}
                src={previewUrl}
                style={{ flex: 1, width: '100%', minHeight: 0, border: 'none', background: '#fff' }}
              />
            ) : <div style={{ padding: 18, fontSize: 12, color: 'var(--dim)' }}>Loading…</div>
          ) : (
            <iframe key={`${reloadKey}-${htmlTrusted}`} title={name} sandbox="allow-scripts" srcDoc={artifactSrcDoc({ kind: 'html', source: content }, { trusted: htmlTrusted })} style={{ flex: 1, width: '100%', minHeight: 0, border: 'none', background: '#fff' }} />
          )
        ) : <div style={{ padding: 18, fontSize: 12, color: 'var(--dim)' }}>Loading…</div>
      ) : kind === 'image' ? (
        dataUrl ? (
          <div style={{ flex: 1, minHeight: 0, overflow: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
            <img src={dataUrl} alt={name} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', borderRadius: 6 }} />
          </div>
        ) : <div style={{ padding: 18, fontSize: 12, color: 'var(--dim)' }}>Loading…</div>
      ) : kind === 'pdf' ? (
        dataUrl ? (
          <embed src={dataUrl} type="application/pdf" style={{ flex: 1, width: '100%', minHeight: 0 }} />
        ) : <div style={{ padding: 18, fontSize: 12, color: 'var(--dim)' }}>Loading…</div>
      ) : kind === 'video' ? (
        dataUrl ? (
          <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, background: '#000' }}>
            <video src={dataUrl} controls style={{ maxWidth: '100%', maxHeight: '100%', borderRadius: 6 }} />
          </div>
        ) : <div style={{ padding: 18, fontSize: 12, color: 'var(--dim)' }}>Loading…</div>
      ) : kind === 'audio' ? (
        dataUrl ? (
          <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
            <audio src={dataUrl} controls style={{ width: '100%', maxWidth: 480 }} />
          </div>
        ) : <div style={{ padding: 18, fontSize: 12, color: 'var(--dim)' }}>Loading…</div>
      ) : csvTable ? (
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
          <table className="mono" style={{ borderCollapse: 'collapse', fontSize: 11.5, margin: 10 }}>
            <thead>
              <tr>
                {(csvTable.rows[0] ?? []).map((h, i) => (
                  <th key={i} style={{
                    position: 'sticky', top: 0, zIndex: 1, textAlign: 'left', padding: '5px 10px',
                    background: 'var(--panel2)', color: 'var(--text)', fontWeight: 700,
                    borderBottom: '2px solid var(--line2)', whiteSpace: 'nowrap',
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {csvTable.rows.slice(1).map((r, i) => (
                <tr key={i} style={{ background: i % 2 ? 'var(--bg2)' : 'transparent' }}>
                  {r.map((c, j) => (
                    <td key={j} style={{ padding: '3px 10px', color: 'var(--text2)', borderBottom: '1px solid var(--line-soft)', whiteSpace: 'nowrap', maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis' }} title={c}>{c}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {csvTable.truncated && (
            <div style={{ padding: '4px 12px 12px', fontSize: 11.5, color: 'var(--amber)' }}>
              Showing the first 2,000 of {csvTable.total.toLocaleString()} rows — switch to raw for the rest.
            </div>
          )}
        </div>
      ) : content === null ? (
        <div style={{ padding: 18, fontSize: 12, color: 'var(--dim)' }}>Loading…</div>
      ) : rendered ? (
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
          <div style={{
            maxWidth: 760, padding: '18px 24px', fontSize: 13, lineHeight: 1.65, color: 'var(--text2)',
            fontFamily: 'var(--font-sans)',
          }}>
            <Markdown text={content} />
          </div>
        </div>
      ) : (
        <div
          ref={scrollRef}
          tabIndex={0}
          onScroll={e => setView({ top: e.currentTarget.scrollTop, h: e.currentTarget.clientHeight })}
          style={{ flex: 1, minHeight: 0, overflow: 'auto', outline: 'none' }}
        >
          <div style={{ display: 'inline-block', minWidth: '100%' }}>
            {/* spacer reserving the height of the rows scrolled off the top */}
            <div style={{ height: first * ROW_H }} />
            {lines.slice(first, last).map((line, i) => {
              const n = first + i + 1
              const g = gutterFor(n)
              const matched = findOpen && !!findQ && line.toLowerCase().includes(findQ.toLowerCase())
              const isCur = matched && curFindLine === n - 1
              const html = highlight(line, lang) || '&nbsp;'
              const gitBg = gutter === 'git' && g.color ? `${g.color === 'var(--green)' ? 'rgba(96,211,148,.05)' : g.color === 'var(--amber)' ? 'rgba(255,176,32,.05)' : 'transparent'}` : 'transparent'
              return (
                <div key={n} style={{ display: 'flex', height: ROW_H, background: isCur ? 'var(--accent-faint)' : gitBg }}>
                  <span
                    className="mono"
                    title={gutter === 'git' ? g.label : undefined}
                    style={{
                      width: 50, flexShrink: 0, textAlign: 'right', paddingRight: 8, userSelect: 'none',
                      fontSize: 11, lineHeight: `${ROW_H}px`, background: 'var(--bg2)',
                      borderRight: `2px solid ${gutter === 'git' && g.color ? g.color : 'var(--line-soft)'}`,
                      color: gutter === 'git' ? (g.color ?? 'var(--faint)') : 'var(--faint)',
                      fontWeight: gutter === 'git' && g.color ? 700 : 400,
                    }}
                  >
                    {n}
                  </span>
                  <span
                    className="mono"
                    style={{ padding: '0 14px', fontSize: 12, lineHeight: `${ROW_H}px`, whiteSpace: 'pre', color: 'var(--text2)', userSelect: 'text' }}
                    dangerouslySetInnerHTML={{ __html: matched ? markMatches(html, findQ, isCur) : html }}
                  />
                </div>
              )
            })}
            {/* spacer reserving the height of the rows below the viewport */}
            <div style={{ height: Math.max(0, lines.length - last) * ROW_H }} />
            {truncated && (
              <div style={{ padding: '8px 14px', fontSize: 11.5, color: 'var(--amber)' }}>
                Showing the first {MAX_LINES.toLocaleString()} of {allLines.length.toLocaleString()} lines.
              </div>
            )}
          </div>
        </div>
      )}

      {gutter === 'git' && !err && content !== null && kind === 'text' && (
        <div className="mono" style={{
          height: 24, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 14, padding: '0 12px',
          background: 'var(--panel)', borderTop: '1px solid var(--line)', fontSize: 10, color: 'var(--dim)',
        }}>
          <span><span style={{ color: 'var(--green)' }}>●</span> new</span>
          <span><span style={{ color: 'var(--amber)' }}>●</span> changed</span>
          <span><span style={{ color: 'var(--red-soft)' }}>●</span> deletion below</span>
          {!git && <span style={{ marginLeft: 'auto', color: 'var(--faint)' }}>not a git repository</span>}
          {git && !changed && <span style={{ marginLeft: 'auto', color: 'var(--faint)' }}>no uncommitted changes in this file</span>}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- pane

/** Manage a session-scoped filesystem tree, selected file, and git metadata. */
export function FilesPane({ agent }: { agent: Agent }) {
  const init = cached(agent.id)
  const [file, setFile] = useState<string | null>(init.file)
  const [gutter, setGutter] = useState<'numbers' | 'git'>(init.gutter)
  const [expanded, setExpanded] = useState<Set<string>>(new Set(init.expanded))
  const [tabs, setTabs] = useState<string[]>(init.tabs)
  const [drafts, setDrafts] = useState<Record<string, string>>(init.drafts)
  const [modes, setModes] = useState<Record<string, 'edit' | 'view'>>(init.modes)
  const [showHidden, setShowHidden] = useState(init.showHidden ?? true)
  const [git, setGit] = useState<GitInfo | null>(null)
  const [refresh, setRefresh] = useState<TreeRefresh>({ tick: 0, dirs: null })
  // explorer/viewer split — fixed default width until first dragged
  const [treeShare, setTreeShare] = useState<number | null>(explorerSplitCache.get(agent.id) ?? null)
  const root = agent.cwd || '~'
  // machine sessions browse the remote host over ssh (using the session's own
  // connection snapshot); local sessions use native fs. `root` scopes the
  // local adapter's mutating ops (create/move/delete).
  const fs = useMemo(() => sessionFs(agent.machine, agent.id, root), [agent.machine, agent.id, root])
  // chat hosts: files can be attached to the conversation with one click —
  // the ChatPane below subscribes on the attach bus and chips the file
  const attachToChat = agent.kind === 'chat' ? (path: string) => { requestAttach(agent.id, path) } : undefined
  // right-click → CRUD everywhere; the native open entries are local-only
  // (remote paths live on another host, and a browser build has no OS opener)
  const [menu, setMenu] = useState<TreeMenuState | null>(null)
  const onTreeMenu = isTauri
    ? (ev: React.MouseEvent, path: string, isDir: boolean) => {
        ev.preventDefault()
        setMenu({ x: ev.clientX, y: ev.clientY, path, isDir, local: !agent.machine })
      }
    : undefined

  // persist UI state across remounts
  useEffect(() => {
    stateCache.set(agent.id, { file, gutter, expanded: [...expanded], tabs, drafts, modes, showHidden })
  }, [agent.id, file, gutter, expanded, tabs, drafts, modes, showHidden])

  // open a file in a tab (append once, then activate)
  const openFile = useCallback((path: string) => {
    setTabs(prev => (prev.includes(path) ? prev : [...prev, path]))
    setFile(path)
  }, [])

  // mirror the editor's buffer into per-tab drafts (dirty dot + remount restore)
  const handleDocChange = (path: string, text: string, dirty: boolean) => {
    setDrafts(prev => {
      if (dirty) return prev[path] === text ? prev : { ...prev, [path]: text }
      if (!(path in prev)) return prev
      const next = { ...prev }
      delete next[path]
      return next
    })
  }

  const clearDraft = (path: string) => {
    setDrafts(prev => {
      if (!(path in prev)) return prev
      const next = { ...prev }
      delete next[path]
      return next
    })
  }

  // close a tab; an unsaved draft asks first (discard keeps the file on disk
  // as-is and just drops the buffer). Closing the active tab activates the
  // neighbor; closing the last one returns to the empty state.
  const closeTab = (path: string) => {
    const doClose = () => {
      clearDraft(path)
      const ix = tabs.indexOf(path)
      const next = tabs.filter(p => p !== path)
      setTabs(next)
      if (file === path) setFile(next[Math.min(ix, next.length - 1)] ?? null)
    }
    if (drafts[path] === undefined) { doClose(); return }
    void confirmAction({
      title: `Discard unsaved changes to ${baseName(path)}?`,
      detail: 'This tab has edits that were never saved. Closing it drops the changes; the file on disk stays as it was.',
      confirmLabel: 'Discard & close',
    }).then(ok => { if (ok) doClose() })
  }

  // terminal ctrl/cmd+click on a path lands here (path already cwd-resolved)
  useEffect(() => onOpenFileRequest(agent.id, openFile), [agent.id, openFile])

  // Refresh repository status and rebuild the path-to-status lookup.
  const refreshGit = useCallback(() => {
    fs.gitStatus(root)
      .then(res => {
        const byPath = new Map<string, string>()
        const dirs = new Set<string>()
        for (const f of res.files) {
          const abs = `${res.root}/${f.path}`
          byPath.set(abs, f.status)
          let d = abs
          while (d.includes('/') && d.length > res.root.length) {
            d = d.slice(0, d.lastIndexOf('/'))
            dirs.add(d)
          }
        }
        setGit({ root: res.root, byPath, dirs })
      })
      .catch(() => setGit(null))
  }, [root, fs])

  // Desktop app: a native recursive watch on the workspace root drives tree +
  // git refresh (Rust coalesces bursts), so no fixed-interval polling. Browser
  // build: fall back to a periodic refresh since watch events never fire there.
  useEffect(() => {
    refreshGit()
    // native fs watch is local-only; a remote (ssh) session can't receive
    // change events, so it falls back to the periodic refresh below
    if (isTauri && !fs.remote) {
      // the fs-change stream is shared by every watched root — remember our
      // canonical key so other sessions' churn doesn't refresh this pane
      let key: string | null = null
      void watchDir(root).then(k => { key = k })
      const off = onFsChange(e => {
        if (key !== null && e.root !== key) return
        // re-list only the directories the batch actually touched
        const dirs = new Set(e.paths.map(p => p.slice(0, p.lastIndexOf('/'))).filter(Boolean))
        setRefresh(r => ({ tick: r.tick + 1, dirs: dirs.size ? dirs : null }))
        refreshGit()
      })
      return () => { off(); void unwatchDir(root) }
    }
    const iv = window.setInterval(() => { setRefresh(r => ({ tick: r.tick + 1, dirs: null })); refreshGit() }, 6000)
    return () => window.clearInterval(iv)
  }, [refreshGit, root, fs])

  // Expand a cached directory or lazily request its children before expanding.
  const toggleDir = (path: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  // ⌘P quick-open overlay (file fuzzy search, anchored to the explorer)
  const [quickOpen, setQuickOpen] = useState(false)

  // close every tab at/under a deleted path — drafts included, no extra
  // confirm (the permanent-delete dialog already covered them)
  const closeTabsUnder = (target: string) => {
    const match = (p: string) => p === target || p.startsWith(target + '/')
    const next = tabs.filter(p => !match(p))
    if (next.length === tabs.length) return
    setTabs(next)
    setDrafts(prev => remapKeys(prev, p => (match(p) ? '' : p), true))
    setModes(prev => remapKeys(prev, p => (match(p) ? '' : p), true))
    if (file && match(file)) setFile(next[next.length - 1] ?? null)
  }

  // retarget tabs/drafts/modes/expanded after a rename (dirs take their subtree)
  const retargetRenamed = (from: string, to: string, isDir: boolean) => {
    const remap = (p: string) => p === from ? to : (isDir && p.startsWith(from + '/') ? to + p.slice(from.length) : p)
    setTabs(prev => prev.map(remap))
    setDrafts(prev => remapKeys(prev, remap))
    setModes(prev => remapKeys(prev, remap))
    setExpanded(prev => new Set([...prev].map(remap)))
    if (file) setFile(remap(file))
  }

  const { crud, opErr, clearOpErr } = useTreeOps({
    fs,
    expandDirs: dirs => setExpanded(prev => {
      const next = new Set(prev)
      for (const d of dirs) next.add(d)
      return next
    }),
    collapsePath: path => setExpanded(prev => {
      const next = new Set<string>()
      for (const p of prev) if (p !== path && !p.startsWith(path + '/')) next.add(p)
      return next.size === prev.size ? prev : next
    }),
    refreshDirs: dirs => setRefresh(r => ({ tick: r.tick + 1, dirs })),
    onAfter: refreshGit,
    onDeletePath: closeTabsUnder,
    onRenamePath: retargetRenamed,
    onCreatedFile: openFile,
  })

  return (
    <div
      style={{ flex: 1, minHeight: 0, display: 'flex' }}
      onKeyDown={e => {
        if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return
        const key = e.key.toLowerCase()
        // ⌘W / Ctrl+W closes the active tab while the pane has focus
        if (key === 'w' && file) {
          e.preventDefault()
          closeTab(file)
        }
        // ⌘P / Ctrl+P opens the file fuzzy-search overlay
        else if (key === 'p') {
          e.preventDefault()
          setQuickOpen(true)
        }
      }}
    >
      <div style={{
        ...(treeShare != null
          ? { flexBasis: `${treeShare * 100}%`, flexGrow: 0, flexShrink: 1 }
          : { width: 180, flexShrink: 0 }),
        display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: treeShare != null ? 120 : 0,
        background: 'var(--bg2)', borderRight: '1px solid var(--line)', position: 'relative',
      }}>
        <ExplorerHeader
          root={root}
          refreshTitle="Refresh tree & git status"
          onRefresh={() => { setRefresh(r => ({ tick: r.tick + 1, dirs: null })); refreshGit() }}
          onNewFile={() => crud.beginCreate(root, 'file')}
          onNewFolder={() => crud.beginCreate(root, 'folder')}
          onCollapseAll={() => setExpanded(new Set())}
          showHidden={showHidden}
          onToggleHidden={() => setShowHidden(v => !v)}
        />
        {opErr && <TreeOpError message={opErr} onDismiss={clearOpErr} />}
        <div
          style={{ flex: 1, overflowY: 'auto', padding: '5px 4px' }}
          onContextMenu={onTreeMenu ? ev => { if (ev.target === ev.currentTarget) onTreeMenu(ev, root, true) } : undefined}
        >
          <TreeLevel
            dir={root}
            depth={0}
            expanded={expanded}
            toggleDir={toggleDir}
            openFile={openFile}
            selected={file}
            git={git}
            refresh={refresh}
            onAttachFile={attachToChat}
            onMenu={onTreeMenu}
            fs={fs}
            crud={crud}
            showHidden={showHidden}
          />
        </div>
        {quickOpen && (
          <QuickOpen root={root} fs={fs} cacheKey={agent.id} onPick={openFile} onClose={() => setQuickOpen(false)} />
        )}
      </div>
      {menu && <TreeContextMenu menu={menu} onClose={() => setMenu(null)} crud={crud} />}
      <Divider dir="col" onRatio={r => { explorerSplitCache.set(agent.id, r); setTreeShare(r) }} />

      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        {tabs.length > 0 && (
          <FileTabs tabs={tabs} active={file} drafts={drafts} onSelect={setFile} onClose={closeTab} />
        )}
        {file ? (
          <>
            <Breadcrumbs path={file} root={root} />
            <FileViewer
              key={file}
              bare
              path={file}
              gutter={gutter}
              onToggleGutter={() => setGutter(g => (g === 'numbers' ? 'git' : 'numbers'))}
              onClose={() => closeTab(file)}
              git={git}
              onAttachFile={attachToChat}
              fs={fs}
              initialMode={modes[file]}
              draft={drafts[file]}
              onModeChange={m => setModes(prev => (prev[file] === m ? prev : { ...prev, [file]: m }))}
              onDocChange={(text, dirty) => handleDocChange(file, text, dirty)}
              onDiscard={() => clearDraft(file)}
            />
          </>
        ) : (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: 'var(--dim)' }}>
            Pick a file to preview
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- standalone

/** The same tree + rich viewer with nothing attached: browse any folder and
 *  open its files (code, markdown, images, PDF, office). Used by the review
 *  workbench when the reviewed folder has no git repository — there is no diff
 *  to show, but the work itself is still reviewable. */
export function FolderExplorer({ root, fs = sessionFs(undefined, '', root) }: { root: string; fs?: SessionFs }) {
  const init = cached(`folder:${root}`)
  const [file, setFile] = useState<string | null>(init.file)
  const [gutter, setGutter] = useState<'numbers' | 'git'>('numbers')
  const [expanded, setExpanded] = useState<Set<string>>(new Set(init.expanded))
  const [refresh, setRefresh] = useState<TreeRefresh>({ tick: 0, dirs: null })
  const [treeShare, setTreeShare] = useState<number | null>(explorerSplitCache.get(`folder:${root}`) ?? null)
  const [showHidden, setShowHidden] = useState(init.showHidden ?? true)
  const [quickOpen, setQuickOpen] = useState(false)
  const [menu, setMenu] = useState<TreeMenuState | null>(null)
  const onTreeMenu = isTauri
    ? (ev: React.MouseEvent, path: string, isDir: boolean) => {
        ev.preventDefault()
        setMenu({ x: ev.clientX, y: ev.clientY, path, isDir, local: !fs.remote })
      }
    : undefined

  useEffect(() => {
    // single-file browser: keep whatever tab state the cache entry holds
    const st = cached(`folder:${root}`)
    stateCache.set(`folder:${root}`, { file, gutter, expanded: [...expanded], tabs: st.tabs, drafts: st.drafts, modes: st.modes, showHidden })
  }, [root, file, gutter, expanded, showHidden])

  const toggleDir = (path: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const { crud, opErr, clearOpErr } = useTreeOps({
    fs,
    expandDirs: dirs => setExpanded(prev => {
      const next = new Set(prev)
      for (const d of dirs) next.add(d)
      return next
    }),
    collapsePath: path => setExpanded(prev => {
      const next = new Set<string>()
      for (const p of prev) if (p !== path && !p.startsWith(path + '/')) next.add(p)
      return next.size === prev.size ? prev : next
    }),
    refreshDirs: dirs => setRefresh(r => ({ tick: r.tick + 1, dirs })),
    onDeletePath: target => { if (file && (file === target || file.startsWith(target + '/'))) setFile(null) },
    onRenamePath: (from, to, isDir) => {
      if (file) setFile(file === from ? to : (isDir && file.startsWith(from + '/') ? to + file.slice(from.length) : file))
    },
    onCreatedFile: setFile,
  })

  return (
    <div
      style={{ flex: 1, minHeight: 0, display: 'flex' }}
      onKeyDown={e => {
        // ⌘P / Ctrl+P opens the file fuzzy-search overlay
        if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'p') {
          e.preventDefault()
          setQuickOpen(true)
        }
      }}
    >
      <div style={{
        ...(treeShare != null
          ? { flexBasis: `${treeShare * 100}%`, flexGrow: 0, flexShrink: 1 }
          : { width: 240, flexShrink: 0 }),
        display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: treeShare != null ? 120 : 0,
        background: 'var(--bg2)', borderRight: '1px solid var(--line)', position: 'relative',
      }}>
        <ExplorerHeader
          root={root}
          refreshTitle="Refresh tree"
          onRefresh={() => setRefresh(r => ({ tick: r.tick + 1, dirs: null }))}
          onNewFile={() => crud.beginCreate(root, 'file')}
          onNewFolder={() => crud.beginCreate(root, 'folder')}
          onCollapseAll={() => setExpanded(new Set())}
          showHidden={showHidden}
          onToggleHidden={() => setShowHidden(v => !v)}
        />
        {opErr && <TreeOpError message={opErr} onDismiss={clearOpErr} />}
        <div
          style={{ flex: 1, overflowY: 'auto', padding: '5px 4px' }}
          onContextMenu={onTreeMenu ? ev => { if (ev.target === ev.currentTarget) onTreeMenu(ev, root, true) } : undefined}
        >
          <TreeLevel
            dir={root}
            depth={0}
            expanded={expanded}
            toggleDir={toggleDir}
            openFile={setFile}
            selected={file}
            git={null}
            refresh={refresh}
            onMenu={onTreeMenu}
            fs={fs}
            crud={crud}
            showHidden={showHidden}
          />
        </div>
        {quickOpen && (
          <QuickOpen root={root} fs={fs} cacheKey={`folder:${root}`} onPick={setFile} onClose={() => setQuickOpen(false)} />
        )}
      </div>
      {menu && <TreeContextMenu menu={menu} onClose={() => setMenu(null)} crud={crud} />}
      <Divider dir="col" onRatio={r => { explorerSplitCache.set(`folder:${root}`, r); setTreeShare(r) }} />

      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        {file ? (
          <FileViewer
            path={file}
            gutter={gutter}
            onToggleGutter={() => setGutter(g => (g === 'numbers' ? 'git' : 'numbers'))}
            onClose={() => setFile(null)}
            git={null}
            fs={fs}
          />
        ) : (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: 'var(--dim)' }}>
            Pick a file on the left to view it
          </div>
        )}
      </div>
    </div>
  )
}

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
import { IMG_MIME, viewKind } from '../../shared/file-preview'
import { CodeEditor } from './lazy-editor'
import { parseDiffLines } from './diff-marks'
import type { Agent } from '../../core/types'
import { IC, Icon } from '../../components/ui'
import { FileIcon } from '../../components/FileIcon'
import { Markdown } from '../../components/Markdown'
import { ContextMenu } from '../../components/ContextMenu'
import { artifactSrcDoc } from '../chat/artifacts'
import { requestAttach } from '../chat/attach-bus'
import { onOpenFileRequest } from './open-file-bus'
import { Divider } from './Divider'

// UI state survives tab switches / pane moves (components remount freely)
interface FilesState {
  file: string | null
  gutter: 'numbers' | 'git'
  expanded: string[]
}
const stateCache = new Map<string, FilesState>()
// drag-adjusted explorer-column share (per session / folder); absent = the
// fixed default width until the user first drags the divider
const explorerSplitCache = new Map<string, number>()

/** Return the persistent per-session file-browser cache, creating it on demand. */
function cached(id: string): FilesState {
  let st = stateCache.get(id)
  if (!st) {
    st = { file: null, gutter: 'git', expanded: [] }
    stateCache.set(id, st)
  }
  return st
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
const ROW_H = 19
const OVERSCAN = 24

// ---------------------------------------------------------------- tree

/** A refresh request for mounted tree levels: bump `tick` to re-list in place;
 *  `dirs` limits the re-list to those directories (null = every level). */
interface TreeRefresh { tick: number; dirs: Set<string> | null }

/** Recursively render one directory level and lazily loaded descendants. */
function TreeLevel({ dir, depth, expanded, toggleDir, openFile, selected, git, refresh, onAttachFile, onMenu, fs }: {
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
  /** local sessions: right-click context menu (open in native app / Finder / VS Code) */
  onMenu?: (ev: React.MouseEvent, path: string, isDir: boolean) => void
  /** local or remote (ssh) fs adapter for the owning session */
  fs: SessionFs
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

  return (
    <>
      {entries.map(e => {
        const color = e.isDir
          ? (git?.dirs.has(e.path) ? 'var(--amber)' : null)
          : gitColor(git?.byPath.get(e.path))
        const isOpen = expanded.has(e.path)
        const isSel = selected === e.path
        return (
          <div key={e.path}>
            <button
              className="palette-item"
              onClick={() => (e.isDir ? toggleDir(e.path) : openFile(e.path))}
              onContextMenu={onMenu ? ev => onMenu(ev, e.path, e.isDir) : undefined}
              style={{
                width: '100%', display: 'flex', alignItems: 'center', gap: 6, border: 'none',
                textAlign: 'left', padding: `3px 8px 3px ${8 + depth * 13}px`, borderRadius: 6,
                background: isSel ? 'rgba(245,196,81,.09)' : 'transparent',
                color: color ?? (isSel ? 'var(--text)' : 'var(--mut)'),
                fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
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
                    background: 'rgba(245,196,81,.14)', color: 'var(--accent)', fontSize: 12, fontWeight: 700,
                  }}
                >
                  +
                </span>
              )}
            </button>
            {e.isDir && isOpen && (
              <TreeLevel dir={e.path} depth={depth + 1} expanded={expanded} toggleDir={toggleDir} openFile={openFile} selected={selected} git={git} refresh={refresh} onAttachFile={onAttachFile} onMenu={onMenu} fs={fs} />
            )}
          </div>
        )
      })}
      {entries.length === 0 && (
        <div style={{ padding: `3px 8px 3px ${20 + depth * 13}px`, fontSize: 11, color: 'var(--faint)' }}>empty</div>
      )}
    </>
  )
}

// ---------------------------------------------------------------- context menu

interface TreeMenuState { x: number; y: number; path: string; isDir: boolean }

/** Right-click menu for local tree rows: hand the path to the OS. */
function TreeContextMenu({ menu, onClose }: { menu: TreeMenuState; onClose: () => void }) {
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
    </ContextMenu>
  )
}

// ---------------------------------------------------------------- viewer

/** Load and display one file with syntax highlighting and optional diff gutter. */
function FileViewer({ path, gutter, onToggleGutter, onClose, git, onAttachFile, fs }: {
  path: string
  gutter: 'numbers' | 'git'
  onToggleGutter: () => void
  onClose: () => void
  git: GitInfo | null
  onAttachFile?: (path: string) => void
  fs: SessionFs
}) {
  const [content, setContent] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [marks, setMarks] = useState<{ added: Set<number>; modified: Set<number>; deletedAfter: Set<number> } | null>(null)
  const [mdView, setMdView] = useState<'rendered' | 'raw'>('rendered')
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
  const [editing, setEditing] = useState(false)
  const editingRef = useRef(false)
  editingRef.current = editing
  const contentRef = useRef<string | null>(null)
  // virtualized code view: track the scroll viewport so only visible rows render
  const scrollRef = useRef<HTMLDivElement>(null)
  const [view, setView] = useState({ top: 0, h: 0 })

  const status = git?.byPath.get(path)
  const name = path.slice(path.lastIndexOf('/') + 1)
  const kind = viewKind(name)
  const lang = langForFile(name)
  const isMd = /\.(md|markdown|mdx)$/i.test(name)
  const rendered = isMd && mdView === 'rendered'
  const rel = git && path.startsWith(git.root + '/') ? path.slice(git.root.length + 1) : null

  // Read the selected file and its diff, ignoring stale async completions.
  const load = useCallback(async () => {
    if (editingRef.current) return // never clobber an open editor buffer
    try {
      if (kind === 'image' || kind === 'pdf') {
        // rendered natively from a data URL; no diff/polling semantics
        const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
        const mime = kind === 'pdf' ? 'application/pdf' : IMG_MIME[ext]
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
    setEditing(false)
    void load()
    if (kind === 'image' || kind === 'pdf') return
    if (isTauri) return onFsChange(() => void load())
    const iv = window.setInterval(() => void load(), 4000)
    return () => window.clearInterval(iv)
  }, [load, kind])

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
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg3)' }}>
      <div style={{
        height: 34, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8, padding: '0 10px',
        background: 'var(--panel)', borderBottom: '1px solid var(--line)',
      }}>
        <FileIcon name={name} path={path} isDir={false} size={14} />
        <span className="mono" style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={path}>
          {rel ?? name}
        </span>
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
        <button className="icon-btn" title="Close file" onClick={onClose} style={{ width: 26, height: 26, borderRadius: 6 }}>
          <Icon paths={IC.close} size={13} stroke={1.8} />
        </button>
      </div>

      {err ? (
        <div style={{ padding: 18, fontSize: 12, color: 'var(--red-soft)' }}>
          Can't display this file — {err.includes('stream did not contain valid UTF-8') ? 'it is binary or not UTF-8 text.' : err}
        </div>
      ) : editing && content !== null ? (
        <CodeEditor
          path={path}
          initial={content}
          onSave={async text => {
            await fs.writeTextFile(path, text)
            contentRef.current = text
            setContent(text)
          }}
          onClose={() => { setEditing(false); void load() }}
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
          onScroll={e => setView({ top: e.currentTarget.scrollTop, h: e.currentTarget.clientHeight })}
          style={{ flex: 1, minHeight: 0, overflow: 'auto' }}
        >
          <div style={{ display: 'inline-block', minWidth: '100%' }}>
            {/* spacer reserving the height of the rows scrolled off the top */}
            <div style={{ height: first * ROW_H }} />
            {lines.slice(first, last).map((line, i) => {
              const n = first + i + 1
              const g = gutterFor(n)
              return (
                <div key={n} style={{ display: 'flex', height: ROW_H, background: gutter === 'git' && g.color ? `${g.color === 'var(--green)' ? 'rgba(96,211,148,.05)' : g.color === 'var(--amber)' ? 'rgba(255,176,32,.05)' : 'transparent'}` : 'transparent' }}>
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
                    style={{ padding: '0 14px', fontSize: 11.5, lineHeight: `${ROW_H}px`, whiteSpace: 'pre', color: 'var(--text2)', userSelect: 'text' }}
                    dangerouslySetInnerHTML={{ __html: highlight(line, lang) || '&nbsp;' }}
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
  const [git, setGit] = useState<GitInfo | null>(null)
  const [refresh, setRefresh] = useState<TreeRefresh>({ tick: 0, dirs: null })
  // explorer/viewer split — fixed default width until first dragged
  const [treeShare, setTreeShare] = useState<number | null>(explorerSplitCache.get(agent.id) ?? null)
  const root = agent.cwd || '~'
  // machine sessions browse the remote host over ssh (using the session's own
  // connection snapshot); local sessions use native fs
  const fs = useMemo(() => sessionFs(agent.machine, agent.id), [agent.machine, agent.id])
  // chat hosts: files can be attached to the conversation with one click —
  // the ChatPane below subscribes on the attach bus and chips the file
  const attachToChat = agent.kind === 'chat' ? (path: string) => { requestAttach(agent.id, path) } : undefined
  // right-click → open natively; local sessions only (remote paths live on
  // another host, and a browser build has no OS opener)
  const [menu, setMenu] = useState<TreeMenuState | null>(null)
  const onTreeMenu = isTauri && !agent.machine
    ? (ev: React.MouseEvent, path: string, isDir: boolean) => {
        ev.preventDefault()
        setMenu({ x: ev.clientX, y: ev.clientY, path, isDir })
      }
    : undefined

  // persist UI state across remounts
  useEffect(() => {
    stateCache.set(agent.id, { file, gutter, expanded: [...expanded] })
  }, [agent.id, file, gutter, expanded])

  // terminal ctrl/cmd+click on a path lands here (path already cwd-resolved)
  useEffect(() => onOpenFileRequest(agent.id, path => setFile(path)), [agent.id])

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

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
      <div style={{
        ...(treeShare != null
          ? { flexBasis: `${treeShare * 100}%`, flexGrow: 0, flexShrink: 1 }
          : { width: 180, flexShrink: 0 }),
        display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: treeShare != null ? 120 : 0,
        background: 'var(--bg2)', borderRight: '1px solid var(--line)',
      }}>
        <div style={{
          height: 30, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 7, padding: '0 10px',
          borderBottom: '1px solid var(--line)',
        }}>
          <span className="mono" style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: 0.6, color: 'var(--dim)' }}>EXPLORER</span>
          <span className="mono" style={{ fontSize: 10, color: 'var(--faint)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={root}>
            {root.slice(root.lastIndexOf('/') + 1) || root}
          </span>
          <button
            className="icon-btn"
            title="Refresh tree & git status"
            onClick={() => { setRefresh(r => ({ tick: r.tick + 1, dirs: null })); refreshGit() }}
            style={{ width: 22, height: 22, borderRadius: 5, marginLeft: 'auto' }}
          >
            <Icon paths={['M21 12a9 9 0 11-2.6-6.4', 'M21 4v5h-5']} size={12} stroke={1.8} />
          </button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '5px 4px' }}>
          <TreeLevel
            dir={root}
            depth={0}
            expanded={expanded}
            toggleDir={toggleDir}
            openFile={setFile}
            selected={file}
            git={git}
            refresh={refresh}
            onAttachFile={attachToChat}
            onMenu={onTreeMenu}
            fs={fs}
          />
        </div>
      </div>
      {menu && <TreeContextMenu menu={menu} onClose={() => setMenu(null)} />}
      <Divider dir="col" onRatio={r => { explorerSplitCache.set(agent.id, r); setTreeShare(r) }} />

      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        {file ? (
          <FileViewer
            path={file}
            gutter={gutter}
            onToggleGutter={() => setGutter(g => (g === 'numbers' ? 'git' : 'numbers'))}
            onClose={() => setFile(null)}
            git={git}
            onAttachFile={attachToChat}
            fs={fs}
          />
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
export function FolderExplorer({ root, fs = sessionFs(undefined, '') }: { root: string; fs?: SessionFs }) {
  const init = cached(`folder:${root}`)
  const [file, setFile] = useState<string | null>(init.file)
  const [gutter, setGutter] = useState<'numbers' | 'git'>('numbers')
  const [expanded, setExpanded] = useState<Set<string>>(new Set(init.expanded))
  const [refresh, setRefresh] = useState<TreeRefresh>({ tick: 0, dirs: null })
  const [treeShare, setTreeShare] = useState<number | null>(explorerSplitCache.get(`folder:${root}`) ?? null)

  useEffect(() => {
    stateCache.set(`folder:${root}`, { file, gutter, expanded: [...expanded] })
  }, [root, file, gutter, expanded])

  const toggleDir = (path: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
      <div style={{
        ...(treeShare != null
          ? { flexBasis: `${treeShare * 100}%`, flexGrow: 0, flexShrink: 1 }
          : { width: 240, flexShrink: 0 }),
        display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: treeShare != null ? 120 : 0,
        background: 'var(--bg2)', borderRight: '1px solid var(--line)',
      }}>
        <div style={{
          height: 30, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 7, padding: '0 10px',
          borderBottom: '1px solid var(--line)',
        }}>
          <span className="mono" style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: 0.6, color: 'var(--dim)' }}>EXPLORER</span>
          <span className="mono" style={{ fontSize: 10, color: 'var(--faint)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={root}>
            {root.slice(root.lastIndexOf('/') + 1) || root}
          </span>
          <button
            className="icon-btn"
            title="Refresh tree"
            onClick={() => setRefresh(r => ({ tick: r.tick + 1, dirs: null }))}
            style={{ width: 22, height: 22, borderRadius: 5, marginLeft: 'auto' }}
          >
            <Icon paths={['M21 12a9 9 0 11-2.6-6.4', 'M21 4v5h-5']} size={12} stroke={1.8} />
          </button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '5px 4px' }}>
          <TreeLevel
            dir={root}
            depth={0}
            expanded={expanded}
            toggleDir={toggleDir}
            openFile={setFile}
            selected={file}
            git={null}
            refresh={refresh}
            fs={fs}
          />
        </div>
      </div>
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

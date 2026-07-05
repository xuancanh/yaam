// VS Code-style file explorer + viewer for one agent session. The tree roots
// at the session's cwd; clicking a file opens a read-only viewer that either
// splits with the terminal or replaces it (toggleable). Git-aware: changed
// files are tinted in the tree and the viewer's gutter can switch from line
// numbers to change markers (green = new, amber = modified, red = deletion).
import { useCallback, useEffect, useRef, useState } from 'react'
import { highlight, langForFile } from '../../core/highlight'
import { gitFileDiff, gitStatus, listDir, readTextFile } from '../../core/native'
import type { DirEntryInfo } from '../../core/native'
import type { Agent } from '../../types'
import { IC, Icon } from '../../components/ui'
import { Markdown } from '../../components/Markdown'
import { ChatPane } from '../chat/ChatPane'
import { TerminalPane } from './TerminalPane'

export type FilesMode = 'split' | 'replace'

// UI state survives tab switches / pane moves (components remount freely)
interface FilesState {
  file: string | null
  mode: FilesMode
  gutter: 'numbers' | 'git'
  expanded: string[]
}
const stateCache = new Map<string, FilesState>()

/** Return the persistent per-session file-browser cache, creating it on demand. */
function cached(id: string): FilesState {
  let st = stateCache.get(id)
  if (!st) {
    st = { file: null, mode: 'split', gutter: 'git', expanded: [] }
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

/** Parse `git diff -U0` hunk headers into per-line change markers. */
/** Parse a file diff into line-number markers for the source gutter. */
function parseDiffLines(diff: string): { added: Set<number>; modified: Set<number>; deletedAfter: Set<number> } {
  const added = new Set<number>()
  const modified = new Set<number>()
  const deletedAfter = new Set<number>()
  for (const m of diff.matchAll(/^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    const oldCount = m[1] !== undefined ? parseInt(m[1], 10) : 1
    const newStart = parseInt(m[2], 10)
    const newCount = m[3] !== undefined ? parseInt(m[3], 10) : 1
    if (newCount === 0) {
      deletedAfter.add(newStart)
      continue
    }
    const target = oldCount === 0 ? added : modified
    for (let i = 0; i < newCount; i++) target.add(newStart + i)
  }
  return { added, modified, deletedAfter }
}

interface GitInfo {
  root: string
  /** absolute path → porcelain status */
  byPath: Map<string, string>
  /** absolute dir paths containing at least one change */
  dirs: Set<string>
}

const MAX_LINES = 8000

// ---------------------------------------------------------------- tree

/** Recursively render one directory level and lazily loaded descendants. */
function TreeLevel({ dir, depth, expanded, toggleDir, openFile, selected, git }: {
  dir: string
  depth: number
  expanded: Set<string>
  toggleDir: (path: string) => void
  openFile: (path: string) => void
  selected: string | null
  git: GitInfo | null
}) {
  const [entries, setEntries] = useState<DirEntryInfo[] | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    listDir(dir)
      .then(es => { if (live) setEntries(es.filter(e => e.name !== '.git')) })
      .catch(e => { if (live) setErr(e instanceof Error ? e.message : String(e)) })
    return () => { live = false }
  }, [dir])

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
              {e.isDir
                ? <Icon paths={['M3 7a2 2 0 012-2h4l2 2h9a1 1 0 011 1v10a2 2 0 01-2 2H5a2 2 0 01-2-2V7z']} size={13} stroke={1.6} />
                : <Icon paths={['M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z', 'M14 3v5h5']} size={13} stroke={1.6} />}
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{e.name}</span>
              {!e.isDir && color && <span style={{ marginLeft: 'auto', fontSize: 9.5, flexShrink: 0, color }}>●</span>}
            </button>
            {e.isDir && isOpen && (
              <TreeLevel dir={e.path} depth={depth + 1} expanded={expanded} toggleDir={toggleDir} openFile={openFile} selected={selected} git={git} />
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

// ---------------------------------------------------------------- viewer

/** Load and display one file with syntax highlighting and optional diff gutter. */
function FileViewer({ path, gutter, onToggleGutter, mode, onToggleMode, onClose, git }: {
  path: string
  gutter: 'numbers' | 'git'
  onToggleGutter: () => void
  mode: FilesMode
  onToggleMode: () => void
  onClose: () => void
  git: GitInfo | null
}) {
  const [content, setContent] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [marks, setMarks] = useState<{ added: Set<number>; modified: Set<number>; deletedAfter: Set<number> } | null>(null)
  const [mdView, setMdView] = useState<'rendered' | 'raw'>('rendered')
  const contentRef = useRef<string | null>(null)

  const status = git?.byPath.get(path)
  const name = path.slice(path.lastIndexOf('/') + 1)
  const lang = langForFile(name)
  const isMd = /\.(md|markdown|mdx)$/i.test(name)
  const rendered = isMd && mdView === 'rendered'
  const rel = git && path.startsWith(git.root + '/') ? path.slice(git.root.length + 1) : null

  // Read the selected file and its diff, ignoring stale async completions.
  const load = useCallback(async () => {
    try {
      const text = await readTextFile(path)
      if (text !== contentRef.current) {
        contentRef.current = text
        setContent(text)
      }
      setErr(null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      return
    }
    if (git && rel) {
      if (git.byPath.get(path) === '??') {
        // untracked: every line is new
        setMarks({ added: new Set([-1]), modified: new Set(), deletedAfter: new Set() })
      } else {
        try {
          setMarks(parseDiffLines(await gitFileDiff(git.root, rel)))
        } catch {
          setMarks(null)
        }
      }
    } else {
      setMarks(null)
    }
  }, [path, git, rel])

  // load on open, then poll — the agent edits files while you watch
  useEffect(() => {
    contentRef.current = null
    setContent(null)
    setErr(null)
    setMarks(null)
    setMdView('rendered')
    void load()
    const iv = window.setInterval(() => void load(), 4000)
    return () => window.clearInterval(iv)
  }, [load])

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

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', background: '#07080B' }}>
      <div style={{
        height: 34, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8, padding: '0 10px',
        background: 'var(--panel)', borderBottom: '1px solid var(--line)',
      }}>
        <Icon paths={['M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z', 'M14 3v5h5']} size={13} stroke={1.6} />
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
        <span className="mono" style={{ fontSize: 10, color: 'var(--faint)', flexShrink: 0 }}>{allLines.length} lines</span>
        <div style={{ flex: 1 }} />
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
        <button
          className="icon-btn"
          title={mode === 'split' ? 'Split with terminal — click to fill the pane' : 'Replacing terminal — click to split'}
          onClick={onToggleMode}
          style={{ width: 26, height: 26, borderRadius: 6, color: mode === 'replace' ? 'var(--accent)' : undefined }}
        >
          {mode === 'split'
            ? <Icon paths={['M4 5h16v14H4z', 'M4 12h16']} size={14} stroke={1.7} />
            : <Icon paths={['M4 5h16v14H4z']} size={14} stroke={1.7} />}
        </button>
        <button className="icon-btn" title="Close file" onClick={onClose} style={{ width: 26, height: 26, borderRadius: 6 }}>
          <Icon paths={IC.close} size={13} stroke={1.8} />
        </button>
      </div>

      {err ? (
        <div style={{ padding: 18, fontSize: 12, color: 'var(--red-soft)' }}>
          Can't display this file — {err.includes('stream did not contain valid UTF-8') ? 'it is binary or not UTF-8 text.' : err}
        </div>
      ) : content === null ? (
        <div style={{ padding: 18, fontSize: 12, color: 'var(--dim)' }}>Loading…</div>
      ) : rendered ? (
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
          <div style={{
            maxWidth: 760, padding: '18px 24px', fontSize: 13, lineHeight: 1.65, color: '#C7CCD6',
            fontFamily: "'IBM Plex Sans', system-ui, sans-serif",
          }}>
            <Markdown text={content} />
          </div>
        </div>
      ) : (
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
          <div style={{ display: 'inline-block', minWidth: '100%' }}>
            {lines.map((line, i) => {
              const n = i + 1
              const g = gutterFor(n)
              return (
                <div key={n} style={{ display: 'flex', background: gutter === 'git' && g.color ? `${g.color === 'var(--green)' ? 'rgba(96,211,148,.05)' : g.color === 'var(--amber)' ? 'rgba(255,176,32,.05)' : 'transparent'}` : 'transparent' }}>
                  <span
                    className="mono"
                    title={gutter === 'git' ? g.label : undefined}
                    style={{
                      width: 50, flexShrink: 0, textAlign: 'right', paddingRight: 8, userSelect: 'none',
                      fontSize: 11, lineHeight: 1.6, background: '#0A0B0F',
                      borderRight: `2px solid ${gutter === 'git' && g.color ? g.color : '#14171d'}`,
                      color: gutter === 'git' ? (g.color ?? 'var(--faint)') : 'var(--faint)',
                      fontWeight: gutter === 'git' && g.color ? 700 : 400,
                    }}
                  >
                    {n}
                  </span>
                  <span
                    className="mono"
                    style={{ padding: '0 14px', fontSize: 11.5, lineHeight: 1.6, whiteSpace: 'pre', color: '#C7CCD6', userSelect: 'text' }}
                    dangerouslySetInnerHTML={{ __html: highlight(line, lang) || '&nbsp;' }}
                  />
                </div>
              )
            })}
            {truncated && (
              <div style={{ padding: '8px 14px', fontSize: 11.5, color: 'var(--amber)' }}>
                Showing the first {MAX_LINES.toLocaleString()} of {allLines.length.toLocaleString()} lines.
              </div>
            )}
          </div>
        </div>
      )}

      {gutter === 'git' && !err && content !== null && (
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
export function FilesPane({ agent, active }: { agent: Agent; active: boolean }) {
  const init = cached(agent.id)
  const [file, setFile] = useState<string | null>(init.file)
  const [mode, setMode] = useState<FilesMode>(init.mode)
  const [gutter, setGutter] = useState<'numbers' | 'git'>(init.gutter)
  const [expanded, setExpanded] = useState<Set<string>>(new Set(init.expanded))
  const [git, setGit] = useState<GitInfo | null>(null)
  const [treeKey, setTreeKey] = useState(0)
  const root = agent.cwd || '~'

  // persist UI state across remounts
  useEffect(() => {
    stateCache.set(agent.id, { file, mode, gutter, expanded: [...expanded] })
  }, [agent.id, file, mode, gutter, expanded])

  // Refresh repository status and rebuild the path-to-status lookup.
  const refreshGit = useCallback(() => {
    gitStatus(root)
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
  }, [root])

  useEffect(() => {
    refreshGit()
    const iv = window.setInterval(refreshGit, 6000)
    return () => window.clearInterval(iv)
  }, [refreshGit])

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
        width: 220, flexShrink: 0, display: 'flex', flexDirection: 'column', minHeight: 0,
        background: '#0C0D12', borderRight: '1px solid var(--line)',
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
            onClick={() => { setTreeKey(k => k + 1); refreshGit() }}
            style={{ width: 22, height: 22, borderRadius: 5, marginLeft: 'auto' }}
          >
            <Icon paths={['M21 12a9 9 0 11-2.6-6.4', 'M21 4v5h-5']} size={12} stroke={1.8} />
          </button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '5px 4px' }}>
          <TreeLevel
            key={treeKey}
            dir={root}
            depth={0}
            expanded={expanded}
            toggleDir={toggleDir}
            openFile={setFile}
            selected={file}
            git={git}
          />
        </div>
      </div>

      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        {file && (
          <FileViewer
            path={file}
            gutter={gutter}
            onToggleGutter={() => setGutter(g => (g === 'numbers' ? 'git' : 'numbers'))}
            mode={mode}
            onToggleMode={() => setMode(m => (m === 'split' ? 'replace' : 'split'))}
            onClose={() => setFile(null)}
            git={git}
          />
        )}
        {(!file || mode === 'split') && (
          <div style={{
            flex: file ? '0 0 40%' : 1, minHeight: 0, display: 'flex', flexDirection: 'column',
            borderTop: file ? '1px solid var(--line)' : 'none',
          }}>
            {agent.kind === 'chat'
              ? <ChatPane agent={agent} active={active && !file} />
              : <TerminalPane agent={agent} active={active && !file} />}
          </div>
        )}
      </div>
    </div>
  )
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useActions, useConductorSelector } from '../../store'
import { worktreeDiff } from '../../core/native'
import { detectRepoDirs } from '../../shared/git-repos'
import type { GitStatusResult } from '../../core/native'
import { buildCfg, callApi, hasCreds } from '../../llm/client'
import type { Agent } from '../../core/types'
import { IC, Icon } from '../../components/ui'
import { FolderExplorer } from './FilesPane'
import { sessionFs } from './remote-native'
import type { SessionFs } from './remote-native'

// Fork/GitKraken-style git workbench for one session: a tree of changed files
// on the left split into STAGED and CHANGES (stage/unstage per file or per
// section), the selected file's diff on the right (single-file or a
// continuous all-files scroll), and a commit box whose message can be
// AI-drafted. GitWorkbench is the shared body — the pane popup (GitPanel) and
// the agents → Review drawer both render it, so the two surfaces stay one
// component. Multi-repo working folders get a repo picker.

interface FileRow {
  path: string
  status: string
  staged: boolean
}

/** paths → nested tree rows (dirs expanded, depth-indented) for one section */
interface TreeRow {
  key: string
  label: string
  depth: number
  isDir: boolean
  file?: FileRow
}

export function buildTree(files: FileRow[]): TreeRow[] {
  const rows: TreeRow[] = []
  const seenDirs = new Set<string>()
  for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const parts = f.path.split('/')
    for (let i = 0; i < parts.length - 1; i++) {
      const dir = parts.slice(0, i + 1).join('/')
      if (!seenDirs.has(dir)) {
        seenDirs.add(dir)
        rows.push({ key: `${f.staged}:d:${dir}`, label: parts[i], depth: i, isDir: true })
      }
    }
    rows.push({ key: `${f.staged}:f:${f.path}`, label: parts[parts.length - 1], depth: parts.length - 1, isDir: false, file: f })
  }
  return rows
}

/** split one unified diff into per-file chunks (for the all-files sections) */
export function splitUnifiedDiff(diff: string): { path: string; diff: string }[] {
  const out: { path: string; diff: string }[] = []
  let current: { path: string; lines: string[] } | null = null
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git')) {
      if (current) out.push({ path: current.path, diff: current.lines.join('\n') })
      const m = line.match(/ b\/(.+)$/)
      current = { path: m ? m[1] : line.slice(11), lines: [line] }
      continue
    }
    current?.lines.push(line)
  }
  if (current) out.push({ path: current.path, diff: current.lines.join('\n') })
  return out
}

const STATUS_COLORS: Record<string, string> = {
  A: 'var(--green)', '?': 'var(--green)', M: 'var(--amber)', R: 'var(--amber)', D: 'var(--red-soft)', U: 'var(--red-soft)',
}

function statusChar(f: FileRow): string {
  return f.status === '??' ? '?' : f.status.slice(0, 1) || 'M'
}

/** one selectable file row with its stage/unstage action */
function FileRowView({ row, selected, onSelect, onToggle }: {
  row: TreeRow
  selected: boolean
  onSelect: () => void
  onToggle: () => void
}) {
  const f = row.file!
  const c = statusChar(f)
  return (
    <div
      className="palette-item"
      onClick={onSelect}
      style={{
        display: 'flex', alignItems: 'center', gap: 6, padding: `2px 8px 2px ${10 + row.depth * 12}px`,
        borderRadius: 6, cursor: 'pointer', background: selected ? 'rgba(245,196,81,.09)' : 'transparent',
      }}
    >
      <button
        className="icon-btn"
        title={f.staged ? 'Unstage file' : 'Stage file'}
        onClick={e => { e.stopPropagation(); onToggle() }}
        style={{ width: 17, height: 17, borderRadius: 4, flexShrink: 0, border: '1px solid var(--line2)' }}
      >
        <span className="mono" style={{ fontSize: 11, fontWeight: 700, lineHeight: 1 }}>{f.staged ? '−' : '+'}</span>
      </button>
      <span className="mono" title={f.status} style={{ width: 12, flexShrink: 0, fontSize: 10.5, fontWeight: 700, color: STATUS_COLORS[c] ?? 'var(--mut)' }}>{c}</span>
      <span style={{ fontSize: 12, color: selected ? 'var(--text)' : 'var(--mut2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={f.path}>
        {row.label}
      </span>
    </div>
  )
}

/** STAGED / CHANGES section: header with a bulk action + the file tree */
function Section({ title, files, bulkLabel, onBulk, selectedPath, selectedStaged, onSelect, onToggle }: {
  title: string
  files: FileRow[]
  bulkLabel: string
  onBulk: () => void
  selectedPath: string | null
  selectedStaged: boolean
  onSelect: (f: FileRow) => void
  onToggle: (f: FileRow) => void
}) {
  const rows = useMemo(() => buildTree(files), [files])
  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 32 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '7px 10px 4px' }}>
        <span className="mono" style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: 0.6, color: 'var(--dim)' }}>{title}</span>
        <span className="mono" style={{ fontSize: 10, color: 'var(--faint)' }}>{files.length}</span>
        <div style={{ flex: 1 }} />
        {files.length > 0 && (
          <button
            className="mono"
            onClick={onBulk}
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 10, fontWeight: 600, color: 'var(--accent)', padding: 0 }}
          >
            {bulkLabel}
          </button>
        )}
      </div>
      {rows.map(row => row.isDir ? (
        <div key={row.key} className="mono" style={{ padding: `2px 8px 1px ${10 + row.depth * 12}px`, fontSize: 10.5, color: 'var(--dim)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          ▾ {row.label}/
        </div>
      ) : (
        <FileRowView
          key={row.key}
          row={row}
          selected={selectedPath === row.file!.path && selectedStaged === row.file!.staged}
          onSelect={() => onSelect(row.file!)}
          onToggle={() => onToggle(row.file!)}
        />
      ))}
      {files.length === 0 && <div style={{ padding: '2px 12px 6px', fontSize: 11, color: 'var(--faint)' }}>nothing here</div>}
    </div>
  )
}

/** colored unified-diff body */
function DiffView({ diff }: { diff: string }) {
  if (!diff.trim()) return <div style={{ padding: 16, fontSize: 12, color: 'var(--dim)' }}>no diff — select a file on the left</div>
  return (
    <pre className="mono" style={{ margin: 0, padding: '8px 0', fontSize: 11.5, lineHeight: 1.55 }}>
      {diff.split('\n').map((line, i) => {
        const color = line.startsWith('+++') || line.startsWith('---') ? 'var(--text)'
          : line.startsWith('+') ? 'var(--green)'
          : line.startsWith('-') ? 'var(--red-soft)'
          : line.startsWith('@@') ? 'var(--accent)'
          : 'var(--mut)'
        const bg = line.startsWith('+') && !line.startsWith('+++') ? 'rgba(61,220,151,.06)'
          : line.startsWith('-') && !line.startsWith('---') ? 'rgba(255,92,92,.06)'
          : 'transparent'
        return <div key={i} style={{ padding: '0 14px', color, background: bg, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{line || ' '}</div>
      })}
    </pre>
  )
}

interface DiffSection {
  key: string
  label: string
  staged: boolean
  diff: string
}

/** The shared git body: toolbar (repo picker, view toggle, refresh), the
 *  staged/unstaged tree + commit box on the left, diffs on the right, and an
 *  optional host-supplied footer (the review drawer's merge/approve row). */
export function GitWorkbench({ cwd, worktree, footer, fs = sessionFs(undefined, '') }: {
  cwd?: string
  /** worktree info when the work happens in an isolated mirror */
  worktree?: { root: string; base: string; workdir: string }
  footer?: ReactNode
  /** local or remote (ssh) git adapter for the reviewed session */
  fs?: SessionFs
}) {
  const settings = useConductorSelector(x => x.settings)
  const [repos, setRepos] = useState<string[]>([])
  const [repo, setRepo] = useState<string>(cwd ?? "")
  /** the reviewed folder contains no git repository at all — fall back to a
   *  plain folder browse (rich file viewer) instead of an empty diff view */
  const [noRepo, setNoRepo] = useState(false)
  const [status, setStatus] = useState<GitStatusResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<{ path: string; staged: boolean } | null>(null)
  const [diff, setDiff] = useState('')
  /** single = one file at a time · all = continuous scroll of every diff
   *  (worktree sessions review vs their fork point in all-files mode) */
  const [viewMode, setViewMode] = useState<'single' | 'all'>('single')
  const [sections, setSections] = useState<DiffSection[]>([])
  const sectionRefs = useRef(new Map<string, HTMLDivElement>())

  const refresh = useCallback(async (dir = repo) => {
    try {
      const st = await fs.gitStatus(dir)
      setStatus(st)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStatus(null)
    }
  }, [repo, fs])

  // resolve the repo (or, for a multi-repo worktree/folder cwd, the repo list).
  // Remote (ssh) sessions can't be scanned locally, so the cwd IS the repo —
  // gitStatus resolves the real toplevel, or errors into the no-repo fallback.
  useEffect(() => {
    let live = true
    if (fs.remote) {
      const dir = cwd ?? ''
      setRepos([dir])
      setRepo(dir)
      void fs.gitStatus(dir)
        .then(st => { if (live) { setStatus(st); setError(null) } })
        .catch(() => { if (live) setNoRepo(true) })
      return () => { live = false }
    }
    void detectRepoDirs(cwd ?? "").then(candidates => {
      if (!live) return
      setRepos(candidates)
      if (candidates.length) { setRepo(candidates[0]); void refresh(candidates[0]) }
      else setNoRepo(true)
    })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, fs])

  // one file's diff for its side; untracked files show their contents
  const loadFileDiff = useCallback(async (st: GitStatusResult, path: string, staged: boolean): Promise<string> => {
    const f = st.files.find(x => x.path === path)
    if (!staged && f?.status === '??') {
      const text = await fs.readTextFile(`${st.root}/${path}`).catch(() => '(binary or unreadable file)')
      return `+++ ${path} (untracked)\n${text.split('\n').slice(0, 800).map(l => `+${l}`).join('\n')}`
    }
    return await fs.gitFileDiffSide(st.root, path, staged)
  }, [fs])

  // single-file view: load the selected file's diff
  useEffect(() => {
    if (viewMode !== 'single' || !selected || !status) { setDiff(''); return }
    let live = true
    loadFileDiff(status, selected.path, selected.staged)
      .then(d => { if (live) setDiff(d) })
      .catch(e => { if (live) setDiff(String(e)) })
    return () => { live = false }
  }, [selected, status, viewMode, loadFileDiff])

  // all-files view: every diff in one scroll. Worktree sessions review against
  // the fork point (committed + uncommitted — exactly what a merge brings back)
  useEffect(() => {
    if (viewMode !== 'all' || !status) { setSections([]); return }
    let live = true
    const load = async (): Promise<DiffSection[]> => {
      if (worktree) {
        const repoDiffs = await worktreeDiff(worktree.root)
        return repoDiffs.flatMap(r => {
          const prefix = repoDiffs.length > 1 ? `${r.name}/` : ''
          if (r.error) return [{ key: `wt:${r.name}`, label: `${r.name} (error)`, staged: false, diff: r.error }]
          return splitUnifiedDiff(r.diff).map(f => ({
            key: `wt:${prefix}${f.path}`, label: `${prefix}${f.path}`, staged: false, diff: f.diff,
          }))
        })
      }
      const wanted = [
        ...status.files.filter(f => f.index !== ' ' && f.index !== '?').map(f => ({ path: f.path, staged: true })),
        ...status.files.filter(f => f.work !== ' ').map(f => ({ path: f.path, staged: false })),
      ]
      return await Promise.all(wanted.slice(0, 60).map(async w => ({
        key: `${w.staged}:${w.path}`,
        label: w.path,
        staged: w.staged,
        diff: await loadFileDiff(status, w.path, w.staged).catch(e => String(e)),
      })))
    }
    void load().then(secs => { if (live) setSections(secs) })
    return () => { live = false }
  }, [viewMode, status, worktree, loadFileDiff])

  // in all-files view, picking a file on the left scrolls to its section
  const selectFile = (f: FileRow) => {
    setSelected({ path: f.path, staged: f.staged })
    if (viewMode !== 'all') return
    const repoPrefix = worktree && repos.length > 1 ? `${repo.slice(repo.lastIndexOf('/') + 1)}/` : ''
    const key = worktree ? `wt:${repoPrefix}${f.path}` : `${f.staged}:${f.path}`
    sectionRefs.current.get(key)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const files = status?.files ?? []
  const stagedFiles: FileRow[] = files.filter(f => f.index !== ' ' && f.index !== '?').map(f => ({ path: f.path, status: f.index, staged: true }))
  const unstagedFiles: FileRow[] = files.filter(f => f.work !== ' ').map(f => ({ path: f.path, status: f.status === '??' ? '??' : f.work, staged: false }))

  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [genBusy, setGenBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await fn()
      await refresh()
      setNote(null)
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const toggle = (f: FileRow) => act(() => f.staged ? fs.gitUnstage(status!.root, [f.path]) : fs.gitStage(status!.root, [f.path]))

  const commit = () => act(async () => {
    const summary = await fs.gitCommit(status!.root, message.trim())
    setMessage('')
    setNote(summary.split('\n')[0] ?? 'committed')
  })

  const generate = async () => {
    if (!status) return
    setGenBusy(true)
    setNote(null)
    try {
      const staged = stagedFiles.length > 0
      const parts = await Promise.all(
        (staged ? stagedFiles : unstagedFiles).slice(0, 25).map(f => fs.gitFileDiffSide(status.root, f.path, staged).catch(() => '')),
      )
      const diffText = parts.join('\n').slice(0, 24_000)
      if (!diffText.trim()) throw new Error('nothing to describe — stage some changes first')
      const res = await callApi(
        buildCfg(settings),
        'You write git commit messages. Reply with ONLY the message: an imperative-mood subject line under 65 characters; add a short body after a blank line only when the change genuinely needs explanation. No quotes, no markdown fences.',
        [{ role: 'user', content: `Write a commit message for this diff${staged ? '' : ' (unstaged working-tree changes)'}:\n\n${diffText}` }],
        [],
      )
      const text = res.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim()
      if (text) setMessage(text)
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e))
    } finally {
      setGenBusy(false)
    }
  }

  const repoName = (p: string) => p.slice(p.lastIndexOf('/') + 1) || p

  // no repository anywhere under the reviewed folder: there is no diff to
  // stage or commit, but the work is still reviewable — browse the whole
  // folder with the same rich viewer the terminal/chat explorer uses
  if (noRepo) {
    return (
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <div className="mono" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px', borderBottom: '1px solid var(--line)', flexShrink: 0, fontSize: 10.5, color: 'var(--dim)' }}>
          <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{cwd}</span>
          <span style={{ marginLeft: 'auto', flexShrink: 0, color: 'var(--amber)' }}>not a git repository — browsing files</span>
        </div>
        <FolderExplorer root={cwd ?? "~"} fs={fs} />
        {footer}
      </div>
    )
  }

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px', borderBottom: '1px solid var(--line)', flexShrink: 0 }}>
        <span className="mono" style={{ flex: 1, minWidth: 0, fontSize: 10.5, color: 'var(--dim)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {status ? `${status.root} · ⎇ ${status.branch || 'detached'}` : cwd}
          {worktree ? ' · isolated worktree' : ''}
        </span>
        {repos.length > 1 && (
          <select
            value={repo}
            onChange={e => { setRepo(e.target.value); setSelected(null); void refresh(e.target.value) }}
            className="select-field"
            style={{ background: 'var(--bg)', border: '1px solid var(--line2)', borderRadius: 8, padding: '4px 8px', color: 'var(--text)', fontSize: 11.5, outline: 'none' }}
          >
            {repos.map(r => <option key={r} value={r}>{repoName(r)}</option>)}
          </select>
        )}
        <button
          className="icon-btn"
          title={viewMode === 'single'
            ? `Single-file view — click for a continuous scroll of all diffs${worktree ? ' (vs the worktree fork point)' : ''}`
            : 'All-files view — click for one file at a time'}
          onClick={() => setViewMode(m => (m === 'single' ? 'all' : 'single'))}
          style={{ width: 25, height: 25, borderRadius: 7, color: viewMode === 'all' ? 'var(--accent)' : undefined }}
        >
          {viewMode === 'all'
            ? <Icon paths={['M4 5h16', 'M4 9h16', 'M4 13h16', 'M4 17h16']} size={13} stroke={1.8} />
            : <Icon paths={['M5 4h14v16H5z', 'M9 9h6', 'M9 13h6']} size={13} stroke={1.7} />}
        </button>
        <button className="icon-btn" title="Refresh status" onClick={() => { void refresh() }} style={{ width: 25, height: 25, borderRadius: 7 }}>
          <Icon paths={['M21 12a9 9 0 11-2.6-6.4', 'M21 4v5h-5']} size={13} stroke={1.8} />
        </button>
      </div>

      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <div style={{ width: 280, flexShrink: 0, borderRight: '1px solid var(--line)', display: 'flex', flexDirection: 'column', minHeight: 0, background: 'var(--bg2)' }}>
          <div style={{ flex: 1, overflowY: 'auto', paddingBottom: 6 }}>
            {error
              ? <div style={{ padding: 14, fontSize: 12, color: 'var(--red-soft)' }}>{error}</div>
              : <>
                  <Section
                    title="STAGED"
                    files={stagedFiles}
                    bulkLabel="unstage all"
                    onBulk={() => { void act(() => fs.gitUnstage(status!.root, stagedFiles.map(f => f.path))) }}
                    selectedPath={selected?.path ?? null}
                    selectedStaged={selected?.staged ?? false}
                    onSelect={selectFile}
                    onToggle={f => { void toggle(f) }}
                  />
                  <div style={{ borderTop: '1px solid var(--line-soft)', margin: '4px 0' }} />
                  <Section
                    title="CHANGES"
                    files={unstagedFiles}
                    bulkLabel="stage all"
                    onBulk={() => { void act(() => fs.gitStage(status!.root, unstagedFiles.map(f => f.path))) }}
                    selectedPath={selected?.path ?? null}
                    selectedStaged={selected?.staged ?? true}
                    onSelect={selectFile}
                    onToggle={f => { void toggle(f) }}
                  />
                </>}
          </div>

          <div style={{ borderTop: '1px solid var(--line)', padding: 10, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 7 }}>
            <textarea
              value={message}
              onChange={e => setMessage(e.target.value)}
              placeholder="Commit message…"
              rows={3}
              style={{
                background: 'var(--bg)', border: '1px solid var(--line2)', borderRadius: 8, padding: '7px 9px',
                color: 'var(--text)', outline: 'none', resize: 'vertical', fontSize: 12, lineHeight: 1.5,
                fontFamily: 'var(--font-sans)',
              }}
            />
            {note && <div className="mono" style={{ fontSize: 10.5, color: 'var(--amber)', whiteSpace: 'pre-wrap', maxHeight: 60, overflowY: 'auto' }}>{note}</div>}
            <div style={{ display: 'flex', gap: 7 }}>
              <button
                className="open-btn"
                title={hasCreds(settings) ? `Draft a message from the ${stagedFiles.length ? 'staged' : 'unstaged'} diff` : 'Needs the Master Brain credentials (Settings)'}
                disabled={genBusy || !hasCreds(settings)}
                onClick={() => { void generate() }}
                style={{ flex: 'none', padding: '7px 11px', fontSize: 11.5, opacity: hasCreds(settings) ? 1 : 0.5 }}
              >
                {genBusy ? 'Drafting…' : '✨ Generate'}
              </button>
              <button
                className="approve-btn"
                disabled={busy || !message.trim() || stagedFiles.length === 0}
                onClick={commit}
                title={stagedFiles.length === 0 ? 'Stage files first' : `Commit ${stagedFiles.length} staged file${stagedFiles.length > 1 ? 's' : ''}`}
                style={{ flex: 1, padding: 7, fontSize: 12, opacity: busy || !message.trim() || stagedFiles.length === 0 ? 0.5 : 1 }}
              >
                {busy ? 'Working…' : `Commit${stagedFiles.length ? ` ${stagedFiles.length} file${stagedFiles.length > 1 ? 's' : ''}` : ''}`}
              </button>
            </div>
          </div>
        </div>

        <div style={{ flex: 1, minWidth: 0, overflowY: 'auto', background: 'var(--bg3)' }}>
          {viewMode === 'single' ? (
            <>
              {selected && (
                <div className="mono" style={{ position: 'sticky', top: 0, padding: '7px 14px', fontSize: 11, fontWeight: 600, color: 'var(--text2)', background: 'var(--panel2)', borderBottom: '1px solid var(--line)' }}>
                  {selected.path} <span style={{ color: 'var(--dim)', fontWeight: 400 }}>· {selected.staged ? 'staged' : 'unstaged'}</span>
                </div>
              )}
              <DiffView diff={diff} />
            </>
          ) : sections.length ? (
            sections.map(sec => (
              <div
                key={sec.key}
                ref={el => {
                  if (el) sectionRefs.current.set(sec.key, el)
                  else sectionRefs.current.delete(sec.key)
                }}
              >
                <div
                  className="mono"
                  style={{
                    position: 'sticky', top: 0, zIndex: 2, padding: '7px 14px', fontSize: 11, fontWeight: 600,
                    color: 'var(--text2)', background: 'var(--panel2)', borderBottom: '1px solid var(--line)', borderTop: '1px solid var(--line)',
                  }}
                >
                  {sec.label}{' '}
                  <span style={{ color: worktree ? 'var(--accent)' : sec.staged ? 'var(--green)' : 'var(--amber)', fontWeight: 400 }}>
                    · {worktree ? 'vs fork point' : sec.staged ? 'staged' : 'unstaged'}
                  </span>
                </div>
                <DiffView diff={sec.diff} />
              </div>
            ))
          ) : (
            <div style={{ padding: 16, fontSize: 12, color: 'var(--dim)' }}>no changes</div>
          )}
        </div>
      </div>

      {footer}
    </div>
  )
}

/** The pane-header popup: a modal shell around the shared workbench. */
export function GitPanel({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const { openDiff } = useActions()
  const fs = useMemo(() => sessionFs(agent.machine, agent.id), [agent.machine, agent.id])
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(4,5,8,.6)', zIndex: 48, display: 'flex', justifyContent: 'center', alignItems: 'center', padding: '4vh 3vw' }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: 1040, maxWidth: '100%', height: '86vh', display: 'flex', flexDirection: 'column',
        background: 'var(--panel)', border: '1px solid var(--line2)', borderRadius: 15, boxShadow: '0 26px 70px rgba(0,0,0,.6)', overflow: 'hidden',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 15px', borderBottom: '1px solid var(--line)', flexShrink: 0 }}>
          <Icon paths={['M6 3v12', 'M6 15a3 3 0 103 3', 'M18 9a3 3 0 10-3-3', 'M18 9a9 9 0 01-9 9']} size={16} stroke={1.7} />
          <div className="grotesk" style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            Git · {agent.name}
          </div>
          {agent.worktree && (
            <button
              className="open-btn"
              title="Open the review drawer to merge this worktree back into the original checkout"
              onClick={() => { onClose(); openDiff(agent.id) }}
              style={{ flex: 'none', padding: '5px 12px', fontSize: 11.5, color: 'var(--amber)' }}
            >
              Review &amp; merge…
            </button>
          )}
          <button className="icon-btn" title="Close" onClick={onClose} style={{ width: 26, height: 26, borderRadius: 7 }}>
            <Icon paths={IC.close} size={12} stroke={2} />
          </button>
        </div>
        <GitWorkbench cwd={agent.cwd} worktree={agent.worktree} fs={fs} />
      </div>
    </div>
  )
}

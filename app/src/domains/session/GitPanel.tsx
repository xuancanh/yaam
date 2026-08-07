import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useConductorSelector } from '../../store'
import { worktreeDiff } from '../../core/native'
import type { GitStatusResult } from '../../core/native'
import { buildCfg, callApi, hasCreds } from '../../llm/client'
import type { Agent } from '../../core/types'
import { Icon } from '../../components/ui'
import { CodeEditor } from './lazy-editor'
import { splitDiffRows } from './diff-split'
import type { SplitCell } from './diff-split'
import { repoLabel } from '../../shared/git-repos'
import { highlight, langForFile } from '../../core/highlight'
import type { HighlightLang } from '../../core/highlight'
import { WorktreeMergeBar } from './WorktreeMergeBar'
import { Divider } from './Divider'
import { FolderExplorer } from './FilesPane'
import { sessionFs } from './remote-native'
import type { SessionFs } from './remote-native'

// drag-adjusted file-list share of the workbench (per reviewed folder);
// absent = the fixed default width until the user first drags the divider
const fileColSplitCache = new Map<string, number>()

// Fork/GitKraken-style git workbench for one session: a tree of changed files
// on the left split into STAGED and CHANGES (stage/unstage per file or per
// section), the selected file's diff on the right (single-file or a
// continuous all-files scroll), and a commit box whose message can be
// AI-drafted. GitWorkbench is the shared body — the pane popup (GitPanel) and
// the agents → Review drawer both render it, so the two surfaces stay one
// component. Multi-repo working folders get a repo picker.

interface FileRow {
  /** display path — repo-prefixed when the folder holds several repos */
  path: string
  status: string
  staged: boolean
  /** owning repo root (absent only in tests that exercise buildTree alone) */
  root?: string
  /** path relative to `root` — what the git commands take */
  rel?: string
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
        borderRadius: 6, cursor: 'pointer', background: selected ? 'rgba(245,196,81,.14)' : 'transparent',
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
      <span style={{ fontSize: 12.5, color: selected ? 'var(--text)' : 'var(--text2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={f.path}>
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

const CELL_STYLE: Record<string, { color: string; bg: string }> = {
  add: { color: 'var(--green)', bg: 'rgba(61,220,151,.10)' },
  del: { color: 'var(--red-soft)', bg: 'rgba(255,92,92,.10)' },
  ctx: { color: 'var(--mut)', bg: 'transparent' },
  empty: { color: 'var(--mut)', bg: 'var(--bg2)' },
  hunk: { color: 'var(--accent)', bg: 'transparent' },
  meta: { color: 'var(--text)', bg: 'var(--panel2)' },
}

/** syntax-highlighted code content for a diff line (empty stays a blank line);
 *  the add/del tint comes from the row, so highlight paints only the tokens */
function hlHtml(text: string, lang: HighlightLang): { __html: string } {
  return { __html: text ? highlight(text, lang) : ' ' }
}

/** one side-by-side cell: gutter line number + syntax-highlighted text */
function SplitCellView({ cell, lang }: { cell: SplitCell; lang: HighlightLang }) {
  const st = CELL_STYLE[cell.kind]
  const code = cell.kind === 'add' || cell.kind === 'del' || cell.kind === 'ctx'
  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', background: st.bg }}>
      <span style={{ width: 40, flexShrink: 0, textAlign: 'right', paddingRight: 7, color: 'var(--faint)', userSelect: 'none' }}>
        {cell.n ?? ''}
      </span>
      {code
        ? <span style={{ flex: 1, minWidth: 0, padding: '0 10px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }} dangerouslySetInnerHTML={hlHtml(cell.text, lang)} />
        : <span style={{ flex: 1, minWidth: 0, padding: '0 10px', color: st.color, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{cell.text || ' '}</span>}
    </div>
  )
}

/** colored diff body: unified, or side-by-side (old left, new right).
 *  `path` selects the syntax highlighter for the code content. */
function DiffView({ diff, split, path }: { diff: string; split?: boolean; path?: string }) {
  const lang = useMemo(() => (path ? langForFile(path) : 'text') as HighlightLang, [path])
  if (!diff.trim()) return <div style={{ padding: 16, fontSize: 12, color: 'var(--dim)' }}>no diff — select a file on the left</div>
  if (split) {
    const rows = splitDiffRows(diff)
    return (
      <div className="mono" style={{ padding: '8px 0', fontSize: 12, lineHeight: 1.6 }}>
        {rows.map((row, i) => row.left.kind === 'hunk' || row.left.kind === 'meta' ? (
          <div key={i} style={{ padding: '0 14px', color: CELL_STYLE[row.left.kind].color, background: CELL_STYLE[row.left.kind].bg, whiteSpace: 'pre-wrap', fontWeight: row.left.kind === 'meta' ? 700 : 400 }}>
            {row.left.text}
          </div>
        ) : (
          <div key={i} style={{ display: 'flex' }}>
            <SplitCellView cell={row.left} lang={lang} />
            <div style={{ width: 1, flexShrink: 0, background: 'var(--line)' }} />
            <SplitCellView cell={row.right} lang={lang} />
          </div>
        ))}
      </div>
    )
  }
  return (
    <pre className="mono" style={{ margin: 0, padding: '8px 0', fontSize: 12, lineHeight: 1.6 }}>
      {diff.split('\n').map((line, i) => {
        const isMeta = line.startsWith('+++') || line.startsWith('---')
        const isAdd = line.startsWith('+') && !isMeta
        const isDel = line.startsWith('-') && !isMeta
        const isHunk = line.startsWith('@@')
        const markColor = isMeta ? 'var(--text)' : isAdd ? 'var(--green)' : isDel ? 'var(--red-soft)' : isHunk ? 'var(--accent)' : 'var(--mut)'
        const bg = isAdd ? 'rgba(61,220,151,.10)' : isDel ? 'rgba(255,92,92,.10)' : 'transparent'
        // meta/hunk lines are diff chrome — literal, no highlight. code lines
        // keep their +/-/space marker colored, with the tokens highlighted.
        if (isMeta || isHunk || !line) {
          return <div key={i} style={{ padding: '0 14px', color: markColor, background: bg, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{line || ' '}</div>
        }
        const mark = isAdd || isDel || line.startsWith(' ') ? line.slice(0, 1) : ''
        const code = mark ? line.slice(1) : line
        return (
          <div key={i} style={{ padding: '0 14px', background: bg, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            <span style={{ color: markColor, userSelect: 'none' }}>{mark}</span>
            <span dangerouslySetInnerHTML={hlHtml(code, lang)} />
          </div>
        )
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
export function GitWorkbench({ cwd, worktree, footer, fs = sessionFs(undefined, ''), compact }: {
  cwd?: string
  /** worktree info when the work happens in an isolated mirror */
  worktree?: { root: string; base: string; workdir: string }
  footer?: ReactNode
  /** local or remote (ssh) git adapter for the reviewed session */
  fs?: SessionFs
  /** narrow host (inline pane side panel): slimmer file column */
  compact?: boolean
}) {
  const settings = useConductorSelector(x => x.settings)
  /** every repo under the reviewed folder, loaded together — a folder of
   *  sub-repos reviews as ONE pane (no picker), paths prefixed per repo */
  const [statuses, setStatuses] = useState<{ dir: string; label: string; st: GitStatusResult }[]>([])
  /** the reviewed folder contains no git repository at all — fall back to a
   *  plain folder browse (rich file viewer) instead of an empty diff view */
  const [noRepo, setNoRepo] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // file-list/diff split — fixed default width until first dragged
  const [fileColShare, setFileColShare] = useState<number | null>(fileColSplitCache.get(cwd ?? '') ?? null)
  const [selected, setSelected] = useState<FileRow | null>(null)
  const [diff, setDiff] = useState('')
  /** single = one file at a time · all = continuous scroll of every diff
   *  (worktree sessions review vs their fork point in all-files mode) */
  const [viewMode, setViewMode] = useState<'single' | 'all'>('single')
  /** side-by-side (old | new) instead of the unified diff */
  const [sideBySide, setSideBySide] = useState(false)
  /** editing the selected file in place of its diff */
  const [editing, setEditing] = useState(false)
  const [editText, setEditText] = useState<string | null>(null)
  const [sections, setSections] = useState<DiffSection[]>([])
  const sectionRefs = useRef(new Map<string, HTMLDivElement>())

  const loadStatuses = useCallback(async (dirs: string[]) => {
    const loaded = await Promise.all(dirs.map(async dir => {
      try {
        return { dir, label: repoLabel(cwd ?? '', dir), st: await fs.gitStatus(dir), err: null as string | null }
      } catch (e) {
        return { dir, label: repoLabel(cwd ?? '', dir), st: null, err: e instanceof Error ? e.message : String(e) }
      }
    }))
    const ok = loaded.filter(r => r.st !== null) as { dir: string; label: string; st: GitStatusResult }[]
    setStatuses(ok)
    setError(ok.length ? null : loaded[0]?.err ?? 'no repository')
  }, [cwd, fs])

  const dirsRef = useRef<string[]>([])
  const refresh = useCallback(async () => {
    if (dirsRef.current.length) await loadStatuses(dirsRef.current)
  }, [loadStatuses])

  // resolve the repo (or, for a multi-repo folder cwd, the repo list) through the
  // session's adapter, so a remote folder of repos is detected on the host too
  useEffect(() => {
    let live = true
    void fs.detectRepos(cwd ?? "").then(candidates => {
      if (!live) return
      dirsRef.current = candidates
      if (candidates.length) void loadStatuses(candidates)
      else setNoRepo(true)
    })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, fs])

  // one file's diff for its side; untracked files show their contents
  const loadFileDiff = useCallback(async (f: FileRow): Promise<string> => {
    const root = f.root ?? cwd ?? ''
    const rel = f.rel ?? f.path
    if (!f.staged && f.status === '??') {
      const text = await fs.readTextFile(`${root}/${rel}`).catch(() => '(binary or unreadable file)')
      return `+++ ${f.path} (untracked)\n${text.split('\n').slice(0, 800).map(l => `+${l}`).join('\n')}`
    }
    return await fs.gitFileDiffSide(root, rel, f.staged)
  }, [fs, cwd])

  // single-file view: load the selected file's diff
  useEffect(() => {
    if (viewMode !== 'single' || !selected || !statuses.length) { setDiff(''); return }
    let live = true
    loadFileDiff(selected)
      .then(d => { if (live) setDiff(d) })
      .catch(e => { if (live) setDiff(String(e)) })
    return () => { live = false }
  }, [selected, statuses, viewMode, loadFileDiff])

  // aggregated rows across every repo; the display path carries the repo
  // prefix when there is more than one, so the tree nests repos naturally
  const multi = statuses.length > 1
  const stagedFiles: FileRow[] = statuses.flatMap(r =>
    r.st.files.filter(f => f.index !== ' ' && f.index !== '?').map(f => ({
      path: multi ? `${r.label}/${f.path}` : f.path, status: f.index, staged: true, root: r.st.root, rel: f.path,
    })))
  const unstagedFiles: FileRow[] = statuses.flatMap(r =>
    r.st.files.filter(f => f.work !== ' ').map(f => ({
      path: multi ? `${r.label}/${f.path}` : f.path, status: f.status === '??' ? '??' : f.work, staged: false, root: r.st.root, rel: f.path,
    })))
  const allRows = [...stagedFiles, ...unstagedFiles]

  // all-files view: every diff in one scroll. Worktree sessions review against
  // the fork point (committed + uncommitted — exactly what a merge brings back)
  useEffect(() => {
    if (viewMode !== 'all' || !statuses.length) { setSections([]); return }
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
      return await Promise.all(allRows.slice(0, 60).map(async f => ({
        key: `${f.staged}:${f.path}`,
        label: f.path,
        staged: f.staged,
        diff: await loadFileDiff(f).catch(e => String(e)),
      })))
    }
    void load().then(secs => { if (live) setSections(secs) })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode, statuses, worktree, loadFileDiff])

  // open the selected file in the inline editor (fix-as-you-review)
  const startEdit = async () => {
    if (!selected?.root) return
    try {
      setEditText(await fs.readTextFile(`${selected.root}/${selected.rel ?? selected.path}`))
      setEditing(true)
    } catch (e) {
      setDiff(e instanceof Error ? e.message : String(e))
    }
  }

  // in all-files view, picking a file on the left scrolls to its section
  const selectFile = (f: FileRow) => {
    setEditing(false)
    setEditText(null)
    setSelected(f)
    if (viewMode !== 'all') return
    const repoPrefix = worktree && multi && f.root ? `${f.root.slice(f.root.lastIndexOf('/') + 1)}/` : ''
    const key = worktree ? `wt:${repoPrefix}${f.rel ?? f.path}` : `${f.staged}:${f.path}`
    sectionRefs.current.get(key)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

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

  /** group rows by their repo root for the per-repo git commands */
  const byRoot = (rows: FileRow[]): Map<string, string[]> => {
    const m = new Map<string, string[]>()
    for (const f of rows) {
      const root = f.root ?? cwd ?? ''
      m.set(root, [...(m.get(root) ?? []), f.rel ?? f.path])
    }
    return m
  }

  const toggle = (f: FileRow) => act(() =>
    f.staged ? fs.gitUnstage(f.root ?? cwd ?? '', [f.rel ?? f.path]) : fs.gitStage(f.root ?? cwd ?? '', [f.rel ?? f.path]))

  const bulk = (rows: FileRow[], op: 'stage' | 'unstage') => act(async () => {
    for (const [root, paths] of byRoot(rows)) {
      if (op === 'stage') await fs.gitStage(root, paths)
      else await fs.gitUnstage(root, paths)
    }
  })

  // one message, committed into every repo that has something staged
  const commit = () => act(async () => {
    const roots = [...byRoot(stagedFiles).keys()]
    const summaries: string[] = []
    for (const root of roots) {
      const summary = await fs.gitCommit(root, message.trim())
      const line = summary.split('\n')[0] ?? 'committed'
      summaries.push(roots.length > 1 ? `${repoLabel(cwd ?? '', root)}: ${line}` : line)
    }
    setMessage('')
    setNote(summaries.join('\n') || 'committed')
  })

  const generate = async () => {
    if (!statuses.length) return
    setGenBusy(true)
    setNote(null)
    try {
      const staged = stagedFiles.length > 0
      const parts = await Promise.all(
        (staged ? stagedFiles : unstagedFiles).slice(0, 25).map(f => fs.gitFileDiffSide(f.root ?? cwd ?? '', f.rel ?? f.path, staged).catch(() => '')),
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
          {statuses.length === 1
            ? `${statuses[0].st.root} · ⎇ ${statuses[0].st.branch || 'detached'}`
            : statuses.length > 1 ? `${cwd} · ${statuses.length} repos` : cwd}
          {worktree ? ' · isolated worktree' : ''}
        </span>
        <button
          className="icon-btn"
          title={sideBySide ? 'Side-by-side diff — click for unified' : 'Unified diff — click for side-by-side (old | new)'}
          onClick={() => setSideBySide(v => !v)}
          style={{ width: 25, height: 25, borderRadius: 7, color: sideBySide ? 'var(--accent)' : undefined }}
        >
          <Icon paths={['M4 5h16v14H4z', 'M12 5v14']} size={13} stroke={1.7} />
        </button>
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
        <div style={{
          ...(fileColShare != null
            ? { flexBasis: `${fileColShare * 100}%`, flexGrow: 0, flexShrink: 1 }
            : { width: compact ? 200 : 280, flexShrink: 0 }),
          borderRight: '1px solid var(--line)', display: 'flex', flexDirection: 'column', minHeight: 0,
          minWidth: fileColShare != null ? 150 : 0, background: 'var(--bg2)',
        }}>
          <div style={{ flex: 1, overflowY: 'auto', paddingBottom: 6 }}>
            {error
              ? <div style={{ padding: 14, fontSize: 12, color: 'var(--red-soft)' }}>{error}</div>
              : <>
                  <Section
                    title="STAGED"
                    files={stagedFiles}
                    bulkLabel="unstage all"
                    onBulk={() => { void bulk(stagedFiles, 'unstage') }}
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
                    onBulk={() => { void bulk(unstagedFiles, 'stage') }}
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
        <Divider dir="col" onRatio={r => { fileColSplitCache.set(cwd ?? '', r); setFileColShare(r) }} />

        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflowY: editing ? 'hidden' : 'auto', background: 'var(--bg3)' }}>
          {viewMode === 'single' ? (
            <>
              {selected && (
                <div className="mono" style={{ position: 'sticky', top: 0, zIndex: 2, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8, padding: '4px 14px', minHeight: 30, fontSize: 11, fontWeight: 600, color: 'var(--text2)', background: 'var(--panel2)', borderBottom: '1px solid var(--line)' }}>
                  <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {selected.path} <span style={{ color: 'var(--dim)', fontWeight: 400 }}>· {editing ? 'editing' : selected.staged ? 'staged' : 'unstaged'}</span>
                  </span>
                  <div style={{ flex: 1 }} />
                  {!editing && (
                    <button
                      className="icon-btn"
                      title="Edit this file in place (⌘S saves; the diff refreshes)"
                      onClick={() => { void startEdit() }}
                      style={{ width: 22, height: 22, borderRadius: 6, flexShrink: 0 }}
                    >
                      <Icon paths={['M12 20h9', 'M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z']} size={12} stroke={1.7} />
                    </button>
                  )}
                </div>
              )}
              {editing && editText !== null && selected?.root ? (
                <CodeEditor
                  path={`${selected.root}/${selected.rel ?? selected.path}`}
                  initial={editText}
                  onSave={async text => {
                    await fs.writeTextFile(`${selected.root}/${selected.rel ?? selected.path}`, text)
                    await refresh()
                  }}
                  onClose={() => { setEditing(false); setEditText(null); void refresh() }}
                />
              ) : (
                <DiffView diff={diff} split={sideBySide} path={selected?.path} />
              )}
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
                <DiffView diff={sec.diff} split={sideBySide} path={sec.label} />
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

/** Inline changes panel for one session (docked right or bottom of the pane):
 *  the shared workbench through the session's fs adapter, closing with a
 *  worktree merge bar when the session is isolated. `compact` slims the file
 *  column for narrow right-docked hosts. */
export function GitSidePanel({ agent, compact }: { agent: Agent; compact?: boolean }) {
  const fs = useMemo(() => sessionFs(agent.machine, agent.id), [agent.machine, agent.id])
  return (
    <GitWorkbench
      cwd={agent.cwd}
      worktree={agent.worktree}
      fs={fs}
      compact={compact}
      footer={agent.worktree ? <WorktreeMergeBar agent={agent} /> : undefined}
    />
  )
}

/** Full-size popup fallback for split layouts where the docked panel is too
 *  cramped: a modal shell around the same panel. */
export function GitPopup({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(4,5,8,.6)', zIndex: 48, display: 'flex', justifyContent: 'center', alignItems: 'center', padding: '4vh 3vw' }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: 1040, maxWidth: '100%', height: '86vh', display: 'flex', flexDirection: 'column',
        background: 'var(--panel)', border: '1px solid var(--line2)', borderRadius: 15, boxShadow: '0 26px 70px rgba(0,0,0,.6)', overflow: 'hidden',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 15px', borderBottom: '1px solid var(--line)', flexShrink: 0 }}>
          <Icon paths={['M6 3v12', 'M6 15a3 3 0 103 3', 'M18 9a3 3 0 10-3-3', 'M18 9a9 9 0 01-9 9']} size={16} stroke={1.7} />
          <div className="grotesk" style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            Changes · {agent.name}
          </div>
          <button className="icon-btn" title="Close" onClick={onClose} style={{ width: 26, height: 26, borderRadius: 7 }}>
            <Icon paths={['M6 6l12 12', 'M18 6L6 18']} size={12} stroke={2} />
          </button>
        </div>
        <GitSidePanel agent={agent} />
      </div>
    </div>
  )
}

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useActions, useConductorSelector } from '../../store'
import {
  gitCommit, gitFileDiffSide, gitStage, gitStatus, gitUnstage, listDir, readTextFile,
} from '../../core/native'
import type { GitStatusResult } from '../../core/native'
import { buildCfg, callApi, hasCreds } from '../../llm/client'
import type { Agent } from '../../core/types'
import { IC, Icon } from '../../components/ui'

// Fork/GitKraken-style git popup for one session: a tree of changed files on
// the left split into STAGED and CHANGES (stage/unstage per file or per
// section), the selected file's diff on the right, and a commit box whose
// message can be AI-drafted from the staged diff. A modal so it works the
// same however many panes share the workspace grid.

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

function buildTree(files: FileRow[]): TreeRow[] {
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

const STATUS_COLORS: Record<string, string> = {
  A: 'var(--green)', '?': 'var(--green)', M: 'var(--amber)', R: 'var(--amber)', D: 'var(--red-soft)', U: 'var(--red-soft)',
}

function statusChar(f: FileRow): string {
  const c = f.status === '??' ? '?' : f.status.slice(0, 1) || 'M'
  return c
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

export function GitPanel({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const settings = useConductorSelector(x => x.settings)
  const { openDiff } = useActions()
  const [repos, setRepos] = useState<string[]>([])
  const [repo, setRepo] = useState<string>(agent.cwd ?? '')
  const [status, setStatus] = useState<GitStatusResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<{ path: string; staged: boolean } | null>(null)
  const [diff, setDiff] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [genBusy, setGenBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const refresh = useCallback(async (dir = repo) => {
    try {
      const st = await gitStatus(dir)
      setStatus(st)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStatus(null)
    }
  }, [repo])

  // resolve the repo (or, for a multi-repo worktree/folder cwd, the repo list)
  useEffect(() => {
    let live = true
    const boot = async () => {
      const base = agent.cwd ?? ''
      try {
        await gitStatus(base)
        if (live) { setRepos([base]); setRepo(base); void refresh(base) }
      } catch {
        // cwd isn't a repo — offer its immediate repo subfolders (multi-repo workspace)
        const entries = await listDir(base).catch(() => [])
        const candidates: string[] = []
        for (const e of entries.filter(x => x.isDir && x.name !== '.git').slice(0, 16)) {
          try { await gitStatus(e.path); candidates.push(e.path) } catch { /* not a repo */ }
        }
        if (!live) return
        setRepos(candidates)
        if (candidates.length) { setRepo(candidates[0]); void refresh(candidates[0]) }
        else setError('no git repository found in this session\'s working folder')
      }
    }
    void boot()
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.id])

  // load the selected file's diff (staged/unstaged side; untracked = whole file)
  useEffect(() => {
    if (!selected || !status) { setDiff(''); return }
    let live = true
    const load = async () => {
      const abs = `${status.root}/${selected.path}`
      const f = status.files.find(x => x.path === selected.path)
      if (!selected.staged && f?.status === '??') {
        const text = await readTextFile(abs).catch(() => '(binary or unreadable file)')
        return `+++ ${selected.path} (untracked)\n${text.split('\n').slice(0, 800).map(l => `+${l}`).join('\n')}`
      }
      return await gitFileDiffSide(status.root, selected.path, selected.staged)
    }
    load().then(d => { if (live) setDiff(d) }).catch(e => { if (live) setDiff(String(e)) })
    return () => { live = false }
  }, [selected, status])

  const files = status?.files ?? []
  const stagedFiles: FileRow[] = files.filter(f => f.index !== ' ' && f.index !== '?').map(f => ({ path: f.path, status: f.index, staged: true }))
  const unstagedFiles: FileRow[] = files.filter(f => f.work !== ' ').map(f => ({ path: f.path, status: f.status === '??' ? '??' : f.work, staged: false }))

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

  const toggle = (f: FileRow) => act(() => f.staged ? gitUnstage(status!.root, [f.path]) : gitStage(status!.root, [f.path]))

  const commit = () => act(async () => {
    const summary = await gitCommit(status!.root, message.trim())
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
        (staged ? stagedFiles : unstagedFiles).slice(0, 25).map(f => gitFileDiffSide(status.root, f.path, staged).catch(() => '')),
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

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(4,5,8,.6)', zIndex: 48, display: 'flex', justifyContent: 'center', alignItems: 'center', padding: '4vh 3vw' }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: 1040, maxWidth: '100%', height: '86vh', display: 'flex', flexDirection: 'column',
        background: 'var(--panel)', border: '1px solid var(--line2)', borderRadius: 15, boxShadow: '0 26px 70px rgba(0,0,0,.6)', overflow: 'hidden',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 15px', borderBottom: '1px solid var(--line)', flexShrink: 0 }}>
          <Icon paths={['M6 3v12', 'M6 15a3 3 0 103 3', 'M18 9a3 3 0 10-3-3', 'M18 9a9 9 0 01-9 9']} size={16} stroke={1.7} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="grotesk" style={{ fontSize: 14, fontWeight: 600 }}>Git · {agent.name}</div>
            <div className="mono" style={{ fontSize: 10.5, color: 'var(--dim)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {status ? `${status.root} · ⎇ ${status.branch || 'detached'}` : agent.cwd}
              {agent.worktree ? ' · isolated worktree' : ''}
            </div>
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
          {repos.length > 1 && (
            <select
              value={repo}
              onChange={e => { setRepo(e.target.value); setSelected(null); void refresh(e.target.value) }}
              className="select-field"
              style={{ background: 'var(--bg)', border: '1px solid var(--line2)', borderRadius: 8, padding: '5px 9px', color: 'var(--text)', fontSize: 12, outline: 'none' }}
            >
              {repos.map(r => <option key={r} value={r}>{repoName(r)}</option>)}
            </select>
          )}
          <button className="icon-btn" title="Refresh status" onClick={() => { void refresh() }} style={{ width: 26, height: 26, borderRadius: 7 }}>
            <Icon paths={['M21 12a9 9 0 11-2.6-6.4', 'M21 4v5h-5']} size={13} stroke={1.8} />
          </button>
          <button className="icon-btn" title="Close" onClick={onClose} style={{ width: 26, height: 26, borderRadius: 7 }}>
            <Icon paths={IC.close} size={12} stroke={2} />
          </button>
        </div>

        <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
          <div style={{ width: 290, flexShrink: 0, borderRight: '1px solid var(--line)', display: 'flex', flexDirection: 'column', minHeight: 0, background: 'var(--bg2)' }}>
            <div style={{ flex: 1, overflowY: 'auto', paddingBottom: 6 }}>
              {error
                ? <div style={{ padding: 14, fontSize: 12, color: 'var(--red-soft)' }}>{error}</div>
                : <>
                    <Section
                      title="STAGED"
                      files={stagedFiles}
                      bulkLabel="unstage all"
                      onBulk={() => { void act(() => gitUnstage(status!.root, stagedFiles.map(f => f.path))) }}
                      selectedPath={selected?.path ?? null}
                      selectedStaged={selected?.staged ?? false}
                      onSelect={f => setSelected({ path: f.path, staged: true })}
                      onToggle={f => { void toggle(f) }}
                    />
                    <div style={{ borderTop: '1px solid var(--line-soft)', margin: '4px 0' }} />
                    <Section
                      title="CHANGES"
                      files={unstagedFiles}
                      bulkLabel="stage all"
                      onBulk={() => { void act(() => gitStage(status!.root, unstagedFiles.map(f => f.path))) }}
                      selectedPath={selected?.path ?? null}
                      selectedStaged={selected?.staged ?? true}
                      onSelect={f => setSelected({ path: f.path, staged: false })}
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
            {selected && (
              <div className="mono" style={{ position: 'sticky', top: 0, padding: '7px 14px', fontSize: 11, fontWeight: 600, color: 'var(--text2)', background: 'var(--panel2)', borderBottom: '1px solid var(--line)' }}>
                {selected.path} <span style={{ color: 'var(--dim)', fontWeight: 400 }}>· {selected.staged ? 'staged' : 'unstaged'}</span>
              </div>
            )}
            <DiffView diff={diff} />
          </div>
        </div>
      </div>
    </div>
  )
}

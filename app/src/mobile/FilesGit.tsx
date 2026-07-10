// File explorer + git change review for the companion, powered by the rpc
// bridge: the phone queues a request, the desktop answers with its normal
// native adapters (path-scoped to session working folders), and the result
// renders here. Markdown files render rich; diffs get the usual +/- coloring.
import { useCallback, useEffect, useState } from 'react'
import { Markdown } from '../components/Markdown'
import { CodeLines, IMG_MIME, isMarkdown, viewKind } from '../shared/file-preview'
import { rpc } from './api'

interface FsEntry { name: string; path: string; isDir: boolean }
interface GitFile { path: string; status: string; index: string; work: string }

function Crumbs({ root, path, onGo }: { root: string; path: string; onGo: (p: string) => void }) {
  const rel = path === root ? '' : path.slice(root.length + 1)
  const parts = rel ? rel.split('/') : []
  return (
    <div className="crumbs mono">
      <button onClick={() => onGo(root)}>{root.slice(root.lastIndexOf('/') + 1) || root}</button>
      {parts.map((p, i) => (
        <span key={i}>
          {' / '}
          <button onClick={() => onGo(`${root}/${parts.slice(0, i + 1).join('/')}`)}>{p}</button>
        </span>
      ))}
    </div>
  )
}

type FileKind = ReturnType<typeof viewKind>

/** Rich text/code rendering: shared markdown + highlighter components. */
function RichText({ name, text }: { name: string; text: string }) {
  if (isMarkdown(name)) return <div style={{ fontSize: 13.5, lineHeight: 1.6 }}><Markdown text={text} /></div>
  return <pre className="filetext">{text ? <CodeLines name={name} text={text} /> : '(empty file)'}</pre>
}

interface Loaded { path: string; text?: string; b64?: string; kind: FileKind }

export function FilesBrowser({ root, onAttach }: {
  root: string
  /** when provided, the preview offers "Add to chat" with the loaded content */
  onAttach?: (a: { name: string; path: string; text: string }) => void
}) {
  const [path, setPath] = useState(root)
  const [entries, setEntries] = useState<FsEntry[] | null>(null)
  const [file, setFile] = useState<Loaded | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback((dir: string) => {
    setBusy(true)
    setErr('')
    setFile(null)
    rpc<{ entries: FsEntry[] }>('rpc_fs_list', dir)
      .then(r => { setEntries(r.entries.filter(e => e.name !== '.git')); setPath(dir) })
      .catch(e => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false))
  }, [])

  useEffect(() => { load(root) }, [root, load])

  const openFile = (p: string) => {
    setBusy(true)
    setErr('')
    const kind = viewKind(p)
    const req = kind === 'image' || kind === 'pdf'
      ? rpc<{ b64: string }>('rpc_fs_b64', p).then(r => setFile({ path: p, b64: r.b64, kind }))
      : rpc<{ text: string }>('rpc_fs_read', p).then(r => setFile({ path: p, text: r.text, kind }))
    req.catch(e => setErr(e instanceof Error ? e.message : String(e))).finally(() => setBusy(false))
  }

  if (file) {
    const name = file.path.slice(file.path.lastIndexOf('/') + 1)
    const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
    return (
      <div>
        <div className="row" style={{ marginBottom: 8 }}>
          <button className="back" onClick={() => setFile(null)}>‹ Files</button>
          <span className="name mono" style={{ fontSize: 12 }}>{name}</span>
        </div>
        {err && <div className="warn">{err}</div>}
        {file.kind === 'image' && file.b64 && (
          <img
            src={`data:${IMG_MIME[ext] ?? 'image/png'};base64,${file.b64}`}
            alt={name}
            style={{ maxWidth: '100%', borderRadius: 12, border: '1px solid var(--line-soft)', display: 'block', margin: '0 auto' }}
          />
        )}
        {file.kind === 'pdf' && file.b64 && (
          <div className="btnrow" style={{ marginTop: 4 }}>
            <button
              className="btn ghost"
              onClick={() => {
                const bytes = Uint8Array.from(atob(file.b64!), c => c.charCodeAt(0))
                const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }))
                window.open(url, '_blank')
              }}
            >
              📄 Open PDF
            </button>
          </div>
        )}
        {(file.kind === 'text' || file.kind === 'office' || file.kind === 'html') && <RichText name={name} text={file.text ?? ''} />}
        {onAttach && file.kind !== 'image' && file.kind !== 'pdf' && (
          <div className="btnrow">
            <button
              className="btn accent"
              onClick={() => onAttach({ name, path: file.path, text: file.text ?? '' })}
            >
              ＋ Add to chat
            </button>
          </div>
        )}
      </div>
    )
  }

  return (
    <div>
      <Crumbs root={root} path={path} onGo={load} />
      {err && <div className="warn">{err}</div>}
      {busy && !entries && <div className="empty">Loading…</div>}
      {entries?.map(e => (
        <button key={e.path} className="card slim" onClick={() => (e.isDir ? load(e.path) : openFile(e.path))}>
          <div className="row">
            <span style={{ flexShrink: 0 }}>{e.isDir ? '📁' : '📄'}</span>
            <span className="name">{e.name}</span>
          </div>
        </button>
      ))}
      {entries && entries.length === 0 && <div className="empty">Empty folder.</div>}
    </div>
  )
}

const STATUS_COLOR: Record<string, string> = { '??': 'var(--green)', A: 'var(--green)', M: 'var(--amber)', D: 'var(--red-soft)' }

function DiffText({ diff }: { diff: string }) {
  return (
    <pre className="filetext mono">
      {diff.split('\n').map((l, i) => (
        <div
          key={i}
          style={{
            color: l.startsWith('+') && !l.startsWith('+++') ? 'var(--green)'
              : l.startsWith('-') && !l.startsWith('---') ? 'var(--red-soft)'
              : l.startsWith('@@') ? 'var(--accent)' : undefined,
          }}
        >
          {l || ' '}
        </div>
      ))}
    </pre>
  )
}

export function GitReview({ root }: { root: string }) {
  const [status, setStatus] = useState<{ root: string; branch: string; files: GitFile[] } | null>(null)
  const [diff, setDiff] = useState<{ path: string; text: string } | null>(null)
  const [err, setErr] = useState('')

  const load = useCallback(() => {
    setErr('')
    rpc<{ root: string; branch: string; files: GitFile[] }>('rpc_git_status', root)
      .then(setStatus)
      .catch(e => setErr(e instanceof Error ? e.message : String(e)))
  }, [root])

  useEffect(() => { load() }, [load])

  const openDiff = (f: GitFile, staged: boolean) => {
    if (!status) return
    setErr('')
    rpc<{ diff: string }>('rpc_git_diff', JSON.stringify({ root: status.root, path: f.path, staged }))
      .then(r => setDiff({ path: f.path, text: r.diff || '(no diff)' }))
      .catch(e => setErr(e instanceof Error ? e.message : String(e)))
  }

  if (diff) {
    return (
      <div>
        <div className="row" style={{ marginBottom: 8 }}>
          <button className="back" onClick={() => setDiff(null)}>‹ Changes</button>
          <span className="name mono" style={{ fontSize: 12 }}>{diff.path}</span>
        </div>
        <DiffText diff={diff.text} />
      </div>
    )
  }

  if (err) return <div className="warn">{err}</div>
  if (!status) return <div className="empty">Loading…</div>

  const staged = status.files.filter(f => f.index !== ' ' && f.index !== '?')
  const unstaged = status.files.filter(f => f.work !== ' ')
  const row = (f: GitFile, isStaged: boolean) => (
    <button key={`${isStaged}:${f.path}`} className="card slim" onClick={() => openDiff(f, isStaged)}>
      <div className="row">
        <span className="mono" style={{ fontSize: 10, fontWeight: 700, color: STATUS_COLOR[f.status === '??' ? '??' : (isStaged ? f.index : f.work)] ?? 'var(--amber)', flexShrink: 0, width: 20 }}>
          {f.status === '??' ? 'NEW' : isStaged ? f.index : f.work}
        </span>
        <span className="name mono" style={{ fontSize: 12 }}>{f.path}</span>
      </div>
    </button>
  )

  return (
    <div>
      <div className="meta mono" style={{ marginBottom: 8 }}>{status.root} · ⎇ {status.branch || 'detached'}</div>
      <div className="section" style={{ marginTop: 4 }}>STAGED · {staged.length}</div>
      {staged.length ? staged.map(f => row(f, true)) : <div className="empty" style={{ padding: '8px 0' }}>nothing staged</div>}
      <div className="section">CHANGES · {unstaged.length}</div>
      {unstaged.length ? unstaged.map(f => row(f, false)) : <div className="empty" style={{ padding: '8px 0' }}>no unstaged changes</div>}
    </div>
  )
}

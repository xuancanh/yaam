import { useState } from 'react'
import { useActions, useConductorSelector, shallowEqual } from '../../store'
import { pickFile } from '../../core/native'
import type { McpServer } from '../../core/types'
import { EditableName, Switch } from '../../components/ui'
import { DraftInput, DraftTextarea } from '../../components/DraftInput'
import { DialogField, DialogFooter, DialogHeader, EntityDialog } from '../../components/EntityDialog'
import { FIELD_STYLE } from './common'
import { SectionLabel } from './SectionLabel'
import { availableCatalog, installMcpb, scanImportableMcpServers } from './mcp-market'
import type { McpCandidate } from './mcp-market'
import { confirmAction } from '../../components/Confirm'

/** Connection status dot + label for one server. */
function mcpStatus(m: McpServer): { color: string; label: string } {
  if (m.lastError) return { color: 'var(--red-soft)', label: 'error' }
  if (m.toolCount !== undefined) return { color: 'var(--green)', label: `${m.toolCount} tools` }
  return { color: 'var(--line3)', label: 'not connected' }
}

/** Spacious popup for one MCP server: transport fields, status, connect. */
function McpDialog({ m, onClose }: { m: McpServer; onClose: () => void }) {
  const { updateMcpServer, removeMcpServer, connectMcpServer } = useActions()
  const stdio = m.transport === 'stdio'
  const st = mcpStatus(m)
  return (
    <EntityDialog onClose={onClose} width={680}>
      <DialogHeader
        onClose={onClose}
        lead={<span style={{ width: 10, height: 10, borderRadius: '50%', background: st.color, marginTop: 8, flexShrink: 0 }} />}
        title={<EditableName name={m.name} onRename={name => updateMcpServer(m.id, { name })} fontSize={15} />}
        sub={<>{stdio ? 'stdio process' : 'streamable HTTP'} · {st.label} · changes save on blur & reconnect</>}
        actions={
          <button className="open-btn" style={{ flex: 'none', padding: '5px 14px', fontSize: 12 }} onClick={() => { void connectMcpServer(m.id) }}>
            {m.toolCount !== undefined ? 'Reconnect' : 'Connect'}
          </button>
        }
      />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        {m.lastError && (
          <div className="mono" style={{
            fontSize: 11, color: 'var(--red-soft)', background: 'rgba(255,92,92,.07)',
            border: '1px solid rgba(255,92,92,.3)', borderRadius: 9, padding: '9px 12px', lineHeight: 1.5, wordBreak: 'break-word',
          }}>
            {m.lastError}
          </div>
        )}

        {stdio ? (
          <>
            <DialogField label="COMMAND" hint="executable + arguments, spawned as a local process">
              <DraftInput
                value={`${m.command ?? ''} ${(m.args ?? []).join(' ')}`.trim()}
                onCommit={v => {
                  const parts = v.trim().split(/\s+/)
                  if (parts[0]) updateMcpServer(m.id, { command: parts[0], args: parts.slice(1) })
                }}
                placeholder="npx -y @modelcontextprotocol/server-github"
                style={{ ...FIELD_STYLE, width: '100%' }}
              />
            </DialogField>
            <DialogField label="ENVIRONMENT" hint="one KEY=value per line (tokens etc.)">
              <DraftTextarea
                value={m.env ?? ''}
                onCommit={v => updateMcpServer(m.id, { env: v })}
                placeholder={'GITHUB_PERSONAL_ACCESS_TOKEN=ghp_…'}
                rows={4}
                style={{ ...FIELD_STYLE, width: '100%', resize: 'vertical', lineHeight: 1.5 }}
              />
            </DialogField>
            <DialogField label="WORKING DIRECTORY" hint="optional — e.g. an unpacked .mcpb bundle dir">
              <DraftInput
                value={m.cwd ?? ''}
                onCommit={v => updateMcpServer(m.id, { cwd: v.trim() || undefined })}
                placeholder="default"
                style={{ ...FIELD_STYLE, width: '100%' }}
              />
            </DialogField>
          </>
        ) : (
          <>
            <DialogField label="URL" hint="endpoint implementing MCP streamable HTTP">
              <DraftInput
                value={m.url}
                onCommit={v => { if (v.trim()) updateMcpServer(m.id, { url: v.trim() }) }}
                placeholder="https://…/mcp"
                style={{ ...FIELD_STYLE, width: '100%' }}
              />
            </DialogField>
            <DialogField label="HEADERS" hint='one "KEY: value" per line (auth tokens etc.)'>
              <DraftTextarea
                value={m.headers ?? ''}
                onCommit={v => updateMcpServer(m.id, { headers: v })}
                placeholder={'Authorization: Bearer sk-…'}
                rows={4}
                style={{ ...FIELD_STYLE, width: '100%', resize: 'vertical', lineHeight: 1.5 }}
              />
            </DialogField>
          </>
        )}

        <div style={{
          display: 'flex', alignItems: 'center', gap: 12, padding: '11px 14px',
          background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 10,
        }}>
          <div style={{ flex: 1, fontSize: 12, color: 'var(--mut)', lineHeight: 1.5 }}>
            <b style={{ color: 'var(--text)' }}>Enabled</b><br />
            <span style={{ color: 'var(--dim)' }}>its tools are offered to chat agents; disabling stops the process</span>
          </div>
          <Switch on={m.enabled} onToggle={() => updateMcpServer(m.id, { enabled: !m.enabled })} />
        </div>
      </div>

      <DialogFooter onClose={onClose}>
        <button
          className="deny-btn"
          style={{ flex: 'none', padding: '8px 16px', color: 'var(--red-soft)', borderColor: 'rgba(255,92,92,.4)' }}
          onClick={() => {
            void confirmAction({ title: `Remove MCP server “${m.name.slice(0, 40)}”?`, detail: 'Stops the server and removes its configuration (including credentials in its env/headers).' })
              .then(ok => { if (ok) { removeMcpServer(m.id); onClose() } })
          }}
        >
          Remove
        </button>
      </DialogFooter>
    </EntityDialog>
  )
}

/** One configured MCP server row — status summary; click for the full editor. */
function McpServerRow({ m, onOpen }: { m: McpServer; onOpen: () => void }) {
  const { updateMcpServer, connectMcpServer } = useActions()
  const stdio = m.transport === 'stdio'
  const detail = stdio ? `${m.command ?? ''} ${(m.args ?? []).join(' ')}`.trim() : m.url
  const st = mcpStatus(m)
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 0', borderBottom: '1px solid var(--line-soft)' }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: st.color }} />
      <div className="palette-item" style={{ flex: 1, minWidth: 0, cursor: 'pointer', borderRadius: 7, padding: '2px 6px', margin: '-2px -6px' }} onClick={onOpen} title="Click to view & edit">
        <div style={{ fontSize: 13, fontWeight: 600 }}>
          {m.name}
          <span className="mono" style={{ fontSize: 10, color: 'var(--dim)', marginLeft: 7 }}>
            {stdio ? 'stdio · ' : ''}{st.label}
          </span>
        </div>
        <div className="mono" title={m.lastError ?? detail} style={{ fontSize: 10.5, color: m.lastError ? 'var(--red-soft)' : 'var(--mut)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {m.lastError ?? detail}
        </div>
      </div>
      <button className="open-btn" style={{ flex: 'none', padding: '4px 11px', fontSize: 11.5 }} onClick={() => { void connectMcpServer(m.id) }}>
        {m.toolCount !== undefined ? 'Reconnect' : 'Connect'}
      </button>
      <Switch on={m.enabled} onToggle={() => updateMcpServer(m.id, { enabled: !m.enabled })} />
    </div>
  )
}

/** One marketplace / import candidate with a one-click add. */
function McpCandidateRow({ c, onAdd }: { c: McpCandidate; onAdd: () => void }) {
  const detail = c.transport === 'http' ? c.url : `${c.command} ${(c.args ?? []).join(' ')}`
  const needsCreds = (c.env ?? '').split('\n').some(l => l.trim().endsWith('='))
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0', borderBottom: '1px solid var(--line-soft)' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600 }}>
          {c.name}
          <span className="mono" style={{ fontSize: 9.5, color: 'var(--dim)', marginLeft: 7 }}>
            {c.source}{c.transport === 'stdio' ? ' · stdio' : ''}{needsCreds ? ' · needs credentials' : ''}
          </span>
        </div>
        <div className="mono" title={detail} style={{ fontSize: 10.5, color: 'var(--mut)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {c.description ?? detail}
        </div>
      </div>
      <button className="open-btn" style={{ flex: 'none', padding: '4px 12px', fontSize: 11.5 }} onClick={onAdd}>
        Add
      </button>
    </div>
  )
}

/** MCP servers chat agents can call tools on: configured list, a curated
 *  marketplace, import from other AI apps' configs, and manual add. */
export function McpSection() {
  const s = useConductorSelector(x => ({ mcpServers: x.mcpServers }), shallowEqual)
  const { addMcpServer } = useActions()
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [headers, setHeaders] = useState('')
  const [marketOpen, setMarketOpen] = useState(false)
  const [imported, setImported] = useState<McpCandidate[] | null>(null)
  const [scanning, setScanning] = useState(false)
  const [bundleError, setBundleError] = useState<string | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const openServer = openId ? s.mcpServers.find(m => m.id === openId) : undefined

  const addCandidate = (c: McpCandidate) => {
    addMcpServer(c.name, c.url ?? '', c.headers, c.transport === 'stdio'
      ? { transport: 'stdio', command: c.command, args: c.args, env: c.env, cwd: c.cwd }
      : { transport: 'http' })
    setImported(cur => cur?.filter(x => x !== c) ?? cur)
  }

  const installBundle = async () => {
    const path = await pickFile(['mcpb', 'dxt', 'zip'], 'MCP bundle')
    if (!path) return
    try {
      addCandidate(await installMcpb(path))
    } catch (e) {
      setBundleError(e instanceof Error ? e.message : String(e))
      window.setTimeout(() => setBundleError(null), 6000)
    }
  }

  const scan = async () => {
    setScanning(true)
    try {
      setImported(await scanImportableMcpServers(s.mcpServers))
    } finally {
      setScanning(false)
    }
  }

  const catalog = marketOpen ? availableCatalog(s.mcpServers) : []

  return (
    <>
      <SectionLabel>MCP SERVERS — tools for chat agents</SectionLabel>
      <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 13, padding: '5px 16px', marginBottom: 26 }}>
        {s.mcpServers.length === 0 && (
          <div style={{ padding: '14px 0', fontSize: 12, color: 'var(--dim)' }}>
            No MCP servers yet — browse the marketplace, import what Claude/Cursor/Codex already use, or add one manually below.
          </div>
        )}
        {s.mcpServers.map(m => <McpServerRow key={m.id} m={m} onOpen={() => setOpenId(m.id)} />)}

        <div style={{ display: 'flex', gap: 8, padding: '12px 0' }}>
          <button className="open-btn" style={{ padding: '5px 13px', fontSize: 12, color: marketOpen ? 'var(--accent)' : undefined }} onClick={() => setMarketOpen(v => !v)}>
            {marketOpen ? 'Hide marketplace' : 'Browse marketplace'}
          </button>
          <button className="open-btn" style={{ padding: '5px 13px', fontSize: 12 }} onClick={() => { void scan() }} disabled={scanning}>
            {scanning ? 'Scanning…' : 'Import from Claude / Cursor / Codex…'}
          </button>
          <button className="open-btn" style={{ padding: '5px 13px', fontSize: 12 }} onClick={() => { void installBundle() }} title="Install a Claude Desktop extension bundle (.mcpb / .dxt)">
            Install .mcpb…
          </button>
        </div>
        {bundleError && <div style={{ fontSize: 11.5, color: 'var(--red-soft)', paddingBottom: 8 }}>{bundleError}</div>}

        {marketOpen && (
          <div style={{ padding: '2px 0 10px' }}>
            <div className="mono" style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.5, color: 'var(--dim)', padding: '4px 0' }}>MARKETPLACE — curated servers (stdio needs Node/uv on PATH)</div>
            {catalog.length
              ? catalog.map(c => <McpCandidateRow key={`${c.source}:${c.name}`} c={c} onAdd={() => addCandidate(c)} />)
              : <div style={{ fontSize: 11.5, color: 'var(--dim)', padding: '6px 0' }}>everything in the catalog is already configured</div>}
          </div>
        )}

        {imported !== null && (
          <div style={{ padding: '2px 0 10px' }}>
            <div className="mono" style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.5, color: 'var(--dim)', padding: '4px 0' }}>FOUND IN OTHER APPS</div>
            {imported.length
              ? imported.map(c => <McpCandidateRow key={`${c.source}:${c.name}:${c.command ?? c.url}`} c={c} onAdd={() => addCandidate(c)} />)
              : <div style={{ fontSize: 11.5, color: 'var(--dim)', padding: '6px 0' }}>nothing new found — no configs, or everything is already imported</div>}
          </div>
        )}

        <div style={{ padding: '13px 0', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="name" style={{ ...FIELD_STYLE, width: 140 }} />
            <input value={url} onChange={e => setUrl(e.target.value)} placeholder="https://…/mcp — or a command like: npx -y some-mcp-server" style={{ ...FIELD_STYLE, flex: 1 }} />
            <button
              className="open-btn"
              style={{ flex: 'none', padding: '6px 13px', fontSize: 12, opacity: url.trim() ? 1 : 0.5 }}
              disabled={!url.trim()}
              onClick={() => {
                const v = url.trim()
                if (/^https?:\/\//.test(v)) addMcpServer(name, v, headers)
                else {
                  const parts = v.split(/\s+/)
                  addMcpServer(name || parts[parts.length - 1], '', undefined, { transport: 'stdio', command: parts[0], args: parts.slice(1), env: headers.includes('=') ? headers : undefined })
                }
                setName(''); setUrl(''); setHeaders('')
              }}
            >
              Add & connect
            </button>
          </div>
          <textarea
            value={headers}
            onChange={e => setHeaders(e.target.value)}
            placeholder={'http: extra headers ("Authorization: Bearer sk-…")  ·  stdio: env ("KEY=value"), one per line'}
            rows={2}
            style={{ ...FIELD_STYLE, resize: 'vertical', fontSize: 11.5 }}
          />
        </div>
      </div>
      {openServer && <McpDialog m={openServer} onClose={() => setOpenId(null)} />}
    </>
  )
}

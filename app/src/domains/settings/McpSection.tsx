import { useState } from 'react'
import { useActions, useConductorSelector, shallowEqual } from '../../store'
import { pickFile } from '../../core/native'
import { IC, Icon, Switch } from '../../components/ui'
import { FIELD_STYLE } from './common'
import { SectionLabel } from './SectionLabel'
import { availableCatalog, installMcpb, scanImportableMcpServers } from './mcp-market'
import type { McpCandidate } from './mcp-market'

/** One configured MCP server row: status, connect, enable, remove, and an
 *  expandable editor (stdio command/env/cwd or http url/headers). */
function McpServerRow({ m }: { m: import('../../core/types').McpServer }) {
  const { updateMcpServer, removeMcpServer, connectMcpServer } = useActions()
  const [open, setOpen] = useState(false)
  const stdio = m.transport === 'stdio'
  const detail = stdio ? `${m.command ?? ''} ${(m.args ?? []).join(' ')}`.trim() : m.url
  return (
    <div style={{ padding: '12px 0', borderBottom: '1px solid var(--line-soft)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{
          width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
          background: m.lastError ? 'var(--red-soft)' : m.toolCount !== undefined ? 'var(--green)' : 'var(--line3)',
        }} />
        <div style={{ flex: 1, minWidth: 0, cursor: 'pointer' }} onClick={() => setOpen(v => !v)} title="Click to edit">
          <div style={{ fontSize: 13, fontWeight: 600 }}>
            {m.name}
            <span className="mono" style={{ fontSize: 10, color: 'var(--dim)', marginLeft: 7 }}>
              {stdio ? 'stdio · ' : ''}{m.lastError ? 'error' : m.toolCount !== undefined ? `${m.toolCount} tools` : 'not connected'}
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
        <button className="icon-btn danger" title="Remove server" style={{ width: 26, height: 26 }} onClick={() => removeMcpServer(m.id)}>
          <Icon paths={IC.close} size={12} stroke={2} />
        </button>
      </div>
      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7, padding: '10px 0 2px 20px' }}>
          {stdio ? (
            <>
              <input
                defaultValue={detail}
                placeholder="command and args, e.g. npx -y @modelcontextprotocol/server-github"
                onBlur={e => {
                  const parts = e.target.value.trim().split(/\s+/)
                  if (parts[0]) updateMcpServer(m.id, { command: parts[0], args: parts.slice(1) })
                }}
                style={{ ...FIELD_STYLE, fontSize: 11.5 }}
              />
              <textarea
                defaultValue={m.env ?? ''}
                placeholder={'environment, one per line — e.g.\nGITHUB_PERSONAL_ACCESS_TOKEN=ghp_…'}
                rows={2}
                onBlur={e => updateMcpServer(m.id, { env: e.target.value })}
                style={{ ...FIELD_STYLE, resize: 'vertical', fontSize: 11.5 }}
              />
            </>
          ) : (
            <>
              <input
                defaultValue={m.url}
                placeholder="https://…/mcp"
                onBlur={e => { if (e.target.value.trim()) updateMcpServer(m.id, { url: e.target.value.trim() }) }}
                style={{ ...FIELD_STYLE, fontSize: 11.5 }}
              />
              <textarea
                defaultValue={m.headers ?? ''}
                placeholder={'extra headers, one per line — e.g.\nAuthorization: Bearer sk-…'}
                rows={2}
                onBlur={e => updateMcpServer(m.id, { headers: e.target.value })}
                style={{ ...FIELD_STYLE, resize: 'vertical', fontSize: 11.5 }}
              />
            </>
          )}
        </div>
      )}
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
        {s.mcpServers.map(m => <McpServerRow key={m.id} m={m} />)}

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
    </>
  )
}

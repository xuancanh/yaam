import { useState } from 'react'
import type { ReactNode } from 'react'
import { useActions, useConductorSelector, shallowEqual } from '../../store'
import { APPEARANCE_DEFAULTS } from '../../app/appearance'
import type { AppearanceSettings } from '../../core/types'
import { hexToRgba } from '../../core/data'
import { pickFile, pickFolder } from '../../core/native'
import { PROVIDERS, providerFor } from '../../master'
import { SHELLS } from '../../core/data'
import { EditableName, IC, Icon, Switch, ViewHeader } from '../../components/ui'
import { ToolsSection } from './ToolsView'
import { availableCatalog, installMcpb, scanImportableMcpServers } from './mcp-market'
import type { McpCandidate } from './mcp-market'
import { DEFAULT_PLUGIN_REGISTRY, fetchPluginMarketplace, resolvePluginInstall } from './plugin-market'
import type { PluginEntry } from './plugin-market'

const FIELD_STYLE = {
  background: 'var(--bg)', border: '1px solid var(--line2)', borderRadius: 8,
  padding: '7px 10px', color: 'var(--text)', outline: 'none', fontSize: 12.5,
  fontFamily: 'var(--font-mono)',
} as const

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
function McpSection() {
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

/** One plugin row inside a browsed marketplace. */
function PluginRow({ p, installed, onInstall }: { p: PluginEntry; installed: string | null; onInstall: () => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--line-soft)' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600 }}>
          {p.name}
          {p.category && <span className="mono" style={{ fontSize: 9.5, color: 'var(--dim)', marginLeft: 7 }}>{p.category}</span>}
          {p.author && <span className="mono" style={{ fontSize: 9.5, color: 'var(--faint)', marginLeft: 7 }}>{p.author}</span>}
        </div>
        <div title={p.description} style={{ fontSize: 11, color: 'var(--mut)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {installed ?? p.description ?? ''}
        </div>
      </div>
      <button
        className="open-btn"
        style={{ flex: 'none', padding: '4px 12px', fontSize: 11.5, opacity: p.loc && !installed ? 1 : 0.5 }}
        disabled={!p.loc || !!installed}
        title={p.loc ? 'Import this plugin’s skills/commands + MCP servers for chat agents' : 'Not hosted on GitHub — install manually'}
        onClick={onInstall}
      >
        {installed ? 'Installed' : 'Install'}
      </button>
    </div>
  )
}

/** Claude plugin marketplaces: browse a marketplace repo and install plugins
 *  for chat — skills/commands become skill registries, .mcp.json becomes MCP
 *  servers. Claude-Code-only parts (agents, hooks) are skipped. */
function PluginsSection() {
  const s = useConductorSelector(x => ({ settings: x.settings, skillRegistries: x.skillRegistries, mcpServers: x.mcpServers }), shallowEqual)
  const { updateSettings, addSkillRegistry, addMcpServer } = useActions()
  const registries = s.settings.pluginRegistries ?? [DEFAULT_PLUGIN_REGISTRY]
  const [open, setOpen] = useState<string | null>(null)
  const [plugins, setPlugins] = useState<PluginEntry[]>([])
  const [filter, setFilter] = useState('')
  const [status, setStatus] = useState<string | null>(null)
  const [installed, setInstalled] = useState<Record<string, string>>({})
  const [newUrl, setNewUrl] = useState('')

  const browse = async (url: string) => {
    if (open === url) { setOpen(null); return }
    setStatus('loading marketplace…')
    try {
      const market = await fetchPluginMarketplace(url)
      setPlugins(market.plugins)
      setOpen(url)
      setStatus(null)
    } catch (e) {
      setStatus(`could not load marketplace: ${e instanceof Error ? e.message : e}`)
    }
  }

  const install = async (p: PluginEntry) => {
    setInstalled(cur => ({ ...cur, [p.name]: 'installing…' }))
    try {
      const res = await resolvePluginInstall(p)
      const haveReg = new Set(s.skillRegistries.map(r => r.url))
      let regs = 0
      for (const reg of res.skillRegistries) {
        if (haveReg.has(reg.url)) continue
        addSkillRegistry(reg.name, reg.url)
        regs++
      }
      const haveMcp = new Set(s.mcpServers.map(m => m.transport === 'stdio' ? `${m.command} ${(m.args ?? []).join(' ')}` : m.url))
      let mcps = 0
      for (const c of res.mcpServers) {
        const fp = c.transport === 'stdio' ? `${c.command} ${(c.args ?? []).join(' ')}` : c.url
        if (fp && haveMcp.has(fp)) continue
        addMcpServer(c.name, c.url ?? '', c.headers, c.transport === 'stdio'
          ? { transport: 'stdio', command: c.command, args: c.args, env: c.env }
          : { transport: 'http' })
        mcps++
      }
      const parts = [
        regs ? `${regs} skill registr${regs > 1 ? 'ies' : 'y'}` : '',
        mcps ? `${mcps} MCP server${mcps > 1 ? 's' : ''}` : '',
        res.skipped.length ? `skipped: ${res.skipped.join(', ')}` : '',
      ].filter(Boolean)
      setInstalled(cur => ({ ...cur, [p.name]: `installed — ${parts.join(' · ') || 'already present'}` }))
    } catch (e) {
      setInstalled(cur => {
        const next = { ...cur }
        delete next[p.name]
        return next
      })
      setStatus(`${p.name}: ${e instanceof Error ? e.message : e}`)
    }
  }

  const shown = plugins.filter(p => {
    const q = filter.trim().toLowerCase()
    return !q || p.name.toLowerCase().includes(q) || (p.description ?? '').toLowerCase().includes(q) || (p.category ?? '').toLowerCase().includes(q)
  }).slice(0, 60)

  return (
    <>
      <SectionLabel>PLUGIN MARKETPLACES — Claude plugins (skills, commands, MCP) for chat agents</SectionLabel>
      <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 13, padding: '5px 16px', marginBottom: 26 }}>
        {registries.map(reg => (
          <div key={reg.url} style={{ padding: '10px 0', borderBottom: '1px solid var(--line-soft)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{reg.name}</div>
                <div className="mono" style={{ fontSize: 10.5, color: 'var(--mut)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{reg.url}</div>
              </div>
              <button className="open-btn" style={{ flex: 'none', padding: '4px 12px', fontSize: 11.5, color: open === reg.url ? 'var(--accent)' : undefined }} onClick={() => { void browse(reg.url) }}>
                {open === reg.url ? 'Close' : 'Browse'}
              </button>
              <button
                className="icon-btn danger"
                title="Remove marketplace"
                style={{ width: 24, height: 24 }}
                onClick={() => updateSettings({ pluginRegistries: registries.filter(r => r.url !== reg.url) })}
              >
                <Icon paths={IC.close} size={11} stroke={2} />
              </button>
            </div>
            {open === reg.url && (
              <div style={{ padding: '8px 0 4px' }}>
                <input
                  value={filter}
                  onChange={e => setFilter(e.target.value)}
                  placeholder={`search ${plugins.length} plugins…`}
                  style={{ ...FIELD_STYLE, width: '100%', marginBottom: 4 }}
                />
                <div style={{ maxHeight: 320, overflowY: 'auto' }}>
                  {shown.map(p => <PluginRow key={p.name} p={p} installed={installed[p.name] ?? null} onInstall={() => { void install(p) }} />)}
                  {!shown.length && <div style={{ fontSize: 11.5, color: 'var(--dim)', padding: '8px 0' }}>no plugins match</div>}
                </div>
              </div>
            )}
          </div>
        ))}
        {status && <div style={{ fontSize: 11.5, color: 'var(--amber)', padding: '8px 0' }}>{status}</div>}
        <div style={{ display: 'flex', gap: 8, padding: '11px 0' }}>
          <input value={newUrl} onChange={e => setNewUrl(e.target.value)} placeholder="add a marketplace — GitHub repo with .claude-plugin/marketplace.json" style={{ ...FIELD_STYLE, flex: 1 }} />
          <button
            className="open-btn"
            style={{ flex: 'none', padding: '6px 13px', fontSize: 12, opacity: newUrl.trim() ? 1 : 0.5 }}
            disabled={!newUrl.trim()}
            onClick={() => {
              const url = newUrl.trim().replace(/\/$/, '')
              if (!registries.some(r => r.url === url)) {
                updateSettings({ pluginRegistries: [...registries, { name: url.split('/').pop() ?? url, url }] })
              }
              setNewUrl('')
            }}
          >
            Add
          </button>
        </div>
      </div>
    </>
  )
}

/** Skills registry: reusable instruction packs chat agents load on demand. */
function SkillsSection() {
  const s = useConductorSelector(x => ({ skills: x.skills }), shallowEqual)
  const { addSkill, updateSkill, removeSkill } = useActions()
  const [openId, setOpenId] = useState<string | null>(null)

  return (
    <>
      <SectionLabel>SKILLS — reusable instructions for chat agents</SectionLabel>
      <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 13, padding: '5px 16px', marginBottom: 26 }}>
        {s.skills.map(sk => (
          <div key={sk.id} style={{ padding: '11px 0', borderBottom: '1px solid var(--line-soft)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <button
                onClick={() => setOpenId(openId === sk.id ? null : sk.id)}
                style={{ background: 'transparent', border: 'none', color: 'var(--dim)', fontSize: 10, width: 16, cursor: 'pointer' }}
              >
                {openId === sk.id ? '▾' : '▸'}
              </button>
              <div style={{ flex: 1, minWidth: 0 }}>
                <span className="mono" style={{ fontSize: 12.5, fontWeight: 600 }}>{sk.name}</span>
                <span style={{ fontSize: 11.5, color: 'var(--mut)', marginLeft: 8 }}>{sk.description || 'no description'}</span>
              </div>
              <button className="icon-btn danger" title="Remove skill" style={{ width: 24, height: 24 }} onClick={() => removeSkill(sk.id)}>
                <Icon paths={IC.close} size={11} stroke={2} />
              </button>
            </div>
            {openId === sk.id && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 7, padding: '9px 0 4px 26px' }}>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input value={sk.name} onChange={e => updateSkill(sk.id, { name: e.target.value.replace(/\s+/g, '-').toLowerCase() })} placeholder="name (agents load it by this)" style={{ ...FIELD_STYLE, width: 200 }} />
                  <input value={sk.description} onChange={e => updateSkill(sk.id, { description: e.target.value })} placeholder="one-line description — agents pick skills by this" style={{ ...FIELD_STYLE, flex: 1 }} />
                </div>
                <textarea
                  value={sk.body}
                  onChange={e => updateSkill(sk.id, { body: e.target.value })}
                  placeholder="the instructions injected when a chat agent loads this skill"
                  rows={4}
                  style={{ ...FIELD_STYLE, resize: 'vertical', fontFamily: 'var(--font-sans)', lineHeight: 1.5 }}
                />
              </div>
            )}
          </div>
        ))}
        <div style={{ padding: '12px 0' }}>
          <button className="open-btn" style={{ flex: 'none', padding: '6px 13px', fontSize: 12 }} onClick={() => setOpenId(addSkill())}>
            New skill
          </button>
        </div>
      </div>
    </>
  )
}

/** Personas: named voices/roles a chat adopts (picked per chat). */
function PersonasSection() {
  const s = useConductorSelector(x => ({ personas: x.personas }), shallowEqual)
  const { addPersona, updatePersona, removePersona } = useActions()
  const [openId, setOpenId] = useState<string | null>(null)

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 11 }}>
        <SectionLabel>PERSONAS — pick one when starting a chat; appended to the agent's instructions</SectionLabel>
        <button className="open-btn" style={{ flex: 'none', padding: '4px 12px', fontSize: 11.5, marginBottom: 11 }} onClick={() => setOpenId(addPersona())}>
          + New persona
        </button>
      </div>
      <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 13, padding: '5px 16px', marginBottom: 26 }}>
        {s.personas.length === 0 && (
          <div style={{ padding: '14px 0', fontSize: 12, color: 'var(--dim)' }}>No personas yet.</div>
        )}
        {s.personas.map(pe => (
          <div key={pe.id} style={{ padding: '11px 0', borderBottom: '1px solid var(--line-soft)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <button
                onClick={() => setOpenId(openId === pe.id ? null : pe.id)}
                style={{ background: 'transparent', border: 'none', color: 'var(--dim)', fontSize: 10, width: 16, cursor: 'pointer' }}
              >
                {openId === pe.id ? '▾' : '▸'}
              </button>
              <div style={{ flex: 1, minWidth: 0 }}>
                <span className="mono" style={{ fontSize: 12.5, fontWeight: 600 }}>{pe.name}</span>
                <span style={{ fontSize: 11.5, color: 'var(--mut)', marginLeft: 8 }}>{pe.description || 'no description'}</span>
              </div>
              <button className="icon-btn danger" title="Remove persona" style={{ width: 24, height: 24 }} onClick={() => removePersona(pe.id)}>
                <Icon paths={IC.close} size={11} stroke={2} />
              </button>
            </div>
            {openId === pe.id && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 7, padding: '9px 0 4px 26px' }}>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input value={pe.name} onChange={e => updatePersona(pe.id, { name: e.target.value.replace(/\s+/g, '-').toLowerCase() })} placeholder="name" style={{ ...FIELD_STYLE, width: 200 }} />
                  <input value={pe.description} onChange={e => updatePersona(pe.id, { description: e.target.value })} placeholder="one-line description (shown in the picker)" style={{ ...FIELD_STYLE, flex: 1 }} />
                </div>
                <textarea
                  value={pe.body}
                  onChange={e => updatePersona(pe.id, { body: e.target.value })}
                  placeholder="the persona instructions appended to the chat agent's system prompt"
                  rows={4}
                  style={{ ...FIELD_STYLE, resize: 'vertical', fontFamily: 'var(--font-sans)', lineHeight: 1.5 }}
                />
              </div>
            )}
          </div>
        ))}
      </div>
    </>
  )
}

/** Skill registries: remote (github tree) or local-folder skill sources. */
function SkillRegistriesSection() {
  const s = useConductorSelector(x => ({ skillRegistries: x.skillRegistries }), shallowEqual)
  const { addSkillRegistry, updateSkillRegistry, removeSkillRegistry, refreshSkillRegistry } = useActions()
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')

  return (
    <>
      <SectionLabel>SKILL REGISTRIES — SKILL.md folders (GitHub tree URL or local path)</SectionLabel>
      <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 13, padding: '5px 16px', marginBottom: 26 }}>
        {s.skillRegistries.map(r => (
          <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 0', borderBottom: '1px solid var(--line-soft)' }}>
            <span style={{
              width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
              background: r.lastError ? 'var(--red-soft)' : r.skillCount !== undefined ? 'var(--green)' : 'var(--line3)',
            }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>
                {r.name}
                <span className="mono" style={{ fontSize: 10, color: 'var(--dim)', marginLeft: 7 }}>
                  {r.lastError ? 'error' : r.skillCount !== undefined ? `${r.skillCount} skills` : 'not fetched'}
                </span>
              </div>
              <div className="mono" title={r.lastError ?? r.url} style={{ fontSize: 10.5, color: r.lastError ? 'var(--red-soft)' : 'var(--mut)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {r.lastError ?? r.url}
              </div>
            </div>
            <button className="open-btn" style={{ flex: 'none', padding: '4px 11px', fontSize: 11.5 }} onClick={() => { void refreshSkillRegistry(r.id) }}>
              Refresh
            </button>
            <Switch on={r.enabled} onToggle={() => updateSkillRegistry(r.id, { enabled: !r.enabled })} />
            <button className="icon-btn danger" title="Remove registry" style={{ width: 26, height: 26 }} onClick={() => removeSkillRegistry(r.id)}>
              <Icon paths={IC.close} size={12} stroke={2} />
            </button>
          </div>
        ))}
        <div style={{ padding: '13px 0', display: 'flex', gap: 8 }}>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="name" style={{ ...FIELD_STYLE, width: 140 }} />
          <input value={url} onChange={e => setUrl(e.target.value)} placeholder="https://github.com/o/r/tree/main/skills — or /local/folder" style={{ ...FIELD_STYLE, flex: 1 }} />
          <button
            className="open-btn"
            style={{ flex: 'none', padding: '6px 13px', fontSize: 12, opacity: url.trim() ? 1 : 0.5 }}
            disabled={!url.trim()}
            onClick={() => { addSkillRegistry(name, url); setName(''); setUrl('') }}
          >
            Add & fetch
          </button>
        </div>
      </div>
    </>
  )
}

/** Small header button that adds a chat-agent type (needs its own hook scope). */
function AddChatTypeButton() {
  const { addChatAgentType } = useActions()
  return (
    <button className="open-btn" style={{ flex: 'none', padding: '4px 12px', fontSize: 11.5 }} onClick={addChatAgentType}>
      + Add chat agent
    </button>
  )
}

/** Configurable chat-agent types: provider, model, credentials, persona. */
function ChatTypesSection() {
  const s = useConductorSelector(x => ({ chatAgentTypes: x.chatAgentTypes, settings: x.settings }), shallowEqual)
  const { updateChatAgentType, deleteChatAgentType } = useActions()
  return (
    <>
      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))', marginBottom: 26 }}>
        {s.chatAgentTypes.map(t => {
          const prov = providerFor(t.provider)
          const needsBase = prov.models.length === 0
          const sharesMaster = t.provider === s.settings.provider && !t.apiKey
          return (
            <div key={t.id} style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 13, padding: 15, display: 'flex', gap: 12 }}>
              <div className="mono" style={{
                width: 38, height: 38, borderRadius: 10, background: hexToRgba('#7FD1FF', 0.14),
                border: '1px solid ' + hexToRgba('#7FD1FF', 0.4), display: 'flex', alignItems: 'center',
                justifyContent: 'center', fontSize: 12, fontWeight: 600, color: '#7FD1FF', flexShrink: 0,
              }}>
                {t.name.slice(0, 2).toUpperCase()}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <EditableName name={t.name} onRename={name => updateChatAgentType(t.id, { name })} />
                  <button
                    className="icon-btn danger"
                    title="Delete chat agent type"
                    style={{ width: 22, height: 22, borderRadius: 6, marginLeft: 'auto' }}
                    onClick={() => deleteChatAgentType(t.id)}
                  >
                    <Icon paths={IC.close} size={11} stroke={2} />
                  </button>
                </div>
                {t.desc && <div style={{ fontSize: 12, color: 'var(--mut)', marginTop: 4, lineHeight: 1.45 }}>{t.desc}</div>}
                <div style={{ display: 'flex', gap: 6, marginTop: 8, minWidth: 0 }}>
                  <select
                    value={t.provider}
                    onChange={e => {
                      const next = providerFor(e.target.value)
                      updateChatAgentType(t.id, { provider: next.id, models: next.models.length ? next.models : [], model: next.models[0] ?? '' })
                    }}
                    className="select-field"
                    style={{ ...FIELD_STYLE, flex: 1, minWidth: 0, padding: '5px 9px', fontSize: 11.5 }}
                  >
                    {PROVIDERS.map(pr => <option key={pr.id} value={pr.id}>{pr.label}</option>)}
                  </select>
                  {prov.models.length > 0 && (
                    <button
                      className="open-btn"
                      title="Fill the model list with this provider's known models"
                      style={{ flex: 'none', padding: '0 10px', fontSize: 10.5 }}
                      onClick={() => updateChatAgentType(t.id, { models: prov.models, model: prov.models[0] })}
                    >
                      defaults
                    </button>
                  )}
                </div>
                <textarea
                  value={(t.models ?? (t.model ? [t.model] : [])).join('\n')}
                  onChange={e => {
                    const models = e.target.value.split('\n').map(x => x.trim())
                    updateChatAgentType(t.id, { models, model: models.find(Boolean) ?? '' })
                  }}
                  placeholder={'models — one per line, first is the default\n' + (prov.models[0] ?? 'model-id')}
                  rows={Math.min(5, Math.max(2, (t.models?.length ?? 1) + 1))}
                  title="Pickable per session in the new-session dialog; the first line is the default"
                  style={{ ...FIELD_STYLE, width: '100%', marginTop: 6, padding: '5px 9px', fontSize: 11.5, resize: 'vertical', minHeight: 34 }}
                />
                {t.provider !== 'bedrock' && (
                  <input
                    type="password"
                    value={t.apiKey ?? ''}
                    onChange={e => updateChatAgentType(t.id, { apiKey: e.target.value || undefined })}
                    placeholder={sharesMaster ? 'API key (empty = share Master Brain credentials)' : 'API key · ' + prov.keyHint}
                    style={{ ...FIELD_STYLE, width: '100%', marginTop: 6, padding: '5px 9px', fontSize: 11.5 }}
                  />
                )}
                {needsBase && (
                  <input
                    value={t.baseUrl ?? ''}
                    onChange={e => updateChatAgentType(t.id, { baseUrl: e.target.value || undefined })}
                    placeholder={prov.protocol === 'anthropic' ? 'base URL · https://…  (Anthropic-compatible /v1/messages)' : 'base URL · https://…/v1  (OpenAI-compatible)'}
                    style={{ ...FIELD_STYLE, width: '100%', marginTop: 6, padding: '5px 9px', fontSize: 11.5 }}
                  />
                )}
                <textarea
                  value={t.systemPrompt ?? ''}
                  onChange={e => updateChatAgentType(t.id, { systemPrompt: e.target.value || undefined })}
                  placeholder="persona (optional) · appended to the agent's system prompt"
                  rows={2}
                  style={{ ...FIELD_STYLE, width: '100%', marginTop: 6, padding: '5px 9px', fontSize: 11, resize: 'vertical', minHeight: 30, fontFamily: 'var(--font-sans)' }}
                />
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 10 }}>
                  <span style={{ fontSize: 11, color: t.enabled ? 'var(--green)' : '#6B7280', fontWeight: 600 }}>
                    {t.enabled ? 'Enabled' : 'Disabled'}{t.provider === 'bedrock' ? ' · AWS chain' : t.apiKey ? ' · own key' : sharesMaster ? ' · shares Master creds' : ' · no credentials'}
                  </span>
                  <Switch on={t.enabled} onToggle={() => updateChatAgentType(t.id, { enabled: !t.enabled })} />
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </>
  )
}

/** One labeled appearance row with the control on the right. */
function AppearanceRow({ label, detail, children, last }: { label: string; detail: string; children: ReactNode; last?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '13px 0', borderBottom: last ? 'none' : '1px solid var(--line-soft)' }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600 }}>{label}</div>
        <div style={{ fontSize: 12, color: 'var(--mut)', marginTop: 2 }}>{detail}</div>
      </div>
      {children}
    </div>
  )
}

/** Theme, UI scale, density, and typography (Settings → General). */
function AppearanceSection() {
  const s = useConductorSelector(x => ({ appearance: x.settings.appearance }), shallowEqual)
  const { updateSettings } = useActions()
  const a = { ...APPEARANCE_DEFAULTS, ...s.appearance }
  const patch = (p: AppearanceSettings) => updateSettings({ appearance: { ...s.appearance, ...p } })
  return (
    <>
      <SectionLabel>APPEARANCE</SectionLabel>
      <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 13, padding: '5px 16px', marginBottom: 26 }}>
        <AppearanceRow label="Theme" detail="Color palette for the whole app; System follows the OS light/dark setting.">
          <select value={a.theme} onChange={e => patch({ theme: e.target.value as AppearanceSettings['theme'] })} style={{ ...FIELD_STYLE, width: 160 }}>
            <option value="dark">Dark</option>
            <option value="midnight">Midnight</option>
            <option value="light">Light</option>
            <option value="system">System</option>
          </select>
        </AppearanceRow>
        <AppearanceRow label="Interface scale" detail="Scales all text and spacing together.">
          <input
            type="range" min={80} max={140} step={5}
            value={a.uiScale}
            onChange={e => patch({ uiScale: Number(e.target.value) })}
            style={{ width: 150 }}
          />
          <span className="mono" style={{ fontSize: 12, width: 44, textAlign: 'right' }}>{a.uiScale}%</span>
        </AppearanceRow>
        <AppearanceRow label="Density" detail="Row spacing and message padding in chats and lists.">
          <select value={a.density} onChange={e => patch({ density: e.target.value as AppearanceSettings['density'] })} style={{ ...FIELD_STYLE, width: 160 }}>
            <option value="compact">Compact</option>
            <option value="normal">Normal</option>
            <option value="comfortable">Comfortable</option>
          </select>
        </AppearanceRow>
        <AppearanceRow label="Interface font" detail="The sans-serif face used across the app.">
          <select value={a.uiFont} onChange={e => patch({ uiFont: e.target.value as AppearanceSettings['uiFont'] })} style={{ ...FIELD_STYLE, width: 160 }}>
            <option value="plex">IBM Plex Sans</option>
            <option value="system">System</option>
            <option value="grotesk">Space Grotesk</option>
          </select>
        </AppearanceRow>
        <AppearanceRow label="Monospace font" detail="Code, paths, terminals-adjacent labels.">
          <select value={a.monoFont} onChange={e => patch({ monoFont: e.target.value as AppearanceSettings['monoFont'] })} style={{ ...FIELD_STYLE, width: 160 }}>
            <option value="jetbrains">JetBrains Mono</option>
            <option value="system">System mono</option>
          </select>
        </AppearanceRow>
        <AppearanceRow label="Table typography" detail="Font size and family for markdown tables in chat replies." last>
          <input
            type="number" min={10} max={20}
            value={a.tableFontSize}
            onChange={e => patch({ tableFontSize: Math.max(10, Math.min(20, Number(e.target.value) || 13)) })}
            style={{ ...FIELD_STYLE, width: 64 }}
          />
          <select value={a.tableFont} onChange={e => patch({ tableFont: e.target.value as AppearanceSettings['tableFont'] })} style={{ ...FIELD_STYLE, width: 120 }}>
            <option value="sans">Sans</option>
            <option value="mono">Mono</option>
          </select>
        </AppearanceRow>
      </div>
    </>
  )
}

/** Render a consistent settings-section heading. */
function SectionLabel({ children }: { children: string }) {
  return (
    <div className="mono" style={{ fontSize: 11, fontWeight: 600, letterSpacing: 0.5, color: 'var(--mut)', marginBottom: 11 }}>
      {children}
    </div>
  )
}

const ORCHESTRATION: Array<{ id: 'autoRoute' | 'approveDestructive' | 'followMode'; label: string; detail: string }> = [
  { id: 'autoRoute', label: 'Auto-route requests', detail: 'Master assigns tasks to the right agent without asking first.' },
  { id: 'approveDestructive', label: 'Require approval for destructive actions', detail: 'Migrations, file deletes, and deploys pause for your sign-off.' },
  { id: 'followMode', label: 'Follow mode', detail: 'Master watches every session and escalates when action is needed.' },
]

/** Render global provider, orchestration, session, agent-type, and addon settings. */
const SETTINGS_TABS = [
  ['general', 'General'],
  ['appearance', 'Appearance'],
  ['brain', 'Master Brain'],
  ['types', 'Terminal Agents'],
  ['chatagents', 'Chat Agents'],
  ['mcp', 'MCP Servers'],
  ['tools', 'Tools & Permissions'],
] as const
type SettingsTab = (typeof SETTINGS_TABS)[number][0]

export function SettingsView() {
  const s = useConductorSelector(x => ({ settings: x.settings, agentTypes: x.agentTypes }), shallowEqual)
  const { toggleSetting, toggleAgentType, updateSettings, setAgentTypeCmd, updateAgentType, addAgentType, deleteAgentType } = useActions()
  const [tab, setTab] = useState<SettingsTab>('general')
  const [chatTab, setChatTab] = useState<'agents' | 'personas' | 'skills'>('agents')

  // Fill the default working directory from the native folder picker.
  const browseDefaultCwd = async () => {
    const dir = await pickFolder(s.settings.defaultCwd || undefined)
    if (dir) updateSettings({ defaultCwd: dir })
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <ViewHeader title="Settings">
        <span style={{ fontSize: 11.5, color: 'var(--dim)' }}>Agent types, MCP servers, skills, and orchestration policy</span>
      </ViewHeader>
      <div style={{
        display: 'flex', gap: 4, padding: '10px 22px 0', borderBottom: '1px solid var(--line)',
        background: 'var(--panel)', flexShrink: 0,
      }}>
        {SETTINGS_TABS.map(([id, label]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            style={{
              background: 'transparent', border: 'none', padding: '8px 14px 10px', fontSize: 12.5,
              fontWeight: 600, cursor: 'pointer',
              color: tab === id ? 'var(--accent)' : 'var(--mut)',
              borderBottom: `2px solid ${tab === id ? 'var(--accent)' : 'transparent'}`,
              marginBottom: -1,
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: 22 }}>
        <div style={{ maxWidth: 820 }}>

          {tab === 'brain' && <>
          <SectionLabel>MASTER BRAIN</SectionLabel>
          <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 13, padding: '5px 16px', marginBottom: 26 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 0', borderBottom: '1px solid var(--line-soft)' }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600 }}>LLM Master</div>
                <div style={{ fontSize: 12, color: 'var(--mut)', marginTop: 2 }}>
                  Master is an LLM with tools — it routes tasks to sessions, launches and stops them, and builds schedules. Pick a provider and add credentials — an API key, or AWS Bedrock via your credential chain.
                </div>
              </div>
              <Switch on={s.settings.masterEnabled} onToggle={() => updateSettings({ masterEnabled: !s.settings.masterEnabled })} />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 0', borderBottom: '1px solid var(--line-soft)' }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600 }}>Provider</div>
              </div>
              <select
                value={s.settings.provider}
                onChange={e => {
                  const next = providerFor(e.target.value)
                  updateSettings({ provider: next.id, masterModel: next.models[0] ?? '' })
                }}
                style={{ ...FIELD_STYLE, width: 260 }}
              >
                {PROVIDERS.map(pr => <option key={pr.id} value={pr.id}>{pr.label}</option>)}
              </select>
            </div>
            {providerFor(s.settings.provider).id === 'bedrock' && (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 0', borderBottom: '1px solid var(--line-soft)' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 600 }}>AWS region</div>
                    <div style={{ fontSize: 12, color: 'var(--mut)', marginTop: 2 }}>Region hosting the Bedrock inference profile.</div>
                  </div>
                  <input
                    value={s.settings.awsRegion}
                    onChange={e => updateSettings({ awsRegion: e.target.value })}
                    placeholder="us-east-1"
                    style={{ ...FIELD_STYLE, width: 260 }}
                  />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 0', borderBottom: '1px solid var(--line-soft)' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 600 }}>AWS profile</div>
                    <div style={{ fontSize: 12, color: 'var(--mut)', marginTop: 2 }}>
                      Profile from ~/.aws/config (SSO profiles auto-refresh their tokens). Empty = default credential chain: env vars, default profile, instance role.
                    </div>
                  </div>
                  <input
                    value={s.settings.awsProfile}
                    onChange={e => updateSettings({ awsProfile: e.target.value })}
                    placeholder="default"
                    style={{ ...FIELD_STYLE, width: 260 }}
                  />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 0', borderBottom: '1px solid var(--line-soft)' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 600 }}>Credential command</div>
                    <div style={{ fontSize: 12, color: 'var(--mut)', marginTop: 2 }}>
                      Optional — overrides the profile. Any shell command that prints AWS credentials as JSON{' '}
                      (<span className="mono">aws configure export-credentials</span>,{' '}
                      <span className="mono">claude default-credential-export</span>) or{' '}
                      <span className="mono">AWS_*</span> env lines. Edit freely, including the binary path. Cached until the
                      credentials expire, then re-run automatically.
                    </div>
                  </div>
                  <input
                    value={s.settings.credCmd}
                    onChange={e => updateSettings({ credCmd: e.target.value })}
                    placeholder="claude default-credential-export"
                    style={{ ...FIELD_STYLE, width: 260 }}
                  />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 0', borderBottom: '1px solid var(--line-soft)' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 600 }}>Credential refresh command</div>
                    <div style={{ fontSize: 12, color: 'var(--mut)', marginTop: 2 }}>
                      Optional. Runs automatically when Bedrock rejects expired credentials, then the call retries — e.g. <span className="mono">aws sso login --profile work</span> or your corporate credential tool.
                    </div>
                  </div>
                  <input
                    value={s.settings.awsRefreshCmd}
                    onChange={e => updateSettings({ awsRefreshCmd: e.target.value })}
                    placeholder="aws sso login --profile …"
                    style={{ ...FIELD_STYLE, width: 260 }}
                  />
                </div>
              </>
            )}
            {providerFor(s.settings.provider).id === 'custom' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 0', borderBottom: '1px solid var(--line-soft)' }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600 }}>Base URL</div>
                  <div style={{ fontSize: 12, color: 'var(--mut)', marginTop: 2 }}>OpenAI-compatible endpoint root, e.g. http://localhost:11434/v1</div>
                </div>
                <input
                  value={s.settings.baseUrl}
                  onChange={e => updateSettings({ baseUrl: e.target.value })}
                  placeholder="https://…/v1"
                  style={{ ...FIELD_STYLE, width: 260 }}
                />
              </div>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 0', borderBottom: '1px solid var(--line-soft)' }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600 }}>Model</div>
                <div style={{ fontSize: 12, color: 'var(--mut)', marginTop: 2 }}>Type any model id — suggestions per provider.</div>
              </div>
              <input
                list="master-models"
                value={s.settings.masterModel}
                onChange={e => updateSettings({ masterModel: e.target.value })}
                placeholder="model id"
                style={{ ...FIELD_STYLE, width: 260 }}
              />
              <datalist id="master-models">
                {providerFor(s.settings.provider).models.map(m => <option key={m} value={m} />)}
              </datalist>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 0', borderBottom: '1px solid var(--line-soft)' }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600 }}>Monitor model</div>
                <div style={{ fontSize: 12, color: 'var(--mut)', marginTop: 2 }}>
                  Each session gets its own monitor LLM that watches output and only escalates digests to Master. Use a cheap model.
                </div>
              </div>
              <input
                list="master-models"
                value={s.settings.monitorModel}
                onChange={e => updateSettings({ monitorModel: e.target.value })}
                placeholder="same as Master model"
                style={{ ...FIELD_STYLE, width: 260 }}
              />
            </div>
            {providerFor(s.settings.provider).id !== 'bedrock' && (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 0', borderBottom: '1px solid var(--line-soft)' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 600 }}>API key</div>
                    <div style={{ fontSize: 12, color: 'var(--mut)', marginTop: 2 }}>Stored locally in the app data folder. Leave empty if you use a credential command below.</div>
                  </div>
                  <input
                    type="password"
                    value={s.settings.apiKey}
                    onChange={e => updateSettings({ apiKey: e.target.value })}
                    placeholder={providerFor(s.settings.provider).keyHint}
                    style={{ ...FIELD_STYLE, width: 260 }}
                  />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 0' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 600 }}>Credential command</div>
                    <div style={{ fontSize: 12, color: 'var(--mut)', marginTop: 2 }}>
                      Optional — overrides the API key. Any shell command that prints the credential (raw key/token or JSON), e.g.{' '}
                      <span className="mono">claude default-credential-export</span> — edit freely, including the binary path{' '}
                      (<span className="mono">~/.claude/local/claude …</span>) or flags. Runs in a login shell, is cached until the
                      credential expires, and re-runs automatically when the API rejects it, so short-lived tokens keep working.
                    </div>
                  </div>
                  <input
                    value={s.settings.credCmd}
                    onChange={e => updateSettings({ credCmd: e.target.value })}
                    placeholder="claude default-credential-export"
                    style={{ ...FIELD_STYLE, width: 260 }}
                  />
                </div>
              </>
            )}
          </div>

          </>}

          {tab === 'appearance' && <AppearanceSection />}

          {tab === 'general' && <>
          <SectionLabel>SESSION DEFAULTS</SectionLabel>
          <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 13, padding: '5px 16px', marginBottom: 26 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 0', borderBottom: '1px solid var(--line-soft)' }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600 }}>Terminal shell</div>
                <div style={{ fontSize: 12, color: 'var(--mut)', marginTop: 2 }}>Used when launching a plain terminal session.</div>
              </div>
              <select
                value={s.settings.shell}
                onChange={e => updateSettings({ shell: e.target.value })}
                style={{ ...FIELD_STYLE, width: 160 }}
              >
                {SHELLS.map(sh => <option key={sh} value={sh}>{sh}</option>)}
              </select>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 0' }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600 }}>Default working directory</div>
                <div style={{ fontSize: 12, color: 'var(--mut)', marginTop: 2 }}>Prefilled in the new-session dialog.</div>
              </div>
              <input
                value={s.settings.defaultCwd}
                onChange={e => updateSettings({ defaultCwd: e.target.value })}
                placeholder="none"
                style={{ ...FIELD_STYLE, width: 220 }}
              />
              <button className="open-btn" style={{ flex: 'none', padding: '7px 12px' }} onClick={browseDefaultCwd}>Browse…</button>
            </div>
          </div>

          <SectionLabel>ORCHESTRATION</SectionLabel>
          <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 13, padding: '5px 16px', marginBottom: 26 }}>
            {ORCHESTRATION.map(o => (
              <div key={o.id} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 0', borderBottom: '1px solid var(--line-soft)' }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600 }}>{o.label}</div>
                  <div style={{ fontSize: 12, color: 'var(--mut)', marginTop: 2 }}>{o.detail}</div>
                </div>
                <Switch on={s.settings[o.id]} onToggle={() => toggleSetting(o.id)} />
              </div>
            ))}
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 0' }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600 }}>Desktop notifications</div>
                <div style={{ fontSize: 12, color: 'var(--mut)', marginTop: 2 }}>Escalations and finished work reach the OS notification center while YAAM is in the background.</div>
              </div>
              <Switch
                on={s.settings.osNotifications !== false}
                onToggle={() => updateSettings({ osNotifications: s.settings.osNotifications === false })}
              />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 0', borderTop: '1px solid var(--line-soft)' }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600 }}>GitHub token</div>
                <div style={{ fontSize: 12, color: 'var(--mut)', marginTop: 2 }}>
                  Personal access token for skill registries, plugin marketplaces, and MCP catalogs — lifts the 60 req/h unauthenticated API limit. Stored in the OS keychain.
                </div>
              </div>
              <input
                type="password"
                defaultValue={s.settings.githubToken ?? ''}
                placeholder="ghp_… / github_pat_…"
                onBlur={e => updateSettings({ githubToken: e.target.value.trim() })}
                style={{ ...FIELD_STYLE, width: 240 }}
              />
            </div>
          </div>

          </>}

          {tab === 'types' && <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 11 }}>
            <SectionLabel>TERMINAL AGENTS — external CLIs in PTY sessions</SectionLabel>
            <button className="open-btn" style={{ flex: 'none', padding: '4px 12px', fontSize: 11.5, marginBottom: 11 }} onClick={addAgentType}>+ Add terminal agent</button>
          </div>
          <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))', marginBottom: 26 }}>
            {s.agentTypes.map(t => (
              <div key={t.id} style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 13, padding: 15, display: 'flex', gap: 12 }}>
                <div className="mono" style={{
                  width: 38, height: 38, borderRadius: 10, background: hexToRgba(t.color, 0.14),
                  border: `1px solid ${hexToRgba(t.color, 0.4)}`, display: 'flex', alignItems: 'center',
                  justifyContent: 'center', fontSize: 12, fontWeight: 600, color: t.color, flexShrink: 0,
                }}>
                  {t.name.slice(0, 2).toUpperCase()}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <EditableName name={t.name} onRename={name => updateAgentType(t.id, { name })} />
                    {t.custom && (
                      <button
                        className="icon-btn danger"
                        title="Delete agent type"
                        style={{ width: 22, height: 22, borderRadius: 6, marginLeft: 'auto' }}
                        onClick={() => deleteAgentType(t.id)}
                      >
                        <Icon paths={IC.close} size={11} stroke={2} />
                      </button>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--mut)', marginTop: 4, lineHeight: 1.45 }}>{t.desc}</div>
                  <input
                    value={t.model}
                    onChange={e => setAgentTypeCmd(t.id, e.target.value)}
                    placeholder="launch command · e.g. claude"
                    title="Command used to launch this agent type"
                    style={{ ...FIELD_STYLE, width: '100%', marginTop: 8, padding: '5px 9px', fontSize: 11.5 }}
                  />
                  <textarea
                    value={t.env ?? ''}
                    onChange={e => updateAgentType(t.id, { env: e.target.value })}
                    placeholder={'environment · one per line\nANTHROPIC_MODEL=claude-sonnet-5\nHTTP_PROXY=…'}
                    rows={2}
                    title="Environment variables applied when launching this agent type"
                    style={{ ...FIELD_STYLE, width: '100%', marginTop: 6, padding: '5px 9px', fontSize: 11, resize: 'vertical', minHeight: 34 }}
                  />
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 10 }}>
                    <span style={{ fontSize: 11, color: t.enabled ? 'var(--green)' : '#6B7280', fontWeight: 600 }}>
                      {t.enabled ? 'Enabled' : 'Disabled'} · {t.tools} tools
                    </span>
                    <Switch on={t.enabled} onToggle={() => toggleAgentType(t.id)} />
                  </div>
                </div>
              </div>
            ))}
          </div>
          </>}

          {tab === 'chatagents' && <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
            <div style={{ display: 'flex', gap: 4, background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 9, padding: 3 }}>
              {([['agents', 'Agents'], ['personas', 'Personas'], ['skills', 'Skills']] as const).map(([id, label]) => (
                <button
                  key={id}
                  onClick={() => setChatTab(id)}
                  style={{
                    border: 'none', borderRadius: 6, padding: '6px 14px', fontSize: 12, fontWeight: 600, cursor: 'pointer',
                    background: chatTab === id ? 'rgba(245,196,81,.14)' : 'transparent',
                    color: chatTab === id ? 'var(--accent)' : 'var(--mut)',
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            <div style={{ flex: 1 }} />
            {chatTab === 'agents' && <AddChatTypeButton />}
          </div>
          {chatTab === 'agents' && <>
            <div style={{ fontSize: 11.5, color: 'var(--dim)', marginBottom: 12, lineHeight: 1.5 }}>
              Each chat agent picks a provider, a model list (pickable per chat), credentials, and an optional base persona. Empty API key = share the Master Brain credentials when the provider matches.
            </div>
            <ChatTypesSection />
          </>}
          {chatTab === 'personas' && <PersonasSection />}
          {chatTab === 'skills' && <>
            <PluginsSection />
            <SkillRegistriesSection />
            <SkillsSection />
          </>}
          </>}

          {tab === 'mcp' && <McpSection />}

          {tab === 'tools' && <>
          <SectionLabel>MASTER TOOLS — what Master may do; click a permission to cycle it</SectionLabel>
          <ToolsSection />
          </>}

        </div>
      </div>
    </div>
  )
}

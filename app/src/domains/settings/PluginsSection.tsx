import { useState } from 'react'
import { useActions, useConductorSelector, shallowEqual } from '../../store'
import { IC, Icon } from '../../components/ui'
import { FIELD_STYLE } from './common'
import { SectionLabel } from './SectionLabel'
import { DEFAULT_PLUGIN_REGISTRY, fetchPluginMarketplace, resolvePluginInstall } from './plugin-market'
import type { PluginEntry } from './plugin-market'

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
export function PluginsSection() {
  const s = useConductorSelector(x => ({ settings: x.settings, skillRegistries: x.skillRegistries, mcpServers: x.mcpServers, personas: x.personas }), shallowEqual)
  const { updateSettings, addSkillRegistry, addMcpServer, addPersona, updatePersona, installAddonJson } = useActions()
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
      // plugin agents arrive as personas (pickable when starting a chat)
      const havePersona = new Set(s.personas.map(pe => pe.name))
      let personas = 0
      for (const pe of res.personas) {
        if (havePersona.has(pe.name)) continue
        updatePersona(addPersona(), pe)
        personas++
      }
      // hooks arrive as a generated addon; its exec scope stays ungranted
      // until the user enables it in Settings → Addons
      if (res.hookAddonJson) installAddonJson(res.hookAddonJson)
      const parts = [
        regs ? `${regs} skill registr${regs > 1 ? 'ies' : 'y'}` : '',
        mcps ? `${mcps} MCP server${mcps > 1 ? 's' : ''}` : '',
        personas ? `${personas} persona${personas > 1 ? 's' : ''}` : '',
        res.hookAddonJson ? 'hooks addon (grant exec to activate)' : '',
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

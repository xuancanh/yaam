import { useCallback, useEffect, useState } from 'react'
import { useActions, useConductor } from '../../store'
import { httpGetText, readTextFile } from '../../core/native'
import { ALL_PERMISSIONS } from '../../core/addons'
import type { Addon } from '../../types'
import { IC, Icon, Switch, ViewHeader } from '../../components/ui'

// VS-Code-marketplace-style addon manager: sidebar (installed + market from
// every configured registry + registry management), detail pane, AI generator.

interface RegistryEntry {
  name: string
  version?: string
  icon?: string
  description?: string
  url: string
  /** which registry it came from */
  registry: string
}

const FIELD = {
  width: '100%', background: 'var(--bg)', border: '1px solid var(--line2)', borderRadius: 8,
  padding: '7px 10px', color: 'var(--text)', outline: 'none', fontSize: 12,
  fontFamily: "'JetBrains Mono', monospace",
} as const

const isHttp = (u: string) => /^https?:\/\//.test(u)

/** Load one registry index — http(s) URL, local index.json, or local folder. */
async function fetchIndex(url: string): Promise<{ packages: Omit<RegistryEntry, 'registry'>[]; base: string }> {
  const indexPath = isHttp(url) || /\.json$/.test(url) ? url : `${url.replace(/\/$/, '')}/index.json`
  const text = isHttp(indexPath) ? await httpGetText(indexPath) : await readTextFile(indexPath)
  const json = JSON.parse(text)
  const base = indexPath.replace(/\/[^/]*$/, '')
  return { packages: Array.isArray(json.packages) ? json.packages : [], base }
}

/** Resolve a package url from an index: absolute stays, relative joins the index dir. */
function resolvePkgUrl(pkgUrl: string, base: string): string {
  if (isHttp(pkgUrl) || pkgUrl.startsWith('/')) return pkgUrl
  return `${base}/${pkgUrl.replace(/^\.\//, '')}`
}

function GenerateDialog({ onClose }: { onClose: () => void }) {
  const { generateAddon } = useActions()
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const go = async () => {
    if (!prompt.trim() || busy) return
    setBusy(true)
    setError('')
    const err = await generateAddon(prompt.trim())
    setBusy(false)
    if (err) setError(err)
    else onClose()
  }

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(4,5,8,.55)', zIndex: 46, display: 'flex', justifyContent: 'center', alignItems: 'flex-start', paddingTop: '14vh' }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 540, maxWidth: '92vw', background: 'var(--panel2)', border: '1px solid var(--line2)', borderRadius: 15, boxShadow: '0 26px 70px rgba(0,0,0,.6)', padding: 20 }}>
        <div className="grotesk" style={{ fontWeight: 600, fontSize: 15, marginBottom: 4 }}>✦ Generate an addon</div>
        <div style={{ fontSize: 12, color: 'var(--mut)', marginBottom: 12, lineHeight: 1.55 }}>
          Describe what you want — a tab, Master tools, lifecycle hooks, even the addon's own agent. The generator knows the full
          addon API (tasks with criteria and watcher chat, session output, templates, schedules, storage) and installs the result
          immediately; permissions stay visible and revocable.
        </div>
        <textarea
          autoFocus
          value={prompt}
          onChange={e => setPrompt(e.target.value)}
          rows={5}
          placeholder={'e.g. A "standup" tab summarizing what every session did today, with a button that files follow-up tasks for anything that failed…'}
          style={{ ...FIELD, fontFamily: "'IBM Plex Sans', system-ui, sans-serif", fontSize: 12.5, resize: 'vertical', lineHeight: 1.5 }}
        />
        {error && <div style={{ fontSize: 11.5, color: 'var(--red-soft)', marginTop: 8 }}>{error}</div>}
        <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
          <button className="approve-btn" style={{ flex: 1, padding: 9, opacity: prompt.trim() && !busy ? 1 : 0.45 }} disabled={!prompt.trim() || busy} onClick={go}>
            {busy ? 'Generating… (validates & installs)' : 'Generate & install'}
          </button>
          <button className="deny-btn" style={{ flex: 'none', padding: '9px 16px' }} onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  )
}

/** Detail pane for an installed addon. */
function InstalledDetail({ a }: { a: Addon }) {
  const { toggleAddon, toggleAddonGrant, removeAddon, exportAddon, openAddon } = useActions()
  const parts = [
    a.html ? 'view' : '', a.tools?.length ? `${a.tools.length} tool(s)` : '',
    a.hooks ? 'hooks' : '', a.agent ? 'agent' : '',
  ].filter(Boolean)
  return (
    <div style={{ padding: 26, maxWidth: 640 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <span style={{ fontSize: 34 }}>{a.icon}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="grotesk" style={{ fontSize: 18, fontWeight: 600 }}>{a.name}</div>
          <div className="mono" style={{ fontSize: 11, color: 'var(--dim)', marginTop: 2 }}>
            v{a.version} · {a.source}{a.author ? ` · ${a.author}` : ''} · installed {a.createdAt}
          </div>
        </div>
        <Switch on={a.enabled} onToggle={() => toggleAddon(a.id)} />
      </div>
      <div style={{ fontSize: 13, color: '#C7CCD6', lineHeight: 1.6, marginTop: 14 }}>{a.desc || 'No description.'}</div>
      <div className="mono" style={{ fontSize: 11, color: 'var(--mut)', marginTop: 8 }}>ships: {parts.join(' · ') || 'nothing?'}</div>

      <div className="mono" style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: 0.4, color: 'var(--dim)', margin: '20px 0 8px' }}>PERMISSIONS — click to grant / revoke</div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {a.permissions.map(perm => {
          const on = a.granted.includes(perm)
          const label = ALL_PERMISSIONS.find(x => x.id === perm)?.label ?? perm
          return (
            <button
              key={perm}
              title={`${label} — click to ${on ? 'revoke' : 'grant'}`}
              onClick={() => toggleAddonGrant(a.id, perm)}
              className="mono"
              style={{
                fontSize: 10.5, fontWeight: 600, padding: '4px 10px', borderRadius: 6, border: '1px solid', cursor: 'pointer',
                borderColor: on ? 'rgba(61,220,151,.35)' : 'var(--line2)',
                background: on ? 'rgba(61,220,151,.1)' : 'transparent',
                color: on ? 'var(--green)' : 'var(--dim)',
                textDecoration: on ? 'none' : 'line-through',
              }}
            >
              {perm}
            </button>
          )
        })}
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 24 }}>
        {a.html && <button className="approve-btn" style={{ padding: '8px 18px' }} onClick={() => openAddon(a.id)}>Open tab</button>}
        <button className="open-btn" style={{ flex: 'none', padding: '8px 16px' }} onClick={() => exportAddon(a.id)}>Export .yaam.json</button>
        <button className="deny-btn" style={{ flex: 'none', padding: '8px 16px' }} onClick={() => removeAddon(a.id)}>Uninstall</button>
      </div>
      <div style={{ fontSize: 11, color: 'var(--dim)', lineHeight: 1.5, marginTop: 18 }}>
        ⚠ Tools, hooks, and agents run with app privileges (bounded by the granted scopes above). Views stay sandboxed.
      </div>
    </div>
  )
}

/** Detail pane for a marketplace entry. */
function MarketDetail({ e, installed }: { e: RegistryEntry; installed?: Addon }) {
  const { installAddonFromUrl } = useActions()
  return (
    <div style={{ padding: 26, maxWidth: 640 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <span style={{ fontSize: 34 }}>{e.icon || '◆'}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="grotesk" style={{ fontSize: 18, fontWeight: 600 }}>{e.name}</div>
          <div className="mono" style={{ fontSize: 11, color: 'var(--dim)', marginTop: 2 }}>
            {e.version ? `v${e.version} · ` : ''}registry: {e.registry}
          </div>
        </div>
      </div>
      <div style={{ fontSize: 13, color: '#C7CCD6', lineHeight: 1.6, marginTop: 14 }}>{e.description || 'No description.'}</div>
      <div className="mono" style={{ fontSize: 10.5, color: 'var(--dim)', marginTop: 10, wordBreak: 'break-all' }}>{e.url}</div>
      <div style={{ display: 'flex', gap: 8, marginTop: 24 }}>
        <button className="approve-btn" style={{ padding: '8px 20px' }} onClick={() => installAddonFromUrl(e.url)}>
          {installed ? (installed.version === e.version ? 'Reinstall' : `Update (installed v${installed.version})`) : 'Install'}
        </button>
        {installed && <span className="mono" style={{ alignSelf: 'center', fontSize: 11, color: 'var(--green)' }}>✓ installed</span>}
      </div>
      <div style={{ fontSize: 11, color: 'var(--dim)', lineHeight: 1.5, marginTop: 18 }}>
        Permissions are shown and adjustable after install; upgrades keep your grant choices.
      </div>
    </div>
  )
}

export function AddonsView() {
  const s = useConductor()
  const { installAddonFromFile, installAddonFromFolder, updateSettings } = useActions()
  const [query, setQuery] = useState('')
  const [market, setMarket] = useState<RegistryEntry[]>([])
  const [regErrors, setRegErrors] = useState<Record<string, string>>({})
  const [selected, setSelected] = useState<{ kind: 'installed' | 'market'; key: string } | null>(null)
  const [generating, setGenerating] = useState(false)
  const [newRegName, setNewRegName] = useState('')
  const [newRegUrl, setNewRegUrl] = useState('')

  const registries = s.settings.registries
    ?? (s.settings.registryUrl ? [{ name: 'yaam', url: s.settings.registryUrl }] : [])

  const refresh = useCallback(async () => {
    const all: RegistryEntry[] = []
    const errors: Record<string, string> = {}
    await Promise.all(registries.map(async reg => {
      try {
        const { packages, base } = await fetchIndex(reg.url)
        for (const p of packages) all.push({ ...p, url: resolvePkgUrl(p.url, base), registry: reg.name })
      } catch (e) {
        errors[reg.name] = e instanceof Error ? e.message : String(e)
      }
    }))
    setMarket(all)
    setRegErrors(errors)
  }, [registries.map(r => r.url).join('|')]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { void refresh() }, [refresh])

  const q = query.toLowerCase().trim()
  const match = (name: string, desc?: string) => !q || name.toLowerCase().includes(q) || (desc ?? '').toLowerCase().includes(q)
  const installed = s.addons.filter(a => match(a.name, a.desc))
  const available = market.filter(e => match(e.name, e.description))
  const byName = new Map(s.addons.map(a => [a.name.toLowerCase(), a]))

  const sel = selected?.kind === 'installed'
    ? s.addons.find(a => a.id === selected.key)
    : selected?.kind === 'market'
      ? market.find(e => e.url === selected.key)
      : undefined

  const addRegistry = () => {
    const url = newRegUrl.trim()
    if (!url) return
    const name = newRegName.trim() || (isHttp(url) ? new URL(url).hostname : 'local')
    updateSettings({ registries: [...registries.filter(r => r.url !== url), { name, url }] })
    setNewRegName('')
    setNewRegUrl('')
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <ViewHeader title="Addons">
        <span style={{ fontSize: 11.5, color: 'var(--dim)' }}>Views, Master tools, hooks, and agents — installable, permission-scoped, LLM-generatable</span>
        <div style={{ flex: 1 }} />
        <button className="approve-btn" style={{ flex: 'none', padding: '6px 14px', fontSize: 12 }} onClick={() => setGenerating(true)}>✦ Generate…</button>
        <button className="open-btn" style={{ flex: 'none', padding: '6px 12px', fontSize: 12 }} onClick={installAddonFromFile}>Install file…</button>
        <button className="open-btn" title="Multi-file addon: addon.yaml + view.html / tools/*.js / hooks/*.js" style={{ flex: 'none', padding: '6px 12px', fontSize: 12 }} onClick={installAddonFromFolder}>Install folder…</button>
      </ViewHeader>
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <div style={{ width: 320, flexShrink: 0, borderRight: '1px solid var(--line)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div style={{ padding: '12px 14px 8px' }}>
            <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search addons…" style={FIELD} />
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '0 8px 14px' }}>
            <div className="mono" style={{ fontSize: 9.5, fontWeight: 600, letterSpacing: 0.4, color: 'var(--dim)', padding: '10px 8px 6px' }}>
              INSTALLED · {installed.length}
            </div>
            {installed.map(a => (
              <button
                key={a.id}
                className="palette-item"
                onClick={() => setSelected({ kind: 'installed', key: a.id })}
                style={{
                  width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '9px 10px', borderRadius: 9,
                  background: selected?.kind === 'installed' && selected.key === a.id ? 'rgba(245,196,81,.08)' : 'transparent',
                  border: 'none', textAlign: 'left',
                }}
              >
                <span style={{ fontSize: 17, width: 22, textAlign: 'center', opacity: a.enabled ? 1 : 0.4 }}>{a.icon}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600, color: a.enabled ? 'var(--text)' : 'var(--dim)' }}>
                    {a.name} <span className="mono" style={{ fontSize: 9.5, color: 'var(--dim)' }}>v{a.version}</span>
                  </div>
                  <div style={{ fontSize: 10.5, color: 'var(--mut)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.desc || a.source}</div>
                </div>
                {!a.enabled && <span className="mono" style={{ fontSize: 9, color: 'var(--dim)' }}>off</span>}
              </button>
            ))}
            {!installed.length && <div style={{ fontSize: 11.5, color: 'var(--dim)', padding: '2px 10px 8px' }}>nothing installed{q ? ' matches' : ' yet'}</div>}

            <div className="mono" style={{ fontSize: 9.5, fontWeight: 600, letterSpacing: 0.4, color: 'var(--dim)', padding: '14px 8px 6px' }}>
              MARKETPLACE · {available.length}
            </div>
            {available.map(e => {
              const inst = byName.get(e.name.toLowerCase())
              return (
                <button
                  key={`${e.registry}:${e.url}`}
                  className="palette-item"
                  onClick={() => setSelected({ kind: 'market', key: e.url })}
                  style={{
                    width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '9px 10px', borderRadius: 9,
                    background: selected?.kind === 'market' && selected.key === e.url ? 'rgba(245,196,81,.08)' : 'transparent',
                    border: 'none', textAlign: 'left',
                  }}
                >
                  <span style={{ fontSize: 17, width: 22, textAlign: 'center' }}>{e.icon || '◆'}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 600 }}>
                      {e.name} <span className="mono" style={{ fontSize: 9.5, color: 'var(--dim)' }}>{e.version ? `v${e.version}` : ''} · {e.registry}</span>
                    </div>
                    <div style={{ fontSize: 10.5, color: 'var(--mut)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{e.description}</div>
                  </div>
                  {inst && <span className="mono" style={{ fontSize: 9, color: 'var(--green)' }}>✓</span>}
                </button>
              )
            })}
            {!available.length && <div style={{ fontSize: 11.5, color: 'var(--dim)', padding: '2px 10px' }}>no packages{q ? ' match' : ''}</div>}

            <div className="mono" style={{ fontSize: 9.5, fontWeight: 600, letterSpacing: 0.4, color: 'var(--dim)', padding: '16px 8px 6px' }}>
              REGISTRIES
            </div>
            {registries.map(r => (
              <div key={r.url} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px' }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: regErrors[r.name] ? 'var(--red-soft)' : 'var(--green)', flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 11.5, fontWeight: 600 }}>{r.name} {!isHttp(r.url) && <span className="mono" style={{ fontSize: 9, color: 'var(--accent)' }}>local</span>}</div>
                  <div className="mono" title={regErrors[r.name] ?? r.url} style={{ fontSize: 9.5, color: regErrors[r.name] ? 'var(--red-soft)' : 'var(--dim)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {regErrors[r.name] ?? r.url}
                  </div>
                </div>
                <button className="icon-btn danger" title="Remove registry" style={{ width: 20, height: 20, borderRadius: 5, flexShrink: 0 }}
                  onClick={() => updateSettings({ registries: registries.filter(x => x.url !== r.url) })}>
                  <Icon paths={IC.close} size={10} stroke={2} />
                </button>
              </div>
            ))}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 10px 0' }}>
              <input value={newRegName} onChange={e => setNewRegName(e.target.value)} placeholder="name (optional)" style={{ ...FIELD, fontSize: 11 }} />
              <div style={{ display: 'flex', gap: 6 }}>
                <input value={newRegUrl} onChange={e => setNewRegUrl(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') addRegistry() }}
                  placeholder="https://…/index.json or /local/folder" style={{ ...FIELD, fontSize: 11 }} />
                <button className="open-btn" style={{ flex: 'none', padding: '0 12px', fontSize: 11.5, opacity: newRegUrl.trim() ? 1 : 0.5 }} disabled={!newRegUrl.trim()} onClick={addRegistry}>Add</button>
              </div>
              <div style={{ fontSize: 10, color: 'var(--dim)', lineHeight: 1.5 }}>
                A registry is any index.json (see the repo's registry/) — served over http(s) or a local folder.
              </div>
            </div>
          </div>
        </div>
        <div style={{ flex: 1, minWidth: 0, overflowY: 'auto', background: '#0A0B0F' }}>
          {sel && selected?.kind === 'installed'
            ? <InstalledDetail a={sel as Addon} />
            : sel && selected?.kind === 'market'
              ? <MarketDetail e={sel as RegistryEntry} installed={byName.get((sel as RegistryEntry).name.toLowerCase())} />
              : (
                <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 10 }}>
                  <div style={{ fontSize: 30, opacity: 0.5 }}>🧩</div>
                  <div className="grotesk" style={{ fontSize: 15, fontWeight: 600, color: 'var(--mut)' }}>Pick an addon</div>
                  <div style={{ fontSize: 12, color: 'var(--dim)', maxWidth: 340, textAlign: 'center', lineHeight: 1.6 }}>
                    Install from a registry, a file, or a folder — or describe one and let ✦ Generate build it against the full addon API.
                  </div>
                </div>
              )}
        </div>
      </div>
      {generating && <GenerateDialog onClose={() => setGenerating(false)} />}
    </div>
  )
}

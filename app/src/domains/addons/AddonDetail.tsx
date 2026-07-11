// Per-addon settings & permissions panel — shared between the Addons manager's
// detail pane and the Settings tab inside an open addon view.
import { useEffect, useState } from 'react'
import { useActions } from '../../store'
import { secretGet, secretSet } from '../../core/native'
import { ALL_PERMISSIONS } from '../../core/addons'
import type { Addon } from '../../core/types'
import { Switch } from '../../components/ui'
import { confirmAction } from '../../components/Confirm'

const FIELD = {
  width: '100%', background: 'var(--bg)', border: '1px solid var(--line2)', borderRadius: 8,
  padding: '7px 10px', color: 'var(--text)', outline: 'none', fontSize: 12,
  fontFamily: 'var(--font-mono)',
} as const

/** One declared secret slot: shows set/unset and takes a new value straight
 *  into the OS keychain — the value never enters app state or addon code. */
function SecretRow({ addonId, name, label }: { addonId: string; name: string; label?: string }) {
  const account = `addon:${addonId}:${name}`
  const [isSet, setIsSet] = useState<boolean | null>(null)
  const [draft, setDraft] = useState('')
  useEffect(() => {
    let alive = true
    void secretGet(account).then(v => { if (alive) setIsSet(!!v) })
    return () => { alive = false }
  }, [account])
  const save = () => {
    if (!draft.trim()) return
    void secretSet(account, draft.trim()).then(() => { setIsSet(true); setDraft('') })
  }
  const clear = () => { void secretSet(account, '').then(() => setIsSet(false)) }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
      <span style={{ width: 7, height: 7, borderRadius: '50%', flex: 'none', background: isSet ? 'var(--green)' : 'var(--line2)' }} />
      <span className="mono" style={{ fontSize: 11, fontWeight: 600, minWidth: 120 }}>{name}</span>
      <input
        type="password"
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') save() }}
        placeholder={isSet ? 'set — enter to replace' : label || 'enter value'}
        style={{ ...FIELD, flex: 1, padding: '5px 9px', fontSize: 11 }}
      />
      <button className="open-btn" style={{ padding: '5px 12px', opacity: draft.trim() ? 1 : 0.45 }} disabled={!draft.trim()} onClick={save}>Save</button>
      {isSet && <button className="deny-btn" style={{ padding: '5px 10px' }} onClick={clear}>Clear</button>}
    </div>
  )
}

/** Settings & permissions for an installed addon. `inTab` hides the "Open tab"
 *  button when the panel is already rendered inside that tab. */
export function AddonDetail({ a, inTab }: { a: Addon; inTab?: boolean }) {
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
      <div style={{ fontSize: 13, color: 'var(--text2)', lineHeight: 1.6, marginTop: 14 }}>{a.desc || 'No description.'}</div>
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

      {!!a.hosts?.length && (
        <div className="mono" style={{ fontSize: 11, color: 'var(--mut)', marginTop: 14 }}>
          network allowlist: {a.hosts.join(' · ')}
        </div>
      )}

      {!!a.secrets?.length && (
        <>
          <div className="mono" style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: 0.4, color: 'var(--dim)', margin: '20px 0 2px' }}>
            SECRETS — stored in the OS keychain, never shown to addon code
          </div>
          {a.secrets.map(sd => <SecretRow key={sd.name} addonId={a.id} name={sd.name} label={sd.label} />)}
        </>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 24 }}>
        {a.html && !inTab && <button className="approve-btn" style={{ padding: '8px 18px' }} onClick={() => openAddon(a.id)}>Open tab</button>}
        <button className="open-btn" style={{ flex: 'none', padding: '8px 16px' }} onClick={() => exportAddon(a.id)}>Export .yaam.json</button>
        <button className="deny-btn" style={{ flex: 'none', padding: '8px 16px' }} onClick={() => { void confirmAction({ title: `Uninstall addon “${a.name.slice(0, 40)}”?`, detail: 'Removes the addon, its tools, hooks, and stored data. Reinstalling starts fresh.', confirmLabel: 'Uninstall' }).then(ok => { if (ok) removeAddon(a.id) }) }}>Uninstall</button>
      </div>
      <div style={{ fontSize: 11, color: 'var(--dim)', lineHeight: 1.5, marginTop: 18 }}>
        ⚠ Tools, hooks, and agents run with app privileges (bounded by the granted scopes above). Views stay sandboxed.
      </div>
    </div>
  )
}

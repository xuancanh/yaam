import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { useActions, useConductorSelector, shallowEqual } from '../../store'
import { AddonSource } from './AddonSource'
import { AddonDetail } from './AddonDetail'
import { AddonFrame } from './AddonFrame'
import type { Addon } from '../../core/types'
import { IC, Icon, MasterMark, ViewHeader } from '../../components/ui'
import { confirmAction } from '../../components/Confirm'

/** Host the scoped LLM customization conversation for one addon package. */
function AddonChat({ addon }: { addon: Addon }) {
  const s = useConductorSelector(x => ({ addonChats: x.addonChats, addonChatBusy: x.addonChatBusy }), shallowEqual)
  const { sendAddonChat } = useActions()
  const [draft, setDraft] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const msgs = s.addonChats[addon.id] ?? []
  const busy = s.addonChatBusy === addon.id

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [msgs.length, busy])

  // Send the customization prompt and clear the local composer.
  const send = () => {
    if (!draft.trim() || busy) return
    sendAddonChat(addon.id, draft.trim())
    setDraft('')
  }
  // Send on Enter while preserving Shift+Enter for multiline input.
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, background: 'var(--bg2)' }}>
      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: 18, display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 760, width: '100%', margin: '0 auto' }}>
        {msgs.length === 0 && (
          <div style={{ color: 'var(--dim)', fontSize: 12.5, lineHeight: 1.6, padding: '20px 0' }}>
            This chat customizes only “{addon.name}”. Try: “add a refresh timestamp”, “make the bars green”,
            “also notify me when total cost passes $5”, “add a tool that restarts idle sessions”.
          </div>
        )}
        {msgs.map((m, i) => m.role === 'you' ? (
          <div key={i} style={{ alignSelf: 'flex-end', maxWidth: '85%', background: 'var(--panel3)', border: '1px solid var(--line2)', borderRadius: '12px 12px 3px 12px', padding: '8px 12px', fontSize: 13, lineHeight: 1.5 }}>
            {m.text}
          </div>
        ) : (
          <div key={i} style={{ display: 'flex', gap: 10, maxWidth: '85%' }}>
            <div style={{ marginTop: 2 }}><MasterMark size={20} glow={false} /></div>
            <div style={{ fontSize: 13, lineHeight: 1.55, color: 'var(--text2)' }}>{m.text}</div>
          </div>
        ))}
        {busy && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--dim)', fontSize: 12 }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--accent)', animation: 'cpulse 0.9s ease-in-out infinite' }} />
            editing the addon…
          </div>
        )}
      </div>
      <div style={{ borderTop: '1px solid var(--line)', padding: '12px 18px' }}>
        <div style={{ maxWidth: 760, margin: '0 auto', background: 'var(--panel2)', border: '1px solid var(--line2)', borderRadius: 12, padding: '9px 12px', display: 'flex', gap: 10, alignItems: 'flex-end' }}>
          <textarea
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={onKey}
            placeholder={`Customize ${addon.name}…`}
            rows={2}
            disabled={busy}
            style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', resize: 'none', color: 'var(--text)', fontFamily: 'var(--font-sans)', fontSize: 13, lineHeight: 1.5 }}
          />
          <button className="send-btn" onClick={send} style={{ opacity: busy || !draft.trim() ? 0.5 : 1 }}>
            <Icon paths={IC.send} size={16} stroke={2.2} />
          </button>
        </div>
      </div>
    </div>
  )
}

const TAB_CONTEXT = { placement: 'tab' } as const

// VIEW_CSP/withViewCsp live in ./view-csp (pure module) so tests can exercise
// the injection without importing the React view.

/** Render an addon's view, source, customization, or settings mode. */
export function AddonView() {
  // Only `addons`/`activeAddon` drive this view reactively; the full-state
  // snapshot handed to the iframe (gated by its state:read grant) is pushed
  // imperatively from useAppStore.getState(), so we do not subscribe to the
  // whole store and rerender on unrelated terminal/chat activity.
  const s = useConductorSelector(x => ({ addons: x.addons, activeAddon: x.activeAddon }), shallowEqual)
  const { removeAddon } = useActions()
  const [mode, setMode] = useState<'view' | 'source' | 'chat' | 'settings'>('view')
  const addon = s.addons.find(a => a.id === s.activeAddon)

  if (!addon) return null
  const effectiveMode = mode === 'view' && !addon.html ? 'chat' : mode

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <ViewHeader title={`${addon.icon} ${addon.name}`}>
        <span style={{ fontSize: 11.5, color: 'var(--dim)' }}>
          {addon.desc || 'addon'} · v{addon.version} · {addon.source === 'master' ? 'built by Master' : `installed (${addon.source})`} · {addon.createdAt}
          {addon.devPath && <span className="mono" style={{ marginLeft: 8, padding: '1px 7px', borderRadius: 5, border: '1px solid var(--accent-border)', background: 'var(--accent-soft)', color: 'var(--accent)', fontSize: 9.5, fontWeight: 700, letterSpacing: 0.6 }} title={`watching ${addon.devPath}`}>DEV</span>}
        </span>
        <div style={{ flex: 1 }} />
        <div style={{ display: 'flex', gap: 4, marginRight: 8 }}>
          {(addon.html ? ['view', 'source', 'chat', 'settings'] as const : ['source', 'chat', 'settings'] as const).map(m => (
            <button
              key={m}
              onClick={() => setMode(m)}
              style={{
                padding: '5px 12px', borderRadius: 7, border: '1px solid',
                borderColor: effectiveMode === m ? 'var(--accent-border)' : 'var(--line)',
                background: effectiveMode === m ? 'var(--accent-soft)' : 'transparent',
                color: effectiveMode === m ? 'var(--accent)' : 'var(--mut)',
                fontSize: 11.5, fontWeight: 600,
              }}
            >
              {m === 'view' ? 'View' : m === 'source' ? 'Source' : m === 'chat' ? 'Customize' : 'Settings'}
            </button>
          ))}
        </div>
        <button
          className="icon-btn danger"
          title="Remove addon"
          style={{ width: 28, height: 28 }}
          onClick={() => { void confirmAction({ title: `Uninstall addon “${addon.name.slice(0, 40)}”?`, detail: 'Removes the addon, its tools, hooks, and stored data. Reinstalling starts fresh.', confirmLabel: 'Uninstall' }).then(ok => { if (ok) removeAddon(addon.id) }) }}
        >
          <Icon paths={IC.close} size={14} stroke={1.8} />
        </button>
      </ViewHeader>
      {effectiveMode === 'view' && addon.html && <AddonFrame addon={addon} context={TAB_CONTEXT} />}
      {effectiveMode === 'source' && <AddonSource addon={addon} />}
      {effectiveMode === 'chat' && <AddonChat addon={addon} />}
      {effectiveMode === 'settings' && (
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', background: 'var(--bg2)' }}>
          <AddonDetail a={addon} inTab />
        </div>
      )}
    </div>
  )
}

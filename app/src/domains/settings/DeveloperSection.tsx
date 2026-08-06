// DEVELOPER section for Settings → General: a toggle, the live in-app debug
// log (HTTP failures, mirrored console errors), and the Web Inspector button.
// Built for exactly the "the marketplace looks broken, where are the logs?"
// situation — the buffer records from app start, before the toggle is on.
import { useSyncExternalStore, useState } from 'react'
import { useActions, useConductorSelector } from '../../store'
import { clearDebugLog, debugEntries, onDebugLog } from '../../core/debug-log'
import { isTauri } from '../../infrastructure/native/base'
import { SectionLabel } from './SectionLabel'
import { Switch } from '../../components/ui'

const time = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })

function DebugLogViewer() {
  const entries = useSyncExternalStore(onDebugLog, debugEntries)
  const [copied, setCopied] = useState(false)
  const copyAll = () => {
    const text = entries.map(e => `${new Date(e.at).toISOString()} [${e.scope}] ${e.message}`).join('\n')
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1400)
    })
  }
  return (
    <div style={{ borderTop: '1px solid var(--line-soft)', padding: '12px 0 4px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span className="mono" style={{ flex: 1, fontSize: 9.5, letterSpacing: .55, color: 'var(--dim)' }}>
          DEBUG LOG · {entries.length} event{entries.length === 1 ? '' : 's'} · newest last
        </span>
        <button className="open-btn" style={{ flex: 'none', padding: '4px 10px', fontSize: 11 }} onClick={copyAll}>
          {copied ? '✓ Copied' : 'Copy all'}
        </button>
        <button className="open-btn" style={{ flex: 'none', padding: '4px 10px', fontSize: 11 }} onClick={clearDebugLog}>
          Clear
        </button>
      </div>
      <div className="mono" style={{
        maxHeight: 260, overflowY: 'auto', background: 'var(--bg2)', border: '1px solid var(--line)',
        borderRadius: 9, padding: '8px 10px', fontSize: 10.5, lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
      }}>
        {entries.length === 0 && <span style={{ color: 'var(--dim)' }}>No diagnostic events yet. Failed registry/marketplace fetches, HTTP errors, and console errors land here.</span>}
        {entries.map((e, i) => (
          <div key={i} style={{ marginBottom: 3 }}>
            <span style={{ color: 'var(--faint)' }}>{time(e.at)}</span>
            <span style={{ color: e.scope.startsWith('console') ? 'var(--red-soft)' : 'var(--accent)' }}> [{e.scope}] </span>
            <span style={{ color: 'var(--mut2)' }}>{e.message}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export function DeveloperSection() {
  const devMode = useConductorSelector(x => x.settings.devMode === true)
  const { updateSettings } = useActions()
  const openInspector = async () => {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('open_devtools').catch(() => {})
  }
  return (
    <>
      <SectionLabel>DEVELOPER</SectionLabel>
      <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 13, padding: '5px 16px', marginBottom: 26 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 0' }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600 }}>Developer mode</div>
            <div style={{ fontSize: 12, color: 'var(--mut)', marginTop: 2 }}>
              Show the in-app debug log (registry & marketplace fetch failures, console errors) and the Web Inspector. Events are recorded from app start either way.
            </div>
          </div>
          {devMode && isTauri && (
            <button className="open-btn" style={{ flex: 'none', padding: '6px 12px', fontSize: 11.5 }} onClick={() => { void openInspector() }}>
              Web Inspector
            </button>
          )}
          <Switch on={devMode} onToggle={() => updateSettings({ devMode: !devMode })} />
        </div>
        {devMode && <DebugLogViewer />}
      </div>
    </>
  )
}

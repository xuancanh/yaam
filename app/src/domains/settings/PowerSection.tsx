// POWER section for Settings → General: the Keep Awake mode. Holds a system
// idle-sleep assertion (caffeinate under the hood) so a locked or dark screen
// doesn't pause running sessions. The display still sleeps and locks normally,
// and a closed lid still sleeps the Mac — that's OS policy no app can override.
import { useConductorSelector, useActions, shallowEqual } from '../../store'
import { keepAwakeDesired } from '../../app/keep-awake'
import { isTauri } from '../../infrastructure/native/base'
import { SectionLabel } from './SectionLabel'

const OPTIONS = [
  { value: 'off', label: 'Off', detail: 'Normal power behavior — the Mac idle-sleeps on its usual schedule.' },
  { value: 'sessions', label: 'While sessions are running', detail: 'Stay awake only while an agent is working or waiting on you; sleep normally when everything is idle.' },
  { value: 'always', label: 'Always while YAAM is open', detail: 'Never idle-sleep while the app runs. Best plugged in.' },
] as const

export function PowerSection() {
  const s = useConductorSelector(x => ({ keepAwake: x.settings.keepAwake ?? 'off', active: keepAwakeDesired(x) }), shallowEqual)
  const { updateSettings } = useActions()
  if (!isTauri) return null
  return (
    <>
      <SectionLabel>POWER</SectionLabel>
      <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 13, padding: '5px 16px', marginBottom: 26 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 0 10px' }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600 }}>
              Keep the Mac awake
              {s.active && (
                <span className="mono" style={{ marginLeft: 8, fontSize: 9.5, fontWeight: 700, color: 'var(--green)', border: '1px solid var(--green)', borderRadius: 4, padding: '1px 6px', verticalAlign: 'middle' }}>
                  HOLDING
                </span>
              )}
            </div>
            <div style={{ fontSize: 12, color: 'var(--mut)', marginTop: 2, lineHeight: 1.5 }}>
              Blocks idle system sleep so running sessions keep working while the screen is dark or locked.
              The display still sleeps and locks as usual.
            </div>
          </div>
          <select
            value={s.keepAwake}
            onChange={e => updateSettings({ keepAwake: e.target.value as 'off' | 'sessions' | 'always' })}
            className="select-field"
            style={{ background: 'var(--bg)', border: '1px solid var(--line2)', borderRadius: 8, padding: '6px 9px', color: 'var(--text)', fontSize: 12, outline: 'none', flexShrink: 0 }}
          >
            {OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--dim)', lineHeight: 1.55, padding: '0 0 12px', borderTop: '1px solid var(--line-soft)', paddingTop: 10 }}>
          {OPTIONS.find(o => o.value === s.keepAwake)?.detail}{' '}
          Closing the lid still sleeps the Mac unless it's in clamshell mode (power + external display).
          For lid-closed work, run the session on a remote machine — SSH sessions live in tmux on the host and don't care if this laptop sleeps.
        </div>
      </div>
    </>
  )
}

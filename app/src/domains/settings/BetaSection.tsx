// BETA section for Settings → General: feature flags for surfaces that work
// but aren't polished enough to be defaults yet. Flags gate entry points only
// — no data or behavior changes when one is off.
import { useConductorSelector, useActions } from '../../store'
import { SectionLabel } from './SectionLabel'
import { Switch } from '../../components/ui'

export function BetaSection() {
  const missionOn = useConductorSelector(x => x.settings.missionControlBeta === true)
  const { updateSettings, setView } = useActions()
  return (
    <>
      <SectionLabel>BETA</SectionLabel>
      <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 13, padding: '5px 16px', marginBottom: 26 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 0' }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600 }}>
              Mission Control
              <span className="mono" style={{ marginLeft: 8, fontSize: 9, fontWeight: 700, color: 'var(--amber)', border: '1px solid var(--amber)', borderRadius: 4, padding: '1px 6px', verticalAlign: 'middle' }}>
                BETA
              </span>
            </div>
            <div style={{ fontSize: 12, color: 'var(--mut)', marginTop: 2, lineHeight: 1.5 }}>
              A full-screen command deck: a stage that auto-follows whichever session needs you,
              a priority rail with inline decision buttons, and ⌘1–9 staging. Adds a Mission entry
              to the navigation rail and the ⌘K palette.
            </div>
          </div>
          {missionOn && (
            <button className="open-btn" style={{ flex: 'none', padding: '6px 12px', fontSize: 11.5 }} onClick={() => setView('mission')}>
              Open
            </button>
          )}
          <Switch on={missionOn} onToggle={() => updateSettings({ missionControlBeta: !missionOn })} />
        </div>
      </div>
    </>
  )
}

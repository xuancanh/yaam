import { useConductorSelector } from '../../store'

/** Sticky save-failure banner. The save-error toast auto-dismisses after ~6s;
 *  this stays mounted for as long as the persistence runtime reports a failing
 *  partition (`state.saveError`) and clears itself on the next successful
 *  write, so a persistently failing disk can't go unnoticed. Subscribes only
 *  to `saveError`, so terminal output churn never re-renders it. */
export function SaveErrorBanner() {
  const saveError = useConductorSelector(s => s.saveError)
  if (!saveError) return null
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
      padding: '5px 12px', fontSize: 12, fontWeight: 500, flexShrink: 0,
      color: 'var(--red-soft)', background: 'rgba(255,122,122,.08)',
      borderBottom: '1px solid var(--line)',
    }}>
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--red-soft)', boxShadow: '0 0 6px rgba(255,122,122,.6)' }} />
      {saveError}
    </div>
  )
}

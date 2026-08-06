// APP UPDATES row for Settings → General: current version, manual check, and
// one-click install of an OTA release (see infrastructure/native/app-update).
import { useEffect, useState } from 'react'
import { checkAppUpdate, type AppUpdate } from '../../infrastructure/native/app-update'
import { isTauri } from '../../infrastructure/native/base'
import { SectionLabel } from './SectionLabel'

type Phase =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'current' }
  | { kind: 'available'; update: AppUpdate }
  | { kind: 'installing'; version: string; percent: number | null }
  | { kind: 'error'; message: string }

export function UpdateSection() {
  const [version, setVersion] = useState('')
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })

  useEffect(() => {
    if (!isTauri) return
    import('@tauri-apps/api/app').then(m => m.getVersion()).then(setVersion).catch(() => {})
  }, [])

  const runCheck = async () => {
    setPhase({ kind: 'checking' })
    try {
      const update = await checkAppUpdate()
      setPhase(update ? { kind: 'available', update } : { kind: 'current' })
    } catch (error) {
      setPhase({ kind: 'error', message: String(error) })
    }
  }

  const runInstall = async (update: AppUpdate) => {
    setPhase({ kind: 'installing', version: update.version, percent: null })
    try {
      await update.install(percent => setPhase({ kind: 'installing', version: update.version, percent }))
      // on success the app relaunches; nothing left to render
    } catch (error) {
      setPhase({ kind: 'error', message: String(error) })
    }
  }

  const detail =
    phase.kind === 'checking' ? 'Checking…'
    : phase.kind === 'current' ? 'You are on the latest version.'
    : phase.kind === 'available' ? `Version ${phase.update.version} is available.`
    : phase.kind === 'installing' ? `Installing ${phase.version}… ${phase.percent !== null ? `${phase.percent}%` : ''} The app restarts when done.`
    : phase.kind === 'error' ? `Update failed: ${phase.message}`
    : 'Updates are fetched from GitHub releases and verified before install.'

  return (
    <>
      <SectionLabel>APP UPDATES</SectionLabel>
      <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 13, padding: '5px 16px', marginBottom: 26 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 0' }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600 }}>
              YAAM {version && <span className="mono" style={{ fontSize: 11.5, color: 'var(--dim)', marginLeft: 6 }}>v{version}</span>}
            </div>
            <div style={{ fontSize: 12, color: phase.kind === 'error' ? 'var(--amber)' : 'var(--mut)', marginTop: 2 }}>{detail}</div>
          </div>
          {phase.kind === 'available' ? (
            <button className="open-btn" style={{ flex: 'none', padding: '7px 12px' }} onClick={() => runInstall(phase.update)}>
              Install & restart
            </button>
          ) : (
            <button
              className="open-btn"
              style={{ flex: 'none', padding: '7px 12px', opacity: phase.kind === 'checking' || phase.kind === 'installing' ? 0.5 : 1, ...(!isTauri ? { display: 'none' } : {}) }}
              disabled={phase.kind === 'checking' || phase.kind === 'installing'}
              onClick={runCheck}
            >
              Check for updates
            </button>
          )}
        </div>
      </div>
    </>
  )
}

// Inbox footer: turn lock-screen alerts on or off for this phone and pick
// what they cover. Where push cannot work from here (plain-HTTP LAN link,
// iPhone Safari outside a home-screen app) it says exactly what to do.
import { useEffect, useState } from 'react'
import { disablePush, enablePush, pushStatus, pushSupport, type PushPrefs } from './api'

const WHY: Record<string, string> = {
  insecure: 'Lock-screen alerts need the HTTPS link (Cloudflare Tunnel or Tailscale in Settings → Remote Control on the desktop). This plain-HTTP network link cannot receive them.',
  'ios-browser': 'On iPhone, alerts only work from the Home Screen app: tap Share → Add to Home Screen, open YAAM from there, then turn alerts on here.',
  unsupported: 'This browser cannot receive push alerts.',
}

export function PushCard() {
  const support = pushSupport()
  const [on, setOn] = useState<boolean | null>(null)
  const [prefs, setPrefs] = useState<PushPrefs>({ needs: true, done: true })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    if (support !== 'ok') return
    let live = true
    pushStatus()
      .then(st => { if (live) { setOn(st.on); setPrefs(st.prefs) } })
      .catch(() => { if (live) setOn(false) })
    return () => { live = false }
  }, [support])

  const run = async (f: () => Promise<void>) => {
    setBusy(true)
    setErr('')
    try { await f() } catch (e) { setErr(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  const turnOn = () => run(async () => { await enablePush(prefs); setOn(true) })
  const turnOff = () => run(async () => { await disablePush(); setOn(false) })
  const toggle = (k: keyof PushPrefs) => {
    const next = { ...prefs, [k]: !prefs[k] }
    setPrefs(next)
    if (on) void run(() => enablePush(next))
  }
  const blocked = support === 'ok' && typeof Notification !== 'undefined' && Notification.permission === 'denied'

  return (
    <div className="pushcard">
      <div className="phead">
        <span className="ptitle">Lock-screen alerts</span>
        {support === 'ok' && on !== null && <span className={`pstate${on ? ' on' : ''}`}>{on ? 'On' : 'Off'}</span>}
      </div>
      {support !== 'ok' ? (
        <div className="pnote">{WHY[support]}</div>
      ) : blocked ? (
        <div className="pnote">Notifications are blocked for this site. Allow them in the browser's site settings, then come back.</div>
      ) : (
        <>
          <div className="pnote">Get a notification when an agent needs you, even with this app closed. Held back while the app is open on screen.</div>
          <div className="pprefs">
            <button className={`fchip${prefs.needs ? ' on' : ''}`} disabled={busy} onClick={() => toggle('needs')}>Needs you</button>
            <button className={`fchip${prefs.done ? ' on' : ''}`} disabled={busy} onClick={() => toggle('done')}>Finished</button>
          </div>
          <div className="btnrow" style={{ padding: 0 }}>
            {on
              ? <button className="btn ghost" disabled={busy} onClick={() => void turnOff()}>Turn off</button>
              : <button className="btn primary" disabled={busy || on === null} onClick={() => void turnOn()}>{busy ? 'Turning on…' : 'Turn on alerts'}</button>}
          </div>
        </>
      )}
      {err && <div className="pnote perr">{err}</div>}
    </div>
  )
}

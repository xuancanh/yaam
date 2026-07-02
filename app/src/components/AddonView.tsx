import { useCallback, useEffect, useRef } from 'react'
import { useActions, useConductor } from '../store'
import type { AppState } from '../types'
import { IC, Icon, ViewHeader } from './ui'

// What addons are allowed to see — a read-only snapshot pushed over postMessage.
function snapshot(s: AppState) {
  return {
    sessions: s.agents.map(a => ({
      id: a.id, name: a.name, status: a.status,
      task: a.task ?? null, summary: a.summary ?? null, actionNeeded: a.actionNeeded ?? null,
      cost: Number(a.cost.toFixed(3)), used: Number(a.used.toFixed(2)),
    })),
    tasks: s.tasks.map(t => ({ title: t.title, col: t.col })),
    crons: s.crons.map(c => ({ name: c.name, schedule: c.schedule, on: c.on, last: c.last })),
    events: s.events.slice(0, 10).map(e => ({ time: e.time, type: e.type, text: e.text })),
    totals: {
      cost: Number(s.agents.reduce((n, a) => n + a.cost, 0).toFixed(3)),
      used: Number(s.agents.reduce((n, a) => n + a.used, 0).toFixed(2)),
      running: s.agents.filter(a => a.status === 'running').length,
    },
  }
}

export function AddonView() {
  const s = useConductor()
  const { removeAddon } = useActions()
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const stateRef = useRef(s)
  stateRef.current = s

  const addon = s.addons.find(a => a.id === s.activeAddon)

  const push = useCallback(() => {
    iframeRef.current?.contentWindow?.postMessage(
      { type: 'yaam:state', state: snapshot(stateRef.current) }, '*')
  }, [])

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== iframeRef.current?.contentWindow) return
      if (e.data?.type === 'yaam:getState') push()
    }
    window.addEventListener('message', onMessage)
    const timer = window.setInterval(push, 3000)
    return () => {
      window.removeEventListener('message', onMessage)
      window.clearInterval(timer)
    }
  }, [push])

  if (!addon) return null

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <ViewHeader title={`${addon.icon} ${addon.name}`}>
        <span style={{ fontSize: 11.5, color: 'var(--dim)' }}>
          {addon.desc || 'addon'} · built by Master · {addon.createdAt}
        </span>
        <div style={{ flex: 1 }} />
        <button
          className="icon-btn danger"
          title="Remove addon"
          style={{ width: 28, height: 28 }}
          onClick={() => removeAddon(addon.id)}
        >
          <Icon paths={IC.close} size={14} stroke={1.8} />
        </button>
      </ViewHeader>
      <iframe
        ref={iframeRef}
        key={addon.id + addon.createdAt}
        title={addon.name}
        sandbox="allow-scripts"
        srcDoc={addon.html}
        onLoad={push}
        style={{ flex: 1, border: 'none', background: '#0A0B0F' }}
      />
    </div>
  )
}

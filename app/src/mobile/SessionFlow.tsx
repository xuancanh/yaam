// Structured session view for the phone: the agent's prompts, tool calls and
// replies from its CLI transcript (the desktop FLOW panel's data), grouped by
// turn with failures marked. Far easier to follow on a small screen than a
// raw terminal, and it scrolls natively. Watching is opt-in per session so
// the desktop only ships flows a phone actually has open.
import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { RemoteFlowStep } from '../domains/remote/snapshot'
import { sendCommand } from './api'

const KIND: Record<string, { glyph: string; color: string }> = {
  read: { glyph: '◔', color: 'var(--mut)' },
  edit: { glyph: '✎', color: 'var(--accent)' },
  run: { glyph: '›_', color: 'var(--green)' },
  search: { glyph: '⌕', color: 'var(--mut)' },
  web: { glyph: '◍', color: '#7FD1FF' },
  agent: { glyph: '◈', color: '#C77DFF' },
  plan: { glyph: '☰', color: 'var(--mut)' },
  mcp: { glyph: '⧉', color: '#7FD1FF' },
  other: { glyph: '•', color: 'var(--dim)' },
}

const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const base = (p: string) => p.split('/').filter(Boolean).pop() ?? p

type Turn = { prompt?: RemoteFlowStep; steps: RemoteFlowStep[] }

function turns(steps: readonly RemoteFlowStep[]): Turn[] {
  const out: Turn[] = []
  for (const s of steps) {
    if (s.type === 'prompt') out.push({ prompt: s, steps: [] })
    else {
      if (!out.length) out.push({ steps: [] })
      out[out.length - 1].steps.push(s)
    }
  }
  return out
}

const Step = memo(function Step({ s }: { s: RemoteFlowStep }) {
  if (s.type === 'say') return <div className="fsay">{s.label}</div>
  const k = KIND[s.kind ?? 'other'] ?? KIND.other
  return (
    <div className={`fstep${s.status === 'error' ? ' err' : ''}`}>
      <span className={`fdot ${s.status ?? 'ok'}`} />
      <span className="fglyph" style={{ color: k.color }}>{k.glyph}</span>
      <span className="flabel">{s.path ? base(s.path) : s.label}</span>
      <span className="ftool">{s.tool}</span>
    </div>
  )
})

export function SessionFlow({ sessionId, flow }: { sessionId: string; flow?: RemoteFlowStep[] }) {
  const [errorsOnly, setErrorsOnly] = useState(false)
  useEffect(() => {
    void sendCommand({ kind: 'session_watch', id: sessionId })
    return () => { void sendCommand({ kind: 'session_unwatch', id: sessionId }) }
  }, [sessionId])

  // follow the newest step only while the reader is at the bottom
  const scRef = useRef<HTMLDivElement>(null)
  const atBottom = useRef(true)
  const last = flow?.[flow.length - 1]
  useLayoutEffect(() => {
    const sc = scRef.current
    if (sc && atBottom.current) sc.scrollTop = sc.scrollHeight
  }, [flow?.length, last?.status])

  if (!flow) return <div className="body"><div className="pairwrap"><div className="spinner" /></div></div>
  if (!flow.length) {
    return (
      <div className="body">
        <div className="empty">No activity yet. The flow fills in from the agent's transcript as it works (Claude Code and Codex sessions).</div>
      </div>
    )
  }
  const errors = flow.filter(s => s.status === 'error').length
  const tools = flow.filter(s => s.type === 'tool').length
  return (
    <div
      className="body"
      ref={scRef}
      onScroll={e => { const el = e.currentTarget; atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 56 }}
    >
      <div className="fhead">
        <span>{tools} tool calls</span>
        {errors > 0 && (
          <button className={`fchip${errorsOnly ? ' on' : ''}`} onClick={() => setErrorsOnly(v => !v)}>{errors} failed</button>
        )}
      </div>
      {turns(flow).map((t, i) => {
        const shown = errorsOnly ? t.steps.filter(s => s.status === 'error') : t.steps
        if (errorsOnly && !shown.length) return null
        return (
          <div key={t.prompt?.id ?? `t${i}`} className="fturn">
            {t.prompt && (
              <div className="fprompt">
                <span className="fyou">you</span>
                <span style={{ flex: 1, minWidth: 0 }}>{t.prompt.label}</span>
                <span className="ftime">{clock(t.prompt.at)}</span>
              </div>
            )}
            {shown.map(s => <Step key={s.id} s={s} />)}
          </div>
        )
      })}
    </div>
  )
}

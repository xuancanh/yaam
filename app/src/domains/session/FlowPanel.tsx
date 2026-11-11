// Docked "FLOW" panel: a live timeline of the session's prompts, tool calls
// and replies from its transcript, grouped by turn, with failed calls marked
// and edited/read files one click from the Files panel.
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Agent } from '../../core/types'
import { requestOpenFile } from './open-file-bus'
import { resolveTermPath } from '../../core/terminal-links'
import { flowFor, flowStats, onFlow } from './session-flow'
import type { FlowKind, FlowStep } from './session-flow'

const KIND: Record<FlowKind, { glyph: string; color: string; name: string }> = {
  read: { glyph: '◔', color: 'var(--mut)', name: 'read' },
  edit: { glyph: '✎', color: 'var(--accent)', name: 'edit' },
  run: { glyph: '›_', color: 'var(--green)', name: 'run' },
  search: { glyph: '⌕', color: 'var(--mut)', name: 'search' },
  web: { glyph: '◍', color: '#7FD1FF', name: 'web' },
  agent: { glyph: '◈', color: '#C77DFF', name: 'subagent' },
  plan: { glyph: '☰', color: 'var(--mut)', name: 'plan' },
  mcp: { glyph: '⧉', color: '#7FD1FF', name: 'mcp' },
  other: { glyph: '•', color: 'var(--dim)', name: 'tool' },
}

const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })

/** Turns: each prompt opens one; leading steps before any prompt form turn 0. */
function turns(steps: readonly FlowStep[]): { prompt?: FlowStep; steps: FlowStep[] }[] {
  const out: { prompt?: FlowStep; steps: FlowStep[] }[] = []
  for (const s of steps) {
    if (s.type === 'prompt') out.push({ prompt: s, steps: [] })
    else {
      if (!out.length) out.push({ steps: [] })
      out[out.length - 1].steps.push(s)
    }
  }
  return out
}

export function FlowPanel({ agent }: { agent: Agent }) {
  const [, bump] = useState(0)
  const [errorsOnly, setErrorsOnly] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  useEffect(() => onFlow(agent.id, () => bump(n => n + 1)), [agent.id])
  const steps = flowFor(agent.id)
  const stats = flowStats(steps)
  const groups = useMemo(() => turns(steps), [steps, steps.length]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const el = scrollRef.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  })

  if (!steps.length) {
    return (
      <div style={{ padding: 14, fontSize: 12, color: 'var(--dim)', lineHeight: 1.6 }}>
        No activity yet. The flow fills in from the agent's transcript as it works (Claude Code and Codex sessions).
      </div>
    )
  }
  const kinds = (Object.entries(stats.byKind) as [FlowKind, number][]).sort((a, b) => b[1] - a[1])
  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '6px 10px', borderBottom: '1px solid var(--line)', fontSize: 11 }}>
        <span style={{ fontWeight: 700 }}>{stats.tools} calls</span>
        {kinds.map(([k, n]) => <span key={k} style={{ color: KIND[k].color }}>{KIND[k].glyph} {n} {KIND[k].name}</span>)}
        {stats.files > 0 && <span style={{ color: 'var(--mut)' }}>{stats.files} file{stats.files > 1 ? 's' : ''} edited</span>}
        <div style={{ flex: 1 }} />
        {stats.errors > 0 && (
          <button
            onClick={() => setErrorsOnly(v => !v)}
            style={{ fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 99, cursor: 'pointer', border: '1px solid var(--red-soft)', background: errorsOnly ? 'var(--red-soft)' : 'transparent', color: errorsOnly ? '#1a0505' : 'var(--red-soft)' }}
          >
            {stats.errors} failed
          </button>
        )}
      </div>
      <div
        ref={scrollRef}
        onScroll={e => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40 }}
        className="selectable"
        style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '6px 0 12px' }}
      >
        {groups.map((g, gi) => {
          const shown = errorsOnly ? g.steps.filter(s => s.status === 'error') : g.steps
          if (errorsOnly && !shown.length) return null
          return (
            <div key={g.prompt?.id ?? `t${gi}`} style={{ marginBottom: 6 }}>
              {g.prompt && (
                <div style={{ display: 'flex', gap: 8, padding: '6px 10px', margin: '0 6px', borderRadius: 7, background: 'var(--accent-faint)', fontSize: 12 }}>
                  <span style={{ color: 'var(--accent)', fontWeight: 700 }}>you</span>
                  <span style={{ flex: 1, minWidth: 0 }}>{g.prompt.label}</span>
                  <span className="mono" style={{ fontSize: 10, color: 'var(--dim)' }}>{clock(g.prompt.at)}</span>
                </div>
              )}
              {shown.map(s => s.type === 'say' ? (
                <div key={s.id} style={{ padding: '3px 12px 3px 28px', fontSize: 11.5, color: 'var(--text2)' }}>{s.label}</div>
              ) : (
                <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2px 12px 2px 14px', fontSize: 11.5 }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: s.status === 'error' ? 'var(--red-soft)' : s.status === 'running' ? 'var(--amber)' : 'var(--line2)' }} />
                  <span className="mono" style={{ width: 18, flexShrink: 0, color: KIND[s.kind ?? 'other'].color, fontSize: 11 }}>{KIND[s.kind ?? 'other'].glyph}</span>
                  {s.path ? (
                    <button
                      className="mono"
                      title={`${s.tool} · ${s.path} (open in Files)`}
                      onClick={() => requestOpenFile(agent.id, resolveTermPath(s.path!, agent.cwd || ''))}
                      style={{ flex: 1, minWidth: 0, textAlign: 'left', background: 'none', border: 'none', padding: 0, color: s.status === 'error' ? 'var(--red-soft)' : 'var(--text)', cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11.5 }}
                    >
                      {s.label}
                    </button>
                  ) : (
                    <span className="mono" title={`${s.tool}: ${s.label}`} style={{ flex: 1, minWidth: 0, color: s.status === 'error' ? 'var(--red-soft)' : 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {s.label}
                    </span>
                  )}
                  <span style={{ fontSize: 10, color: 'var(--faint)', flexShrink: 0 }}>{s.tool}</span>
                </div>
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}

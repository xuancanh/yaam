import { useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { Agent } from '../types'
import { STATUS_META, hexToRgba } from '../data'

/** Render one or more SVG paths with the shared icon defaults. */
export function Icon({ paths, size = 17, stroke = 1.6, style }: {
  paths: string[]
  size?: number
  stroke?: number
  style?: CSSProperties
}) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round"
      style={style}
    >
      {paths.map((d, i) => <path key={i} d={d} />)}
    </svg>
  )
}

export const IC = {
  bell: ['M12 4a5 5 0 015 5v4l1.8 2.6H5.2L7 13V9a5 5 0 015-5z', 'M10 20a2 2 0 004 0'],
  gear: ['M12 9a3 3 0 100 6 3 3 0 000-6z', 'M19 12a7 7 0 00-.1-1.2l2-1.5-2-3.4-2.3 1a7 7 0 00-2-1.2L16.2 3H7.8l-.4 2.7a7 7 0 00-2 1.2l-2.3-1-2 3.4 2 1.5A7 7 0 003 12c0 .4 0 .8.1 1.2l-2 1.5 2 3.4 2.3-1a7 7 0 002 1.2L7.8 21h8.4l.4-2.7a7 7 0 002-1.2l2.3 1 2-3.4-2-1.5c.1-.4.1-.8.1-1.2z'],
  bars: ['M5 18V7', 'M12 18V4', 'M19 18v-8'],
  route: ['M4 6h9', 'M4 18h6', 'M13 6l3 3-3 3', 'M20 6v12'],
  warn: ['M12 3l9 16H3z', 'M12 10v4', 'M12 17.5v.1'],
  bolt: ['M14 3l-1 5 5-1-8 13 1-6-5 1z'],
  chip: ['M4 10h3M4 14h3M17 10h3M17 14h3M10 4v3M14 4v3M10 17v3M14 17v3'],
  sliders: ['M6 4v16', 'M12 4v16', 'M18 4v16'],
  close: ['M6 6l12 12', 'M18 6L6 18'],
  plus: ['M12 5v14', 'M5 12h14'],
  split: ['M12 5v14'],
  send: ['M12 20V5', 'M6 11l6-6 6 6'],
}

/** Render an agent lifecycle label using the shared status colors. */
export function StatusPill({ agent, small }: { agent: Agent; small?: boolean }) {
  // chat agents have no OS process: at rest they are ready (not "paused"),
  // and while a turn runs they are thinking
  const sm = agent.kind === 'chat'
    ? agent.status === 'running'
      ? { label: 'Thinking', color: STATUS_META.running.color }
      : { label: 'Ready', color: '#8B93A1' }
    : STATUS_META[agent.status] || STATUS_META.idle
  // running = calm static light; flashing means "look at me" (needs/attention)
  const anim = agent.status === 'needs' || agent.attention
    ? 'cpulse 1.1s ease-in-out infinite' : 'none'
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 6, background: 'var(--panel2)',
      border: '1px solid var(--line)', borderRadius: 20, padding: '3px 9px', flexShrink: 0,
    }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: sm.color, animation: anim }} />
      <span style={{ fontSize: small ? 10 : 10.5, fontWeight: 600, color: sm.color }}>{sm.label}</span>
    </div>
  )
}

/** Render a colored initial badge for one agent session. */
export function AgentAvatar({ agent, size = 24 }: { agent: Agent; size?: number }) {
  return (
    <div className="mono" style={{
      width: size, height: size, borderRadius: size > 30 ? 9 : 6,
      background: hexToRgba(agent.color, 0.14), border: `1px solid ${hexToRgba(agent.color, 0.4)}`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: size > 30 ? 12 : 10, fontWeight: 600, color: agent.color, flexShrink: 0,
    }}>
      {agent.short}
    </div>
  )
}

/** Switch a label into an inline editor and commit on blur or Enter. */
export function EditableName({ name, onRename, fontSize = 13.5 }: {
  name: string
  onRename: (name: string) => void
  fontSize?: number
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(name)

  if (editing) {
    // Commit the draft and leave edit mode from either blur or keyboard input.
    const commit = () => { onRename(draft); setEditing(false) }
    return (
      <input
        autoFocus
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') setEditing(false)
        }}
        onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--bg)', border: '1px solid var(--line2)', borderRadius: 5,
          padding: '2px 6px', color: 'var(--text)', outline: 'none', fontSize,
          fontWeight: 600, fontFamily: 'inherit', width: 150,
        }}
      />
    )
  }
  return (
    <div
      className="editable-name"
      title="Double-click (or click the pencil) to rename"
      onDoubleClick={e => { e.stopPropagation(); setDraft(name); setEditing(true) }}
      style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}
    >
      <span style={{ fontSize, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</span>
      <button
        className="rename-pencil"
        onClick={e => { e.stopPropagation(); setDraft(name); setEditing(true) }}
        style={{
          border: 'none', background: 'transparent', color: 'var(--dim)', padding: 1,
          display: 'flex', alignItems: 'center', flexShrink: 0,
        }}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M17 3a2.8 2.8 0 014 4L7.5 20.5 2 22l1.5-5.5z" />
        </svg>
      </button>
    </div>
  )
}

/** Render the shared accessible-looking binary toggle control. */
export function Switch({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      style={{
        width: 38, height: 22, borderRadius: 999, border: '1px solid var(--line2)',
        background: on ? 'var(--green)' : 'var(--line2)', position: 'relative',
        flexShrink: 0, transition: 'background .15s', padding: 0,
      }}
    >
      <span style={{
        position: 'absolute', top: 2, left: on ? 18 : 2, width: 16, height: 16,
        borderRadius: '50%', background: '#fff', transition: 'left .15s',
      }} />
    </button>
  )
}

/** Render a consistent title row for full-height application views. */
export function ViewHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div style={{
      height: 46, flexShrink: 0, background: 'var(--panel)', borderBottom: '1px solid var(--line)',
      display: 'flex', alignItems: 'center', gap: 10, padding: '0 18px',
    }}>
      <span className="grotesk" style={{ fontWeight: 600, fontSize: 14 }}>{title}</span>
      {children}
    </div>
  )
}

/** Render the compact YAAM three-bar brand mark. */
export function MasterMark({ size = 24, glow = true }: { size?: number; glow?: boolean }) {
  const accent = 'var(--accent)'
  return (
    <div style={{
      width: size, height: size, borderRadius: Math.round(size * 0.29),
      background: `linear-gradient(145deg, ${accent}, rgba(245,196,81,.72))`,
      display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      boxShadow: glow ? '0 0 14px rgba(245,196,81,.5)' : 'none',
    }}>
      <svg width={size * 0.54} height={size * 0.54} viewBox="0 0 24 24" fill="none" stroke="#0D0F14" strokeWidth="2.2" strokeLinecap="round">
        <path d="M5 18V7" /><path d="M12 18V4" /><path d="M19 18v-8" />
      </svg>
    </div>
  )
}

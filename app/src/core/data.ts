import type { Agent, AgentTool, AppState, DiffFile, MemorySource, Perm, Snapshot } from './types'
import { freshWorkspaceSlice } from '../domains/workspace/slice'
import { freshSessionSlice } from '../domains/session/slice'
import { freshBoardSlice } from '../domains/board/slice'
import { freshScheduleSlice } from '../domains/schedules/slice'
import { freshMasterSlice } from '../domains/master/slice'
import { freshAddonSlice } from '../domains/addons/slice'
import { freshSettingsSlice } from '../domains/settings/slice'
import { freshActivitySlice } from '../domains/activity/slice'
import { freshChatSlice } from '../domains/chat/slice'
import { freshShellUiSlice } from '../domains/shell/slice'

export const ACCENT = '#F5C451'

export const SHELLS = ['zsh', 'bash', 'sh', 'fish', 'nu']

export const MASTER_GREETING = 'I’m Master for this workspace. Give me a brain in Settings → Master Brain (any supported provider’s API key), then tell me what you need — I launch and command sessions, answer questions about them, and build schedules. Without one, everything else still works: launch any CLI as a session (⌘T), organize the board, and review diffs manually.'

export const LOG_COLORS: Record<string, string> = {
  sys: '#5B6472',
  you: '#E7E9F0',
  run: '#7FD1FF',
  out: '#8B93A1',
  think: '#D9B778',
  edit: '#7FE3B0',
  warn: '#FFB020',
  err: '#FF7A7A',
}

export const STATUS_META: Record<string, { label: string; color: string }> = {
  running: { label: 'Running', color: '#3DDC97' },
  idle: { label: 'Paused', color: '#6B7280' },
  needs: { label: 'Needs action', color: '#FFB020' },
  error: { label: 'Error', color: '#FF5C5C' },
}

/** Tab indicator color while a session is actively streaming output ("responding").
 *  Deliberately distinct from the lifecycle colors above (green/amber/red/grey). */
export const RESPONDING_COLOR = '#7FD1FF'

export const PERM_COLORS: Record<Perm, string> = {
  Off: '#6B7280',
  'Ask first': '#FFB020',
  Auto: '#3DDC97',
  Approval: '#FF5C5C',
}

export const PERM_ORDER: Perm[] = ['Off', 'Ask first', 'Auto', 'Approval']

export const EVENT_COLORS: Record<string, string> = {
  route: ACCENT,
  edit: '#7FE3B0',
  test: '#7FD1FF',
  escalate: '#FFB020',
  cron: '#8B93A1',
  build: ACCENT,
  done: '#3DDC97',
}

export const NOTIF_COLORS: Record<string, string> = {
  escalate: '#FFB020',
  done: '#3DDC97',
  cron: '#8B93A1',
}

/** Accent swatches a workspace can pick from; the first (yellow) is the
 *  default. Pickers append a custom-color well, so any hex is reachable. */
export const WORKSPACE_COLORS = ['#F5C451', '#3DDC97', '#7FD1FF', '#A371F7', '#FF7A7A', '#FFB020'] as const

/** The default workspace accent (matches --accent). */
export const DEFAULT_WORKSPACE_COLOR = WORKSPACE_COLORS[0]

/** Session/tab accent swatches: assigned randomly at launch, configurable from
 *  the tab context menu, and offered as tab-group border colors. Pickers append
 *  a custom-color well, so any hex is reachable. */
export const TAB_COLORS = ['#7FD1FF', '#F5C451', '#3DDC97', '#FF9B9B', '#C77DFF', '#E8A87C'] as const

export const DIFF_COLORS: Record<string, string> = {
  add: '#7FE3B0',
  del: '#FF9B9B',
  ctx: '#8B93A1',
  meta: ACCENT,
}

export const DIFF_BG: Record<string, string> = {
  add: 'rgba(61,220,151,.09)',
  del: 'rgba(255,92,92,.09)',
  ctx: 'transparent',
  meta: 'var(--accent-faint)',
}

// dot color for a session's tab/card indicator: attention overrides toward
// what happened (finished=green, error=red, needs=amber)
/** Map an agent's lifecycle and attention state to its status-dot color. */
export function indicatorColor(a: Agent): string {
  if (a.status === 'needs') return STATUS_META.needs.color
  if (a.status === 'error') return STATUS_META.error.color
  if (a.attention && a.status === 'idle') return STATUS_META.running.color
  return (STATUS_META[a.status] || STATUS_META.idle).color
}

/** Convert a six-digit hex color to an rgba() value with the requested alpha.
 *  Optional-color fields (Agent.color, TabGroup.color) are typed `string?` —
 *  a missing color degrades to transparent rather than throwing on slice. */
export function hexToRgba(hex: string | undefined, a: number): string {
  if (!hex) return 'transparent'
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
}

/** Adapt a fixed accent hex (tab/workspace/status colors — all tuned for dark
 *  surfaces) to the CURRENT theme: on light themes the pastel is saturated
 *  around its mean and darkened so borders, dots, and colored text keep
 *  contrast on pale panels; dark themes get it back unchanged. Reads the live
 *  data-theme attribute — callers re-render far more often than themes change. */
export function uiTint(hex: string): string {
  if (typeof document === 'undefined') return hex
  const theme = document.documentElement.getAttribute('data-theme')
  if (theme !== 'light' && theme !== 'paper' && theme !== 'sakura') return hex
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!m) return hex
  const n = parseInt(m[1], 16)
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  const mean = (ch[0] + ch[1] + ch[2]) / 3
  const adj = ch.map(v => {
    const saturated = Math.max(0, Math.min(255, mean + (v - mean) * 1.3))
    return Math.round(saturated * 0.58)
  })
  return `#${adj.map(v => v.toString(16).padStart(2, '0')).join('')}`
}

// What of this session feeds Master's context — toggles are enforced when
// building Master's system prompt. Token counts are computed live.
/** Create an independent copy of the default memory-source configuration. */
export function mkMemory(): MemorySource[] {
  return [
    { id: 'tail', label: 'Terminal output tail', detail: 'last 200 lines, ANSI-stripped', tokens: 0, on: true },
    { id: 'meta', label: 'Session metadata', detail: 'command · working dir · status', tokens: 0, on: true },
  ]
}

// What Master may do to this session — enforced in Master's tool executor.
/** Create an independent copy of the default per-agent tool permissions. */
export function mkTools(): AgentTool[] {
  return [
    { id: 'send', name: 'Send input', on: true, perm: 'Auto' },
    { id: 'stop', name: 'Stop session', on: true, perm: 'Ask first' },
    { id: 'respawn', name: 'Respawn', on: true, perm: 'Auto' },
  ]
}

// Live token estimate for a memory source (chars / 4 ≈ tokens, in k)
/** Return the effective token allocation for one enabled agent memory source. */
export function memTokens(a: Agent, sourceId: string): number {
  if (sourceId === 'tail') return a.log.reduce((n, l) => n + l.x.length + 1, 0) / 4000
  if (sourceId === 'meta') return 0.05
  return 0
}

export interface AgentDetail {
  used: number
  cost: number
  budget: number
  snaps: Snapshot[]
  diff: DiffFile[]
}

/** Seed the monitor-maintained detail fields for a newly created session. */
export function defaultDetail(): AgentDetail {
  return { used: 0, cost: 0, budget: 3.0, snaps: [{ label: 'session start', time: 'just now' }], diff: [] }
}

/** Fresh AppState = every domain's initial slice plus the transient boot status. */
export function seedState(): AppState {
  return {
    ...freshWorkspaceSlice(),
    ...freshSessionSlice(),
    ...freshBoardSlice(),
    ...freshScheduleSlice(),
    ...freshMasterSlice(),
    ...freshAddonSlice(),
    ...freshSettingsSlice(),
    ...freshActivitySlice(),
    ...freshChatSlice(),
    ...freshShellUiSlice(),
    bootStatus: 'loading',
  }
}

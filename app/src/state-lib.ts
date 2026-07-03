// Pure helpers shared by the store: ids, cron parsing, prompt/dialog
// detection, agent-type utilities, pane focus semantics, and PTY input.
import * as native from './native'
import type { AppState, EscOption, WorkspaceData } from './types'

let uid = 0
export function mkId(prefix: string): string {
  uid += 1
  return `${prefix}${Date.now()}-${uid}`
}

// Matches one field of a five-field cron expression: *, */n, a, a-b, and comma lists.
export function fieldMatches(field: string, value: number): boolean {
  return field.split(',').some(part => {
    if (part === '*') return true
    const step = part.match(/^\*\/(\d+)$/)
    if (step) return value % parseInt(step[1], 10) === 0
    const range = part.match(/^(\d+)-(\d+)$/)
    if (range) return value >= parseInt(range[1], 10) && value <= parseInt(range[2], 10)
    return parseInt(part, 10) === value
  })
}

export function cronMatches(expr: string, d: Date): boolean {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) return false
  const [min, hour, dom, mon, dow] = fields
  return (
    fieldMatches(min, d.getMinutes()) &&
    fieldMatches(hour, d.getHours()) &&
    fieldMatches(dom, d.getDate()) &&
    fieldMatches(mon, d.getMonth() + 1) &&
    fieldMatches(dow, d.getDay())
  )
}

export function humanizeCron(expr: string): string {
  const f = expr.trim().split(/\s+/)
  if (f.length !== 5) return expr
  const [min, hour, , , dow] = f
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  if (/^\d+$/.test(min) && /^\d+$/.test(hour)) {
    const time = `${hour.padStart(2, '0')}:${min.padStart(2, '0')}`
    if (dow === '*') return `Every day · ${time}`
    if (/^\d+$/.test(dow)) return `${DAYS[parseInt(dow, 10) % 7]}s · ${time}`
  }
  if (min.startsWith('*/') && hour === '*') return `Every ${min.slice(2)} min`
  return expr
}

// Heuristics for "this CLI is waiting on the user": y/n prompts, permission
// questions, confirmation menus.
export const PROMPT_RE = /(\[y\/n\]|\[y\/N\]|\[Y\/n\]|\(y\/n\)|yes\/no|do you want|would you like|allow this|allow .*\?|permission|approve\?|confirm|proceed\?|continue\?|password:|are you sure|press enter to|\(esc to cancel\))/i

// Strong markers for full-screen TUI approval dialogs (Claude Code, Codex, …).
// Matched against the rendered screen, so they must be specific enough to
// never appear during normal TUI operation.
export const TUI_PROMPT_RE = /(do you want to (proceed|make this edit|run|allow)|requires approval|don'?t ask again|yes, and|grant (access|permission)|allow this (command|tool|action)|\[y\/n\]|\(y\/n\)|password:|enter to select|[↑↓]\/[↑↓] to navigate|❯\s*\d+\.)/i
export const QUESTION_LINE_RE = /(do you want[^?]*\??|requires approval|allow [^?]*\??|permission|\[y\/n\]|\(y\/n\))/i
// selection menus usually put the actual question on its own line ending in "?"
export const QUESTION_MARK_LINE_RE = /^[^│┌└─]*\S[^?]*\?\s*$/

// numbered dialog options, with optional ❯ cursor: "❯ 1. Yes" / "2. No"
export const OPTION_RE = /^\s*[│]?\s*(❯)?\s*(\d+)[.)]\s+(.+?)\s*[│]?\s*$/

export function extractOptions(lines: string[]): { options: EscOption[]; cursorNum: number } {
  const options: EscOption[] = []
  let cursorNum = 1
  for (const line of lines) {
    const m = line.match(OPTION_RE)
    if (!m) continue
    const num = parseInt(m[2], 10)
    if (options.some(o => o.num === num)) continue
    options.push({ num, label: m[3].trim().slice(0, 60) })
    if (m[1]) cursorNum = num
  }
  return options.length >= 2 ? { options, cursorNum } : { options: [], cursorNum: 1 }
}

export function typeForCommand(command: string, types: AppState['agentTypes']) {
  const bin = command.trim().split(/\s+/)[0]
  return types.find(t => t.model.trim().split(/\s+/)[0] === bin)
}

// iTerm-like focus: if the session is already visible, activate that pane;
// otherwise show it in the active pane. Never duplicates a session across
// panes (two panes would fight over the same terminal element).
export function focusSessionIn(s: AppState, id: string): AppState {
  s = { ...s, agents: s.agents.map(a => (a.id === id ? { ...a, archived: false, attention: false } : a)) }
  const minimizedIds = s.minimizedIds.filter(x => x !== id)
  const existing = s.focusedIds.indexOf(id)
  if (existing >= 0) {
    return {
      ...s, minimizedIds, activePane: existing, view: 'workspace',
      maximizedPane: s.maximizedPane === null ? null : existing,
    }
  }
  const focusedIds = s.focusedIds.slice()
  if (!focusedIds.length) focusedIds.push(id)
  else focusedIds[Math.min(s.activePane, focusedIds.length - 1)] = id
  return {
    ...s, focusedIds, minimizedIds,
    activePane: Math.min(s.activePane, focusedIds.length - 1),
    view: 'workspace',
  }
}

// KEY=value lines → shell assignment prefix (we spawn via sh -lc)
export function envPrefix(env?: string): string {
  if (!env) return ''
  const parts = env.split('\n')
    .map(l => l.trim())
    .filter(l => /^[A-Za-z_][A-Za-z0-9_]*=/.test(l))
    .map(l => {
      const i = l.indexOf('=')
      return `${l.slice(0, i)}='${l.slice(i + 1).replace(/'/g, `'\\''`)}'`
    })
  return parts.length ? `${parts.join(' ')} ` : ''
}

export function spawnAgentProcess(id: string, command: string, cwd?: string): Promise<void> {
  return native.spawnSession(id, command.trim(), cwd || undefined)
}

export const wait = (ms: number) => new Promise<void>(r => window.setTimeout(r, ms))

export const KEYMAP: Record<string, string> = {
  enter: '\r', esc: '\x1b', escape: '\x1b', up: '\x1b[A', down: '\x1b[B',
  right: '\x1b[C', left: '\x1b[D', tab: '\t', space: ' ', backspace: '\x7f',
  'ctrl+c': '\x03', 'ctrl+d': '\x04',
}

// Write text, then Enter as a SEPARATE keypress. TUIs (Claude Code et al.)
// treat text+\r in one chunk as a paste and insert a newline instead of
// submitting.
export function sendLineToSession(id: string, text: string) {
  native.writeSession(id, text).catch(() => {})
  window.setTimeout(() => { native.writeSession(id, '\r').catch(() => {}) }, 250)
}



// ---------- workspace scoping ----------

export function emptyScoped(greeting: string): WorkspaceData {
  return {
    focusedIds: [], activePane: 0, minimizedIds: [],
    paneSplits: { row: 0.5, cols: [0.5, 0.5] }, maximizedPane: null,
    messages: [{ id: mkId('m'), role: 'master', kind: 'text', text: greeting }],
    crons: [], tasks: [], events: [], notifications: [], pendingMasterNotes: [],
  }
}

export function scopedFromState(s: AppState): WorkspaceData {
  return {
    focusedIds: s.focusedIds, activePane: s.activePane, minimizedIds: s.minimizedIds,
    paneSplits: s.paneSplits, maximizedPane: s.maximizedPane,
    messages: s.messages, crons: s.crons, tasks: s.tasks,
    events: s.events, notifications: s.notifications, pendingMasterNotes: [],
  }
}

export function applyScoped(s: AppState, d: WorkspaceData): AppState {
  return {
    ...s,
    focusedIds: d.focusedIds, activePane: d.activePane, minimizedIds: d.minimizedIds,
    paneSplits: d.paneSplits, maximizedPane: d.maximizedPane,
    messages: d.messages, crons: d.crons, tasks: d.tasks,
    events: d.events, notifications: d.notifications,
  }
}

/** Switch the active workspace: stash current scoped data, load the target's. */
export function switchWorkspaceIn(s: AppState, id: string, greeting: string): AppState {
  if (id === s.activeWorkspace || !s.workspaces.some(w => w.id === id)) return s
  const stash = { ...s.workspaceData, [s.activeWorkspace]: scopedFromState(s) }
  const target = stash[id] ?? emptyScoped(greeting)
  const rest = { ...stash }
  delete rest[id]
  return applyScoped({ ...s, activeWorkspace: id, workspaceData: rest, view: 'workspace' }, target)
}

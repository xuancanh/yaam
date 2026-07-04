// Pure helpers shared by the store: ids, cron parsing, prompt/dialog
// detection, agent-type utilities, pane focus semantics, and PTY input.
import * as native from './native'
import type { AgentTemplate, AgentType, AppState, EscOption, WorkspaceData } from './types'

let uid = 0
/** Generate a short UI identifier with a readable entity prefix. */
export function mkId(prefix: string): string {
  uid += 1
  return `${prefix}${Date.now()}-${uid}`
}

// Matches one field of a five-field cron expression: *, */n, a, a-b, and comma lists.
/** Match one cron field, supporting wildcards, steps, lists, and ranges. */
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

/** Evaluate a five-field cron expression against a local Date. */
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

/** Render common cron expressions as short labels and preserve uncommon input. */
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

/** Extract numbered TUI choices and the visible cursor from settled screen rows. */
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

/** full prompt handed to the one-shot session working a kanban task */
export function taskPrompt(task: { title: string; description?: string; criteria?: string[] }): string {
  return [
    task.title,
    task.description,
    task.criteria?.length ? `Acceptance criteria:\n${task.criteria.map(c => `- ${c}`).join('\n')}` : '',
  ].filter(Boolean).join('\n\n')
}

/** Resolve a configured agent type from the executable at the start of a command. */
export function typeForCommand(command: string, types: AppState['agentTypes']) {
  const bin = command.trim().split(/\s+/)[0]
  return types.find(t => t.model.trim().split(/\s+/)[0] === bin)
}

// Chrome-split-like focus: if the session is already in a slot, activate that
// pane; otherwise fill an empty slot (active one first). When the grid is
// full the session is shown SOLO on top of it — the split group stays intact
// and is never silently replaced. Never duplicates a session across panes
// (two panes would fight over the same terminal element).
export function focusSessionIn(s: AppState, id: string): AppState {
  s = { ...s, agents: s.agents.map(a => (a.id === id ? { ...a, archived: false, attention: false } : a)) }
  const minimizedIds = s.minimizedIds.filter(x => x !== id)
  const focusedIds: (string | null)[] = s.focusedIds.length ? s.focusedIds.slice() : [null]
  const existing = focusedIds.indexOf(id)
  if (existing >= 0) {
    return {
      ...s, focusedIds, minimizedIds, activePane: existing, soloId: null, view: 'workspace',
      maximizedPane: s.maximizedPane === null ? null : existing,
    }
  }
  let slot = Math.min(s.activePane, focusedIds.length - 1)
  if (focusedIds[slot] !== null) {
    const empty = focusedIds.indexOf(null)
    if (empty < 0) return { ...s, focusedIds, minimizedIds, soloId: id, view: 'workspace' }
    slot = empty
  }
  focusedIds[slot] = id
  return {
    ...s, focusedIds, minimizedIds,
    activePane: slot,
    soloId: null,
    view: 'workspace',
  }
}

// KEY=value lines → shell assignment prefix (we spawn via sh -lc)
/** Convert newline-delimited environment assignments into a shell-safe prefix. */
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

/** Launch a real PTY session through the native bridge. */
export function spawnAgentProcess(id: string, command: string, cwd?: string): Promise<void> {
  return native.spawnSession(id, command.trim(), cwd || undefined)
}

/** Resolve after a browser timer delay. */
export const wait = (ms: number) => new Promise<void>(r => window.setTimeout(r, ms))

export const KEYMAP: Record<string, string> = {
  enter: '\r', esc: '\x1b', escape: '\x1b', up: '\x1b[A', down: '\x1b[B',
  right: '\x1b[C', left: '\x1b[D', tab: '\t', space: ' ', backspace: '\x7f',
  'ctrl+c': '\x03', 'ctrl+d': '\x04',
}

/**
 * Send text and Enter as separate writes; terminal TUIs otherwise treat the
 * combined chunk as pasted text and may insert a newline instead of submitting.
 */
export function sendLineToSession(id: string, text: string) {
  native.writeSession(id, text).catch(() => {})
  window.setTimeout(() => { native.writeSession(id, '\r').catch(() => {}) }, 250)
}



// ---------- workspace scoping ----------

/** Create the isolated state slice for a new workspace. */
export function emptyScoped(greeting: string): WorkspaceData {
  return {
    focusedIds: [], activePane: 0, soloId: null, paneStacked: false, minimizedIds: [],
    paneSplits: { row: 0.5, cols: [0.5, 0.5] }, maximizedPane: null,
    messages: [{ id: mkId('m'), role: 'master', kind: 'text', text: greeting }],
    crons: [], tasks: [], events: [], notifications: [], pendingMasterNotes: [],
  }
}

/** Snapshot the active workspace's flat fields into a storable workspace slice. */
export function scopedFromState(s: AppState): WorkspaceData {
  return {
    focusedIds: s.focusedIds, activePane: s.activePane, soloId: s.soloId, paneStacked: s.paneStacked, minimizedIds: s.minimizedIds,
    paneSplits: s.paneSplits, maximizedPane: s.maximizedPane,
    messages: s.messages, crons: s.crons, tasks: s.tasks,
    events: s.events, notifications: s.notifications, pendingMasterNotes: [],
  }
}

/** Replace the flat active-workspace fields with a workspace slice. */
export function applyScoped(s: AppState, d: WorkspaceData): AppState {
  return {
    ...s,
    focusedIds: d.focusedIds.slice(0, 4), activePane: d.activePane,
    soloId: d.soloId ?? null, paneStacked: d.paneStacked ?? false, minimizedIds: d.minimizedIds,
    paneSplits: d.paneSplits, maximizedPane: d.maximizedPane,
    messages: d.messages, crons: d.crons, tasks: d.tasks,
    events: d.events, notifications: d.notifications,
  }
}

/** Switch the active workspace: stash current scoped data, load the target's. */
/** Stash the current workspace and hydrate the target workspace atomically. */
export function switchWorkspaceIn(s: AppState, id: string, greeting: string): AppState {
  if (id === s.activeWorkspace || !s.workspaces.some(w => w.id === id)) return s
  const stash = { ...s.workspaceData, [s.activeWorkspace]: scopedFromState(s) }
  const target = stash[id] ?? emptyScoped(greeting)
  const rest = { ...stash }
  delete rest[id]
  return applyScoped({ ...s, activeWorkspace: id, workspaceData: rest, view: 'workspace' }, target)
}

// ---------------------------------------------------------------- agent templates

/** Quote an arbitrary string for safe use as one POSIX shell argument. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/**
 * Build the CLI command for an agent template. Ephemeral templates use the
 * CLI's one-shot mode (claude -p / codex exec) so the process exits by itself
 * when the task is done; interactive templates start a long-running session
 * seeded with the prompt. `{task}` in the prompt is replaced by the task text;
 * without the placeholder the task is appended after the prompt.
 */
/** Translate a template into the real CLI invocation for its configured agent type. */
export function buildTemplateCommand(tpl: AgentTemplate, type: AgentType | undefined, task?: string): string {
  const bin = (type?.model ?? tpl.typeId).trim() || 'claude'
  const base = tpl.prompt.includes('{task}')
    ? tpl.prompt.replaceAll('{task}', task ?? '')
    : [tpl.prompt, task ?? ''].filter(Boolean).join('\n\n')
  const prompt = base.trim()
  const kind = type?.probe
    ?? (/(^|\/)claude$/.test(bin) ? 'claude' : /(^|\/)codex$/.test(bin) ? 'codex' : undefined)
  const extra = tpl.extraArgs.trim()
  const parts: string[] = [bin]

  if (kind === 'claude') {
    if (tpl.mode === 'ephemeral') parts.push('-p')
    if (tpl.model.trim()) parts.push('--model', shQuote(tpl.model.trim()))
    if (tpl.systemPrompt.trim()) parts.push('--append-system-prompt', shQuote(tpl.systemPrompt.trim()))
    if (tpl.approval === 'edits') parts.push('--permission-mode', 'acceptEdits')
    if (tpl.approval === 'full') parts.push('--dangerously-skip-permissions')
    if (extra) parts.push(extra)
    if (prompt) parts.push(shQuote(prompt))
    return parts.join(' ')
  }

  if (kind === 'codex') {
    if (tpl.mode === 'ephemeral') parts.push('exec')
    if (tpl.model.trim()) parts.push('-m', shQuote(tpl.model.trim()))
    if (tpl.approval === 'safe') parts.push('--sandbox', 'read-only')
    if (tpl.approval === 'edits') parts.push('--full-auto')
    if (tpl.approval === 'full') parts.push('--dangerously-bypass-approvals-and-sandbox')
    if (extra) parts.push(extra)
    // codex has no system-prompt flag — fold it into the prompt
    const full = [tpl.systemPrompt.trim(), prompt].filter(Boolean).join('\n\n')
    if (full) parts.push(shQuote(full))
    return parts.join(' ')
  }

  // generic CLI: flags verbatim, system prompt folded into the prompt
  if (extra) parts.push(extra)
  const full = [tpl.systemPrompt.trim(), prompt].filter(Boolean).join('\n\n')
  if (full) parts.push(shQuote(full))
  return parts.join(' ')
}

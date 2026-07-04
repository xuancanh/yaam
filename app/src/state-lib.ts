// Pure helpers shared by the store: ids, cron parsing, prompt/dialog
// detection, agent-type utilities, pane focus semantics, and PTY input.
import * as native from './native'
import type { AgentTemplate, AgentType, AppState, EscOption, TabGroup, WorkspaceData } from './types'

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

// A task's prompt has two layers that must not be mixed into one blob:
// the WORK TEXT (what to do — this is what fills a template's {task} slot)
// and the CONTRACT (criteria + goal stop-condition — appended after the
// fully composed prompt, so template framing never swallows or contradicts
// the verification rules).

/** the work item itself: title + description — fills a template's {task} slot */
export function taskWorkText(task: { title: string; description?: string }): string {
  return [task.title, task.description].filter(Boolean).join('\n\n')
}

/** verification contract appended after any template framing: acceptance
 *  criteria plus /goal-style stop-condition semantics (neither claude -p nor
 *  codex exec exposes a goal flag, so it lives in the prompt). */
export function taskContract(task: { criteria?: string[] }): string {
  const criteria = task.criteria ?? []
  if (!criteria.length) return ''
  return `Acceptance criteria:\n${criteria.map(c => `- ${c}`).join('\n')}\n\n` +
    'GOAL — treat the acceptance criteria above as your stop condition. They override any earlier instruction about when to stop. Before finishing, re-verify each criterion against your actual changes and outputs; if any is unmet, keep working until it is. If something genuinely blocks you, stop and state precisely what is blocking and what you completed.'
}

/** Resolve a configured agent type from the executable at the start of a command. */
export function typeForCommand(command: string, types: AppState['agentTypes']) {
  const bin = command.trim().split(/\s+/)[0]
  return types.find(t => t.model.trim().split(/\s+/)[0] === bin)
}

// ---------- tab groups (Chrome-style: each group owns its pane layout) ----------

/** Build a fresh tab group around the given slots. */
export function mkGroup(slots: (string | null)[], stacked = false): TabGroup {
  return {
    id: mkId('g'),
    slots: slots.length ? slots.slice(0, 4) : [null],
    stacked,
    activePane: 0,
    maximizedPane: null,
    splits: { row: 0.5, cols: [0.5, 0.5] },
  }
}

/** The group currently shown in the workspace grid. */
export function activeGroupOf(s: Pick<AppState, 'groups' | 'activeGroup'>): TabGroup | undefined {
  return s.groups.find(g => g.id === s.activeGroup)
}

/** Migrate legacy flat pane state (focusedIds/soloId/…) into tab groups. */
export function groupsFromLegacy(d: {
  focusedIds?: (string | null)[]
  activePane?: number
  soloId?: string | null
  paneStacked?: boolean
  paneSplits?: { row: number; cols: number[] }
}): { groups: TabGroup[]; activeGroup: string | null } {
  const groups: TabGroup[] = []
  const slots = (d.focusedIds ?? []).slice(0, 4)
  if (slots.some(Boolean)) {
    const g = mkGroup(slots, d.paneStacked ?? false)
    g.activePane = Math.max(0, Math.min(d.activePane ?? 0, g.slots.length - 1))
    if (d.paneSplits) g.splits = d.paneSplits
    groups.push(g)
  }
  let activeGroup = groups[0]?.id ?? null
  if (d.soloId && !slots.includes(d.soloId)) {
    const solo = mkGroup([d.soloId])
    groups.push(solo)
    activeGroup = solo.id
  }
  return { groups, activeGroup }
}

/** Drop a session from every group; prune groups that end up fully empty.
 *  A single-pane group always closes with its session; an emptied ACTIVE
 *  multi-pane grid survives so the user can reassign its sections. */
export function removeFromGroups(s: AppState, id: string): Pick<AppState, 'groups' | 'activeGroup'> {
  let groups = s.groups.map(g => g.slots.includes(id)
    ? { ...g, slots: g.slots.map(x => (x === id ? null : x)), maximizedPane: null }
    : g)
  groups = groups.filter(g => g.slots.some(Boolean) || (g.id === s.activeGroup && g.slots.length > 1))
  const activeGroup = groups.some(g => g.id === s.activeGroup) ? s.activeGroup : groups[0]?.id ?? null
  return { groups, activeGroup }
}

// Chrome-like focus: if the session already lives in a group, activate that
// group and pane. Otherwise fill an empty slot of the ACTIVE group (its active
// slot first) so tabs clicked into a split merge into it — and when the active
// group is full, the session opens as its own tab (a new single group).
// A session never appears in two groups (panes would fight over its terminal).
export function focusSessionIn(s: AppState, id: string): AppState {
  s = { ...s, agents: s.agents.map(a => (a.id === id ? { ...a, archived: false, attention: false } : a)) }
  const minimizedIds = s.minimizedIds.filter(x => x !== id)
  const owner = s.groups.find(g => g.slots.includes(id))
  if (owner) {
    const pane = owner.slots.indexOf(id)
    return {
      ...s, minimizedIds, activeGroup: owner.id, view: 'workspace',
      groups: s.groups.map(g => g.id === owner.id
        ? { ...g, activePane: pane, maximizedPane: g.maximizedPane === null ? null : pane }
        : g),
    }
  }
  const ag = activeGroupOf(s)
  if (ag) {
    const slot = ag.slots[ag.activePane] === null ? ag.activePane : ag.slots.indexOf(null)
    if (slot >= 0) {
      return {
        ...s, minimizedIds, view: 'workspace',
        groups: s.groups.map(g => g.id === ag.id
          ? { ...g, slots: g.slots.map((x, i) => (i === slot ? id : x)), activePane: slot }
          : g),
      }
    }
  }
  const ng = mkGroup([id])
  return { ...s, minimizedIds, groups: s.groups.concat([ng]), activeGroup: ng.id, view: 'workspace' }
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

/** Launch a command or persisted direct terminal shell through the native bridge. */
export function spawnAgentProcess(id: string, command: string, cwd?: string, terminalShell?: string): Promise<void> {
  return native.spawnSession(id, command.trim(), cwd || undefined, undefined, undefined, terminalShell)
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
    groups: [], activeGroup: null, minimizedIds: [],
    messages: [{ id: mkId('m'), role: 'master', kind: 'text', text: greeting }],
    crons: [], tasks: [], events: [], notifications: [], pendingMasterNotes: [],
  }
}

/** Snapshot the active workspace's flat fields into a storable workspace slice. */
export function scopedFromState(s: AppState): WorkspaceData {
  return {
    groups: s.groups, activeGroup: s.activeGroup, minimizedIds: s.minimizedIds,
    messages: s.messages, crons: s.crons, tasks: s.tasks,
    events: s.events, notifications: s.notifications, pendingMasterNotes: [],
  }
}

/** Replace the flat active-workspace fields with a workspace slice. */
export function applyScoped(s: AppState, d: WorkspaceData): AppState {
  const { groups, activeGroup } = d.groups
    ? { groups: d.groups, activeGroup: d.activeGroup && d.groups.some(g => g.id === d.activeGroup) ? d.activeGroup : d.groups[0]?.id ?? null }
    : groupsFromLegacy(d)
  return {
    ...s,
    groups, activeGroup, minimizedIds: d.minimizedIds,
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
export function buildTemplateCommand(tpl: AgentTemplate, type: AgentType | undefined, task?: string, contract?: string): string {
  const bin = (type?.model ?? tpl.typeId).trim() || 'claude'
  const base = tpl.prompt.includes('{task}')
    ? tpl.prompt.replaceAll('{task}', task ?? '')
    : [tpl.prompt, task ?? ''].filter(Boolean).join('\n\n')
  // the verification contract (criteria + goal) rides AFTER the composed
  // prompt so template framing never swallows or contradicts it
  const prompt = [base.trim(), (contract ?? '').trim()].filter(Boolean).join('\n\n')
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
    // exec refuses to run outside a trusted git directory unless told not to
    // check — one-shot task sessions must not die on that
    if (tpl.mode === 'ephemeral') parts.push('exec', '--skip-git-repo-check')
    if (tpl.model.trim()) parts.push('-m', shQuote(tpl.model.trim()))
    if (tpl.approval === 'safe') parts.push('--sandbox', 'read-only')
    // --full-auto is deprecated in favor of the explicit sandbox mode
    if (tpl.approval === 'edits') parts.push('--sandbox', 'workspace-write')
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

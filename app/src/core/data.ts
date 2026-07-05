import type { Agent, AgentTool, AppState, DiffFile, MemorySource, Perm, Snapshot } from './types'

export const ACCENT = '#F5C451'

export const SHELLS = ['zsh', 'bash', 'sh', 'fish', 'nu']

export const MASTER_GREETING = 'I’m Master for this workspace. Give me a brain in Settings → Master Brain (any supported provider’s API key), then tell me what you need — I launch and command sessions, answer questions about them, and build schedules.'

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
  meta: 'rgba(245,196,81,.08)',
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

/** Convert a six-digit hex color to an rgba() value with the requested alpha. */
export function hexToRgba(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
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

/** Build a complete fresh AppState used before persisted state is hydrated. */
export function seedState(): AppState {
  return {
    bootStatus: 'loading',
    view: 'workspace',
    workspaces: [{ id: 'ws-default', name: 'Default' }],
    activeWorkspace: 'ws-default',
    workspaceData: {},
    groups: [],
    activeGroup: null,
    activeChatId: null,
    minimizedIds: [],
    composer: '',
    panel: null,
    toast: null,
    drawer: null,
    paletteOpen: false,
    paletteQuery: '',
    notifOpen: false,
    newSessionOpen: false,
    masterBusy: false,
    dragOverCol: null,
    addons: [],
    activeAddon: null,
    addonStorage: {},
    addonChats: {},
    addonChatBusy: null,
    pendingToolApprovals: [],
    agents: [],
    events: [],
    notifications: [],
    agentTypes: [
      { id: 'claude', name: 'Claude Code', color: '#E8A87C', model: 'claude', tools: 6, desc: 'Anthropic CLI — deep multi-file edits, tests, and refactors.', enabled: true, resumeCmd: 'claude --resume {id}', resumeFallbackCmd: 'claude --continue', probe: 'claude' },
      { id: 'codex', name: 'Codex', color: '#34D399', model: 'codex', tools: 6, desc: 'OpenAI CLI — fast fixes, typechecking, and e2e.', enabled: true, resumeCmd: 'codex resume {id}', resumeFallbackCmd: 'codex resume --last', probe: 'codex' },
      { id: 'gemini', name: 'Gemini CLI', color: '#6C8EF5', model: 'gemini', tools: 5, desc: 'Google CLI — very large-context refactors.', enabled: true },
      { id: 'aider', name: 'Aider', color: '#C77DFF', model: 'aider', tools: 6, desc: 'Pair-programming CLI — git-native diffs.', enabled: true, resumeCmd: 'aider --restore-chat-history' },
      { id: 'cursor', name: 'Cursor Agent', color: '#9AA3B2', model: 'cursor-agent', tools: 4, desc: 'Background agent — repo-wide autonomous tasks.', enabled: false },
    ],
    templates: [
      {
        id: 'tpl-claude-oneshot', name: 'claude-one-shot', typeId: 'claude', mode: 'ephemeral' as const,
        prompt: '{task}', systemPrompt: '', model: '', approval: 'edits' as const,
        cwd: '', extraArgs: '', autoArchive: false,
      },
      {
        id: 'tpl-codex-oneshot', name: 'codex-one-shot', typeId: 'codex', mode: 'ephemeral' as const,
        prompt: '{task}', systemPrompt: '', model: '', approval: 'edits' as const,
        cwd: '', extraArgs: '', autoArchive: false,
      },
    ],
    mcpServers: [],
    personas: [
      {
        id: 'persona-terse-engineer',
        name: 'terse-engineer',
        description: 'Senior engineer voice: short, direct, evidence-first.',
        body: 'Speak like a senior engineer in a hurry: lead with the answer, cite file:line for claims about code, prefer diffs over descriptions, flag risks in one line each, no pleasantries.',
      },
    ],
    skillRegistries: [
      { id: 'sr-anthropic', name: 'anthropic', url: 'https://github.com/anthropics/skills/tree/main/skills', enabled: true },
    ],
    chatAgentTypes: [
      { id: 'chat-claude', name: 'Claude', provider: 'anthropic', model: 'claude-sonnet-5', models: ['claude-sonnet-5', 'claude-haiku-4-5-20251001', 'claude-opus-4-8'], enabled: true, desc: 'Shares the Master Brain credentials unless a key is set.' },
      { id: 'chat-gpt', name: 'GPT', provider: 'openai', model: 'gpt-4o', models: ['gpt-4o', 'gpt-4o-mini', 'o4-mini'], enabled: false, desc: 'Needs an OpenAI API key.' },
      { id: 'chat-deepseek', name: 'DeepSeek', provider: 'deepseek', model: 'deepseek-chat', models: ['deepseek-chat', 'deepseek-reasoner'], enabled: false, desc: 'Needs a DeepSeek API key.' },
      { id: 'chat-gemini', name: 'Gemini', provider: 'gemini', model: 'gemini-2.5-flash', models: ['gemini-2.5-flash', 'gemini-2.5-pro'], enabled: false, desc: 'Needs a Google AI Studio key.' },
    ],
    skills: [
      {
        id: 'skill-commit-style',
        name: 'clean-commits',
        description: 'House rules for writing commit messages and splitting commits.',
        body: 'When committing: imperative mood subject under 65 chars; body explains WHY, wrapped at 72; one logical change per commit — split refactors from behavior changes; never commit commented-out code or debug prints.',
      },
    ],
    settings: {
      autoRoute: true, approveDestructive: true, followMode: true,
      shell: 'zsh', defaultCwd: '',
      masterEnabled: false, masterModel: 'claude-sonnet-5', monitorModel: 'claude-haiku-4-5-20251001', apiKey: '',
      provider: 'anthropic', baseUrl: '',
      awsRegion: 'us-east-1', awsProfile: '', awsRefreshCmd: '', credCmd: '',
      registryUrl: 'https://raw.githubusercontent.com/xuancanh/yaam/main/registry/index.json',
      registries: [{ name: 'yaam', url: 'https://raw.githubusercontent.com/xuancanh/yaam/main/registry/index.json' }],
    },
    tasks: [],
    messages: [
      {
        id: 'm1', role: 'master', kind: 'text',
        text: 'I’m Master. Give me a brain in Settings → Master Brain (any supported provider’s API key), then tell me what you need — I launch and command sessions, answer questions about them, and build schedules.',
      },
    ],
    crons: [],
    // Master's global tools — permissions here gate its tool executor.
    // Auto: act freely · Ask first: confirm in chat first · Approval/Off: blocked.
    toolsCatalog: [
      { id: 'launch_session', name: 'Launch session', desc: 'Master may spawn new CLI sessions.', perm: 'Auto', agents: 0 },
      { id: 'send_to_session', name: 'Send input', desc: 'Master may write to a session\'s terminal (per-session override in the session panel).', perm: 'Auto', agents: 0 },
      { id: 'stop_session', name: 'Stop session', desc: 'Master may kill running sessions.', perm: 'Ask first', agents: 0 },
      { id: 'create_schedule', name: 'Create schedule', desc: 'Master may add recurring cron schedules.', perm: 'Auto', agents: 0 },
      { id: 'add_task', name: 'Add board task', desc: 'Master may add cards to the task board.', perm: 'Auto', agents: 0 },
      { id: 'configure_setting', name: 'Change settings', desc: 'Master may change app settings from chat (never API keys).', perm: 'Auto', agents: 0 },
      { id: 'set_tool_permission', name: 'Change permissions', desc: 'Master may change its own tool permissions.', perm: 'Ask first', agents: 0 },
      { id: 'create_addon', name: 'Build addons', desc: 'Master may create custom tabs (sandboxed HTML addons).', perm: 'Auto', agents: 0 },
    ],
  }
}

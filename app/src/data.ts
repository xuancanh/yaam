import type { AgentTool, AppState, DiffFile, MemorySource, Perm, Snapshot } from './types'

export const ACCENT = '#F5C451'

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

export function hexToRgba(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
}

export function mkMemory(): MemorySource[] {
  return [
    { id: 'repomap', label: 'Repository map', detail: 'auto-indexed', tokens: 8.1, on: true },
    { id: 'guide', label: 'Project guide', detail: 'CLAUDE.md · conventions', tokens: 2.3, on: true },
    { id: 'diffs', label: 'Recent diffs', detail: 'last 12 commits', tokens: 4.7, on: true },
    { id: 'summary', label: 'Session summary', detail: 'rolling context', tokens: 3.2, on: true },
  ]
}

export function mkTools(): AgentTool[] {
  return [
    { id: 'shell', name: 'Shell', on: true, perm: 'Ask first' },
    { id: 'fs', name: 'File write', on: true, perm: 'Auto' },
    { id: 'git', name: 'Git', on: true, perm: 'Auto' },
    { id: 'http', name: 'HTTP fetch', on: true, perm: 'Ask first' },
    { id: 'db', name: 'DB query', on: false, perm: 'Approval' },
    { id: 'browser', name: 'Browser', on: false, perm: 'Off' },
  ]
}

export interface AgentDetail {
  used: number
  cost: number
  budget: number
  snaps: Snapshot[]
  diff: DiffFile[]
}

export function defaultDetail(): AgentDetail {
  return { used: 0, cost: 0, budget: 3.0, snaps: [{ label: 'session start', time: 'just now' }], diff: [] }
}

export function seedState(): AppState {
  return {
    view: 'workspace',
    activePane: 0,
    maximizedPane: null,
    focusedIds: [],
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
    agents: [],
    events: [],
    notifications: [],
    agentTypes: [
      { id: 'claude', name: 'Claude Code', color: '#E8A87C', model: 'claude', tools: 6, desc: 'Anthropic CLI — deep multi-file edits, tests, and refactors.', enabled: true },
      { id: 'codex', name: 'Codex', color: '#34D399', model: 'codex', tools: 6, desc: 'OpenAI CLI — fast fixes, typechecking, and e2e.', enabled: true },
      { id: 'gemini', name: 'Gemini CLI', color: '#6C8EF5', model: 'gemini', tools: 5, desc: 'Google CLI — very large-context refactors.', enabled: true },
      { id: 'aider', name: 'Aider', color: '#C77DFF', model: 'aider', tools: 6, desc: 'Pair-programming CLI — git-native diffs.', enabled: true },
      { id: 'cursor', name: 'Cursor Agent', color: '#9AA3B2', model: 'cursor-agent', tools: 4, desc: 'Background agent — repo-wide autonomous tasks.', enabled: false },
    ],
    integrations: [
      { id: 'github', name: 'GitHub', cat: 'Source control', detail: 'not connected', connected: false },
      { id: 'linear', name: 'Linear', cat: 'Issue tracking', detail: 'not connected', connected: false },
      { id: 'slack', name: 'Slack', cat: 'Notifications', detail: 'not connected', connected: false },
      { id: 'postgres', name: 'Postgres', cat: 'Databases', detail: 'not connected', connected: false },
      { id: 'figma', name: 'Figma (MCP)', cat: 'Design', detail: 'not connected', connected: false },
      { id: 'sentry', name: 'Sentry', cat: 'Monitoring', detail: 'not connected', connected: false },
    ],
    settings: {
      autoRoute: true, approveDestructive: true, followMode: true,
      shell: 'zsh', defaultCwd: '',
      masterEnabled: false, masterModel: 'claude-sonnet-5', apiKey: '',
    },
    tasks: [],
    messages: [
      {
        id: 'm1', role: 'master', kind: 'text',
        text: 'I’m Master. Launch a live session (⌘K → New agent session), then tell me what you need — I route tasks to sessions, answer questions about them, and build tools and schedules.',
      },
    ],
    crons: [],
    toolsCatalog: [
      { id: 'shell', name: 'Shell', desc: 'Run commands in the workspace sandbox.', perm: 'Ask first', agents: 0 },
      { id: 'fs', name: 'File write', desc: 'Create and edit files in the repository.', perm: 'Auto', agents: 0 },
      { id: 'git', name: 'Git', desc: 'Stage, commit, branch, and push changes.', perm: 'Auto', agents: 0 },
      { id: 'http', name: 'HTTP fetch', desc: 'Outbound requests to allowlisted hosts only.', perm: 'Ask first', agents: 0 },
      { id: 'db', name: 'DB query', desc: 'Read and write against connected databases.', perm: 'Approval', agents: 0 },
      { id: 'browser', name: 'Browser', desc: 'Headless browsing and page scraping.', perm: 'Off', agents: 0 },
    ],
  }
}

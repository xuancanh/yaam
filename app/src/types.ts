export type LogKind = 'sys' | 'you' | 'run' | 'out' | 'think' | 'edit' | 'warn' | 'err'

export interface LogLine {
  t: LogKind
  x: string
}

export type AgentStatus = 'running' | 'idle' | 'needs' | 'error'

export type Perm = 'Off' | 'Ask first' | 'Auto' | 'Approval'

export interface MemorySource {
  id: string
  label: string
  detail: string
  tokens: number
  on: boolean
}

export interface AgentTool {
  id: string
  name: string
  on: boolean
  perm: Perm
}

export type HunkKind = 'add' | 'del' | 'ctx' | 'meta'

export interface DiffHunk {
  t: HunkKind
  x: string
}

export interface DiffFile {
  file: string
  add: number
  del: number
  hunks: DiffHunk[]
}

export interface Snapshot {
  label: string
  time: string
}

export interface Agent {
  id: string
  name: string
  short: string
  color: string
  repo: string
  branch: string
  status: AgentStatus
  model: string
  /** 'real' agents are OS processes managed by the Tauri backend; the rest are simulated */
  kind?: 'sim' | 'real'
  cmd?: string
  cwd?: string
  fi: number
  feed: LogLine[]
  memory: MemorySource[]
  tools: AgentTool[]
  log: LogLine[]
  escReason?: string
  used: number
  cost: number
  budget: number
  snaps: Snapshot[]
  diff: DiffFile[]
  /** the CLI's own session/conversation id, captured after launch for resume */
  cliSessionId?: string
  launchedAt?: number
  /** archived sessions are hidden from tabs/overview but kept for history */
  archived?: boolean
  /** agent type used to launch this session (env + resume behavior) */
  typeId?: string
  /** unseen event: finished its job / needs action — flashes in tabs and overview until viewed */
  attention?: boolean
  /** Master-maintained: what this agent is working on */
  task?: string
  /** Master-maintained: latest 1-2 sentence state summary */
  summary?: string
  /** Master-maintained: what the user must do, if anything */
  actionNeeded?: string
  summaryAt?: string
}

export interface RouteEntry {
  name: string
  color: string
  repo: string
  task: string
  action: string
}

export interface EscOption {
  num: number
  label: string
}

export interface Escalation {
  name: string
  color: string
  repo: string
  reason: string
  resolved: boolean
  decision: 'approved' | 'denied' | null
  /** numbered options extracted from the dialog, when it is a menu */
  options?: EscOption[]
  /** option number the ❯ cursor was on when detected */
  cursorNum?: number
  /** label of the option the user picked */
  choice?: string
}

export interface BuildResult {
  kind: 'tool' | 'cron'
  title: string
  detail: string
  view: View
}

export interface BuildUI {
  title: string
  stage: number
  done: boolean
  bars: number[]
}

export interface Message {
  id: string
  role: 'you' | 'master'
  kind: 'text' | 'route' | 'escalate' | 'build' | 'buildui'
  text?: string
  routes?: RouteEntry[]
  esc?: Escalation
  escFor?: string
  build?: BuildResult
  buildUI?: BuildUI
  /** Master's collapsed tool-use / reasoning trace */
  thinking?: string
}

export interface Cron {
  id: string
  name: string
  schedule: string
  human: string
  target: string
  agent: string
  color: string
  on: boolean
  built: boolean
  last: string
  /** command to launch as a real session when the schedule fires */
  cmd?: string
  cwd?: string
  lastFiredMinute?: string
}

export interface CatalogTool {
  id: string
  name: string
  desc: string
  perm: Perm
  agents: number
  built?: boolean
}

export type EventType = 'route' | 'edit' | 'test' | 'escalate' | 'cron' | 'build' | 'done'

export interface EventItem {
  id: string
  type: EventType
  agentId: string | null
  text: string
  time: string
}

export type NotifKind = 'escalate' | 'done' | 'cron'

export interface Notification {
  id: string
  kind: NotifKind
  title: string
  detail: string
  time: string
  read: boolean
  agentId: string | null
}

export interface AgentType {
  id: string
  name: string
  color: string
  /** command line used to launch this agent type as a session */
  model: string
  tools: number
  desc: string
  enabled: boolean
  /** environment variables, one KEY=value per line, applied when launching */
  env?: string
  /** user-created type (deletable) */
  custom?: boolean
  /** command used to resume a previous CLI session; {id} is replaced with the captured session id */
  resumeCmd?: string
  /** resume command when no session id was captured (e.g. claude --continue) */
  resumeFallbackCmd?: string
  /** how to detect the CLI's session id after launch */
  probe?: 'claude' | 'codex'
}

export interface Integration {
  id: string
  name: string
  cat: string
  detail: string
  connected: boolean
}

export interface OrchestrationSettings {
  autoRoute: boolean
  approveDestructive: boolean
  followMode: boolean
  /** shell used for plain terminal sessions */
  shell: string
  /** default working directory prefilled in the new-session dialog */
  defaultCwd: string
  /** Master brain: when enabled with an API key, Master is an LLM with tools */
  masterEnabled: boolean
  masterModel: string
  /** model for per-session monitor LLMs; empty = same as masterModel */
  monitorModel: string
  apiKey: string
  /** LLM provider: anthropic | openai | deepseek | kimi | custom */
  provider: string
  /** base URL for the custom provider (OpenAI-compatible) */
  baseUrl: string
}

export type BoardCol = 'backlog' | 'routed' | 'progress' | 'review' | 'done'

export interface BoardTask {
  id: string
  title: string
  col: BoardCol
  agentId: string | null
}

export interface Addon {
  id: string
  name: string
  /** single char / emoji shown in the icon rail */
  icon: string
  /** self-contained HTML document rendered in a sandboxed iframe */
  html: string
  desc?: string
  createdAt: string
}

export type View =
  | 'workspace'
  | 'overview'
  | 'board'
  | 'timeline'
  | 'usage'
  | 'crons'
  | 'tools'
  | 'settings'
  | 'addon'

export interface Panel {
  agentId: string
  tab: 'memory' | 'tools'
}

export interface Drawer {
  kind: 'agent' | 'diff'
  agentId: string
}

export interface PersistedState {
  tasks: BoardTask[]
  crons: Cron[]
  settings: OrchestrationSettings
  toolsCatalog: CatalogTool[]
  agentTypes: AgentType[]
  integrations: Integration[]
  /** session definitions + output tails; restored as paused sessions */
  agents?: Agent[]
  focusedIds?: string[]
  activePane?: number
  minimizedIds?: string[]
  paneSplits?: { row: number; cols: number[] }
  addons?: Addon[]
  messages?: Message[]
  events?: EventItem[]
  notifications?: Notification[]
}

export interface AppState {
  view: View
  activePane: number
  /** index into focusedIds of the pane that is currently maximized, or null */
  maximizedPane: number | null
  focusedIds: string[]
  /** sessions minimized to the dock strip */
  minimizedIds: string[]
  /** divider ratios: row = first row height fraction, cols = first pane width fraction per row */
  paneSplits: { row: number; cols: number[] }
  composer: string
  panel: Panel | null
  toast: string | null
  drawer: Drawer | null
  paletteOpen: boolean
  paletteQuery: string
  notifOpen: boolean
  newSessionOpen: boolean
  masterBusy: boolean
  dragOverCol: BoardCol | null
  addons: Addon[]
  activeAddon: string | null
  agents: Agent[]
  messages: Message[]
  crons: Cron[]
  toolsCatalog: CatalogTool[]
  events: EventItem[]
  notifications: Notification[]
  agentTypes: AgentType[]
  integrations: Integration[]
  settings: OrchestrationSettings
  tasks: BoardTask[]
}

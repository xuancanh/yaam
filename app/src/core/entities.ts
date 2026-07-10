// Entity and record types for every domain. This is the shared type hub with
// no imports from domain folders, so domain state slices can import entities
// here without a cycle. core/types re-exports everything below as a barrel and
// composes the domain slices into AppState.

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

export interface ChatAttachmentRecord {
  name: string
  kind: 'text' | 'image'
  text?: string
  mediaType?: string
  path?: string
}

export interface ChatToolEvent {
  id: string
  at: number
  name: string
  input: string
  result: string
  status: 'completed' | 'failed' | 'denied' | 'truncated'
}

export interface ChatTurn {
  id: string
  at: number
  startedAt: number
  completedAt?: number
  status: 'running' | 'complete' | 'stopped' | 'failed'
  model: string
  input: {
    text: string
    attachments: ChatAttachmentRecord[]
    skill?: string
  }
  assistantText?: string
  error?: string
  tools: ChatToolEvent[]
  usage?: {
    inputTokens: number
    outputTokens: number
  }
}

export interface ChatQueuedMessage {
  id: string
  at: number
  text: string
  attachments: ChatAttachmentRecord[]
}

export interface ChatComposerState {
  draft: string
  attachments: ChatAttachmentRecord[]
  queue: ChatQueuedMessage[]
}

/** Transient per-session runtime state — NOT persisted. Hydration re-derives it
 *  (restored sessions always start idle). Split out from the durable SessionRecord
 *  so the persistence boundary is explicit and type-enforced rather than an ad-hoc
 *  field list. Other runtime concerns (active request, terminal attachment,
 *  pending approval) live outside the store in their own registries. */
export interface SessionRuntimeState {
  status: AgentStatus
  /** transient escalation reason shown while a session waits on the user */
  escReason?: string
  /** transient: the PTY is actively streaming output right now (drives the tab's
   *  blinking "responding" indicator). Cleared once output goes quiet. */
  responding?: boolean
}

/** The durable configuration + history of a session: everything that is
 *  persisted (see `selectSession`). Combined with SessionRuntimeState to form the
 *  working `Agent` type used across the app. */
export interface SessionRecord {
  id: string
  name: string
  short: string
  color: string
  repo: string
  branch: string
  model: string
  /** 'real' = PTY process · 'chat' = in-app LLM chat agent (Claude-Desktop-style) */
  kind?: 'sim' | 'real' | 'chat'
  cmd?: string
  cwd?: string
  /** executable used for a plain terminal; bypasses the generic /bin/sh command wrapper */
  terminalShell?: string
  memory: MemorySource[]
  tools: AgentTool[]
  log: LogLine[]
  used: number
  cost: number
  budget: number
  /** Usage counters use printable terminal characters, not the legacy line-count heuristic. */
  usageVersion?: 1
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
  /** owning workspace */
  workspaceId?: string
  /** Master-maintained: what this agent is working on */
  task?: string
  /** Master-maintained: latest 1-2 sentence state summary */
  summary?: string
  /** Master-maintained: what the user must do, if anything */
  actionNeeded?: string
  summaryAt?: string
  /** one-shot run (claude -p / codex exec): exits by itself when done */
  ephemeral?: boolean
  /** archive automatically after a successful ephemeral run */
  autoArchive?: boolean
  /** template this session was launched from */
  templateId?: string
  /** chat-mode conversation (kind === 'chat') */
  chatLog?: ChatMsg[]
  /** durable structured work records; legacy chats populate this on their next turn */
  chatTurns?: ChatTurn[]
  /** durable unsent work so navigation and restarts do not discard it */
  chatComposer?: ChatComposerState
  /** name was never chosen by the user — safe to auto-title from the conversation */
  nameIsDefault?: boolean
  /** which ChatAgentType powers this chat session */
  chatTypeId?: string
  /** model chosen for this session (from the type's models list) */
  chatModel?: string
  /** persona adopted by this chat session */
  personaId?: string
  /** skill sources for this chat: 'local' and/or SkillRegistry ids */
  skillSourceIds?: string[]
  /** chat tool safety: 'ask' (default) pauses shell/AppleScript/delete tool
   *  calls for inline approval; 'auto' runs them without asking */
  permMode?: 'ask' | 'auto'
  /** git-worktree isolation this session runs in (cwd === workdir) */
  worktree?: { root: string; base: string; workdir: string }
  /** the PTY lives in a detached host process that outlives the app; the
   *  session command is an attach client (resume = reconnect) */
  detached?: boolean
  /** runs on a saved remote machine over SSH + tmux; `cmd` is the original agent
   *  command (the ssh/tmux wrap is rebuilt on launch/resume), `cwd` is the remote
   *  working dir. Persistence is the remote tmux session, not a CLI resume id. */
  machineId?: string
  /** connection snapshot taken at launch, so the session keeps resuming/stopping
   *  and browsing Files/Git even if the saved machine is later edited or removed */
  machine?: Machine
}

/** A session as the app works with it: durable record plus live runtime state.
 *  Remains the single working type across the UI and actions; the record/runtime
 *  split is the persistence and domain boundary, not a call-site concern. */
export type Agent = SessionRecord & SessionRuntimeState

/** The runtime-only keys, as a value — the single source of truth persistence
 *  uses to strip transient fields. Typed as keyof SessionRuntimeState so it stays
 *  in sync if the runtime shape changes. */
export const SESSION_RUNTIME_KEYS: ReadonlyArray<keyof SessionRuntimeState> = ['status', 'escReason', 'responding']

/** one message in a chat-mode session */
export interface ChatMsg {
  id: string
  role: 'user' | 'assistant' | 'tool' | 'thinking'
  text: string
  at: number
  /** set on tool-approval prompts (ask mode): awaiting → user decided */
  approval?: 'pending' | 'approved' | 'denied'
  /** structured turn that produced this visible transcript entry */
  turnId?: string
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

/** One recorded firing of a schedule: when, what happened, and where the
 *  result lives (session / board task) so the user can jump to it. */
export interface CronRun {
  at: number
  /** short outcome line, e.g. `launched: npm test` / `added task “…”` */
  note: string
  ok: boolean
  /** session the firing launched, when the action was a command */
  agentId?: string
  /** board task the firing created, for task/template schedules */
  taskId?: string
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
  /** one-time run at this epoch ms (instead of a recurring cron expression) */
  at?: number
  /** when set, firing adds this task to the kanban board instead of launching.
   *  Carries the full task spec (same shape the board's New-task dialog produces);
   *  startNow spawns its watcher-driven session immediately on fire. */
  boardTask?: {
    title: string
    description?: string
    criteria?: string[]
    templateId?: string
    typeId?: string
    cwd?: string
    machineId?: string
    isolate?: boolean
    sessionMode?: 'oneshot' | 'interactive'
    startNow?: boolean
  }
  lastFiredMinute?: string
  /** newest-first log of the last firings and what each produced */
  runs?: CronRun[]
  /** agent template launched on fire (overrides cmd) */
  templateId?: string
  /** task text passed to the template */
  prompt?: string
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

/** an MCP server chat agents can call tools on — streamable HTTP or a local
 *  stdio process (the transport most published servers use) */
export interface McpServer {
  id: string
  name: string
  /** http(s) endpoint implementing MCP streamable HTTP (http transport) */
  url: string
  /** extra request headers, one "KEY: value" per line (auth tokens etc.) */
  headers?: string
  /** transport; absent = 'http' (pre-stdio servers) */
  transport?: 'http' | 'stdio'
  /** stdio: executable to spawn (npx, uvx, node, a binary…) */
  command?: string
  /** stdio: arguments */
  args?: string[]
  /** stdio: environment, one "KEY=value" per line */
  env?: string
  /** stdio: working directory (e.g. an unpacked .mcpb bundle dir) */
  cwd?: string
  enabled: boolean
  /** last successful connection's tool count */
  toolCount?: number
  /** last connection error, if any */
  lastError?: string
}

/** a configurable chat-agent type: provider + model + credentials */
export interface ChatAgentType {
  id: string
  name: string
  desc?: string
  /** provider id from llm/client PROVIDERS (anthropic, openai, deepseek, kimi, gemini, glm, bedrock, custom, anthropic-compat) */
  provider: string
  /** default model (first of `models`) */
  model: string
  /** predefined model list for this agent — pickable per session */
  models?: string[]
  /** empty = share the Master Brain credentials when the provider matches */
  apiKey?: string
  /** endpoint for the custom / anthropic-compat providers */
  baseUrl?: string
  /** extra persona appended to the chat agent's system prompt */
  systemPrompt?: string
  enabled: boolean
}

/** a named persona chat agents can adopt (picked per chat) */
export interface Persona {
  id: string
  name: string
  description: string
  /** appended to the chat agent's system prompt */
  body: string
}

/** a remote or local source of skills (e.g. Anthropic's github skills repo) */
export interface SkillRegistry {
  id: string
  name: string
  /** github tree URL (https://github.com/o/r/tree/branch/path) or a local folder of skill dirs with SKILL.md */
  url: string
  enabled: boolean
  /** last successful fetch's skill count */
  skillCount?: number
  lastError?: string
}

/** a reusable instruction pack chat agents can load on demand */
export interface Skill {
  id: string
  name: string
  description: string
  /** the instructions injected when the skill is loaded */
  body: string
}

/** Settings → Appearance: theme, scale, density, and typography. All optional —
 *  absent fields fall back to APPEARANCE_DEFAULTS (dark / 100% / normal). */
export interface AppearanceSettings {
  theme?: 'dark' | 'light' | 'paper' | 'midnight' | 'system'
  /** whole-UI scale in percent (80–140) */
  uiScale?: number
  density?: 'compact' | 'normal' | 'comfortable'
  uiFont?: 'plex' | 'system' | 'grotesk'
  monoFont?: 'jetbrains' | 'system'
  /** markdown table font size, px */
  tableFontSize?: number
  tableFont?: 'sans' | 'mono'
}

/** A saved remote machine agents can run on over SSH (inside tmux for
 *  durability). Auth is keys/ssh-agent only — `identityFile` is a path, never
 *  key contents, and there is deliberately no password field. */
export interface Machine {
  id: string
  /** display name in the machine picker */
  label: string
  host: string
  user: string
  /** ssh port; defaults to 22 */
  port?: number
  /** path to a private key passed as `ssh -i`; empty = ssh-agent/default keys */
  identityFile?: string
  /** default working directory on the host (prefilled cwd / fs+git root) */
  remoteDir?: string
  /** extra raw `ssh -o` options for advanced setups (space-separated) */
  options?: string
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
  /** legacy single addon-registry URL (superseded by `registries`) */
  registryUrl: string
  /** addon registries: http(s) index URLs or local folder/index.json paths */
  registries?: { name: string; url: string }[]
  /** Claude plugin marketplaces (repos with .claude-plugin/marketplace.json);
   *  installing a plugin imports its skills/commands + MCP servers for chat */
  pluginRegistries?: { name: string; url: string }[]
  /** base URL for the custom provider (OpenAI-compatible) */
  baseUrl: string
  /** AWS region for the bedrock provider */
  awsRegion: string
  /** AWS profile for the bedrock provider; empty = default credential chain */
  awsProfile: string
  /** shell command run to refresh AWS credentials when Bedrock rejects them */
  awsRefreshCmd: string
  /** shell command that prints the API credential (raw key or JSON);
   *  re-run automatically on expiry or when the API rejects it */
  credCmd: string
  /** Settings → Appearance: theme, scale, density, typography */
  appearance?: AppearanceSettings
  /** native desktop notifications for escalations/finished work when the app
   *  is unfocused (default on) */
  osNotifications?: boolean
  /** GitHub personal access token for registry/marketplace fetches (lifts the
   *  unauthenticated 60 req/h API limit; keychain-backed like API keys) */
  githubToken?: string
  /** Master chat panel width (px, drag-resizable) */
  sidebarWidth?: number
  /** Master chat panel collapsed to a slim rail */
  sidebarHidden?: boolean
  /** Chat view conversation-list width (px, drag-resizable) */
  chatListWidth?: number
  /** Board view mode: kanban columns (planning) or mission control (triage) */
  boardMode?: 'kanban' | 'mission'
  /** phone remote companion: LAN server for fleet status + approvals */
  remoteEnabled?: boolean
  /** devices that completed the pairing handshake (token minted on explicit
   *  desktop approval); re-hydrated into the server on every start */
  remoteDevices?: { id: string; name: string; token: string; at: number }[]
  /** optional public base URL (Cloudflare Tunnel, Tailscale MagicDNS, …) shown
   *  as the connect link instead of the raw interface IPs */
  remotePublicUrl?: string
  /** persisted URL token — connect links survive restarts; editable */
  remoteToken?: string
  /** when the current URL token was minted (epoch ms) — drives auto-rotation */
  remoteTokenAt?: number
  /** auto-rotate the URL token after `remoteTokenRotateHours` */
  remoteTokenRotate?: boolean
  /** rotation period in hours (default 24) */
  remoteTokenRotateHours?: number
  /** saved remote machines agents can run on over SSH + tmux */
  machines?: Machine[]
}

export type BoardCol = 'backlog' | 'progress' | 'review' | 'done' | 'failed'

export type TemplateMode = 'ephemeral' | 'interactive'
/** safe = read-only / ask for everything · edits = auto-approve file edits · full = no approvals or sandbox */
export type TemplateApproval = 'safe' | 'edits' | 'full'

export interface AgentTemplate {
  id: string
  name: string
  /** base agent type: binary, env vars, resume behavior */
  typeId: string
  /** ephemeral one-shot (claude -p / codex exec, exits by itself) vs long-running interactive */
  mode: TemplateMode
  /** default task prompt; {task} is replaced when launched with a task */
  prompt: string
  /** appended system prompt (claude --append-system-prompt; prepended to the prompt for CLIs without the flag) */
  systemPrompt: string
  /** model flag; empty = CLI default */
  model: string
  approval: TemplateApproval
  /** working directory; empty = session default */
  cwd: string
  /** extra CLI flags appended verbatim */
  extraArgs: string
  /** archive the session automatically after a successful ephemeral run */
  autoArchive: boolean
  /** run on a saved remote machine (SSH + tmux) instead of locally; empty = local */
  machineId?: string
}

/** one message in a task's watcher chat */
export interface TaskChatMsg {
  id: string
  role: 'user' | 'watcher' | 'system'
  text: string
  at: number
}

export interface BoardTask {
  id: string
  title: string
  col: BoardCol
  /** most recent session working this task (primary, shown on the card) */
  agentId: string | null
  /** every session the watcher spawned for this task, in spawn order */
  agentIds?: string[]
  /** what needs to be done, in enough detail for a one-shot agent */
  description?: string
  /** acceptance criteria the watcher verifies before moving to done */
  criteria?: string[]
  /** chat with this task's watcher (mini master) */
  chat?: TaskChatMsg[]
  /** watcher's one-line status shown on the card */
  watcherNote?: string
  /** the watcher flagged a question and is waiting on the user */
  awaitingUser?: boolean
  /** epoch ms — a session is spawned for the task at this time */
  scheduleAt?: number
  /** template used when the task spawns its session */
  templateId?: string
  /** agent type used when no template is set; empty = first enabled type */
  typeId?: string
  /** working directory for the spawned session (overrides template/default) */
  cwd?: string
  /** run the task's sessions on a saved remote machine (SSH + tmux); empty =
   *  local. Ignored when the task uses a template that already sets a machine. */
  machineId?: string
  /** run the task's sessions in an isolated git worktree (reviewed via the queue) */
  isolate?: boolean
  /** how the task's sessions run: one-shot (default — run the task and exit,
   *  giving the watcher a clean exit to assess) or interactive (stays open;
   *  the watcher assesses whenever the session eventually exits) */
  sessionMode?: 'oneshot' | 'interactive'
  /** archived tasks leave the board but stay recoverable; deletion only
   *  happens from the Archived viewer */
  archived?: boolean
}

export interface AddonTool {
  name: string
  description: string
  input_schema: Record<string, unknown>
  /** JS function body: (input, api) => string | Promise<string> */
  handler: string
}

export interface AddonHooks {
  /** JS body: (event = { sessionId, name, code }, api) => void — runs when a session exits */
  onSessionExit?: string
  /** JS body: (event = { sessionId, name, question }, api) => void — runs when a session needs input */
  onNeedsInput?: string
  /** JS body: (event = { taskId, title, col, from }, api) => void — runs when a board task changes column */
  onTaskMoved?: string
  /** JS body: (event = { name, kind: 'command'|'task'|'log' }, api) => void — runs when a schedule fires */
  onCronFired?: string
  /** appended to Master's system prompt while the addon is enabled — changes its behavior */
  masterPromptAppend?: string
}

export type AddonHookName = 'onSessionExit' | 'onNeedsInput' | 'onTaskMoved' | 'onCronFired'

/** An addon's own LLM harness (like Master / task watchers): a persistent
 *  conversation whose tools are the addon's permission-scoped API. */
export interface AddonAgent {
  /** persona + instructions (system prompt) */
  system: string
  /** hook events that wake the agent with the event as its note */
  on?: AddonHookName[]
}

export type AddonPermission = 'state:read' | 'sessions:send' | 'sessions:launch' | 'tasks' | 'schedules' | 'agent' | 'master:prompt' | 'ui' | 'storage' | 'exec'

export interface Addon {
  id: string
  name: string
  version: string
  /** single char / emoji shown in the icon rail */
  icon: string
  desc?: string
  author?: string
  /** self-contained HTML document rendered in a sandboxed iframe (optional tab) */
  html?: string
  tools?: AddonTool[]
  hooks?: AddonHooks
  /** optional dedicated LLM harness for this addon */
  agent?: AddonAgent
  /** capability scopes the package requests */
  permissions: AddonPermission[]
  /** scopes the user has granted (enforced at the API boundary) */
  granted: AddonPermission[]
  enabled: boolean
  source: 'master' | 'file' | 'url' | 'registry'
  createdAt: string
}

export type View =
  | 'workspace'
  | 'overview'
  | 'board'
  | 'timeline'
  | 'crons'
  | 'templates'
  | 'tools'
  | 'settings'
  | 'addon'
  | 'addons'
  | 'chat'

export interface Panel {
  agentId: string
  tab: 'memory' | 'tools'
}

export interface Drawer {
  kind: 'agent' | 'diff'
  agentId: string
}

export interface PersistedState {
  /** schema revision of this snapshot; absent in pre-versioning saves */
  schemaVersion?: number
  tasks: BoardTask[]
  crons: Cron[]
  settings: OrchestrationSettings
  toolsCatalog: CatalogTool[]
  agentTypes: AgentType[]
  templates?: AgentTemplate[]
  mcpServers?: McpServer[]
  skills?: Skill[]
  personas?: Persona[]
  skillRegistries?: SkillRegistry[]
  chatAgentTypes?: ChatAgentType[]
  workspaces?: Workspace[]
  activeWorkspace?: string
  workspaceData?: Record<string, WorkspaceData>
  addonStorage?: Record<string, Record<string, unknown>>
  chatMemory?: Record<string, string>
  /** session definitions + output tails; restored as paused sessions */
  agents?: Agent[]
  groups?: TabGroup[]
  activeGroup?: string | null
  /** legacy (pre-groups) pane state, migrated on load */
  focusedIds?: (string | null)[]
  activePane?: number
  soloId?: string | null
  paneStacked?: boolean
  paneSplits?: { row: number; cols: number[] }
  maximizedPane?: number | null
  minimizedIds?: string[]
  addons?: Addon[]
  messages?: Message[]
  events?: EventItem[]
  notifications?: Notification[]
}

/** Low-churn on-disk partition: everything durable except the agents/sessions. */
export type MainPartition = Omit<PersistedState, 'agents'>

/** High-churn on-disk partition: session definitions and their output tails. */
export type SessionsPartition = Pick<PersistedState, 'schemaVersion' | 'agents'>

export interface Workspace {
  id: string
  name: string
}

/** A Chrome-style tab group: one or more pane slots with their own layout.
 *  Single-slot groups render as plain tabs; multi-slot groups as merged tabs. */
export interface TabGroup {
  id: string
  /** pane slots: length = chosen layout (1–4), null = empty slot awaiting assignment */
  slots: (string | null)[]
  /** 2-pane orientation: true = stacked top/bottom instead of side by side */
  stacked: boolean
  activePane: number
  /** index into slots of the pane currently maximized, or null */
  maximizedPane: number | null
  /** divider ratios: row = first row height fraction, cols = first pane width fraction per row */
  splits: { row: number; cols: number[] }
}

/** Per-workspace slice. The ACTIVE workspace's copy lives flat on AppState;
 *  inactive workspaces are stashed here and swapped in on switch. */
export interface WorkspaceData {
  groups?: TabGroup[]
  activeGroup?: string | null
  /** legacy (pre-groups) pane state, migrated when the slice is applied */
  focusedIds?: (string | null)[]
  activePane?: number
  soloId?: string | null
  paneStacked?: boolean
  paneSplits?: { row: number; cols: number[] }
  maximizedPane?: number | null
  minimizedIds: string[]
  messages: Message[]
  crons: Cron[]
  tasks: BoardTask[]
  events: EventItem[]
  notifications: Notification[]
  /** Master events that arrived while the workspace was in the background */
  pendingMasterNotes: string[]
}

/** Runtime restoration lifecycle: load+apply the persisted snapshot, rebuild
 *  terminals/resolve secrets, then mark ready so dependent runtimes may start. */
export type BootStatus = 'loading' | 'restoring-runtime' | 'ready' | 'failed'

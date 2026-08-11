// Static per-CLI capability adapters. One place that knows how each supported
// coding agent is invoked, how its session identity is captured, and (soon)
// where it persists structured state. Everything else resolves through
// adapterFor() instead of sniffing binary names or switching on probe ids.
import type { AgentType } from './entities'

export type AdapterId = 'claude' | 'codex' | 'opencode' | 'kiro'

/** Quote an arbitrary string for safe use as one POSIX shell argument. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** Template fields an adapter translates into concrete CLI arguments. */
export interface HeadlessSpec {
  /** one-shot print mode vs long-running seeded session */
  mode: 'ephemeral' | 'interactive'
  /** model override ('' = CLI default) */
  model: string
  /** extra system-prompt text; adapters without a flag fold it into the prompt */
  systemPrompt: string
  /** approval posture: safe = read-only-ish, edits = auto-accept edits, full = no gates */
  approval: 'safe' | 'edits' | 'full'
  /** raw extra CLI arguments (already shell-formatted by the user) */
  extraArgs: string
  /** the composed task prompt */
  prompt: string
}

export interface AgentAdapter {
  id: AdapterId
  /** executable basenames that identify this CLI */
  bins: string[]
  /** how the CLI's session id is captured: minted by us at launch via a flag,
   *  or detected from its on-disk session store after launch */
  sessionId: 'mint' | 'detect'
  /** launch flag pinning a freshly minted session id (mint strategy only) */
  mintFlag?: (id: string) => string
  /** flags that already carry session identity — when the user's command
   *  matches, we must not mint (reusing an id errors "already in use") */
  sessionFlagRe?: RegExp
  /** translate template fields into CLI arguments after the binary */
  buildArgs: (spec: HeadlessSpec) => string[]
  /** settings JSON wiring the CLI's lifecycle hooks to YAAM's local listener
   *  (passed via the CLI's per-session settings flag; local sessions only) */
  hookSettings?: (url: string) => string
  /** flag pinning the CLI's local event server to a port YAAM allocated, so
   *  the manager can subscribe to its bus (local sessions only) */
  serverPortFlag?: (port: number) => string
  /** flag injecting YAAM's manager MCP server (report_status/get_task) into
   *  the session (local sessions only) */
  mcpConfigFlag?: (url: string) => string
  /** where the CLI persists session state, for structured readers (Phase 1.2+).
   *  Descriptive today; not yet consumed at runtime. */
  store: { kind: 'claude-projects' | 'codex-rollouts' | 'opencode-server' | 'kiro-cli'; note: string }
  /** env assignment identifying the session to file-installed hooks (the hook
   *  command forwards it back, so events map to the exact session) */
  sessionEnv?: (id: string) => string
  /** CLI whose hooks are installed as global files rather than launch flags */
  fileHooks?: 'kiro'
}

export const ADAPTERS: Record<AdapterId, AgentAdapter> = {
  claude: {
    id: 'claude',
    bins: ['claude'],
    sessionId: 'mint',
    mintFlag: id => `--session-id ${id}`,
    sessionFlagRe: /(^|\s)(--session-id|--resume|-r|--continue|-c)(\s|=|$)/,
    buildArgs: spec => {
      const parts: string[] = []
      if (spec.mode === 'ephemeral') parts.push('-p')
      if (spec.model.trim()) parts.push('--model', shQuote(spec.model.trim()))
      if (spec.systemPrompt.trim()) parts.push('--append-system-prompt', shQuote(spec.systemPrompt.trim()))
      if (spec.approval === 'edits') parts.push('--permission-mode', 'acceptEdits')
      if (spec.approval === 'full') parts.push('--dangerously-skip-permissions')
      if (spec.extraArgs.trim()) parts.push(spec.extraArgs.trim())
      if (spec.prompt) parts.push(shQuote(spec.prompt))
      return parts
    },
    store: { kind: 'claude-projects', note: '~/.claude/projects/<encoded-cwd>/<session-id>.jsonl; path known at launch because we mint the id' },
    // an extra --mcp-config merges with the user's own servers (the flag is
    // repeatable); skipped when the user passed --strict-mcp-config
    mcpConfigFlag: url => `--mcp-config ${shQuote(JSON.stringify({ mcpServers: { yaam: { type: 'http', url } } }))}`,
    // http hooks merge with the user's own settings-file hooks; an unreachable
    // listener fails fast and Claude proceeds, so this is strictly additive
    hookSettings: url => {
      const http = [{ hooks: [{ type: 'http', url }] }]
      return JSON.stringify({
        hooks: {
          UserPromptSubmit: http, PreToolUse: http, PostToolUse: http,
          Notification: http, PermissionRequest: http, Stop: http, SessionEnd: http,
        },
      })
    },
  },
  codex: {
    id: 'codex',
    bins: ['codex'],
    sessionId: 'detect',
    buildArgs: spec => {
      const parts: string[] = []
      if (spec.mode === 'ephemeral') parts.push('exec', '--skip-git-repo-check')
      if (spec.model.trim()) parts.push('-m', shQuote(spec.model.trim()))
      if (spec.approval === 'safe') parts.push('--sandbox', 'read-only')
      if (spec.approval === 'edits') parts.push('--sandbox', 'workspace-write')
      if (spec.approval === 'full') parts.push('--dangerously-bypass-approvals-and-sandbox')
      if (spec.extraArgs.trim()) parts.push(spec.extraArgs.trim())
      // codex has no system-prompt flag; fold it into the prompt
      const full = [spec.systemPrompt.trim(), spec.prompt].filter(Boolean).join('\n\n')
      if (full) parts.push(shQuote(full))
      return parts
    },
    store: { kind: 'codex-rollouts', note: '~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl; id detected from filenames after launch' },
  },
  opencode: {
    id: 'opencode',
    bins: ['opencode'],
    sessionId: 'detect',
    buildArgs: spec => {
      // one-shot mode is `opencode run <msg>`; no system-prompt flag, so it is
      // folded into the prompt. Interactive seeding matches the generic shape.
      const parts: string[] = []
      if (spec.mode === 'ephemeral') parts.push('run')
      if (spec.model.trim()) parts.push('-m', shQuote(spec.model.trim()))
      if (spec.approval === 'full') parts.push('--auto')
      if (spec.extraArgs.trim()) parts.push(spec.extraArgs.trim())
      const full = [spec.systemPrompt.trim(), spec.prompt].filter(Boolean).join('\n\n')
      if (full) parts.push(shQuote(full))
      return parts
    },
    // opencode moved session storage to SQLite, so file detection is blind;
    // the server bus (pinned below) is the real integration — it streams
    // status/permissions and names the session id for resume.
    store: { kind: 'opencode-server', note: 'SQLite at ~/.local/share/opencode/opencode.db; the local HTTP server is the integration surface' },
    serverPortFlag: port => `--port ${port} --hostname 127.0.0.1`,
  },
  kiro: {
    id: 'kiro',
    bins: ['kiro-cli'],
    // sessions live in kiro's SQLite (plus ~/.kiro/sessions for ACP mode);
    // no detection implemented, so resume uses the fallback (--resume)
    sessionId: 'detect',
    // the seed launch command is `kiro-cli chat`; args ride after the subcommand
    buildArgs: spec => {
      const parts: string[] = []
      if (spec.mode === 'ephemeral') parts.push('--no-interactive')
      if (spec.approval === 'full') parts.push('--trust-all-tools')
      if (spec.extraArgs.trim()) parts.push(spec.extraArgs.trim())
      // no model or system-prompt flags; fold the system prompt into the prompt
      const full = [spec.systemPrompt.trim(), spec.prompt].filter(Boolean).join('\n\n')
      if (full) parts.push(shQuote(full))
      return parts
    },
    store: { kind: 'kiro-cli', note: 'SQLite (kiro-cli data.sqlite3) + ~/.kiro/sessions for ACP mode; hooks in .kiro/hooks are the event tap' },
    sessionEnv: id => `YAAM_SESSION=${id}`,
    fileHooks: 'kiro',
  },
}

/** First token of a command, reduced to its executable basename. */
export function binOf(command: string): string {
  return (command.trim().split(/\s+/)[0] ?? '').split('/').pop() ?? ''
}

/** Resolve the adapter for an agent type (via probe) or a raw command (via
 *  binary basename). Returns undefined for CLIs we have no adapter for. */
export function adapterFor(type: AgentType | undefined, command?: string): AgentAdapter | undefined {
  if (type?.probe && ADAPTERS[type.probe]) return ADAPTERS[type.probe]
  const bin = binOf(command ?? type?.model ?? '')
  if (!bin) return undefined
  return Object.values(ADAPTERS).find(a => a.bins.includes(bin))
}

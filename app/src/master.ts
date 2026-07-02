// Master's brain: a Claude model with tool use, talking to the Anthropic API
// directly from the webview. The three-way flow:
//   user → Master (chat) · Master → agents (tools write to session stdin)
//   agents → Master (session state + output tails in the system prompt; exit
//   events trigger proactive turns)
import type { AppState } from './types'
import { fetch as tauriFetch } from '@tauri-apps/plugin-http'
import { isTauri } from './native'

// Route HTTP through the Tauri backend so browser CORS never blocks a provider.
const doFetch: typeof fetch = (...args) => (isTauri ? tauriFetch(...args) : fetch(...args))

export interface ProviderDef {
  id: string
  label: string
  base: string
  protocol: 'anthropic' | 'openai'
  models: string[]
  keyHint: string
}

export const PROVIDERS: ProviderDef[] = [
  { id: 'anthropic', label: 'Anthropic (Claude)', base: 'https://api.anthropic.com', protocol: 'anthropic', models: ['claude-sonnet-5', 'claude-haiku-4-5-20251001', 'claude-opus-4-8'], keyHint: 'sk-ant-…' },
  { id: 'openai', label: 'OpenAI', base: 'https://api.openai.com/v1', protocol: 'openai', models: ['gpt-4o', 'gpt-4o-mini', 'o4-mini'], keyHint: 'sk-…' },
  { id: 'deepseek', label: 'DeepSeek', base: 'https://api.deepseek.com', protocol: 'openai', models: ['deepseek-chat', 'deepseek-reasoner'], keyHint: 'sk-…' },
  { id: 'kimi', label: 'Kimi (Moonshot)', base: 'https://api.moonshot.ai/v1', protocol: 'openai', models: ['kimi-k2-0905-preview', 'kimi-latest'], keyHint: 'sk-…' },
  { id: 'custom', label: 'Custom (OpenAI-compatible)', base: '', protocol: 'openai', models: [], keyHint: 'api key' },
]

export function providerFor(id: string): ProviderDef {
  return PROVIDERS.find(pr => pr.id === id) ?? PROVIDERS[0]
}

export interface MasterExec {
  launchSession: (command: string, cwd: string, name?: string) => string
  sendToSession: (sessionId: string, text: string) => string
  stopSession: (sessionId: string) => string
  readSession: (sessionId: string, lines?: number) => string
  flagNeedsInput: (sessionId: string, question: string) => string
  renameSession: (sessionId: string, name: string) => string
  updateAgentStatus: (sessionId: string, task?: string, summary?: string, actionNeeded?: string) => string
  createSchedule: (name: string, cron: string, command?: string, cwd?: string) => string
  addTask: (title: string) => string
}

const TOOLS = [
  {
    name: 'launch_session',
    description: 'Launch a CLI command as a new live agent session. Returns the new session id.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'full command line, e.g. "claude -p" or "zsh -i"' },
        cwd: { type: 'string', description: 'working directory (optional)' },
        name: { type: 'string', description: 'display name (optional)' },
      },
      required: ['command'],
    },
  },
  {
    name: 'send_to_session',
    description: 'Send a line of text to a session\'s stdin. Use the session id from the state listing.',
    input_schema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        text: { type: 'string' },
      },
      required: ['session_id', 'text'],
    },
  },
  {
    name: 'read_session',
    description: 'Read the most recent terminal output of a session (ANSI-stripped). Use this to check what an agent is doing or whether it finished.',
    input_schema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        lines: { type: 'number', description: 'how many lines from the end (default 40, max 120)' },
      },
      required: ['session_id'],
    },
  },
  {
    name: 'update_agent_status',
    description: 'Update a session\'s card on the Agents overview: what it is working on (task), a 1-2 sentence state summary, and what the user must do if anything (action_needed, empty string to clear). Call this whenever you review a session\'s output so the overview stays current.',
    input_schema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        task: { type: 'string' },
        summary: { type: 'string' },
        action_needed: { type: 'string' },
      },
      required: ['session_id'],
    },
  },
  {
    name: 'rename_session',
    description: 'Rename a session (its display name in tabs, panes, and lists).',
    input_schema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        name: { type: 'string' },
      },
      required: ['session_id', 'name'],
    },
  },
  {
    name: 'flag_needs_input',
    description: 'Mark a session as waiting for the user: shows a Needs-action banner, sends a notification, and puts an approve/deny card in chat. Call this when a session\'s output shows it is blocked on user input or permission.',
    input_schema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        question: { type: 'string', description: 'what the session is asking, quoted or paraphrased' },
      },
      required: ['session_id', 'question'],
    },
  },
  {
    name: 'stop_session',
    description: 'Stop (kill) a running session.',
    input_schema: {
      type: 'object',
      properties: { session_id: { type: 'string' } },
      required: ['session_id'],
    },
  },
  {
    name: 'create_schedule',
    description: 'Create a recurring schedule (5-field cron). If command is set, each run launches it as a live session.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        cron: { type: 'string', description: 'e.g. "0 3 * * *"' },
        command: { type: 'string' },
        cwd: { type: 'string' },
      },
      required: ['name', 'cron'],
    },
  },
  {
    name: 'add_task',
    description: 'Add a task card to the board backlog.',
    input_schema: {
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
    },
  },
]

function describeState(s: AppState): string {
  const roster = s.agents.length
    ? s.agents.map(a => `${a.name} (id=${a.id}, ${a.status})`).join(' · ')
    : 'none'
  const sessions = s.agents.map(a => {
    const memOn = (id: string) => a.memory.find(m => m.id === id)?.on !== false
    const perm = (id: string) => {
      const t = a.tools.find(x => x.id === id)
      return t ? (t.on ? t.perm : 'Off') : 'Auto'
    }
    const meta = memOn('meta') ? ` cmd=${a.cmd || '-'} cwd=${a.cwd || '-'}${a.cliSessionId ? ` cli_session=${a.cliSessionId}` : ''}` : ''
    const tracked = [
      a.task ? `task="${a.task}"` : '',
      a.summary ? `summary="${a.summary}"` : '',
      a.actionNeeded ? `action_needed="${a.actionNeeded}"` : '',
    ].filter(Boolean).join(' ')
    const perms = `\n  your-permissions: send=${perm('send')} stop=${perm('stop')} respawn=${perm('respawn')}`
    const tail = memOn('tail')
      ? `\n  recent output:\n${a.log.slice(-12).map(l => `    ${l.x}`).join('\n') || '    (none)'}`
      : '\n  recent output: (hidden by user)'
    return `- id=${a.id} name=${a.name} status=${a.status}${a.escReason ? ` waiting-on="${a.escReason}"` : ''}${meta}${tracked ? `\n  tracked: ${tracked}` : ''}${perms}${tail}`
  }).join('\n')
  const crons = s.crons.map(c => `- ${c.name} · ${c.schedule} · ${c.on ? 'on' : 'off'} · cmd=${c.cmd || '-'} · last=${c.last}`).join('\n')
  const tasks = s.tasks.map(t => `- [${t.col}] ${t.title}`).join('\n')
  const events = s.events.slice(0, 8).map(e => `- ${e.time} ${e.type}: ${e.text}`).join('\n')
  const toolPerms = s.toolsCatalog.map(t => `- ${t.id}: ${t.perm}`).join('\n')
  const types = s.agentTypes.filter(t => t.enabled)
    .map(t => `- ${t.name}: launch with command "${t.model}" — ${t.desc}`).join('\n')
  return [
    `AGENT TYPES you can launch (use the exact command; a plain terminal is "${s.settings.shell || 'zsh'} -i"):\n${types || '(none enabled)'}`,
    `YOUR TOOL PERMISSIONS (Auto = act freely · Ask first = confirm with the user in chat before doing it · Approval/Off = blocked):\n${toolPerms}`,
    `YOUR SUB-AGENTS — ${s.agents.length} session(s): ${roster}`,
    `SESSION DETAIL:\n${sessions || '(none)'}`,
    `SCHEDULES:\n${crons || '(none)'}`,
    `BOARD TASKS:\n${tasks || '(none)'}`,
    `RECENT EVENTS:\n${events || '(none)'}`,
  ].join('\n\n')
}

function systemPrompt(s: AppState): string {
  return `You are Master, the orchestrator inside Conductor — a desktop manager for multiple live agent sessions (CLI processes). You sit between the user and the sessions:
- The user talks to you in chat.
- You command sessions with tools (send text to their stdin, launch or stop them).
- Sessions report back through their output, which appears in the state below. After you send something to a session, you get an [event] message with its response once the output settles; relay the outcome to the user concisely and only act further when needed.

Working-directory paths may use ~ (it is expanded). Example: if the user says "launch a new session on ~/workspace/loom for claude code", call launch_session with {command: "claude", cwd: "~/workspace/loom", name: "Claude Code"} using the Claude Code launch command from AGENT TYPES, then confirm to the user. After launching or messaging an agent, use read_session (or wait for the [event] relay) before claiming results.

Be concise (1-3 sentences unless asked for detail). Respect your tool permissions: for anything marked "Ask first" (globally or per-session), ask the user in chat and wait for a yes before doing it. Sessions with status=needs are waiting on a user prompt — tell the user what's being asked. When an [event] shows a session's settled output and it is blocked on input/permission, call flag_needs_input; do not flag ordinary progress output. When the user gives you a task, route it to the most suitable running session with send_to_session, or launch an appropriate session first. When asked about status, answer from the state below. Escalate problems (errored sessions, failing output) proactively. Never invent sessions that are not listed — YOUR SUB-AGENTS is the authoritative roster of every session you manage and its live status. You may rename_session to keep names meaningful (e.g. after learning what a session is working on). Whenever you review a session's output (events, read_session), also call update_agent_status so the Agents overview shows its current task, a short summary, and any action the user must take (clear action_needed with an empty string once handled).

CURRENT STATE
${describeState(s)}`
}

interface ApiContentBlock {
  type: string
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
}

interface ApiResponse {
  content: ApiContentBlock[]
  stop_reason: string
  error?: { message: string }
}

type ApiMessage = { role: 'user' | 'assistant'; content: unknown }

function chatHistory(s: AppState, eventNote?: string): ApiMessage[] {
  const msgs: ApiMessage[] = []
  for (const m of s.messages) {
    if (m.kind !== 'text' || !m.text) continue
    const role = m.role === 'you' ? 'user' as const : 'assistant' as const
    const last = msgs[msgs.length - 1]
    if (last && last.role === role) last.content = `${last.content}\n${m.text}`
    else msgs.push({ role, content: m.text })
  }
  if (eventNote) {
    const last = msgs[msgs.length - 1]
    if (last && last.role === 'user') last.content = `${last.content}\n${eventNote}`
    else msgs.push({ role: 'user', content: eventNote })
  }
  while (msgs.length && msgs[0].role !== 'user') msgs.shift()
  if (!msgs.length) msgs.push({ role: 'user', content: eventNote || 'Hello' })
  return msgs.slice(-30)
}

interface LlmConfig {
  provider: ProviderDef
  baseUrl: string
  apiKey: string
  model: string
}

async function callAnthropic(cfg: LlmConfig, system: string, messages: ApiMessage[]): Promise<ApiResponse> {
  const res = await doFetch(`${cfg.provider.base}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': cfg.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({ model: cfg.model, max_tokens: 2048, system, messages, tools: TOOLS }),
  })
  const data = await res.json() as ApiResponse
  if (!res.ok) throw new Error(data.error?.message || `API error ${res.status}`)
  return data
}

interface OaiToolCall {
  id: string
  function: { name: string; arguments: string }
}

interface OaiMessage {
  role: string
  content: string | null
  reasoning_content?: string
  tool_calls?: OaiToolCall[]
  tool_call_id?: string
}

/** Convert internal (Anthropic-shaped) history to OpenAI chat format. */
function toOpenAiMessages(system: string, messages: ApiMessage[]): OaiMessage[] {
  const out: OaiMessage[] = [{ role: 'system', content: system }]
  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content })
      continue
    }
    const blocks = m.content as ApiContentBlock[]
    if (m.role === 'assistant') {
      const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('\n')
      const toolCalls = blocks.filter(b => b.type === 'tool_use').map(b => ({
        id: b.id || '', type: 'function' as const,
        function: { name: b.name || '', arguments: JSON.stringify(b.input || {}) },
      }))
      out.push({ role: 'assistant', content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) })
    } else {
      // tool results
      for (const b of blocks as Array<{ type: string; tool_use_id?: string; content?: string }>) {
        if (b.type === 'tool_result') out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: b.content ?? '' })
      }
    }
  }
  return out
}

async function callOpenAi(cfg: LlmConfig, system: string, messages: ApiMessage[]): Promise<ApiResponse> {
  const base = (cfg.provider.id === 'custom' ? cfg.baseUrl : cfg.provider.base).replace(/\/$/, '')
  if (!base) throw new Error('custom provider needs a base URL (Settings → Master Brain)')
  const res = await doFetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: 2048,
      messages: toOpenAiMessages(system, messages),
      tools: TOOLS.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } })),
    }),
  })
  const data = await res.json() as {
    choices?: Array<{ message: OaiMessage; finish_reason: string }>
    error?: { message: string }
  }
  if (!res.ok) throw new Error(data.error?.message || `API error ${res.status}`)
  const msg = data.choices?.[0]?.message
  const content: ApiContentBlock[] = []
  if (msg?.reasoning_content) content.push({ type: 'thinking', text: msg.reasoning_content })
  if (msg?.content) content.push({ type: 'text', text: msg.content })
  for (const tc of msg?.tool_calls ?? []) {
    let input: Record<string, unknown> = {}
    try { input = JSON.parse(tc.function.arguments || '{}') } catch { /* malformed args */ }
    content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input })
  }
  return { content, stop_reason: msg?.tool_calls?.length ? 'tool_use' : 'end_turn' }
}

function callApi(cfg: LlmConfig, system: string, messages: ApiMessage[]): Promise<ApiResponse> {
  return cfg.provider.protocol === 'anthropic' ? callAnthropic(cfg, system, messages) : callOpenAi(cfg, system, messages)
}

function runTool(name: string, input: Record<string, unknown>, exec: MasterExec): string {
  const str = (k: string) => typeof input[k] === 'string' ? input[k] as string : ''
  switch (name) {
    case 'launch_session': return exec.launchSession(str('command'), str('cwd'), str('name') || undefined)
    case 'send_to_session': return exec.sendToSession(str('session_id'), str('text'))
    case 'stop_session': return exec.stopSession(str('session_id'))
    case 'read_session': return exec.readSession(str('session_id'), typeof input.lines === 'number' ? input.lines : undefined)
    case 'flag_needs_input': return exec.flagNeedsInput(str('session_id'), str('question'))
    case 'rename_session': return exec.renameSession(str('session_id'), str('name'))
    case 'update_agent_status': return exec.updateAgentStatus(
      str('session_id'),
      typeof input.task === 'string' ? input.task : undefined,
      typeof input.summary === 'string' ? input.summary : undefined,
      typeof input.action_needed === 'string' ? input.action_needed : undefined,
    )
    case 'create_schedule': return exec.createSchedule(str('name'), str('cron'), str('command') || undefined, str('cwd') || undefined)
    case 'add_task': return exec.addTask(str('title'))
    default: return `unknown tool ${name}`
  }
}

export interface MasterTurnResult {
  text: string
  thinking: string
}

/**
 * Run one Master turn: call the model, execute any tool calls against the app,
 * and loop until the model stops. Intermediate narration, reasoning, and tool
 * calls are collected as a collapsible "thinking" trace; only the final text
 * is the reply.
 */
export async function runMasterTurn(
  getState: () => AppState,
  exec: MasterExec,
  eventNote?: string,
): Promise<MasterTurnResult> {
  const s0 = getState()
  const cfg: LlmConfig = {
    provider: providerFor(s0.settings.provider),
    baseUrl: s0.settings.baseUrl,
    apiKey: s0.settings.apiKey,
    model: s0.settings.masterModel,
  }
  const messages = chatHistory(s0, eventNote)
  const trace: string[] = []
  let finalTexts: string[] = []

  for (let i = 0; i < 8; i++) {
    // re-describe state each iteration so tool effects are visible to the model
    const res = await callApi(cfg, systemPrompt(getState()), messages)
    const stepTexts: string[] = []
    for (const block of res.content) {
      if (block.type === 'thinking' && block.text) trace.push(block.text)
      if (block.type === 'text' && block.text) stepTexts.push(block.text)
    }
    if (res.stop_reason !== 'tool_use') {
      finalTexts = stepTexts
      break
    }
    // narration before tool calls belongs to the trace, not the reply
    trace.push(...stepTexts)
    const results = res.content
      .filter(b => b.type === 'tool_use')
      .map(b => {
        const result = runTool(b.name || '', b.input || {}, exec)
        trace.push(`→ ${b.name}(${JSON.stringify(b.input || {})})`)
        trace.push(`← ${result.length > 300 ? result.slice(0, 300) + '…' : result}`)
        return { type: 'tool_result', tool_use_id: b.id, content: result }
      })
    messages.push({ role: 'assistant', content: res.content })
    messages.push({ role: 'user', content: results })
  }

  return {
    text: finalTexts.join('\n\n').trim(),
    thinking: trace.join('\n').trim(),
  }
}

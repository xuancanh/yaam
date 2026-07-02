// Master's brain: a Claude model with tool use, talking to the Anthropic API
// directly from the webview. The three-way flow:
//   user → Master (chat) · Master → agents (tools write to session stdin)
//   agents → Master (session state + output tails in the system prompt; exit
//   events trigger proactive turns)
import type { AppState } from './types'

export const MASTER_MODELS = ['claude-sonnet-5', 'claude-haiku-4-5-20251001', 'claude-opus-4-8']

export interface MasterExec {
  launchSession: (command: string, cwd: string, name?: string) => string
  sendToSession: (sessionId: string, text: string) => string
  stopSession: (sessionId: string) => string
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
  const sessions = s.agents.map(a => {
    const memOn = (id: string) => a.memory.find(m => m.id === id)?.on !== false
    const perm = (id: string) => {
      const t = a.tools.find(x => x.id === id)
      return t ? (t.on ? t.perm : 'Off') : 'Auto'
    }
    const meta = memOn('meta') ? ` cmd=${a.cmd || '-'} cwd=${a.cwd || '-'}` : ''
    const perms = `\n  your-permissions: send=${perm('send')} stop=${perm('stop')} respawn=${perm('respawn')}`
    const tail = memOn('tail')
      ? `\n  recent output:\n${a.log.slice(-12).map(l => `    ${l.x}`).join('\n') || '    (none)'}`
      : '\n  recent output: (hidden by user)'
    return `- id=${a.id} name=${a.name} status=${a.status}${a.escReason ? ` waiting-on="${a.escReason}"` : ''}${meta}${perms}${tail}`
  }).join('\n')
  const crons = s.crons.map(c => `- ${c.name} · ${c.schedule} · ${c.on ? 'on' : 'off'} · cmd=${c.cmd || '-'} · last=${c.last}`).join('\n')
  const tasks = s.tasks.map(t => `- [${t.col}] ${t.title}`).join('\n')
  const events = s.events.slice(0, 8).map(e => `- ${e.time} ${e.type}: ${e.text}`).join('\n')
  const toolPerms = s.toolsCatalog.map(t => `- ${t.id}: ${t.perm}`).join('\n')
  return [
    `YOUR TOOL PERMISSIONS (Auto = act freely · Ask first = confirm with the user in chat before doing it · Approval/Off = blocked):\n${toolPerms}`,
    `SESSIONS (${s.agents.length}):\n${sessions || '(none)'}`,
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

Be concise (1-3 sentences unless asked for detail). Respect your tool permissions: for anything marked "Ask first" (globally or per-session), ask the user in chat and wait for a yes before doing it. Sessions with status=needs are waiting on a user prompt — tell the user what's being asked. When the user gives you a task, route it to the most suitable running session with send_to_session, or launch an appropriate session first. When asked about status, answer from the state below. Escalate problems (errored sessions, failing output) proactively. Never invent sessions that are not listed.

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
  return msgs.slice(-24)
}

async function callApi(apiKey: string, model: string, system: string, messages: ApiMessage[]): Promise<ApiResponse> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({ model, max_tokens: 1024, system, messages, tools: TOOLS }),
  })
  const data = await res.json() as ApiResponse
  if (!res.ok) throw new Error(data.error?.message || `API error ${res.status}`)
  return data
}

function runTool(name: string, input: Record<string, unknown>, exec: MasterExec): string {
  const str = (k: string) => typeof input[k] === 'string' ? input[k] as string : ''
  switch (name) {
    case 'launch_session': return exec.launchSession(str('command'), str('cwd'), str('name') || undefined)
    case 'send_to_session': return exec.sendToSession(str('session_id'), str('text'))
    case 'stop_session': return exec.stopSession(str('session_id'))
    case 'create_schedule': return exec.createSchedule(str('name'), str('cron'), str('command') || undefined, str('cwd') || undefined)
    case 'add_task': return exec.addTask(str('title'))
    default: return `unknown tool ${name}`
  }
}

/**
 * Run one Master turn: call the model, execute any tool calls against the app,
 * and loop until the model stops. Returns the model's final text.
 */
export async function runMasterTurn(
  getState: () => AppState,
  exec: MasterExec,
  eventNote?: string,
): Promise<string> {
  const s0 = getState()
  const { apiKey, masterModel } = s0.settings
  const messages = chatHistory(s0, eventNote)
  const texts: string[] = []

  for (let i = 0; i < 6; i++) {
    // re-describe state each iteration so tool effects are visible to the model
    const res = await callApi(apiKey, masterModel, systemPrompt(getState()), messages)
    for (const block of res.content) {
      if (block.type === 'text' && block.text) texts.push(block.text)
    }
    if (res.stop_reason !== 'tool_use') break
    const results = res.content
      .filter(b => b.type === 'tool_use')
      .map(b => ({
        type: 'tool_result',
        tool_use_id: b.id,
        content: runTool(b.name || '', b.input || {}, exec),
      }))
    messages.push({ role: 'assistant', content: res.content })
    messages.push({ role: 'user', content: results })
  }

  return texts.join('\n\n').trim()
}

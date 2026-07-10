// Per-addon LLM harness: an addon can declare an `agent` — its own persistent
// mini-orchestrator (like Master and the task watchers), whose tools ARE the
// addon's permission-scoped API. Hook events can wake it, and addon views can
// chat with it over the RPC bridge (agent.wake returns the reply).
import type { Addon } from '../../core/types'
import type { AddonApi } from '../../core/addons'
import type { ApiMessage, LlmConfig } from '../../llm/client'
import { capToolHistory, runToolLoop, sanitizeToolHistory } from '../../llm/tool-loop'

// The API surface projected as LLM tools. Each entry maps a tool call onto
// the (permission-enforced) AddonApi — denied scopes surface as tool errors.
const AGENT_TOOLS: { name: string; description: string; input_schema: Record<string, unknown>; run: (api: AddonApi, input: Record<string, unknown>) => unknown }[] = [
  {
    name: 'get_state',
    description: 'Read the app snapshot: sessions (status, cost), board tasks (spec, column, watcher note, chat tail), templates, schedules, recent events, totals.',
    input_schema: { type: 'object', properties: {} },
    run: api => api.getState(),
  },
  {
    name: 'read_output',
    description: "Latest terminal output of a session (rendered screen for TUIs, log tail otherwise).",
    input_schema: { type: 'object', properties: { session_id: { type: 'string' }, lines: { type: 'number' } }, required: ['session_id'] },
    run: (api, i) => api.sessions.readOutput(String(i.session_id), Number(i.lines) || 30),
  },
  {
    name: 'send_to_session',
    description: 'Type a line into a live session (Enter is pressed for you).',
    input_schema: { type: 'object', properties: { session_id: { type: 'string' }, text: { type: 'string' } }, required: ['session_id', 'text'] },
    run: (api, i) => { api.sendToSession(String(i.session_id), String(i.text)); return 'sent' },
  },
  {
    name: 'launch_session',
    description: 'Launch a command as a new session; returns its id.',
    input_schema: { type: 'object', properties: { command: { type: 'string' }, cwd: { type: 'string' }, name: { type: 'string' } }, required: ['command'] },
    run: (api, i) => api.launchSession(String(i.command), i.cwd ? String(i.cwd) : undefined, i.name ? String(i.name) : undefined) ?? 'launch failed',
  },
  {
    name: 'stop_session',
    description: "Stop a running session's process.",
    input_schema: { type: 'object', properties: { session_id: { type: 'string' } }, required: ['session_id'] },
    run: (api, i) => { api.sessions.stop(String(i.session_id)); return 'stopped' },
  },
  {
    name: 'add_task',
    description: 'Create a board task (title + description + criteria); its watcher drives its session once started. Supports isolate (git worktree), session_mode, machine_id, schedule_at (epoch ms).',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' }, col: { type: 'string' }, description: { type: 'string' },
        criteria: { type: 'array', items: { type: 'string' } }, cwd: { type: 'string' }, start: { type: 'boolean' },
        isolate: { type: 'boolean' }, session_mode: { type: 'string', enum: ['oneshot', 'interactive'] },
        machine_id: { type: 'string' }, schedule_at: { type: 'number' },
      },
      required: ['title'],
    },
    run: (api, i) => {
      const id = api.tasks.add(String(i.title), i.col ? String(i.col) : undefined, {
        description: i.description ? String(i.description) : undefined,
        criteria: Array.isArray(i.criteria) ? i.criteria.map(String) : undefined,
        cwd: i.cwd ? String(i.cwd) : undefined,
        isolate: i.isolate === true ? true : undefined,
        sessionMode: i.session_mode === 'interactive' ? 'interactive' : undefined,
        machineId: i.machine_id ? String(i.machine_id) : undefined,
        scheduleAt: typeof i.schedule_at === 'number' ? i.schedule_at : undefined,
      })
      if (i.start === true) api.tasks.start(id)
      return `task ${id} created${i.start === true ? ' and started' : ''}`
    },
  },
  {
    name: 'get_task',
    description: 'Full detail of one board task: spec, watcher note, chat history, sessions, isolation/schedule.',
    input_schema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] },
    run: (api, i) => api.tasks.get(String(i.task_id)) ?? 'task not found',
  },
  {
    name: 'restart_task',
    description: 'Stop the task\'s dead/stuck session and spawn a fresh one for it.',
    input_schema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] },
    run: (api, i) => { api.tasks.restart(String(i.task_id)); return 'restarting' },
  },
  {
    name: 'approve_task',
    description: 'Approve a task sitting in review (merges its isolated worktree if any) and move it to done.',
    input_schema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] },
    run: (api, i) => api.tasks.approve(String(i.task_id)),
  },
  {
    name: 'reject_task',
    description: 'Send a review task back with feedback; the watcher relaunches the work with it.',
    input_schema: { type: 'object', properties: { task_id: { type: 'string' }, feedback: { type: 'string' } }, required: ['task_id', 'feedback'] },
    run: (api, i) => { api.tasks.reject(String(i.task_id), String(i.feedback)); return 'sent back with feedback' },
  },
  {
    name: 'http_request',
    description: "HTTP call to one of the hosts declared in this addon's manifest. Header/body values may use {{secret:NAME}} — resolved from the keychain, never shown to you.",
    input_schema: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] },
        url: { type: 'string' },
        headers: { type: 'object', description: 'string values; {{secret:NAME}} allowed' },
        body: { type: 'string' },
      },
      required: ['method', 'url'],
    },
    run: async (api, i) => {
      const res = await api.http.request(String(i.method), String(i.url), {
        headers: (i.headers && typeof i.headers === 'object' ? i.headers : undefined) as Record<string, string> | undefined,
        body: typeof i.body === 'string' ? i.body : undefined,
      })
      return `HTTP ${res.status} (${res.contentType})\n${res.text.slice(0, 20_000)}`
    },
  },
  {
    name: 'move_task',
    description: 'Move a board task to a column (backlog|progress|review|done|failed).',
    input_schema: { type: 'object', properties: { task_id: { type: 'string' }, col: { type: 'string' } }, required: ['task_id', 'col'] },
    run: (api, i) => { api.tasks.move(String(i.task_id), String(i.col)); return 'moved' },
  },
  {
    name: 'task_chat',
    description: "Post a message into a task's watcher chat — the task's own mini-orchestrator reads and reacts to it.",
    input_schema: { type: 'object', properties: { task_id: { type: 'string' }, text: { type: 'string' } }, required: ['task_id', 'text'] },
    run: (api, i) => { api.tasks.chat(String(i.task_id), String(i.text)); return 'posted' },
  },
  {
    name: 'run_template',
    description: 'Launch an agent template by name or id, optionally with task text.',
    input_schema: { type: 'object', properties: { template: { type: 'string' }, task: { type: 'string' } }, required: ['template'] },
    run: (api, i) => api.templates.run(String(i.template), i.task ? String(i.task) : undefined) ?? 'template not found or launch failed',
  },
  {
    name: 'add_schedule',
    description: 'Create a schedule: recurring (5-field cron "schedule") or one-time (epoch-ms "at"); either a raw command or a board task spec.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' }, schedule: { type: 'string' }, at: { type: 'number' }, cmd: { type: 'string' },
        task: { type: 'object', description: '{ title, description?, criteria?, cwd?, startNow? }' },
      },
      required: ['name'],
    },
    run: (api, i) => api.schedules.add(i as Parameters<AddonApi['schedules']['add']>[0]),
  },
  {
    name: 'storage',
    description: "This addon's persistent key-value storage: op=get|set|list|remove.",
    input_schema: { type: 'object', properties: { op: { type: 'string', enum: ['get', 'set', 'list', 'remove'] }, key: { type: 'string' }, value: {} }, required: ['op'] },
    run: (api, i) => {
      if (i.op === 'list') return JSON.stringify(api.storage.list())
      if (i.op === 'set') { api.storage.set(String(i.key), i.value); return 'saved' }
      if (i.op === 'remove') { api.storage.remove(String(i.key)); return 'removed' }
      return JSON.stringify(api.storage.get(String(i.key)) ?? null)
    },
  },
  {
    name: 'notify_user',
    description: 'Notification in the bell popover (title + detail).',
    input_schema: { type: 'object', properties: { title: { type: 'string' }, detail: { type: 'string' } }, required: ['title'] },
    run: (api, i) => { api.notify(String(i.title), String(i.detail ?? '')); return 'notified' },
  },
]

function agentSystem(addon: Addon): string {
  return `You are the dedicated agent of the "${addon.name}" addon inside YAAM (an agent manager) — a mini orchestrator like the app's Master, but owned by this addon and bounded by its granted permissions (denied calls fail loudly; work with what you have).

ADDON PERSONA & INSTRUCTIONS
${addon.agent?.system ?? '(none)'}

Ground every statement in tool results — read state before acting, never invent sessions or tasks. Keep final replies short and concrete; they are shown in the addon's UI or logged. Use tools first, reply after.`
}

/**
 * One agent turn for one addon. `history` is the agent's private conversation
 * (mutated in place, capped here). Returns the agent's final prose reply.
 */
export async function runAddonAgentTurn(
  cfg: LlmConfig,
  addon: Addon,
  note: string,
  history: ApiMessage[],
  api: AddonApi,
  signal?: AbortSignal,
): Promise<string> {
  // a previous failed/aborted turn can leave dangling tool rounds — providers
  // reject those, which would silence this agent on every later turn
  sanitizeToolHistory(history)
  history.push({ role: 'user', content: note })
  const defs = AGENT_TOOLS.map(({ name, description, input_schema }) => ({ name, description, input_schema }))
  const { text: reply } = await runToolLoop({
    cfg, system: agentSystem(addon), history, tools: defs, maxRounds: 6, signal,
    terminalAssistant: 'text', // the addon agent stores just its final prose
    execute: async (name, input) => {
      const tool = AGENT_TOOLS.find(t => t.name === name)
      if (!tool) return `unknown tool ${name}`
      const out = await tool.run(api, input ?? {})
      return typeof out === 'string' ? out : JSON.stringify(out ?? 'ok')
    },
  })
  // cap through the sanitizing helper — a blind shift() can split a
  // tool_use/tool_result pair or leave an orphaned tool_result at the head
  capToolHistory(history, 24)
  return reply
}

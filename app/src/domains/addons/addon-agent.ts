// Per-addon LLM harness: an addon can declare an `agent` — its own persistent
// mini-orchestrator (like Master and the task watchers), whose tools ARE the
// addon's permission-scoped API. Hook events can wake it, and addon views can
// chat with it over the RPC bridge (agent.wake returns the reply).
import type { Addon } from '../../core/types'
import type { AddonApi } from '../../core/addons'
import { callApi } from '../../llm/client'
import type { ApiContentBlock, ApiMessage, LlmConfig } from '../../llm/client'

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
    description: 'Create a board task (title + description + criteria); its watcher drives a one-shot session once started.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' }, col: { type: 'string' }, description: { type: 'string' },
        criteria: { type: 'array', items: { type: 'string' } }, cwd: { type: 'string' }, start: { type: 'boolean' },
      },
      required: ['title'],
    },
    run: (api, i) => {
      const id = api.tasks.add(String(i.title), i.col ? String(i.col) : undefined, {
        description: i.description ? String(i.description) : undefined,
        criteria: Array.isArray(i.criteria) ? i.criteria.map(String) : undefined,
        cwd: i.cwd ? String(i.cwd) : undefined,
      })
      if (i.start === true) api.tasks.start(id)
      return `task ${id} created${i.start === true ? ' and started' : ''}`
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
    description: "This addon's persistent key-value storage: op=get|set.",
    input_schema: { type: 'object', properties: { op: { type: 'string', enum: ['get', 'set'] }, key: { type: 'string' }, value: {} }, required: ['op', 'key'] },
    run: (api, i) => (i.op === 'set' ? (api.storage.set(String(i.key), i.value), 'saved') : JSON.stringify(api.storage.get(String(i.key)) ?? null)),
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
): Promise<string> {
  history.push({ role: 'user', content: note })
  const defs = AGENT_TOOLS.map(({ name, description, input_schema }) => ({ name, description, input_schema }))
  let reply = ''
  for (let i = 0; i < 6; i++) {
    const res = await callApi(cfg, agentSystem(addon), history, defs)
    if (res.stop_reason !== 'tool_use') {
      reply = res.content.filter(b => b.type === 'text' && b.text).map(b => b.text).join('\n').trim()
      history.push({ role: 'assistant', content: reply || '(ok)' })
      break
    }
    const results = await Promise.all(res.content
      .filter((b): b is ApiContentBlock => b.type === 'tool_use')
      .map(async b => {
        const tool = AGENT_TOOLS.find(t => t.name === b.name)
        let content: string
        try {
          const out = tool ? await tool.run(api, b.input ?? {}) : `unknown tool ${b.name}`
          content = typeof out === 'string' ? out : JSON.stringify(out ?? 'ok')
        } catch (e) {
          content = `error: ${e instanceof Error ? e.message : String(e)}`
        }
        return { type: 'tool_result', tool_use_id: b.id, content }
      }))
    history.push({ role: 'assistant', content: res.content })
    history.push({ role: 'user', content: results })
  }
  while (history.length > 24) history.shift()
  if (history.length && history[0].role !== 'user') history.shift()
  return reply
}

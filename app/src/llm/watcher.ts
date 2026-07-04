// Per-task watcher: every started kanban task gets its own "mini Master" —
// a small LLM conversation that owns exactly one task. It spawns/steers the
// task's one-shot session, keeps the card moving across the board, and talks
// to the user through the task's chat. It also powers LLM-assisted task
// creation (drafting descriptions/criteria, or rejecting vague tasks).
import type { Agent, BoardTask } from '../types'
import { callApi } from './client'
import type { ApiContentBlock, ApiMessage, LlmConfig } from './client'

// ---------- task creation assist ----------

export interface TaskSpecDraft {
  ok: boolean
  description: string
  criteria: string[]
  questions: string[]
}

const SPEC_TOOL = [{
  name: 'submit_spec',
  description: 'Submit the completed task spec, or reject it with questions when the input is too vague.',
  input_schema: {
    type: 'object',
    properties: {
      ok: { type: 'boolean', description: 'true if a concrete, actionable spec could be written' },
      description: { type: 'string', description: 'what needs to be done, concrete enough for a one-shot coding agent' },
      criteria: { type: 'array', items: { type: 'string' }, description: '2-5 short, verifiable acceptance criteria' },
      questions: { type: 'array', items: { type: 'string' }, description: 'when ok=false: 1-3 targeted questions for the user' },
    },
    required: ['ok'],
  },
}]

const SPEC_SYSTEM = `You turn rough task ideas into actionable kanban tasks inside YAAM (an agent manager). The task will be handed verbatim to a one-shot coding agent, and its acceptance criteria will be verified by a watcher LLM.

Write a concise description (2-6 sentences, concrete: what, where, how to verify) and 2-5 short verifiable acceptance criteria. Preserve everything the user already wrote — polish and complete it, never discard their intent.

If the idea is too vague to produce a spec an agent could act on without guessing (no clear goal, unknown target, ambiguous scope), set ok=false and ask 1-3 targeted questions instead. Always call submit_spec exactly once.`

/** Ask the configured LLM to complete or reject a rough board-task specification. */
export async function draftTaskSpec(
  cfg: LlmConfig,
  title: string,
  description: string,
  criteria: string[],
): Promise<TaskSpecDraft> {
  const user = `Task title: ${title || '(none)'}\nUser's description: ${description || '(none)'}\nUser's criteria:\n${criteria.length ? criteria.map(c => `- ${c}`).join('\n') : '(none)'}`
  const res = await callApi(cfg, SPEC_SYSTEM, [{ role: 'user', content: user }], SPEC_TOOL)
  const call = res.content.find((b): b is ApiContentBlock => b.type === 'tool_use' && b.name === 'submit_spec')
  const input = (call?.input ?? {}) as Record<string, unknown>
  // Keep only non-empty strings from model-generated array fields.
  const strArr = (v: unknown) => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()) : []
  if (!call) return { ok: false, description, criteria, questions: ['The assistant could not parse this task — add more detail and try again.'] }
  return {
    ok: input.ok === true,
    description: typeof input.description === 'string' && input.description.trim() ? input.description.trim() : description,
    criteria: strArr(input.criteria).length ? strArr(input.criteria) : criteria,
    questions: strArr(input.questions),
  }
}

// ---------- per-task watcher (mini master) ----------

export interface WatcherExec {
  moveTask: (col: string) => string
  updateNote: (note: string) => string
  sendToSession: (text: string) => string
  askUser: (question: string) => string
}

const WATCHER_TOOLS = [
  {
    name: 'move_task',
    description: 'Move this task to a board column. progress = being worked on; review = work looks complete, awaiting user verification; done = criteria verified met; failed = the attempt failed and retrying as-is is pointless; backlog = paused/reset.',
    input_schema: {
      type: 'object',
      properties: { col: { type: 'string', enum: ['backlog', 'routed', 'progress', 'review', 'done', 'failed'] } },
      required: ['col'],
    },
  },
  {
    name: 'update_note',
    description: "Set the one-line status shown on the task's card (terse, present tense, e.g. 'running tests · 2/3 criteria met').",
    input_schema: {
      type: 'object',
      properties: { note: { type: 'string' } },
      required: ['note'],
    },
  },
  {
    name: 'send_to_session',
    description: "Type a line into the task's live session (answer a prompt, give a follow-up instruction, unblock it). Only works while the session is alive.",
    input_schema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
  {
    name: 'ask_user',
    description: 'Ask the user a question in the task chat and flag the task as waiting on them. Use when stuck, when the outcome is ambiguous, or when a decision is theirs to make. Do not also repeat the question in your reply.',
    input_schema: {
      type: 'object',
      properties: { question: { type: 'string' } },
      required: ['question'],
    },
  },
]

/** Describe a task, worker, and evidence rules for its dedicated watcher. */
function watcherSystem(task: BoardTask, agent: Agent | undefined): string {
  const criteria = (task.criteria ?? []).map((c, i) => `${i + 1}. ${c}`).join('\n') || '(none set)'
  return `You are the dedicated watcher for ONE kanban task inside YAAM (an agent manager) — a mini orchestrator that owns this task end-to-end.

THE TASK
- title: ${task.title}
- column: ${task.col}
- description: ${task.description || '(none)'}
- acceptance criteria:
${criteria}

THE WORKER
${agent
    ? `A one-shot session is handling the work: name "${agent.name}", command \`${agent.cmd || '-'}\`, status ${agent.status}${agent.summary ? `, last summary: ${agent.summary}` : ''}. You receive digests of its output and can steer it with send_to_session.`
    : 'No session is attached right now. If work is still needed, say so — the user (or Master) starts sessions.'}

YOUR DUTIES
1. Track progress against the acceptance criteria — only against evidence from digests/output, never invented.
2. Keep the board truthful with move_task: progress while working; review when the work looks complete (criteria appear met) so the user can verify; done only when the user confirms or the evidence is unambiguous; failed when the attempt failed for good.
3. Keep the card's one-line note current with update_note on every meaningful change.
4. When the session stalls, errs, or asks something you can answer from the task spec, unblock it with send_to_session.
5. When YOU are stuck, the outcome is ambiguous, or a decision belongs to the user — ask_user (sparingly; one focused question).

You also chat with the user: your final plain-text reply (if any) is posted to the task's chat. Keep replies short and concrete. Use tools first, then reply only if there is something worth saying.`
}

/** Dispatch one watcher tool call onto the task-scoped execution surface. */
function runWatcherTool(name: string, input: Record<string, unknown>, exec: WatcherExec): string {
  // Read a string argument without trusting model-generated input types.
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '')
  switch (name) {
    case 'move_task': return exec.moveTask(str('col'))
    case 'update_note': return exec.updateNote(str('note'))
    case 'send_to_session': return exec.sendToSession(str('text'))
    case 'ask_user': return exec.askUser(str('question'))
    default: return `unknown tool ${name}`
  }
}

/**
 * One watcher turn for one task. `history` is the watcher's private
 * conversation (mutated in place, capped here). Returns the watcher's final
 * prose reply, which the caller posts to the task chat.
 */
export async function runWatcherTurn(
  cfg: LlmConfig,
  getTask: () => BoardTask | undefined,
  getAgent: () => Agent | undefined,
  note: string,
  history: ApiMessage[],
  exec: WatcherExec,
): Promise<string> {
  history.push({ role: 'user', content: note })
  let reply = ''
  for (let i = 0; i < 4; i++) {
    const task = getTask()
    if (!task) break
    const res = await callApi(cfg, watcherSystem(task, getAgent()), history, WATCHER_TOOLS)
    if (res.stop_reason !== 'tool_use') {
      reply = res.content.filter(b => b.type === 'text' && b.text).map(b => b.text).join('\n').trim()
      history.push({ role: 'assistant', content: reply || '(ok)' })
      break
    }
    const results = res.content
      .filter((b): b is ApiContentBlock => b.type === 'tool_use')
      .map(b => ({
        type: 'tool_result',
        tool_use_id: b.id,
        content: runWatcherTool(b.name || '', b.input || {}, exec),
      }))
    history.push({ role: 'assistant', content: res.content })
    history.push({ role: 'user', content: results })
  }
  // cap the private history so long tasks stay cheap
  while (history.length > 20) history.shift()
  if (history.length && history[0].role !== 'user') history.shift()
  return reply
}

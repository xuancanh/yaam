// Per-task watcher: every started kanban task gets its own "mini Master" —
// a small LLM conversation that owns exactly one task. It spawns/steers the
// task's one-shot session, keeps the card moving across the board, and talks
// to the user through the task's chat. It also powers LLM-assisted task
// creation (drafting descriptions/criteria, or rejecting vague tasks).
import type { Agent, BoardTask } from '../../core/types'
import { callApi } from '../../llm/client'
import type { ApiContentBlock, ApiMessage, LlmConfig } from '../../llm/client'
import { runToolLoop, sanitizeToolHistory } from '../../llm/tool-loop'

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
  sendToSession: (text: string, session?: string) => string
  askUser: (question: string) => string
  checkSession: () => string
  spawnSession: (extraInstructions: string) => string
}

const WATCHER_TOOLS = [
  {
    name: 'move_task',
    description: 'Move this task to a board column. progress = being worked on; review = work looks complete, awaiting user verification; done = criteria verified met; failed = the attempt failed and retrying as-is is pointless; backlog = paused/reset.',
    input_schema: {
      type: 'object',
      properties: { col: { type: 'string', enum: ['backlog', 'progress', 'review', 'done', 'failed'] } },
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
    name: 'spawn_session',
    description: "Spawn a one-shot session to work this task — YOU own spawning. The task's title, description and criteria (with a goal stop-condition) are sent as its prompt automatically; extra_instructions are appended when you need to adjust the approach (e.g. retry guidance after a failure). You can run more than one session when parallel work genuinely helps, and you receive every session's output.",
    input_schema: {
      type: 'object',
      properties: { extra_instructions: { type: 'string' } },
    },
  },
  {
    name: 'send_to_session',
    description: "Type a line into one of the task's live sessions (answer a prompt, give a follow-up instruction, unblock it). `session` = session name when several are attached; defaults to the most recent. Only works while that session is alive.",
    input_schema: {
      type: 'object',
      properties: { text: { type: 'string' }, session: { type: 'string' } },
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
  {
    name: 'check_session',
    description: "Query the LIVE state of every session attached to this task: status, whether each process is still running, runtime, and the latest terminal output. Call this before concluding anything about completion — digests can lag behind reality.",
    input_schema: { type: 'object', properties: {} },
  },
]

/** Describe a task, its workers, and evidence rules for its dedicated watcher. */
function watcherSystem(task: BoardTask, agents: Agent[]): string {
  const criteria = (task.criteria ?? []).map((c, i) => `${i + 1}. ${c}`).join('\n') || '(none set)'
  const workers = agents.length
    ? agents.map(a =>
        `- "${a.name}" · status ${a.status}${a.status === 'running' || a.status === 'needs' ? ' (STILL RUNNING)' : ' (exited)'} · \`${a.cmd || '-'}\`${a.summary ? ` · last summary: ${a.summary}` : ''}`,
      ).join('\n')
    : '(none attached — if work is still needed, spawn one with spawn_session)'
  return `You are the dedicated watcher for ONE kanban task inside YAAM (an agent manager) — a mini orchestrator that owns this task end-to-end.

THE TASK
- title: ${task.title}
- column: ${task.col}
- description: ${task.description || '(none)'}
- acceptance criteria:
${criteria}

YOUR SESSIONS (you spawned or inherited these; you are their sole monitor — their output digests come straight to you)
${workers}

GROUND TRUTH RULES
- A session is FINISHED only when its process has EXITED — you get an explicit "session exited" event. Until then it is still working, no matter how complete a digest sounds. One-shot CLIs print most output only at the very end, so silence ≠ done and a promising digest ≠ done.
- When you are about to claim completion, move the task, or tell the user anything about a session's state, call check_session first and ground your statement in what it returns.

YOUR DUTIES
1. YOU own the workers: spawn_session when the task needs work and nothing is running; respawn with extra_instructions after a fixable failure; spawn a second session only when parallel work genuinely helps (they share no state — split cleanly).
2. Track progress against the acceptance criteria — only against evidence from digests/output/check_session, never invented.
3. Keep the board truthful with move_task: progress while working; review when the work looks complete (criteria appear met) so the user can verify; done only when the user confirms or the evidence is unambiguous; failed when the attempt failed for good.
4. Keep the card's one-line note current with update_note on every meaningful change.
5. When a session stalls, errs, or asks something you can answer from the task spec, unblock it with send_to_session.
6. When YOU are stuck, the outcome is ambiguous, or a decision belongs to the user — ask_user (sparingly; one focused question).

You also chat with the user: your final plain-text reply (if any) is posted to the task's chat. Keep replies short and concrete. Use tools first, then reply only if there is something worth saying.`
}

/** Dispatch one watcher tool call onto the task-scoped execution surface. */
function runWatcherTool(name: string, input: Record<string, unknown>, exec: WatcherExec): string {
  // Read a string argument without trusting model-generated input types.
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '')
  switch (name) {
    case 'move_task': return exec.moveTask(str('col'))
    case 'update_note': return exec.updateNote(str('note'))
    case 'send_to_session': return exec.sendToSession(str('text'), str('session') || undefined)
    case 'ask_user': return exec.askUser(str('question'))
    case 'check_session': return exec.checkSession()
    case 'spawn_session': return exec.spawnSession(str('extra_instructions'))
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
  getAgents: () => Agent[],
  note: string,
  history: ApiMessage[],
  exec: WatcherExec,
  signal?: AbortSignal,
  callApi?: Parameters<typeof runToolLoop>[0]['callApi'],
): Promise<string> {
  // a previous failed/aborted turn can leave dangling tool rounds — providers
  // reject those, which would silence the watcher on every later turn
  sanitizeToolHistory(history)
  history.push({ role: 'user', content: note })
  const { text: reply } = await runToolLoop({
    cfg, history, tools: WATCHER_TOOLS, maxRounds: 5, signal, callApi,
    terminalAssistant: 'text', sequential: true,
    // re-read live task/agents each round; stop if the task was deleted mid-loop
    shouldContinue: () => !!getTask(),
    system: () => { const t = getTask(); return t ? watcherSystem(t, getAgents()) : '' },
    execute: async (name, input) => runWatcherTool(name, input, exec),
  })
  // cap the private history so long tasks stay cheap — then re-establish the
  // invariants, because a blind shift() can split a tool_use/tool_result pair
  // (the exact corruption that permanently muted watchers before)
  while (history.length > 20) history.shift()
  sanitizeToolHistory(history)
  return reply
}

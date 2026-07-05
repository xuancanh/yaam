// Per-session monitor: each agent session gets its own lightweight LLM
// conversation that watches ONLY that session. It keeps the session's status
// card current, detects when the user is needed, and escalates a short digest
// to Master only when something noteworthy happens — Master never sees raw
// terminal output from the watchers.
import type { Agent } from '../../core/types'
import { callApi } from '../../llm/client'
import type { ApiContentBlock, ApiMessage, LlmConfig } from '../../llm/client'

export interface MonitorExec {
  updateStatus: (task?: string, summary?: string, actionNeeded?: string) => string
  flagNeedsInput: (question: string) => string
  reportToMaster: (digest: string, importance: 'info' | 'action' | 'critical') => string
}

const MONITOR_TOOLS = [
  {
    name: 'update_status',
    description: 'Update this session\'s card: task (what it is working on), summary (1-2 sentences), action_needed (what the user must do, empty string to clear).',
    input_schema: {
      type: 'object',
      properties: {
        task: { type: 'string' },
        summary: { type: 'string' },
        action_needed: { type: 'string' },
      },
    },
  },
  {
    name: 'flag_needs_input',
    description: 'Mark this session as waiting for the user (approval prompt, question, menu). Triggers the needs-action banner and a notification.',
    input_schema: {
      type: 'object',
      properties: { question: { type: 'string' } },
      required: ['question'],
    },
  },
  {
    name: 'report_to_master',
    description: 'Escalate a short digest to Master. ONLY for noteworthy events: the session finished its task, failed or got blocked, needs a user decision, or hit a major milestone. Routine progress must NOT be reported — just update_status.',
    input_schema: {
      type: 'object',
      properties: {
        digest: { type: 'string', description: '1-3 sentences: what happened and what should happen next' },
        importance: { type: 'string', enum: ['info', 'action', 'critical'] },
      },
      required: ['digest', 'importance'],
    },
  },
]

/** Describe one session and the monitor's strict escalation responsibilities. */
function monitorSystem(agent: Agent): string {
  return `You are a session monitor inside YAAM (an agent manager). You watch exactly ONE terminal session:
- name: ${agent.name}
- command: ${agent.cmd || '-'}
- working dir: ${agent.cwd || '-'}
- currently tracked: task="${agent.task || '-'}" summary="${agent.summary || '-'}" action_needed="${agent.actionNeeded || '-'}"

You receive the session's output whenever it settles. Your duties, in order:
1. Keep the status card current with update_status (terse: task, 1-2 sentence summary, action_needed or empty string).
2. If the session is waiting on the user (permission prompt, question, selection menu), call flag_needs_input.
3. Call report_to_master ONLY when noteworthy: task completed, error/blocked, user decision required, or a major milestone. Routine progress = update_status only, no report. Master is busy — do not spam it.

Ground every tool argument in the output you actually received — never invent progress, intentions, or results that the text does not show. If the output is ambiguous, say so in the summary rather than guessing. Never reply with prose; use tools, then stop. If nothing changed, do nothing.`
}

/** Dispatch a monitor tool call to the session-specific execution callbacks. */
function runMonitorTool(name: string, input: Record<string, unknown>, exec: MonitorExec): string {
  // Read a string argument without trusting model-generated input types.
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '')
  switch (name) {
    case 'update_status':
      return exec.updateStatus(
        typeof input.task === 'string' ? input.task : undefined,
        typeof input.summary === 'string' ? input.summary : undefined,
        typeof input.action_needed === 'string' ? input.action_needed : undefined,
      )
    case 'flag_needs_input':
      return exec.flagNeedsInput(str('question'))
    case 'report_to_master': {
      const imp = str('importance')
      return exec.reportToMaster(str('digest'), imp === 'action' || imp === 'critical' ? imp : 'info')
    }
    default:
      return `unknown tool ${name}`
  }
}

/**
 * One monitor turn for one session. `history` is this monitor's own private
 * conversation (mutated in place, capped by the caller).
 */
export async function runMonitorTurn(
  cfg: LlmConfig,
  agent: Agent,
  note: string,
  history: ApiMessage[],
  exec: MonitorExec,
  signal?: AbortSignal,
): Promise<void> {
  history.push({ role: 'user', content: note })
  for (let i = 0; i < 3; i++) {
    const res = await callApi(cfg, monitorSystem(agent), history, MONITOR_TOOLS, signal)
    if (res.stop_reason !== 'tool_use') {
      const text = res.content.filter(b => b.type === 'text' && b.text).map(b => b.text).join('\n')
      history.push({ role: 'assistant', content: text || '(ok)' })
      break
    }
    const results = res.content
      .filter((b): b is ApiContentBlock => b.type === 'tool_use')
      .map(b => ({
        type: 'tool_result',
        tool_use_id: b.id,
        content: runMonitorTool(b.name || '', b.input || {}, exec),
      }))
    history.push({ role: 'assistant', content: res.content })
    history.push({ role: 'user', content: results })
  }
  // cap the private history so long-running sessions stay cheap
  while (history.length > 16) history.shift()
  if (history.length && history[0].role !== 'user') history.shift()
}

// Dispatcher for the manager tools spawned sessions call over MCP (native
// `mcp-serve-call`). The Rust listener answers protocol plumbing; actual tool
// behavior lives here because the frontend owns tasks and agents. Two tools
// today: report_status (the agent self-reports Task/Now/Next — deterministic
// where the monitor LLM had to infer from screen text) and get_task (re-read
// the board contract before claiming completion).
import type { AppState, BoardTask } from '../../core/types'
import { mcpServeRespond, onMcpServeCall } from '../../core/native'
import type { McpServeCall } from '../../core/native'
import { markStructuredSignal } from './signal-sources'

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

const text = (t: string): Record<string, unknown> => ({ content: [{ type: 'text', text: t }] })
const errorResult = (t: string): Record<string, unknown> => ({ content: [{ type: 'text', text: t }], isError: true })

export interface McpServeDeps {
  stateRef: { current: AppState }
  applyAgentStatus: (sid: string, task?: string, summary?: string, nextAction?: string, actionNeeded?: string) => void
  taskForSession: (sessionId: string) => { task: BoardTask } | undefined
  /** event subscription; defaults to the native bridge (injectable for tests) */
  subscribe?: (cb: (e: McpServeCall) => void) => () => void
}

/** Answer one manager-tool call (exported for tests). */
export function applyMcpServeCall(deps: McpServeDeps, e: McpServeCall): Record<string, unknown> {
  const agent = e.agent ? deps.stateRef.current.agents.find(a => a.id === e.agent && !a.archived) : undefined
  if (!agent) return errorResult('unknown session — this tool is only available to sessions YAAM launched')
  // a session calling manager tools is feeding us structured signals
  markStructuredSignal(agent.id, 'hooks')
  switch (e.name) {
    case 'report_status': {
      const a = e.arguments
      deps.applyAgentStatus(agent.id, str(a.task), str(a.summary), str(a.next_action), str(a.action_needed))
      return text('status recorded')
    }
    case 'get_task': {
      const located = deps.taskForSession(agent.id)
      if (!located) return text('No board task is linked to this session.')
      const t = located.task
      const criteria = (t.criteria ?? []).map(c => `- ${c}`).join('\n')
      return text([
        `Title: ${t.title}`,
        `Column: ${t.col}`,
        t.description ? `Description:\n${t.description}` : '',
        criteria ? `Acceptance criteria:\n${criteria}` : '',
      ].filter(Boolean).join('\n\n'))
    }
    default:
      return errorResult(`unknown tool: ${e.name ?? '(none)'}`)
  }
}

/** Subscribe to manager-tool calls and answer them; returns an unsubscribe fn. */
export function attachMcpServe(deps: McpServeDeps): () => void {
  const subscribe = deps.subscribe ?? onMcpServeCall
  return subscribe(e => { void mcpServeRespond(e.callId, applyMcpServeCall(deps, e)) })
}

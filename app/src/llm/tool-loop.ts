// The shared LLM tool-loop engine. Master, the task watcher, the addon agent,
// and the addon editor all run the same loop: call the model, stop on a
// non-tool_use turn, otherwise execute the tool_use blocks and feed the results
// back — bounded by a round limit and cancellable. This centralizes that loop so
// the round cap, cancellation, tool-error containment, and history growth behave
// consistently instead of being re-implemented (differently) per runtime.
import { callApi as realCallApi } from './client'
import type { ApiContentBlock, ApiMessage, ApiResponse, LlmConfig } from './client'

export interface ToolLoopTool {
  name: string
  description: string
  input_schema: unknown
}

export interface ToolLoopParams {
  cfg: LlmConfig
  /** system prompt; a thunk when it must be re-read each round (live state) */
  system: string | (() => string)
  /** conversation history — MUTATED in place (assistant turns + tool results) */
  history: ApiMessage[]
  /** tool definitions; a thunk when they must be re-read each round */
  tools: ToolLoopTool[] | (() => ToolLoopTool[])
  /** run one tool call and return its result text (thrown errors are contained) */
  execute: (name: string, input: Record<string, unknown>, id: string) => Promise<string>
  /** max model turns before giving up */
  maxRounds: number
  signal?: AbortSignal
  /** execute a round's tool_use blocks sequentially instead of in parallel */
  sequential?: boolean
  /** how the loop-ending assistant turn is appended to history: the full content
   *  blocks (default) or just its prose text (some runtimes store only the reply) */
  terminalAssistant?: 'content' | 'text'
  /** checked before each round; return false to stop early (e.g. the task the
   *  watcher owns was deleted mid-loop). Not a failure — returns the reply so far. */
  shouldContinue?: () => boolean
  /** injectable transport (tests provide a scripted callApi) */
  callApi?: (cfg: LlmConfig, system: string, messages: ApiMessage[], tools: unknown[], signal?: AbortSignal) => Promise<ApiResponse>
}

export interface ToolLoopResult {
  /** final prose reply (empty if the loop hit its round cap without concluding) */
  text: string
  /** model turns actually taken */
  rounds: number
  /** true if the round cap was reached without a non-tool_use turn */
  maxedOut: boolean
}

const proseOf = (content: ApiContentBlock[]) =>
  content.filter(b => b.type === 'text' && b.text).map(b => b.text).join('\n').trim()

export async function runToolLoop(p: ToolLoopParams): Promise<ToolLoopResult> {
  const call = p.callApi ?? realCallApi
  const sys = () => (typeof p.system === 'function' ? p.system() : p.system)
  const toolz = () => (typeof p.tools === 'function' ? p.tools() : p.tools)

  const runOne = async (b: ApiContentBlock): Promise<ApiContentBlock> => {
    let content: string
    try {
      content = await p.execute(b.name ?? '', b.input ?? {}, b.id ?? '')
    } catch (e) {
      content = `error: ${e instanceof Error ? e.message : String(e)}`
    }
    return { type: 'tool_result', tool_use_id: b.id, content } as unknown as ApiContentBlock
  }

  for (let round = 0; round < p.maxRounds; round++) {
    if (p.shouldContinue && !p.shouldContinue()) return { text: '', rounds: round, maxedOut: false }
    const res = await call(p.cfg, sys(), p.history, toolz(), p.signal)
    const uses = res.content.filter((b): b is ApiContentBlock => b.type === 'tool_use')

    if (res.stop_reason !== 'tool_use' || uses.length === 0) {
      const text = proseOf(res.content)
      p.history.push({
        role: 'assistant',
        content: p.terminalAssistant === 'text' ? (text || '(ok)') : res.content,
      })
      return { text, rounds: round + 1, maxedOut: false }
    }

    p.history.push({ role: 'assistant', content: res.content })
    const results = p.sequential
      ? await sequential(uses, runOne)
      : await Promise.all(uses.map(runOne))
    p.history.push({ role: 'user', content: results })
  }
  return { text: '', rounds: p.maxRounds, maxedOut: true }
}

async function sequential<T, R>(items: T[], fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  for (const it of items) out.push(await fn(it))
  return out
}

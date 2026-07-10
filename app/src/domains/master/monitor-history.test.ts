import { describe, expect, it, vi } from 'vitest'
import { runMonitorTurn } from './monitor'
import type { MonitorExec } from './monitor'
import type { ApiMessage, LlmConfig } from '../../llm/client'
import type { Agent } from '../../core/types'

// REGRESSION: the monitor's history cap used blind shift()s. Once a session
// accumulated >16 entries the cap could split a tool_use/tool_result pair or
// leave the history OPENING with an orphaned tool_result — every later API
// call was rejected, freezing the status card (task/summary/action_needed)
// and muting suggest_actions for the rest of the session's life.

const cfg = {} as LlmConfig
const exec = {} as MonitorExec
const agent = { id: 'a1', name: 'worker', status: 'running' } as Agent

const textReply = { content: [{ type: 'text', text: 'noted' }], stop_reason: 'end_turn' }
const toolPair = (id: string): ApiMessage[] => [
  { role: 'assistant', content: [{ type: 'tool_use', id, name: 'update_status', input: {} }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
]

function longHistory(): ApiMessage[] {
  // enough entries that the cap point lands INSIDE a tool round
  const h: ApiMessage[] = []
  for (let i = 0; i < 5; i++) {
    h.push({ role: 'user', content: `output ${i}` })
    h.push(...toolPair(`call-${i}`))
    h.push({ role: 'assistant', content: `reply ${i}` })
  }
  return h // 20 entries
}

const openersOk = (h: ApiMessage[]) =>
  h.length === 0 || (h[0].role === 'user' && typeof h[0].content === 'string')

const pairsIntact = (h: ApiMessage[]) => {
  const uses = new Set<string>()
  const results = new Set<string>()
  for (const m of h) {
    if (!Array.isArray(m.content)) continue
    for (const b of m.content as { type: string; id?: string; tool_use_id?: string }[]) {
      if (b.type === 'tool_use' && b.id) uses.add(b.id)
      if (b.type === 'tool_result' && b.tool_use_id) results.add(b.tool_use_id)
    }
  }
  return [...uses].every(id => results.has(id)) && [...results].every(id => uses.has(id))
}

describe('runMonitorTurn history integrity', () => {
  it('capping a long history never splits tool pairs or opens with debris', async () => {
    const history = longHistory()
    const callApi = vi.fn(async () => textReply)
    await runMonitorTurn(cfg, agent, 'new output', history, exec, undefined, undefined, callApi)
    expect(history.length).toBeLessThanOrEqual(16)
    expect(openersOk(history)).toBe(true)
    expect(pairsIntact(history)).toBe(true)
  })

  it('a dangling tool round from a previously aborted turn is dropped before calling the API', async () => {
    const history: ApiMessage[] = [
      { role: 'user', content: 'earlier' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'orphan', name: 'update_status', input: {} }] },
    ]
    const callApi = vi.fn(async (_c: unknown, _s: unknown, messages: ApiMessage[]) => {
      // the request the provider actually sees must be pair-intact
      expect(pairsIntact(messages)).toBe(true)
      expect(openersOk(messages)).toBe(true)
      return textReply
    })
    await runMonitorTurn(cfg, agent, 'follow-up', history, exec, undefined, undefined, callApi)
    expect(callApi).toHaveBeenCalledOnce()
  })
})

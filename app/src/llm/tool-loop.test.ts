import { describe, expect, it, vi } from 'vitest'
import { runToolLoop } from './tool-loop'
import type { ApiMessage, ApiResponse, LlmConfig } from './client'

const cfg = {} as LlmConfig
const toolUse = (id: string, name: string, input: Record<string, unknown> = {}): ApiResponse =>
  ({ content: [{ type: 'tool_use', id, name, input }], stop_reason: 'tool_use' })
const finalText = (text: string): ApiResponse =>
  ({ content: [{ type: 'text', text }], stop_reason: 'end_turn' })

/** a callApi that replays a fixed script of responses, recording the calls */
function scripted(responses: ApiResponse[]) {
  const calls: { system: string; messages: number }[] = []
  let i = 0
  const callApi = vi.fn(async (_c: LlmConfig, system: string, messages: ApiMessage[]) => {
    calls.push({ system, messages: messages.length })
    return responses[Math.min(i++, responses.length - 1)]
  })
  return { callApi, calls }
}

describe('runToolLoop', () => {
  it('stops on a non-tool_use turn and returns its prose', async () => {
    const { callApi } = scripted([finalText('all done')])
    const history: ApiMessage[] = [{ role: 'user', content: 'go' }]
    const execute = vi.fn(async () => 'x')
    const res = await runToolLoop({ cfg, system: 'S', history, tools: [], execute, maxRounds: 5, callApi })
    expect(res).toMatchObject({ text: 'all done', rounds: 1, maxedOut: false })
    expect(execute).not.toHaveBeenCalled()
    expect(history.at(-1)).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'all done' }] })
  })

  it('executes tool_use blocks, feeds results back, and loops until a text turn', async () => {
    const { callApi, calls } = scripted([toolUse('t1', 'read'), toolUse('t2', 'read'), finalText('final')])
    const history: ApiMessage[] = [{ role: 'user', content: 'go' }]
    const execute = vi.fn(async (name: string, _i: unknown, id: string) => `${name}:${id} ok`)
    const res = await runToolLoop({ cfg, system: 'S', history, tools: [], execute, maxRounds: 5, callApi })
    expect(res).toMatchObject({ text: 'final', rounds: 3, maxedOut: false })
    expect(execute).toHaveBeenCalledTimes(2)
    // history: user, assistant(t1), user(result), assistant(t2), user(result), assistant(final)
    const roles = history.map(m => m.role)
    expect(roles).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant'])
    const firstResult = history[2].content as Array<{ type: string; tool_use_id: string; content: string }>
    expect(firstResult[0]).toMatchObject({ type: 'tool_result', tool_use_id: 't1', content: 'read:t1 ok' })
    expect(calls.length).toBe(3)
  })

  it('contains a thrown tool error as an error result (loop continues)', async () => {
    const { callApi } = scripted([toolUse('t1', 'boom'), finalText('recovered')])
    const history: ApiMessage[] = [{ role: 'user', content: 'go' }]
    const execute = vi.fn(async () => { throw new Error('kaboom') })
    const res = await runToolLoop({ cfg, system: 'S', history, tools: [], execute, maxRounds: 5, callApi })
    expect(res.text).toBe('recovered')
    const result = history[2].content as Array<{ content: string }>
    expect(result[0].content).toContain('kaboom')
  })

  it('stops at maxRounds when the model keeps calling tools', async () => {
    const { callApi } = scripted([toolUse('t', 'loop')]) // always tool_use
    const history: ApiMessage[] = [{ role: 'user', content: 'go' }]
    const execute = vi.fn(async () => 'again')
    const res = await runToolLoop({ cfg, system: 'S', history, tools: [], execute, maxRounds: 3, callApi })
    expect(res).toMatchObject({ text: '', rounds: 3, maxedOut: true })
    expect(execute).toHaveBeenCalledTimes(3)
  })

  it("terminalAssistant:'text' stores just the reply (addon-agent semantics)", async () => {
    const { callApi } = scripted([finalText('hi there')])
    const history: ApiMessage[] = [{ role: 'user', content: 'go' }]
    await runToolLoop({ cfg, system: 'S', history, tools: [], execute: vi.fn(async () => ''), maxRounds: 5, terminalAssistant: 'text', callApi })
    expect(history.at(-1)).toEqual({ role: 'assistant', content: 'hi there' })
  })

  it('re-reads system + tools thunks each round', async () => {
    const { callApi, calls } = scripted([toolUse('t1', 'x'), finalText('done')])
    let n = 0
    const history: ApiMessage[] = [{ role: 'user', content: 'go' }]
    await runToolLoop({ cfg, system: () => `S${n++}`, history, tools: () => [], execute: vi.fn(async () => 'ok'), maxRounds: 5, callApi })
    expect(calls.map(c => c.system)).toEqual(['S0', 'S1'])
  })
})

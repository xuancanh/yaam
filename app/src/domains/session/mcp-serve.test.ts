import { describe, expect, it, vi, beforeEach } from 'vitest'
import { applyMcpServeCall } from './mcp-serve'
import { useAppStore } from '../../core/store'
import { resetStructuredSignals, structuredSourceOf } from './signal-sources'
import type { Agent, AppState, BoardTask } from '../../core/types'

const agent = (over: Partial<Agent> = {}): Agent =>
  ({ id: 'a1', name: 'A', status: 'running', kind: 'real', log: [], memory: [], tools: [], ...over }) as unknown as Agent
const stateRef = { get current() { return useAppStore.getState() } }

beforeEach(() => {
  resetStructuredSignals()
  useAppStore.setState({ agents: [agent()] } as Partial<AppState> as AppState)
})

describe('applyMcpServeCall', () => {
  it('report_status forwards the fields and counts as structured coverage', () => {
    const applyAgentStatus = vi.fn()
    const result = applyMcpServeCall({ stateRef, applyAgentStatus, taskForSession: () => undefined }, {
      callId: 1, agent: 'a1', name: 'report_status',
      arguments: { task: 'ship it', summary: 'running tests', next_action: 'commit', action_needed: '' },
    })
    expect(applyAgentStatus).toHaveBeenCalledWith('a1', 'ship it', 'running tests', 'commit', undefined)
    expect(result.isError).toBeUndefined()
    expect(structuredSourceOf('a1')).toBe('hooks')
  })

  it('get_task renders the linked board contract', () => {
    const task = { title: 'Fix auth', col: 'progress', description: 'JWT refresh is broken', criteria: ['tests pass', 'no console errors'] } as unknown as BoardTask
    const result = applyMcpServeCall({ stateRef, applyAgentStatus: vi.fn(), taskForSession: () => ({ task }) }, {
      callId: 2, agent: 'a1', name: 'get_task', arguments: {},
    })
    const body = (result.content as { text: string }[])[0].text
    expect(body).toContain('Title: Fix auth')
    expect(body).toContain('- tests pass')
  })

  it('rejects unknown sessions and unknown tools', () => {
    const deps = { stateRef, applyAgentStatus: vi.fn(), taskForSession: () => undefined }
    expect(applyMcpServeCall(deps, { callId: 3, agent: 'ghost', name: 'report_status', arguments: {} }).isError).toBe(true)
    expect(applyMcpServeCall(deps, { callId: 4, agent: 'a1', name: 'rm_rf', arguments: {} }).isError).toBe(true)
    expect(deps.applyAgentStatus).not.toHaveBeenCalled()
  })
})

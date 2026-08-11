import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { applyAcpEvent, deliverAcpAnswer, resetAcpRuntime } from './acp-events'
import { useAppStore } from '../../core/store'
import { resetNeedsFlagSources } from './needs-provenance'
import type { Agent, AppState } from '../../core/types'
import * as native from '../../core/native'

const agent = (over: Partial<Agent>): Agent =>
  ({ id: 'a1', name: 'A', status: 'running', kind: 'real', acp: true, log: [], memory: [], tools: [], ...over }) as unknown as Agent
const stateRef = { get current() { return useAppStore.getState() } }

beforeEach(() => {
  resetAcpRuntime()
  resetNeedsFlagSources()
  useAppStore.setState({ agents: [agent({})] } as Partial<AppState> as AppState)
})
afterEach(() => vi.restoreAllMocks())

describe('applyAcpEvent', () => {
  it('ready captures the protocol session id for resume', () => {
    applyAcpEvent({ stateRef, setNeedsInput: vi.fn(), clearNeeds: vi.fn() },
      { agent: 'a1', kind: 'ready', sessionId: 'sess_42' })
    expect(useAppStore.getState().agents[0].cliSessionId).toBe('sess_42')
  })

  it('message chunks mark the session responding; the prompt response ends the turn', () => {
    const deps = { stateRef, setNeedsInput: vi.fn(), clearNeeds: vi.fn() }
    applyAcpEvent(deps, {
      agent: 'a1', kind: 'update',
      params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi\n' } } },
    })
    expect(useAppStore.getState().agents[0].responding).toBe(true)
    applyAcpEvent(deps, { agent: 'a1', kind: 'response', id: 2, result: { stopReason: 'end_turn' } })
    expect(useAppStore.getState().agents[0].responding).toBe(false)
  })

  it('permission requests raise needs-input with the protocol options', () => {
    const setNeedsInput = vi.fn()
    applyAcpEvent({ stateRef, setNeedsInput, clearNeeds: vi.fn() }, {
      agent: 'a1', kind: 'permission', requestId: 9,
      params: {
        toolCall: { toolCallId: 't1', title: 'Run npm test' },
        options: [
          { optionId: 'ok', name: 'Allow', kind: 'allow_once' },
          { optionId: 'no', name: 'Reject', kind: 'reject_once' },
        ],
      },
    })
    expect(setNeedsInput).toHaveBeenCalledWith('a1', 'Permission needed · Run npm test',
      [{ num: 1, label: 'Allow' }, { num: 2, label: 'Reject' }])
  })
})

describe('deliverAcpAnswer', () => {
  const raisePermission = () =>
    applyAcpEvent({ stateRef, setNeedsInput: vi.fn(), clearNeeds: vi.fn() }, {
      agent: 'a1', kind: 'permission', requestId: 9,
      params: {
        toolCall: { toolCallId: 't1', title: 'Edit file' },
        options: [
          { optionId: 'ok', name: 'Allow', kind: 'allow_once' },
          { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
          { optionId: 'no', name: 'Reject', kind: 'reject_once' },
        ],
      },
    })

  it('routes numbered choices, approve, and deny to the protocol response', async () => {
    const respond = vi.spyOn(native, 'acpRespondPermission').mockResolvedValue()
    raisePermission()
    expect(deliverAcpAnswer('a1', 2)).toBe(true)
    expect(respond).toHaveBeenLastCalledWith('a1', 9, 'always')

    raisePermission()
    expect(deliverAcpAnswer('a1', 'approve')).toBe(true)
    expect(respond).toHaveBeenLastCalledWith('a1', 9, 'ok')

    raisePermission()
    expect(deliverAcpAnswer('a1', 'deny')).toBe(true)
    expect(respond).toHaveBeenLastCalledWith('a1', 9, 'no')

    // consumed: a second answer has nothing pending (PTY path applies)
    expect(deliverAcpAnswer('a1', 'approve')).toBe(false)
  })
})

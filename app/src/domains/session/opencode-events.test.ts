import { describe, expect, it, vi, beforeEach } from 'vitest'
import { applyOpencodeEvent, opencodeSessionId, opencodeSignal } from './opencode-events'
import { useAppStore } from '../../core/store'
import { resetNeedsFlagSources } from './needs-provenance'
import type { Agent, AppState } from '../../core/types'

const agent = (over: Partial<Agent>): Agent =>
  ({ id: 'a1', name: 'A', status: 'running', kind: 'real', log: [], memory: [], tools: [], ...over }) as unknown as Agent
const stateRef = { get current() { return useAppStore.getState() } }

beforeEach(() => {
  resetNeedsFlagSources()
  useAppStore.setState({ agents: [agent({})] } as Partial<AppState> as AppState)
})

describe('opencodeSignal / opencodeSessionId', () => {
  it('maps the server bus to session signals', () => {
    expect(opencodeSignal({ type: 'permission.asked', properties: { title: 'Run npm test' } }))
      .toEqual({ kind: 'needs', question: 'Permission needed · Run npm test' })
    expect(opencodeSignal({ type: 'permission.replied' })).toEqual({ kind: 'activity' })
    expect(opencodeSignal({ type: 'session.idle' })).toEqual({ kind: 'turn-end' })
    expect(opencodeSignal({ type: 'message.part.updated' })).toEqual({ kind: 'activity' })
    expect(opencodeSignal({ type: 'server.connected' })).toBeNull()
  })
  it('finds the session id wherever the bus carries it', () => {
    expect(opencodeSessionId({ properties: { sessionID: 'ses_1' } })).toBe('ses_1')
    expect(opencodeSessionId({ properties: { info: { id: 'ses_2' } } })).toBe('ses_2')
    expect(opencodeSessionId({ properties: {} })).toBeUndefined()
  })
})

describe('applyOpencodeEvent', () => {
  it('captures the first session id for resume and flags permissions', () => {
    const setNeedsInput = vi.fn()
    const deps = { stateRef, setNeedsInput, clearNeeds: vi.fn() }
    applyOpencodeEvent(deps, { agent: 'a1', payload: { type: 'session.status', properties: { sessionID: 'ses_9' } } })
    expect(useAppStore.getState().agents[0].cliSessionId).toBe('ses_9')
    applyOpencodeEvent(deps, { agent: 'a1', payload: { type: 'permission.asked', properties: { sessionID: 'ses_9', title: 'Edit file' } } })
    expect(setNeedsInput).toHaveBeenCalledWith('a1', 'Permission needed · Edit file')
  })

  it('ignores events from other conversations on the same server', () => {
    useAppStore.setState({ agents: [agent({ cliSessionId: 'ses_mine' })] } as Partial<AppState> as AppState)
    const setNeedsInput = vi.fn()
    applyOpencodeEvent({ stateRef, setNeedsInput, clearNeeds: vi.fn() },
      { agent: 'a1', payload: { type: 'permission.asked', properties: { sessionID: 'ses_other' } } })
    expect(setNeedsInput).not.toHaveBeenCalled()
  })

  it('permission.replied clears a bus-raised flag', () => {
    const clearNeeds = vi.fn()
    const deps = { stateRef, setNeedsInput: vi.fn(), clearNeeds }
    applyOpencodeEvent(deps, { agent: 'a1', payload: { type: 'permission.asked', properties: { sessionID: 'ses_1' } } })
    useAppStore.setState({ agents: [agent({ status: 'needs', cliSessionId: 'ses_1' })] } as Partial<AppState> as AppState)
    applyOpencodeEvent(deps, { agent: 'a1', payload: { type: 'permission.replied', properties: { sessionID: 'ses_1' } } })
    expect(clearNeeds).toHaveBeenCalledWith('a1')
  })
})

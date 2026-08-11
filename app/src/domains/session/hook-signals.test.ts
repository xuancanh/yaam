import { describe, expect, it, vi, beforeEach } from 'vitest'
import { hookSignal } from './hook-signals'
import { applyHookEvent } from './hook-events'
import { useAppStore } from '../../core/store'
import { isHookNeedsFlag, resetNeedsFlagSources } from './needs-provenance'
import type { Agent, AppState } from '../../core/types'

describe('hookSignal', () => {
  it('maps lifecycle events to session signals', () => {
    expect(hookSignal({ hook_event_name: 'UserPromptSubmit' })).toEqual({ kind: 'turn-start' })
    expect(hookSignal({ hook_event_name: 'PreToolUse', tool_name: 'Bash' })).toEqual({ kind: 'activity', tool: 'Bash' })
    expect(hookSignal({ hook_event_name: 'PostToolUse', tool_name: 'Edit' })).toEqual({ kind: 'activity', tool: 'Edit' })
    expect(hookSignal({ hook_event_name: 'Stop' })).toEqual({ kind: 'turn-end' })
    expect(hookSignal({ hook_event_name: 'SessionEnd' })).toEqual({ kind: 'session-end' })
    expect(hookSignal({ hook_event_name: 'ConfigChange' })).toBeNull()
  })
  it('describes permission requests with the tool and its target', () => {
    expect(hookSignal({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm -rf /tmp/x' } }))
      .toEqual({ kind: 'needs', question: 'Permission needed · Bash — rm -rf /tmp/x' })
    expect(hookSignal({ hook_event_name: 'PermissionRequest' }))
      .toEqual({ kind: 'needs', question: 'Permission needed · a tool' })
  })
  it('raises only waiting-on-you notifications', () => {
    expect(hookSignal({ hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash' }))
      .toEqual({ kind: 'needs', question: 'Claude needs your permission to use Bash' })
    expect(hookSignal({ hook_event_name: 'Notification', message: 'Claude Code update available' })).toBeNull()
  })
})

describe('applyHookEvent', () => {
  const agent = (over: Partial<Agent>): Agent =>
    ({ id: 'a1', name: 'A', status: 'running', kind: 'real', log: [], memory: [], tools: [], cliSessionId: 'cli-1', ...over }) as unknown as Agent
  const stateRef = { get current() { return useAppStore.getState() } }

  beforeEach(() => {
    resetNeedsFlagSources()
    useAppStore.setState({ agents: [agent({})] } as Partial<AppState> as AppState)
  })

  it('resolves the agent by embedded id or CLI session id and flags needs with hook provenance', () => {
    const setNeedsInput = vi.fn()
    const deps = { stateRef, setNeedsInput, clearNeeds: vi.fn() }
    applyHookEvent(deps, { agent: null, payload: { hook_event_name: 'PermissionRequest', session_id: 'cli-1', tool_name: 'Bash' } })
    expect(setNeedsInput).toHaveBeenCalledWith('a1', 'Permission needed · Bash')
    expect(isHookNeedsFlag('a1')).toBe(true)
  })

  it('does not re-flag an already-flagged session', () => {
    useAppStore.setState({ agents: [agent({ status: 'needs' })] } as Partial<AppState> as AppState)
    const setNeedsInput = vi.fn()
    applyHookEvent({ stateRef, setNeedsInput, clearNeeds: vi.fn() },
      { agent: 'a1', payload: { hook_event_name: 'PermissionRequest', tool_name: 'Bash' } })
    expect(setNeedsInput).not.toHaveBeenCalled()
  })

  it('tool activity clears a hook-raised flag but leaves LLM-raised flags alone', () => {
    const clearNeeds = vi.fn()
    const deps = { stateRef, setNeedsInput: vi.fn(), clearNeeds }
    // hook raised the flag earlier
    applyHookEvent(deps, { agent: 'a1', payload: { hook_event_name: 'PermissionRequest', tool_name: 'Bash' } })
    useAppStore.setState({ agents: [agent({ status: 'needs' })] } as Partial<AppState> as AppState)
    applyHookEvent(deps, { agent: 'a1', payload: { hook_event_name: 'PreToolUse', tool_name: 'Bash' } })
    expect(clearNeeds).toHaveBeenCalledWith('a1')

    // an LLM-owned flag (no hook provenance) is not cleared by activity
    clearNeeds.mockClear()
    resetNeedsFlagSources()
    applyHookEvent(deps, { agent: 'a1', payload: { hook_event_name: 'PreToolUse', tool_name: 'Bash' } })
    expect(clearNeeds).not.toHaveBeenCalled()
  })

  it('tracks responding across turn start, activity, and turn end', () => {
    const deps = { stateRef, setNeedsInput: vi.fn(), clearNeeds: vi.fn() }
    applyHookEvent(deps, { agent: 'a1', payload: { hook_event_name: 'UserPromptSubmit' } })
    expect(useAppStore.getState().agents[0].responding).toBe(true)
    applyHookEvent(deps, { agent: 'a1', payload: { hook_event_name: 'Stop' } })
    expect(useAppStore.getState().agents[0].responding).toBe(false)
  })

  it('ignores unknown agents and archived sessions', () => {
    useAppStore.setState({ agents: [agent({ archived: true })] } as Partial<AppState> as AppState)
    const setNeedsInput = vi.fn()
    applyHookEvent({ stateRef, setNeedsInput, clearNeeds: vi.fn() },
      { agent: 'a1', payload: { hook_event_name: 'PermissionRequest' } })
    applyHookEvent({ stateRef, setNeedsInput, clearNeeds: vi.fn() },
      { agent: 'ghost', payload: { hook_event_name: 'PermissionRequest' } })
    expect(setNeedsInput).not.toHaveBeenCalled()
  })
})

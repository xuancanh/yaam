import { describe, expect, it, vi } from 'vitest'
import { applyPeerCall, peerState, peersOf } from './mcp-peer'
import type { PeerDeps } from './mcp-peer'
import type { Agent, AppState } from '../../core/types'

const agent = (over: Partial<Agent>): Agent =>
  ({ id: 'a', name: 'A', status: 'running', kind: 'real', log: [], memory: [], tools: [], workspaceId: 'w1', cwd: '/p', ...over }) as unknown as Agent

function setup(agents: Agent[], peerTools = true) {
  const state = {
    agents, activeWorkspace: 'w1', workspaces: [{ id: 'w1' }, { id: 'w2' }],
    settings: { peerTools, shell: 'zsh' },
    agentTypes: [{ id: 'claude', model: 'claude', enabled: true }],
  } as unknown as AppState
  const stateRef = { current: state }
  let clock = 0
  const deps: PeerDeps = {
    stateRef,
    sessionScreenTail: id => `screen of ${id}`,
    sendLine: vi.fn(),
    launchSession: vi.fn(() => 'new1'),
    sleep: async ms => { clock += ms },
    now: () => clock,
  }
  return { deps, stateRef }
}
const body = (r: Record<string, unknown>) => (r.content as { text: string }[])[0].text

describe('peerState', () => {
  it('maps runtime status to the coarse peer view', () => {
    expect(peerState({ status: 'needs' })).toBe('blocked')
    expect(peerState({ status: 'running', responding: true })).toBe('working')
    expect(peerState({ status: 'running' })).toBe('idle')
    expect(peerState({ status: 'idle' })).toBe('stopped')
    expect(peerState({ status: 'error' })).toBe('failed')
  })
})

describe('applyPeerCall', () => {
  const me = agent({ id: 'me', name: 'Me' })
  const other = agent({ id: 'b', name: 'B', responding: true })
  const elsewhere = agent({ id: 'c', name: 'C', workspaceId: 'w2' })

  it('is refused while the setting is off', async () => {
    const { deps } = setup([me, other], false)
    expect((await applyPeerCall(deps, me, 'list_sessions', {})).isError).toBe(true)
  })

  it('lists only same-workspace peers, never the caller', async () => {
    const { deps, stateRef } = setup([me, other, elsewhere])
    expect(peersOf(stateRef.current, me).map(a => a.id)).toEqual(['b'])
    const out = JSON.parse(body(await applyPeerCall(deps, me, 'list_sessions', {})))
    expect(out.sessions).toEqual([expect.objectContaining({ id: 'b', state: 'working' })])
    expect(out.agent_types).toEqual(['claude', 'shell'])
  })

  it('refuses to prompt a blocked session or one outside the workspace', async () => {
    const { deps } = setup([me, agent({ id: 'b', status: 'needs' }), elsewhere])
    expect(body(await applyPeerCall(deps, me, 'prompt_session', { session_id: 'b', text: 'hi' }))).toMatch(/Only the user/)
    expect((await applyPeerCall(deps, me, 'prompt_session', { session_id: 'c', text: 'hi' })).isError).toBe(true)
    expect(deps.sendLine).not.toHaveBeenCalled()
  })

  it('prompts and waits until the target stops working', async () => {
    const { deps, stateRef } = setup([me, agent({ id: 'b', name: 'B' })])
    deps.sendLine = vi.fn(() => {
      // starts working, then finishes after a few polls
      stateRef.current = { ...stateRef.current, agents: stateRef.current.agents.map(a => a.id === 'b' ? { ...a, responding: true } : a) }
      setTimeout(() => {}, 0)
    })
    let polls = 0
    deps.sleep = async () => {
      if (++polls === 3) stateRef.current = { ...stateRef.current, agents: stateRef.current.agents.map(a => a.id === 'b' ? { ...a, responding: false } : a) }
    }
    const r = await applyPeerCall(deps, me, 'prompt_session', { session_id: 'b', text: 'run tests', wait: true })
    expect(deps.sendLine).toHaveBeenCalledWith('b', 'run tests')
    expect(body(r)).toMatch(/B is now idle/)
    expect(body(r)).toContain('screen of b')
  })

  it('wait_for_session times out with the current state', async () => {
    const { deps } = setup([me, other])
    const r = await applyPeerCall(deps, me, 'wait_for_session', { session_id: 'b', until: 'idle', timeout_sec: 2 })
    expect(body(r)).toMatch(/Timed out; B is still working/)
  })

  it('spawns a known agent type in the caller workspace and folder', async () => {
    const { deps } = setup([me])
    const r = await applyPeerCall(deps, me, 'spawn_session', { agent: 'claude' })
    expect(deps.launchSession).toHaveBeenCalledWith('claude', '/p', undefined, 'claude', 'w1')
    expect(body(r)).toContain('id=new1')
    expect((await applyPeerCall(deps, me, 'spawn_session', { agent: 'nope' })).isError).toBe(true)
  })
})

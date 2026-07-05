import { describe, expect, it } from 'vitest'
import { selectMainState, selectSession } from './schema'
type AppState = import('../../core/types').AppState

function baseState(over: Partial<AppState> = {}): AppState {
  return {
    schemaVersion: 1,
    tasks: [], crons: [], settings: {}, toolsCatalog: [], agentTypes: [], templates: [],
    mcpServers: [], skills: [], personas: [], skillRegistries: [], chatAgentTypes: [],
    workspaces: [{ id: 'ws-a', name: 'A' }], activeWorkspace: 'ws-a', workspaceData: {},
    agents: [], groups: [], activeGroup: null, minimizedIds: [], addons: [], addonStorage: {},
    messages: [], events: [], notifications: [], pendingMasterNotes: [],
    ...over,
  } as unknown as AppState
}

describe('persistence selectors', () => {
  it('selectMainState omits agents, stamps schemaVersion, caps history slices', () => {
    const s = baseState({
      agents: [{ id: 'a1' }] as unknown as AppState['agents'],
      messages: Array.from({ length: 100 }, (_, i) => ({ id: `m${i}` })) as unknown as AppState['messages'],
      events: Array.from({ length: 100 }, (_, i) => ({ id: `e${i}` })) as unknown as AppState['events'],
    })
    const main = selectMainState(s)
    expect('agents' in main).toBe(false)
    expect(main.schemaVersion).toBe(1)
    expect(main.messages!.length).toBe(60)
    expect(main.events!.length).toBe(60)
  })
  it('selectSession wraps one agent, caps its log, and drops runtime status', () => {
    const agent = { id: 'a1', status: 'running', escReason: 'prompt', cmd: 'claude', log: Array.from({ length: 500 }, (_, i) => ({ t: 'out', x: `${i}` })) } as unknown as AppState['agents'][number]
    const out = selectSession(agent)
    expect(out.agent.id).toBe('a1')
    expect((out.agent as Record<string, unknown>).cmd).toBe('claude') // durable config kept
    expect('status' in out.agent).toBe(false) // runtime status dropped
    expect('escReason' in out.agent).toBe(false)
    expect(out.agent.log.length).toBe(200)
    expect(out.agent.log[199].x).toBe('499') // keeps the tail
  })
})

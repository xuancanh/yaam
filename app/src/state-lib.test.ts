import { describe, expect, it, vi } from 'vitest'

// state-lib pulls in the Tauri bridge transitively; stub it — these tests touch
// only pure logic (cron, persistence selectors, workspace scoping).
vi.mock('./native', () => ({}))

const { cronMatches, fieldMatches, humanizeCron, selectMainState, selectSession, scopedFromState, applyScoped, switchWorkspaceIn } = await import('./state-lib')
type AppState = import('./types').AppState

describe('fieldMatches', () => {
  it('matches wildcards, values, ranges, lists, and steps', () => {
    expect(fieldMatches('*', 5)).toBe(true)
    expect(fieldMatches('5', 5)).toBe(true)
    expect(fieldMatches('5', 6)).toBe(false)
    expect(fieldMatches('1-3', 2)).toBe(true)
    expect(fieldMatches('1,4,6', 4)).toBe(true)
    expect(fieldMatches('*/15', 30)).toBe(true)
    expect(fieldMatches('*/15', 31)).toBe(false)
  })
  it('rejects */0 and non-numeric fields instead of crashing', () => {
    expect(fieldMatches('*/0', 0)).toBe(false)
    expect(fieldMatches('abc', 5)).toBe(false)
  })
})

describe('cronMatches', () => {
  // Wed 2026-01-07 09:30 local
  const d = new Date(2026, 0, 7, 9, 30)
  it('matches an exact minute/hour', () => {
    expect(cronMatches('30 9 * * *', d)).toBe(true)
    expect(cronMatches('31 9 * * *', d)).toBe(false)
  })
  it('ORs day-of-month and day-of-week when both are restricted (crontab rule)', () => {
    // DOM=7 matches, DOW=0(Sun) does not → OR ⇒ still fires
    expect(cronMatches('30 9 7 * 0', d)).toBe(true)
    // neither DOM (8) nor DOW (0) matches ⇒ does not fire
    expect(cronMatches('30 9 8 * 0', d)).toBe(false)
  })
  it('rejects malformed expressions', () => {
    expect(cronMatches('30 9 * *', d)).toBe(false)
  })
})

describe('humanizeCron', () => {
  it('renders common shapes and preserves uncommon ones', () => {
    expect(humanizeCron('0 9 * * *')).toBe('Every day · 09:00')
    expect(humanizeCron('*/10 * * * *')).toBe('Every 10 min')
    expect(humanizeCron('weird expr')).toBe('weird expr')
  })
})

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
  it('selectSession wraps one agent and caps its log to 200 lines', () => {
    const agent = { id: 'a1', log: Array.from({ length: 500 }, (_, i) => ({ t: 'out', x: `${i}` })) } as unknown as AppState['agents'][number]
    const out = selectSession(agent)
    expect(out.agent.id).toBe('a1')
    expect(out.agent.log.length).toBe(200)
    expect(out.agent.log[199].x).toBe('499') // keeps the tail
  })
})

describe('workspace scoping round-trip', () => {
  it('scopedFromState + applyScoped preserve the active slice', () => {
    const s = baseState({
      tasks: [{ id: 't1', title: 't1', col: 'backlog', agentId: null }] as unknown as AppState['tasks'],
      crons: [{ id: 'c1', name: 'nightly' }] as unknown as AppState['crons'],
    })
    const scoped = scopedFromState(s)
    const applied = applyScoped(baseState(), scoped)
    expect(applied.tasks).toEqual(s.tasks)
    expect(applied.crons).toEqual(s.crons)
  })
  it('switchWorkspaceIn stashes the current slice and loads the target', () => {
    const s = baseState({
      workspaces: [{ id: 'ws-a', name: 'A' }, { id: 'ws-b', name: 'B' }],
      activeWorkspace: 'ws-a',
      tasks: [{ id: 't-a', title: 'a', col: 'backlog', agentId: null }] as unknown as AppState['tasks'],
    })
    const next = switchWorkspaceIn(s, 'ws-b', 'hi')
    expect(next.activeWorkspace).toBe('ws-b')
    expect(next.tasks).toEqual([]) // fresh empty slice for ws-b
    expect(next.workspaceData['ws-a'].tasks).toEqual(s.tasks) // ws-a stashed
  })
  it('switchWorkspaceIn is a no-op for the current or an unknown workspace', () => {
    const s = baseState()
    expect(switchWorkspaceIn(s, 'ws-a', 'hi')).toBe(s)
    expect(switchWorkspaceIn(s, 'ghost', 'hi')).toBe(s)
  })
})

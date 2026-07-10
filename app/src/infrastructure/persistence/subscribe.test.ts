import { describe, expect, it } from 'vitest'
import { chatTranscriptsChanged, mainPartitionChanged, secretsChanged, sessionsChanged } from './subscribe'
type AppState = import('../../core/types').AppState

function baseState(over: Partial<AppState> = {}): AppState {
  return {
    schemaVersion: 1,
    tasks: [], crons: [], settings: { apiKey: '' }, toolsCatalog: [], agentTypes: [], templates: [],
    mcpServers: [], skills: [], personas: [], skillRegistries: [], chatAgentTypes: [],
    workspaces: [], activeWorkspace: 'ws-a', workspaceData: {},
    agents: [], groups: [], activeGroup: null, minimizedIds: [], addons: [], addonStorage: {},
    messages: [], events: [], notifications: [], pendingMasterNotes: [],
    toast: '', composer: '',
    ...over,
  } as unknown as AppState
}

describe('mainPartitionChanged', () => {
  it('is false when only transient (non-persisted) slices change', () => {
    const a = baseState()
    const b = { ...a, toast: 'x', composer: 'typing…' } as AppState
    expect(mainPartitionChanged(a, b)).toBe(false)
  })
  it('is false when only agents change (those go to per-session files)', () => {
    const a = baseState()
    const b = { ...a, agents: [{ id: 'x' }] as unknown as AppState['agents'] } as AppState
    expect(mainPartitionChanged(a, b)).toBe(false)
  })
  it('is true when a durable slice changes reference', () => {
    const a = baseState()
    expect(mainPartitionChanged(a, { ...a, tasks: [{ id: 't' }] as unknown as AppState['tasks'] } as AppState)).toBe(true)
    expect(mainPartitionChanged(a, { ...a, workspaceData: { ws: {} } as unknown as AppState['workspaceData'] } as AppState)).toBe(true)
    expect(mainPartitionChanged(a, { ...a, activeWorkspace: 'ws-b' } as AppState)).toBe(true)
    expect(mainPartitionChanged(a, { ...a, chatMemory: { 'ws-a': 'remember this' } } as AppState)).toBe(true)
    expect(mainPartitionChanged(a, { ...a, durableAgents: [] } as AppState)).toBe(true)
    expect(mainPartitionChanged(a, { ...a, assistantMemory: { 'ws-a': [] } } as AppState)).toBe(true)
    expect(mainPartitionChanged(a, { ...a, harnessLog: [] } as AppState)).toBe(true)
  })
})

describe('sessionsChanged', () => {
  it('tracks the agents array reference', () => {
    const a = baseState()
    expect(sessionsChanged(a, a)).toBe(false)
    expect(sessionsChanged(a, { ...a, agents: [] as AppState['agents'] } as AppState)).toBe(true)
  })
})

describe('secretsChanged', () => {
  it('is true only for credential-bearing slices', () => {
    const a = baseState()
    expect(secretsChanged(a, { ...a, toast: 'x' } as AppState)).toBe(false)
    expect(secretsChanged(a, { ...a, settings: { apiKey: 'sk-1' } } as AppState)).toBe(true)
    expect(secretsChanged(a, { ...a, mcpServers: [{ id: 'm' }] as unknown as AppState['mcpServers'] } as AppState)).toBe(true)
    expect(secretsChanged(a, { ...a, chatAgentTypes: [{ id: 'c' }] as unknown as AppState['chatAgentTypes'] } as AppState)).toBe(true)
  })
})

describe('chatTranscriptsChanged', () => {
  const chat = (id: string, chatLog: unknown) => ({ id, kind: 'chat', chatLog }) as unknown as AppState['agents'][number]
  const real = (id: string) => ({ id, kind: 'real', log: [] }) as unknown as AppState['agents'][number]

  it('ignores changes to non-chat sessions', () => {
    const log = [{ id: 'm' }]
    const a = baseState({ agents: [chat('c', log), real('r1')] as AppState['agents'] })
    // r1 replaced (terminal output) but the chat's chatLog ref is unchanged
    const b = { ...a, agents: [chat('c', log), real('r1')] as AppState['agents'] } as AppState
    expect(chatTranscriptsChanged(a, b)).toBe(false)
  })
  it('is true when a chat transcript reference changes', () => {
    const a = baseState({ agents: [chat('c', [{ id: 'm1' }])] as AppState['agents'] })
    const b = { ...a, agents: [chat('c', [{ id: 'm1' }, { id: 'm2' }])] as AppState['agents'] } as AppState
    expect(chatTranscriptsChanged(a, b)).toBe(true)
  })
  it('is true when indexed chat metadata changes', () => {
    const log = [{ id: 'm1' }]
    const a = baseState({ agents: [{ ...chat('c', log), name: 'Old', chatTags: ['one'] }] as AppState['agents'] })
    const renamed = { ...a, agents: [{ ...a.agents[0], name: 'New' }] } as AppState
    const retagged = { ...a, agents: [{ ...a.agents[0], chatTags: ['two'] }] } as AppState
    const statusOnly = { ...a, agents: [{ ...a.agents[0], status: 'running' }] } as AppState
    expect(chatTranscriptsChanged(a, renamed)).toBe(true)
    expect(chatTranscriptsChanged(a, retagged)).toBe(true)
    expect(chatTranscriptsChanged(a, statusOnly)).toBe(false)
  })
  it('is true when a chat session is added or removed', () => {
    const a = baseState({ agents: [chat('c', [])] as AppState['agents'] })
    expect(chatTranscriptsChanged(a, { ...a, agents: [] as AppState['agents'] } as AppState)).toBe(true)
    expect(chatTranscriptsChanged(a, { ...a, agents: [chat('c', []), chat('d', [])] as AppState['agents'] } as AppState)).toBe(true)
  })
})

import { describe, it, expect } from 'vitest'
import { buildHydration } from './hydrate'
import { seedState } from '../../core/data'
import type { PersistedState } from '../../core/types'

const seed = () => seedState()

describe('buildHydration', () => {
  it('falls back to a default workspace when none are persisted', () => {
    const { next } = buildHydration({}, seed())
    expect(next.workspaces).toEqual([{ id: 'ws-default', name: 'Default' }])
    expect(next.activeWorkspace).toBe('ws-default')
  })

  it('ignores a persisted activeWorkspace that no longer exists', () => {
    const p: Partial<PersistedState> = {
      workspaces: [{ id: 'ws-a', name: 'A' }],
      activeWorkspace: 'ws-gone',
    }
    expect(buildHydration(p, seed()).next.activeWorkspace).toBe('ws-a')
  })

  it('migrates tasks parked in the removed "routed" column back to backlog', () => {
    const p = { tasks: [{ id: 't1', col: 'routed' }] } as unknown as Partial<PersistedState>
    expect(buildHydration(p, seed()).next.tasks[0].col).toBe('backlog')
  })

  it('restores only real sessions with a cmd (plus chats) and resets them to idle', () => {
    const p = {
      agents: [
        { id: 'a1', kind: 'real', cmd: 'claude', status: 'running', log: [] },
        { id: 'a2', kind: 'real', status: 'running', log: [] }, // no cmd → dropped
      ],
    } as unknown as Partial<PersistedState>
    const { next, restoredAgents } = buildHydration(p, seed())
    expect(restoredAgents.map(a => a.id)).toEqual(['a1'])
    expect(next.agents.find(a => a.id === 'a1')?.status).toBe('idle')
  })

  it('appends an interrupted marker to a chat that was persisted mid-reply', () => {
    const p = {
      agents: [{ id: 'c1', kind: 'chat', status: 'running', chatLog: [{ id: 'm', role: 'user', text: 'hi', at: 1 }] }],
    } as unknown as Partial<PersistedState>
    const chat = buildHydration(p, seed()).restoredAgents.find(a => a.id === 'c1')!
    const last = chat.chatLog![chat.chatLog!.length - 1]
    expect(last.role).toBe('assistant')
    expect(last.text).toMatch(/interrupted/)
  })

  it('stops a structured turn interrupted after an assistant delta was persisted', () => {
    const p = {
      agents: [{
        id: 'c1', kind: 'chat', chatLog: [{ id: 'm', role: 'assistant', text: 'partial reply', at: 2 }],
        chatTurns: [{
          id: 't1', at: 1, startedAt: 1, status: 'running', model: 'test',
          input: { text: 'hi', attachments: [] }, tools: [], assistantText: 'partial reply',
        }],
      }],
    } as unknown as Partial<PersistedState>
    const chat = buildHydration(p, seed()).restoredAgents.find(a => a.id === 'c1')!

    expect(chat.chatTurns?.[0].status).toBe('stopped')
    expect(chat.chatTurns?.[0].completedAt).toEqual(expect.any(Number))
    expect(chat.chatLog?.at(-1)?.text).toMatch(/interrupted/)
  })

  it('migrates legacy personas to durable agents and rebinds their chats', () => {
    const p = {
      personas: [{ id: 'terse', name: 'Terse Engineer', description: 'direct', body: 'Lead with evidence.' }],
      agents: [{ id: 'c1', kind: 'chat', status: 'idle', personaId: 'terse', chatLog: [] }],
    } as unknown as Partial<PersistedState>

    const { next } = buildHydration(p, seed())
    expect(next.durableAgents.find(d => d.id === 'da-persona-terse')).toMatchObject({
      name: 'Terse Engineer', role: 'direct', charter: 'Lead with evidence.',
    })
    expect(next.agents.find(a => a.id === 'c1')?.durableAgentId).toBe('da-persona-terse')
  })

  it('drops tab-group slots referencing unknown session ids and empties dead groups', () => {
    const p = {
      agents: [{ id: 'a1', kind: 'real', cmd: 'claude', log: [] }],
      groups: [
        { id: 'g1', slots: ['a1', 'ghost'], activePane: 3 },
        { id: 'g2', slots: ['ghost'] },
      ],
    } as unknown as Partial<PersistedState>
    const { next } = buildHydration(p, seed())
    expect(next.groups.map(g => g.id)).toEqual(['g1'])
    expect(next.groups[0].slots).toEqual(['a1', null])
    expect(next.groups[0].activePane).toBe(1) // clamped to slots.length - 1
  })

  it('preserves persisted five- and six-pane layouts', () => {
    const p = {
      groups: [{ id: 'g1', slots: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'], activePane: 5, rows: [3, 3] }],
      agents: Array.from({ length: 6 }, (_, i) => ({ id: `a${i + 1}`, kind: 'real', cmd: 'claude', log: [] })),
    } as unknown as Partial<PersistedState>
    const { next } = buildHydration(p, seed())
    expect(next.groups[0].slots).toEqual(['a1', 'a2', 'a3', 'a4', 'a5', 'a6'])
    expect(next.groups[0].rows).toEqual([3, 3])
    expect(next.groups[0].activePane).toBe(5)
  })

  it('does not auto-grant dangerous scopes to legacy addons', () => {
    const legacy = {
      id: 'addon', name: 'Legacy', enabled: true, source: 'file', createdAt: 'then',
    }
    const explicit = {
      ...legacy, id: 'explicit', permissions: ['state:read', 'http'], granted: ['http'],
    }
    const p = { addons: [legacy, explicit] } as unknown as Partial<PersistedState>

    const addons = buildHydration(p, seed()).next.addons

    expect(addons.find(a => a.id === 'addon')?.granted).toEqual(['state:read', 'ui', 'storage'])
    expect(addons.find(a => a.id === 'explicit')?.granted).toEqual(['http'])
  })
})

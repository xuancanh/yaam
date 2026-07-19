import { describe, expect, it } from 'vitest'
import type { HistoryEntry } from '../core/types'
import { historyContextIndex } from './history-list-model'

const entries = [
  { id: '1', at: 2, category: 'work', actor: 'session', kind: 'task', text: 'x', taskId: 't1', taskTitle: 'Login', sessionId: 'a1', sessionName: 'Worker A' },
  { id: '2', at: 1, category: 'action', actor: 'user', kind: 'send', text: 'y', taskId: 't1', taskTitle: 'Login', sessionId: 'a2', sessionName: 'Worker B' },
] as HistoryEntry[]

describe('historyContextIndex', () => {
  it('deduplicates task context for a session history', () => {
    expect(historyContextIndex(entries, 'session')).toEqual([{ id: 't1', label: 'Login' }])
  })

  it('lists every contributing session for a task history', () => {
    expect(historyContextIndex(entries, 'task')).toEqual([{ id: 'a1', label: 'Worker A' }, { id: 'a2', label: 'Worker B' }])
  })
})

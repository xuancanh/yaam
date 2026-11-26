import { describe, expect, it } from 'vitest'
import { newAlerts, pushCandidates } from './push-events'
import type { RemoteSnapshot } from './snapshot'

type S = RemoteSnapshot['sessions'][number]
const session = (o: Partial<S>): S => ({
  id: 's1', name: 'api', status: 'running', task: '', summary: '', nextAction: '', actionNeeded: '',
  attention: false, cost: 0, kind: 'claude', repo: '', cwd: '', term: '', cols: 80, ...o,
})
const snap = (o: Partial<RemoteSnapshot>): RemoteSnapshot => ({
  ts: 0, workspace: 'w', workspaceId: 'w', workspaces: [], sessions: [], tasks: [], durables: [], chats: [],
  master: { busy: false, brain: true, msgs: [] }, approvals: [], ...o,
})
const msg = (id: string, role: string, text: string) => ({ id, role, text, at: 0 })

describe('push alerts', () => {
  it('alerts once when a session blocks, and again only for a new question', () => {
    const a = pushCandidates(snap({ sessions: [session({ status: 'needs', actionNeeded: 'Approve Bash(npm test)?' })] }))
    const first = newAlerts(new Set(), a)
    expect(first).toEqual([expect.objectContaining({ kind: 'needs', title: 'api needs you', open: 'session:s1', tag: 's-s1' })])
    // same condition on the next publish: silent
    expect(newAlerts(new Set(a.keys()), a)).toEqual([])
    const b = pushCandidates(snap({ sessions: [session({ status: 'needs', actionNeeded: 'Approve Edit(src/a.ts)?' })] }))
    expect(newAlerts(new Set(a.keys()), b)).toHaveLength(1)
  })

  it('tells "finished" apart from "needs you"', () => {
    const c = pushCandidates(snap({ sessions: [session({ status: 'idle', attention: true, summary: 'Tests pass' })] }))
    expect([...c.values()]).toEqual([expect.objectContaining({ kind: 'done', title: 'api finished', body: 'Tests pass' })])
  })

  it('covers tasks waiting on the user and tool approvals', () => {
    const c = pushCandidates(snap({
      tasks: [{ id: 't1', title: 'Ship it', col: 'doing', watcherNote: '', watcherNext: 'Which branch?', awaitingUser: true, description: '', criteria: [], chat: [] }],
      approvals: [{ kind: 'chat', id: 'ap1', agentId: 'c9', label: 'write_file', detail: 'src/x.ts' }],
    }))
    const v = [...c.values()]
    expect(v).toContainEqual(expect.objectContaining({ title: 'Task: Ship it', body: 'Which branch?', open: 'task:t1' }))
    expect(v).toContainEqual(expect.objectContaining({ title: 'Approval needed', body: 'write_file: src/x.ts', open: 'chat:c9' }))
  })

  it('pings for an answer once per question, not per streamed chunk or event note', () => {
    const msgs = [msg('u1', 'user', 'status?'), msg('r1', 'assistant', 'Working')]
    expect(pushCandidates(snap({ master: { busy: true, brain: true, msgs } })).size).toBe(0)
    const done = pushCandidates(snap({ master: { busy: false, brain: true, msgs } }))
    const later = pushCandidates(snap({ master: { busy: false, brain: true, msgs: msgs.concat([msg('e1', 'assistant', 'monitor note')]) } }))
    expect(newAlerts(new Set(done.keys()), later)).toEqual([])
    // Master's own notes with no question from the user never ping
    expect(pushCandidates(snap({ master: { busy: false, brain: true, msgs: [msg('e1', 'assistant', 'note')] } })).size).toBe(0)
  })
})

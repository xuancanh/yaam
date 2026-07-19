import { describe, expect, it } from 'vitest'
import type { AppState } from '../../core/types'
import { authorizedRemoteRoot, remoteCommandAllowed, remoteFileRoots } from './authorization'

const state = {
  activeWorkspace: 'active',
  agents: [
    { cwd: '/work/project', workspaceId: 'active' },
    { cwd: '/work/project/deeper', workspaceId: 'active' },
    { cwd: '/secret/background', workspaceId: 'background' },
    { cwd: '/secret/archived', workspaceId: 'active', archived: true },
    { cwd: '/base', workspaceId: 'active', worktree: { workdir: '/mirror/task', root: '/base' } },
  ],
} as AppState

describe('remote file authorization', () => {
  it('exposes only active, non-archived working roots and prefers worktree mirrors', () => {
    expect(remoteFileRoots(state)).toEqual(['/work/project/deeper', '/work/project', '/mirror/task'])
  })

  it('returns the most specific containing root for native canonical checks', () => {
    expect(authorizedRemoteRoot(state, '/work/project/deeper/file.ts')).toBe('/work/project/deeper')
    expect(authorizedRemoteRoot(state, '/secret/background/file')).toBeUndefined()
    expect(authorizedRemoteRoot(state, '/secret/archived/file')).toBeUndefined()
    expect(authorizedRemoteRoot(state, 'relative/file')).toBeUndefined()
  })
})

describe('remote command authorization', () => {
  const command = (kind: string, id: string, agentId = '') => ({ kind, id, agent_id: agentId, text: '', ok: false })
  const scoped = {
    ...state,
    agents: [
      { id: 'session', kind: 'real', workspaceId: 'active' },
      {
        id: 'chat', kind: 'chat', workspaceId: 'active',
        chatLog: [
          { id: 'approval', approval: 'pending' },
          { id: 'reply', role: 'assistant', suggestions: ['Yes, ship it'] },
        ],
      },
      { id: 'background', kind: 'real', workspaceId: 'background' },
      { id: 'archived', kind: 'real', workspaceId: 'active', archived: true },
    ],
    tasks: [{ id: 'task', archived: false }, { id: 'old-task', archived: true }],
    durableAgents: [{ id: 'durable' }, { id: 'old-durable', archived: true }],
    pendingToolApprovals: [{ id: 'master-approval' }],
    workspaces: [{ id: 'active', name: 'Active' }, { id: 'background', name: 'Background' }],
  } as AppState

  it('allows visible targets and matching pending approvals', () => {
    expect(remoteCommandAllowed(scoped, command('session_input', 'session'))).toBe(true)
    expect(remoteCommandAllowed(scoped, command('chat_send', 'chat'))).toBe(true)
    expect(remoteCommandAllowed(scoped, command('task_start', 'task'))).toBe(true)
    expect(remoteCommandAllowed(scoped, command('chat_new', 'durable'))).toBe(true)
    expect(remoteCommandAllowed(scoped, command('approve_master', 'master-approval'))).toBe(true)
    expect(remoteCommandAllowed(scoped, command('approve_chat', 'approval', 'chat'))).toBe(true)
    // any EXISTING workspace is switchable — that is the feature, not a leak
    expect(remoteCommandAllowed(scoped, command('workspace_switch', 'background'))).toBe(true)
  })

  it('quick replies must match a proposed suggestion; ratings need an assistant message', () => {
    expect(remoteCommandAllowed(scoped, { kind: 'chat_reply', id: 'reply', agent_id: 'chat', text: 'Yes, ship it', ok: false })).toBe(true)
    expect(remoteCommandAllowed(scoped, { kind: 'chat_reply', id: 'reply', agent_id: 'chat', text: 'injected text', ok: false })).toBe(false)
    expect(remoteCommandAllowed(scoped, command('chat_rate', 'reply', 'chat'))).toBe(true)
    expect(remoteCommandAllowed(scoped, command('chat_rate', 'approval', 'chat'))).toBe(false) // not an assistant msg
  })

  it('rejects background, archived, mismatched, and unknown targets', () => {
    expect(remoteCommandAllowed(scoped, command('session_stop', 'background'))).toBe(false)
    expect(remoteCommandAllowed(scoped, command('session_resume', 'archived'))).toBe(false)
    expect(remoteCommandAllowed(scoped, command('task_start', 'old-task'))).toBe(false)
    expect(remoteCommandAllowed(scoped, command('chat_new', 'old-durable'))).toBe(false)
    expect(remoteCommandAllowed(scoped, command('approve_chat', 'approval', 'session'))).toBe(false)
    expect(remoteCommandAllowed(scoped, command('unknown', 'session'))).toBe(false)
    expect(remoteCommandAllowed(scoped, command('workspace_switch', 'no-such-workspace'))).toBe(false)
  })

  it('rejects switching onto a workspace a satellite window owns', () => {
    const withDetached = { ...scoped, detachedWorkspaces: ['background'] } as AppState
    expect(remoteCommandAllowed(withDetached, command('workspace_switch', 'background'))).toBe(false)
    expect(remoteCommandAllowed(withDetached, command('workspace_switch', 'active'))).toBe(true)
  })
})

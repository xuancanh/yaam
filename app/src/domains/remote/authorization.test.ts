import { describe, expect, it } from 'vitest'
import type { AppState } from '../../core/types'
import { authorizedRemoteRoot, remoteFileRoots } from './authorization'

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

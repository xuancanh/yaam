import { describe, expect, it } from 'vitest'
import { filterRecent, recentCwdsFor, rememberCwd, splitPath } from './recent-cwds'

describe('recent working folders', () => {
  it('moves a re-used folder to the front, per target, and caps the list', () => {
    let list = rememberCwd(undefined, '~/a', undefined, 1)
    list = rememberCwd(list, '~/b/', undefined, 2)
    list = rememberCwd(list, '~/a', 'box', 3)
    list = rememberCwd(list, '~/a ', undefined, 4)
    expect(list.map(r => `${r.machineId ?? ''}:${r.path}`)).toEqual([':~/a', 'box:~/a', ':~/b'])
    for (let i = 0; i < 50; i++) list = rememberCwd(list, `/p${i}`, undefined)
    expect(list).toHaveLength(40)
  })

  it('merges remembered folders with session folders, skipping worktrees and other targets', () => {
    const settings = { defaultCwd: '~/home', recentCwds: [{ path: '~/x', at: 1 }, { path: '/srv', machineId: 'box', at: 2 }] }
    const agents = [
      { cwd: '~/old', kind: 'real' as const },
      { cwd: '/Users/me/.yaam/worktrees/s1/repo', kind: 'real' as const },
      { cwd: '~/chat', kind: 'chat' as const },
      { cwd: '/remote', machineId: 'box', kind: 'real' as const },
      { cwd: '~/x', kind: 'real' as const },
    ]
    expect(recentCwdsFor(settings, agents, undefined)).toEqual(['~/x', '~/old', '~/home'])
    expect(recentCwdsFor(settings, agents, 'box')).toEqual(['/srv', '/remote'])
  })

  it('splits a path into name and parent', () => {
    expect(splitPath('/Users/me/proj/')).toEqual({ name: 'proj', parent: '/Users/me' })
    expect(splitPath('/tmp')).toEqual({ name: 'tmp', parent: '/' })
    expect(splitPath('proj')).toEqual({ name: 'proj', parent: '' })
  })
})

describe('filterRecent', () => {
  const paths = ['~/work/yaam', '~/work/api-server', '~/yaam-notes/misc', '/tmp/x']
  it('matches every word anywhere, folder-name hits first', () => {
    expect(filterRecent(paths, 'yaam')).toEqual(['~/work/yaam', '~/yaam-notes/misc'])
    expect(filterRecent(paths, 'work API')).toEqual(['~/work/api-server'])
    expect(filterRecent(paths, '  ')).toEqual(paths)
  })
})

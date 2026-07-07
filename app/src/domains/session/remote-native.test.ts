import { describe, expect, it, vi, beforeEach } from 'vitest'

// capture the command strings remoteFs runs, and feed canned output back
const exec = vi.fn<(cmd: string, cwd?: string, t?: number) => Promise<{ code: number; output: string }>>()
vi.mock('../../core/native', () => ({
  execCommand: (cmd: string, cwd?: string, t?: number) => exec(cmd, cwd, t),
  // local fns — unused in these remote tests, present so the import resolves
  listDir: vi.fn(), readTextFile: vi.fn(), readFileB64: vi.fn(),
  gitStatus: vi.fn(), gitFileDiff: vi.fn(), gitFileDiffSide: vi.fn(),
  gitStage: vi.fn(), gitUnstage: vi.fn(), gitCommit: vi.fn(),
}))

import { remoteFs, sessionFs } from './remote-native'
import type { Machine } from '../../core/types'

const m: Machine = { id: 'mc1', label: 'box', host: 'h', user: 'u' }
const okOut = (output: string) => exec.mockResolvedValueOnce({ code: 0, output })

beforeEach(() => exec.mockReset())

describe('remoteFs.listDir', () => {
  it('parses ls -1Ap output and sorts folders first, case-insensitively', async () => {
    okOut('Zeta\nsrc/\nREADME.md\n.env\nlib/\n')
    const entries = await remoteFs(m, 'a1').listDir('/srv/app')
    expect(entries.map(e => `${e.name}${e.isDir ? '/' : ''}`)).toEqual(['lib/', 'src/', '.env', 'README.md', 'Zeta'])
    expect(entries[0].path).toBe('/srv/app/lib')
    // the command went to the machine over ssh
    expect(exec.mock.calls[0][0]).toContain(`'u@h'`)
    expect(exec.mock.calls[0][0]).toContain('ls -1Ap')
  })
})

describe('remoteFs.gitStatus', () => {
  it('parses toplevel, branch, and porcelain X/Y columns', async () => {
    okOut('/srv/app\nmain\n M src/a.ts\nA  src/b.ts\n?? notes.txt\n')
    const st = await remoteFs(m, 'a1').gitStatus('/srv/app')
    expect(st).toMatchObject({ root: '/srv/app', branch: 'main' })
    expect(st.files).toEqual([
      { path: 'src/a.ts', status: 'M', index: ' ', work: 'M' },
      { path: 'src/b.ts', status: 'A', index: 'A', work: ' ' },
      { path: 'notes.txt', status: '??', index: '?', work: '?' },
    ])
  })
  it('rejects a non-repo directory (empty toplevel)', async () => {
    okOut('\n\n')
    await expect(remoteFs(m, 'a1').gitStatus('/tmp')).rejects.toThrow(/not a git repository/)
  })
})

describe('remoteFs error propagation', () => {
  it('surfaces a non-zero remote command as an error', async () => {
    exec.mockResolvedValueOnce({ code: 1, output: 'cat: nope: No such file' })
    await expect(remoteFs(m, 'a1').readTextFile('/nope')).rejects.toThrow(/No such file/)
  })
})

describe('sessionFs', () => {
  it('returns a local (non-remote) adapter when no machine', () => {
    expect(sessionFs(undefined, 'a1').remote).toBe(false)
    expect(sessionFs(m, 'a1').remote).toBe(true)
  })
})

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

import { parsePorcelain, remoteFs, sessionFs } from './remote-native'
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

describe('parsePorcelain', () => {
  it('matches git.rs: rename → destination, strips quotes, needs a space at col 2', () => {
    const st = parsePorcelain('/r', 'main', [
      'R  old.ts -> new.ts',
      ' M "file with spaces.txt"',
      'A  keep.ts',
      'bad',            // no space at column 2 → skipped
    ])
    expect(st.files.map(f => f.path)).toEqual(['new.ts', 'file with spaces.txt', 'keep.ts'])
    expect(st.files[0]).toMatchObject({ status: 'R', index: 'R', work: ' ' })
    expect(st.files[1]).toMatchObject({ status: 'M', index: ' ', work: 'M' })
  })
})

describe('remoteFs.readFileB64', () => {
  it('reads a small binary, having checked the size first', async () => {
    okOut('12\n')          // wc -c
    okOut('aGVsbG8=\n')    // base64
    expect(await remoteFs(m, 'a1').readFileB64('/small')).toBe('aGVsbG8=')
  })
  it('refuses an oversized file instead of returning a truncated (corrupt) preview', async () => {
    okOut('9999999\n')     // wc -c — well over the cap
    await expect(remoteFs(m, 'a1').readFileB64('/big.png')).rejects.toThrow(/too large/)
  })
})

describe('remoteFs.writeTextFile', () => {
  it('decodes to a temporary sibling and atomically replaces the destination', async () => {
    okOut('')
    await remoteFs(m, 'a1').writeTextFile('/srv/app/file.txt', 'hello')
    const command = exec.mock.calls[0][0]
    expect(command).toContain('.yaam-tmp-$$')
    expect(command).toContain('base64 -d > "$tmp"')
    expect(command).toContain('mv -- "$tmp"')
    expect(command.indexOf('base64 -d > "$tmp"')).toBeLessThan(command.indexOf('mv -- "$tmp"'))
  })
  it('does not execute an oversized write', async () => {
    await expect(remoteFs(m, 'a1').writeTextFile('/srv/app/file.txt', 'x'.repeat(200_001))).rejects.toThrow(/too large/)
    expect(exec).not.toHaveBeenCalled()
  })
  it('enforces the save limit in encoded bytes, not UTF-16 characters', async () => {
    await expect(remoteFs(m, 'a1').writeTextFile('/srv/app/file.txt', 'é'.repeat(100_001))).rejects.toThrow(/too large/)
    expect(exec).not.toHaveBeenCalled()
  })
})

describe('remoteFs.readTextFile', () => {
  it('checks the remote size before returning editable text', async () => {
    okOut('hello')
    expect(await remoteFs(m, 'a1').readTextFile('/srv/app/file.txt')).toBe('hello')
    const command = exec.mock.calls[0][0]
    expect(command).toContain('wc -c')
    expect(command).toContain('file too large to edit over SSH')
    expect(command.indexOf('wc -c')).toBeLessThan(command.indexOf('cat --'))
  })
  it('surfaces the remote size guard instead of exposing truncated content', async () => {
    exec.mockResolvedValueOnce({ code: 1, output: 'file too large to edit over SSH (50000 bytes; limit 30000)' })
    await expect(remoteFs(m, 'a1').readTextFile('/srv/app/large.txt')).rejects.toThrow(/too large to edit/)
  })
})

describe('remoteFs.detectRepos', () => {
  it('returns [cwd] when the folder itself is a repo', async () => {
    okOut('/srv\nmain\n') // gitStatus(cwd) succeeds
    expect(await remoteFs(m, 'a1').detectRepos('/srv')).toEqual(['/srv'])
  })
  it('finds repo subfolders when the folder is a multi-repo container', async () => {
    okOut('\n\n')                          // gitStatus(/srv) → not a repo
    okOut('repo-a/\nrepo-b/\nnotes.txt\n') // listDir(/srv)
    okOut('/srv/repo-a\nmain\n')           // gitStatus(/srv/repo-a) → repo
    okOut('\n\n')                          // gitStatus(/srv/repo-b) → not a repo
    expect(await remoteFs(m, 'a1').detectRepos('/srv')).toEqual(['/srv/repo-a'])
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

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../core/native', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gitStatus: vi.fn(),
  gitDiff: vi.fn(),
  listDir: vi.fn(),
}))
import { gitDiff, gitStatus, listDir } from '../core/native'
import { detectRepoDirs, multiRepoDiff } from './git-repos'

const asRepo = (paths: string[]) =>
  vi.mocked(gitStatus).mockImplementation(async (cwd: string) => {
    if (paths.includes(cwd)) return { root: cwd, branch: 'main', files: [] }
    throw new Error('not a git repository')
  })

beforeEach(() => vi.clearAllMocks())

describe('detectRepoDirs', () => {
  it('returns the cwd itself when it is a repo', async () => {
    asRepo(['/ws/app'])
    expect(await detectRepoDirs('/ws/app')).toEqual(['/ws/app'])
    expect(listDir).not.toHaveBeenCalled()
  })

  it('returns the immediate repo subfolders of a plain multi-repo folder', async () => {
    asRepo(['/ws/app', '/ws/api'])
    vi.mocked(listDir).mockResolvedValue([
      { name: 'app', path: '/ws/app', isDir: true },
      { name: 'api', path: '/ws/api', isDir: true },
      { name: 'docs', path: '/ws/docs', isDir: true }, // not a repo
      { name: 'README.md', path: '/ws/README.md', isDir: false },
    ])
    expect(await detectRepoDirs('/ws')).toEqual(['/ws/app', '/ws/api'])
  })

  it('returns [] when nothing under the folder is a repo', async () => {
    asRepo([])
    vi.mocked(listDir).mockResolvedValue([{ name: 'docs', path: '/ws/docs', isDir: true }])
    expect(await detectRepoDirs('/ws')).toEqual([])
  })
})

describe('multiRepoDiff', () => {
  it('single repo: one unnamed diff', async () => {
    asRepo(['/ws/app'])
    vi.mocked(gitDiff).mockResolvedValue('diff --git a/x b/x')
    expect(await multiRepoDiff('/ws/app')).toEqual([{ name: '', diff: 'diff --git a/x b/x' }])
  })

  it('multi-repo folder: one named diff per sub-repo, failures inlined', async () => {
    asRepo(['/ws/app', '/ws/api'])
    vi.mocked(listDir).mockResolvedValue([
      { name: 'app', path: '/ws/app', isDir: true },
      { name: 'api', path: '/ws/api', isDir: true },
    ])
    vi.mocked(gitDiff).mockImplementation(async cwd => {
      if (cwd === '/ws/api') throw new Error('boom')
      return 'app diff'
    })
    expect(await multiRepoDiff('/ws')).toEqual([
      { name: 'app', diff: 'app diff' },
      { name: 'api', diff: 'error: boom' },
    ])
  })

  it('throws when there is no repo at all', async () => {
    asRepo([])
    vi.mocked(listDir).mockResolvedValue([])
    await expect(multiRepoDiff('/ws')).rejects.toThrow('no git repository')
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../core/native', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gitStatus: vi.fn(),
  gitDiff: vi.fn(),
  listDir: vi.fn(),
}))
import { gitDiff, gitStatus, listDir } from '../core/native'
import { detectRepoDirs, multiRepoDiff, repoLabel } from './git-repos'

const asRepo = (paths: string[]) =>
  vi.mocked(gitStatus).mockImplementation(async (cwd: string) => {
    if (paths.includes(cwd)) return { root: cwd, branch: 'main', files: [] }
    throw new Error('not a git repository')
  })

/** fake directory tree: path → entry names, trailing '/' marks a folder */
const fakeTree = (dirs: Record<string, string[]>) =>
  vi.mocked(listDir).mockImplementation(async path => (dirs[path] ?? []).map(entry => {
    const isDir = entry.endsWith('/')
    const name = isDir ? entry.slice(0, -1) : entry
    return { name, path: `${path}/${name}`, isDir }
  }))

beforeEach(() => vi.clearAllMocks())

describe('detectRepoDirs', () => {
  it('returns the cwd itself when it is a repo', async () => {
    asRepo(['/ws/app'])
    expect(await detectRepoDirs('/ws/app')).toEqual(['/ws/app'])
    expect(listDir).not.toHaveBeenCalled()
  })

  it('returns the repo subfolders of a plain multi-repo folder', async () => {
    asRepo([])
    fakeTree({
      '/ws': ['app/', 'api/', 'docs/', 'README.md'],
      '/ws/app': ['.git/', 'src/'],
      '/ws/api': ['.git/'],
      '/ws/docs': ['guide.md'],
    })
    expect(await detectRepoDirs('/ws')).toEqual(['/ws/app', '/ws/api'])
  })

  it('finds repos nested up to three levels down, but not deeper', async () => {
    asRepo([])
    fakeTree({
      '/ws': ['group/'],
      '/ws/group': ['team/'],
      '/ws/group/team': ['api/', 'deep/'],
      '/ws/group/team/api': ['.git/', 'app.py'], // depth 3 → found
      '/ws/group/team/deep': ['repo/'],
      '/ws/group/team/deep/repo': ['.git/'],     // depth 4 → out of range
    })
    expect(await detectRepoDirs('/ws')).toEqual(['/ws/group/team/api'])
  })

  it('skips hidden/dependency folders and does not descend into found repos', async () => {
    asRepo([])
    fakeTree({
      '/ws': ['app/', 'node_modules/', '.cache/'],
      '/ws/app': ['.git/', 'vendored/'],
      '/ws/app/vendored': ['.git/'],       // inside a found repo — its business
      '/ws/node_modules': ['dep/'],
      '/ws/node_modules/dep': ['.git/'],
      '/ws/.cache': ['tool/'],
      '/ws/.cache/tool': ['.git/'],
    })
    expect(await detectRepoDirs('/ws')).toEqual(['/ws/app'])
  })

  it('returns [] when nothing under the folder is a repo', async () => {
    asRepo([])
    fakeTree({ '/ws': ['docs/'], '/ws/docs': ['guide.md'] })
    expect(await detectRepoDirs('/ws')).toEqual([])
  })
})

describe('repoLabel', () => {
  it('shows a repo relative to the scanned folder, else its basename', () => {
    expect(repoLabel('/ws', '/ws/group/api')).toBe('group/api')
    expect(repoLabel('/ws/', '/ws/api')).toBe('api')
    expect(repoLabel('/other', '/ws/api')).toBe('api')
  })
})

describe('multiRepoDiff', () => {
  it('single repo: one unnamed diff', async () => {
    asRepo(['/ws/app'])
    vi.mocked(gitDiff).mockResolvedValue('diff --git a/x b/x')
    expect(await multiRepoDiff('/ws/app')).toEqual([{ name: '', diff: 'diff --git a/x b/x' }])
  })

  it('multi-repo folder: relative names per repo, failures inlined', async () => {
    asRepo([])
    fakeTree({
      '/ws': ['app/', 'group/'],
      '/ws/app': ['.git/'],
      '/ws/group': ['api/'],
      '/ws/group/api': ['.git/'],
    })
    vi.mocked(gitDiff).mockImplementation(async cwd => {
      if (cwd === '/ws/group/api') throw new Error('boom')
      return 'app diff'
    })
    expect(await multiRepoDiff('/ws')).toEqual([
      { name: 'app', diff: 'app diff' },
      { name: 'group/api', diff: 'error: boom' },
    ])
  })

  it('throws when there is no repo at all', async () => {
    asRepo([])
    fakeTree({ '/ws': [] })
    await expect(multiRepoDiff('/ws')).rejects.toThrow('no git repository')
  })
})

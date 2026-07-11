// @vitest-environment jsdom
// When the reviewed folder contains no git repository, the workbench must not
// dead-end on an error — it falls back to the FolderExplorer (tree + rich file
// viewer) and still renders the host-supplied footer (review actions).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { createElement } from 'react'

vi.mock('../../store', () => ({
  useActions: () => ({}),
  useConductorSelector: (sel: (s: unknown) => unknown) => sel({ settings: {} }),
}))
vi.mock('../../shared/git-repos', () => ({ detectRepoDirs: async () => [], repoLabel: (_: string, p: string) => p }))
vi.mock('../../core/native', () => ({
  isTauri: false,
  listDir: async () => [
    { name: 'report.md', path: '/plain/report.md', isDir: false },
    { name: 'assets', path: '/plain/assets', isDir: true },
  ],
  gitStatus: async () => { throw new Error('not a git repository') },
  gitStage: async () => {},
  gitUnstage: async () => {},
  gitCommit: async () => '',
  gitFileDiff: async () => '',
  gitFileDiffSide: async () => '',
  readTextFile: async () => '# report',
  readFileB64: async () => '',
  onFsChange: () => () => {},
  watchDir: async () => {},
  unwatchDir: async () => {},
  worktreeDiff: async () => [],
}))
vi.mock('../../llm/client', () => ({ buildCfg: () => ({}), callApi: async () => ({ content: [] }), hasCreds: () => false }))
vi.mock('../../core/highlight', () => ({ highlight: (l: string) => l, langForFile: () => 'text' }))
vi.mock('../chat/ChatPane', () => ({ ChatPane: () => null }))
vi.mock('./TerminalPane', () => ({ TerminalPane: () => null }))

import { GitWorkbench } from './GitPanel'

afterEach(cleanup)

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve() })

describe('GitWorkbench without a git repository', () => {
  it('falls back to the folder explorer instead of an error dead-end', async () => {
    const r = render(createElement(GitWorkbench, {
      cwd: '/plain',
      footer: createElement('div', { 'data-testid': 'review-footer' }, 'footer'),
    }))
    await flush()
    expect(r.getByText(/not a git repository — browsing files/)).toBeTruthy()
    expect(r.getByText('EXPLORER')).toBeTruthy()
    // the folder's contents are listed in the tree
    expect(r.getByText('report.md')).toBeTruthy()
    expect(r.getByText('assets')).toBeTruthy()
    // review actions survive the fallback
    expect(r.getByTestId('review-footer')).toBeTruthy()
    // and the git-only chrome is gone
    expect(r.queryByText('STAGED')).toBeNull()
  })

  it('opens a file in the rich viewer on click', async () => {
    const r = render(createElement(GitWorkbench, { cwd: '/plain' }))
    await flush()
    act(() => { r.getByText('report.md').click() })
    await flush()
    // viewer header shows the file plus its line count once loaded
    expect(r.getAllByText(/report\.md/).length).toBeGreaterThan(1)
    expect(r.getByText(/1 lines/)).toBeTruthy()
  })
})

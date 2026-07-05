import { describe, expect, it } from 'vitest'
import { parseGithubUrl, resolveSource } from './plugin-market'

const registry = { owner: 'anthropics', repo: 'claude-plugins-official', ref: 'HEAD', path: '' }

describe('parseGithubUrl', () => {
  it('parses bare repos, .git suffixes, and tree URLs', () => {
    expect(parseGithubUrl('https://github.com/anthropics/claude-plugins-official'))
      .toEqual(registry)
    expect(parseGithubUrl('https://github.com/42Crunch-AI/claude-plugins.git'))
      .toEqual({ owner: '42Crunch-AI', repo: 'claude-plugins', ref: 'HEAD', path: '' })
    expect(parseGithubUrl('https://github.com/adobe/skills/tree/main/plugins/creative-cloud'))
      .toEqual({ owner: 'adobe', repo: 'skills', ref: 'main', path: 'plugins/creative-cloud' })
    expect(parseGithubUrl('https://gitlab.com/x/y')).toBeNull()
  })
})

describe('resolveSource', () => {
  it('resolves relative sources inside the marketplace repo', () => {
    expect(resolveSource(registry, './plugins/agent-sdk-dev'))
      .toEqual({ ...registry, path: 'plugins/agent-sdk-dev' })
  })

  it('resolves git-subdir sources with ref and path', () => {
    expect(resolveSource(registry, {
      source: 'git-subdir', url: 'https://github.com/adobe/skills.git',
      path: 'plugins/creative-cloud/adobe-for-creativity', ref: 'main', sha: 'abc',
    })).toEqual({ owner: 'adobe', repo: 'skills', ref: 'main', path: 'plugins/creative-cloud/adobe-for-creativity' })
  })

  it('falls back to the sha, then HEAD, for url sources', () => {
    expect(resolveSource(registry, { source: 'url', url: 'https://github.com/endorlabs/ai-plugins.git', sha: 'a67' }))
      .toEqual({ owner: 'endorlabs', repo: 'ai-plugins', ref: 'a67', path: '' })
    expect(resolveSource(registry, { source: 'url', url: 'https://github.com/o/r.git' }))
      .toEqual({ owner: 'o', repo: 'r', ref: 'HEAD', path: '' })
  })

  it('returns null for non-GitHub sources', () => {
    expect(resolveSource(registry, { source: 'url', url: 'https://example.com/repo.git' })).toBeNull()
    expect(resolveSource(registry, undefined)).toBeNull()
  })
})

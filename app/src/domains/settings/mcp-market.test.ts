import { describe, expect, it } from 'vitest'
import { availableCatalog, fromCodexToml, MCP_CATALOG } from './mcp-market'
import type { McpCandidate } from './mcp-market'
import type { McpServer } from '../../core/types'

describe('fromCodexToml', () => {
  it('reads command, args, and inline env from mcp_servers tables', () => {
    const out: McpCandidate[] = []
    fromCodexToml('Codex', [
      '[other]',
      'foo = "bar"',
      '[mcp_servers.github]',
      'command = "npx"',
      'args = ["-y", "@modelcontextprotocol/server-github"]',
      'env = { GITHUB_PERSONAL_ACCESS_TOKEN = "ghp_x" }',
      '[mcp_servers.fetch]',
      'command = "uvx"',
      'args = ["mcp-server-fetch"]',
    ].join('\n'), out)
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({
      name: 'github', source: 'Codex', transport: 'stdio', command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: 'GITHUB_PERSONAL_ACCESS_TOKEN=ghp_x',
    })
    expect(out[1]).toMatchObject({ name: 'fetch', command: 'uvx', args: ['mcp-server-fetch'] })
  })

  it('reads env sub-tables', () => {
    const out: McpCandidate[] = []
    fromCodexToml('Codex', [
      '[mcp_servers.slack]',
      'command = "npx"',
      'args = ["-y", "@modelcontextprotocol/server-slack"]',
      '[mcp_servers.slack.env]',
      'SLACK_BOT_TOKEN = "xoxb-1"',
      'SLACK_TEAM_ID = "T1"',
    ].join('\n'), out)
    expect(out).toHaveLength(1)
    expect(out[0].env).toBe('SLACK_BOT_TOKEN=xoxb-1\nSLACK_TEAM_ID=T1')
  })
})

describe('availableCatalog', () => {
  it('hides catalog entries the user already configured', () => {
    const github = MCP_CATALOG.find(c => c.name === 'github')!
    const existing: McpServer[] = [{
      id: 'mcp1', name: 'my-github', url: '', enabled: true,
      transport: 'stdio', command: github.command, args: github.args,
    }]
    const names = availableCatalog(existing).map(c => c.name)
    expect(names).not.toContain('github')
    expect(names).toContain('filesystem')
  })
})

import { beforeEach, describe, expect, it } from 'vitest'
import { describeTool, flowFor, flowStats, ingestFlow, onFlow, resetFlows } from './session-flow'

beforeEach(() => resetFlows())

describe('describeTool', () => {
  it('categorizes Claude and Codex tools', () => {
    expect(describeTool('Edit', { file_path: '/r/src/a.ts' })).toEqual({ kind: 'edit', label: 'a.ts', path: '/r/src/a.ts' })
    expect(describeTool('Bash', { command: 'npm test' }).label).toBe('npm test')
    expect(describeTool('shell', { command: ['bash', '-lc', 'cargo test'] }).label).toBe('cargo test')
    expect(describeTool('apply_patch', { input: '*** Begin Patch\n*** Update File: src/x.rs\n' })).toMatchObject({ kind: 'edit', label: 'x.rs' })
    expect(describeTool('mcp__github__create_pr', {})).toEqual({ kind: 'mcp', label: 'github · create_pr' })
  })
})

describe('ingestFlow', () => {
  it('builds a Claude timeline and settles tool results by id', () => {
    let pings = 0
    onFlow('s', () => pings++)
    ingestFlow('s', [
      { type: 'user', timestamp: '2026-11-11T10:00:00Z', message: { content: 'fix the login bug' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a/login.ts' } }, { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm test' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1' }, { type: 'tool_result', tool_use_id: 't2', is_error: true }] } },
    ])
    const f = flowFor('s')
    expect(f.map(s => s.type)).toEqual(['prompt', 'say', 'tool', 'tool'])
    expect(f[2].status).toBe('ok')
    expect(f[3].status).toBe('error')
    expect(flowStats(f)).toMatchObject({ tools: 2, errors: 1 })
    expect(pings).toBe(1)
  })

  it('reads Codex rollouts', () => {
    ingestFlow('c', [
      { type: 'event_msg', payload: { type: 'user_message', message: 'add a flag' } },
      { type: 'response_item', payload: { type: 'function_call', name: 'shell', call_id: 'c1', arguments: JSON.stringify({ command: ['bash', '-lc', 'ls'] }) } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: '{"output":"x","metadata":{"exit_code":2}}' } },
    ])
    const f = flowFor('c')
    expect(f[1]).toMatchObject({ kind: 'run', label: 'ls', status: 'error' })
  })

  it('skips meta and slash-command user entries', () => {
    ingestFlow('m', [
      { type: 'user', isMeta: true, message: { content: 'caveat' } },
      { type: 'user', message: { content: '<command-name>/compact</command-name>' } },
    ])
    expect(flowFor('m')).toEqual([])
  })
})

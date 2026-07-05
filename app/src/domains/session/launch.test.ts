import { describe, it, expect } from 'vitest'
import { buildLaunch } from './launch'
import type { AgentType } from '../../core/types'

const claude: AgentType = { id: 'claude', name: 'Claude', color: '#fff', model: '', tools: 0, desc: '', enabled: true, probe: 'claude' } as AgentType
const codex: AgentType = { id: 'codex', name: 'Codex', color: '#fff', model: '', tools: 0, desc: '', enabled: true, probe: 'codex' } as AgentType
const types = [claude, codex]

describe('buildLaunch', () => {
  it('returns null for a blank command', () => {
    expect(buildLaunch({ command: '   ', cwd: '' }, types, 'ws')).toBeNull()
  })

  it('injects a deterministic --session-id for Claude and records it on the agent', () => {
    const plan = buildLaunch({ command: 'claude', cwd: '/repo', typeId: 'claude' }, types, 'ws')!
    expect(plan.knownSessionId).toBeTruthy()
    expect(plan.spawnCommand).toBe(`claude --session-id ${plan.knownSessionId}`)
    expect(plan.agent.cliSessionId).toBe(plan.knownSessionId)
    expect(plan.agent.cmd).toBe('claude') // clean command preserved for relaunch
  })

  it('does not inject when the Claude command already resumes a session', () => {
    const plan = buildLaunch({ command: 'claude --resume abc', cwd: '', typeId: 'claude' }, types, 'ws')!
    expect(plan.knownSessionId).toBeUndefined()
    expect(plan.spawnCommand).toBe('claude --resume abc')
  })

  it('leaves non-Claude CLIs to file detection (no id injection)', () => {
    const plan = buildLaunch({ command: 'codex', cwd: '', typeId: 'codex' }, types, 'ws')!
    expect(plan.knownSessionId).toBeUndefined()
    expect(plan.spawnCommand).toBe('codex')
  })

  it('labels one-shot runs and warns when no working folder is set', () => {
    const plan = buildLaunch({ command: 'claude', cwd: '', typeId: 'claude', opts: { ephemeral: true } }, types, 'ws')!
    const text = plan.agent.log.map(l => l.x).join('\n')
    expect(text).toMatch(/one-shot run/)
    expect(text).toMatch(/home directory/)
    expect(plan.agent.repo).toBe('~')
  })

  it('defaults the workspace to the active one', () => {
    const plan = buildLaunch({ command: 'claude', cwd: '/repo', typeId: 'claude' }, types, 'ws-active')!
    expect(plan.agent.workspaceId).toBe('ws-active')
    expect(plan.agent.repo).toBe('repo')
  })
})

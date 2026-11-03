import { describe, expect, it } from 'vitest'
import { ADAPTERS, adapterFor, binOf, shQuote } from './agent-adapters'
import { buildTemplateCommand } from '../domains/schedules/template-command'
import type { AgentTemplate, AgentType } from './types'

const type = (over: Partial<AgentType>): AgentType =>
  ({ id: 't', name: 'T', color: '#fff', model: '', tools: 0, desc: '', enabled: true, ...over }) as AgentType

const tpl = (over: Partial<AgentTemplate>): AgentTemplate =>
  ({
    id: 'tpl', name: 'Tpl', typeId: 'claude', mode: 'ephemeral', prompt: 'do {task}',
    systemPrompt: '', model: '', approval: 'safe', cwd: '', extraArgs: '', autoArchive: false,
    ...over,
  }) as unknown as AgentTemplate

describe('binOf / adapterFor', () => {
  it('reduces commands to executable basenames', () => {
    expect(binOf('claude --resume x')).toBe('claude')
    expect(binOf('/usr/local/bin/codex exec')).toBe('codex')
    expect(binOf('  ')).toBe('')
  })
  it('resolves via probe first, then binary basename, path included', () => {
    expect(adapterFor(type({ probe: 'codex' }), 'claude')?.id).toBe('codex')
    expect(adapterFor(undefined, '/opt/bin/claude -p hi')?.id).toBe('claude')
    expect(adapterFor(undefined, 'opencode')?.id).toBe('opencode')
    expect(adapterFor(undefined, 'aider')).toBeUndefined()
  })
})

describe('session-id strategy', () => {
  it('claude mints; codex and opencode detect', () => {
    expect(ADAPTERS.claude.sessionId).toBe('mint')
    expect(ADAPTERS.claude.mintFlag!('u-1')).toBe('--session-id u-1')
    expect(ADAPTERS.codex.sessionId).toBe('detect')
    expect(ADAPTERS.opencode.sessionId).toBe('detect')
  })
  it('gemini mints and resumes by uuid; omp detects', () => {
    expect(ADAPTERS.gemini.sessionId).toBe('mint')
    expect(ADAPTERS.gemini.mintFlag!('u-1')).toBe('--session-id u-1')
    expect(ADAPTERS.gemini.sessionFlagRe!.test('gemini --resume latest')).toBe(true)
    expect(ADAPTERS.gemini.sessionFlagRe!.test('gemini')).toBe(false)
    expect(ADAPTERS.omp.sessionId).toBe('detect')
    expect(adapterFor(undefined, 'omp --model opus')?.id).toBe('omp')
  })
  it('claude forwards SessionStart through a command hook (http hooks are skipped for it)', () => {
    const settings = JSON.parse(ADAPTERS.claude.hookSettings!('http://127.0.0.1:1/hook?token=t&agent=a'))
    const start = settings.hooks.SessionStart[0].hooks[0]
    expect(start.type).toBe('command')
    expect(start.command).toContain(`curl`)
    expect(start.command).toContain(`'http://127.0.0.1:1/hook?token=t&agent=a'`)
    expect(settings.hooks.Stop[0].hooks[0].type).toBe('http')
  })
  it('claude skips minting when the command already carries session identity', () => {
    for (const cmd of ['claude --resume abc', 'claude -c', 'claude --session-id x']) {
      expect(ADAPTERS.claude.sessionFlagRe!.test(cmd)).toBe(true)
    }
    expect(ADAPTERS.claude.sessionFlagRe!.test('claude -p hi')).toBe(false)
  })
})

describe('buildTemplateCommand via adapters', () => {
  it('claude: one-shot flags, system prompt flag, approval mapping', () => {
    const t = tpl({ systemPrompt: 'be brief', model: 'opus', approval: 'edits' })
    expect(buildTemplateCommand(t, type({ model: 'claude', probe: 'claude' }), 'fix it'))
      .toBe(`claude -p --model 'opus' --append-system-prompt 'be brief' --permission-mode acceptEdits 'do fix it'`)
  })
  it('codex: exec mode, sandbox mapping, system prompt folded into the prompt', () => {
    const t = tpl({ typeId: 'codex', systemPrompt: 'be brief', approval: 'full' })
    expect(buildTemplateCommand(t, type({ model: 'codex', probe: 'codex' }), 'fix it'))
      .toBe(`codex exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox 'be brief\n\ndo fix it'`)
  })
  it('opencode: run subcommand for one-shot, --auto only on full approval', () => {
    const t = tpl({ typeId: 'opencode', approval: 'full' })
    expect(buildTemplateCommand(t, type({ model: 'opencode', probe: 'opencode' }), 'fix it'))
      .toBe(`opencode run --auto 'do fix it'`)
    expect(buildTemplateCommand(tpl({ typeId: 'opencode', mode: 'interactive' }), type({ model: 'opencode', probe: 'opencode' }), 'fix it'))
      .toBe(`opencode 'do fix it'`)
  })
  it('gemini: -p for one-shot, -i to seed interactive, approval-mode mapping', () => {
    const g = type({ model: 'gemini', probe: 'gemini' })
    expect(buildTemplateCommand(tpl({ typeId: 'gemini', approval: 'edits', model: 'gemini-3-pro' }), g, 'fix it'))
      .toBe(`gemini -m 'gemini-3-pro' --approval-mode auto_edit -p 'do fix it'`)
    expect(buildTemplateCommand(tpl({ typeId: 'gemini', mode: 'interactive', approval: 'full' }), g, 'fix it'))
      .toBe(`gemini --approval-mode yolo -i 'do fix it'`)
  })
  it('omp: print mode, system prompt flag, approval mapping', () => {
    const o = type({ model: 'omp', probe: 'omp' })
    expect(buildTemplateCommand(tpl({ typeId: 'omp', systemPrompt: 'sp', approval: 'full' }), o, 'fix it'))
      .toBe(`omp -p --append-system-prompt 'sp' --auto-approve 'do fix it'`)
    expect(buildTemplateCommand(tpl({ typeId: 'omp', mode: 'interactive', approval: 'edits' }), o, 'fix it'))
      .toBe(`omp --approval-mode write 'do fix it'`)
  })
  it('unknown CLIs get the generic shape and the contract rides after the prompt', () => {
    const t = tpl({ typeId: 'aider', systemPrompt: 'sp', extraArgs: '--yes' })
    expect(buildTemplateCommand(t, type({ model: 'aider' }), 'fix it', 'CONTRACT'))
      .toBe(`aider --yes ${shQuote('sp\n\ndo fix it\n\nCONTRACT')}`)
  })
})

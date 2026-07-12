import { describe, it, expect } from 'vitest'
import { detectPrompt, deterministicStatus, extractOptions, stableScreenKey } from './prompt-detection'

describe('stableScreenKey', () => {
  it('treats a redraw that only advances a spinner as the same screen', () => {
    const a = stableScreenKey(['⠋ Building project', 'compiling module A'])
    const b = stableScreenKey(['⠙ Building project', 'compiling module A'])
    expect(a).toBe(b)
  })

  it('drops decoration/blank lines and collapses whitespace', () => {
    expect(stableScreenKey(['────────', '  running   tests  ', '   '])).toBe('running tests')
  })

  it('changes when real content changes', () => {
    expect(stableScreenKey(['tests: 1 passed'])).not.toBe(stableScreenKey(['tests: 2 passed']))
  })
})

describe('detectPrompt', () => {
  it('flags a plain y/n prompt on the stream tail', () => {
    const r = detectPrompt(['building…', 'Do you want to proceed? [y/n]'], false)
    expect(r.promptDetected).toBe(true)
    expect(r.busy).toBe(false)
    expect(r.question).toMatch(/proceed/i)
  })

  it('flags a line that merely ends in a question mark or colon', () => {
    expect(detectPrompt(['Enter your name:'], false).promptDetected).toBe(true)
    expect(detectPrompt(['What is the target branch?'], false).promptDetected).toBe(true)
  })

  it('does not flag ordinary output', () => {
    expect(detectPrompt(['compiled 42 modules', 'done in 1.2s'], false).promptDetected).toBe(false)
  })

  it('flags a full-screen TUI approval dialog', () => {
    const screen = ['╭──────────╮', '│ Do you want to make this edit? │', '│ ❯ 1. Yes │', '│   2. No  │']
    const r = detectPrompt(screen, true)
    expect(r.promptDetected).toBe(true)
    expect(r.question).toMatch(/make this edit/i)
  })

  it('suppresses detection while the TUI busy marker is on screen', () => {
    const screen = ['Do you want to proceed?', 'esc to interrupt']
    const r = detectPrompt(screen, true)
    expect(r.busy).toBe(true)
    expect(r.promptDetected).toBe(false)
  })

  it('pairs with extractOptions on the same screen', () => {
    const screen = ['Choose one:', '❯ 1. Approve', '  2. Deny']
    expect(detectPrompt(screen, true).promptDetected).toBe(true)
    const { options, cursorNum } = extractOptions(screen)
    expect(options.map(o => o.label)).toEqual(['Approve', 'Deny'])
    expect(cursorNum).toBe(1)
  })
})

describe('deterministicStatus', () => {
  it('summarizes the last meaningful line, skipping decoration/noise', () => {
    const r = deterministicStatus(['building...', 'Tests passed: 42', '────────────', '   '])
    expect(r.summary).toBe('Tests passed: 42')
    expect(r.actionNeeded).toBeUndefined()
  })

  it('flags recent error-looking output as action needed', () => {
    const r = deterministicStatus(['running build', 'Error: cannot find module "x"'])
    expect(r.actionNeeded).toMatch(/error/i)
    expect(r.summary).toContain('cannot find module')
  })

  it('does not re-flag an error buried far above the recent tail', () => {
    const old = ['error: transient blip']
    const recent = Array.from({ length: 12 }, (_, i) => `ok line ${i}`)
    expect(deterministicStatus([...old, ...recent]).actionNeeded).toBeUndefined()
  })
})

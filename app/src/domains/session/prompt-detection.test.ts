import { describe, it, expect } from 'vitest'
import { detectPrompt, extractOptions, stableScreenKey } from './prompt-detection'

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

  it('flags a last line that ends in a question mark', () => {
    expect(detectPrompt(['What is the target branch?'], false).promptDetected).toBe(true)
    expect(detectPrompt(['Continue?'], false).promptDetected).toBe(true)
  })

  it('does not flag output that merely mentions prompt-ish words or ends in a colon', () => {
    expect(detectPrompt(['npm error code EACCES', 'npm error permission denied'], false).promptDetected).toBe(false)
    expect(detectPrompt(['error: something failed'], false).promptDetected).toBe(false)
    expect(detectPrompt(['Done:'], false).promptDetected).toBe(false)
    expect(detectPrompt(['Enter your name:'], false).promptDetected).toBe(false)
    expect(detectPrompt(['please confirm receipt of 3 items'], false).promptDetected).toBe(false)
  })

  it('judges plain streams by the last non-empty line only', () => {
    // a prompt that scrolled past (newer output below it) is no longer waiting
    expect(detectPrompt(['Do you want to proceed? [y/n]', 'compiling module B'], false).promptDetected).toBe(false)
    // trailing blank lines don't hide a real prompt
    expect(detectPrompt(['Continue?', ''], false).promptDetected).toBe(true)
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

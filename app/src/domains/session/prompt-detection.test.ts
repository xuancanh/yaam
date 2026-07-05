import { describe, it, expect } from 'vitest'
import { detectPrompt, extractOptions } from './prompt-detection'

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

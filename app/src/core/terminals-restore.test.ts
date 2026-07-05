// @vitest-environment jsdom
// Regression: xterm's `?1049l` handler "restores" the cursor even when nothing
// was saved, landing at row 0 — the next process then overwrote/cleared the
// preserved history, leaving a blank screen with only its own last lines
// ("Resume this session with: claude --resume …"). restoreTerminalModes must
// therefore (a) not touch the alt-screen state of a normal-buffer terminal and
// (b) after actually leaving the alt screen, re-park the cursor below the
// existing content so new output appends instead of overwriting.
import { describe, expect, it, vi } from 'vitest'

vi.mock('./native', () => ({
  onSessionData: () => {},
  resizeSession: async () => {},
  writeSession: async () => {},
}))

import { getTerminal, isAltScreen, restoreTerminalModes, disposeTerminal } from './terminals'

const write = (term: { write: (d: string, cb?: () => void) => void }, data: string) =>
  new Promise<void>(r => term.write(data, r))

const settle = () => new Promise<void>(r => setTimeout(r, 30))

const screenText = (term: ReturnType<typeof getTerminal>['term']): string[] => {
  const buf = term.buffer.active
  const out: string[] = []
  for (let y = 0; y < buf.length; y++) out.push(buf.getLine(y)?.translateToString(true) ?? '')
  return out
}

describe('restoreTerminalModes', () => {
  it('keeps the cursor in place on a normal-buffer terminal', async () => {
    const { term } = getTerminal('rt-normal')
    await write(term, 'line one\r\nline two\r\n$ ')
    const before = { x: term.buffer.active.cursorX, y: term.buffer.active.cursorY }
    restoreTerminalModes('rt-normal')
    await settle()
    expect(term.buffer.active.type).toBe('normal')
    expect({ x: term.buffer.active.cursorX, y: term.buffer.active.cursorY }).toEqual(before)
    // history intact — a subsequent write appends after the prompt
    await write(term, 'resumed')
    expect(screenText(term).slice(0, 3)).toEqual(['line one', 'line two', '$ resumed'])
    disposeTerminal('rt-normal')
  })

  it('leaves a dead TUI alt screen and parks the cursor after the history', async () => {
    const { term } = getTerminal('rt-alt')
    await write(term, 'old history A\r\nold history B\r\n')
    await write(term, '\x1b[?1049h\x1b[2J\x1b[HTUI CONTENT') // TUI enters alt screen and draws
    expect(isAltScreen('rt-alt')).toBe(true)
    restoreTerminalModes('rt-alt')
    await settle()
    expect(isAltScreen('rt-alt')).toBe(false)
    // new output (the respawned CLI) must land BELOW the preserved history,
    // not at row 0 over it
    await write(term, 'new output')
    const text = screenText(term)
    expect(text[0]).toBe('old history A')
    expect(text[1]).toBe('old history B')
    expect(text.indexOf('new output')).toBeGreaterThanOrEqual(2)
    disposeTerminal('rt-alt')
  })

  it('scrolls one line open when the history fills the whole screen', async () => {
    const { term } = getTerminal('rt-full')
    const rows = term.rows
    for (let i = 1; i <= rows; i++) await write(term, `history ${i}\r\n`)
    await write(term, '\x1b[?1049h\x1b[2JTUI')
    restoreTerminalModes('rt-full')
    await settle()
    await write(term, 'after')
    const text = screenText(term).filter(l => l)
    expect(text).toContain('history 1')
    expect(text[text.length - 1]).toBe('after')
    disposeTerminal('rt-full')
  })
})

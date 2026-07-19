import { describe, expect, it } from 'vitest'
import { TerminalInputBuffer } from './terminal-input'

describe('TerminalInputBuffer', () => {
  it('emits text only when Enter is sent', () => {
    const input = new TerminalInputBuffer()
    expect(input.feed('fix the tests')).toEqual([])
    expect(input.feed('\r')).toEqual(['fix the tests'])
  })

  it('tracks basic line editing before submission', () => {
    const input = new TerminalInputBuffer()
    input.feed('helo')
    input.feed('\x1b[D')
    input.feed('l')
    expect(input.feed('\r')).toEqual(['hello'])

    input.feed('remove mistake\x17fixed')
    expect(input.feed('\r')).toEqual(['remove fixed'])
  })

  it('keeps bracketed multiline paste as one submission', () => {
    const input = new TerminalInputBuffer()
    expect(input.feed('\x1b[200~line one\nline two\x1b[201~')).toEqual([])
    expect(input.feed('\r')).toEqual(['line one\nline two'])
  })

  it('records an empty Enter but not arrows or cancellation', () => {
    const input = new TerminalInputBuffer()
    input.feed('\x1b[A')
    expect(input.feed('\r')).toEqual([''])
    input.feed('secret')
    input.feed('\x03')
    expect(input.feed('\r')).toEqual([''])
  })
})


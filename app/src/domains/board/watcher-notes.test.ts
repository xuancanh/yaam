import { describe, it, expect } from 'vitest'
import { enqueueWatcherNote, isProgressNote, NOTE_PROGRESS } from './watcher-notes'

const progress = (s: string) => `${NOTE_PROGRESS} ${s}`

describe('enqueueWatcherNote', () => {
  it('keeps only the latest progress note (overlapping settles supersede)', () => {
    let q: string[] = []
    q = enqueueWatcherNote(q, progress('screen v1'))
    q = enqueueWatcherNote(q, progress('screen v2'))
    q = enqueueWatcherNote(q, progress('screen v3'))
    expect(q).toEqual([progress('screen v3')])
  })

  it('accumulates discrete events in order', () => {
    let q: string[] = []
    q = enqueueWatcherNote(q, '[user message] hello')
    q = enqueueWatcherNote(q, 'The session is waiting at a prompt')
    expect(q).toEqual(['[user message] hello', 'The session is waiting at a prompt'])
  })

  it('a progress note supersedes an earlier progress note but preserves events around it', () => {
    let q: string[] = []
    q = enqueueWatcherNote(q, progress('old screen'))
    q = enqueueWatcherNote(q, '[user message] answer this')
    q = enqueueWatcherNote(q, progress('new screen'))
    // the stale progress is dropped; the user message survives; latest progress last
    expect(q).toEqual(['[user message] answer this', progress('new screen')])
  })

  it('classifies notes', () => {
    expect(isProgressNote(progress('x'))).toBe(true)
    expect(isProgressNote('[user message] x')).toBe(false)
  })
})

import { describe, it, expect } from 'vitest'
import { enqueueWatcherNote, isProgressNote, NOTE_PROGRESS, WATCHER_QUEUE_CAP } from './watcher-notes'

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

  // REL-12: notes queued while the watcher is busy must be capped — a stuck
  // turn otherwise accumulates them forever and drains as one huge message.
  it('caps the queue, keeping the newest notes', () => {
    let q: string[] = []
    for (let i = 1; i <= WATCHER_QUEUE_CAP + 4; i++) q = enqueueWatcherNote(q, `event ${i}`)
    expect(q).toHaveLength(WATCHER_QUEUE_CAP)
    expect(q[0]).toBe('event 5') // oldest dropped
    expect(q[q.length - 1]).toBe(`event ${WATCHER_QUEUE_CAP + 4}`) // newest kept
  })

  it('the cap still lets a fresh progress note supersede a stale one', () => {
    let q: string[] = []
    for (let i = 0; i < WATCHER_QUEUE_CAP; i++) q = enqueueWatcherNote(q, `event ${i}`)
    q = enqueueWatcherNote(q, progress('stale'))
    q = enqueueWatcherNote(q, progress('fresh'))
    expect(q).toHaveLength(WATCHER_QUEUE_CAP)
    expect(q.some(n => n.includes('stale'))).toBe(false)
    expect(q[q.length - 1]).toBe(progress('fresh'))
  })
})

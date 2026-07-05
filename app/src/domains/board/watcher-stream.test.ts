// The task chat streams the watcher's in-flight reply: deltas land in
// taskStreams[taskId] while the model talks, and clear() removes the entry
// when the turn settles (so the final pushTaskChat message replaces it).
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../../core/types'
import type { StreamDelta } from '../../llm/client'

let deltas: StreamDelta = () => {}
vi.mock('../../llm/client', () => ({
  callApiStream: (_c: unknown, _s: unknown, _m: unknown, _t: unknown, onDelta: StreamDelta) => {
    deltas = onDelta
    return new Promise(() => {}) // stays in flight; the test drives deltas by hand
  },
}))
vi.mock('../../master', () => ({}))
vi.mock('../../core/terminals', () => ({}))
vi.mock('../session/command', () => ({}))
vi.mock('./watcher', () => ({}))

import { makeStreamingCall } from './watcher-runner'

describe('makeStreamingCall', () => {
  let state = { taskStreams: undefined } as unknown as AppState
  const ctx = { dispatch: (f: (s: AppState) => AppState) => { state = f(state) } }

  beforeEach(() => {
    state = { taskStreams: undefined } as unknown as AppState
    vi.useFakeTimers()
  })

  it('streams text deltas into taskStreams, per round, and clears on settle', () => {
    const { call, clear } = makeStreamingCall(ctx, 't1')
    void call({} as never, 'sys', [], [])
    deltas('Looking at ')
    expect(state.taskStreams?.t1).toBe('Looking at ')

    // throttled trailer catches the rapid follow-up delta
    deltas('the failing test…')
    vi.advanceTimersByTime(120)
    expect(state.taskStreams?.t1).toBe('Looking at the failing test…')

    // thinking-channel deltas never reach the task chat
    deltas('secret reasoning', 'thinking')
    vi.advanceTimersByTime(120)
    expect(state.taskStreams?.t1).toBe('Looking at the failing test…')

    // a new round starts a fresh assistant turn
    void call({} as never, 'sys', [], [])
    deltas('Round two')
    vi.advanceTimersByTime(120)
    expect(state.taskStreams?.t1).toBe('Round two')

    clear()
    expect(state.taskStreams).toEqual({})
  })

  it('clear is a no-op when nothing streamed (no stray store writes)', () => {
    const { clear } = makeStreamingCall(ctx, 't9')
    const before = state
    clear()
    expect(state).toBe(before)
  })
})

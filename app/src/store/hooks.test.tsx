// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { createElement, useRef } from 'react'
import { act, render } from '@testing-library/react'
import { StoreCtx } from '../context'
import type { ConductorStore } from '../context'
import { useConductorSelector } from './hooks'
import type { AppState } from '../types'

// Minimal external store standing in for the provider — lets us drive state
// changes and assert exactly when a selector consumer re-renders.
function mockStore(initial: AppState) {
  let state = initial
  const subs = new Set<() => void>()
  const store: ConductorStore = {
    subscribe: cb => { subs.add(cb); return () => { subs.delete(cb) } },
    getSnapshot: () => state,
  }
  const set = (next: AppState) => { state = next; subs.forEach(cb => cb()) }
  return { store, set }
}

describe('useConductorSelector', () => {
  it('re-renders only when the selected slice changes', () => {
    const { store, set } = mockStore({ toast: 'a', composer: 'x' } as unknown as AppState)
    let renders = 0
    let seen: string | null = null

    function Probe() {
      renders++
      seen = useConductorSelector((s: AppState) => s.toast)
      const rc = useRef(0); rc.current++
      return createElement('span', null, seen)
    }
    render(createElement(StoreCtx.Provider, { value: store }, createElement(Probe)))

    expect(renders).toBe(1)
    expect(seen).toBe('a')

    // change an UNRELATED slice → selected value identical → no re-render
    act(() => set({ toast: 'a', composer: 'y' } as unknown as AppState))
    expect(renders).toBe(1)

    // change the SELECTED slice → re-render with the new value
    act(() => set({ toast: 'b', composer: 'y' } as unknown as AppState))
    expect(renders).toBe(2)
    expect(seen).toBe('b')
  })

  it('supports a custom equality function for object slices', () => {
    const eq = (a: { n: number }, b: { n: number }) => a.n === b.n
    const { store, set } = mockStore({ agents: [{ id: 'a', n: 1 }] } as unknown as AppState)
    let renders = 0
    function Probe() {
      renders++
      useConductorSelector((s: AppState) => ({ n: (s as unknown as { agents: { n: number }[] }).agents[0].n }), eq)
      return null
    }
    render(createElement(StoreCtx.Provider, { value: store }, createElement(Probe)))
    expect(renders).toBe(1)
    // new object, same n → equal → no re-render
    act(() => set({ agents: [{ id: 'a', n: 1 }] } as unknown as AppState))
    expect(renders).toBe(1)
    // n changed → re-render
    act(() => set({ agents: [{ id: 'a', n: 2 }] } as unknown as AppState))
    expect(renders).toBe(2)
  })
})

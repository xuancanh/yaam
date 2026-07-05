// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest'
import { createElement } from 'react'
import { render, act } from '@testing-library/react'
import { useAppStore } from '../core/store'
import { useConductorSelector } from './hooks'
import type { AppState } from '../core/types'

const setState = (s: Partial<AppState>) => useAppStore.setState(s as AppState, true)

describe('useConductorSelector (Zustand-backed)', () => {
  beforeEach(() => { setState({ toast: 'a', composer: 'x' } as unknown as AppState) })

  it('re-renders only when the selected slice changes', () => {
    let renders = 0
    let seen: string | null = null
    function Probe() {
      renders++
      seen = useConductorSelector((s: AppState) => s.toast)
      return createElement('span', null, seen)
    }
    render(createElement(Probe))
    expect(renders).toBe(1)
    expect(seen).toBe('a')

    // unrelated slice changes → selected value identical → no re-render
    act(() => setState({ toast: 'a', composer: 'y' } as unknown as AppState))
    expect(renders).toBe(1)

    // selected slice changes → re-render with the new value
    act(() => setState({ toast: 'b', composer: 'y' } as unknown as AppState))
    expect(renders).toBe(2)
    expect(seen).toBe('b')
  })

  it('supports a custom equality function for object slices', () => {
    setState({ agents: [{ id: 'a', n: 1 }] } as unknown as AppState)
    const eq = (a: { n: number }, b: { n: number }) => a.n === b.n
    let renders = 0
    function Probe() {
      renders++
      useConductorSelector((s: AppState) => ({ n: (s as unknown as { agents: { n: number }[] }).agents[0].n }), eq)
      return null
    }
    render(createElement(Probe))
    expect(renders).toBe(1)
    // new object, same n → equal → no re-render
    act(() => setState({ agents: [{ id: 'a', n: 1 }] } as unknown as AppState))
    expect(renders).toBe(1)
    // n changed → re-render
    act(() => setState({ agents: [{ id: 'a', n: 2 }] } as unknown as AppState))
    expect(renders).toBe(2)
  })
})

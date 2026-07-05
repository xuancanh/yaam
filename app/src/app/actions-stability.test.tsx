// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { createElement, useRef } from 'react'
import { render, act } from '@testing-library/react'
import { useAppStore } from '../core/store'
import { useSettingsActions } from '../domains/settings/actions'
import type { AppState } from '../core/types'

// A stable ctx (defined once) is what the provider passes via useMemo. This
// proves a domain action slice keeps a stable identity across a state-driven
// re-render — i.e. terminal output / chat streaming won't replace the action
// surface and re-render action consumers.
const CTX = {
  dispatch: useAppStore.setState as unknown as (f: (s: AppState) => AppState) => void,
  later: () => {},
  connectMcp: async () => '',
  refreshSkillCatalog: async () => '',
  mcpSessions: { current: new Map() },
  skillCatalogs: { current: new Map() },
}

describe('domain action slice stability', () => {
  it('does not change identity when unrelated state updates', () => {
    const seen: unknown[] = []
    let renders = 0
    function Probe() {
      renders++
      useAppStore(s => s.toast) // subscribe so a state change re-renders us
      const actions = useSettingsActions(CTX)
      const first = useRef(actions)
      seen.push(actions === first.current ? 'stable' : 'CHANGED')
      return null
    }
    render(createElement(Probe))
    // simulate terminal output / any state change
    act(() => useAppStore.setState({ toast: 'x' } as Partial<AppState> as AppState))
    act(() => useAppStore.setState({ toast: 'y' } as Partial<AppState> as AppState))
    expect(renders).toBeGreaterThan(1)          // the state changes did re-render Probe
    expect(seen.every(x => x === 'stable')).toBe(true) // …but the action slice never changed identity
  })
})

// React bindings against the host stub (jsdom + real postMessage).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { createYaamClient } from '../src/bridge'
import type { YaamClient } from '../src/bridge'
import { createHostStub } from '../src/testing'
import type { HostStub } from '../src/testing'
import { YaamProvider, useStorage, useYaamState } from '../src/react'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

let stub: HostStub
let client: YaamClient
let container: HTMLDivElement
let root: Root

beforeEach(() => {
  stub = createHostStub()
  client = createYaamClient({ target: window, onError: () => {} })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  container.remove()
  stub.dispose()
  client.dispose()
})

// several turns: each RPC is two queued postMessage hops plus a state update
const flush = () => act(async () => {
  for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0))
})

function TaskCount() {
  const count = useYaamState(s => s?.tasks.length ?? -1)
  return <span id="count">{count}</span>
}

function StoredName() {
  const cell = useStorage<string>('name', 'default')
  return (
    <button id="stored" onClick={() => cell.set('clicked')}>
      {cell.loading ? 'loading' : cell.value}
    </button>
  )
}

describe('react bindings', () => {
  it('useYaamState re-renders on state pushes', async () => {
    await act(async () => {
      root.render(<YaamProvider client={client}><TaskCount /></YaamProvider>)
    })
    await flush()
    expect(container.querySelector('#count')?.textContent).toBe('3')
    stub.state.tasks.push({ ...stub.state.tasks[0], id: 'tX', title: 'extra' })
    await act(async () => { stub.pushState() })
    await flush()
    expect(container.querySelector('#count')?.textContent).toBe('4')
  })

  it('useStorage loads the persisted value and writes through', async () => {
    stub.storage.set('name', 'persisted')
    await act(async () => {
      root.render(<YaamProvider client={client}><StoredName /></YaamProvider>)
    })
    await flush()
    const btn = container.querySelector<HTMLButtonElement>('#stored')
    expect(btn?.textContent).toBe('persisted')
    await act(async () => { btn?.click() })
    await flush()
    expect(btn?.textContent).toBe('clicked')
    expect(stub.storage.get('name')).toBe('clicked')
  })

  it('useStorage falls back to the initial value when unset', async () => {
    await act(async () => {
      root.render(<YaamProvider client={client}><StoredName /></YaamProvider>)
    })
    await flush()
    expect(container.querySelector('#stored')?.textContent).toBe('default')
  })
})

// React bindings for addon views. Wrap the app in <YaamProvider> and read the
// host through hooks; state pushes arrive ~3s apart, so re-rendering on every
// push is cheap by design.
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createYaamClient } from './bridge'
import type { YaamClient } from './bridge'
import type { AddonSnapshot, YaamApi } from './types'

const YaamContext = createContext<YaamClient | null>(null)

/** Provide the host bridge to the view. Pass `client` to inject a testing
 *  stub-bound client; otherwise one is created (and disposed on unmount). */
export function YaamProvider({ client, children }: { client?: YaamClient; children: ReactNode }) {
  const owned = useRef<YaamClient | null>(null)
  const value = useMemo(() => client ?? (owned.current ??= createYaamClient()), [client])
  useEffect(() => () => { owned.current?.dispose(); owned.current = null }, [])
  return <YaamContext.Provider value={value}>{children}</YaamContext.Provider>
}

/** The bridge client (api / call / onState / guard). */
export function useYaam(): YaamClient {
  const c = useContext(YaamContext)
  if (!c) throw new Error('useYaam requires a <YaamProvider> ancestor')
  return c
}

/** The typed RPC tree: `useYaamApi().tasks.add('title')`. */
export function useYaamApi(): YaamApi {
  return useYaam().api
}

/** Subscribe to host state pushes. Null until the first push arrives (or when
 *  state:read is not granted). The optional selector runs per render — derive,
 *  don't allocate-and-memoize. */
export function useYaamState(): AddonSnapshot | null
export function useYaamState<T>(selector: (s: AddonSnapshot | null) => T): T
export function useYaamState<T>(selector?: (s: AddonSnapshot | null) => T): T | AddonSnapshot | null {
  const client = useYaam()
  const [state, setState] = useState<AddonSnapshot | null>(() => client.state())
  useEffect(() => client.onState(s => { setState(s) }), [client])
  return selector ? selector(state) : state
}

/** Whether the host denied the state push (state:read not granted). */
export function useStateDenied(): boolean {
  const client = useYaam()
  const [denied, setDenied] = useState(false)
  useEffect(() => client.onState((_s, d) => { setDenied(d === 'state:read') }), [client])
  return denied
}

export interface StorageCell<T> {
  value: T
  /** optimistic local update + persisted storage.set (errors reported via guard) */
  set: (next: T | ((prev: T) => T)) => void
  /** true until the initial storage.get resolves */
  loading: boolean
}

/** A persisted per-addon storage key as local state. Values must stay within
 *  the host's storage caps (256 KB per key, 1 MB per addon). */
export function useStorage<T>(key: string, initial: T): StorageCell<T> {
  const client = useYaam()
  const [value, setValue] = useState<T>(initial)
  const [loading, setLoading] = useState(true)
  const initialRef = useRef(initial)

  useEffect(() => {
    let alive = true
    setLoading(true)
    client.api.storage.get(key).then(v => {
      if (!alive) return
      if (v !== undefined && v !== null) setValue(v as T)
      else setValue(initialRef.current)
      setLoading(false)
    }).catch(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [client, key])

  const set = (next: T | ((prev: T) => T)) => {
    setValue(prev => {
      const v = typeof next === 'function' ? (next as (p: T) => T)(prev) : next
      void client.guard(client.api.storage.set(key, v))
      return v
    })
  }

  return { value, set, loading }
}

// Re-claim signal for views that tell the desktop what they show. Terminal
// focus and flow watches are sent once on mount, and the desktop drops them
// after a phone goes quiet (~15s), so a locked phone came back to a blank
// terminal or a flow spinner forever. MobileApp fires this after a gap or on a
// fresh stream; views listen and send their claim again.
import { useEffect, useRef } from 'react'

export const RECLAIM_EVENT = 'yaam-reclaim'
export const RECLAIM_AFTER_MS = 10_000

export function useReclaim(claim: () => void): void {
  const ref = useRef(claim)
  ref.current = claim
  useEffect(() => {
    const on = () => ref.current()
    window.addEventListener(RECLAIM_EVENT, on)
    return () => window.removeEventListener(RECLAIM_EVENT, on)
  }, [])
}

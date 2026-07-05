// Headless driver for the phone remote: while Settings → Phone remote is on,
// runs the Rust LAN server, publishes debounced fleet snapshots, and drains the
// decision queue — applying approvals through the SAME conductor actions the
// desktop buttons use, so the remote can never do anything the UI can't.
import { useEffect } from 'react'
import { dispatch, useAppStore } from '../../core/store'
import { useActions, useConductorSelector } from '../../store'
import { remotePublish, remoteStart, remoteStop, remoteTakeDecisions } from '../../core/native'
import { buildRemoteSnapshot } from './snapshot'

const PUBLISH_DEBOUNCE_MS = 1000
const DECISION_POLL_MS = 2000

export function RemoteCompanion() {
  const enabled = useConductorSelector(s => s.settings.remoteEnabled === true)
  const { resolveToolApproval, approveChatTool } = useActions()

  useEffect(() => {
    if (!enabled) {
      dispatch(s => (s.remoteInfo ? { ...s, remoteInfo: null } : s))
      void remoteStop()
      return
    }
    let dead = false
    let debounce: ReturnType<typeof setTimeout> | null = null

    const publish = () => {
      if (dead) return
      void remotePublish(JSON.stringify(buildRemoteSnapshot(useAppStore.getState())))
    }

    void remoteStart()
      .then(info => {
        if (dead) return
        dispatch(s => ({ ...s, remoteInfo: info }))
        publish()
      })
      .catch(e => {
        console.error('[yaam] remote companion failed to start:', e)
        dispatch(s => ({ ...s, toast: `Phone remote failed: ${e instanceof Error ? e.message : String(e)}` }))
      })

    const unsub = useAppStore.subscribe(() => {
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(publish, PUBLISH_DEBOUNCE_MS)
    })

    const poll = setInterval(() => {
      void remoteTakeDecisions().then(ds => {
        if (dead) return
        for (const d of ds) {
          if (d.kind === 'chat') approveChatTool(d.agent_id, d.id, d.ok)
          else if (d.kind === 'master') resolveToolApproval(d.id, d.ok)
        }
      }).catch(() => {})
    }, DECISION_POLL_MS)

    return () => {
      dead = true
      if (debounce) clearTimeout(debounce)
      unsub()
      clearInterval(poll)
      void remoteStop()
      dispatch(s => (s.remoteInfo ? { ...s, remoteInfo: null } : s))
    }
  }, [enabled, resolveToolApproval, approveChatTool])

  return null
}

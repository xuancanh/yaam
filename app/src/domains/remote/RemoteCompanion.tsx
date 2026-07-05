// Headless driver for the phone remote: while Settings → Phone remote is on,
// runs the Rust axum server, publishes debounced fleet snapshots, drains the
// command queue, and surfaces pairing requests as explicit approval dialogs.
// Every command is applied through the SAME conductor actions the desktop
// buttons use, so a paired phone can never do anything the UI can't.
import { useEffect, useRef } from 'react'
import { dispatch, useAppStore } from '../../core/store'
import { useActions, useConductorSelector } from '../../store'
import {
  remoteApprovePair, remoteDenyPair, remotePendingPairs, remotePublish,
  remoteSetDevices, remoteStart, remoteStop, remoteTakeCommands,
} from '../../core/native'
import type { RemoteCommand } from '../../core/native'
import { serializeScreen, terminalSize } from '../../core/terminals'
import { confirmAction } from '../../components/Confirm'
import { buildRemoteSnapshot } from './snapshot'

// short debounce: chat deltas land in the store per animation frame, and the
// SSE stream pushes every publish — this is the streaming granularity remotes see
const PUBLISH_DEBOUNCE_MS = 300
const POLL_MS = 2000

/** One session's terminal, serialized with colors/layout for the mobile xterm. */
function termFor(id: string): { data: string; cols: number } {
  return { data: serializeScreen(id), cols: terminalSize(id)?.cols ?? 80 }
}

export function RemoteCompanion() {
  const enabled = useConductorSelector(s => s.settings.remoteEnabled === true)
  const devices = useConductorSelector(s => s.settings.remoteDevices)
  /** user edited/regenerated the token in Settings → restart the server on it */
  const tokenKey = useConductorSelector(s => (s.settings.remoteTokenRotate ? 'rotate' : s.settings.remoteToken ?? ''))
  const actions = useActions()
  const actionsRef = useRef(actions)
  actionsRef.current = actions
  /** pairing requests already showing a dialog — never double-prompt */
  const prompted = useRef(new Set<string>())

  // keep the server's device set in sync with the persisted copy (revokes too)
  useEffect(() => {
    if (enabled) void remoteSetDevices(devices ?? [])
  }, [enabled, devices])

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
      void remotePublish(JSON.stringify(buildRemoteSnapshot(useAppStore.getState(), termFor)))
    }

    // stable connect links: reuse the persisted token unless auto-rotate is on
    const st = useAppStore.getState().settings
    const persisted = st.remoteTokenRotate ? undefined : st.remoteToken
    void remoteStart(undefined, persisted)
      .then(info => {
        if (dead) return
        dispatch(s => ({ ...s, remoteInfo: info }))
        const cur = useAppStore.getState().settings
        if (cur.remoteToken !== info.token) actionsRef.current.updateSettings({ remoteToken: info.token })
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

    const applyCommand = (c: RemoteCommand) => {
      const a = actionsRef.current
      switch (c.kind) {
        case 'chat_send': return a.sendChatMessage(c.id, c.text)
        case 'task_chat': return a.sendTaskChat(c.id, c.text)
        case 'task_start': return a.startTask(c.id)
        case 'session_input': return a.sendInput(c.id, c.text)
        case 'session_stop': return a.stopSession(c.id)
        case 'session_resume': return a.resume(c.id)
        case 'approve_master': return a.resolveToolApproval(c.id, c.ok)
        case 'approve_chat': return a.approveChatTool(c.agent_id, c.id, c.ok)
        default: console.warn('[yaam] unknown remote command:', c.kind)
      }
    }

    const promptPair = (req: { id: string; name: string }) => {
      if (prompted.current.has(req.id)) return
      prompted.current.add(req.id)
      void confirmAction({
        title: `Pair “${req.name || 'unknown device'}”?`,
        detail: 'This device asked to connect to the phone remote. Once paired it can watch your fleet and send chat, task, and session commands until you revoke it in Settings.',
        confirmLabel: 'Pair device',
        danger: false,
      }).then(async ok => {
        prompted.current.delete(req.id)
        try {
          if (ok) {
            const dev = await remoteApprovePair(req.id)
            const cur = useAppStore.getState().settings.remoteDevices ?? []
            actionsRef.current.updateSettings({ remoteDevices: cur.filter(d => d.id !== dev.id).concat([dev]) })
            dispatch(s => ({ ...s, toast: `Paired ${dev.name || 'device'}` }))
          } else {
            await remoteDenyPair(req.id)
          }
        } catch (e) {
          console.error('[yaam] pairing failed:', e)
        }
      })
    }

    const poll = setInterval(() => {
      void remoteTakeCommands().then(cs => {
        if (dead) return
        for (const c of cs) applyCommand(c)
        // republish right away so the phone sees its own action reflected on
        // the next poll instead of one debounce later
        if (cs.length) setTimeout(publish, 120)
      }).catch(() => {})
      void remotePendingPairs().then(reqs => {
        if (dead) return
        for (const r of reqs) promptPair(r)
      }).catch(() => {})
    }, POLL_MS)

    return () => {
      dead = true
      if (debounce) clearTimeout(debounce)
      unsub()
      clearInterval(poll)
      void remoteStop()
      dispatch(s => (s.remoteInfo ? { ...s, remoteInfo: null } : s))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, tokenKey])

  return null
}

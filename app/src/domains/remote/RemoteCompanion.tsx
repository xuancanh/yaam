// Headless driver for the phone remote: while Settings → Phone remote is on,
// runs the Rust axum server, publishes debounced fleet snapshots, drains the
// command queue, and surfaces pairing requests as explicit approval dialogs.
// Every command is applied through the SAME conductor actions the desktop
// buttons use, so a paired phone can never do anything the UI can't.
import { useEffect, useRef } from 'react'
import { dispatch, useAppStore } from '../../core/store'
import { useActions, useConductorSelector } from '../../store'
import {
  gitFileDiffSide, gitStatus, listDir, readTextFile,
  remoteApprovePair, remoteDenyPair, remotePendingPairs, remotePublish, remoteRespond,
  remoteSetDevices, remoteStart, remoteStop, remoteTakeCommands,
} from '../../core/native'
import type { RemoteCommand } from '../../core/native'
import { serializeScreen, terminalSize } from '../../core/terminals'
import { confirmAction } from '../../components/Confirm'
import { buildRemoteSnapshot } from './snapshot'

// short debounce: chat deltas land in the store per animation frame, and the
// SSE stream pushes every publish — this is the streaming granularity remotes see
const PUBLISH_DEBOUNCE_MS = 300
const POLL_MS = 800 // command/pairing drain — rpc browsing rides this loop

/** Client-side token mint (same alphabet the server uses). */
function mintToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(24)), b => (b % 36).toString(36)).join('')
}

/** One session's terminal, serialized with colors/layout for the mobile xterm. */
function termFor(id: string): { data: string; cols: number } {
  return { data: serializeScreen(id), cols: terminalSize(id)?.cols ?? 80 }
}

/** Paths a paired phone may browse: anything under a live session's working
 *  folder (incl. worktree mirrors) — the same scope the mobile UI offers. */
function pathAllowed(path: string): boolean {
  if (!path.startsWith('/')) return false
  const roots = useAppStore.getState().agents
    .filter(a => !a.archived)
    .flatMap(a => [a.cwd, a.worktree?.workdir, a.worktree?.root])
    .filter((p): p is string => !!p)
  return roots.some(r => path === r || path.startsWith(`${r.replace(/\/+$/, '')}/`))
}

const RPC_READ_CAP = 200_000

/** fs/git browsing computed on the desktop with its normal native adapters;
 *  the answer lands in the server's response store for the phone to pick up. */
async function answerRpc(kind: string, requestId: string, payload: string): Promise<void> {
  const respond = (v: unknown) => remoteRespond(requestId, JSON.stringify(v))
  try {
    switch (kind) {
      case 'rpc_fs_list': {
        if (!pathAllowed(payload)) return await respond({ error: 'path outside session folders' })
        const entries = await listDir(payload)
        return await respond({ entries: entries.map(e => ({ name: e.name, path: e.path, isDir: e.isDir })) })
      }
      case 'rpc_fs_read': {
        if (!pathAllowed(payload)) return await respond({ error: 'path outside session folders' })
        const text = await readTextFile(payload)
        return await respond({ text: text.length > RPC_READ_CAP ? `${text.slice(0, RPC_READ_CAP)}\n… (truncated)` : text })
      }
      case 'rpc_git_status': {
        if (!pathAllowed(payload)) return await respond({ error: 'path outside session folders' })
        const st = await gitStatus(payload)
        return await respond({ root: st.root, branch: st.branch, files: st.files.map(f => ({ path: f.path, status: f.status, index: f.index, work: f.work })) })
      }
      case 'rpc_git_diff': {
        const req = JSON.parse(payload) as { root: string; path: string; staged: boolean }
        // a repo root may sit ABOVE the session cwd — accept ancestors of
        // allowed folders too (the root came from our own rpc_git_status)
        const roots = useAppStore.getState().agents
          .filter(a => !a.archived)
          .flatMap(a => [a.cwd, a.worktree?.workdir, a.worktree?.root])
          .filter((p): p is string => !!p)
        const base = req.root.replace(/\/+$/, '')
        const ok = base.startsWith('/') && roots.some(r => r === base || r.startsWith(`${base}/`) || base.startsWith(`${r.replace(/\/+$/, '')}/`))
        if (!ok) return await respond({ error: 'path outside session folders' })
        return await respond({ diff: await gitFileDiffSide(req.root, req.path, req.staged) })
      }
      default:
        return await respond({ error: `unknown rpc ${kind}` })
    }
  } catch (e) {
    await respond({ error: e instanceof Error ? e.message : String(e) }).catch(() => {})
  }
}

export function RemoteCompanion() {
  const enabled = useConductorSelector(s => s.settings.remoteEnabled === true)
  const devices = useConductorSelector(s => s.settings.remoteDevices)
  /** user edited/regenerated the token in Settings → restart the server on it */
  const tokenKey = useConductorSelector(s => s.settings.remoteToken ?? '')
  const rotate = useConductorSelector(s => s.settings.remoteTokenRotate === true)
  const actions = useActions()
  const actionsRef = useRef(actions)
  actionsRef.current = actions
  /** pairing requests already showing a dialog — never double-prompt */
  const prompted = useRef(new Set<string>())

  // keep the server's device set in sync with the persisted copy (revokes too)
  useEffect(() => {
    if (enabled) void remoteSetDevices(devices ?? [])
  }, [enabled, devices])

  // auto-rotation: mint a fresh token once the user-chosen period elapses.
  // Updating the setting restarts the server on the new token; paired devices
  // keep working (their tokens are independent), only links must be re-copied.
  useEffect(() => {
    if (!enabled || !rotate) return
    const check = () => {
      const st = useAppStore.getState().settings
      const periodMs = Math.max(0.1, st.remoteTokenRotateHours ?? 24) * 3_600_000
      if (Date.now() - (st.remoteTokenAt ?? 0) >= periodMs) {
        actionsRef.current.updateSettings({ remoteToken: mintToken(), remoteTokenAt: Date.now() })
      }
    }
    check()
    const iv = setInterval(check, 60_000)
    return () => clearInterval(iv)
  }, [enabled, rotate])

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

    // stable connect links: always run on the persisted token (minted once,
    // rotated only by the user or the auto-rotation timer above)
    void remoteStart(undefined, useAppStore.getState().settings.remoteToken)
      .then(info => {
        if (dead) return
        dispatch(s => ({ ...s, remoteInfo: info }))
        const cur = useAppStore.getState().settings
        if (cur.remoteToken !== info.token) {
          actionsRef.current.updateSettings({ remoteToken: info.token, remoteTokenAt: Date.now() })
        }
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
      if (c.kind.startsWith('rpc_')) { void answerRpc(c.kind, c.id, c.text); return }
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

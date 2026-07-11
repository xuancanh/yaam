// Headless driver for the phone remote: while Settings → Phone remote is on,
// runs the Rust axum server, publishes debounced fleet snapshots, drains the
// command queue, and surfaces pairing requests as explicit approval dialogs.
// Every command is applied through the SAME conductor actions the desktop
// buttons use, so a paired phone can never do anything the UI can't.
import { useEffect, useRef } from 'react'
import { dispatch, useAppStore } from '../../core/store'
import { useActions, useConductorSelector } from '../../store'
import {
  gitFileDiffSide, gitStatus, listDir, readFileB64, readTextFile,
  remoteActive, remoteApprovePair, remoteDenyPair, remotePendingPairs, remotePublish,
  remoteRespond, remoteSetDevices, remoteStart, remoteStop, remoteTakeCommands, writeSession,
} from '../../core/native'
import type { RemoteCommand } from '../../core/native'
import { fitTerminal, remoteResize, serializeScreen, terminalSize } from '../../core/terminals'
import { confirmAction } from '../../components/Confirm'
import { b64ToBytes, extractFileText } from '../../shared/filetext'
import { buildRemoteSnapshot } from './snapshot'
import { authorizedRemoteRoot, remoteCommandAllowed, remoteFileRoots } from './authorization'

// short debounce: chat deltas land in the store per animation frame, and the
// SSE stream pushes every publish — this is the streaming granularity remotes see
const PUBLISH_DEBOUNCE_MS = 300
const POLL_MS = 800 // command/pairing drain — rpc browsing rides this loop

const REMOTE_KEY_BYTES: Record<string, string> = {
  enter: '\r',
  esc: '\x1b',
  tab: '\t',
  'shift+tab': '\x1b[Z', // CSI Z — back-tab / reverse-tab
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
}

/** Client-side token mint (same alphabet the server uses). */
function mintToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(24)), b => (b % 36).toString(36)).join('')
}

/** One session's terminal, serialized with colors/layout for the mobile xterm. */
function termFor(id: string): { data: string; cols: number } {
  return { data: serializeScreen(id), cols: terminalSize(id)?.cols ?? 80 }
}

const RPC_READ_CAP = 200_000
const approvedGitRoots = new Set<string>()

/** fs/git browsing computed on the desktop with its normal native adapters;
 *  the answer lands in the server's response store for the phone to pick up. */
async function answerRpc(kind: string, requestId: string, payload: string): Promise<void> {
  const respond = (v: unknown) => remoteRespond(requestId, JSON.stringify(v))
  try {
    switch (kind) {
      case 'rpc_fs_list': {
        const root = authorizedRemoteRoot(useAppStore.getState(), payload)
        if (!root) return await respond({ error: 'path outside active session folders' })
        const entries = await listDir(payload, root)
        return await respond({ entries: entries.map(e => ({ name: e.name, path: e.path, isDir: e.isDir })) })
      }
      case 'rpc_fs_read': {
        const root = authorizedRemoteRoot(useAppStore.getState(), payload)
        if (!root) return await respond({ error: 'path outside active session folders' })
        const name = payload.slice(payload.lastIndexOf('/') + 1)
        // office docs: extract readable text desktop-side (same as the chat pipeline)
        if (/\.(docx|xlsx|pptx)$/i.test(name)) {
          const extracted = await extractFileText(name, b64ToBytes(await readFileB64(payload, root)))
          return await respond({ text: extracted.text ?? '(no text extracted)', kind: 'office' })
        }
        const text = await readTextFile(payload, root)
        return await respond({ text: text.length > RPC_READ_CAP ? `${text.slice(0, RPC_READ_CAP)}\n… (truncated)` : text })
      }
      case 'rpc_fs_b64': {
        // binary payloads for the rich viewer (images, PDFs) — size-capped
        const root = authorizedRemoteRoot(useAppStore.getState(), payload)
        if (!root) return await respond({ error: 'path outside active session folders' })
        const b64 = await readFileB64(payload, root)
        if (b64.length > 8_000_000) return await respond({ error: 'file too large to preview remotely' })
        return await respond({ b64 })
      }
      case 'rpc_git_status': {
        const root = authorizedRemoteRoot(useAppStore.getState(), payload)
        if (!root) return await respond({ error: 'path outside active session folders' })
        await listDir(payload, root) // canonical/symlink-safe authorization
        const st = await gitStatus(payload)
        if (approvedGitRoots.size >= 100) approvedGitRoots.clear()
        approvedGitRoots.add(st.root.replace(/\/+$/, ''))
        return await respond({ root: st.root, branch: st.branch, files: st.files.map(f => ({ path: f.path, status: f.status, index: f.index, work: f.work })) })
      }
      case 'rpc_git_diff': {
        const req = JSON.parse(payload) as { root: string; path: string; staged: boolean }
        // a repo root may sit ABOVE the session cwd — accept ancestors of
        // allowed folders too (the root came from our own rpc_git_status)
        const roots = remoteFileRoots(useAppStore.getState())
        const base = req.root.replace(/\/+$/, '')
        const active = roots.some(r => r === base || r.startsWith(`${base}/`) || base.startsWith(`${r}/`))
        if (!approvedGitRoots.has(base) || !active) return await respond({ error: 'git root was not authorized by status' })
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

    let wasActive = false
    const publish = () => {
      if (dead) return
      // snapshots serialize every session's terminal — skip all of it while
      // no phone is connected, or the desktop pays that tax on every store
      // change for nobody (felt as typing lag in busy terminals)
      void remoteActive().then(active => {
        if (dead) return
        wasActive = active
        if (!active) return
        void remotePublish(JSON.stringify(buildRemoteSnapshot(useAppStore.getState(), termFor)))
      }).catch(() => {})
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
        // re-hydrate paired devices after EVERY (re)start — a phone that
        // reaches the fresh server before hydration would read as unpaired
        // and get bounced back to the pairing screen
        void remoteSetDevices(cur.remoteDevices ?? [])
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
      if (!remoteCommandAllowed(useAppStore.getState(), c)) {
        console.warn('[yaam] rejected out-of-scope remote command:', c.kind)
        return
      }
      if (c.kind.startsWith('rpc_')) { void answerRpc(c.kind, c.id, c.text); return }
      const a = actionsRef.current
      switch (c.kind) {
        case 'master_send': return a.sendMessage(c.text)
        // the desktop and the phone share ONE active workspace — switching
        // from the phone switches the desktop too (by design, like the tabs)
        case 'workspace_switch': return a.switchWorkspace(c.id)
        case 'chat_send': return a.sendChatMessage(c.id, c.text)
        // start a fresh conversation with a durable agent (c.id = agent id);
        // the phone spots the new chat in the next snapshot and opens it
        case 'chat_new': return void a.newChatSession(undefined, undefined, undefined, undefined, undefined, c.id || undefined)
        case 'task_chat': return a.sendTaskChat(c.id, c.text)
        case 'task_start': return a.startTask(c.id)
        case 'session_input': return a.sendInput(c.id, c.text)
        case 'session_key': {
          const seq = REMOTE_KEY_BYTES[c.text]
          if (seq) void writeSession(c.id, seq).catch(() => {})
          return
        }
        case 'prompt_answer': return a.answerPrompt(c.id, Number(c.text))
        case 'prompt_approve': return a.approve(c.id)
        case 'prompt_deny': return a.deny(c.id)
        // exclusive terminal focus: the focused device owns the PTY size
        case 'session_focus': {
          try {
            const d = JSON.parse(c.text || '{}') as { rows?: number; cols?: number }
            if (d.rows && d.cols) remoteResize(c.id, d.rows, d.cols)
          } catch { /* malformed dims */ }
          return
        }
        case 'session_blur': return fitTerminal(c.id) // desktop reclaims its size
        case 'session_stop': return a.stopSession(c.id)
        case 'session_resume': return a.resume(c.id)
        case 'approve_master': return a.resolveToolApproval(c.id, c.ok)
        case 'approve_chat': return a.approveChatTool(c.agent_id, c.id, c.ok)
        // quick-reply chip tapped on the phone (agent_id = chat, id = message)
        case 'chat_reply': return a.sendQuickReply(c.agent_id, c.id, c.text)
        case 'chat_rate': return a.rateChatReply(c.agent_id, c.id, c.ok ? 'up' : 'down', c.text || undefined)
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
      // a phone (re)connected while publishing was idle — hand it a fresh
      // snapshot now instead of waiting for the next store change
      void remoteActive().then(active => {
        if (dead) return
        if (!active) {
          wasActive = false
        } else if (!wasActive) {
          publish()
        }
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

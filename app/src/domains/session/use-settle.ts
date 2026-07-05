// Session settle/prompt watcher: owns the per-session timers and dedup state
// (armed snapshots, quiet-period timers, last-flagged questions) and turns raw
// PTY activity into "needs input" / "finished responding" signals. Pulled out of
// the provider so the whole prompt-detection loop lives in the session domain;
// the provider passes in its state ref, the notifier, and the Master/monitor/
// watcher fan-out refs.
import { useCallback, useEffect, useRef } from 'react'
import type { MutableRefObject } from 'react'
import type { AppState, EscOption, NotifKind } from '../../core/types'
import type { LocatedTask } from '../board/task-state'
import { isAltScreen, readScreen } from '../../core/terminals'
import { hasCreds } from '../../master'
import { dispatch } from '../../core/store'
import {
  activeGroupOf, detectPrompt, extractOptions,
  QUESTION_LINE_RE, QUESTION_MARK_LINE_RE, TUI_PROMPT_RE,
} from '../../core/state-lib'

export interface SettleDeps {
  stateRef: MutableRefObject<AppState>
  later: (ms: number, fn: () => void) => void
  notify: (kind: NotifKind, title: string, detail: string, agentId: string | null) => void
  setNeedsInput: (id: string, question: string, options?: EscOption[], cursorNum?: number) => void
  runMonitor: (id: string, note: string) => void
  taskForSession: (id: string) => LocatedTask | undefined
  masterEventRef: MutableRefObject<(note: string, agentId?: string) => void>
  monitorEventRef: MutableRefObject<(id: string, note: string) => Promise<void> | void>
  runWatcherRef: MutableRefObject<(taskId: string, note: string) => void>
}

export interface SettleApi {
  /** mark a session as awaiting fresh output so the next settle means completion */
  armResponseWatch: (id: string) => void
  /** reset a session's quiet-period timer on raw PTY activity */
  bumpSettle: (id: string) => void
  /** drop a session's last-flagged question (user answered/handled it) */
  clearFlagged: (id: string) => void
  /** tear down all settle state + timer for a session */
  disposeSettle: (id: string) => void
}

export function useSessionSettle(deps: SettleDeps): SettleApi {
  const { stateRef, later, notify, setNeedsInput, runMonitor, taskForSession, masterEventRef, monitorEventRef, runWatcherRef } = deps

  // armed watch: snapshot of the screen/tail at arm time — we only relay once
  // the content has actually changed AND the TUI is no longer busy
  const armedRef = useRef<Map<string, { snapshot: string; at: number }>>(new Map())
  const settleRef = useRef<Map<string, { since: number; timer: number }>>(new Map())
  const lastFlaggedRef = useRef<Map<string, string>>(new Map())
  // set below; ref avoids a declaration cycle with onSettle
  const bumpSettleRef = useRef<(id: string) => void>(() => {})

  // Mark a session as awaiting fresh output so the next settle means completion.
  const armResponseWatch = useCallback((id: string) => {
    const alt = isAltScreen(id)
    const agent = stateRef.current.agents.find(a => a.id === id)
    const snapshot = alt
      ? readScreen(id).join('\n')
      : (agent?.log ?? []).slice(-14).map(l => l.x).join('\n')
    armedRef.current.set(id, { snapshot, at: Date.now() })
    // ensure a settle check runs even if the session produces no output at all
    later(4000, () => bumpSettleRef.current(id))
  }, [stateRef, later])

  // Inspect a stable rendered screen for prompts, completion, monitors, and watchers.
  const onSettle = useCallback((id: string, since: number) => {
    settleRef.current.delete(id)
    const agent = stateRef.current.agents.find(a => a.id === id)
    if (!agent || (agent.status !== 'running' && agent.status !== 'needs')) return
    const st = stateRef.current.settings
    const llm = Boolean(st.masterEnabled && hasCreds(st) && st.followMode)
    const alt = isAltScreen(id)
    const armed = armedRef.current.get(id)

    // TUIs redraw constantly, so judge the rendered screen (stable) instead
    // of the raw output stream; plain sessions use the new stream tail.
    const streamLines = agent.log.slice(since).map(l => l.x).filter(Boolean)
    const content = alt ? readScreen(id) : streamLines.slice(-14)
    if (!content.length) return
    const lastLine = content[content.length - 1] ?? ''
    // Never flag input, and never relay half-answers, while the TUI busy marker
    // is visible — any question-looking text on screen is transient then.
    const { busy, promptDetected, question } = detectPrompt(content, alt)

    if (promptDetected) {
      const already = agent.status === 'needs' && lastFlaggedRef.current.get(id) === question
      if (!already) {
        lastFlaggedRef.current.set(id, question)
        const { options, cursorNum } = extractOptions(content)
        setNeedsInput(id, question, options, cursorNum)
        if (llm) {
          masterEventRef.current(
            `[event] session "${agent.name}" (${id}) is showing a dialog (approval or selection menu) and has been flagged as needing input:\n` +
            `${content.slice(-14).join('\n')}\n\nTell the user what it is asking — include the options if it is a menu. Approve sends Enter (selects the highlighted option), Deny sends Escape; for other choices the user should click into the terminal.`,
            id,
          )
        }
        const taskFor = taskForSession(id)
        if (taskFor) {
          runWatcherRef.current(taskFor.task.id,
            `The task's session "${agent.name}" is waiting at this prompt:\n${content.slice(-14).join('\n')}\n\n` +
            'Unblock it from the task spec when safe; otherwise ask the user one focused question and update the card note.')
        }
      }
      return
    }

    // prompt gone (or the session is generating again) — it was answered
    if (agent.status === 'needs') {
      lastFlaggedRef.current.delete(id)
      dispatch(s => ({
        ...s,
        agents: s.agents.map(a => a.id === id ? { ...a, status: 'running' as const, escReason: undefined } : a),
      }))
    }

    if (armed) {
      const joined = content.join('\n')
      const expired = Date.now() - armed.at > 15 * 60 * 1000
      const unchanged = joined === armed.snapshot
      if ((busy || unchanged) && !expired) {
        settleRef.current.delete(id)
        const timer = window.setTimeout(() => onSettleRef.current(id, since), 3500)
        settleRef.current.set(id, { since, timer })
        return
      }
      armedRef.current.delete(id)
      if (!expired) {
        // deterministic indicator, independent of the LLM layer: if the user
        // isn't looking at this session, flash its tab and ring the bell
        const st2 = stateRef.current
        const g2 = activeGroupOf(st2)
        const watching = (g2 ? g2.slots[g2.activePane] : null) === id
          && (agent.workspaceId ?? st2.activeWorkspace) === st2.activeWorkspace
          && document.hasFocus()
        if (!watching) {
          dispatch(s2 => ({
            ...s2,
            agents: s2.agents.map(a => (a.id === id ? { ...a, attention: true } : a)),
          }))
          notify('done', `${agent.name} finished responding`, lastLine.slice(0, 90), id)
        }
        // task sessions are watched by their task's watcher (the mini master
        // assigns itself as monitor) — the generic session monitor skips them
        if (llm && !taskForSession(id)) {
          void runMonitor(id,
            `The session finished responding. ${alt ? 'Current screen' : 'New output since last check'}:\n${content.slice(-14).join('\n')}\n\n` +
            'It was given a task by Master or the user, so a completed response IS noteworthy — update the status and report a digest to Master.')
        }
      }
    }

    // Task watchers own progress independently of the global follow-mode
    // monitor. Feed every stable output snapshot to the watcher, including
    // routine progress that the session monitor deliberately does not report.
    const taskFor = taskForSession(id)
    if (taskFor) {
      runWatcherRef.current(taskFor.task.id,
        `The task's session "${agent.name}" produced stable output. ${alt ? 'Current screen' : 'New output'}:\n` +
        `${content.slice(-14).join('\n')}\n\nTrack progress against the acceptance criteria, update the card note, and move the task only if the evidence supports it.`)
    }
  }, [stateRef, notify, runMonitor, setNeedsInput, taskForSession, masterEventRef, runWatcherRef])

  const onSettleRef = useRef<(id: string, since: number) => void>(() => {})
  onSettleRef.current = onSettle

  // (re)start the settle watcher — checks only run once output goes quiet.
  // Driven by RAW pty activity, because TUI redraws often contain no newlines.
  // Reset a session's quiet-period timer whenever raw PTY activity arrives.
  const bumpSettle = useCallback((id: string) => {
    const prev = settleRef.current.get(id)
    if (prev) window.clearTimeout(prev.timer)
    const since = prev?.since ?? Math.max(0, (stateRef.current.agents.find(a => a.id === id)?.log.length ?? 1) - 1)
    const timer = window.setTimeout(() => onSettle(id, since), 3000)
    settleRef.current.set(id, { since, timer })
  }, [stateRef, onSettle])
  bumpSettleRef.current = bumpSettle

  // Deterministic safety net for full-screen TUIs: scan the rendered screen of
  // every running alt-buffer session for approval dialogs / selection menus.
  // Settle timing doesn't matter here; dedupe prevents refiring on redraws.
  useEffect(() => {
    const timer = window.setInterval(() => {
      for (const a of stateRef.current.agents) {
        if (a.kind !== 'real') continue
        if (a.status !== 'running' && a.status !== 'needs') continue
        if (!isAltScreen(a.id)) continue
        const screen = readScreen(a.id)
        if (!screen.length) continue
        const joined = screen.join('\n')
        if (TUI_PROMPT_RE.test(joined)) {
          if (a.status !== 'running') continue
          const question = (
            screen.find(l => QUESTION_LINE_RE.test(l)) ||
            screen.find(l => QUESTION_MARK_LINE_RE.test(l.trim())) ||
            screen[screen.length - 1]
          ).trim()
          if (lastFlaggedRef.current.get(a.id) === question) continue
          lastFlaggedRef.current.set(a.id, question)
          const { options, cursorNum } = extractOptions(screen)
          setNeedsInput(a.id, question, options, cursorNum)
          void monitorEventRef.current(a.id,
            `A dialog was detected on the session's screen (already flagged as needing input):\n${screen.slice(-14).join('\n')}\n\n` +
            'This needs the user — report_to_master with what it is asking, including the options if it is a menu.')
        } else if (a.status === 'needs') {
          lastFlaggedRef.current.delete(a.id)
          dispatch(s2 => ({
            ...s2,
            agents: s2.agents.map(x => x.id === a.id ? { ...x, status: 'running' as const, escReason: undefined } : x),
          }))
        }
      }
    }, 4000)
    return () => window.clearInterval(timer)
  }, [stateRef, setNeedsInput, monitorEventRef])

  const clearFlagged = useCallback((id: string) => { lastFlaggedRef.current.delete(id) }, [])
  const disposeSettle = useCallback((id: string) => {
    const st = settleRef.current.get(id)
    if (st) window.clearTimeout(st.timer)
    settleRef.current.delete(id)
    armedRef.current.delete(id)
    lastFlaggedRef.current.delete(id)
  }, [])

  return { armResponseWatch, bumpSettle, clearFlagged, disposeSettle }
}

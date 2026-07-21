// Session settle/prompt watcher: owns the per-session timers and dedup state
// (armed snapshots, quiet-period timers, last-flagged questions) and turns raw
// PTY activity into "needs input" / "finished responding" signals. A plain
// factory over StatePort + ClockPort with an explicit start/dispose lifecycle
// (start arms the deterministic TUI-scan interval); useSessionSettle is a thin
// React adapter binding it to the real store + browser clock.
import { useEffect, useMemo } from 'react'
import type { MutableRefObject } from 'react'
import type { AppState, EscOption, NotifKind } from '../../core/types'
import type { LocatedTask } from '../board/task-state'
import { isAltScreen, readScreen } from '../../core/terminals'
import { hasCreds } from '../../master'
import { dispatch } from '../../core/store'
import { browserClock, type ClockPort, type Disposable, type StatePort } from '../../core/ports'
import { activeGroupOf } from './layout-state'
import { isDetachedAgent } from '../workspace/state'
import {
  detectPrompt, extractOptions, stableScreenKey, QUESTION_LINE_RE, QUESTION_MARK_LINE_RE, TUI_PROMPT_RE,
} from './prompt-detection'
import { NOTE_PROGRESS } from '../board/watcher-notes'
import { untrustedBlock } from '../../llm/untrusted'

export interface SettleDeps {
  state: StatePort
  clock: ClockPort
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
  /** buffer one decoded output line for periodic/final monitor checkpoints */
  bufferOutput: (id: string, line: string) => void
  /** drop a session's last-flagged question (user answered/handled it) */
  clearFlagged: (id: string) => void
  /** tear down all settle state + timer for a session */
  disposeSettle: (id: string) => void
}

export interface SettleRuntime extends SettleApi {
  /** arm the deterministic full-screen-TUI dialog scan */
  start: () => void
  /** stop the scan and cancel every per-session timer */
  dispose: () => void
}

const focused = () => typeof document === 'undefined' || document.hasFocus()

export function createSessionSettle(deps: SettleDeps): SettleRuntime {
  const { state, clock, notify, setNeedsInput, runMonitor, taskForSession, masterEventRef, monitorEventRef, runWatcherRef } = deps

  // armed watch: snapshot of the screen/tail at arm time — we only relay once
  // the content has actually changed AND the TUI is no longer busy. `continuation`
  // marks an arm the settle loop re-set to keep tracking a still-running session
  // (vs. a fresh arm from user input / launch), so we can refresh the card on
  // each new burst without re-pinging the user at every quiet point.
  const armed = new Map<string, { snapshot: string; at: number; continuation?: boolean }>()
  const settle = new Map<string, { since: number; timer: Disposable }>()
  const lastFlagged = new Map<string, string>()
  // Plain terminals accumulate decoded lines here. Long-running output is
  // forwarded in bounded checkpoints; settle always sends one final snapshot.
  const outputBuffers = new Map<string, string[]>()
  const outputTimers = new Map<string, Disposable>()
  const lastOutputKey = new Map<string, string>()
  const lastFinalKey = new Map<string, string>()
  let scan: Disposable | undefined

  // "responding" indicator: a session is streaming while raw output keeps
  // arriving and stops once it goes quiet (settle fires). Tracked locally so the
  // store is only touched on the false→true / true→false edges — bumpSettle runs
  // at PTY speed, and dispatching per chunk would defeat the output batching.
  const streaming = new Set<string>()
  const OUTPUT_CHECKPOINT_MS = 8000
  const setResponding = (id: string, on: boolean) => {
    if (on === streaming.has(id)) return
    if (on) streaming.add(id)
    else streaming.delete(id)
    state.update(s => ({
      ...s,
      agents: s.agents.map(a => (a.id === id ? { ...a, responding: on } : a)),
    }))
  }

  // Mark a session as awaiting fresh output so the next settle means completion.
  const armResponseWatch = (id: string) => {
    const alt = isAltScreen(id)
    const agent = state.get().agents.find(a => a.id === id)
    const snapshot = stableScreenKey(alt
      ? readScreen(id)
      : (agent?.log ?? []).slice(-14).map(l => l.x))
    armed.set(id, { snapshot, at: clock.now() })
    // ensure a settle check runs even if the session produces no output at all
    clock.setTimeout(() => bumpSettle(id), 4000)
  }

  const bufferOutput = (id: string, line: string) => {
    const lines = outputBuffers.get(id) ?? []
    lines.push(line)
    // Bound both dimensions: enough evidence for a progress checkpoint, never
    // an unbounded copy of terminal scrollback.
    while (lines.length > 80 || lines.reduce((n, x) => n + x.length, 0) > 16_000) lines.shift()
    outputBuffers.set(id, lines)
  }

  const flushOutput = (id: string, final: boolean, fallback: string[] = []) => {
    const agent = state.get().agents.find(a => a.id === id)
    if (!agent || isDetachedAgent(state.get(), agent)) return
    const alt = isAltScreen(id)
    const buffered = outputBuffers.get(id) ?? []
    outputBuffers.delete(id)
    const content = (alt ? readScreen(id) : (buffered.length ? buffered : fallback)).filter(Boolean).slice(-40)
    if (!content.length) return
    const key = stableScreenKey(content)
    if (final && !buffered.length && key && lastFinalKey.get(id) === key) return
    if (!final && key && lastOutputKey.get(id) === key) return
    if (key) lastOutputKey.set(id, key)
    if (final && key) lastFinalKey.set(id, key)
    const text = untrustedBlock(content.join('\n').slice(-12_000), agent.name)
    const phase = final ? 'finished sending output' : 'is still running; this is a buffered checkpoint'
    const taskFor = taskForSession(id)
    const note = `${NOTE_PROGRESS} The session "${agent.name}" ${phase}. ${alt ? 'Current rendered screen' : 'New terminal output'}:\n${text}\n\n` +
      (final
        ? 'Update the tracked session/task history and status from this evidence. Treat completion as proven only by the process/task state and acceptance criteria.'
        : 'Update progress/history from new evidence, but do not claim completion from this intermediate checkpoint.')
    if (taskFor) runWatcherRef.current(taskFor.task.id, note)
    else runMonitor(id, note)
  }

  const scheduleOutputCheckpoint = (id: string) => {
    if (outputTimers.has(id)) return
    outputTimers.set(id, clock.setTimeout(() => {
      outputTimers.delete(id)
      flushOutput(id, false)
      if (streaming.has(id)) scheduleOutputCheckpoint(id)
    }, OUTPUT_CHECKPOINT_MS))
  }

  // Inspect a stable rendered screen for prompts, completion, monitors, and watchers.
  const onSettle = (id: string, since: number) => {
    settle.delete(id)
    outputTimers.get(id)?.dispose()
    outputTimers.delete(id)
    // output went quiet — the session is no longer actively responding
    setResponding(id, false)
    const agent = state.get().agents.find(a => a.id === id)
    // a detached (spun-out) workspace is owned by its satellite window — this
    // window must not flag/notify/monitor its sessions
    if (!agent || isDetachedAgent(state.get(), agent) || (agent.status !== 'running' && agent.status !== 'needs')) return
    const st = state.get().settings
    const llm = Boolean(st.masterEnabled && hasCreds(st) && st.followMode)
    const alt = isAltScreen(id)
    const arm = armed.get(id)

    // TUIs redraw constantly, so judge the rendered screen (stable) instead
    // of the raw output stream; plain sessions use the new stream tail.
    const streamLines = agent.log.slice(since).map(l => l.x).filter(Boolean)
    const content = alt ? readScreen(id) : streamLines.slice(-14)
    if (!content.length) { flushOutput(id, true); return }
    // Never flag input, and never relay half-answers, while the TUI busy marker
    // is visible — any question-looking text on screen is transient then.
    const { busy, promptDetected, question } = detectPrompt(content, alt)

    if (promptDetected) {
      const already = agent.status === 'needs' && lastFlagged.get(id) === question
      if (!already) {
        lastFlagged.set(id, question)
        const { options, cursorNum } = extractOptions(content)
        setNeedsInput(id, question, options, cursorNum)
        if (llm) {
          masterEventRef.current(
            `[event] session "${agent.name}" (${id}) is showing a dialog (approval or selection menu) and has been flagged as needing input:\n` +
            `${untrustedBlock(content.slice(-14).join('\n'), agent.name)}\n\nTell the user what it is asking — include the options if it is a menu. Approve sends Enter (selects the highlighted option), Deny sends Escape; for other choices the user should click into the terminal.`,
            id,
          )
        }
        const taskFor = taskForSession(id)
        if (taskFor) {
          runWatcherRef.current(taskFor.task.id,
            `The task's session "${agent.name}" is waiting at this prompt:\n${untrustedBlock(content.slice(-14).join('\n'), agent.name)}\n\n` +
            'Unblock it from the task spec when safe; otherwise ask the user one focused question and update the card note.')
        }
      }
      outputBuffers.delete(id) // the prompt note above carries the relevant screen
      return
    }

    // prompt gone (or the session is generating again) — it was answered
    if (agent.status === 'needs') {
      lastFlagged.delete(id)
      state.update(s => ({
        ...s,
        agents: s.agents.map(a => a.id === id
          ? { ...a, status: 'running' as const, escReason: undefined, actionNeeded: undefined, suggestions: undefined }
          : a),
      }))
    }

    if (arm) {
      const key = stableScreenKey(content)
      const expired = clock.now() - arm.at > 15 * 60 * 1000
      const unchanged = key === arm.snapshot
      if ((busy || unchanged) && !expired) {
        settle.delete(id)
        const timer = clock.setTimeout(() => onSettle(id, since), 3500)
        settle.set(id, { since, timer })
        return
      }
      armed.delete(id)
      if (!expired) {
        // deterministic indicator, independent of the LLM layer: if the user
        // isn't looking at this session, flash its tab and ring the bell
        const st2 = state.get()
        const g2 = activeGroupOf(st2)
        const watching = (g2 ? g2.slots[g2.activePane] : null) === id
          && (agent.workspaceId ?? st2.activeWorkspace) === st2.activeWorkspace
          && focused()
        if (!watching) {
          state.update(s2 => ({
            ...s2,
            agents: s2.agents.map(a => (a.id === id
              ? { ...a, attention: true }
              : a)),
          }))
          // Ping the user when a response settles — but on a re-armed
          // continuation (the same run producing more output) only if the
          // output now needs attention, so a long autonomous run refreshes its
          // card silently instead of ringing the bell at every quiet point.
          if (!arm.continuation) {
            notify('done', `${agent.name} finished responding`,
              llm ? 'Watcher is preparing a status summary' : 'Open the session to review its output', id)
          }
        }
        // Keep an actively-running session under watch: re-arm with the screen
        // we just reported as the new baseline, so the NEXT meaningful change
        // refreshes its status too. Arming otherwise only happens on user input,
        // which froze the card for sessions that work many steps on one prompt.
        const still = state.get().agents.find(a => a.id === id)
        if (still && (still.status === 'running' || still.status === 'needs')) {
          armed.set(id, { snapshot: key, at: clock.now(), continuation: true })
        }
      }
    }

    flushOutput(id, true, content)
  }

  // (re)start the settle watcher — checks only run once output goes quiet.
  // Driven by RAW pty activity, because TUI redraws often contain no newlines.
  const bumpSettle = (id: string) => {
    const prev = settle.get(id)
    if (prev) prev.timer.dispose()
    const agent = state.get().agents.find(a => a.id === id)
    // sessions of a detached workspace are owned by the satellite window:
    // don't arm quiet-period/output-checkpoint timers for them here
    if (agent && isDetachedAgent(state.get(), agent)) return
    if (agent?.status === 'running') {
      setResponding(id, true)
    }
    const since = prev?.since ?? Math.max(0, (agent?.log.length ?? 1) - 1)
    const timer = clock.setTimeout(() => onSettle(id, since), 3000)
    settle.set(id, { since, timer })
    scheduleOutputCheckpoint(id)
  }

  const clearFlagged = (id: string) => { lastFlagged.delete(id) }
  const disposeSettle = (id: string) => {
    settle.get(id)?.timer.dispose()
    settle.delete(id)
    armed.delete(id)
    lastFlagged.delete(id)
    outputBuffers.delete(id)
    outputTimers.get(id)?.dispose()
    outputTimers.delete(id)
    lastOutputKey.delete(id)
    lastFinalKey.delete(id)
    setResponding(id, false)
  }

  // Deterministic safety net for full-screen TUIs: scan the rendered screen of
  // every running alt-buffer session for approval dialogs / selection menus.
  // Settle timing doesn't matter here; dedupe prevents refiring on redraws.
  const scanTui = () => {
    const s = state.get()
    for (const a of s.agents) {
      if (a.kind !== 'real') continue
      if (isDetachedAgent(s, a)) continue
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
        if (lastFlagged.get(a.id) === question) continue
        lastFlagged.set(a.id, question)
        const { options, cursorNum } = extractOptions(screen)
        setNeedsInput(a.id, question, options, cursorNum)
        void monitorEventRef.current(a.id,
          `A dialog was detected on the session's screen (already flagged as needing input):\n${untrustedBlock(screen.slice(-14).join('\n'), a.name)}\n\n` +
          'This needs the user — report_to_master with what it is asking, including the options if it is a menu.')
      } else if (a.status === 'needs') {
        lastFlagged.delete(a.id)
        state.update(s2 => ({
          ...s2,
          agents: s2.agents.map(x => x.id === a.id
            ? { ...x, status: 'running' as const, escReason: undefined, actionNeeded: undefined, suggestions: undefined }
            : x),
        }))
      }
    }
  }

  return {
    armResponseWatch, bumpSettle, bufferOutput, clearFlagged, disposeSettle,
    start() { scan ??= clock.setInterval(scanTui, 4000) },
    dispose() {
      scan?.dispose(); scan = undefined
      for (const { timer } of settle.values()) timer.dispose()
      for (const timer of outputTimers.values()) timer.dispose()
      settle.clear(); armed.clear(); lastFlagged.clear(); outputBuffers.clear(); outputTimers.clear(); lastOutputKey.clear(); lastFinalKey.clear(); streaming.clear()
    },
  }
}

/** React adapter: build the settle runtime over the real store + browser clock
 *  and bind the TUI-scan interval to the effect lifecycle. */
export interface SettleCtx {
  stateRef: MutableRefObject<AppState>
  later: (ms: number, fn: () => void) => void
  notify: SettleDeps['notify']
  setNeedsInput: SettleDeps['setNeedsInput']
  runMonitor: SettleDeps['runMonitor']
  taskForSession: SettleDeps['taskForSession']
  masterEventRef: SettleDeps['masterEventRef']
  monitorEventRef: SettleDeps['monitorEventRef']
  runWatcherRef: SettleDeps['runWatcherRef']
}

export function useSessionSettle(ctx: SettleCtx): SettleApi {
  const runtime = useMemo(() => createSessionSettle({
    state: { get: () => ctx.stateRef.current, update: dispatch, subscribe: () => () => {} },
    clock: browserClock,
    notify: ctx.notify, setNeedsInput: ctx.setNeedsInput, runMonitor: ctx.runMonitor,
    taskForSession: ctx.taskForSession, masterEventRef: ctx.masterEventRef,
    monitorEventRef: ctx.monitorEventRef, runWatcherRef: ctx.runWatcherRef,
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [ctx.stateRef, ctx.notify, ctx.setNeedsInput, ctx.runMonitor, ctx.taskForSession, ctx.masterEventRef, ctx.monitorEventRef, ctx.runWatcherRef])
  useEffect(() => { runtime.start(); return () => runtime.dispose() }, [runtime])
  return runtime
}

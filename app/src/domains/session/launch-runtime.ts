// Session/task launch runtime: spawn a PTY session (optimistic state + terminal
// + backend spawn), resolve a template into a launch, the ONE canonical one-shot
// launch for a board task (active or background workspace), and the watcher-first
// / deterministic start paths. Plus CLI resume-id probing. Extracted from the
// provider; operates on the runtime callbacks/refs passed in ctx.
import { useMemo } from 'react'
import type { MutableRefObject } from 'react'
import type { AgentTemplate, AppState, EventType, TaskChatMsg } from '../../core/types'
import { dispatch } from '../../core/store'
import { hasCreds } from '../../master'
import { buildLaunch } from './launch'
import { focusSessionIn } from './layout-state'
import { envPrefix, typeForCommand } from './command'
import { findMachine, wrapLaunch } from './remote-machine'
import { realSessionProcessPort } from './ports'
import type { SessionProcessPort } from './ports'
import { buildTemplateCommand } from '../schedules/template-command'
import { taskContract, taskWorkText } from '../board/task-prompt'
import { findTaskInState, updateLocatedTask } from '../board/task-state'

export interface LaunchRuntimeCtx {
  stateRef: MutableRefObject<AppState>
  later: (ms: number, fn: () => void) => void
  flash: (t: string) => void
  logEvent: (type: EventType, agentId: string | null, text: string) => void
  appendTail: (id: string, line: string) => void
  clearNeeds: (id: string) => void
  bumpSettle: (id: string) => void
  armResponseWatch: (id: string) => void
  pushTaskChat: (taskId: string, role: TaskChatMsg['role'], text: string) => void
  runWatcher: (taskId: string, note: string) => Promise<void> | void
  taskSessions: MutableRefObject<Map<string, { taskId: string; workspaceId: string }>>
  /** native PTY + terminal capability; defaults to the real IPC-backed port */
  port?: SessionProcessPort
}

export interface LaunchRuntime {
  probeCliSession: (id: string, command: string, cwd: string, isResume: boolean) => void
  launchSession: (command: string, cwd: string, nameHint?: string, typeId?: string, workspaceId?: string, opts?: { ephemeral?: boolean; autoArchive?: boolean; templateId?: string; terminalShell?: string; isolate?: boolean; detached?: boolean; machineId?: string }) => string | null
  launchFromTemplate: (templateId: string, task?: string, workspaceId?: string, cwdOverride?: string, forceEphemeral?: boolean, contract?: string) => string | null
  spawnTaskSession: (taskId: string, opts?: { extraInstructions?: string; briefWatcher?: boolean; workspaceId?: string }) => string | null
  spawnSessionForTask: (taskId: string, workspaceId?: string) => void
  startTaskViaWatcher: (taskId: string) => void
}

export function useLaunchRuntime(ctx: LaunchRuntimeCtx): LaunchRuntime {
  const { stateRef, later, flash, logEvent, appendTail, clearNeeds, bumpSettle, armResponseWatch, pushTaskChat, runWatcher, taskSessions, port } = ctx
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => createLaunchRuntime(ctx), [stateRef, later, flash, logEvent, appendTail, clearNeeds, bumpSettle, armResponseWatch, pushTaskChat, runWatcher, taskSessions, port])
}

/** The launch runtime as a plain factory (no React), so it can be unit-tested
 *  with a fake SessionProcessPort and the real store. */
export function createLaunchRuntime(ctx: LaunchRuntimeCtx): LaunchRuntime {
  const { stateRef, later, flash, logEvent, appendTail, clearNeeds, bumpSettle, armResponseWatch, pushTaskChat, runWatcher, taskSessions } = ctx
  const port = ctx.port ?? realSessionProcessPort
  {
    // Poll native session files until the launched CLI's resume id is discoverable.
    const probeCliSession = (id: string, command: string, cwd: string, isResume: boolean) => {
      const probeType = typeForCommand(command, stateRef.current.agentTypes)
        ?? typeForCommand(stateRef.current.agents.find(a => a.id === id)?.cmd ?? '', stateRef.current.agentTypes)
      if (!probeType?.probe || !port.isTauri) return
      if (!isResume && /--resume|resume |--continue/.test(command)) return
      const spawnedAt = Date.now()
      // Probe repeatedly because CLIs create their resume files after process start.
      const tryDetect = () => {
        const current = stateRef.current.agents.find(a => a.id === id)
        if (!current) return
        if (!isResume && current.cliSessionId) return
        // ids already claimed by other live sessions — so concurrent sessions
        // (codex/opencode stores aren't cwd-scoped) can't resolve to the same file
        const exclude = stateRef.current.agents
          .filter(a => a.id !== id && a.cliSessionId)
          .map(a => a.cliSessionId!)
        port.detectCliSession(probeType.probe!, cwd || undefined, spawnedAt, exclude).then(sid => {
          if (!sid || sid === stateRef.current.agents.find(a => a.id === id)?.cliSessionId) return
          dispatch(s2 => ({
            ...s2,
            agents: s2.agents.map(a => a.id === id
              ? { ...a, cliSessionId: sid, log: a.log.concat([{ t: 'sys', x: `${isResume ? 'session id changed on resume' : `captured ${probeType.name} session`} · ${sid}` }]) }
              : a),
          }))
        }).catch(() => {})
      }
      later(7000, tryDetect)
      later(25000, tryDetect)
      if (!isResume) later(60000, tryDetect)
    }

    // Create optimistic session state, spawn its PTY, and attach lifecycle tracking.
    const launchSession = (command: string, cwd: string, nameHint?: string, typeId?: string, workspaceId?: string, opts?: { ephemeral?: boolean; autoArchive?: boolean; templateId?: string; terminalShell?: string; isolate?: boolean; detached?: boolean; machineId?: string }): string | null => {
      const machine = findMachine(stateRef.current.settings?.machines, opts?.machineId)
      const plan = buildLaunch({ command, cwd, nameHint, typeId, workspaceId, opts }, stateRef.current.agentTypes, stateRef.current.activeWorkspace, machine)
      if (!plan) return null
      const { agent, spawnCommand, knownSessionId, launchType } = plan
      const id = agent.id
      dispatch(s => {
        const withAgent = { ...s, agents: s.agents.concat([agent]) }
        // background-workspace launches (cron) must not touch the active layout
        if (agent.workspaceId !== s.activeWorkspace) return withAgent
        return { ...focusSessionIn(withAgent, id), newSessionOpen: false }
      })
      port.attachTerminal(id, line => appendTail(id, line), () => clearNeeds(id), () => bumpSettle(id), () => armResponseWatch(id))
      const fail = (err: unknown) => {
        dispatch(s => ({
          ...s,
          agents: s.agents.map(a => a.id === id
            ? { ...a, status: 'error' as const, log: a.log.concat([{ t: 'err' as const, x: String(err) }]) }
            : a),
        }))
      }
      const spawn = (spawnCwd: string | undefined) => {
        // Command sessions use the configured shell as login+interactive so a
        // GUI-launched app gets the same PATH/toolchain setup as the user's
        // terminal. Plain terminal sessions already carry terminalShell and
        // launch that shell directly instead.
        const commandShell = opts?.terminalShell ? undefined : (stateRef.current.settings?.shell || 'zsh')
        // Machine session: the local PTY runs an ssh client into a remote tmux
        // session (the durability layer). The remote cwd is handled inside the
        // wrap, so the local spawn cwd is irrelevant; CLI id probing/detach are
        // local-only and skipped.
        if (machine) {
          const inner = `${envPrefix(launchType?.env)}${spawnCommand}`
          port.spawnSession(id, wrapLaunch(machine, inner, id, agent.cwd), undefined, undefined, undefined, undefined, commandShell).catch(fail)
          return
        }
        // Claude's id is known up front; only codex/opencode need file detection.
        if (!knownSessionId) probeCliSession(id, agent.cmd ?? '', spawnCwd ?? '', false)
        if (opts?.detached) {
          // the PTY moves into a detached host process; the app runs a small
          // attach client instead. agent.cmd keeps the ORIGINAL command —
          // resume re-derives the attach wrapper via detachedSpawn, which
          // reattaches a live host or relaunches this command if it ended.
          port.detachedSpawn(id, `${envPrefix(launchType?.env)}${spawnCommand}`, spawnCwd, commandShell)
            .then(attachCmd => {
              dispatch(s => ({
                ...s,
                agents: s.agents.map(a => a.id === id
                  ? { ...a, detached: true, log: a.log.concat([{ t: 'sys' as const, x: 'detached session — survives closing the app; ▶ reattaches' }]) }
                  : a),
              }))
              port.spawnSession(id, attachCmd, spawnCwd || undefined, undefined, undefined, undefined, undefined).catch(fail)
            })
            .catch(fail)
          return
        }
        port.spawnSession(id, `${envPrefix(launchType?.env)}${spawnCommand}`, spawnCwd || undefined, undefined, undefined, opts?.terminalShell, commandShell).catch(fail)
      }
      if (opts?.isolate && agent.cwd && !machine) {
        // isolation: mirror the working folder (a repo, or a folder of repos)
        // into git worktrees first, then run the session inside the mirror
        port.createWorktree(agent.cwd, id).then(wt => {
          dispatch(s => ({
            ...s,
            agents: s.agents.map(a => a.id === id
              ? {
                  ...a, cwd: wt.workdir,
                  worktree: { root: wt.root, base: wt.base, workdir: wt.workdir },
                  log: a.log.concat([{ t: 'sys' as const, x: `isolated in worktree ${wt.root} (${wt.repos.length} repo${wt.repos.length > 1 ? 's' : ''})` }]),
                }
              : a),
          }))
          spawn(wt.workdir)
        }).catch(fail)
      } else {
        spawn(agent.cwd)
      }
      return id
    }

    // Resolve a persisted template into a command and launch it in the target workspace.
    const launchFromTemplate = (templateId: string, task?: string, workspaceId?: string, cwdOverride?: string, forceEphemeral?: boolean, contract?: string, isolate?: boolean): string | null => {
      const st = stateRef.current
      const stored = (st.templates ?? []).find(t => t.id === templateId)
      if (!stored) {
        flash('Template not found')
        return null
      }
      const tpl = forceEphemeral && stored.mode !== 'ephemeral' ? { ...stored, mode: 'ephemeral' as const } : stored
      const type = st.agentTypes.find(t => t.id === tpl.typeId)
      const command = buildTemplateCommand(tpl, type, task, contract)
      const id = launchSession(command, cwdOverride || tpl.cwd || st.settings.defaultCwd || '', tpl.name, type?.id, workspaceId, {
        ephemeral: tpl.mode === 'ephemeral', autoArchive: tpl.autoArchive, templateId: tpl.id, isolate,
        machineId: tpl.machineId,
      })
      if (id) logEvent('route', id, `Launched template “${tpl.name}”${task ? ` · ${task.slice(0, 48)}` : ''}`)
      return id
    }

    // The ONE canonical one-shot launch for a board task, in any workspace (active
    // or background). Locates the task, launches its template — or the default
    // agent type — one-shot, binds its watcher, and updates the card in its own slice.
    const spawnTaskSession = (taskId: string, opts?: { extraInstructions?: string; briefWatcher?: boolean; workspaceId?: string }): string | null => {
      const st = stateRef.current
      const located = findTaskInState(st, taskId, opts?.workspaceId)
      if (!located) return null
      const { task, workspaceId } = located
      // layered prompt: work text fills the template's {task} slot; the
      // verification contract (criteria + goal) is appended after the composed
      // prompt so template framing can't swallow or contradict it
      const work = taskWorkText(task)
        + (opts?.extraInstructions?.trim() ? `\n\nAdditional instructions from the task watcher:\n${opts.extraInstructions.trim()}` : '')
      const contract = taskContract(task)
      // isolation: the task's FIRST session builds the worktree; follow-up
      // sessions re-enter the same worktree so the work-in-progress carries over
      const prior = (task.agentIds ?? [])
        .map(aid => st.agents.find(a => a.id === aid)?.worktree)
        .find(Boolean)
      const runCwd = prior?.workdir || task.cwd
      const isolate = !!task.isolate && !prior
      let id: string | null = null
      // watcher-driven task sessions are ALWAYS one-shot: they run the task and exit
      if (task.templateId && (st.templates ?? []).some(t => t.id === task.templateId)) {
        id = launchFromTemplate(task.templateId, work, workspaceId, runCwd, true, contract, isolate)
      } else {
        const type = (task.typeId ? st.agentTypes.find(t => t.id === task.typeId) : undefined)
          ?? st.agentTypes.find(t => t.enabled)
        if (!type) {
          flash('No enabled agent type to handle the task')
          return null
        }
        const oneShot: AgentTemplate = {
          id: '', name: task.title.slice(0, 18), typeId: type.id, mode: 'ephemeral',
          prompt: '{task}', systemPrompt: '', model: '', approval: 'edits', cwd: '', extraArgs: '', autoArchive: false,
        }
        id = launchSession(buildTemplateCommand(oneShot, type, work, contract), runCwd || st.settings.defaultCwd || '', task.title.slice(0, 18), type.id, workspaceId, { ephemeral: true, isolate, machineId: task.machineId })
      }
      if (!id) return null
      if (prior) {
        // adopt the task's existing worktree on the follow-up session
        dispatch(s2 => ({
          ...s2,
          agents: s2.agents.map(a => a.id === id ? { ...a, worktree: prior } : a),
        }))
      }
      taskSessions.current.set(id, { taskId, workspaceId })
      const sessionName = stateRef.current.agents.find(a => a.id === id)?.name ?? id
      dispatch(s2 => updateLocatedTask(s2, taskId, t => ({
        ...t, agentId: id, agentIds: [...(t.agentIds ?? []), id!], scheduleAt: undefined,
        col: t.col === 'backlog' || t.col === 'done' || t.col === 'failed' ? 'progress' as const : t.col,
      }), workspaceId))
      armResponseWatch(id)
      pushTaskChat(taskId, 'system', `Spawned one-shot session “${sessionName}” for this task`)
      if (!task.cwd && !st.settings.defaultCwd && !(task.templateId && (st.templates ?? []).find(t => t.id === task.templateId)?.cwd)) {
        pushTaskChat(taskId, 'system',
          '⚠ No working folder set — the session runs in your home directory. If this task targets a repo, set the folder in the task spec and Relaunch.')
      }
      if (opts?.briefWatcher) {
        void runWatcher(taskId,
          `A one-shot session "${sessionName}" was just spawned to work this task; it received the title, description and criteria as its prompt, with the criteria set as an explicit goal (stop condition) it must self-verify before exiting. ` +
          'Set your card note, make sure the task sits in the right column, and post one short kickoff message for the user.')
      }
      logEvent('route', id, `Spawned session for task “${task.title.slice(0, 48)}”`)
      flash(`Session spawned for “${task.title.slice(0, 28)}”`)
      return id
    }

    // Deterministic start (drag to progress, schedules, no-brain fallback).
    const spawnSessionForTask = (taskId: string, workspaceId?: string) => {
      const located = findTaskInState(stateRef.current, taskId, workspaceId)
      if (!located || located.task.agentId) return
      spawnTaskSession(taskId, { briefWatcher: true, workspaceId: located.workspaceId })
    }

    // Watcher-first start: hand the task to its watcher (it calls spawn_session);
    // fall back to a direct spawn when there is no brain or the watcher fails to act.
    const startTaskViaWatcher = (taskId: string) => {
      const st = stateRef.current
      const task = st.tasks.find(t => t.id === taskId)
      if (!task || task.agentId) return
      if (!(st.settings.masterEnabled && hasCreds(st.settings))) {
        spawnSessionForTask(taskId)
        return
      }
      pushTaskChat(taskId, 'system', 'Start requested — handing to the watcher')
      void Promise.resolve(runWatcher(taskId,
        'The user started this task. You own spawning: call spawn_session now (add extra_instructions only if the spec needs augmenting), set your card note, and post one short kickoff message. If spawning fails, tell the user why.',
      )).then(() => {
        const after = stateRef.current.tasks.find(t => t.id === taskId)
        if (after && !after.agentId && !(after.agentIds ?? []).length) {
          pushTaskChat(taskId, 'system', 'Watcher did not spawn a session — starting one directly')
          spawnSessionForTask(taskId)
        }
      })
    }

    return { probeCliSession, launchSession, launchFromTemplate, spawnTaskSession, spawnSessionForTask, startTaskViaWatcher }
  }
}

// Pure launch planning: turn a launch request into the concrete Agent record
// and the exact command to spawn, without touching state, terminals, or the
// backend. The provider applies the plan (dispatch + terminal + native spawn).
import type { Agent, AgentType, Machine } from '../../core/types'
import { defaultDetail, mkMemory, mkTools } from '../../core/data'
import { mkId } from '../../shared/id'
import { typeForCommand } from './command'

export interface LaunchInput {
  command: string
  cwd: string
  nameHint?: string
  typeId?: string
  workspaceId?: string
  opts?: { ephemeral?: boolean; autoArchive?: boolean; templateId?: string; terminalShell?: string; isolate?: boolean }
}

export interface LaunchPlan {
  /** the new session record to insert */
  agent: Agent
  /** command to hand the backend (may carry an injected --session-id) */
  spawnCommand: string
  /** set when we minted the CLI session id ourselves (Claude); undefined means detect */
  knownSessionId?: string
  /** resolved agent type, for env-prefixing the spawn command */
  launchType?: AgentType
}

const REAL_COLORS = ['#7FD1FF', '#F5C451', '#3DDC97', '#FF9B9B', '#C77DFF', '#E8A87C']

export function buildLaunch(input: LaunchInput, agentTypes: AgentType[], activeWorkspace: string, machine?: Machine): LaunchPlan | null {
  const { command, cwd, nameHint, typeId, workspaceId, opts } = input
  const trimmed = command.trim()
  if (!trimmed) return null
  const id = mkId('a')
  const bin = trimmed.split(/\s+/)[0].split('/').pop() || trimmed
  const color = REAL_COLORS[Math.floor(Math.random() * REAL_COLORS.length)]
  const dir = cwd.trim()
  const launchType = agentTypes.find(t => t.id === (typeId ?? '')) ?? typeForCommand(trimmed, agentTypes)
  // Deterministic Claude sessions: Claude Code honors `--session-id <uuid>`, so
  // we mint the id ourselves and know it immediately — no fragile file
  // detection. The flag goes only into the SPAWNED command (reusing an id
  // errors "already in use"), while cmd stays clean for relaunch/resume.
  // codex/opencode have no launch-time id flag, so they keep file detection.
  // Remote (machine) sessions can't use local CLI id injection/detection — the
  // CLI stores live on the host — and are never one-shot; tmux is the durability
  // layer. The ssh+tmux wrap itself is applied later (launch-runtime), after the
  // env prefix, so `spawnCommand` stays the clean agent command here.
  let knownSessionId: string | undefined
  let spawnCommand = trimmed
  if (!machine && launchType?.probe === 'claude' && !/(^|\s)(--session-id|--resume|-r|--continue|-c)(\s|=|$)/.test(trimmed)) {
    knownSessionId = crypto.randomUUID()
    spawnCommand = trimmed.replace(/^(\s*\S+)/, `$1 --session-id ${knownSessionId}`)
  }
  const agent: Agent = {
    id, name: nameHint || bin, short: (nameHint || bin).slice(0, 2).toUpperCase(), color,
    repo: dir ? dir.split('/').pop() || dir : '~', branch: 'live',
    status: 'running', model: trimmed, kind: 'real', cmd: trimmed, cwd: dir, launchedAt: Date.now(),
    cliSessionId: knownSessionId,
    typeId: typeId ?? typeForCommand(trimmed, agentTypes)?.id,
    workspaceId: workspaceId ?? activeWorkspace,
    machineId: machine?.id,
    // snapshot the connection so later edits/removal of the saved machine can't
    // strand this session (resume/stop/Files/Git read agent.machine, not settings)
    machine: machine ? { ...machine } : undefined,
    ephemeral: machine ? false : opts?.ephemeral, autoArchive: machine ? false : opts?.autoArchive, templateId: opts?.templateId,
    terminalShell: opts?.terminalShell,
    memory: mkMemory(), tools: mkTools(),
    log: [
      { t: 'sys', x: `spawning · ${trimmed}${dir ? ` @ ${dir}` : ''}` },
      // print-mode CLIs (claude -p) emit nothing until the turn completes —
      // label the silence so a long run doesn't read as a hang
      ...(opts?.ephemeral ? [{ t: 'sys' as const, x: 'one-shot run — output appears when the turn completes; this can take a while' }] : []),
      ...(!dir ? [{ t: 'warn' as const, x: 'no working folder set — running in your home directory' }] : []),
    ],
    ...defaultDetail(), usageVersion: 1,
  }
  return { agent, spawnCommand, knownSessionId, launchType }
}

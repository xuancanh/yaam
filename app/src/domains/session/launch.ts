// Pure launch planning: turn a launch request into the concrete Agent record
// and the exact command to spawn, without touching state, terminals, or the
// backend. The provider applies the plan (dispatch + terminal + native spawn).
import type { Agent, AgentType, Machine, SandboxConfig } from '../../core/types'
import { defaultDetail, mkMemory, mkTools, TAB_COLORS } from '../../core/data'
import { mkId } from '../../shared/id'
import { adapterFor } from '../../core/agent-adapters'
import { typeForCommand } from './command'

export interface LaunchInput {
  command: string
  cwd: string
  nameHint?: string
  typeId?: string
  workspaceId?: string
  opts?: { ephemeral?: boolean; autoArchive?: boolean; templateId?: string; terminalShell?: string; isolate?: boolean; detached?: boolean; machineId?: string; sandbox?: SandboxConfig }
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

export function buildLaunch(input: LaunchInput, agentTypes: AgentType[], activeWorkspace: string, machine?: Machine): LaunchPlan | null {
  const { command, cwd, nameHint, typeId, workspaceId, opts } = input
  const trimmed = command.trim()
  if (!trimmed) return null
  const id = mkId('a')
  const bin = trimmed.split(/\s+/)[0].split('/').pop() || trimmed
  const color = TAB_COLORS[Math.floor(Math.random() * TAB_COLORS.length)]
  const dir = cwd.trim()
  const launchType = agentTypes.find(t => t.id === (typeId ?? '')) ?? typeForCommand(trimmed, agentTypes)
  // Deterministic session ids where the CLI allows it: mint-strategy adapters
  // (Claude's `--session-id <uuid>`) get the id injected at launch, so we know
  // it immediately — no fragile file detection. The flag goes only into the
  // SPAWNED command (reusing an id errors "already in use"), while cmd stays
  // clean for relaunch/resume. Detect-strategy adapters (codex/opencode) keep
  // file detection, which reads LOCAL stores — remote (machine) sessions can't
  // resume those by id and restart fresh. Minting works wherever the CLI runs,
  // so it applies to machine sessions too (see actions.resume). The ssh wrap is
  // applied later (launch-runtime), after the env prefix, so `spawnCommand`
  // stays the clean agent command here.
  let knownSessionId: string | undefined
  let spawnCommand = trimmed
  const adapter = adapterFor(launchType, trimmed)
  if (adapter?.sessionId === 'mint' && adapter.mintFlag && !adapter.sessionFlagRe?.test(trimmed)) {
    knownSessionId = crypto.randomUUID()
    spawnCommand = trimmed.replace(/^(\s*\S+)/, `$1 ${adapter.mintFlag(knownSessionId)}`)
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
    // a machine session behaves like a local one unless detached is requested,
    // in which case it runs in tmux on the host (durable across disconnects)
    detached: machine ? (opts?.detached || undefined) : undefined,
    ephemeral: opts?.ephemeral, autoArchive: opts?.autoArchive, templateId: opts?.templateId,
    terminalShell: opts?.terminalShell,
    // plain terminals spawn `shell -l -i` with no command string, so the
    // wrapper has nothing to wrap — the dialog disables the option there
    sandbox: opts?.terminalShell ? undefined : opts?.sandbox,
    memory: mkMemory(), tools: mkTools(),
    log: [
      { t: 'sys', x: `spawning · ${trimmed}${dir ? ` @ ${dir}` : ''}` },
      // print-mode CLIs (claude -p) emit nothing until the turn completes —
      // label the silence so a long run doesn't read as a hang
      ...(opts?.ephemeral ? [{ t: 'sys' as const, x: 'one-shot run — output appears when the turn completes; this can take a while' }] : []),
      ...(!dir ? [{ t: 'warn' as const, x: 'no working folder set — running in your home directory' }] : []),
      ...(opts?.sandbox && !opts?.terminalShell
        ? [{ t: 'sys' as const, x: `sandboxed — file writes limited to the working folder, temp, and built-in agent state dirs${opts.sandbox.denyNetwork ? ' · network denied' : ''}` }]
        : []),
    ],
    ...defaultDetail(), usageVersion: 1,
  }
  return { agent, spawnCommand, knownSessionId, launchType }
}

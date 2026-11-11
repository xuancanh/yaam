// Peer-coordination tools for the in-session MCP server: one agent session can
// list, read, prompt, wait on and spawn the other sessions of its workspace
// (the pattern herdr exposes over its socket). Off unless the user enables
// Settings → General → "Sessions can coordinate each other"; the Rust side only lists
// the tools while enabled, and every call re-checks the setting here.
//
// Safety rules:
// - scope is the caller's own workspace, never itself
// - prompting a session that is blocked on an approval is refused: the user
//   answers approvals, a peer agent never does
// - a target whose "send" tool the user turned off is refused
// - screens are returned inside an untrusted-data block
import type { Agent, AppState } from '../../core/types'
import { untrustedBlock } from '../../llm/untrusted'

export const PEER_TOOLS = new Set(['list_sessions', 'read_session', 'prompt_session', 'wait_for_session', 'spawn_session'])

export type PeerState = 'working' | 'blocked' | 'idle' | 'stopped' | 'failed'

/** The coarse state a peer sees. `running` is a live process; `responding`
 *  means it is streaming output right now. */
export function peerState(a: Pick<Agent, 'status' | 'responding'>): PeerState {
  if (a.status === 'needs') return 'blocked'
  if (a.status === 'error') return 'failed'
  if (a.status === 'idle') return 'stopped'
  return a.responding ? 'working' : 'idle'
}

export interface PeerDeps {
  stateRef: { current: AppState }
  sessionScreenTail: (id: string) => string
  sendLine: (id: string, text: string) => void
  launchSession: (command: string, cwd: string, name?: string, typeId?: string, workspaceId?: string, opts?: { terminalShell?: string }) => string | null
  logEvent?: (type: 'route', agentId: string | null, text: string) => void
  /** injectable for tests */
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

type Result = Record<string, unknown>
const text = (t: string): Result => ({ content: [{ type: 'text', text: t }] })
const fail = (t: string): Result => ({ content: [{ type: 'text', text: t }], isError: true })
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
const int = (v: unknown, def: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : def))

const wsOf = (s: AppState, a: Pick<Agent, 'workspaceId'>): string =>
  a.workspaceId && (s.workspaces ?? []).some(w => w.id === a.workspaceId) ? a.workspaceId : s.activeWorkspace

/** Live sessions a caller may coordinate: same workspace, not itself, not a chat. */
export function peersOf(s: AppState, caller: Agent): Agent[] {
  const ws = wsOf(s, caller)
  return s.agents.filter(a => a.id !== caller.id && !a.archived && a.kind !== 'chat' && wsOf(s, a) === ws)
}

function screen(deps: PeerDeps, a: Agent, lines: number): string {
  const tail = deps.sessionScreenTail(a.id).split('\n').slice(-lines).join('\n')
  return untrustedBlock(tail, a.name)
}

/** Resolve the waiting condition: until 'any' = no longer working. */
function reached(st: PeerState, until: string): boolean {
  if (until === 'blocked') return st === 'blocked'
  if (until === 'stopped') return st === 'stopped' || st === 'failed'
  if (until === 'idle') return st === 'idle' || st === 'stopped' || st === 'failed'
  return st !== 'working'
}

/** Poll the store until `id` reaches `until`. `sawWork` guards the race where
 *  a freshly prompted session has not started streaming yet: an idle reading
 *  only counts once it was seen working or `graceMs` has passed. */
async function waitFor(deps: PeerDeps, id: string, until: string, timeoutMs: number, graceMs: number): Promise<{ state: PeerState | 'gone'; timedOut: boolean }> {
  const sleep = deps.sleep ?? (ms => new Promise<void>(r => setTimeout(r, ms)))
  const now = deps.now ?? Date.now
  const start = now()
  let sawWork = false
  for (;;) {
    const a = deps.stateRef.current.agents.find(x => x.id === id && !x.archived)
    if (!a) return { state: 'gone', timedOut: false }
    const st = peerState(a)
    if (st === 'working') sawWork = true
    const settledEnough = sawWork || now() - start >= graceMs || until === 'blocked' || st === 'blocked'
    if (settledEnough && reached(st, until)) return { state: st, timedOut: false }
    if (now() - start >= timeoutMs) return { state: st, timedOut: true }
    await sleep(500)
  }
}

/** Answer one peer tool call. The caller has already been resolved. */
export async function applyPeerCall(deps: PeerDeps, caller: Agent, name: string, args: Record<string, unknown>): Promise<Result> {
  const s = deps.stateRef.current
  if (!s.settings?.peerTools) return fail('Peer tools are turned off. The user can enable them in YAAM Settings → General → Orchestration → "Sessions can coordinate each other".')
  const peers = peersOf(s, caller)
  const target = (): Agent | string => {
    const id = str(args.session_id)
    if (!id) return 'session_id is required'
    if (id === caller.id) return 'that is your own session'
    const a = peers.find(p => p.id === id)
    return a ?? `no session ${id} in your workspace (call list_sessions)`
  }

  switch (name) {
    case 'list_sessions': {
      const rows = peers.map(a => ({
        id: a.id, name: a.name, state: peerState(a), folder: a.cwd ?? '', agent: a.typeId ?? (a.terminalShell ? 'shell' : 'custom'),
        ...(a.task ? { task: a.task } : {}), ...(a.summary ? { now: a.summary } : {}),
      }))
      const types = (s.agentTypes ?? []).filter(t => t.enabled !== false).map(t => t.id)
      return text(JSON.stringify({ sessions: rows, agent_types: [...types, 'shell'] }, null, 2))
    }
    case 'read_session': {
      const a = target()
      if (typeof a === 'string') return fail(a)
      return text(`${a.name} is ${peerState(a)}. Screen:\n${screen(deps, a, int(args.lines, 60, 10, 200))}`)
    }
    case 'prompt_session': {
      const a = target()
      if (typeof a === 'string') return fail(a)
      const body = str(args.text)
      if (!body) return fail('text is required')
      const st = peerState(a)
      if (st === 'blocked') return fail(`${a.name} is blocked on an approval or question. Only the user can answer it; wait_for_session until it is idle instead.`)
      if (st === 'stopped' || st === 'failed') return fail(`${a.name} is not running (state ${st}).`)
      const send = a.tools?.find(t => t.id === 'send')
      if (send && (!send.on || send.perm === 'Off')) return fail(`the user disabled sending to ${a.name}`)
      deps.sendLine(a.id, body)
      deps.logEvent?.('route', a.id, `${caller.name} → ${a.name}: ${body.slice(0, 48)}`)
      if (args.wait !== true) return text(`sent to ${a.name}`)
      const r = await waitFor(deps, a.id, 'any', int(args.timeout_sec, 120, 1, 600) * 1000, 4000)
      const fresh = deps.stateRef.current.agents.find(x => x.id === a.id) ?? a
      return text(`${r.timedOut ? `Timed out; ${a.name} is still ${r.state}.` : `${a.name} is now ${r.state}.`} Screen:\n${screen(deps, fresh, 60)}`)
    }
    case 'wait_for_session': {
      const a = target()
      if (typeof a === 'string') return fail(a)
      const until = ['idle', 'blocked', 'stopped', 'any'].includes(str(args.until)) ? str(args.until) : 'idle'
      const r = await waitFor(deps, a.id, until, int(args.timeout_sec, 120, 1, 600) * 1000, 0)
      if (r.state === 'gone') return fail(`${a.name} was closed`)
      const fresh = deps.stateRef.current.agents.find(x => x.id === a.id) ?? a
      return text(`${r.timedOut ? `Timed out; ${a.name} is still ${r.state}.` : `${a.name} reached ${r.state}.`} Screen:\n${screen(deps, fresh, 40)}`)
    }
    case 'spawn_session': {
      const kind = str(args.agent)
      const cwd = str(args.cwd) || caller.cwd || ''
      const ws = wsOf(s, caller)
      let id: string | null
      if (kind === 'shell') {
        const sh = s.settings.shell || 'zsh'
        id = deps.launchSession(`${sh} -i`, cwd, str(args.name) || undefined, undefined, ws, { terminalShell: sh })
      } else {
        const t = (s.agentTypes ?? []).find(x => x.id === kind && x.enabled !== false)
        if (!t) return fail(`unknown agent type "${kind}"; see agent_types in list_sessions`)
        id = deps.launchSession(t.model, cwd, str(args.name) || undefined, t.id, ws)
      }
      if (!id) return fail('launch failed')
      deps.logEvent?.('route', id, `${caller.name} spawned a session`)
      const prompt = str(args.prompt)
      if (prompt) {
        // type the prompt once the agent finished booting (first quiet moment)
        void waitFor(deps, id, 'idle', 60_000, 3000).then(r => { if (r.state === 'idle') deps.sendLine(id, prompt) })
      }
      return text(`spawned session id=${id}${prompt ? '; the prompt will be typed once it is ready' : ''}. Use wait_for_session or read_session to follow it.`)
    }
    default:
      return fail(`unknown tool: ${name}`)
  }
}

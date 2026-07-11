// Pure snapshot builder for the remote companion: distills AppState into the
// JSON the mobile app renders — sessions (with a terminal tail), the full
// task board (with watcher chats), chat conversations, and every approval
// answerable from the desktop. Sizes are capped so the LAN payload stays
// small even for long-running fleets.
import type { AppState, BuildResult, BuildUI, Escalation, Message, RouteEntry } from '../../core/types'
import { hasCreds } from '../../llm/client'

export interface RemoteApproval {
  /** routes the command back: 'master' → resolveToolApproval, 'chat' → approveChatTool */
  kind: 'master' | 'chat'
  id: string
  agentId: string
  label: string
  detail: string
}

export interface RemoteMsg {
  id: string
  role: string
  text: string
  at: number
  approval?: string
  /** Master message shape, when this is from the orchestrator conversation. */
  kind?: Message['kind']
  thinking?: string
  routes?: RouteEntry[]
  esc?: Escalation
  escFor?: string
  build?: BuildResult
  buildUI?: BuildUI
}

export interface RemoteSnapshot {
  ts: number
  workspace: string
  sessions: {
    id: string
    name: string
    status: string
    task: string
    summary: string
    actionNeeded: string
    /** unseen finished/needs-action event — groups with "needs you" in triage */
    attention: boolean
    cost: number
    kind: string
    repo: string
    /** working folder — the mobile files/git browsing root */
    cwd: string
    /** serialized ANSI terminal buffer (xterm serialize addon) — the mobile
     *  app replays it into its own xterm for pixel-faithful rendering */
    term: string
    /** source terminal width, so the replay uses the same column count */
    cols: number
  }[]
  tasks: {
    id: string
    title: string
    col: string
    watcherNote: string
    awaitingUser: boolean
    description: string
    criteria: string[]
    chat: RemoteMsg[]
  }[]
  /** durable chat identities (non-archived) — conversations group under them */
  durables: {
    id: string
    name: string
    color: string
    role: string
    builtin: boolean
  }[]
  chats: {
    id: string
    name: string
    model: string
    /** this conversation's own file-tool root */
    cwd: string
    /** owning durable agent (unclaimed/legacy chats fall to the built-in one) */
    durableAgentId: string
    pinned: boolean
    /** a turn is streaming right now */
    busy: boolean
    /** last user/assistant message time, for recency sorting */
    lastAt: number
    msgs: RemoteMsg[]
  }[]
  /** the Master orchestrator conversation for the active workspace — the mobile
   *  app's default view, kept in step with the desktop sidebar */
  master: {
    busy: boolean
    /** an LLM brain is configured (masterEnabled + credentials) */
    brain: boolean
    msgs: RemoteMsg[]
  }
  approvals: RemoteApproval[]
}

const MSG_CAP = 30
const TASK_CAP = 60
const TEXT_CAP = 4000

const clip = (s: string) => (s.length > TEXT_CAP ? `${s.slice(0, TEXT_CAP)}…` : s)

/** Flatten one Master message to plain text the mobile chat can render. Master
 *  messages carry structured route/escalation/build payloads; distill each to a
 *  readable line, falling back to the message's own text. */
export function masterMsgText(m: Message): string {
  if (m.text?.trim()) return m.text
  if (m.kind === 'escalate' && m.esc) {
    return `⚠ ${m.esc.name} needs input: ${m.esc.reason}` + (m.esc.resolved ? ` — ${m.esc.decision ?? 'resolved'}` : '')
  }
  if (m.kind === 'route' && m.routes?.length) {
    return `Routed: ${m.routes.map(r => `${r.name} · ${r.action}`).join(', ')}`
  }
  if (m.kind === 'build' && m.build) return `${m.build.title} — ${m.build.detail}`
  if (m.kind === 'buildui') return 'Built a view'
  return ''
}

export function buildRemoteSnapshot(
  s: AppState,
  readTerm: (id: string) => { data: string; cols: number } = () => ({ data: '', cols: 80 }),
): RemoteSnapshot {
  // scope to the ACTIVE workspace — tasks already are (workspaceData holds the
  // rest), and showing a different world than the desktop reads as "not synced"
  const live = s.agents.filter(a => !a.archived && (a.workspaceId ?? s.activeWorkspace) === s.activeWorkspace)
  const approvals: RemoteApproval[] = s.pendingToolApprovals.map(pa => ({
    kind: 'master' as const,
    id: pa.id,
    agentId: '',
    label: `Master wants "${pa.toolId}"`,
    detail: 'Ask-first tool call from the Master agent.',
  }))
  for (const a of live) {
    for (const m of a.chatLog ?? []) {
      if (m.approval === 'pending') {
        approvals.push({
          kind: 'chat',
          id: m.id,
          agentId: a.id,
          label: `${a.name} wants to run a tool`,
          detail: clip(m.text).slice(0, 400),
        })
      }
    }
  }
  // conversations hang off durable agents; unclaimed ones (legacy chats,
  // archived agents' conversations) fall to the built-in generic agent —
  // the same grouping rule the desktop chat sidebar uses
  const durables = (s.durableAgents ?? []).filter(d => !d.archived)
  const fallbackDurable = durables.find(d => d.builtin)?.id ?? 'agent-default'
  const durableOf = (a: (typeof live)[number]) =>
    (durables.some(d => d.id === a.durableAgentId) ? a.durableAgentId! : fallbackDurable)
  const lastChatAt = (a: (typeof live)[number]) => {
    const msgs = (a.chatLog ?? []).filter(m => m.role === 'user' || m.role === 'assistant')
    return msgs[msgs.length - 1]?.at ?? 0
  }
  return {
    ts: Date.now(),
    workspace: s.workspaces.find(w => w.id === s.activeWorkspace)?.name ?? 'yaam',
    sessions: live
      .filter(a => a.kind !== 'chat')
      .map(a => ({
        id: a.id,
        name: a.name,
        status: a.status,
        task: a.task ?? '',
        summary: a.summary ?? '',
        actionNeeded: a.actionNeeded ?? '',
        attention: Boolean(a.attention),
        cost: a.cost,
        kind: a.kind ?? 'real',
        repo: a.repo,
        cwd: a.worktree?.workdir ?? a.cwd ?? '',
        ...(() => { const t = readTerm(a.id); return { term: t.data, cols: t.cols } })(),
      })),
    tasks: s.tasks
      .filter(t => !t.archived)
      .slice(-TASK_CAP)
      .map(t => ({
        id: t.id,
        title: t.title,
        col: t.col,
        watcherNote: t.watcherNote ?? '',
        awaitingUser: Boolean(t.awaitingUser),
        description: clip(t.description ?? ''),
        criteria: t.criteria ?? [],
        chat: (t.chat ?? []).slice(-MSG_CAP).map(m => ({ id: m.id, role: m.role, text: clip(m.text), at: m.at })),
      })),
    durables: durables.map(d => ({
      id: d.id,
      name: d.name,
      color: d.color,
      role: d.role ?? '',
      builtin: Boolean(d.builtin),
    })),
    chats: live
      .filter(a => a.kind === 'chat')
      .map(a => ({
        id: a.id,
        name: a.name,
        model: a.chatModel ?? a.model,
        cwd: a.cwd ?? '',
        durableAgentId: durableOf(a),
        pinned: Boolean(a.chatPinned),
        busy: a.status === 'running',
        lastAt: lastChatAt(a),
        msgs: (a.chatLog ?? [])
          .filter(m => m.role !== 'thinking')
          .slice(-MSG_CAP)
          .map(m => ({ id: m.id, role: m.role, text: clip(m.text), at: m.at, approval: m.approval })),
      })),
    master: {
      busy: Boolean(s.masterBusy),
      brain: Boolean(s.settings.masterEnabled && hasCreds(s.settings)),
      msgs: s.messages
        .map(m => ({
          id: m.id,
          role: m.role === 'you' ? 'user' : 'assistant',
          text: clip(m.text ?? ''),
          at: 0,
          kind: m.kind,
          thinking: m.thinking ? clip(m.thinking) : undefined,
          routes: m.routes,
          esc: m.esc,
          escFor: m.escFor,
          build: m.build,
          buildUI: m.buildUI,
        }))
        .filter(m => m.text || m.kind !== 'text')
        .slice(-MSG_CAP),
    },
    approvals,
  }
}

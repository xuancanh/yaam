// Pure snapshot builder for the remote companion: distills AppState into the
// JSON the mobile app renders — sessions (with a terminal tail), the full
// task board (with watcher chats), chat conversations, and every approval
// answerable from the desktop. Sizes are capped so the LAN payload stays
// small even for long-running fleets.
import type { AppState } from '../../core/types'

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
    cost: number
    kind: string
    repo: string
    /** last plain terminal lines, for the mobile session view */
    screen: string[]
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
  chats: {
    id: string
    name: string
    model: string
    msgs: RemoteMsg[]
  }[]
  approvals: RemoteApproval[]
}

const MSG_CAP = 30
const SCREEN_CAP = 40
const TASK_CAP = 60
const TEXT_CAP = 4000

const clip = (s: string) => (s.length > TEXT_CAP ? `${s.slice(0, TEXT_CAP)}…` : s)

export function buildRemoteSnapshot(
  s: AppState,
  readScreen: (id: string) => string[] = () => [],
): RemoteSnapshot {
  const approvals: RemoteApproval[] = s.pendingToolApprovals.map(pa => ({
    kind: 'master' as const,
    id: pa.id,
    agentId: '',
    label: `Master wants "${pa.toolId}"`,
    detail: 'Ask-first tool call from the Master agent.',
  }))
  for (const a of s.agents) {
    if (a.archived) continue
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
  const live = s.agents.filter(a => !a.archived)
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
        cost: a.cost,
        kind: a.kind ?? 'real',
        repo: a.repo,
        screen: readScreen(a.id).slice(-SCREEN_CAP),
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
    chats: live
      .filter(a => a.kind === 'chat')
      .map(a => ({
        id: a.id,
        name: a.name,
        model: a.chatModel ?? a.model,
        msgs: (a.chatLog ?? [])
          .filter(m => m.role !== 'thinking')
          .slice(-MSG_CAP)
          .map(m => ({ id: m.id, role: m.role, text: clip(m.text), at: m.at, approval: m.approval })),
      })),
    approvals,
  }
}

// Pure snapshot builder for the remote companion: distills AppState into the
// small JSON the phone page renders. Approvals gather BOTH pending Master tool
// approvals and ask-mode chat approvals so everything answerable from the
// desktop is answerable from the phone.
import type { AppState } from '../../core/types'

export interface RemoteApproval {
  /** routes the decision back: 'master' → resolveToolApproval, 'chat' → approveChatTool */
  kind: 'master' | 'chat'
  id: string
  agentId: string
  label: string
  detail: string
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
  }[]
  tasks: { id: string; title: string; col: string; watcherNote: string; awaitingUser: boolean }[]
  approvals: RemoteApproval[]
}

export function buildRemoteSnapshot(s: AppState): RemoteSnapshot {
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
          detail: m.text.slice(0, 400),
        })
      }
    }
  }
  return {
    ts: Date.now(),
    workspace: s.workspaces.find(w => w.id === s.activeWorkspace)?.name ?? 'yaam',
    sessions: s.agents
      .filter(a => !a.archived)
      .map(a => ({
        id: a.id,
        name: a.name,
        status: a.status,
        task: a.task ?? '',
        summary: a.summary ?? '',
        actionNeeded: a.actionNeeded ?? '',
        cost: a.cost,
        kind: a.kind ?? 'real',
      })),
    tasks: s.tasks
      .filter(t => !t.archived && (t.col === 'progress' || t.col === 'review' || t.col === 'failed'))
      .map(t => ({
        id: t.id,
        title: t.title,
        col: t.col,
        watcherNote: t.watcherNote ?? '',
        awaitingUser: Boolean(t.awaitingUser),
      })),
    approvals,
  }
}

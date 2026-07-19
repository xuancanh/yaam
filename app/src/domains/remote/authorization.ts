import type { AppState } from '../../core/types'
import type { RemoteCommand } from '../../core/native'

/** Canonical authorization roots represented in the active phone snapshot. */
export function remoteFileRoots(s: AppState): string[] {
  const roots = s.agents
    .filter(a => !a.archived && (a.workspaceId ?? s.activeWorkspace) === s.activeWorkspace)
    .map(a => a.worktree?.workdir ?? a.cwd)
    .filter((p): p is string => !!p?.startsWith('/'))
    .map(p => p.replace(/\/+$/, ''))
  return [...new Set(roots)].sort((a, b) => b.length - a.length)
}

/** Return the active root that lexically contains `path`; native reads still
 *  receive this root so Rust performs the canonical/symlink-safe check. */
export function authorizedRemoteRoot(s: AppState, path: string): string | undefined {
  if (!path.startsWith('/')) return undefined
  return remoteFileRoots(s).find(root => path === root || path.startsWith(`${root}/`))
}

/** Paired devices may only act on entities represented in the active snapshot. */
export function remoteCommandAllowed(s: AppState, command: RemoteCommand): boolean {
  if (command.kind.startsWith('rpc_')) return true // each RPC authorizes its payload separately
  if (command.kind === 'master_send') return true
  const agents = s.agents.filter(a => !a.archived && (a.workspaceId ?? s.activeWorkspace) === s.activeWorkspace)
  const agent = agents.find(a => a.id === command.id)
  const task = s.tasks.find(t => t.id === command.id && !t.archived)
  switch (command.kind) {
    case 'workspace_switch':
      // never switch main onto a workspace a satellite window owns
      return (s.workspaces ?? []).some(w => w.id === command.id)
        && !(s.detachedWorkspaces ?? []).includes(command.id)
    case 'chat_new':
      return (s.durableAgents ?? []).some(d => d.id === command.id && !d.archived)
    case 'chat_send':
      return agent?.kind === 'chat'
    case 'task_chat':
    case 'task_start':
      return !!task
    case 'session_input':
    case 'session_key':
    case 'session_focus':
    case 'session_blur':
    case 'session_stop':
    case 'session_resume':
    case 'prompt_answer':
    case 'prompt_approve':
    case 'prompt_deny':
      return !!agent && agent.kind !== 'chat'
    case 'approve_master':
      return s.pendingToolApprovals.some(p => p.id === command.id)
    case 'approve_chat': {
      const chat = agents.find(a => a.id === command.agent_id && a.kind === 'chat')
      return !!chat?.chatLog?.some(m => m.id === command.id && m.approval === 'pending')
    }
    case 'chat_reply': {
      // quick-reply chip: only text the assistant actually proposed on that message
      const chat = agents.find(a => a.id === command.agent_id && a.kind === 'chat')
      return !!chat?.chatLog?.some(m => m.id === command.id && m.suggestions?.includes(command.text))
    }
    case 'chat_rate': {
      const chat = agents.find(a => a.id === command.agent_id && a.kind === 'chat')
      return !!chat?.chatLog?.some(m => m.id === command.id && m.role === 'assistant')
    }
    default:
      return false
  }
}

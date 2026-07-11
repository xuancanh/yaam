import type { Agent } from '../../core/types'

/** Durable identities are global, but their conversations remain workspace
 *  records. Keep home-page snippets within the active workspace just like the
 *  surrounding ChatView, then order them by latest activity. */
export function homeConversations(agents: Agent[], durableAgentId: string, workspaceId: string): Agent[] {
  return agents
    .filter(a => a.kind === 'chat'
      && a.durableAgentId === durableAgentId
      && !a.archived
      && (a.workspaceId ?? workspaceId) === workspaceId)
    .sort((a, b) => ((b.chatLog ?? []).at(-1)?.at ?? 0) - ((a.chatLog ?? []).at(-1)?.at ?? 0))
}

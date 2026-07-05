// Chat-domain actions: create a chat agent, select the active chat, and send a
// message (the turn itself runs in domains/chat/runner). Composed into the
// provider's action surface.
import { useMemo } from 'react'
import type { MutableRefObject } from 'react'
import type { Agent, AppState, EventType } from '../../core/types'
import { mkId } from '../../core/state-lib'
import { defaultDetail, mkMemory, mkTools } from '../../core/data'
import type { ConductorActions } from '../../store'

export interface ChatActionsCtx {
  dispatch: (f: (s: AppState) => AppState) => void
  stateRef: MutableRefObject<AppState>
  logEvent: (type: EventType, agentId: string | null, text: string) => void
  runChatMessage: (agentId: string, text: string) => void
}

type ChatActions = Pick<ConductorActions, 'newChatSession' | 'openChat' | 'sendChatMessage'>

export function useChatActions(ctx: ChatActionsCtx): ChatActions {
  const { dispatch, stateRef } = ctx
  return useMemo(() => ({
    newChatSession: (name, cwd, chatTypeId, model, personaId, skillSourceIds) => {
      const id = mkId('a')
      const dir = (cwd ?? stateRef.current.settings.defaultCwd ?? '').trim()
      const chatType = stateRef.current.chatAgentTypes.find(t => t.id === chatTypeId)
        ?? stateRef.current.chatAgentTypes.find(t => t.enabled)
        ?? stateRef.current.chatAgentTypes[0]
      const agent: Agent = {
        id, name: name?.trim() || chatType?.name || 'chat', short: (name?.trim() || chatType?.name || 'CH').slice(0, 2).toUpperCase(),
        color: '#7FD1FF', repo: dir ? dir.split('/').pop() || dir : '~', branch: 'chat',
        status: 'idle', model: chatType ? `${chatType.name} · ${model || chatType.model}` : 'chat agent', kind: 'chat', cwd: dir,
        chatTypeId: chatType?.id,
        chatModel: model || chatType?.model,
        nameIsDefault: !name?.trim(),
        personaId,
        skillSourceIds,
        workspaceId: stateRef.current.activeWorkspace,
        memory: mkMemory(), tools: mkTools(), log: [],
        chatLog: [{
          id: mkId('cm'), role: 'assistant', at: Date.now(),
          text: `Hi — I'm a chat agent${dir ? ` working in \`${dir}\`` : ''}. I can browse and edit files, run commands and scripts, load skills, and call your MCP servers. What are we doing?`,
        }],
        ...defaultDetail(), usageVersion: 1,
      }
      dispatch(s => ({ ...s, agents: s.agents.concat([agent]), activeChatId: id, view: 'chat' }))
      ctx.logEvent('route', id, `Started chat agent “${agent.name}”`)
      return id
    },

    openChat: id => dispatch(s => ({ ...s, activeChatId: id, ...(id ? { view: 'chat' as const } : {}) })),

    sendChatMessage: (agentId, text) => {
      const msg = text.trim()
      if (msg) void ctx.runChatMessage(agentId, msg)
    },
  }), [dispatch, stateRef, ctx])
}

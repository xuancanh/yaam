// Chat-domain actions: create a chat agent, select the active chat, send /
// stop / retry a message (the turn itself runs in domains/chat/runner), clear
// a conversation, and resolve the skills visible to a chat (for the slash
// menu). Composed into the provider's action surface.
import { useMemo } from 'react'
import type { MutableRefObject } from 'react'
import type { Agent, AppState, EventType } from '../../core/types'
import type { CatalogSkill } from '../../core/skills'
import { mkId } from '../../shared/id'
import { defaultDetail, mkMemory, mkTools } from '../../core/data'

export interface ChatActionsCtx {
  dispatch: (f: (s: AppState) => AppState) => void
  stateRef: MutableRefObject<AppState>
  logEvent: (type: EventType, agentId: string | null, text: string) => void
  runChatMessage: (agentId: string, text: string) => void
  stopChatMessage: (agentId: string) => void
  retryChatMessage: (agentId: string) => void
  resetChatRuntime: (agentId: string) => void
  skillCatalogs: MutableRefObject<Map<string, CatalogSkill[]>>
}

export interface ChatActions {
  newChatSession: (name?: string, cwd?: string, chatTypeId?: string, model?: string, personaId?: string, skillSourceIds?: string[]) => string
  openChat: (id: string | null) => void
  sendChatMessage: (agentId: string, text: string) => void
  stopChat: (agentId: string) => void
  retryChat: (agentId: string) => void
  clearChat: (agentId: string) => void
  /** skills visible to this chat (its sources, cached registry catalogs only) */
  chatSkills: (agentId: string) => CatalogSkill[]
}

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

    stopChat: agentId => ctx.stopChatMessage(agentId),

    retryChat: agentId => ctx.retryChatMessage(agentId),

    clearChat: agentId => {
      ctx.resetChatRuntime(agentId)
      dispatch(s => ({
        ...s,
        agents: s.agents.map(a => a.id === agentId ? { ...a, chatLog: [], status: 'idle' as const } : a),
      }))
    },

    chatSkills: agentId => {
      const s = stateRef.current
      const agent = s.agents.find(a => a.id === agentId)
      const sources = agent?.skillSourceIds
        ?? ['local', ...s.skillRegistries.filter(r => r.enabled).map(r => r.id)]
      const out: CatalogSkill[] = []
      if (sources.includes('local')) {
        out.push(...s.skills.map(k => ({ name: k.name, description: k.description, body: k.body, source: 'local' })))
      }
      for (const reg of s.skillRegistries.filter(r => sources.includes(r.id))) {
        out.push(...(ctx.skillCatalogs.current.get(reg.id) ?? []))
      }
      return out
    },
  }), [dispatch, stateRef, ctx])
}

// Chat-domain actions: create a chat agent, select the active chat, send /
// stop / retry a message (the turn itself runs in domains/chat/runner), clear
// a conversation, and resolve the skills visible to a chat (for the slash
// menu). Composed into the provider's action surface.
import { useMemo } from 'react'
import type { MutableRefObject } from 'react'
import type { Agent, AppState, ChatComposerState, EventType } from '../../core/types'
import type { CatalogSkill } from '../../core/skills'
import type { ChatAttachment } from './runner'
import { mkId } from '../../shared/id'
import { defaultDetail, mkMemory, mkTools } from '../../core/data'

export interface ChatActionsCtx {
  dispatch: (f: (s: AppState) => AppState) => void
  stateRef: MutableRefObject<AppState>
  logEvent: (type: EventType, agentId: string | null, text: string) => void
  runChatMessage: (agentId: string, text: string, atts?: ChatAttachment[]) => void
  stopChatMessage: (agentId: string) => void
  retryChatMessage: (agentId: string) => void
  resetChatRuntime: (agentId: string) => void
  resolveChatApproval: (agentId: string, msgId: string, ok: boolean) => void
  skillCatalogs: MutableRefObject<Map<string, CatalogSkill[]>>
}

export interface ChatActions {
  newChatSession: (name?: string, cwd?: string, chatTypeId?: string, model?: string, personaId?: string, skillSourceIds?: string[]) => string
  openChat: (id: string | null) => void
  sendChatMessage: (agentId: string, text: string, atts?: ChatAttachment[]) => void
  stopChat: (agentId: string) => void
  retryChat: (agentId: string) => void
  clearChat: (agentId: string) => void
  setChatComposer: (agentId: string, patch: Partial<ChatComposerState>) => void
  /** answer a pending ask-mode tool approval */
  approveChatTool: (agentId: string, msgId: string, ok: boolean) => void
  /** flip a chat between ask (approve risky tools) and auto */
  setChatPermMode: (agentId: string, mode: 'ask' | 'auto') => void
  /** replace one workspace's durable chat memory (Memory editor) */
  setChatMemory: (workspaceId: string, text: string) => void
  /** skills visible to this chat (its sources, cached registry catalogs only) */
  chatSkills: (agentId: string) => CatalogSkill[]
}

export function useChatActions(ctx: ChatActionsCtx): ChatActions {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => createChatActions(ctx), [ctx.dispatch, ctx.stateRef, ctx.logEvent, ctx.runChatMessage, ctx.stopChatMessage, ctx.retryChatMessage, ctx.resetChatRuntime, ctx.skillCatalogs])
}

/** Plain (non-React) factory for the chat actions. */
export function createChatActions(ctx: ChatActionsCtx): ChatActions {
  const { dispatch, stateRef } = ctx
  return {
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
          text: `Hi${dir ? ` — I'm working in \`${dir}\`` : ''}. What would you like to work on? You can describe an outcome or attach files.`,
        }],
        chatComposer: { draft: '', attachments: [], queue: [] },
        ...defaultDetail(), usageVersion: 1,
      }
      dispatch(s => ({ ...s, agents: s.agents.concat([agent]), activeChatId: id, view: 'chat' }))
      ctx.logEvent('route', id, `Started chat agent “${agent.name}”`)
      return id
    },

    openChat: id => dispatch(s => ({ ...s, activeChatId: id, ...(id ? { view: 'chat' as const } : {}) })),

    sendChatMessage: (agentId, text, atts) => {
      const msg = text.trim()
      if (msg || atts?.length) void ctx.runChatMessage(agentId, msg || '(see attachments)', atts)
    },

    stopChat: agentId => ctx.stopChatMessage(agentId),

    retryChat: agentId => ctx.retryChatMessage(agentId),

    clearChat: agentId => {
      ctx.resetChatRuntime(agentId)
      dispatch(s => ({
        ...s,
        agents: s.agents.map(a => a.id === agentId
          ? { ...a, chatLog: [], chatTurns: [], chatComposer: { draft: '', attachments: [], queue: [] }, status: 'idle' as const }
          : a),
      }))
    },

    setChatComposer: (agentId, patch) => dispatch(s => ({
      ...s,
      agents: s.agents.map(a => {
        if (a.id !== agentId) return a
        const current = a.chatComposer ?? { draft: '', attachments: [], queue: [] }
        return { ...a, chatComposer: { ...current, ...patch } }
      }),
    })),

    approveChatTool: (agentId, msgId, ok) => ctx.resolveChatApproval(agentId, msgId, ok),

    setChatPermMode: (agentId, mode) => dispatch(s => ({
      ...s,
      agents: s.agents.map(a => a.id === agentId ? { ...a, permMode: mode } : a),
    })),

    setChatMemory: (workspaceId, text) => dispatch(s => ({
      ...s,
      chatMemory: { ...s.chatMemory, [workspaceId]: text.trim() },
    })),

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
  }
}

// Chat-domain actions: create a chat agent, select the active chat, send /
// stop / retry a message (the turn itself runs in domains/chat/runner), clear
// a conversation, and resolve the skills visible to a chat (for the slash
// menu). Composed into the provider's action surface.
import { useMemo } from 'react'
import type { MutableRefObject } from 'react'
import type { Agent, AppState, ChatComposerState, DurableAgent, EventType } from '../../core/types'
import type { CatalogSkill } from '../../core/skills'
import type { ChatAttachment } from './runner'
import { mkId } from '../../shared/id'
import { defaultDetail, mkMemory, mkTools } from '../../core/data'
import { buildContextSummary } from './turns'
import { resolveDecision } from '../master/harness-stats'
import { withMemoryAppend } from '../master/assistant-memory'
import { LESSONS_FILE, appendBrainFile, commitBrain } from './durable-brain'
import type { ThinkingEffort } from '../../llm/client'

export interface ChatActionsCtx {
  dispatch: (f: (s: AppState) => AppState) => void
  stateRef: MutableRefObject<AppState>
  logEvent: (type: EventType, agentId: string | null, text: string) => void
  runChatMessage: (agentId: string, text: string, atts?: ChatAttachment[]) => void
  stopChatMessage: (agentId: string) => void
  retryChatMessage: (agentId: string) => void
  replayChatMessage: (agentId: string, turnId: string, text: string, atts?: ChatAttachment[]) => void
  resetChatRuntime: (agentId: string) => void
  resolveChatApproval: (agentId: string, msgId: string, decision: boolean | 'once' | 'always' | 'deny') => void
  compactChatContext: (agentId: string) => Promise<string>
  skillCatalogs: MutableRefObject<Map<string, CatalogSkill[]>>
}

export interface ChatActions {
  newChatSession: (name?: string, cwd?: string, chatTypeId?: string, model?: string, skillSourceIds?: string[], durableAgentId?: string) => string
  /** durable agents: create/update/archive, and manually reflect the latest conversation */
  addDurableAgent: (patch: Partial<DurableAgent> & { name: string }) => string
  updateDurableAgent: (id: string, patch: Partial<DurableAgent>) => void
  archiveDurableAgent: (id: string) => void
  openChat: (id: string | null) => void
  sendChatMessage: (agentId: string, text: string, atts?: ChatAttachment[]) => void
  /** click one of the assistant's quick replies: clears the chips, records the
   *  acceptance, and sends the reply as the user's message */
  sendQuickReply: (agentId: string, msgId: string, reply: string) => void
  stopChat: (agentId: string) => void
  retryChat: (agentId: string) => void
  editAndResendChat: (agentId: string, turnId: string, text: string, atts?: ChatAttachment[]) => void
  forkChatTurn: (agentId: string, turnId: string, text: string, atts?: ChatAttachment[]) => string | null
  promoteChatTurn: (agentId: string, turnId: string) => string | null
  clearChat: (agentId: string) => void
  /** distill the API context into a summary (manual /compact) */
  compactChat: (agentId: string) => Promise<string>
  setChatComposer: (agentId: string, patch: Partial<ChatComposerState>) => void
  /** switch this conversation's brain from the chat bar: agent type (provider),
   *  model, and thinking effort (null clears the effort) */
  setChatConfig: (agentId: string, patch: { chatTypeId?: string; chatModel?: string; chatEffort?: ThinkingEffort | null }) => void
  /** rate an assistant reply 👍/👎; durable agents record the rating (plus the
   *  optional note) as a lesson so future turns adjust */
  rateChatReply: (agentId: string, msgId: string, rating: 'up' | 'down', note?: string) => void
  setChatPinned: (agentId: string, pinned: boolean) => void
  setChatTags: (agentId: string, tags: string[]) => void
  archiveChat: (agentId: string) => void
  restoreChat: (agentId: string) => void
  setChatTokenBudget: (agentId: string, tokens: number) => void
  /** answer a pending ask-mode tool approval */
  approveChatTool: (agentId: string, msgId: string, decision: boolean | 'once' | 'always' | 'deny') => void
  /** flip a chat between ask (approve risky tools) and auto */
  setChatPermMode: (agentId: string, mode: 'ask' | 'auto') => void
  /** replace one workspace's durable chat memory (Memory editor) */
  setChatMemory: (workspaceId: string, text: string) => void
  /** skills visible to this chat (its sources, cached registry catalogs only) */
  chatSkills: (agentId: string) => CatalogSkill[]
}

export function useChatActions(ctx: ChatActionsCtx): ChatActions {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => createChatActions(ctx), [ctx.dispatch, ctx.stateRef, ctx.logEvent, ctx.runChatMessage, ctx.stopChatMessage, ctx.retryChatMessage, ctx.replayChatMessage, ctx.resetChatRuntime, ctx.skillCatalogs])
}

/** Build a fresh chat-session record. A durable agent's conversations inherit
 *  its home dir, color, and defaults; explicit opts win. Pure — the caller
 *  dispatches it (used by newChatSession and by scheduled agent prompts). */
export function buildChatSession(st: AppState, opts: {
  name?: string
  cwd?: string
  chatTypeId?: string
  model?: string
  skillSourceIds?: string[]
  durableAgentId?: string
  tags?: string[]
}): Agent {
  const id = mkId('a')
  const durable = opts.durableAgentId ? (st.durableAgents ?? []).find(d => d.id === opts.durableAgentId) : undefined
  const dir = (opts.cwd ?? durable?.homeDir ?? st.settings.defaultCwd ?? '').trim()
  const chatType = st.chatAgentTypes.find(t => t.id === (opts.chatTypeId ?? durable?.chatTypeId))
    ?? st.chatAgentTypes.find(t => t.enabled)
    ?? st.chatAgentTypes[0]
  const effModel = opts.model || durable?.model
  return {
    id, name: opts.name?.trim() || durable?.name || chatType?.name || 'chat', short: (opts.name?.trim() || durable?.name || chatType?.name || 'CH').slice(0, 2).toUpperCase(),
    color: durable?.color ?? '#7FD1FF', repo: dir ? dir.split('/').pop() || dir : '~', branch: 'chat',
    status: 'idle', model: chatType ? `${chatType.name} · ${effModel || chatType.model}` : 'chat agent', kind: 'chat', cwd: dir,
    chatTypeId: chatType?.id,
    chatModel: effModel || chatType?.model,
    nameIsDefault: !opts.name?.trim(),
    skillSourceIds: opts.skillSourceIds ?? durable?.skillSourceIds,
    durableAgentId: durable?.id,
    chatTags: opts.tags,
    workspaceId: st.activeWorkspace,
    memory: mkMemory(), tools: mkTools(), log: [],
    chatLog: [{
      id: mkId('cm'), role: 'assistant', at: Date.now(),
      text: `Hi${dir ? ` — I'm working in \`${dir}\`` : ''}. What would you like to work on? You can describe an outcome or attach files.`,
    }],
    chatComposer: { draft: '', attachments: [], queue: [] },
    chatTokenBudget: 200_000,
    ...defaultDetail(), usageVersion: 1,
  }
}

/** Memory hygiene by default: agents with a file brain get a weekly loop that
 *  rewrites LESSONS.md — merge duplicates, drop stale items, promote repeated
 *  lessons into principles. Deduped by cron name per agent. */
function seedConsolidationLoop(dispatch: ChatActionsCtx['dispatch'], durableAgentId: string): void {
  dispatch(s => {
    if (s.crons.some(c => c.durableAgentId === durableAgentId && c.name === 'consolidate-lessons')) return s
    return {
      ...s,
      crons: s.crons.concat([{
        id: mkId('c'), name: 'consolidate-lessons', schedule: '0 18 * * 0',
        human: 'Runs at 18:00 on Sunday', target: 'agent', agent: 'Chat', color: '#B78AF7',
        on: true, built: true, last: '—',
        durableAgentId,
        agentPrompt: 'Memory hygiene: read your LESSONS.md and rewrite it in place — merge duplicates, drop stale or contradicted items, and promote lessons that keep repeating into short principles near the top. Keep everything still true; keep the file under ~150 lines. Then reply with a one-line summary of what changed.',
      }]),
    }
  })
}

/** Plain (non-React) factory for the chat actions. */
export function createChatActions(ctx: ChatActionsCtx): ChatActions {
  const { dispatch, stateRef } = ctx
  return {
    newChatSession: (name, cwd, chatTypeId, model, skillSourceIds, durableAgentId) => {
      const agent = buildChatSession(stateRef.current, { name, cwd, chatTypeId, model, skillSourceIds, durableAgentId })
      dispatch(s => ({ ...s, agents: s.agents.concat([agent]), activeChatId: agent.id, view: 'chat' }))
      ctx.logEvent('route', agent.id, `Started chat agent “${agent.name}”`)
      return agent.id
    },

    promoteChatTurn: (agentId, turnId) => {
      const source = stateRef.current.agents.find(a => a.id === agentId)
      const turn = source?.chatTurns?.find(t => t.id === turnId)
      if (!source || !turn) return null
      if (turn.promotedTaskId) return turn.promotedTaskId
      const id = mkId('t')
      const files = turn.input.attachments.map(a => a.path ?? a.name)
      const toolNames = [...new Set(turn.tools.map(t => t.name))]
      const description = [
        `Source chat: ${source.name}`,
        `Request:\n${turn.input.text}`,
        turn.assistantText ? `Outcome:\n${turn.assistantText}` : '',
        files.length ? `Attached files:\n${files.map(f => `- ${f}`).join('\n')}` : '',
        toolNames.length ? `Activity: ${toolNames.join(', ')}` : '',
      ].filter(Boolean).join('\n\n')
      const title = turn.input.text.replace(/\s+/g, ' ').trim().slice(0, 72) || `${source.name} follow-up`
      dispatch(s => ({
        ...s,
        tasks: [...s.tasks, { id, title, col: 'backlog', agentId: null, description, criteria: [], cwd: source.cwd }],
        agents: s.agents.map(a => a.id === agentId ? {
          ...a,
          chatTurns: (a.chatTurns ?? []).map(t => t.id === turnId ? { ...t, promotedTaskId: id } : t),
        } : a),
      }))
      ctx.logEvent('route', agentId, `Promoted a chat turn to board task “${title}”`)
      return id
    },

    openChat: id => dispatch(s => ({ ...s, activeChatId: id, ...(id ? { view: 'chat' as const } : {}) })),

    addDurableAgent: patch => {
      const id = mkId('da')
      dispatch(s => ({
        ...s,
        durableAgents: [...(s.durableAgents ?? []), {
          id, color: '#B78AF7', charter: '', createdAt: Date.now(),
          ...patch, name: patch.name.trim() || 'Agent',
        }],
      }))
      if (patch.homeDir?.trim()) seedConsolidationLoop(dispatch, id)
      ctx.logEvent('build', null, `Created durable agent “${patch.name}”`)
      return id
    },

    updateDurableAgent: (id, patch) => {
      const before = (stateRef.current.durableAgents ?? []).find(d => d.id === id)
      dispatch(s => ({
        ...s,
        durableAgents: (s.durableAgents ?? []).map(d => (d.id === id ? { ...d, ...patch, id: d.id, builtin: d.builtin } : d)),
      }))
      // an agent gaining a home folder gets memory hygiene by default: the
      // weekly consolidate-lessons loop (delete it in the profile to opt out)
      if (patch.homeDir?.trim() && !before?.homeDir?.trim()) seedConsolidationLoop(dispatch, id)
    },

    archiveDurableAgent: id => {
      const d = (stateRef.current.durableAgents ?? []).find(x => x.id === id)
      if (!d || d.builtin) return
      dispatch(s => ({
        ...s,
        durableAgents: (s.durableAgents ?? []).map(x => (x.id === id ? { ...x, archived: true } : x)),
      }))
      ctx.logEvent('edit', null, `Archived durable agent “${d.name}”`)
    },

    sendChatMessage: (agentId, text, atts) => {
      const msg = text.trim()
      if (msg || atts?.length) void ctx.runChatMessage(agentId, msg || '(see attachments)', atts)
    },

    sendQuickReply: (agentId, msgId, reply) => {
      dispatch(s => ({
        ...s,
        agents: s.agents.map(a => a.id === agentId
          ? { ...a, chatLog: (a.chatLog ?? []).map(m => (m.id === msgId ? { ...m, suggestions: undefined } : m)) }
          : a),
        harnessLog: resolveDecision(s.harnessLog, { role: 'chat', kind: 'reply', agentId }, 'accepted', reply.slice(0, 60)),
      }))
      void ctx.runChatMessage(agentId, reply)
    },

    stopChat: agentId => ctx.stopChatMessage(agentId),

    compactChat: agentId => ctx.compactChatContext(agentId),

    retryChat: agentId => ctx.retryChatMessage(agentId),

    editAndResendChat: (agentId, turnId, text, atts) => ctx.replayChatMessage(agentId, turnId, text, atts),

    forkChatTurn: (agentId, turnId, text, atts) => {
      const source = stateRef.current.agents.find(a => a.id === agentId)
      const index = source?.chatTurns?.findIndex(t => t.id === turnId) ?? -1
      const original = index >= 0 ? source?.chatTurns?.[index] : undefined
      if (!source || !original) return null
      const keptTurns = (source.chatTurns ?? []).slice(0, index)
      const keptIds = new Set(keptTurns.map(t => t.id))
      const id = mkId('a')
      const fork: Agent = {
        ...source,
        id,
        name: `${source.name} fork`,
        short: source.short,
        status: 'idle',
        attention: false,
        used: 0,
        cost: 0,
        nameIsDefault: false,
        chatTurns: keptTurns,
        chatLog: (source.chatLog ?? []).filter(m => !m.turnId || keptIds.has(m.turnId)),
        chatComposer: { draft: '', attachments: [], queue: [] },
        chatContextSummary: buildContextSummary(keptTurns),
        chatCompactedAt: undefined,
      }
      dispatch(s => ({ ...s, agents: [...s.agents, fork], activeChatId: id, view: 'chat' }))
      ctx.logEvent('route', id, `Forked chat “${source.name}”`)
      ctx.runChatMessage(id, text, atts ?? original.input.attachments)
      return id
    },

    clearChat: agentId => {
      ctx.resetChatRuntime(agentId)
      dispatch(s => ({
        ...s,
        agents: s.agents.map(a => a.id === agentId
          ? { ...a, chatLog: [], chatTurns: [], chatComposer: { draft: '', attachments: [], queue: [] }, chatContextSummary: undefined, chatCompactedAt: undefined, status: 'idle' as const }
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

    setChatConfig: (agentId, patch) => dispatch(s => ({
      ...s,
      agents: s.agents.map(a => {
        if (a.id !== agentId) return a
        const chatType = patch.chatTypeId
          ? s.chatAgentTypes.find(t => t.id === patch.chatTypeId)
          : s.chatAgentTypes.find(t => t.id === a.chatTypeId)
        // switching the type resets the model to that type's default unless
        // the same dispatch names one explicitly
        const model = patch.chatModel
          ?? (patch.chatTypeId ? chatType?.model : a.chatModel)
          ?? chatType?.model
        return {
          ...a,
          ...(patch.chatTypeId ? { chatTypeId: patch.chatTypeId } : {}),
          chatModel: model,
          ...(patch.chatEffort !== undefined ? { chatEffort: patch.chatEffort ?? undefined } : {}),
          // the session card's display line mirrors the active brain
          model: chatType ? `${chatType.name} · ${model}` : a.model,
        }
      }),
    })),

    rateChatReply: (agentId, msgId, rating, note) => {
      const st = stateRef.current
      const conv = st.agents.find(a => a.id === agentId)
      const msg = conv?.chatLog?.find(m => m.id === msgId)
      if (!conv || !msg || msg.role !== 'assistant') return
      const cleared = msg.feedback === rating && !note // same thumb again = un-rate
      dispatch(s => ({
        ...s,
        agents: s.agents.map(a => a.id === agentId
          ? { ...a, chatLog: (a.chatLog ?? []).map(m => (m.id === msgId ? { ...m, feedback: cleared ? undefined : rating } : m)) }
          : a),
      }))
      if (cleared) return
      // turn the rating into a durable lesson: explicit feedback is the highest-
      // signal learning input, so it lands in the brain immediately instead of
      // waiting for reflection (which only sees the transcript text)
      const excerpt = msg.text.replace(/\s+/g, ' ').trim().slice(0, 160)
      const line = rating === 'down'
        ? `- [user 👎 ${new Date().toISOString().slice(0, 10)}] ${note?.trim() || `the user rejected this kind of reply: "${excerpt}"`}`
        : note?.trim()
          ? `- [user 👍 ${new Date().toISOString().slice(0, 10)}] ${note.trim()}`
          : '' // a bare 👍 is recorded on the message, not worth a lesson line
      if (!line) return
      const durable = conv.durableAgentId ? (st.durableAgents ?? []).find(d => d.id === conv.durableAgentId) : undefined
      if (durable?.homeDir?.trim()) {
        void appendBrainFile(durable, LESSONS_FILE, line)
          .then(() => commitBrain(durable, `feedback · ${rating}`))
          .catch(() => {})
      } else {
        dispatch(s => withMemoryAppend(s, 'corrections', line.replace(/^- /, ''), conv.workspaceId))
      }
      ctx.logEvent('edit', agentId, `Rated a reply ${rating === 'up' ? '👍' : '👎'}${note?.trim() ? ' with a note' : ''}`)
    },

    setChatPinned: (agentId, pinned) => dispatch(s => ({
      ...s,
      agents: s.agents.map(a => a.id === agentId ? { ...a, chatPinned: pinned } : a),
    })),

    setChatTags: (agentId, tags) => dispatch(s => ({
      ...s,
      agents: s.agents.map(a => a.id === agentId ? {
        ...a,
        chatTags: [...new Set(tags.map(tag => tag.trim()).filter(Boolean))].slice(0, 12),
      } : a),
    })),

    archiveChat: agentId => dispatch(s => ({
      ...s,
      agents: s.agents.map(a => a.id === agentId ? { ...a, archived: true, chatPinned: false } : a),
      activeChatId: s.activeChatId === agentId ? null : s.activeChatId,
    })),

    restoreChat: agentId => dispatch(s => ({
      ...s,
      agents: s.agents.map(a => a.id === agentId ? { ...a, archived: false } : a),
    })),

    setChatTokenBudget: (agentId, tokens) => dispatch(s => ({
      ...s,
      agents: s.agents.map(a => a.id === agentId ? { ...a, chatTokenBudget: Math.max(0, Math.round(tokens)) } : a),
    })),

    approveChatTool: (agentId, msgId, decision) => ctx.resolveChatApproval(agentId, msgId, decision),

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

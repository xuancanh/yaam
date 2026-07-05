// Chat-mode agent turn: an in-app Claude-Desktop-style loop (files/exec/skills/
// MCP tools) with streamed answer + reasoning bubbles and one-shot auto-titling.
// Extracted from the provider; operates on the stable refs/callbacks in `ctx`.
import type { MutableRefObject } from 'react'
import type { AppState, ChatMsg } from '../../core/types'
import type { ApiMessage } from '../../master'
import type { McpSession } from '../../core/mcp'
import type { CatalogSkill } from '../../core/skills'
import { buildChatCfg, callApi, chatTypeHasCreds } from '../../llm/client'
import { runChatTurn } from './agent'
import { mkId } from '../../shared/id'

export interface ChatCtx {
  stateRef: MutableRefObject<AppState>
  dispatch: (f: (s: AppState) => AppState) => void
  busy: MutableRefObject<Set<string>>
  histories: MutableRefObject<Map<string, ApiMessage[]>>
  mcpSessions: MutableRefObject<Map<string, McpSession>>
  skillCatalogs: MutableRefObject<Map<string, CatalogSkill[]>>
  pushChatLog: (id: string, msg: Omit<ChatMsg, 'id' | 'at'>) => void
  updateChatLog: (agentId: string, msgId: string, text: string) => void
  flash: (t: string) => void
  refreshSkillCatalog: (id: string) => Promise<string>
}

/** Run one chat-agent turn, streaming deltas/reasoning/tool traces into the UI. */
export async function runChatMessageTurn(ctx: ChatCtx, agentId: string, text: string) {
  const st = ctx.stateRef.current.settings
  const agent = ctx.stateRef.current.agents.find(a => a.id === agentId)
  if (!agent || agent.kind !== 'chat') return
  const chatType = ctx.stateRef.current.chatAgentTypes.find(t => t.id === agent.chatTypeId)
    ?? ctx.stateRef.current.chatAgentTypes.find(t => t.enabled)
    ?? ctx.stateRef.current.chatAgentTypes[0]
  if (!chatType) {
    ctx.pushChatLog(agentId, { role: 'user', text })
    ctx.pushChatLog(agentId, { role: 'assistant', text: 'No chat agent types configured — add one in Settings → Agent Types → Chat agents.' })
    return
  }
  if (!chatTypeHasCreds(chatType, st)) {
    ctx.pushChatLog(agentId, { role: 'user', text })
    ctx.pushChatLog(agentId, { role: 'assistant', text: `“${chatType.name}” has no credentials — set an API key in Settings → Agent Types → Chat agents (or match the Master Brain provider to share its key).` })
    return
  }
  if (ctx.busy.current.has(agentId)) {
    ctx.flash('Chat agent is still working on the previous message')
    return
  }
  ctx.busy.current.add(agentId)
  ctx.pushChatLog(agentId, { role: 'user', text })
  ctx.dispatch(s => ({ ...s, agents: s.agents.map(a => (a.id === agentId ? { ...a, status: 'running' as const } : a)) }))
  try {
    let history = ctx.histories.current.get(agentId)
    if (!history) {
      // after a restart the private API history is gone — rebuild it from
      // the persisted visible transcript (tool traces excluded)
      history = (agent.chatLog ?? [])
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .map(m => ({ role: m.role === 'user' ? 'user' as const : 'assistant' as const, content: m.text }))
      while (history.length && history[0].role !== 'user') history.shift()
      ctx.histories.current.set(agentId, history)
    }
    const mcp = ctx.stateRef.current.mcpServers
      .filter(x => x.enabled)
      .map(x => ctx.mcpSessions.current.get(x.id))
      .filter((x): x is McpSession => !!x)
    // skill sources chosen at chat creation (default: local + enabled registries)
    const sources = agent.skillSourceIds
      ?? ['local', ...ctx.stateRef.current.skillRegistries.filter(r => r.enabled).map(r => r.id)]
    const skills: CatalogSkill[] = []
    if (sources.includes('local')) {
      skills.push(...ctx.stateRef.current.skills.map(k => ({ name: k.name, description: k.description, body: k.body, source: 'local' })))
    }
    for (const reg of ctx.stateRef.current.skillRegistries.filter(r => sources.includes(r.id))) {
      if (!ctx.skillCatalogs.current.has(reg.id)) await ctx.refreshSkillCatalog(reg.id)
      skills.push(...(ctx.skillCatalogs.current.get(reg.id) ?? []))
    }
    const personaBody = ctx.stateRef.current.personas.find(pp => pp.id === agent.personaId)?.body
    const persona = [chatType.systemPrompt, personaBody].filter(Boolean).join('\n\n')
    // streaming: deltas grow one live assistant bubble; a tool round seals
    // the current bubble; the final text replaces (or creates) it
    let streamId: string | null = null
    let acc = ''
    let thinkId: string | null = null
    let thinkAcc = ''
    const appendBubble = (id: string, role: 'assistant' | 'thinking', bubbleText: string) => {
      ctx.dispatch(s2 => ({
        ...s2,
        agents: s2.agents.map(a => a.id === agentId
          ? { ...a, chatLog: [...(a.chatLog ?? []), { id, role, text: bubbleText, at: Date.now() }].slice(-200) }
          : a),
      }))
    }
    const seal = (finalText?: string) => {
      if (streamId) {
        if (finalText !== undefined && finalText !== acc) ctx.updateChatLog(agentId, streamId, finalText)
        streamId = null
        acc = ''
      } else if (finalText !== undefined) {
        ctx.pushChatLog(agentId, { role: 'assistant', text: finalText })
      }
    }
    await runChatTurn(
      buildChatCfg({ ...chatType, model: agent.chatModel || chatType.model }, st),
      () => ctx.stateRef.current.agents.find(a => a.id === agentId),
      skills,
      mcp,
      text,
      history,
      e => {
        if (e.kind === 'delta') {
          acc += e.text
          if (!streamId) {
            streamId = mkId('cm')
            appendBubble(streamId, 'assistant', acc)
          } else {
            ctx.updateChatLog(agentId, streamId, acc)
          }
        } else if (e.kind === 'thinking') {
          thinkAcc += e.text
          if (!thinkId) {
            thinkId = mkId('ct')
            appendBubble(thinkId, 'thinking', thinkAcc)
          } else {
            ctx.updateChatLog(agentId, thinkId, thinkAcc)
          }
        } else if (e.kind === 'round') {
          seal()
          thinkId = null
          thinkAcc = ''
        } else if (e.kind === 'text') {
          seal(e.text)
          thinkId = null
          thinkAcc = ''
        } else {
          ctx.pushChatLog(agentId, { role: 'tool', text: e.text })
        }
      },
      persona || undefined,
    )
    seal()
    // auto-title: after a successful turn, chats still carrying the default
    // type name get a short LLM-derived title (a manual rename always wins)
    if (ctx.stateRef.current.agents.find(a => a.id === agentId)?.nameIsDefault) {
      void (async () => {
        try {
          const reply = (ctx.stateRef.current.agents.find(a => a.id === agentId)?.chatLog ?? [])
            .filter(m => m.role === 'assistant').map(m => m.text).join(' ').slice(0, 400)
          const res = await callApi(
            buildChatCfg({ ...chatType, model: agent.chatModel || chatType.model }, st),
            'You name chat conversations. Reply with ONLY a concise 2-5 word title for the conversation — no quotes, no trailing punctuation.',
            [{ role: 'user', content: `Conversation so far:\nuser: ${text.slice(0, 600)}\nassistant: ${reply}\n\nName this conversation.` }],
            [],
          )
          const title = res.content.filter(b => b.type === 'text').map(b => b.text).join(' ')
            .trim().split('\n')[0].replace(/^["'“”]+|["'“”.]+$/g, '').slice(0, 60).trim()
          if (!title) return
          ctx.dispatch(s2 => ({
            ...s2,
            agents: s2.agents.map(a => a.id === agentId && a.nameIsDefault
              ? { ...a, name: title, short: title.slice(0, 2).toUpperCase(), nameIsDefault: false }
              : a),
          }))
        } catch { /* keep the default name */ }
      })()
    }
  } catch (e) {
    console.error('[yaam] chat turn failed:', e) // reaches the dev/webview log for debugging
    ctx.pushChatLog(agentId, { role: 'assistant', text: `Error: ${e instanceof Error ? e.message : String(e)}` })
  } finally {
    ctx.busy.current.delete(agentId)
    ctx.dispatch(s => ({ ...s, agents: s.agents.map(a => (a.id === agentId ? { ...a, status: 'idle' as const, attention: false } : a)) }))
  }
}

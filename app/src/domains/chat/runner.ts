// Chat-mode agent turn: an in-app Claude-Desktop-style loop (files/exec/skills/
// MCP tools) with streamed answer + reasoning bubbles and one-shot auto-titling.
// Extracted from the provider; operates on the stable refs/callbacks in `ctx`.
import type { MutableRefObject } from 'react'
import type { AppState, ChatMsg } from '../../core/types'
import type { ApiMessage } from '../../master'
import type { McpSession } from '../../core/mcp'
import type { CatalogSkill } from '../../core/skills'
import { buildChatCfg, callApi, chatTypeHasCreds } from '../../llm/client'
import type { ApiContentBlock } from '../../llm/client'
import { runChatTurn } from './agent'
import type { ChatAppPort } from './agent'
import { mkId } from '../../shared/id'
import type { AbortRegistry } from '../../core/abort-registry'
import { isAbortError } from '../../core/abort-registry'

export interface ChatCtx {
  stateRef: MutableRefObject<AppState>
  dispatch: (f: (s: AppState) => AppState) => void
  busy: Set<string>
  /** per-chat cancellation — aborted when the chat is deleted */
  aborts: AbortRegistry
  histories: Map<string, ApiMessage[]>
  mcpSessions: MutableRefObject<Map<string, McpSession>>
  skillCatalogs: MutableRefObject<Map<string, CatalogSkill[]>>
  pushChatLog: (id: string, msg: Omit<ChatMsg, 'id' | 'at'>) => string
  updateChatLog: (agentId: string, msgId: string, text: string) => void
  flash: (t: string) => void
  refreshSkillCatalog: (id: string) => Promise<string>
  /** ask-mode gate: pending tool approvals by chat-message id */
  pendingApprovals: Map<string, { agentId: string; resolve: (ok: boolean) => void }>
}

/** One file attached to an outgoing chat message. Text-ish files (and
 *  extracted PDF/office text) inline into the prompt; images become vision
 *  blocks. `path` lets the agent reach the original file with its tools. */
export interface ChatAttachment {
  name: string
  kind: 'text' | 'image'
  text?: string
  mediaType?: string
  dataB64?: string
  path?: string
}

/** App-level tools (board/schedules/skills) backed by the store — the chat
 *  agent's bridge into YAAM's own orchestration surfaces. */
function makeAppPort(ctx: ChatCtx, agentId: string): ChatAppPort {
  return {
    requestApproval: (tool, preview) => {
      const msgId = ctx.pushChatLog(agentId, { role: 'tool', text: `${tool} → ${preview}`, approval: 'pending' })
      return new Promise<boolean>(resolve => {
        ctx.pendingApprovals.set(msgId, { agentId, resolve })
        // an aborted/stopped turn must not leave the promise hanging
        ctx.aborts.signal(agentId).addEventListener('abort', () => {
          if (ctx.pendingApprovals.delete(msgId)) resolve(false)
        }, { once: true })
      })
    },
    listBoardTasks: () => {
      const tasks = ctx.stateRef.current.tasks
      if (!tasks.length) return '(board is empty)'
      return tasks.map(t => `${t.id} [${t.col}] ${t.title}${t.watcherNote ? ` — ${t.watcherNote}` : ''}`).join('\n')
    },
    addBoardTask: (title, description, criteria) => {
      if (!title.trim()) return 'error: title is required'
      const id = mkId('t')
      ctx.dispatch(s => ({
        ...s,
        tasks: s.tasks.concat([{ id, title: title.trim(), col: 'backlog', agentId: null, description, criteria }]),
      }))
      return `added board task ${id} to the backlog — the user can start it from the Board view`
    },
    listSchedules: () => {
      const crons = ctx.stateRef.current.crons
      if (!crons.length) return '(no schedules)'
      return crons.map(c => `${c.id} [${c.on ? 'on' : 'off'}] ${c.name} — ${c.at ? `once at ${new Date(c.at).toLocaleString()}` : c.schedule}`).join('\n')
    },
    addSchedule: (name, cronExpr, atIso, taskTitle, description) => {
      if (!name.trim() || !taskTitle.trim()) return 'error: name and task_title are required'
      if (!cronExpr === !atIso) return 'error: pass exactly one of cron / at'
      let at: number | undefined
      if (atIso) {
        at = Date.parse(atIso)
        if (Number.isNaN(at)) return `error: could not parse "${atIso}" as a datetime`
        if (at < Date.now()) return `error: ${atIso} is in the past`
      }
      const id = mkId('c')
      ctx.dispatch(s => ({
        ...s,
        crons: s.crons.concat([{
          id, name: name.trim(), schedule: cronExpr ?? '', human: cronExpr ?? `once at ${new Date(at!).toLocaleString()}`,
          target: 'board task', agent: '', color: '#7FD1FF', on: true, built: false, last: '—', at,
          boardTask: { title: taskTitle.trim(), description },
        }]),
      }))
      return `created schedule ${id} (“${name.trim()}”) — it will add the board task when it fires`
    },
    saveSkill: (name, description, body) => {
      const slug = name.trim()
      const existing = ctx.stateRef.current.skills.find(k => k.name.toLowerCase() === slug.toLowerCase())
      ctx.dispatch(s => existing
        ? { ...s, skills: s.skills.map(k => k.id === existing.id ? { ...k, description, body } : k) }
        : { ...s, skills: s.skills.concat([{ id: mkId('sk'), name: slug, description, body }]) })
      return `${existing ? 'updated' : 'saved'} skill “${slug}” — invocable as /${slug}`
    },
  }
}

/** Run one chat-agent turn, streaming deltas/reasoning/tool traces into the UI. */
export async function runChatMessageTurn(ctx: ChatCtx, agentId: string, text: string, atts?: ChatAttachment[]) {
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
  if (ctx.busy.has(agentId)) {
    ctx.flash('Chat agent is still working on the previous message')
    return
  }
  ctx.busy.add(agentId)
  // the visible bubble carries attachment markers; payloads go only to the API
  const visible = atts?.length ? `${text}\n\n${atts.map(a => `📎 ${a.name}`).join(' · ')}` : text
  ctx.pushChatLog(agentId, { role: 'user', text: visible })
  ctx.dispatch(s => ({ ...s, agents: s.agents.map(a => (a.id === agentId ? { ...a, status: 'running' as const } : a)) }))
  try {
    let history = ctx.histories.get(agentId)
    if (!history) {
      // after a restart the private API history is gone — rebuild it from
      // the persisted visible transcript (tool traces excluded)
      history = (agent.chatLog ?? [])
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .map(m => ({ role: m.role === 'user' ? 'user' as const : 'assistant' as const, content: m.text }))
      while (history.length && history[0].role !== 'user') history.shift()
      ctx.histories.set(agentId, history)
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
    // slash-command skill invocation: "/name rest" injects the skill body
    // deterministically instead of hoping the model calls load_skill
    let apiText = text
    const slash = text.match(/^\/([\w][\w.-]*)[ \t]?([\s\S]*)$/)
    if (slash) {
      const skill = skills.find(k => k.name.toLowerCase() === slash[1].toLowerCase())
      if (!skill) {
        ctx.pushChatLog(agentId, { role: 'assistant', text: `No skill named “${slash[1]}”. Available: ${skills.map(k => `\`${k.name}\``).join(', ') || '(none)'}` })
        return
      }
      const rest = slash[2].trim()
      apiText = `The user invoked the skill "${skill.name}" with a slash command — follow it now.\n\n<skill name="${skill.name}">\n${skill.body}\n</skill>${rest ? `\n\nUser input: ${rest}` : ''}`
    }
    // attachments: text extracts inline into the prompt; images become vision blocks
    let apiContent: string | ApiContentBlock[] = apiText
    if (atts?.length) {
      const textAtts = atts.filter(a => a.kind === 'text')
      const imgAtts = atts.filter(a => a.kind === 'image' && a.dataB64)
      const inlined = textAtts.map(a =>
        `\n\n<attachment name="${a.name}"${a.path ? ` path="${a.path}"` : ''}>\n${(a.text ?? '').slice(0, 60_000)}\n</attachment>`).join('')
      const full = apiText + inlined
      apiContent = imgAtts.length
        ? [
            { type: 'text', text: full },
            ...imgAtts.map(a => ({ type: 'image', source: { type: 'base64' as const, media_type: a.mediaType ?? 'image/png', data: a.dataB64! } })),
          ]
        : full
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
      apiContent,
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
      ctx.aborts.signal(agentId),
      makeAppPort(ctx, agentId),
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
    // the chat was deleted mid-reply — stop quietly, don't push an error bubble
    if (isAbortError(e) || ctx.aborts.signal(agentId).aborted) return
    console.error('[yaam] chat turn failed:', e) // reaches the dev/webview log for debugging
    ctx.pushChatLog(agentId, { role: 'assistant', text: `Error: ${e instanceof Error ? e.message : String(e)}` })
  } finally {
    ctx.busy.delete(agentId)
    ctx.aborts.clear(agentId)
    ctx.dispatch(s => ({ ...s, agents: s.agents.map(a => (a.id === agentId ? { ...a, status: 'idle' as const, attention: false } : a)) }))
  }
}

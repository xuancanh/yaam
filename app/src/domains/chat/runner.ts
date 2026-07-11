// Chat-mode agent turn: an in-app Claude-Desktop-style loop (files/exec/skills/
// MCP tools) with streamed answer + reasoning bubbles and one-shot auto-titling.
// Extracted from the provider; operates on the stable refs/callbacks in `ctx`.
import type { MutableRefObject } from 'react'
import type { Agent, AppState, ChatAttachmentRecord, ChatMsg, ChatToolEvent, ChatTurn } from '../../core/types'
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
import { readFileB64 } from '../../core/native'
import { ESTIMATED_OUTPUT_COST_PER_KTOK } from '../../core/usage'
import { buildContextSummary, chatBudgetState } from './turns'
import { formatHits, memoryDigest, searchMemory, withMemoryAppend, wsMemory } from '../master/assistant-memory'
import { recordDecision } from '../master/harness-stats'
import { LESSONS_FILE, JOURNAL_FILE, appendBrainFile, commitBrain, durablePromptSection, journalEntry, loadBrain, reflectTranscript, searchKnowledge } from './durable-brain'

/** quick replies proposed mid-turn, attached to the final bubble at seal time */
const pendingReplies = new Map<string, string[]>()
const reflectingConversations = new Set<string>()

const compactedSummaryMessage = (summary: string): ApiMessage => ({
  role: 'user',
  content: `[The conversation so far was compacted to save context. Structured summary — treat it as your memory of everything above:]\n\n${summary}\n\n[Continue seamlessly; the user still sees the full transcript.]`,
})

/** Rebuild private provider history after a restart. A compacted chat starts
 *  from its durable summary plus only the visible turns created afterwards. */
export function rebuildChatHistory(agent: Agent): ApiMessage[] {
  const visible: ApiMessage[] = (agent.chatLog ?? [])
    .filter(m => (m.role === 'user' || m.role === 'assistant') && (!agent.chatCompactedAt || m.at > agent.chatCompactedAt))
    .map(m => ({ role: m.role === 'user' ? 'user' as const : 'assistant' as const, content: m.text }))
  const history = agent.chatContextSummary && agent.chatCompactedAt
    ? [compactedSummaryMessage(agent.chatContextSummary), { role: 'assistant' as const, content: 'Understood — continuing from the compacted summary.' }, ...visible]
    : visible
  while (history.length && history[0].role !== 'user') history.shift()
  return history
}

/** The durable agent a conversation belongs to, if any. */
function durableAgentOf(ctx: ChatCtx, agentId: string) {
  const st = ctx.stateRef.current
  const session = st.agents.find(a => a.id === agentId)
  return session?.durableAgentId ? (st.durableAgents ?? []).find(d => d.id === session.durableAgentId && !d.archived) : undefined
}

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
  /** surface an event in the notification tray (and the OS when unfocused) */
  notify: (kind: 'escalate' | 'done' | 'cron', title: string, detail: string, agentId: string | null) => void
  refreshSkillCatalog: (id: string) => Promise<string>
  /** ask-mode gate: pending tool approvals by chat-message id */
  pendingApprovals: Map<string, { agentId: string; key: string; resolve: (decision: 'once' | 'always' | 'deny') => void }>
}

/** One file attached to an outgoing chat message. Text-ish files (and
 *  extracted PDF/office text) inline into the prompt; images become vision
 *  blocks. `path` lets the agent reach the original file with its tools. */
export interface ChatAttachment extends ChatAttachmentRecord {
  name: string
  kind: 'text' | 'image'
  text?: string
  mediaType?: string
  dataB64?: string
  path?: string
}

function attachmentRecord(a: ChatAttachment): ChatAttachmentRecord {
  return { name: a.name, kind: a.kind, text: a.text, mediaType: a.mediaType, path: a.path }
}

/** App-level tools (board/schedules/skills) backed by the store — the chat
 *  agent's bridge into YAAM's own orchestration surfaces. */
function makeAppPort(ctx: ChatCtx, agentId: string, turnId: string): ChatAppPort {
  return {
    requestApproval: (tool, preview) => {
      const key = `${tool}\u0000${preview}`
      const agent = ctx.stateRef.current.agents.find(a => a.id === agentId)
      if (agent?.approvedToolCalls?.includes(key)) return Promise.resolve('always')
      const msgId = ctx.pushChatLog(agentId, { role: 'tool', text: `${tool} → ${preview}`, approval: 'pending', turnId })
      return new Promise<'once' | 'always' | 'deny'>(resolve => {
        ctx.pendingApprovals.set(msgId, { agentId, key, resolve })
        // an aborted/stopped turn must not leave the promise hanging
        ctx.aborts.signal(agentId).addEventListener('abort', () => {
          if (ctx.pendingApprovals.delete(msgId)) resolve('deny')
        }, { once: true })
      })
    },
    requestCapability: (capability, reason) => {
      const st = ctx.stateRef.current
      const conv = st.agents.find(a => a.id === agentId)
      const durable = conv?.durableAgentId ? (st.durableAgents ?? []).find(d => d.id === conv.durableAgentId) : undefined
      const who = durable?.name ?? conv?.name ?? 'a chat agent'
      const id = mkId('t')
      const description = [
        `Capability request from “${who}”${conv && conv.name !== who ? ` (conversation: ${conv.name})` : ''}.`,
        `Requested: ${capability}`,
        `Why: ${reason}`,
        'Grant it in Settings (MCP servers / skill registries / agent types) or the agent profile, then tell the agent it is available.',
      ].join('\n\n')
      ctx.dispatch(s => ({
        ...s,
        tasks: s.tasks.concat([{ id, title: `Grant ${who}: ${capability}`.slice(0, 72), col: 'backlog', agentId: null, description, criteria: [] }]),
      }))
      ctx.notify('escalate', `${who} requests a capability`, capability.slice(0, 140), agentId)
      return `Request filed for the user to review (board task ${id}). It is NOT granted yet — continue with what you can do meanwhile.`
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
    remember: fact => {
      // facts land in the shared multi-file store (notes) so monitors, watchers
      // and Master benefit too; the legacy chatMemory string stays readable
      const st = ctx.stateRef.current
      const wid = st.agents.find(a => a.id === agentId)?.workspaceId ?? st.activeWorkspace
      ctx.dispatch(s => withMemoryAppend(s, 'notes', fact, wid))
      return `remembered: ${fact.trim()}`
    },
    memoryLookup: query => {
      const st = ctx.stateRef.current
      const wid = st.agents.find(a => a.id === agentId)?.workspaceId ?? st.activeWorkspace
      return formatHits(searchMemory(wsMemory(st, wid), query))
    },
    suggestReplies: replies => {
      // stash for this turn: the chips attach to the final assistant bubble
      // when the turn seals; recording now lets click/ignore resolve it
      pendingReplies.set(agentId, replies)
      ctx.dispatch(s => ({
        ...s,
        harnessLog: recordDecision(s.harnessLog, { role: 'chat', kind: 'reply', agentId, text: replies.join(' · ').slice(0, 160) }),
      }))
      return `${replies.length} quick replies will be offered under your answer`
    },
    knowledgeSearch: async query => {
      const durable = durableAgentOf(ctx, agentId)
      if (!durable) return 'this conversation has no durable agent'
      return searchKnowledge(durable, query)
    },
    learnLesson: async lesson => {
      const durable = durableAgentOf(ctx, agentId)
      if (durable?.homeDir?.trim()) {
        await appendBrainFile(durable, LESSONS_FILE, `- ${lesson.replace(/\s+/g, ' ').trim()}`)
        void commitBrain(durable, `lesson · ${lesson.slice(0, 40)}`)
        return `lesson recorded in ${LESSONS_FILE}`
      }
      // no home folder (built-in assistant): shared workspace memory instead
      const st = ctx.stateRef.current
      const wid = st.agents.find(a => a.id === agentId)?.workspaceId ?? st.activeWorkspace
      ctx.dispatch(s => withMemoryAppend(s, 'notes', lesson, wid))
      return 'lesson recorded in the shared workspace memory'
    },
    updateSelf: patch => {
      const durable = durableAgentOf(ctx, agentId)
      if (!durable) return 'this conversation has no durable agent profile to update'
      if (patch.homeDir && durable.builtin) return 'the built-in assistant cannot take a home folder — create a dedicated agent instead'
      const applied: string[] = []
      ctx.dispatch(s => ({
        ...s,
        durableAgents: (s.durableAgents ?? []).map(d => {
          if (d.id !== durable.id) return d
          const next = { ...d }
          if (patch.name) { next.name = patch.name.slice(0, 60); applied.push('name') }
          if (patch.role) { next.role = patch.role.slice(0, 120); applied.push('role') }
          if (patch.charter) { next.charter = patch.charter.slice(0, 8000); applied.push('charter') }
          if (patch.model) { next.model = patch.model; applied.push('model') }
          if (patch.homeDir) { next.homeDir = patch.homeDir; applied.push('home folder') }
          return next
        }),
      }))
      return applied.length
        ? `profile updated (${applied.join(', ')}) — the new charter/settings apply from your next turn`
        : 'nothing to change'
    },
    updateDashboard: markdown => {
      const durable = durableAgentOf(ctx, agentId)
      if (!durable) return 'this conversation has no durable agent — only durable agents have a home page'
      ctx.dispatch(s => ({
        ...s,
        durableAgents: (s.durableAgents ?? []).map(d => d.id === durable.id
          ? { ...d, dashboard: markdown.trim().slice(0, 24_000), dashboardAt: Date.now() }
          : d),
      }))
      return 'dashboard updated — the user sees it on your agent home page'
    },
    saveApp: (name, description, html) => {
      const durable = durableAgentOf(ctx, agentId)
      if (!durable) return 'this conversation has no durable agent — only durable agents have mini apps'
      const slug = name.slice(0, 60)
      const existing = (durable.apps ?? []).find(a => a.name.toLowerCase() === slug.toLowerCase())
      if (!existing && (durable.apps ?? []).length >= 12) return 'error: app limit reached (12) — delete_app one first'
      const app = {
        id: existing?.id ?? mkId('app'),
        name: slug,
        description: description.slice(0, 200) || undefined,
        html: html.slice(0, 300_000),
        updatedAt: Date.now(),
      }
      ctx.dispatch(s => ({
        ...s,
        durableAgents: (s.durableAgents ?? []).map(d => d.id === durable.id
          ? { ...d, apps: existing ? (d.apps ?? []).map(a => (a.id === existing.id ? app : a)) : [...(d.apps ?? []), app] }
          : d),
      }))
      return `${existing ? 'updated' : 'created'} mini app “${slug}” — it renders sandboxed on your home page (no network; inline everything)`
    },
    deleteApp: name => {
      const durable = durableAgentOf(ctx, agentId)
      if (!durable) return 'this conversation has no durable agent'
      const target = (durable.apps ?? []).find(a => a.name.toLowerCase() === name.toLowerCase())
      if (!target) return `no mini app named “${name}” — you have: ${(durable.apps ?? []).map(a => a.name).join(', ') || '(none)'}`
      ctx.dispatch(s => ({
        ...s,
        durableAgents: (s.durableAgents ?? []).map(d => d.id === durable.id
          ? { ...d, apps: (d.apps ?? []).filter(a => a.id !== target.id) }
          : d),
      }))
      return `deleted mini app “${target.name}”`
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
  const budget = chatBudgetState(agent)
  if (budget.blocked) {
    ctx.pushChatLog(agentId, { role: 'user', text })
    ctx.pushChatLog(agentId, { role: 'assistant', text: `Token budget reached (${budget.used.toLocaleString()} / ${budget.budget.toLocaleString()}). Increase or disable the budget in the chat header before continuing.` })
    return
  }
  if (ctx.busy.has(agentId)) {
    ctx.flash('Chat agent is still working on the previous message')
    return
  }
  ctx.busy.add(agentId)
  const runSignal = ctx.aborts.signal(agentId)
  const turnId = mkId('turn')
  const startedAt = Date.now()
  const slashName = text.match(/^\/([\w][\w.-]*)/)?.[1]
  const turn: ChatTurn = {
    id: turnId,
    at: startedAt,
    startedAt,
    status: 'running',
    model: agent.chatModel || chatType.model,
    input: { text, attachments: (atts ?? []).map(attachmentRecord), ...(slashName ? { skill: slashName } : {}) },
    tools: [],
  }
  const updateTurn = (patch: Partial<ChatTurn>) => ctx.dispatch(s => ({
    ...s,
    agents: s.agents.map(a => a.id === agentId
      ? { ...a, chatTurns: (a.chatTurns ?? []).map(t => t.id === turnId ? { ...t, ...patch } : t) }
      : a),
  }))
  const addToolEvent = (event: ChatToolEvent) => ctx.dispatch(s => ({
    ...s,
    agents: s.agents.map(a => a.id === agentId
      ? { ...a, chatTurns: (a.chatTurns ?? []).map(t => t.id === turnId ? { ...t, tools: [...t.tools, event] } : t) }
      : a),
  }))
  // the visible bubble carries attachment markers; payloads go only to the API
  const visible = atts?.length ? `${text}\n\n${atts.map(a => `📎 ${a.name}`).join(' · ')}` : text
  ctx.pushChatLog(agentId, { role: 'user', text: visible, turnId })
  ctx.dispatch(s => ({
    ...s,
    agents: s.agents.map(a => a.id === agentId
      // pending feedback is consumed by this turn (injected below) — clear it
      ? { ...a, status: 'running' as const, chatTurns: [...(a.chatTurns ?? []), turn].slice(-200), chatPendingFeedback: undefined }
      : a),
  }))
  let autoCompact = false
  try {
    let history = ctx.histories.get(agentId)
    if (!history) {
      // after a restart the private API history is gone — rebuild it from
      // the persisted visible transcript or its durable compaction cutoff
      history = rebuildChatHistory(agent)
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
        const reply = `No skill named “${slash[1]}”. Available: ${skills.map(k => `\`${k.name}\``).join(', ') || '(none)'}`
        ctx.pushChatLog(agentId, { role: 'assistant', text: reply, turnId })
        updateTurn({ status: 'complete', completedAt: Date.now(), assistantText: reply })
        return
      }
      const rest = slash[2].trim()
      apiText = `The user invoked the skill "${skill.name}" with a slash command — follow it now.\n\n<skill name="${skill.name}">\n${skill.body}\n</skill>${rest ? `\n\nUser input: ${rest}` : ''}`
    }
    // Replayed image attachments retain a path but intentionally do not persist
    // their base64 payload. Reload it only when the turn is actually replayed.
    const resolvedAtts = await Promise.all((atts ?? []).map(async a => {
      if (a.kind !== 'image' || a.dataB64 || !a.path) return a
      try { return { ...a, dataB64: await readFileB64(a.path) } } catch { return a }
    }))
    // attachments: text extracts inline into the prompt; images become vision blocks
    let apiContent: string | ApiContentBlock[] = apiText
    if (resolvedAtts.length) {
      const textAtts = resolvedAtts.filter(a => a.kind === 'text')
      const imgAtts = resolvedAtts.filter(a => a.kind === 'image' && a.dataB64)
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
    const persona = chatType.systemPrompt ?? ''
    // streaming: deltas grow one live assistant bubble; a tool round seals
    // the current bubble; the final text replaces (or creates) it
    let streamId: string | null = null
    let acc = ''
    let thinkId: string | null = null
    let thinkAcc = ''
    // Coalesce streamed delta writes to at most one store dispatch per animation
    // frame (a fast token stream otherwise dispatches per token, churning global
    // state). The latest text per bubble is force-flushed synchronously at every
    // seal/round/text and at turn end, so the committed content is always exact.
    const pendingText = new Map<string, string>()
    let rafId: number | null = null
    const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn: () => void) => window.setTimeout(fn, 16) as unknown as number
    const cancelRaf = typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : (id: number) => window.clearTimeout(id)
    const flushFrame = () => {
      rafId = null
      for (const [id, t] of pendingText) ctx.updateChatLog(agentId, id, t)
      pendingText.clear()
    }
    const flushNow = () => { if (rafId !== null) { cancelRaf(rafId); rafId = null } flushFrame() }
    const batchUpdate = (id: string, t: string) => {
      pendingText.set(id, t)
      if (rafId === null) rafId = raf(flushFrame)
    }
    const appendBubble = (id: string, role: 'assistant' | 'thinking', bubbleText: string) => {
      ctx.dispatch(s2 => ({
        ...s2,
        agents: s2.agents.map(a => a.id === agentId
          ? { ...a, chatLog: [...(a.chatLog ?? []), { id, role, text: bubbleText, at: Date.now(), turnId }].slice(-200) }
          : a),
      }))
    }
    const seal = (finalText?: string) => {
      flushNow() // commit any buffered delta text before sealing the bubble
      if (streamId) {
        if (finalText !== undefined && finalText !== acc) ctx.updateChatLog(agentId, streamId, finalText)
        streamId = null
        acc = ''
      } else if (finalText !== undefined) {
        ctx.pushChatLog(agentId, { role: 'assistant', text: finalText, turnId })
      }
      if (finalText !== undefined) updateTurn({ assistantText: finalText })
    }
    pendingReplies.delete(agentId) // an aborted turn must not leak stale chips
    // durable agents carry their identity + file brain into every turn
    const durableAgent = durableAgentOf(ctx, agentId)
    const durableSection = durableAgent
      ? durablePromptSection(durableAgent, await loadBrain(durableAgent).catch(() => ({ lessons: '', journal: '' })))
      : undefined
    const usage = await runChatTurn(
      buildChatCfg({ ...chatType, model: agent.chatModel || chatType.model, effort: agent.chatEffort }, st),
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
            batchUpdate(streamId, acc)
          }
        } else if (e.kind === 'thinking') {
          thinkAcc += e.text
          if (!thinkId) {
            thinkId = mkId('ct')
            appendBubble(thinkId, 'thinking', thinkAcc)
          } else {
            batchUpdate(thinkId, thinkAcc)
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
          flushNow() // commit buffered deltas before inserting the tool trace
          ctx.pushChatLog(agentId, { role: 'tool', text: e.text, turnId })
          addToolEvent(e.tool ?? {
            id: mkId('tool'), at: Date.now(), name: 'notice', input: '', result: e.text, status: 'completed',
          })
        }
      },
      persona || undefined,
      runSignal,
      makeAppPort(ctx, agentId, turnId),
      // legacy single-string memory + the freshest shared memory-file lines
      [
        ctx.stateRef.current.chatMemory?.[agent.workspaceId ?? ctx.stateRef.current.activeWorkspace],
        memoryDigest(wsMemory(ctx.stateRef.current, agent.workspaceId), ['notes', 'preferences', 'corrections']),
      ].filter(Boolean).join('\n') || undefined,
      agent.chatCompactedAt ? undefined : agent.chatContextSummary,
      // fresh ratings ride along once so the agent visibly closes the loop
      [
        ctx.stateRef.current.settings.assistantPrompts?.chat,
        agent.chatPendingFeedback?.length
          ? `SINCE YOUR LAST REPLY the user rated your work:\n${agent.chatPendingFeedback.map(f => `- ${f}`).join('\n')}\nOpen your reply with ONE short sentence acknowledging the adjustment you are making, then apply it.`
          : '',
      ].filter(Boolean).join('\n\n') || undefined,
      durableSection,
    )
    seal()
    // attach quick replies (suggest_replies) to the final assistant bubble
    {
      const replies = pendingReplies.get(agentId)
      pendingReplies.delete(agentId)
      if (replies?.length) {
        ctx.dispatch(s2 => ({
          ...s2,
          agents: s2.agents.map(a => {
            if (a.id !== agentId) return a
            const log = a.chatLog ?? []
            let lastIx = -1
            for (let i = log.length - 1; i >= 0; i--) {
              if (log[i].role === 'assistant') { lastIx = i; break }
            }
            if (lastIx < 0) return a
            return { ...a, chatLog: log.map((m, i) => (i === lastIx ? { ...m, suggestions: replies } : m)) }
          }),
        }))
      }
    }
    updateTurn({ status: 'complete', completedAt: Date.now(), ...(usage ? { usage } : {}) })
    if (usage) {
      ctx.dispatch(s2 => ({
        ...s2,
        agents: s2.agents.map(a => a.id === agentId ? {
          ...a,
          used: a.used + (usage.inputTokens + usage.outputTokens) / 1000,
          cost: a.cost + usage.outputTokens / 1000 * ESTIMATED_OUTPUT_COST_PER_KTOK,
        } : a),
      }))
    }
    const currentTurns = ctx.stateRef.current.agents.find(a => a.id === agentId)?.chatTurns ?? []
    ctx.dispatch(s2 => ({
      ...s2,
      agents: s2.agents.map(a => a.id === agentId
        ? { ...a, ...(!a.chatCompactedAt ? { chatContextSummary: buildContextSummary(currentTurns) } : {}) }
        : a),
    }))
    // durable agents: distill enough-new conversation into journal + lessons
    // in the background (threshold lives inside; failures are silent)
    void reflectDurableConversation(ctx, agentId).catch(() => {})
    // auto-compact: when this turn's input context reached the limit, distill
    // the API history into a summary in the background (0 disables)
    const compactAt = ctx.stateRef.current.settings.chatCompactTokens ?? DEFAULT_COMPACT_TOKENS
    if (usage && compactAt > 0 && usage.inputTokens >= compactAt) {
      autoCompact = true
    }
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
    // the chat was deleted mid-reply — stop quietly, don't push an error bubble.
    // (any buffered delta frame still pending is a harmless no-op if the chat is
    // gone; the final seal on the success path already flushed it.)
    if (isAbortError(e) || runSignal.aborted) {
      updateTurn({ status: 'stopped', completedAt: Date.now() })
      return
    }
    console.error('[yaam] chat turn failed:', e) // reaches the dev/webview log for debugging
    const error = e instanceof Error ? e.message : String(e)
    updateTurn({ status: 'failed', completedAt: Date.now(), error })
    ctx.pushChatLog(agentId, { role: 'assistant', text: `Error: ${error}`, turnId })
  } finally {
    const released = ctx.aborts.clear(agentId, runSignal)
    if (released || !ctx.aborts.has(agentId)) {
      ctx.busy.delete(agentId)
      ctx.dispatch(s => ({ ...s, agents: s.agents.map(a => (a.id === agentId ? { ...a, status: 'idle' as const, attention: false } : a)) }))
    }
  }
  if (autoCompact) void compactConversation(ctx, agentId).catch(() => {})
}

/** Distill a durable-agent conversation's new messages into its journal and
 *  lessons. Auto-triggered after turns once ≥8 fresh messages accumulated;
 *  `force` (manual "Reflect now") skips the threshold. Returns a status line. */
export async function reflectDurableConversation(ctx: ChatCtx, conversationId: string, force = false): Promise<string> {
  const st = ctx.stateRef.current
  const conv = st.agents.find(a => a.id === conversationId)
  const durable = conv?.durableAgentId ? (st.durableAgents ?? []).find(d => d.id === conv.durableAgentId) : undefined
  if (!conv || !durable) return 'not a durable-agent conversation'
  const since = conv.reflectedAt ?? 0
  const fresh = (conv.chatLog ?? []).filter(m => m.at > since && (m.role === 'user' || m.role === 'assistant'))
  if (fresh.length < (force ? 2 : 8)) return 'not enough new conversation to reflect on'
  const chatType = st.chatAgentTypes.find(t => t.id === conv.chatTypeId) ?? st.chatAgentTypes.find(t => t.enabled)
  if (!chatType || !chatTypeHasCreds(chatType, st.settings)) return 'no chat credentials available for reflection'
  if (reflectingConversations.has(conversationId)) return 'reflection already in progress'
  reflectingConversations.add(conversationId)
  try {
    const reflection = await reflectTranscript(buildChatCfg(chatType, st.settings), durable, conv, since)
    if (!reflection) return 'nothing worth recording'
    if (durable.homeDir?.trim()) {
      await appendBrainFile(durable, JOURNAL_FILE, journalEntry(conv.name, reflection.journal))
      for (const l of reflection.lessons) await appendBrainFile(durable, LESSONS_FILE, `- ${l}`)
      void commitBrain(durable, `reflection · ${conv.name.slice(0, 40)}`)
    } else if (reflection.lessons.length) {
      // brainless (built-in) agents keep lessons in the shared workspace memory
      ctx.dispatch(s => reflection.lessons.reduce((acc, l) => withMemoryAppend(acc, 'notes', l, conv.workspaceId), s))
    }
    ctx.dispatch(s => ({
      ...s,
      agents: s.agents.map(a => (a.id === conversationId ? { ...a, reflectedAt: Date.now() } : a)),
    }))
    return `reflected · journal updated${reflection.lessons.length ? ` · ${reflection.lessons.length} lesson(s) learned` : ''}`
  } finally {
    reflectingConversations.delete(conversationId)
  }
}

/** Default auto-compact trigger: one turn's input tokens reaching this. */
export const DEFAULT_COMPACT_TOKENS = 80_000

/** Compact a conversation's API context: distill the transcript into a
 *  structured summary, reseed the private history with it, and persist it as
 *  the context summary (so a restart keeps the compacted context too). The
 *  visible transcript is untouched. Returns a status line. */
export async function compactConversation(ctx: ChatCtx, agentId: string, force = false): Promise<string> {
  const st = ctx.stateRef.current
  const agent = st.agents.find(a => a.id === agentId)
  if (!agent || agent.kind !== 'chat') return 'not a chat session'
  if (ctx.busy.has(agentId)) return 'the agent is mid-turn — try again when it finishes'
  const msgs = (agent.chatLog ?? []).filter(m => (m.role === 'user' || m.role === 'assistant')
    && (!agent.chatCompactedAt || m.at > agent.chatCompactedAt))
  if (msgs.length < (force ? 2 : 8)) return 'nothing to compact yet'
  const chatType = st.chatAgentTypes.find(t => t.id === agent.chatTypeId) ?? st.chatAgentTypes.find(t => t.enabled)
  if (!chatType || !chatTypeHasCreds(chatType, st.settings)) return 'no chat credentials available for compaction'

  ctx.busy.add(agentId)
  ctx.dispatch(s => ({
    ...s,
    agents: s.agents.map(a => (a.id === agentId ? { ...a, status: 'running' as const, attention: false } : a)),
  }))
  try {
    const previous = agent.chatContextSummary && agent.chatCompactedAt
      ? `PREVIOUS COMPACTED SUMMARY:\n${agent.chatContextSummary}`
      : ''
    const freshLimit = Math.max(4_000, 28_000 - previous.length - 2)
    const fresh = msgs.map(m => `${m.role === 'user' ? 'USER' : 'AGENT'}: ${m.text.slice(0, 1500)}`).join('\n').slice(-freshLimit)
    const transcript = [previous, fresh].filter(Boolean).join('\n\n')
    const res = await callApi(
      buildChatCfg(chatType, st.settings),
      'You compact a long conversation so the agent can continue with a fraction of the context. Write a dense, structured summary the agent can rely on as its ONLY memory of the conversation: ' +
      'GOAL (what the user is trying to achieve) · CURRENT STATE (what has been done, key results) · DECISIONS & PREFERENCES (choices made, corrections given) · KEY FACTS (paths, names, commands, values that will be needed again) · OPEN ITEMS (what remains / what was in flight). ' +
      'Be specific — exact file paths, exact names. No preamble, no meta commentary.',
      [{ role: 'user', content: `Conversation to compact:\n\n${transcript}` }],
      [],
    )
    const summary = res.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim()
    if (!summary) return 'compaction produced nothing'

    // reseed the private API history: summary in, old rounds out
    const history = ctx.histories.get(agentId) ?? []
    const dropped = history.length
    history.length = 0
    history.push(compactedSummaryMessage(summary))
    history.push({ role: 'assistant', content: 'Understood — continuing from the compacted summary.' })
    ctx.histories.set(agentId, history)

    // persist: a restart rebuilds context from chatContextSummary
    const compactedAt = Date.now()
    ctx.dispatch(s => ({
      ...s,
      agents: s.agents.map(a => (a.id === agentId ? { ...a, chatContextSummary: summary.slice(0, 6000), chatCompactedAt: compactedAt } : a)),
    }))
    ctx.pushChatLog(agentId, { role: 'tool', text: `context compacted — ${dropped || msgs.length} entries distilled into a ${summary.length}-char summary` })
    return `compacted · ${dropped || msgs.length} context entries → ${summary.length}-char summary`
  } finally {
    ctx.busy.delete(agentId)
    ctx.dispatch(s => ({
      ...s,
      agents: s.agents.map(a => (a.id === agentId ? { ...a, status: 'idle' as const } : a)),
    }))
  }
}

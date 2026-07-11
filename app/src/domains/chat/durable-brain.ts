// A durable agent's file brain: LESSONS.md (self-maintained corrections and
// style learnings), JOURNAL.md (episodic log of past work), and knowledge/
// (whatever the agent files with its normal file tools) inside its homeDir.
// Files are the storage — transparent, portable, user-editable. Agents without
// a homeDir (the built-in assistant) fall back to the shared workspace memory.
import type { Agent, DurableAgent } from '../../core/types'
import { execCommand, readTextFile, writeTextFile } from '../../core/native'
import { callApi } from '../../llm/client'
import type { ApiContentBlock, LlmConfig } from '../../llm/client'

export const LESSONS_FILE = 'LESSONS.md'
export const JOURNAL_FILE = 'JOURNAL.md'

/** keep prompt injection bounded: freshest content wins */
const LESSONS_PROMPT_CHARS = 2400
const JOURNAL_PROMPT_CHARS = 1600
const FILE_CAP_CHARS = 60_000
const appendQueues = new Map<string, Promise<void>>()

export interface AgentBrain {
  lessons: string
  journal: string
}

const brainPath = (agent: DurableAgent, file: string) => `${agent.homeDir!.replace(/\/+$/, '')}/${file}`

/** Best-effort read of the agent's brain files; missing files read as empty. */
export async function loadBrain(agent: DurableAgent): Promise<AgentBrain> {
  if (!agent.homeDir?.trim()) return { lessons: '', journal: '' }
  const read = (file: string) => readTextFile(brainPath(agent, file)).catch(() => '')
  const [lessons, journal] = await Promise.all([read(LESSONS_FILE), read(JOURNAL_FILE)])
  return { lessons, journal }
}

/** Append one entry to a brain file (created with a header on first write),
 *  trimming the oldest content past the cap. */
export async function appendBrainFile(agent: DurableAgent, file: string, entry: string): Promise<void> {
  if (!agent.homeDir?.trim() || !entry.trim()) return
  const path = brainPath(agent, file)
  const previous = appendQueues.get(path) ?? Promise.resolve()
  const pending = previous.catch(() => {}).then(async () => {
    const cur = await readTextFile(path).catch(() => '')
    const header = cur ? '' : file === LESSONS_FILE
      ? `# Lessons — ${agent.name}\nCorrections and learnings this agent maintains about how to do its job.\n\n`
      : `# Journal — ${agent.name}\nEpisodic log of past work, distilled after conversations.\n\n`
    let next = `${cur || header}${cur && !cur.endsWith('\n') ? '\n' : ''}${entry.trim()}\n`
    if (next.length > FILE_CAP_CHARS) {
      const headerEnd = next.indexOf('\n\n')
      const prefix = headerEnd >= 0 && headerEnd < 4_000 ? next.slice(0, headerEnd + 2) : ''
      const body = next.slice(prefix.length)
      let tail = body.slice(-(FILE_CAP_CHARS - prefix.length))
      // When several entries remain, do not preserve a partial oldest line.
      const firstBreak = tail.indexOf('\n')
      if (body.length > tail.length && firstBreak >= 0 && firstBreak < tail.length - 1) tail = tail.slice(firstBreak + 1)
      next = `${prefix}${tail}`
    }
    await writeTextFile(path, next)
  })
  appendQueues.set(path, pending)
  try {
    await pending
  } finally {
    if (appendQueues.get(path) === pending) appendQueues.delete(path)
  }
}

/** The identity block injected at the TOP of a durable agent's system prompt:
 *  charter (stable, user-owned), freshest lessons, and recent journal. */
export function durablePromptSection(agent: DurableAgent, brain: AgentBrain): string {
  const tail = (s: string, max: number) => (s.length > max ? `…\n${s.slice(s.length - max)}` : s)
  const parts = [
    `YOUR IDENTITY — you are "${agent.name}"${agent.role ? ` (${agent.role})` : ''}, a durable agent: you persist across conversations, and your accumulated lessons/journal below ARE your continuity. `
    + (agent.homeDir
      ? `Your home folder is ${agent.homeDir} — your working dir AND your brain: maintain ${LESSONS_FILE} via the learn_lesson tool, file domain knowledge under knowledge/ with your normal file tools, and RETRIEVE from it with knowledge_search before answering anything your past self may already know.`
      : 'You have no home folder; persist learnings with learn_lesson (they land in the shared workspace memory).'),
    `YOUR CHARTER (your job description):\n${agent.charter.trim() || '(none yet — propose one with update_my_profile once you understand your job)'}`,
  ]
  parts.push(`YOUR HOME PAGE — the user's default view of you: a dashboard you maintain (update_dashboard, markdown) plus your mini apps (save_app — one self-contained HTML document each, rendered sandboxed with no network). `
    + (agent.dashboard?.trim()
      ? `Your dashboard was last updated ${agent.dashboardAt ? new Date(agent.dashboardAt).toISOString().slice(0, 10) : 'earlier'} — refresh it when your state meaningfully changes.`
      : 'Your dashboard is EMPTY — once you understand your job, publish a first dashboard with update_dashboard.')
    + ((agent.apps?.length ?? 0) > 0 ? ` Your mini apps: ${agent.apps!.map(a => a.name).join(', ')}.` : ' You can also grow reusable skills with save_skill.'))
  if (brain.lessons.trim()) parts.push(`YOUR LESSONS (you wrote these from past corrections — apply them):\n${tail(brain.lessons.trim(), LESSONS_PROMPT_CHARS)}`)
  if (brain.journal.trim()) parts.push(`YOUR RECENT JOURNAL (what you did before this conversation):\n${tail(brain.journal.trim(), JOURNAL_PROMPT_CHARS)}`)
  parts.push('RULES: (1) when the user corrects you or a job outcome teaches you something durable, record it with learn_lesson BEFORE moving on. (2) when lessons accumulate into a better way of working — or the user asks you to change how you operate — evolve your own charter/settings with update_my_profile, carrying forward everything still true; never silently discard the user\'s intent. That is how you improve over time.')
  return parts.join('\n\n')
}

// ---------------------------------------------------------------- reflection

const REFLECT_TOOL = [{
  name: 'submit_reflection',
  description: 'Submit the distilled reflection of this conversation.',
  input_schema: {
    type: 'object',
    properties: {
      journal: { type: 'string', description: '2-5 bullet lines: what was worked on, decisions, outcomes' },
      lessons: { type: 'array', items: { type: 'string' }, description: '0-3 durable lessons (corrections, preferences, better approaches). Empty when nothing generalizes.' },
    },
    required: ['journal'],
  },
}]

export interface Reflection {
  journal: string
  lessons: string[]
}

/** Distill one conversation into a journal entry + durable lessons. Returns
 *  null when the transcript is too thin to bother. */
export async function reflectTranscript(cfg: LlmConfig, agent: DurableAgent, conversation: Agent, sinceAt: number): Promise<Reflection | null> {
  const msgs = (conversation.chatLog ?? []).filter(m => m.at > sinceAt && (m.role === 'user' || m.role === 'assistant'))
  if (msgs.length < 2) return null
  const transcript = msgs.map(m => `${m.role === 'user' ? 'USER' : 'AGENT'}: ${m.text.slice(0, 1200)}`).join('\n').slice(-14_000)
  const res = await callApi(
    cfg,
    `You distill a finished conversation for the durable agent "${agent.name}"${agent.role ? ` (${agent.role})` : ''} so future conversations benefit. Journal = what happened (terse bullets, past tense). Lessons = ONLY durable, generalizable learnings — user corrections, stated preferences, approaches that failed/worked. No transient details. Call submit_reflection exactly once.`,
    [{ role: 'user', content: `Conversation "${conversation.name}":\n\n${transcript}` }],
    REFLECT_TOOL,
  )
  const call = res.content.find((b): b is ApiContentBlock => b.type === 'tool_use' && b.name === 'submit_reflection')
  const input = (call?.input ?? {}) as Record<string, unknown>
  const journal = typeof input.journal === 'string' ? input.journal.trim() : ''
  if (!journal) return null
  const lessons = Array.isArray(input.lessons)
    ? (input.lessons as unknown[]).filter((x): x is string => typeof x === 'string' && !!x.trim()).slice(0, 3)
    : []
  return { journal, lessons }
}

/** Format one journal entry with a date + conversation header. */
export function journalEntry(conversationName: string, journal: string, now = new Date()): string {
  const day = now.toISOString().slice(0, 10)
  return `## ${day} — ${conversationName}\n${journal.trim()}`
}

// ---------------------------------------------------------------- knowledge

/** Shell-quote one argument (POSIX). */
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

/** The grep sweep behind knowledge_search: case-insensitive, line-numbered,
 *  .git excluded, bounded output. One pattern alternating the query tokens. */
export function knowledgeSearchCommand(homeDir: string, query: string): string | null {
  const tokens = query.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(t => t.length > 1).slice(0, 6)
  if (!tokens.length) return null
  const pattern = tokens.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  return `grep -rin --include='*' --exclude-dir=.git -E ${shq(pattern)} ${shq(homeDir.replace(/\/+$/, ''))} 2>/dev/null | head -80`
}

/** Rank grep hits by how many query tokens each line matches (then keep file
 *  order), and trim to `limit` compact `file:line: text` rows. */
export function rankKnowledgeHits(grepOutput: string, query: string, homeDir: string, limit = 12): string[] {
  const tokens = query.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(t => t.length > 1)
  const base = homeDir.replace(/\/+$/, '') + '/'
  const scored = grepOutput.split('\n').filter(Boolean).map(line => {
    const low = line.toLowerCase()
    const score = tokens.reduce((n, t) => n + (low.includes(t) ? 1 : 0), 0)
    return { line: line.startsWith(base) ? line.slice(base.length) : line, score }
  })
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(h => h.line.length > 220 ? `${h.line.slice(0, 220)}…` : h.line)
}

/** Search the agent's whole home folder (brain files + knowledge/ + anything
 *  it filed) — the retrieval layer over the files-as-brain design. */
export async function searchKnowledge(agent: DurableAgent, query: string): Promise<string> {
  if (!agent.homeDir?.trim()) return 'this agent has no home folder to search'
  const cmd = knowledgeSearchCommand(agent.homeDir, query)
  if (!cmd) return 'query too short — use a few keywords'
  try {
    const { code, output } = await execCommand(cmd, undefined, 12_000)
    if (code !== 0 || !output.trim()) return 'no matches in the home folder'
    const hits = rankKnowledgeHits(output, query, agent.homeDir)
    return hits.length ? hits.join('\n') : 'no matches in the home folder'
  } catch (e) {
    return `search failed: ${e instanceof Error ? e.message : String(e)}`
  }
}

// ---------------------------------------------------------------- versioning

/** Auto-commit brain changes when the home folder is a git repository, so the
 *  agent's learning history is diffable and reversible. A non-repo home folder
 *  is left untouched (no surprise `git init` in the user's directory). */
export async function commitBrain(agent: DurableAgent, message: string): Promise<void> {
  const dir = agent.homeDir?.trim()
  if (!dir) return
  const d = shq(dir.replace(/\/+$/, ''))
  const probe = await execCommand(`git -C ${d} rev-parse --is-inside-work-tree 2>/dev/null`, undefined, 8000).catch(() => null)
  if (!probe || probe.code !== 0) return
  // stage + commit ONLY the brain paths that exist — never the user's other
  // staged work (a PM agent's home folder may be a real project repo)
  const script = `cd ${d} && paths=""; for p in ${LESSONS_FILE} ${JOURNAL_FILE} knowledge; do [ -e "$p" ] && paths="$paths $p"; done; `
    + `[ -n "$paths" ] && git add -A -- $paths && git commit -m ${shq(`brain: ${message.slice(0, 60)}`)} -- $paths`
  await execCommand(`${script} 2>/dev/null`, undefined, 12_000).catch(() => {})
}

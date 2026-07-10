// A durable agent's file brain: LESSONS.md (self-maintained corrections and
// style learnings), JOURNAL.md (episodic log of past work), and knowledge/
// (whatever the agent files with its normal file tools) inside its homeDir.
// Files are the storage — transparent, portable, user-editable. Agents without
// a homeDir (the built-in assistant) fall back to the shared workspace memory.
import type { Agent, DurableAgent } from '../../core/types'
import { readTextFile, writeTextFile } from '../../core/native'
import { callApi } from '../../llm/client'
import type { ApiContentBlock, LlmConfig } from '../../llm/client'

export const LESSONS_FILE = 'LESSONS.md'
export const JOURNAL_FILE = 'JOURNAL.md'

/** keep prompt injection bounded: freshest content wins */
const LESSONS_PROMPT_CHARS = 2400
const JOURNAL_PROMPT_CHARS = 1600
const FILE_CAP_CHARS = 60_000

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
  const cur = await readTextFile(path).catch(() => '')
  const header = cur ? '' : file === LESSONS_FILE
    ? `# Lessons — ${agent.name}\nCorrections and learnings this agent maintains about how to do its job.\n\n`
    : `# Journal — ${agent.name}\nEpisodic log of past work, distilled after conversations.\n\n`
  let next = `${cur || header}${cur && !cur.endsWith('\n') ? '\n' : ''}${entry.trim()}\n`
  while (next.length > FILE_CAP_CHARS) {
    // drop the oldest section (or line) after the header
    const start = next.indexOf('\n\n') + 2
    const cut = next.indexOf('\n', start + 1)
    if (cut < 0) break
    next = next.slice(0, start) + next.slice(cut + 1)
  }
  await writeTextFile(path, next)
}

/** The identity block injected at the TOP of a durable agent's system prompt:
 *  charter (stable, user-owned), freshest lessons, and recent journal. */
export function durablePromptSection(agent: DurableAgent, brain: AgentBrain): string {
  const tail = (s: string, max: number) => (s.length > max ? `…\n${s.slice(s.length - max)}` : s)
  const parts = [
    `YOUR IDENTITY — you are "${agent.name}"${agent.role ? ` (${agent.role})` : ''}, a durable agent: you persist across conversations, and your accumulated lessons/journal below ARE your continuity. `
    + (agent.homeDir
      ? `Your home folder is ${agent.homeDir} — your working dir AND your brain: maintain ${LESSONS_FILE} via the learn_lesson tool, and file domain knowledge under knowledge/ with your normal file tools so future conversations can find it.`
      : 'You have no home folder; persist learnings with learn_lesson (they land in the shared workspace memory).'),
    `YOUR CHARTER (your job description):\n${agent.charter.trim() || '(none yet — propose one with update_my_profile once you understand your job)'}`,
  ]
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

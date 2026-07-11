// The "hire an agent" gallery: role templates that scaffold a durable agent —
// charter, identity, and starter loops. Templates are just data; the folder
// the user picks becomes the agent's brain. AGENT.json in a home folder makes
// an agent portable (export writes it; import reads it).
import type { DurableAgent } from '../../core/types'
import { describeCron } from '../schedules/cron'

export interface DurableAgentTemplate {
  id: string
  name: string
  role: string
  color: string
  icon: string
  blurb: string
  charter: string
  /** starter loops seeded on hire (weekly/daily prompts) */
  loops?: Array<{ name: string; schedule: string; prompt: string }>
}

export const DURABLE_AGENT_TEMPLATES: DurableAgentTemplate[] = [
  {
    id: 'blank', name: 'Blank agent', role: '', color: '#B78AF7', icon: '✦',
    blurb: 'Start from nothing — write the charter yourself.',
    charter: '',
  },
  {
    id: 'pm', name: 'Project Manager', role: 'keeps a project moving', color: '#6FA8FF', icon: '📋',
    blurb: 'Tracks the board, writes standups, keeps decisions and risks filed.',
    charter: 'You are the project manager for the project in your home folder. Keep the kanban board truthful (list_board_tasks / add_board_task), maintain knowledge/decisions.md, knowledge/risks.md and knowledge/stakeholders.md as things change, and keep tasks small and verifiable (split anything over a day). When asked for status, answer from the board and your journal — never guess. Escalate blockers explicitly.',
    loops: [{ name: 'daily-standup', schedule: '0 9 * * 1-5', prompt: 'Review the board and your journal. Write a short standup into your journal via a JOURNAL.md update: what moved yesterday, what is stalled and why, top risks. Then reply with the three most important lines.' }],
  },
  {
    id: 'researcher', name: 'Research Assistant', role: 'digs, verifies, files findings', color: '#3DDC97', icon: '🔎',
    blurb: 'Researches questions, files sourced notes under knowledge/, builds on past findings.',
    charter: 'You are a research assistant. For every question: check knowledge_search first (you may already know), research with web_search/fetch_url, and file findings under knowledge/<topic>.md with sources and dates. Distinguish facts from claims; note confidence. Prefer primary sources. Keep one topic per file and update files instead of duplicating them.',
  },
  {
    id: 'chef', name: 'Cooking Helper', role: 'meal plans, recipes, pantry', color: '#FFB020', icon: '🍳',
    blurb: 'Learns tastes and pantry, plans meals, refines recipes after each cook.',
    charter: 'You are the household cooking helper. Maintain knowledge/pantry.md, knowledge/preferences.md (likes, dislikes, allergies — per person), and knowledge/recipes/ (one file each, with your own notes from past cooks). After any cooking feedback, update the recipe file AND learn_lesson the generalizable part. Suggest meals from what is in the pantry first.',
    loops: [{ name: 'weekly-meal-plan', schedule: '0 17 * * 0', prompt: 'Draft next week\'s meal plan from knowledge/pantry.md, preferences, and recent journal entries (avoid repeating last week). Reply with the plan and a shopping list; offer quick replies to accept or swap days.' }],
  },
  {
    id: 'tutor', name: 'Learning Tutor', role: 'adapts to how you learn', color: '#FF8FA3', icon: '🎓',
    blurb: 'Tracks progress and mistakes, spaces reviews, adapts difficulty.',
    charter: 'You are a personal tutor. Maintain knowledge/syllabus.md (topics + mastery level), knowledge/mistakes.md (every recurring error, with the misconception behind it), and use your journal for session records. Start each session by reviewing weak areas from mistakes.md; quiz before re-teaching; adapt difficulty from the trend. Update mastery levels after each session.',
    loops: [{ name: 'review-reminder', schedule: '0 18 * * *', prompt: 'Check knowledge/syllabus.md and mistakes.md for topics due for spaced review. If any are due, reply with a 3-question review quiz; otherwise reply "nothing due today".' }],
  },
  {
    id: 'editor', name: 'Writing Editor', role: 'edits in your voice', color: '#F5C451', icon: '✍️',
    blurb: 'Learns your style, edits drafts, keeps a style guide it maintains.',
    charter: 'You are a writing editor. Maintain knowledge/style.md — the author\'s voice, preferences, banned phrases, and recurring fixes — and apply it to every edit. When the author rejects an edit, learn_lesson why and update style.md. Edit in place with edit_file; show a summary of changes, not a lecture. Preserve the author\'s voice over textbook style.',
  },
]

/** The portable profile written to / read from `<homeDir>/AGENT.json` — also
 *  the format agent marketplaces serve. */
export interface AgentExport {
  yaamAgent: 1
  name: string
  role?: string
  color: string
  charter: string
  loops?: Array<{ name: string; schedule: string; prompt: string }>
  /** the agent-maintained home-page dashboard (markdown) */
  dashboard?: string
  /** self-built mini apps (self-contained HTML, rendered sandboxed) */
  apps?: Array<{ name: string; description?: string; html: string }>
}

export function exportRecord(agent: DurableAgent, loops: Array<{ name: string; schedule: string; prompt: string }>): AgentExport {
  return {
    yaamAgent: 1,
    name: agent.name,
    role: agent.role,
    color: agent.color,
    charter: agent.charter,
    ...(loops.length ? { loops } : {}),
    ...(agent.dashboard?.trim() ? { dashboard: agent.dashboard } : {}),
    ...(agent.apps?.length ? { apps: agent.apps.map(a => ({ name: a.name, description: a.description, html: a.html })) } : {}),
  }
}

/** Parse AGENT.json defensively; null when it isn't an agent export. */
export function parseAgentExport(text: string): AgentExport | null {
  try {
    const raw = JSON.parse(text) as Partial<AgentExport>
    if (raw.yaamAgent !== 1 || typeof raw.name !== 'string' || !raw.name.trim()) return null
    return {
      yaamAgent: 1,
      name: raw.name.trim().slice(0, 60),
      role: typeof raw.role === 'string' ? raw.role.slice(0, 120) : undefined,
      color: typeof raw.color === 'string' && /^#[0-9a-f]{6}$/i.test(raw.color) ? raw.color : '#B78AF7',
      charter: typeof raw.charter === 'string' ? raw.charter.slice(0, 8000) : '',
      loops: Array.isArray(raw.loops)
        ? raw.loops
            .filter((l): l is { name: string; schedule: string; prompt: string } =>
              !!l && typeof l === 'object'
              && typeof (l as Record<string, unknown>).schedule === 'string'
              && describeCron((l as Record<string, unknown>).schedule as string).ok
              && typeof (l as Record<string, unknown>).prompt === 'string'
              && !!((l as Record<string, unknown>).prompt as string).trim())
            .map(l => ({ name: String(l.name ?? 'loop').slice(0, 40), schedule: l.schedule, prompt: l.prompt.slice(0, 600) }))
            .slice(0, 6)
        : undefined,
      dashboard: typeof raw.dashboard === 'string' && raw.dashboard.trim() ? raw.dashboard.slice(0, 24_000) : undefined,
      apps: Array.isArray(raw.apps)
        ? raw.apps
            .map(a => a as Record<string, unknown>)
            .filter(a => !!a && typeof a === 'object'
              && typeof a.name === 'string' && !!a.name.trim()
              && typeof a.html === 'string' && !!a.html.trim())
            .map(a => ({
              name: (a.name as string).trim().slice(0, 60),
              description: typeof a.description === 'string' ? a.description.slice(0, 200) : undefined,
              html: (a.html as string).slice(0, 300_000),
            }))
            .slice(0, 12)
        : undefined,
    }
  } catch {
    return null
  }
}

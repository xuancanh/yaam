// Quick prompts: saved one-click prompts for sessions, global or scoped to a
// folder. Defaults apply until the user edits the list once.
import type { QuickPrompt } from '../../core/entities'
import type { AppState } from '../../core/types'

export const DEFAULT_QUICK_PROMPTS: QuickPrompt[] = [
  { id: 'qp-tests', label: 'Run tests, fix failures', text: 'Run the test suite. If anything fails, fix it and run the tests again until they pass.' },
  { id: 'qp-explain', label: 'Explain selection', text: 'Explain what this output means and what I should do about it:{selection}' },
  { id: 'qp-review', label: 'Review your changes', text: 'Review the changes you made in this session: look for bugs, missing edge cases and leftover debug code. Fix what you find and summarise.' },
  { id: 'qp-commit', label: 'Commit message', text: 'Write a concise commit message for the current changes (do not commit).' },
  { id: 'qp-recap', label: 'Recap', text: 'Summarise in a few bullets what you have done so far, what is left, and anything you need from me.' },
]

export function quickPromptsOf(s: Pick<AppState, 'settings'>): QuickPrompt[] {
  return s.settings?.quickPrompts ?? DEFAULT_QUICK_PROMPTS
}

const norm = (p: string) => p.replace(/\/+$/, '')

/** Prompts offered for a session in `cwd`: global ones plus those whose folder
 *  contains it (`~` and absolute spellings compare as written). */
export function promptsFor(list: QuickPrompt[], cwd: string | undefined): QuickPrompt[] {
  const dir = norm(cwd ?? '')
  return list.filter(p => !p.folder || (dir && (dir === norm(p.folder) || dir.startsWith(`${norm(p.folder)}/`))))
}

/** The other live sessions sharing `id`'s tab group (broadcast targets). */
export function groupPeers(s: Pick<AppState, 'groups' | 'agents'>, id: string): string[] {
  const g = (s.groups ?? []).find(x => x.slots.includes(id))
  if (!g) return []
  return g.slots.filter((x): x is string => !!x && x !== id)
    .filter(x => s.agents.some(a => a.id === x && !a.archived && a.kind !== 'chat' && (a.status === 'running' || a.status === 'needs')))
}

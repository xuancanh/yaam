// Line comments on a session's diff (herdr-reviewr, native): collected per
// reviewed folder, then sent to the agent as one review prompt. Runtime only;
// they are a draft review, cleared once sent.

export interface ReviewComment {
  id: string
  path: string
  /** line in the new file (or the old file for a deleted line) */
  line: number
  side: 'new' | 'old'
  /** the diffed line itself, for context in the prompt */
  code: string
  text: string
}

const store = new Map<string, ReviewComment[]>()
const subs = new Set<() => void>()
let seq = 0
const emit = () => { for (const cb of subs) cb() }

export function commentsFor(key: string): ReviewComment[] {
  return store.get(key) ?? []
}
export function addComment(key: string, c: Omit<ReviewComment, 'id'>): void {
  store.set(key, [...commentsFor(key), { ...c, id: `rc${++seq}` }])
  emit()
}
export function removeComment(key: string, id: string): void {
  store.set(key, commentsFor(key).filter(c => c.id !== id))
  emit()
}
export function clearComments(key: string): void {
  store.delete(key)
  emit()
}
export function onComments(cb: () => void): () => void {
  subs.add(cb)
  return () => { subs.delete(cb) }
}

/** Line numbers for each row of a unified diff: new-file number for context
 *  and added lines, old-file number for removed lines, null for chrome. */
export function unifiedLineNumbers(diff: string): ({ line: number; side: 'new' | 'old' } | null)[] {
  let oldN = 0, newN = 0
  return diff.split('\n').map(l => {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l)
    if (h) { oldN = Number(h[1]); newN = Number(h[2]); return null }
    if (l.startsWith('+++') || l.startsWith('---') || l.startsWith('diff ') || l.startsWith('index ') || !oldN && !newN) return null
    if (l.startsWith('+')) return { line: newN++, side: 'new' as const }
    if (l.startsWith('-')) return { line: oldN++, side: 'old' as const }
    if (l.startsWith('\\')) return null
    oldN++
    return { line: newN++, side: 'new' as const }
  })
}

/** The review prompt: comments grouped by file in line order. */
export function reviewPrompt(comments: ReviewComment[]): string {
  const byFile = new Map<string, ReviewComment[]>()
  for (const c of comments) byFile.set(c.path, [...(byFile.get(c.path) ?? []), c])
  const parts = [...byFile.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([path, cs]) => [
    `${path}:`,
    ...cs.sort((a, b) => a.line - b.line).map(c => `- line ${c.line}${c.side === 'old' ? ' (removed line)' : ''}: \`${c.code.trim().slice(0, 160)}\`\n  ${c.text.trim().replace(/\n/g, '\n  ')}`),
  ].join('\n'))
  return `Please address these review comments on your changes, then summarise what you changed:\n\n${parts.join('\n\n')}`
}

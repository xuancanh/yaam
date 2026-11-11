// Pure text builders for the native "work with what's on screen" features:
// selection handoffs, quick prompts and review comments all end up as one
// prompt typed into a session.

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'g')

/** Strip ANSI and trailing blanks; collapse runs of 3+ blank lines. */
export function cleanCapture(text: string): string {
  return text
    .replace(ANSI, '')
    .split('\n').map(l => l.replace(/\s+$/, '')).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** A prompt about selected terminal output: the note first, then the quoted
 *  output, labelled with where it came from (it may be another session). */
export function selectionPrompt(selection: string, note: string, source: { name: string; same: boolean }): string {
  const body = cleanCapture(selection).slice(0, 8000)
  const ask = note.trim() || 'Look at this output and tell me what is going on.'
  const from = source.same ? 'from this terminal' : `from the "${source.name}" session's terminal`
  return `${ask}\n\nOutput ${from}:\n\`\`\`\n${body}\n\`\`\``
}

/** A short board-task title from captured output: the first line that reads
 *  like an error, else the first non-empty line. */
export function errorTitle(text: string): string {
  const lines = cleanCapture(text).split('\n').map(l => l.trim()).filter(Boolean)
  const err = lines.find(l => /\b(error|failed|failure|exception|panic|cannot|undefined|not found|denied)\b|✕|✗|\bFAIL\b/i.test(l))
  const line = (err ?? lines[0] ?? 'Captured terminal output').replace(/^[\s>$#❯•·*-]+/, '')
  return `Fix: ${line.length > 72 ? `${line.slice(0, 71)}…` : line}`
}

/** Board task fields for captured output. */
export function taskFromSelection(selection: string, session: { name: string; cwd?: string }): { title: string; description: string; criteria: string[]; cwd?: string } {
  const body = cleanCapture(selection).slice(0, 6000)
  const where = [`Session: ${session.name}`, session.cwd ? `Folder: ${session.cwd}` : ''].filter(Boolean).join('\n')
  return {
    title: errorTitle(selection),
    description: `${where}\n\nCaptured from the terminal:\n\n\`\`\`\n${body}\n\`\`\``,
    criteria: ['The error above no longer occurs', 'Existing tests still pass'],
    ...(session.cwd ? { cwd: session.cwd } : {}),
  }
}

/** Fill a quick-prompt template. `{selection}` takes the terminal selection
 *  (quoted as a block); a template that needs one and has none returns null. */
export function fillPrompt(template: string, vars: { selection?: string }): string | null {
  if (!template.includes('{selection}')) return template
  const sel = cleanCapture(vars.selection ?? '')
  if (!sel) return null
  return template.replace(/\{selection\}/g, `\n\`\`\`\n${sel.slice(0, 8000)}\n\`\`\`\n`).trim()
}

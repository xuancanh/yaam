// The assistants' shared multi-file memory: a small set of named files per
// workspace that monitors, watchers, Master, and chat agents read (via the
// memory_lookup tool and prompt digests) and that user actions write back to.
// Conventional files:
//   approvals   — how the user answers permission prompts (approve/deny/option)
//   preferences — durable user preferences and conventions
//   patterns    — situation → action pairs the user accepted (clicked suggestions)
//   corrections — review rejections and explicit "not like this" feedback
//   notes       — chat agents' remembered facts
// All functions are pure over MemoryFile[]; callers dispatch the result.
import type { MemoryFile } from '../../core/types'
import { mkId } from '../../shared/id'

export const MEMORY_FILE_NAMES = ['approvals', 'preferences', 'patterns', 'corrections', 'notes'] as const

/** Per-file content cap: appends drop the OLDEST lines past this. */
const FILE_CAP_CHARS = 12_000

/** Append one entry line to a named file (created on demand), deduplicating
 *  identical lines and trimming the oldest content past the cap. */
export function appendMemory(files: MemoryFile[], name: string, entry: string, now = Date.now()): MemoryFile[] {
  const clean = entry.replace(/\s+/g, ' ').trim()
  if (!clean) return files
  const line = clean.startsWith('- ') ? clean : `- ${clean}`
  const existing = files.find(f => f.name === name)
  if (!existing) {
    return [...files, { id: mkId('mem'), name, content: line, updatedAt: now }]
  }
  if (existing.content.split('\n').includes(line)) return files
  let content = existing.content ? `${existing.content}\n${line}` : line
  while (content.length > FILE_CAP_CHARS) {
    const cut = content.indexOf('\n')
    if (cut < 0) break
    content = content.slice(cut + 1)
  }
  return files.map(f => (f.name === name ? { ...f, content, updatedAt: now } : f))
}

export interface MemoryHit {
  file: string
  line: string
}

/** Case-insensitive token search across every file's lines, ranked by how many
 *  query tokens a line matches (most-hit first, then most recent file). */
export function searchMemory(files: MemoryFile[], query: string, limit = 12): MemoryHit[] {
  const tokens = query.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(t => t.length > 1)
  if (!tokens.length) return []
  const scored: Array<MemoryHit & { score: number; at: number }> = []
  for (const f of files) {
    for (const line of f.content.split('\n')) {
      const low = line.toLowerCase()
      const score = tokens.reduce((n, t) => n + (low.includes(t) ? 1 : 0), 0)
      if (score > 0) scored.push({ file: f.name, line: line.trim(), score, at: f.updatedAt })
    }
  }
  return scored
    .sort((a, b) => b.score - a.score || b.at - a.at)
    .slice(0, limit)
    .map(({ file, line }) => ({ file, line }))
}

/** The freshest lines from the given files, newest last, bounded — the compact
 *  digest injected into assistant prompts so learned behavior applies without a
 *  tool round-trip. */
export function memoryDigest(files: MemoryFile[], names: readonly string[], maxChars = 1200): string {
  const parts: string[] = []
  for (const name of names) {
    const f = files.find(x => x.name === name)
    if (!f || !f.content.trim()) continue
    const lines = f.content.split('\n').filter(Boolean)
    parts.push(`[${name}]\n${lines.slice(-8).join('\n')}`)
  }
  let out = parts.join('\n')
  if (out.length > maxChars) out = out.slice(out.length - maxChars)
  return out
}

/** Format search hits as a tool result string. */
export function formatHits(hits: MemoryHit[]): string {
  if (!hits.length) return 'no matching memory entries'
  return hits.map(h => `[${h.file}] ${h.line}`).join('\n')
}

// ---------------------------------------------------------------- state ops

// hydration/tests may hand over states predating these fields — stay defensive
interface MemoryState {
  assistantMemory?: Record<string, MemoryFile[]>
  activeWorkspace: string
}

/** The active (or given) workspace's memory files. */
export function wsMemory<S extends MemoryState>(s: S, wid?: string): MemoryFile[] {
  return (s.assistantMemory ?? {})[wid ?? s.activeWorkspace] ?? []
}

/** State transition appending one entry to a workspace's memory file. */
export function withMemoryAppend<S extends MemoryState>(s: S, file: string, entry: string, wid?: string): S {
  const key = wid ?? s.activeWorkspace
  const cur = (s.assistantMemory ?? {})[key] ?? []
  const next = appendMemory(cur, file, entry)
  if (next === cur) return s
  return { ...s, assistantMemory: { ...(s.assistantMemory ?? {}), [key]: next } }
}

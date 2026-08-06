// Fuzzy matching for the Files pane quick-open overlay (⌘P): an ordered
// subsequence match scored for contiguity, word/basename starts, and early
// position. Pure and dependency-free so it stays unit-testable.

/** Score `query` against a relative '/'-separated `path`. Returns null when
 *  the query is not an ordered subsequence; higher is better. Case-insensitive. */
export function fuzzyScore(query: string, path: string): number | null {
  const q = query.trim().toLowerCase()
  if (!q) return 0
  const p = path.toLowerCase()
  const baseStart = p.lastIndexOf('/') + 1
  let score = 0
  let qi = 0
  let run = 0
  // -2: a first-character match must not count as "contiguous" with a phantom
  let last = -2
  for (let i = 0; i < p.length && qi < q.length; i++) {
    if (p[i] !== q[qi]) continue
    let s = 1
    // consecutive matches compound — a contiguous hit beats a scattered one
    if (i === last + 1) { run++; s += 3 + run } else run = 0
    // the basename start and word boundaries ('/', '.', '-', '_') are the
    // characters people actually type from
    if (i === baseStart) s += 5
    else if (i === 0 || p[i - 1] === '/' || p[i - 1] === '.' || p[i - 1] === '-' || p[i - 1] === '_') s += 3
    // all else equal, prefer matches anchored earlier in the path
    s -= i * 0.02
    score += s
    last = i
    qi++
  }
  return qi === q.length ? score : null
}

/** Rank `paths` against a fuzzy query: best score first, ties broken by
 *  shorter path then alphabetically, capped at `limit`. An empty query keeps
 *  the input order (the raw index listing). */
export function filterPaths(query: string, paths: string[], limit = 50): string[] {
  if (!query.trim()) return paths.slice(0, limit)
  const scored: { path: string; score: number }[] = []
  for (const path of paths) {
    const score = fuzzyScore(query, path)
    if (score !== null) scored.push({ path, score })
  }
  scored.sort((a, b) => b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path))
  return scored.slice(0, limit).map(s => s.path)
}

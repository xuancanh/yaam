// Turn a unified diff into paired side-by-side rows: deletions on the left,
// additions on the right, paired up within each hunk run so a changed line
// reads across. Pure — the DiffView renders the rows.

export type SplitKind = 'ctx' | 'add' | 'del' | 'empty' | 'hunk' | 'meta'

export interface SplitCell {
  /** 1-based line number in that side's file; absent for empty/hunk/meta */
  n?: number
  text: string
  kind: SplitKind
}

export interface SplitRow {
  left: SplitCell
  right: SplitCell
}

const EMPTY: SplitCell = { text: '', kind: 'empty' }

/** Pair a hunk's pending deletions/additions into rows (leftovers pad with
 *  empty cells) and append them. */
function flushRun(rows: SplitRow[], dels: SplitCell[], adds: SplitCell[]): void {
  const n = Math.max(dels.length, adds.length)
  for (let i = 0; i < n; i++) rows.push({ left: dels[i] ?? EMPTY, right: adds[i] ?? EMPTY })
  dels.length = 0
  adds.length = 0
}

/** Parse one unified diff (optionally multi-hunk) into side-by-side rows. */
export function splitDiffRows(diff: string): SplitRow[] {
  const rows: SplitRow[] = []
  const dels: SplitCell[] = []
  const adds: SplitCell[] = []
  let ln = 0 // left (old) line counter
  let rn = 0 // right (new) line counter
  for (const line of diff.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (hunk) {
      flushRun(rows, dels, adds)
      ln = parseInt(hunk[1], 10)
      rn = parseInt(hunk[2], 10)
      const cell: SplitCell = { text: line, kind: 'hunk' }
      rows.push({ left: cell, right: cell })
      continue
    }
    if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('\\')) {
      flushRun(rows, dels, adds)
      if (line.startsWith('diff --git')) rows.push({ left: { text: line, kind: 'meta' }, right: { text: line, kind: 'meta' } })
      continue
    }
    if (line.startsWith('-')) {
      dels.push({ n: ln++, text: line.slice(1), kind: 'del' })
    } else if (line.startsWith('+')) {
      adds.push({ n: rn++, text: line.slice(1), kind: 'add' })
    } else {
      flushRun(rows, dels, adds)
      // context: same text on both sides at their own line numbers
      const text = line.startsWith(' ') ? line.slice(1) : line
      if (ln === 0 && rn === 0) continue // stray text outside any hunk
      rows.push({ left: { n: ln++, text, kind: 'ctx' }, right: { n: rn++, text, kind: 'ctx' } })
    }
  }
  flushRun(rows, dels, adds)
  return rows
}

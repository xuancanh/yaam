// Pure parsing of a unified file diff (`git diff -U0`) into per-line change
// markers for the source-view gutter. Extracted from FilesPane so the parsing is
// unit-testable independently of rendering.
export interface DiffMarks {
  /** 1-based new-file line numbers that are pure additions (no old counterpart) */
  added: Set<number>
  /** 1-based new-file line numbers that replaced existing lines */
  modified: Set<number>
  /** 1-based new-file line numbers AFTER which a deletion occurred */
  deletedAfter: Set<number>
}

/** Parse a file diff's hunk headers into line-number markers for the gutter. */
export function parseDiffLines(diff: string): DiffMarks {
  const added = new Set<number>()
  const modified = new Set<number>()
  const deletedAfter = new Set<number>()
  for (const m of diff.matchAll(/^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    const oldCount = m[1] !== undefined ? parseInt(m[1], 10) : 1
    const newStart = parseInt(m[2], 10)
    const newCount = m[3] !== undefined ? parseInt(m[3], 10) : 1
    if (newCount === 0) {
      deletedAfter.add(newStart)
      continue
    }
    const target = oldCount === 0 ? added : modified
    for (let i = 0; i < newCount; i++) target.add(newStart + i)
  }
  return { added, modified, deletedAfter }
}

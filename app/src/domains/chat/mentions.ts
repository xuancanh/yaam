// @file mentions for the chat composer: list the working folder's files and
// rank them against the query typed after '@'. The picked file goes through
// the existing attachment loader, so it lands in context like a dropped file.
import { execCommand } from '../../core/native'

/** Rank the working folder's files against an @-mention query: basename
 *  prefix matches first, then basename substring, then path substring. */
export function matchFiles(files: string[], query: string, limit = 12): string[] {
  const q = query.toLowerCase()
  const scored: { path: string; score: number }[] = []
  for (const path of files) {
    const base = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
    const score = !q ? 2
      : base.startsWith(q) ? 0
      : base.includes(q) ? 1
      : path.toLowerCase().includes(q) ? 2
      : -1
    if (score >= 0) scored.push({ path, score })
  }
  return scored
    .sort((a, b) => a.score - b.score || a.path.length - b.path.length)
    .slice(0, limit)
    .map(s => s.path)
}

/** List the chat's working folder for @-mentions: tracked + untracked git
 *  files (respects .gitignore), falling back to a bounded find for plain
 *  folders. Best-effort — an empty list simply disables the menu. */
export async function listMentionFiles(cwd: string): Promise<string[]> {
  try {
    const git = await execCommand('git ls-files --cached --others --exclude-standard 2>/dev/null | head -3000', cwd)
    let lines = git.code === 0 ? git.output.split('\n').filter(Boolean) : []
    if (!lines.length) {
      const found = await execCommand(`find . -maxdepth 4 -type f -not -path '*/.git/*' -not -path '*/node_modules/*' 2>/dev/null | head -2000`, cwd)
      lines = found.code === 0 ? found.output.split('\n').filter(Boolean).map(l => l.replace(/^\.\//, '')) : []
    }
    return lines
  } catch {
    return []
  }
}

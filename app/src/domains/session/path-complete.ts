// Folder autocomplete for the new-session dialog's working-folder field.
// Typing `~/a` lists folders in `~/` whose names start with `a`.

export const MAX_SUGGESTIONS = 5

/** Split typed input into the directory to list and the name prefix to match.
 *  Returns null when there is no directory part yet (a bare word). */
export function splitForComplete(input: string): { dir: string; prefix: string } | null {
  if (input === '~') return { dir: '~/', prefix: '' }
  const slash = input.lastIndexOf('/')
  if (slash < 0) return null
  return { dir: input.slice(0, slash + 1), prefix: input.slice(slash + 1) }
}

/** Folder names in `dir` that start with `prefix` (case-insensitive), as full
 *  input values keeping the user's own spelling of the directory (`~/`).
 *  Dot-folders only show when the prefix itself starts with a dot. */
export function folderSuggestions(dir: string, prefix: string, names: string[], max = MAX_SUGGESTIONS): string[] {
  const p = prefix.toLowerCase()
  return names
    .filter(n => (p.startsWith('.') || !n.startsWith('.')) && n.toLowerCase().startsWith(p))
    .sort((a, b) => {
      // exact-case prefix matches first, then alphabetical
      const ea = a.startsWith(prefix) ? 0 : 1, eb = b.startsWith(prefix) ? 0 : 1
      return ea - eb || a.localeCompare(b, undefined, { sensitivity: 'base' })
    })
    .slice(0, max)
    .map(n => `${dir}${n}/`)
}

/** Every ancestor folder of `file` below `root` (all of them when `root` is a
 *  tilde path the listing has already expanded), shallowest first. */
export function ancestorDirs(root: string, file: string): string[] {
  const base = root.replace(/\/+$/, '')
  const inside = file.startsWith(base + '/')
  const out: string[] = []
  let d = file
  while (d.lastIndexOf('/') > 0) {
    d = d.slice(0, d.lastIndexOf('/'))
    if (inside && d.length <= base.length) break
    out.push(d)
  }
  return out.reverse()
}

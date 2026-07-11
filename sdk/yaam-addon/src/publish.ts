// `yaam-addon publish`: put a built addon into a registry checkout — pack it
// into registry/packages/<slug>.yaam.json and update registry/index.json.
// It deliberately does NOT commit or push: the registry PR (with its loud
// permission/hosts/secrets diff) is the human review boundary.
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { packAddon } from './pack.js'

export interface PublishSummary {
  slug: string
  name: string
  version: string
  prevVersion: string | null
  packedFile: string
  /** human lines describing the security-relevant diff vs the previous pack */
  securityDiff: string[]
}

/** Compare dotted numeric versions; positive when a > b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(n => parseInt(n, 10) || 0)
  const pb = b.split('.').map(n => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return d
  }
  return 0
}

type Pack = {
  name?: string
  version?: string
  icon?: string
  description?: string
  permissions?: string[]
  hosts?: string[]
  secrets?: (string | { name: string })[]
}

/** The reviewer-facing diff: scopes, reachable hosts, secret slots. */
export function securityDiff(prev: Pack | null, next: Pack): string[] {
  const lines: string[] = []
  const set = (p?: (string | { name: string })[]) => new Set((p ?? []).map(x => typeof x === 'string' ? x : x.name))
  const cmp = (label: string, before: Set<string>, after: Set<string>) => {
    const added = [...after].filter(x => !before.has(x))
    const removed = [...before].filter(x => !after.has(x))
    if (added.length) lines.push(`+ ${label}: ${added.join(', ')}`)
    if (removed.length) lines.push(`- ${label}: ${removed.join(', ')}`)
  }
  cmp('permissions', set(prev?.permissions), set(next.permissions))
  cmp('hosts', set(prev?.hosts), set(next.hosts))
  cmp('secrets', set(prev?.secrets), set(next.secrets))
  if (!prev) lines.unshift('(new package)')
  return lines
}

export async function publishAddon(builtDir: string, registryDir: string, opts: { urlBase?: string } = {}): Promise<PublishSummary> {
  const indexPath = join(registryDir, 'index.json')
  const index = JSON.parse(await readFile(indexPath, 'utf8')) as { registry: number; packages: Record<string, unknown>[] }
  if (!Array.isArray(index.packages)) throw new Error(`${indexPath} has no "packages" array`)

  const manifest = JSON.parse(await readFile(join(builtDir, 'addon.json'), 'utf8')) as Pack
  if (!manifest.name || !manifest.version) throw new Error('built addon.json needs name and version')
  const slug = manifest.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const packedFile = join(registryDir, 'packages', `${slug}.yaam.json`)

  let prev: Pack | null = null
  try { prev = JSON.parse(await readFile(packedFile, 'utf8')) } catch { /* first publish */ }
  if (prev?.version && compareVersions(manifest.version, prev.version) <= 0) {
    throw new Error(`version ${manifest.version} must be greater than the published ${prev.version} — bump it in addon.config.ts`)
  }

  await packAddon(builtDir, packedFile)

  // url pattern: reuse a sibling entry's base so forks keep their raw URLs
  const sibling = index.packages.find(p => typeof p.url === 'string' && (p.url as string).endsWith('.yaam.json'))
  const urlBase = opts.urlBase
    ?? (sibling ? (sibling.url as string).replace(/[^/]+\.yaam\.json$/, '') : 'https://raw.githubusercontent.com/OWNER/REPO/main/registry/packages/')
  const entry = {
    name: slug,
    version: manifest.version,
    ...(manifest.icon ? { icon: manifest.icon } : {}),
    ...(manifest.description ? { description: manifest.description } : {}),
    url: `${urlBase}${slug}.yaam.json`,
  }
  const at = index.packages.findIndex(p => p.name === slug)
  if (at >= 0) index.packages[at] = { ...index.packages[at], ...entry }
  else index.packages.push(entry)
  await writeFile(indexPath, JSON.stringify(index, null, 2) + '\n')

  return {
    slug,
    name: manifest.name,
    version: manifest.version,
    prevVersion: prev?.version ?? null,
    packedFile,
    securityDiff: securityDiff(prev, manifest),
  }
}

// Durable-agent marketplaces: the same registries that serve addons
// (settings.registries → index.json) may carry an `agents` array — portable
// AGENT.json profiles (charter + loops + dashboard + mini apps) you can hire
// with one click. Index parsing is pure (unit-tested); fetching mirrors the
// addon registry loader: http(s) URL, local index.json, or a local folder.
import { httpGetText, readTextFile } from '../../core/native'
import { parseAgentExport } from './agent-templates'
import type { AgentExport } from './agent-templates'

export interface MarketAgentEntry {
  name: string
  role?: string
  icon?: string
  description?: string
  /** absolute or index-relative URL of the AGENT.json profile */
  url: string
  /** which registry it came from */
  registry: string
}

const isHttp = (u: string) => /^https?:\/\//.test(u)

/** Validate one registry index's `agents` array (absent → empty). */
export function parseAgentIndex(json: unknown): Omit<MarketAgentEntry, 'registry'>[] {
  const agents = (json as { agents?: unknown })?.agents
  if (!Array.isArray(agents)) return []
  return agents
    .filter((a): a is Record<string, unknown> => !!a && typeof a === 'object')
    .filter(a => typeof a.name === 'string' && !!a.name.trim() && typeof a.url === 'string' && !!a.url.trim())
    .map(a => ({
      name: (a.name as string).trim().slice(0, 60),
      role: typeof a.role === 'string' ? a.role.slice(0, 120) : undefined,
      icon: typeof a.icon === 'string' ? a.icon.slice(0, 8) : undefined,
      description: typeof a.description === 'string' ? a.description.slice(0, 300) : undefined,
      url: (a.url as string).trim(),
    }))
    .slice(0, 50)
}

/** Resolve an entry url against its index location: absolute stays, relative joins. */
export function resolveAgentUrl(url: string, indexUrl: string): string {
  if (isHttp(url) || url.startsWith('/')) return url
  const base = indexUrl.replace(/\/[^/]*$/, '')
  return `${base}/${url.replace(/^\.\//, '')}`
}

/** Load every configured registry's agents (registries that fail or carry no
 *  agents contribute nothing — addon-only registries are normal). */
export async function fetchAgentMarket(registries: { name: string; url: string }[]): Promise<MarketAgentEntry[]> {
  const all: MarketAgentEntry[] = []
  await Promise.all(registries.map(async reg => {
    try {
      const indexPath = isHttp(reg.url) || /\.json$/.test(reg.url) ? reg.url : `${reg.url.replace(/\/$/, '')}/index.json`
      const text = isHttp(indexPath) ? await httpGetText(indexPath) : await readTextFile(indexPath)
      for (const a of parseAgentIndex(JSON.parse(text))) {
        all.push({ ...a, url: resolveAgentUrl(a.url, indexPath), registry: reg.name })
      }
    } catch { /* unreachable registry — skip it, keep the rest */ }
  }))
  return all
}

/** Fetch and validate one marketplace agent's full profile. */
export async function fetchAgentProfile(entry: MarketAgentEntry): Promise<AgentExport | null> {
  const text = isHttp(entry.url) ? await httpGetText(entry.url) : await readTextFile(entry.url)
  return parseAgentExport(text)
}

/** Human-readable capability review shown after fetching a remote profile and
 *  before installing it. Marketplace metadata is not enough: the profile can
 *  add enabled token-spending loops and executable (sandboxed) mini apps. */
export function agentProfileInstallDetail(profile: AgentExport): string {
  const loops = profile.loops ?? []
  const apps = profile.apps ?? []
  return [
    profile.role ? `Role: ${profile.role}` : '',
    `Charter: ${profile.charter?.trim().slice(0, 500) || '(empty)'}`,
    loops.length
      ? `Enabled loops (${loops.length}): ${loops.map(l => `${l.name} [${l.schedule}]`).join(', ')}. These start immediately and spend LLM tokens when they fire.`
      : 'Enabled loops: none',
    `Sandboxed mini apps: ${apps.length}${apps.length ? ` (${apps.map(a => a.name).join(', ')})` : ''}`,
  ].filter(Boolean).join('\n\n')
}

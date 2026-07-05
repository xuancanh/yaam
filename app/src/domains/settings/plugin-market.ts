// Claude plugin marketplaces: repos carrying .claude-plugin/marketplace.json
// (the format of github.com/anthropics/claude-plugins-official). YAAM has no
// Claude Code runtime, so "installing" a plugin for chat means importing the
// pieces chat agents can actually use: skills/ and commands/ become skill
// registries (slash-invocable), and .mcp.json servers become MCP candidates.
// Plugin agents/hooks are Claude-Code-specific and are reported as skipped.
import { httpGetText } from '../../core/native'
import { parseSkillMd } from '../../core/skills'
import { fromMcpServersMap } from './mcp-market'
import type { McpCandidate, RawEntry } from './mcp-market'

export const DEFAULT_PLUGIN_REGISTRY = { name: 'claude-plugins-official', url: 'https://github.com/anthropics/claude-plugins-official' }

interface GhLoc {
  owner: string
  repo: string
  /** branch, tag, or commit sha; HEAD = default branch */
  ref: string
  /** path of the plugin root inside the repo ('' = repo root) */
  path: string
}

export interface PluginEntry {
  name: string
  description?: string
  category?: string
  author?: string
  homepage?: string
  /** resolved GitHub location; null when the source isn't a GitHub repo */
  loc: GhLoc | null
}

export interface PluginInstall {
  /** skill registries to add (plugin skills/ and commands/) */
  skillRegistries: { name: string; url: string }[]
  /** MCP servers declared by the plugin's .mcp.json */
  mcpServers: McpCandidate[]
  /** plugin agents/*.md translated into chat personas (system prompts) */
  personas: { name: string; description: string; body: string }[]
  /** plugin hooks/ translated into a YAAM addon package (JSON) whose hooks
   *  run the plugin's commands via the permission-gated exec scope */
  hookAddonJson?: string
  /** components (or hook events) that could not be represented */
  skipped: string[]
}

/** Claude hook events YAAM can map onto its addon hook points. */
const HOOK_EVENT_MAP: Record<string, 'onSessionExit' | 'onNeedsInput'> = {
  Stop: 'onSessionExit',
  SubagentStop: 'onSessionExit',
  SessionEnd: 'onSessionExit',
  Notification: 'onNeedsInput',
}

interface ClaudeHooksConfig {
  hooks?: Record<string, { matcher?: string; hooks?: { type?: string; command?: string }[] }[]>
}

/** Translate a Claude plugin hooks config into a YAAM addon package. Mapped
 *  events run the hook commands through api.exec (the event arrives as
 *  YAAM_HOOK_EVENT json in the command's environment — an approximation of
 *  Claude Code's stdin payload); unmappable events are reported back. */
export function translateHooksToAddon(pluginName: string, cfg: ClaudeHooksConfig): { addonJson: string | null; unmapped: string[] } {
  const byHook: Record<string, string[]> = {}
  const unmapped: string[] = []
  for (const [event, groups] of Object.entries(cfg.hooks ?? {})) {
    const target = HOOK_EVENT_MAP[event]
    const commands = (groups ?? []).flatMap(g => (g.hooks ?? [])
      .filter(h => (h.type ?? 'command') === 'command' && h.command)
      .map(h => h.command!))
    if (!commands.length) continue
    if (!target) {
      unmapped.push(event)
      continue
    }
    byHook[target] = (byHook[target] ?? []).concat(commands)
  }
  const entries = Object.entries(byHook)
  if (!entries.length) return { addonJson: null, unmapped }
  const body = (cmds: string[]) => [
    // hook body runs in the addon sandbox; api.exec is the only machine access
    `const payload = JSON.stringify(event).replace(/'/g, "'\\\\''")`,
    `for (const cmd of ${JSON.stringify(cmds)}) {`,
    `  const r = await api.exec("YAAM_HOOK_EVENT='" + payload + "' " + cmd)`,
    `  if (r.code !== 0) api.logEvent('plugin hook "' + cmd.slice(0, 60) + '" exited ' + r.code)`,
    `}`,
  ].join('\n')
  const addon = {
    name: `${pluginName} hooks`,
    version: '1.0.0',
    icon: '⚓',
    desc: `Lifecycle hooks from the Claude plugin “${pluginName}”, translated to YAAM events. Commands run via the exec permission — grant it in Settings → Addons to activate.`,
    permissions: ['exec', 'ui'],
    hooks: Object.fromEntries(entries.map(([hook, cmds]) => [hook, body(cmds)])),
  }
  return { addonJson: JSON.stringify(addon, null, 2), unmapped }
}

/** github.com/owner/repo[.git][/tree/ref[/path]] → location parts. */
export function parseGithubUrl(url: string): GhLoc | null {
  const m = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/tree\/([^/]+)(?:\/(.+?))?)?\/?$/)
  return m ? { owner: m[1], repo: m[2], ref: m[3] ?? 'HEAD', path: m[4] ?? '' } : null
}

const rawUrl = (l: GhLoc, rel: string) =>
  `https://raw.githubusercontent.com/${l.owner}/${l.repo}/${l.ref}/${[l.path, rel].filter(Boolean).join('/')}`

const treeUrl = (l: GhLoc, rel: string) =>
  `https://github.com/${l.owner}/${l.repo}/tree/${l.ref}/${[l.path, rel].filter(Boolean).join('/')}`

interface MarketplaceEntry {
  name?: string
  description?: string
  category?: string
  author?: { name?: string }
  homepage?: string
  source?: string | { source?: string; url?: string; path?: string; ref?: string; sha?: string }
}

/** Resolve one marketplace entry's source to a GitHub location. */
export function resolveSource(registry: GhLoc, src: MarketplaceEntry['source']): GhLoc | null {
  if (typeof src === 'string') {
    // relative directory inside the marketplace repo itself
    return { ...registry, path: [registry.path, src.replace(/^\.\//, '')].filter(Boolean).join('/') }
  }
  if (src && typeof src === 'object' && src.url) {
    const base = parseGithubUrl(src.url)
    if (!base) return null
    return { ...base, ref: src.ref ?? src.sha ?? 'HEAD', path: src.path ?? '' }
  }
  return null
}

/** Fetch a marketplace repo's plugin directory. */
export async function fetchPluginMarketplace(url: string): Promise<{ name: string; plugins: PluginEntry[] }> {
  const registry = parseGithubUrl(url.trim())
  if (!registry) throw new Error('expected a GitHub repo URL like https://github.com/anthropics/claude-plugins-official')
  const manifest = JSON.parse(await httpGetText(rawUrl(registry, '.claude-plugin/marketplace.json'))) as {
    name?: string
    plugins?: MarketplaceEntry[]
  }
  const plugins = (manifest.plugins ?? [])
    .filter((p): p is MarketplaceEntry & { name: string } => typeof p.name === 'string' && !!p.name)
    .map(p => ({
      name: p.name,
      description: p.description,
      category: p.category,
      author: p.author?.name,
      homepage: p.homepage,
      loc: resolveSource(registry, p.source),
    }))
  return { name: manifest.name ?? registry.repo, plugins }
}

/** Inspect a plugin's repo folder and shape everything chat can consume. */
export async function resolvePluginInstall(plugin: PluginEntry): Promise<PluginInstall> {
  if (!plugin.loc) throw new Error('this plugin is not hosted on GitHub — install its pieces manually')
  const l = plugin.loc
  const listing = JSON.parse(await httpGetText(
    `https://api.github.com/repos/${l.owner}/${l.repo}/contents/${l.path}?ref=${l.ref}`,
  )) as { name: string; type: string }[]
  if (!Array.isArray(listing)) throw new Error('unexpected GitHub API response for the plugin folder')
  const has = (name: string, type: string) => listing.some(e => e.name === name && e.type === type)

  const out: PluginInstall = { skillRegistries: [], mcpServers: [], personas: [], skipped: [] }
  if (has('skills', 'dir')) out.skillRegistries.push({ name: plugin.name, url: treeUrl(l, 'skills') })
  if (has('commands', 'dir')) out.skillRegistries.push({ name: `${plugin.name}-commands`, url: treeUrl(l, 'commands') })
  if (has('.mcp.json', 'file')) {
    try {
      const cfg = JSON.parse(await httpGetText(rawUrl(l, '.mcp.json'))) as { mcpServers?: Record<string, RawEntry> } & Record<string, RawEntry>
      fromMcpServersMap(plugin.name, cfg.mcpServers ?? (cfg as Record<string, RawEntry>), out.mcpServers)
    } catch {
      out.skipped.push('.mcp.json (unparseable)')
    }
  }
  if (has('agents', 'dir')) {
    // Claude Code agents are markdown system prompts with name/description
    // frontmatter — exactly YAAM's persona shape, so translate them
    try {
      const agents = JSON.parse(await httpGetText(
        `https://api.github.com/repos/${l.owner}/${l.repo}/contents/${[l.path, 'agents'].filter(Boolean).join('/')}?ref=${l.ref}`,
      )) as { name: string; type: string }[]
      for (const a of agents.filter(e => e.type === 'file' && /\.md$/i.test(e.name)).slice(0, 20)) {
        try {
          const parsed = parseSkillMd(await httpGetText(rawUrl(l, `agents/${a.name}`)), a.name.replace(/\.md$/i, ''))
          if (parsed.body.trim()) {
            out.personas.push({
              name: `${plugin.name}:${parsed.name}`,
              description: parsed.description || `agent from the ${plugin.name} plugin`,
              body: parsed.body,
            })
          }
        } catch { /* unreadable agent file — skip it, keep the rest */ }
      }
      if (!out.personas.length) out.skipped.push('agents (none parseable)')
    } catch {
      out.skipped.push('agents (listing failed)')
    }
  }
  if (has('hooks', 'dir') || has('hooks.json', 'file')) {
    try {
      const rel = has('hooks.json', 'file') ? 'hooks.json' : 'hooks/hooks.json'
      const cfg = JSON.parse(await httpGetText(rawUrl(l, rel))) as ClaudeHooksConfig
      const { addonJson, unmapped } = translateHooksToAddon(plugin.name, cfg)
      if (addonJson) out.hookAddonJson = addonJson
      if (unmapped.length) out.skipped.push(`hook events without a YAAM equivalent: ${'$'}{unmapped.join(', ')}`)
      if (!addonJson && !unmapped.length) out.skipped.push('hooks (config carried no commands)')
    } catch {
      out.skipped.push('hooks (config unreadable)')
    }
  }
  if (!out.skillRegistries.length && !out.mcpServers.length && !out.personas.length) {
    throw new Error('nothing chat-compatible found (no skills/, commands/, agents/, or .mcp.json)')
  }
  return out
}

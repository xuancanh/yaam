// MCP marketplace + config import: a curated catalog of popular servers and
// parsers for the MCP configs other AI apps already have on this machine
// (Claude Desktop, Claude Code, Cursor, Codex, Windsurf). Everything returns
// McpCandidate rows the UI can add as YAAM servers with one click.
import { readTextFile } from '../../core/native'
import type { McpServer } from '../../core/types'

export interface McpCandidate {
  name: string
  /** where it came from — 'marketplace' or the app whose config declared it */
  source: string
  description?: string
  transport: 'http' | 'stdio'
  url?: string
  headers?: string
  command?: string
  args?: string[]
  /** "KEY=value" lines; empty values mark credentials the user must fill in */
  env?: string
}

/** Curated one-click servers. stdio entries need Node (npx) or uv (uvx). */
export const MCP_CATALOG: McpCandidate[] = [
  { name: 'filesystem', source: 'marketplace', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '~'], description: 'Read/write files under allowed folders (edit the last arg to scope it).' },
  { name: 'github', source: 'marketplace', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: 'GITHUB_PERSONAL_ACCESS_TOKEN=', description: 'Repos, issues, PRs via the GitHub API (needs a PAT).' },
  { name: 'fetch', source: 'marketplace', transport: 'stdio', command: 'uvx', args: ['mcp-server-fetch'], description: 'Fetch web pages as markdown (Python/uv).' },
  { name: 'memory', source: 'marketplace', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'], description: 'Persistent knowledge-graph memory across chats.' },
  { name: 'sequential-thinking', source: 'marketplace', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'], description: 'Structured step-by-step reasoning scratchpad.' },
  { name: 'chrome-devtools', source: 'marketplace', transport: 'stdio', command: 'npx', args: ['-y', 'chrome-devtools-mcp@latest'], description: 'Drive Chrome (navigate, click, inspect) — web-app control.' },
  { name: 'playwright', source: 'marketplace', transport: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'], description: 'Browser automation with Playwright.' },
  { name: 'puppeteer', source: 'marketplace', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-puppeteer'], description: 'Headless-Chrome scraping/screenshots.' },
  { name: 'brave-search', source: 'marketplace', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-brave-search'], env: 'BRAVE_API_KEY=', description: 'Web search via the Brave API (needs a key).' },
  { name: 'slack', source: 'marketplace', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-slack'], env: 'SLACK_BOT_TOKEN=\nSLACK_TEAM_ID=', description: 'Read/post Slack messages (needs a bot token).' },
  { name: 'context7', source: 'marketplace', transport: 'http', url: 'https://mcp.context7.com/mcp', description: 'Up-to-date library docs for coding questions.' },
  { name: 'deepwiki', source: 'marketplace', transport: 'http', url: 'https://mcp.deepwiki.com/mcp', description: 'Ask questions about public GitHub repos.' },
]

interface RawEntry {
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  type?: string
  headers?: Record<string, string>
}

const envToLines = (env?: Record<string, string>) =>
  env ? Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') : undefined

const headersToLines = (headers?: Record<string, string>) =>
  headers ? Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\n') : undefined

/** One mcpServers-style JSON map → candidates. */
function fromMcpServersMap(source: string, map: Record<string, RawEntry> | undefined, out: McpCandidate[]) {
  for (const [name, e] of Object.entries(map ?? {})) {
    if (!e || typeof e !== 'object') continue
    if (typeof e.url === 'string' && e.url) {
      out.push({ name, source, transport: 'http', url: e.url, headers: headersToLines(e.headers) })
    } else if (typeof e.command === 'string' && e.command) {
      out.push({
        name, source, transport: 'stdio', command: e.command,
        args: Array.isArray(e.args) ? e.args.filter((a): a is string => typeof a === 'string') : [],
        env: envToLines(e.env),
      })
    }
  }
}

/** Extremely small TOML reader for Codex's [mcp_servers.*] tables. */
export function fromCodexToml(source: string, toml: string, out: McpCandidate[]) {
  let current: McpCandidate | null = null
  let inEnvTable = false
  const flush = () => { if (current?.command) out.push(current); current = null }
  for (const raw of toml.split('\n')) {
    const line = raw.trim()
    const section = line.match(/^\[(.+)\]$/)
    if (section) {
      const envSub = section[1].match(/^mcp_servers\.(.+)\.env$/)
      if (envSub && current && envSub[1] === current.name) { inEnvTable = true; continue }
      flush()
      inEnvTable = false
      const m = section[1].match(/^mcp_servers\.(.+)$/)
      current = m ? { name: m[1].replace(/^"|"$/g, ''), source, transport: 'stdio', args: [], env: undefined } : null
      continue
    }
    if (!current) continue
    const kv = line.match(/^(\w+)\s*=\s*(.+)$/)
    if (!kv) continue
    const [, key, valRaw] = kv
    if (inEnvTable) {
      const v = valRaw.match(/^"(.*)"$/)?.[1] ?? valRaw
      current.env = `${current.env ? `${current.env}\n` : ''}${key}=${v}`
      continue
    }
    if (key === 'command') current.command = valRaw.match(/^"(.*)"$/)?.[1] ?? valRaw
    else if (key === 'args') {
      try { current.args = (JSON.parse(valRaw.replace(/,\s*\]$/, ']')) as unknown[]).filter((a): a is string => typeof a === 'string') } catch { /* leave as-is */ }
    } else if (key === 'env') {
      // inline table: { KEY = "value", … }
      current.env = [...valRaw.matchAll(/([\w-]+)\s*=\s*"([^"]*)"/g)].map(m => `${m[1]}=${m[2]}`).join('\n') || undefined
    }
  }
  flush()
}

interface ConfigSource {
  source: string
  path: string
  parse: (source: string, text: string, out: McpCandidate[]) => void
}

const CONFIG_SOURCES: ConfigSource[] = [
  {
    source: 'Claude Desktop',
    path: '~/Library/Application Support/Claude/claude_desktop_config.json',
    parse: (src, text, out) => fromMcpServersMap(src, (JSON.parse(text) as { mcpServers?: Record<string, RawEntry> }).mcpServers, out),
  },
  {
    source: 'Claude Code',
    path: '~/.claude.json',
    parse: (src, text, out) => {
      const cfg = JSON.parse(text) as { mcpServers?: Record<string, RawEntry>; projects?: Record<string, { mcpServers?: Record<string, RawEntry> }> }
      fromMcpServersMap(src, cfg.mcpServers, out)
      for (const p of Object.values(cfg.projects ?? {})) fromMcpServersMap(src, p.mcpServers, out)
    },
  },
  {
    source: 'Cursor',
    path: '~/.cursor/mcp.json',
    parse: (src, text, out) => fromMcpServersMap(src, (JSON.parse(text) as { mcpServers?: Record<string, RawEntry> }).mcpServers, out),
  },
  {
    source: 'Windsurf',
    path: '~/.codeium/windsurf/mcp_config.json',
    parse: (src, text, out) => fromMcpServersMap(src, (JSON.parse(text) as { mcpServers?: Record<string, RawEntry> }).mcpServers, out),
  },
  {
    source: 'Codex',
    path: '~/.codex/config.toml',
    parse: fromCodexToml,
  },
]

/** Identity used to dedupe candidates against each other and existing servers. */
function fingerprint(c: { transport?: string; url?: string; command?: string; args?: string[] }): string {
  return c.transport === 'http' || (!c.command && c.url)
    ? `http:${c.url}`
    : `stdio:${c.command} ${(c.args ?? []).join(' ')}`
}

/** Scan the known config locations for MCP servers configured in other apps. */
export async function scanImportableMcpServers(existing: McpServer[]): Promise<McpCandidate[]> {
  const found: McpCandidate[] = []
  for (const src of CONFIG_SOURCES) {
    try {
      src.parse(src.source, await readTextFile(src.path), found)
    } catch { /* app not installed / no config / unparseable — skip */ }
  }
  const have = new Set(existing.map(fingerprint))
  const seen = new Set<string>()
  return found.filter(c => {
    const fp = fingerprint(c)
    if (have.has(fp) || seen.has(fp)) return false
    seen.add(fp)
    return true
  })
}

/** Marketplace entries not already configured. */
export function availableCatalog(existing: McpServer[]): McpCandidate[] {
  const have = new Set(existing.map(fingerprint))
  return MCP_CATALOG.filter(c => !have.has(fingerprint(c)))
}

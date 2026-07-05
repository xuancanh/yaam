// MCP marketplace + config import: a curated catalog of popular servers and
// parsers for the MCP configs other AI apps already have on this machine
// (Claude Desktop, Claude Code, Cursor, Codex, Windsurf). Everything returns
// McpCandidate rows the UI can add as YAAM servers with one click.
import { homeDir } from '@tauri-apps/api/path'
import { execCommand, readTextFile } from '../../core/native'
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
  /** working directory for the process (e.g. an unpacked bundle dir) */
  cwd?: string
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

export interface RawEntry {
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
export function fromMcpServersMap(source: string, map: Record<string, RawEntry> | undefined, out: McpCandidate[]) {
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

// ---------------------------------------------------------------- .mcpb

/** The parts of a Claude Desktop extension manifest we act on.
 *  Spec: github.com/modelcontextprotocol/mcpb (MANIFEST.md). */
interface McpbManifest {
  name?: string
  display_name?: string
  description?: string
  server?: {
    type?: string
    entry_point?: string
    mcp_config?: { command?: string; args?: string[]; env?: Record<string, string> }
  }
  user_config?: Record<string, { title?: string; description?: string; required?: boolean; default?: unknown }>
}

const shellEsc = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

/** Replace manifest template variables. ${user_config.*} defaults are filled
 *  when declared; otherwise the placeholder stays visible for the user to edit. */
function substitute(value: string, dir: string, userConfig: McpbManifest['user_config']): string {
  return value
    .replaceAll('${__dirname}', dir)
    .replace(/\$\{user_config\.([\w-]+)\}/g, (m, key: string) => {
      const def = userConfig?.[key]?.default
      return typeof def === 'string' || typeof def === 'number' ? String(def) : m
    })
}

/** Install a Claude Desktop extension (.mcpb/.dxt): unpack the bundle under
 *  ~/.yaam/mcpb/, read manifest.json, and shape its server as a stdio
 *  candidate. user_config values without defaults stay as ${user_config.*}
 *  placeholders in env/args for the user to fill in the server editor. */
export async function installMcpb(path: string): Promise<McpCandidate> {
  const file = path.split('/').pop() ?? 'bundle.mcpb'
  const slug = file.replace(/\.(mcpb|dxt|zip)$/i, '').replace(/[^\w.-]+/g, '-')
  const home = (await homeDir()).replace(/\/$/, '')
  const dir = `${home}/.yaam/mcpb/${slug}`
  const res = await execCommand(`mkdir -p ${shellEsc(dir)} && unzip -o ${shellEsc(path)} -d ${shellEsc(dir)} >/dev/null`, undefined, 120_000)
  if (res.code !== 0) throw new Error(`could not unpack the bundle: ${res.output.slice(0, 300)}`)
  const manifest = JSON.parse(await readTextFile(`${dir}/manifest.json`)) as McpbManifest
  const cfg = manifest.server?.mcp_config
  let command = cfg?.command
  let args = cfg?.args ?? []
  if (!command) {
    // no explicit mcp_config — derive from the declared runtime + entry point
    const entry = manifest.server?.entry_point ?? ''
    const type = manifest.server?.type ?? 'node'
    if (type === 'node') { command = 'node'; args = [`${dir}/${entry}`] }
    else if (type === 'python') { command = 'python3'; args = [`${dir}/${entry}`] }
    else { command = `${dir}/${entry}`; args = [] }
  } else {
    args = args.map(a => substitute(a, dir, manifest.user_config))
    command = substitute(command, dir, manifest.user_config)
  }
  const env = Object.entries(cfg?.env ?? {})
    .map(([k, v]) => `${k}=${substitute(v, dir, manifest.user_config)}`)
    .join('\n') || undefined
  return {
    name: manifest.display_name || manifest.name || slug,
    source: '.mcpb bundle',
    description: manifest.description,
    transport: 'stdio',
    command,
    args,
    env,
    cwd: dir,
  }
}

/** Marketplace entries not already configured. */
export function availableCatalog(existing: McpServer[]): McpCandidate[] {
  const have = new Set(existing.map(fingerprint))
  return MCP_CATALOG.filter(c => !have.has(fingerprint(c)))
}

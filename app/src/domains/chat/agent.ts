// Chat-mode session harness: a Claude-Desktop-style agent that lives in a
// workspace pane. Unlike terminal sessions (external CLIs over a PTY), a chat
// agent is an in-app LLM loop with first-class tools: navigate and edit
// files, run scripts, load skills from the registry, and call tools on the
// user's configured MCP servers.
import * as native from '../../core/native'
import { mcpCallTool } from '../../core/mcp'
import type { McpSession } from '../../core/mcp'
import type { CatalogSkill } from '../../core/skills'
import type { Agent, ChatToolEvent } from '../../core/types'
import { callApiStream } from '../../llm/client'
import type { ApiContentBlock, ApiMessage, ApiUsage, LlmConfig } from '../../llm/client'

export interface ChatTurnEvent {
  /** delta = streamed text chunk · thinking = streamed reasoning chunk ·
   *  round = current stream bubble is complete (a tool round follows) ·
   *  text = final reply · tool = tool trace */
  kind: 'tool' | 'text' | 'delta' | 'thinking' | 'round'
  text: string
  tool?: ChatToolEvent
}

const MCP_PREFIX = 'mcp__'

/** sanitize server/tool names into a valid tool identifier */
const ident = (x: string) => x.replace(/[^a-zA-Z0-9_]/g, '_')

/** App-level abilities the chat agent gets beyond the filesystem: drive the
 *  kanban board, create schedules, and save/refine skills. Implemented by the
 *  runner against the store. Every method returns a human-readable result. */
export interface ChatAppPort {
  /** ask-mode gate: render an inline approval prompt; resolves with the verdict */
  requestApproval: (tool: string, preview: string) => Promise<'once' | 'always' | 'deny'>
  listBoardTasks: () => string
  addBoardTask: (title: string, description?: string, criteria?: string[]) => string
  listSchedules: () => string
  /** cronExpr XOR atIso; the fired schedule adds a board task */
  addSchedule: (name: string, cronExpr: string | undefined, atIso: string | undefined, taskTitle: string, description?: string) => string
  /** create or update a local skill by name */
  saveSkill: (name: string, description: string, body: string) => string
  /** append one distilled fact to the workspace's durable memory */
  remember: (fact: string) => string
  /** search the assistants' shared multi-file memory */
  memoryLookup: (query: string) => string
  /** propose one-click quick replies shown under the final answer */
  suggestReplies: (replies: string[]) => string
  /** durable agents: record one lesson in the agent's LESSONS.md (or the
   *  shared memory when the agent has no home folder) */
  learnLesson: (lesson: string) => Promise<string>
  /** durable agents: ranked search over the agent's whole home folder */
  knowledgeSearch: (query: string) => Promise<string>
  /** durable agents: self-update the agent's own charter / role / settings */
  updateSelf: (patch: { name?: string; role?: string; charter?: string; model?: string; homeDir?: string }) => string
  /** durable agents: replace the markdown dashboard on the agent's home page */
  updateDashboard: (markdown: string) => string
  /** durable agents: create/update a self-contained HTML mini app by name */
  saveApp: (name: string, description: string, html: string) => string
  /** durable agents: remove one of the agent's mini apps by name */
  deleteApp: (name: string) => string
}

const READ_ONLY_TOOLS = new Set([
  'list_dir', 'read_file', 'glob_files', 'grep_files', 'web_search', 'fetch_url',
  'list_board_tasks', 'list_schedules', 'load_skill', 'memory_lookup', 'suggest_replies',
  'learn_lesson', 'knowledge_search',
])

export function toolNeedsApproval(name: string): boolean {
  return name.startsWith(MCP_PREFIX) || !READ_ONLY_TOOLS.has(name)
}

function approvalPreview(name: string, input: Record<string, unknown>): string {
  const value = name === 'run_command' ? input.command
    : name === 'run_applescript' ? input.script
      : name === 'move_path' || name === 'copy_path' ? `${String(input.from ?? '')} → ${String(input.to ?? '')}`
        : input.path ?? input.title ?? input.name ?? input.url
  return (typeof value === 'string' && value ? value : JSON.stringify(input)).slice(0, 500)
}

/** single-quote a string for POSIX shells */
const shellEsc = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#x27': "'" }
const decodeEntities = (s: string) => s.replace(/&(#?\w+);/g, (m, e: string) => {
  if (ENTITIES[e]) return ENTITIES[e]
  if (e.startsWith('#x') || e.startsWith('#X')) return String.fromCodePoint(parseInt(e.slice(2), 16) || 63)
  if (e.startsWith('#')) return String.fromCodePoint(parseInt(e.slice(1), 10) || 63)
  return m
})

/** crude but dependency-free page → readable text */
function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim()
}

/** DuckDuckGo HTML results → "title — url\nsnippet" blocks */
function parseDdg(html: string): string {
  const titles = [...html.matchAll(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)]
  const snippets = [...html.matchAll(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)]
  const out: string[] = []
  for (let i = 0; i < Math.min(titles.length, 8); i++) {
    let url = titles[i][1]
    const uddg = url.match(/[?&]uddg=([^&]+)/)
    if (uddg) url = decodeURIComponent(uddg[1])
    const title = htmlToText(titles[i][2])
    const snip = snippets[i] ? htmlToText(snippets[i][1]) : ''
    out.push(`${title}\n${url}${snip ? `\n${snip}` : ''}`)
  }
  return out.length ? out.join('\n\n') : '(no results — try a different query or fetch_url a known site)'
}

function builtinTools(skills: CatalogSkill[]) {
  return [
    {
      name: 'list_dir',
      description: 'List a directory (name + type). Use to navigate the filesystem.',
      input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
    {
      name: 'read_file',
      description: 'Read UTF-8 text file(s). Pass `paths` to read several at once. Large files are truncated; pass offset/limit (line numbers) to page.',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          paths: { type: 'array', items: { type: 'string' }, description: 'read multiple files in one call (max 8)' },
          offset: { type: 'number', description: '1-based first line' },
          limit: { type: 'number', description: 'max lines' },
        },
      },
    },
    {
      name: 'glob_files',
      description: 'Find files by name pattern (shell glob like "*.tsx" or "report*"), recursively under path (default: working folder). Skips .git and node_modules.',
      input_schema: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] },
    },
    {
      name: 'grep_files',
      description: 'Regex content search across files, returning file:line: hits. path defaults to the working folder; glob (e.g. "*.md") narrows the files searched.',
      input_schema: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' }, glob: { type: 'string' } }, required: ['pattern'] },
    },
    {
      name: 'create_dir',
      description: 'Create a directory (with parents) inside the working folder.',
      input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
    {
      name: 'move_path',
      description: 'Move or rename a file/directory. Both source and destination must be inside the working folder.',
      input_schema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] },
    },
    {
      name: 'copy_path',
      description: 'Copy a file/directory. The source may be anywhere readable; the destination must be inside the working folder.',
      input_schema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] },
    },
    {
      name: 'delete_path',
      description: 'Delete a file or directory inside the working folder. Irreversible — confirm with the user unless they clearly asked for the deletion.',
      input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
    {
      name: 'web_search',
      description: 'Search the web for current information. Returns titles, URLs, and snippets; follow up with fetch_url to read a result.',
      input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    },
    {
      name: 'fetch_url',
      description: 'Fetch a web page and return its readable text (tags stripped, capped).',
      input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    },
    {
      name: 'http_request',
      description: 'Raw HTTP request for APIs: method + url + optional headers/body. Returns status and body (capped).',
      input_schema: {
        type: 'object',
        properties: {
          method: { type: 'string', description: 'GET/POST/PUT/PATCH/DELETE…' },
          url: { type: 'string' },
          headers: { type: 'object', additionalProperties: { type: 'string' } },
          body: { type: 'string' },
        },
        required: ['method', 'url'],
      },
    },
    {
      name: 'run_applescript',
      description: 'Control native macOS apps (Finder, Mail, Safari, Calendar…) by running an AppleScript via osascript. macOS only; prefer this over pixel-guessing.',
      input_schema: { type: 'object', properties: { script: { type: 'string' } }, required: ['script'] },
    },
    {
      name: 'list_board_tasks',
      description: "List the tasks on YAAM's kanban board (id, column, title).",
      input_schema: { type: 'object', properties: {} },
    },
    {
      name: 'add_board_task',
      description: 'Add a task to the kanban board backlog so an agent session can pick it up; include acceptance criteria when the user gave any.',
      input_schema: {
        type: 'object',
        properties: { title: { type: 'string' }, description: { type: 'string' }, criteria: { type: 'array', items: { type: 'string' } } },
        required: ['title'],
      },
    },
    {
      name: 'list_schedules',
      description: 'List configured schedules (recurring crons and one-time runs).',
      input_schema: { type: 'object', properties: {} },
    },
    {
      name: 'add_schedule',
      description: 'Schedule a board task: recurring (cron expression "m h dom mon dow") or one-time (at = ISO datetime). Exactly one of cron/at.',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          cron: { type: 'string', description: 'cron expression for recurring' },
          at: { type: 'string', description: 'ISO datetime for one-time' },
          task_title: { type: 'string' },
          description: { type: 'string' },
        },
        required: ['name', 'task_title'],
      },
    },
    {
      name: 'remember',
      description: 'Save one durable fact to this workspace\'s memory (shown to every chat agent here, across restarts). Use for stable facts worth keeping: preferences, project conventions, decisions, key paths — not transient task state.',
      input_schema: { type: 'object', properties: { fact: { type: 'string', description: 'one concise sentence' } }, required: ['fact'] },
    },
    {
      name: 'memory_lookup',
      description: 'Search the assistants\' shared memory files (approvals, preferences, patterns, corrections, notes) for how the user handled similar things before. Query with a few keywords.',
      input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    },
    {
      name: 'learn_lesson',
      description: 'Record one durable lesson about how to do YOUR job better — a user correction, a stated preference, an approach that failed or worked. It lands in your LESSONS.md and rides along in every future conversation. Use it the moment you are corrected; never for transient task state.',
      input_schema: { type: 'object', properties: { lesson: { type: 'string', description: 'one concise sentence' } }, required: ['lesson'] },
    },
    {
      name: 'knowledge_search',
      description: 'Ranked keyword search over YOUR whole home folder — lessons, journal, and everything filed under knowledge/. Use it before answering anything your past self may already know (recipes, decisions, notes, project facts). Returns file:line hits; read_file the promising ones.',
      input_schema: { type: 'object', properties: { query: { type: 'string', description: 'a few keywords' } }, required: ['query'] },
    },
    {
      name: 'update_my_profile',
      description: 'Rewrite parts of YOUR OWN durable profile — the charter (your system prompt / job description), role line, name, default model, or home folder. Use when accumulated lessons show your charter should evolve, or when the user asks you to change how you operate. Pass only the fields to change; the charter you pass REPLACES the current one, so carry forward everything still true. In ask mode the user approves this first.',
      input_schema: {
        type: 'object',
        properties: {
          charter: { type: 'string', description: 'the full replacement charter' },
          role: { type: 'string' },
          name: { type: 'string' },
          model: { type: 'string' },
          home_dir: { type: 'string' },
        },
      },
    },
    {
      name: 'update_dashboard',
      description: 'Replace YOUR home-page dashboard (markdown). The user sees it when they open your agent page — keep it a live, at-a-glance status board of your domain: current focus, key facts, links to knowledge files, upcoming loop work. Update it whenever your state meaningfully changes; it fully replaces the previous dashboard.',
      input_schema: { type: 'object', properties: { markdown: { type: 'string', description: 'the full replacement dashboard (markdown)' } }, required: ['markdown'] },
    },
    {
      name: 'save_app',
      description: 'Create or update one of YOUR mini apps by name — a single self-contained HTML document shown on your home page in a sandboxed iframe (no network, no external resources; inline CSS/JS only). Build small interactive tools for your domain: a tracker, calculator, checklist, visualization. Same name = replace.',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'short app name (shown on the card)' },
          description: { type: 'string', description: 'one line: what it does' },
          html: { type: 'string', description: 'the complete HTML document' },
        },
        required: ['name', 'html'],
      },
    },
    {
      name: 'delete_app',
      description: 'Delete one of YOUR mini apps by name.',
      input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    },
    {
      name: 'suggest_replies',
      description: 'Offer up to 3 short one-click replies under your answer when the natural next step is a choice (e.g. "Yes, apply it", "Show the diff first", "Skip"). Each is sent verbatim as the user\'s next message when clicked. Skip it for open-ended answers.',
      input_schema: {
        type: 'object',
        properties: { replies: { type: 'array', items: { type: 'string' } } },
        required: ['replies'],
      },
    },
    {
      name: 'save_skill',
      description: 'Create or update a local skill (reusable instruction pack) by name — capture a workflow that went well, or rewrite an existing skill to fix weaknesses. It becomes slash-invocable immediately.',
      input_schema: {
        type: 'object',
        properties: { name: { type: 'string' }, description: { type: 'string' }, body: { type: 'string' } },
        required: ['name', 'description', 'body'],
      },
    },
    {
      name: 'write_file',
      description: 'Create or fully replace a file with the given content.',
      input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
    },
    {
      name: 'edit_file',
      description: 'Exact string replacement in a file. old_string must match exactly once (include surrounding context to disambiguate).',
      input_schema: {
        type: 'object',
        properties: { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } },
        required: ['path', 'old_string', 'new_string'],
      },
    },
    {
      name: 'run_command',
      description: 'Run a shell command (login shell, 60s timeout, output capped). cwd defaults to the session working folder.',
      input_schema: { type: 'object', properties: { command: { type: 'string' }, cwd: { type: 'string' } }, required: ['command'] },
    },
    {
      name: 'load_skill',
      description: `Load a skill (reusable instruction pack) and follow it. Available: ${skills.map(s => `${s.name} [${s.source}] — ${s.description.slice(0, 120)}`).join(' · ') || '(none available)'}`,
      input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    },
  ]
}

function mcpToolDefs(sessions: McpSession[]) {
  return sessions.flatMap(s => s.tools.map(t => ({
    name: `${MCP_PREFIX}${ident(s.serverName)}__${ident(t.name)}`,
    description: `[MCP: ${s.serverName}] ${t.description}`.slice(0, 1000),
    input_schema: t.inputSchema,
  })))
}

/** Collapse `.`/`..` segments in a POSIX-style path without touching the disk. */
function normalizePath(p: string): string {
  const abs = p.startsWith('/')
  const out: string[] = []
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') { if (out.length && out[out.length - 1] !== '..') out.pop(); else if (!abs) out.push('..') }
    else out.push(seg)
  }
  return (abs ? '/' : '') + out.join('/')
}

class ToolError extends Error {}

async function runBuiltin(name: string, input: Record<string, unknown>, agent: Agent, skills: CatalogSkill[], app?: ChatAppPort): Promise<string> {
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '')
  const root = agent.cwd ? normalizePath(agent.cwd.replace(/\/+$/, '')) : ''
  // Reads/lists resolve relative to the working folder; absolute paths pass through.
  const readPath = (k = 'path') => {
    const p = str(k)
    if (!p) throw new ToolError(`${name}: "${k}" is required`)
    if (p.startsWith('~')) throw new ToolError(`${name}: use an absolute path or one relative to the working folder, not "~"`)
    return p.startsWith('/') ? normalizePath(p) : root ? normalizePath(`${root}/${p}`) : p
  }
  // Writes are sandboxed to the working folder: paths are taken relative to it
  // and must resolve to somewhere inside it (no absolute escapes, no `..` out).
  const writePath = (k = 'path') => {
    const p = str(k)
    if (!p) throw new ToolError(`${name}: "${k}" is required`)
    if (!root) throw new ToolError(`${name}: this chat has no working folder set — cannot write files. Set one on the chat, then use paths relative to it.`)
    if (p.startsWith('~')) throw new ToolError(`${name}: use a path relative to the working folder, not "~"`)
    const full = normalizePath(p.startsWith('/') ? p : `${root}/${p}`)
    if (full !== root && !full.startsWith(`${root}/`)) {
      throw new ToolError(`${name}: refusing to write outside the working folder (${root}). Use a relative path that stays inside it.`)
    }
    return full
  }
  switch (name) {
    case 'list_dir': {
      const entries = await native.listDir(readPath())
      if (!entries.length) return '(empty directory)'
      return entries.map(e => `${e.isDir ? 'd' : '-'} ${e.name}`).join('\n')
    }
    case 'read_file': {
      const multi = Array.isArray(input.paths) ? (input.paths as unknown[]).filter((p): p is string => typeof p === 'string').slice(0, 8) : null
      const readOne = async (raw: string) => {
        const p = raw.startsWith('/') ? normalizePath(raw) : root ? normalizePath(`${root}/${raw}`) : raw
        const offset = Math.max(1, Number(input.offset) || 1)
        const limit = Math.max(1, Math.min(2000, Number(input.limit) || 800))
        // ranged read: only the requested line window crosses IPC, not the whole file
        const { lines, total, start } = await native.readTextRange(p, offset, limit)
        const body = lines.map((l, i) => `${start + i}\t${l}`).join('\n')
        const capped = body.length > 40_000 ? `${body.slice(0, 40_000)}\n… (truncated — page with offset/limit)` : body
        return `${total} lines total\n${capped}`
      }
      if (multi && multi.length) {
        const parts = await Promise.all(multi.map(async p => {
          try { return `=== ${p} ===\n${await readOne(p)}` } catch (e) { return `=== ${p} ===\nerror: ${e instanceof Error ? e.message : e}` }
        }))
        return parts.join('\n\n')
      }
      return await readOne(str('path') || (() => { throw new ToolError('read_file: "path" or "paths" is required') })())
    }
    case 'glob_files': {
      const pattern = str('pattern')
      if (!pattern) throw new ToolError('glob_files: "pattern" is required')
      const dir = str('path') ? readPath() : root
      if (!dir) throw new ToolError('glob_files: no working folder — pass "path"')
      const res = await native.execCommand(
        `find ${shellEsc(dir)} \\( -name .git -o -name node_modules \\) -prune -o -name ${shellEsc(pattern)} -print 2>/dev/null | head -200`,
        undefined, 30_000,
      )
      return res.output.trim() || '(no matches)'
    }
    case 'grep_files': {
      const pattern = str('pattern')
      if (!pattern) throw new ToolError('grep_files: "pattern" is required')
      const dir = str('path') ? readPath() : root
      if (!dir) throw new ToolError('grep_files: no working folder — pass "path"')
      const inc = str('glob') ? ` --include=${shellEsc(str('glob'))}` : ''
      const res = await native.execCommand(
        `grep -rnIE --exclude-dir=.git --exclude-dir=node_modules${inc} -e ${shellEsc(pattern)} ${shellEsc(dir)} 2>/dev/null | head -200`,
        undefined, 30_000,
      )
      const out = res.output.trim()
      return out ? (out.length > 30_000 ? `${out.slice(0, 30_000)}\n… (truncated — narrow the pattern)` : out) : '(no matches)'
    }
    case 'create_dir': {
      const target = writePath()
      await native.createDir(root, target)
      return `created ${target}`
    }
    case 'move_path': {
      const from = writePath('from')
      const to = writePath('to')
      await native.movePath(root, from, to)
      return `moved ${from} → ${to}`
    }
    case 'copy_path': {
      const from = readPath('from') // sources may be read from anywhere readable
      const to = writePath('to')
      await native.copyPath(root, from, to)
      return `copied ${from} → ${to}`
    }
    case 'delete_path': {
      const target = writePath()
      await native.deletePath(root, target)
      return `deleted ${target}`
    }
    case 'web_search': {
      const query = str('query')
      if (!query.trim()) throw new ToolError('web_search: "query" is required')
      const html = await native.httpGetText(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`)
      return parseDdg(html)
    }
    case 'fetch_url': {
      const url = str('url')
      if (!/^https?:\/\//.test(url)) throw new ToolError('fetch_url: "url" must be http(s)')
      const text = htmlToText(await native.httpGetText(url))
      return text.length > 18_000 ? `${text.slice(0, 18_000)}\n… (truncated)` : (text || '(empty page)')
    }
    case 'http_request': {
      const url = str('url')
      const method = str('method') || 'GET'
      if (!/^https?:\/\//.test(url)) throw new ToolError('http_request: "url" must be http(s)')
      const headers = (input.headers && typeof input.headers === 'object' ? input.headers : {}) as Record<string, string>
      const res = await native.httpRequest(method, url, headers, typeof input.body === 'string' ? input.body : undefined)
      const body = res.text.length > 18_000 ? `${res.text.slice(0, 18_000)}\n… (truncated)` : res.text
      return `HTTP ${res.status}${res.contentType ? ` (${res.contentType})` : ''}\n${body || '(empty body)'}`
    }
    case 'run_applescript': {
      const script = str('script')
      if (!script.trim()) throw new ToolError('run_applescript: "script" is required')
      const res = await native.execCommand(`osascript -e ${shellEsc(script)}`, undefined, 60_000)
      return `exit ${res.code}\n${res.output || '(no output)'}`
    }
    case 'list_board_tasks':
      if (!app) return 'board tools are unavailable in this context'
      return app.listBoardTasks()
    case 'add_board_task':
      if (!app) return 'board tools are unavailable in this context'
      return app.addBoardTask(str('title'), str('description') || undefined,
        Array.isArray(input.criteria) ? (input.criteria as unknown[]).filter((c): c is string => typeof c === 'string') : undefined)
    case 'list_schedules':
      if (!app) return 'schedule tools are unavailable in this context'
      return app.listSchedules()
    case 'add_schedule':
      if (!app) return 'schedule tools are unavailable in this context'
      return app.addSchedule(str('name'), str('cron') || undefined, str('at') || undefined, str('task_title'), str('description') || undefined)
    case 'remember':
      if (!app) return 'memory is unavailable in this context'
      if (!str('fact').trim()) throw new ToolError('remember: "fact" is required')
      return app.remember(str('fact').trim())
    case 'memory_lookup':
      if (!app) return 'memory is unavailable in this context'
      return app.memoryLookup(str('query'))
    case 'learn_lesson':
      if (!app) return 'lessons are unavailable in this context'
      if (!str('lesson').trim()) throw new ToolError('learn_lesson: "lesson" is required')
      return await app.learnLesson(str('lesson').trim())
    case 'knowledge_search':
      if (!app) return 'knowledge search is unavailable in this context'
      if (!str('query').trim()) throw new ToolError('knowledge_search: "query" is required')
      return await app.knowledgeSearch(str('query').trim())
    case 'update_my_profile': {
      if (!app) return 'profile updates are unavailable in this context'
      const patch = {
        name: str('name').trim() || undefined,
        role: str('role').trim() || undefined,
        charter: str('charter').trim() || undefined,
        model: str('model').trim() || undefined,
        homeDir: str('home_dir').trim() || undefined,
      }
      if (!Object.values(patch).some(Boolean)) throw new ToolError('update_my_profile: pass at least one field to change')
      return app.updateSelf(patch)
    }
    case 'update_dashboard':
      if (!app) return 'dashboard updates are unavailable in this context'
      if (!str('markdown').trim()) throw new ToolError('update_dashboard: "markdown" is required')
      return app.updateDashboard(str('markdown'))
    case 'save_app':
      if (!app) return 'mini apps are unavailable in this context'
      if (!str('name').trim() || !str('html').trim()) throw new ToolError('save_app: "name" and "html" are required')
      return app.saveApp(str('name').trim(), str('description').trim(), str('html'))
    case 'delete_app':
      if (!app) return 'mini apps are unavailable in this context'
      if (!str('name').trim()) throw new ToolError('delete_app: "name" is required')
      return app.deleteApp(str('name').trim())
    case 'suggest_replies': {
      if (!app) return 'suggestions are unavailable in this context'
      const replies = Array.isArray(input.replies)
        ? (input.replies as unknown[]).filter((r): r is string => typeof r === 'string' && !!r.trim()).map(r => r.trim().slice(0, 80)).slice(0, 3)
        : []
      if (!replies.length) throw new ToolError('suggest_replies: "replies" must be a non-empty string array')
      return app.suggestReplies(replies)
    }
    case 'save_skill':
      if (!app) return 'skill tools are unavailable in this context'
      if (!str('name') || !str('body')) throw new ToolError('save_skill: "name" and "body" are required')
      return app.saveSkill(str('name'), str('description'), str('body'))
    case 'write_file': {
      if (input.content === undefined) throw new ToolError('write_file: "content" is required')
      const target = writePath()
      // root is guaranteed by writePath(); Rust re-checks the canonical scope
      await native.writeTextFile(target, str('content'), root)
      return `wrote ${str('content').length} chars to ${target}`
    }
    case 'edit_file': {
      const target = writePath()
      const text = await native.readTextFile(target, root)
      const oldStr = str('old_string')
      if (!oldStr) return 'old_string is required'
      const count = text.split(oldStr).length - 1
      if (count === 0) return 'old_string not found — read the file and match exactly (whitespace matters)'
      if (count > 1) return `old_string occurs ${count} times — add surrounding context to make it unique`
      await native.writeTextFile(target, text.replace(oldStr, str('new_string')), root)
      return `edited ${target}`
    }
    case 'run_command': {
      const command = str('command')
      if (!command.trim()) throw new ToolError('run_command: "command" is required')
      const res = await native.execCommand(command, str('cwd') || agent.cwd || undefined, 60_000)
      return `exit ${res.code}\n${res.output || '(no output)'}`
    }
    case 'load_skill': {
      const skill = skills.find(s => s.name === str('name'))
      return skill
        ? `SKILL "${skill.name}" — follow these instructions now:\n${skill.body}`
        : `no skill named "${str('name')}". Available: ${skills.map(s => s.name).join(', ') || '(none)'}`
    }
    default:
      return `unknown tool ${name}`
  }
}

function chatSystem(agent: Agent, skills: CatalogSkill[], mcp: McpSession[], persona?: string, memory?: string, contextSummary?: string, custom?: string, durable?: string): string {
  return `${durable?.trim() ? `${durable.trim()}\n\n` : ''}You are a chat agent inside YAAM (an agent-orchestration desktop app) — the user's hands-on assistant in this workspace, like a desktop Claude. You live in a pane named "${agent.name}".

WORKING FOLDER: ${agent.cwd || '(none set — you cannot write files until the user sets one)'}
- Writes (write_file / edit_file) are sandboxed to the working folder: pass paths relative to it (e.g. "report.docx", "src/main.py"). Absolute paths or ".."/"~" that escape the folder are refused. Reads may use absolute paths.

You can navigate, find, and read files (list_dir/glob_files/grep_files/read_file), change and organize them (edit_file for surgical replacements, write_file for new/replaced files, create_dir/move_path/copy_path/delete_path), run shell scripts and commands (run_command — real execution on the user's machine), control native macOS apps (run_applescript), research the web (web_search then fetch_url; http_request for APIs), drive YAAM itself (list/add board tasks, list/add schedules — the board's watcher agents take tasks from there), save reusable skills (save_skill) plus load them (load_skill), and call tools on the user's connected MCP servers${mcp.length ? ` (${mcp.map(s => `${s.serverName}: ${s.tools.length} tools`).join(', ')})` : ' (none connected)'}.

SKILLS (load with load_skill when relevant — descriptions say when)${skills.length ? skills.map(s => `\n- ${s.name} [${s.source}]: ${(s.description || '(no description)').slice(0, 200)}`).join('') : '\n(none available)'}
${memory?.trim() ? `
MEMORY (durable workspace notes written by chat agents in earlier conversations — trust them as context, but verify anything filesystem-specific before acting on it; add new stable facts with the remember tool)
${memory.trim()}
` : `
MEMORY: empty. When you learn a stable fact worth keeping across conversations (a preference, a project convention, a decision), save it with the remember tool.
`}
${contextSummary ? `
EARLIER CONVERSATION CONTEXT (extractive summary of turns outside the recent message window; verify before acting)
${contextSummary}
` : ''}

RULES
- Ground every claim in tool results; read before you edit; verify after you change (re-read or run the relevant check).
- Prefer edit_file with exact context over rewriting whole files.
- Destructive or hard-to-undo actions (deleting files, git push, package publish, rm -rf) need the user's explicit go-ahead first.
- Some tool calls (shell commands, AppleScript, deletions) may pause for the user's inline approval. A denial is guidance, not an error — adjust course instead of retrying.
- Keep replies concise markdown. Reference files as \`path:line\`. When a skill is relevant to the request, load it before answering.
- When your answer ends on an enumerable choice, call suggest_replies so the user can answer with one click.${persona?.trim() ? `\n\nPERSONA (set by the user for this agent type)\n${persona.trim()}` : ''}${custom?.trim() ? `\n\nUSER'S CUSTOM INSTRUCTIONS FOR CHAT AGENTS (follow on top of the rules above)\n${custom.trim()}` : ''}`
}

/** Re-establish the provider invariants on a chat history: no dangling tool
 *  round at the tail, no orphaned tool carrier at the head. Chat conversations
 *  legitimately OPEN with attachment block arrays (text+image), so the generic
 *  tool-loop sanitizer — which demands a plain-string opener — would eat them;
 *  this variant only drops tool_use/tool_result carriers. */
export function sanitizeChatHistory(history: ApiMessage[]): void {
  const carriesTool = (m: ApiMessage) => Array.isArray(m.content)
    && (m.content as ApiContentBlock[]).some(b => b.type === 'tool_use' || b.type === 'tool_result')
  while (history.length && carriesTool(history[history.length - 1])) history.pop()
  while (history.length && (history[0].role !== 'user' || carriesTool(history[0]))) history.shift()
}

/** Cap the persistent conversation, then re-establish the invariants — a blind
 *  shift() can split a tool_use/tool_result pair or leave an orphaned
 *  tool_result opener. Providers reject such a history on EVERY later call,
 *  and chat histories persist across restarts, so the corruption would too. */
export function capChatHistory(history: ApiMessage[], max: number): void {
  while (history.length > max) history.shift()
  sanitizeChatHistory(history)
}

/** Replace image blocks in the history with text placeholders (for models
 *  without vision, whose APIs reject multimodal content outright). Returns
 *  true when anything was stripped; all-text arrays flatten back to strings. */
export function stripImagesFromHistory(history: ApiMessage[]): boolean {
  let stripped = false
  for (let i = 0; i < history.length; i++) {
    const m = history[i]
    if (!Array.isArray(m.content)) continue
    const blocks = m.content as ApiContentBlock[]
    if (!blocks.some(b => b.type === 'image')) continue
    stripped = true
    const replaced = blocks.map(b => b.type === 'image'
      ? { type: 'text', text: '[attached image omitted — this model does not accept images]' }
      : b)
    const allText = replaced.every(b => b.type === 'text')
    history[i] = {
      ...m,
      content: allText ? replaced.map(b => b.text ?? '').join('\n\n') : replaced,
    }
  }
  return stripped
}

/**
 * One chat turn. `history` is the session's persistent API conversation
 * (mutated in place, capped). Tool traces and the final reply stream through
 * `onEvent` so the UI can render them live.
 */
export async function runChatTurn(
  cfg: LlmConfig,
  getAgent: () => Agent | undefined,
  skills: CatalogSkill[],
  mcp: McpSession[],
  userText: string | ApiContentBlock[],
  history: ApiMessage[],
  onEvent: (e: ChatTurnEvent) => void,
  persona?: string,
  signal?: AbortSignal,
  app?: ChatAppPort,
  memory?: string,
  contextSummary?: string,
  custom?: string,
  durable?: string,
): Promise<ApiUsage | undefined> {
  // a stopped/aborted turn can leave the history mid-tool-round (assistant
  // tool_use without its tool_result) — providers reject that; drop the debris
  // and cap through the sanitizing helper (attachment block arrays are kept).
  sanitizeChatHistory(history)
  capChatHistory(history, 58)
  history.push({ role: 'user', content: userText })
  const tools = [...builtinTools(skills), ...mcpToolDefs(mcp)]
  let usage: ApiUsage | undefined
  for (let i = 0; i < 24; i++) {
    const agent = getAgent()
    if (!agent) return usage
    const stream = () => callApiStream(cfg, chatSystem(agent, skills, mcp, persona, memory, contextSummary, custom, durable), history, tools,
      (d, ch) => onEvent({ kind: ch === 'thinking' ? 'thinking' : 'delta', text: d }), signal)
    let res: Awaited<ReturnType<typeof callApiStream>>
    try {
      res = await stream()
    } catch (e) {
      // models without vision reject multimodal content outright (e.g.
      // "unknown variant `image_url`, expected `text`") — swap the images for
      // text notes and retry once instead of failing the whole turn
      const msg = e instanceof Error ? e.message : String(e)
      if (/image/i.test(msg) && stripImagesFromHistory(history)) {
        onEvent({ kind: 'tool', text: 'this model rejected image input — retrying with images omitted' })
        res = await stream()
      } else {
        throw e
      }
    }
    if (res.usage) usage = {
      inputTokens: (usage?.inputTokens ?? 0) + res.usage.inputTokens,
      outputTokens: (usage?.outputTokens ?? 0) + res.usage.outputTokens,
    }
    if (res.stop_reason !== 'tool_use') {
      const text = res.content.filter(b => b.type === 'text' && b.text).map(b => b.text).join('\n').trim()
      history.push({ role: 'assistant', content: text || '(ok)' })
      onEvent({ kind: 'text', text: text || '(no reply)' })
      break
    }
    // interim text streamed before this tool round becomes its own bubble
    onEvent({ kind: 'round', text: '' })
    const results = await Promise.all(res.content
      .filter((b): b is ApiContentBlock => b.type === 'tool_use')
      .map(async b => {
        const name = b.name ?? ''
        const input = (b.input ?? {}) as Record<string, unknown>
        let content: string
        // args that didn't fully arrive (token-limit truncation) must not run
        // with {} — that silently wrote to an empty path / ran a bare shell
        if (b.incompleteArgs) {
          content = `error: the arguments for "${name}" were cut off before they finished (likely the response hit the token limit). Retry with a smaller payload — for large files, write in sections with write_file then append via edit_file.`
          onEvent({
            kind: 'tool',
            text: `${name} — arguments truncated, not executed`,
            tool: { id: b.id ?? `tool-${i}`, at: Date.now(), name, input: JSON.stringify(input).slice(0, 2_000), result: content, status: 'truncated' },
          })
          return { type: 'tool_result', tool_use_id: b.id, content }
        }
        // Ask mode permits reads but pauses every mutating/external capability.
        const gated = toolNeedsApproval(name)
        if (gated && app && (getAgent()?.permMode ?? 'ask') !== 'auto') {
          const decision = await app.requestApproval(name, approvalPreview(name, input))
          if (decision === 'deny') {
            content = 'The user declined this action. Do not retry it as-is — ask them or take another approach.'
            onEvent({
              kind: 'tool',
              text: `${name} — denied by user`,
              tool: { id: b.id ?? `tool-${i}`, at: Date.now(), name, input: JSON.stringify(input).slice(0, 2_000), result: content, status: 'denied' },
            })
            return { type: 'tool_result', tool_use_id: b.id, content }
          }
        }
        try {
          if (name.startsWith(MCP_PREFIX)) {
            const [, server, ...rest] = name.split('__')
            const session = mcp.find(m => ident(m.serverName) === server)
            const toolName = session?.tools.find(t => ident(t.name) === rest.join('__'))?.name
            content = session && toolName ? await mcpCallTool(session, toolName, input) : `unknown MCP tool ${name}`
          } else {
            content = await runBuiltin(name, input, getAgent() ?? ({} as Agent), skills, app)
          }
        } catch (e) {
          content = `error: ${e instanceof Error ? e.message : String(e)}`
        }
        const argPreview = JSON.stringify(input).slice(0, 120)
        onEvent({
          kind: 'tool',
          text: `${name} ${argPreview} → ${content.split('\n')[0]?.slice(0, 120) ?? ''}`,
          tool: {
            id: b.id ?? `tool-${i}`,
            at: Date.now(),
            name,
            input: JSON.stringify(input).slice(0, 2_000),
            result: content.slice(0, 4_000),
            status: content.startsWith('error:') ? 'failed' : content.startsWith('The user declined') ? 'denied' : 'completed',
          },
        })
        return { type: 'tool_result', tool_use_id: b.id, content: content.slice(0, 50_000) }
      }))
    // unsigned thinking blocks never go back over the wire — providers reject
    // or mis-handle replayed reasoning. SIGNED blocks (Anthropic extended
    // thinking) must be retained: the API requires them back verbatim during a
    // tool loop, and forAnthropicWire strips/converts them per request.
    history.push({ role: 'assistant', content: res.content.filter(b => b.type !== 'thinking' || b.signature) })
    history.push({ role: 'user', content: results })
  }
  // cap the persistent conversation so long chats stay affordable
  capChatHistory(history, 60)
  return usage
}

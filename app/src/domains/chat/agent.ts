// Chat-mode session harness: a Claude-Desktop-style agent that lives in a
// workspace pane. Unlike terminal sessions (external CLIs over a PTY), a chat
// agent is an in-app LLM loop with first-class tools: navigate and edit
// files, run scripts, load skills from the registry, and call tools on the
// user's configured MCP servers.
import * as native from '../../core/native'
import { mcpCallTool } from '../../core/mcp'
import type { McpSession } from '../../core/mcp'
import type { CatalogSkill } from '../../core/skills'
import type { Agent } from '../../core/types'
import { callApiStream } from '../../llm/client'
import type { ApiContentBlock, ApiMessage, LlmConfig } from '../../llm/client'

export interface ChatTurnEvent {
  /** delta = streamed text chunk · thinking = streamed reasoning chunk ·
   *  round = current stream bubble is complete (a tool round follows) ·
   *  text = final reply · tool = tool trace */
  kind: 'tool' | 'text' | 'delta' | 'thinking' | 'round'
  text: string
}

const MCP_PREFIX = 'mcp__'

/** sanitize server/tool names into a valid tool identifier */
const ident = (x: string) => x.replace(/[^a-zA-Z0-9_]/g, '_')

/** App-level abilities the chat agent gets beyond the filesystem: drive the
 *  kanban board, create schedules, and save/refine skills. Implemented by the
 *  runner against the store. Every method returns a human-readable result. */
export interface ChatAppPort {
  listBoardTasks: () => string
  addBoardTask: (title: string, description?: string, criteria?: string[]) => string
  listSchedules: () => string
  /** cronExpr XOR atIso; the fired schedule adds a board task */
  addSchedule: (name: string, cronExpr: string | undefined, atIso: string | undefined, taskTitle: string, description?: string) => string
  /** create or update a local skill by name */
  saveSkill: (name: string, description: string, body: string) => string
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
        const text = await native.readTextFile(p)
        const lines = text.split('\n')
        const offset = Math.max(1, Number(input.offset) || 1)
        const limit = Math.max(1, Math.min(2000, Number(input.limit) || 800))
        const slice = lines.slice(offset - 1, offset - 1 + limit)
        const body = slice.map((l, i) => `${offset + i}\t${l}`).join('\n')
        const capped = body.length > 40_000 ? `${body.slice(0, 40_000)}\n… (truncated — page with offset/limit)` : body
        return `${lines.length} lines total\n${capped}`
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
      const res = await native.execCommand(`mkdir -p ${shellEsc(target)}`, undefined, 10_000)
      return res.code === 0 ? `created ${target}` : `mkdir failed: ${res.output}`
    }
    case 'move_path': {
      const from = writePath('from')
      const to = writePath('to')
      const res = await native.execCommand(`mv ${shellEsc(from)} ${shellEsc(to)}`, undefined, 10_000)
      return res.code === 0 ? `moved ${from} → ${to}` : `mv failed: ${res.output}`
    }
    case 'copy_path': {
      const from = readPath('from') // sources may be read from anywhere readable
      const to = writePath('to')
      const res = await native.execCommand(`cp -R ${shellEsc(from)} ${shellEsc(to)}`, undefined, 30_000)
      return res.code === 0 ? `copied ${from} → ${to}` : `cp failed: ${res.output}`
    }
    case 'delete_path': {
      const target = writePath()
      if (target === root) throw new ToolError('delete_path: refusing to delete the working folder itself')
      const res = await native.execCommand(`rm -rf ${shellEsc(target)}`, undefined, 10_000)
      return res.code === 0 ? `deleted ${target}` : `rm failed: ${res.output}`
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

function chatSystem(agent: Agent, skills: CatalogSkill[], mcp: McpSession[], persona?: string): string {
  return `You are a chat agent inside YAAM (an agent-orchestration desktop app) — the user's hands-on assistant in this workspace, like a desktop Claude. You live in a pane named "${agent.name}".

WORKING FOLDER: ${agent.cwd || '(none set — you cannot write files until the user sets one)'}
- Writes (write_file / edit_file) are sandboxed to the working folder: pass paths relative to it (e.g. "report.docx", "src/main.py"). Absolute paths or ".."/"~" that escape the folder are refused. Reads may use absolute paths.

You can navigate, find, and read files (list_dir/glob_files/grep_files/read_file), change and organize them (edit_file for surgical replacements, write_file for new/replaced files, create_dir/move_path/copy_path/delete_path), run shell scripts and commands (run_command — real execution on the user's machine), control native macOS apps (run_applescript), research the web (web_search then fetch_url; http_request for APIs), drive YAAM itself (list/add board tasks, list/add schedules — the board's watcher agents take tasks from there), save reusable skills (save_skill) plus load them (load_skill), and call tools on the user's connected MCP servers${mcp.length ? ` (${mcp.map(s => `${s.serverName}: ${s.tools.length} tools`).join(', ')})` : ' (none connected)'}.

SKILLS (load with load_skill when relevant — descriptions say when)${skills.length ? skills.map(s => `\n- ${s.name} [${s.source}]: ${(s.description || '(no description)').slice(0, 200)}`).join('') : '\n(none available)'}

RULES
- Ground every claim in tool results; read before you edit; verify after you change (re-read or run the relevant check).
- Prefer edit_file with exact context over rewriting whole files.
- Destructive or hard-to-undo actions (deleting files, git push, package publish, rm -rf) need the user's explicit go-ahead first.
- Keep replies concise markdown. Reference files as \`path:line\`. When a skill is relevant to the request, load it before answering.${persona?.trim() ? `\n\nPERSONA (set by the user for this agent type)\n${persona.trim()}` : ''}`
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
): Promise<void> {
  // a stopped/aborted turn can leave the history mid-tool-round (assistant
  // tool_use without its tool_result) — providers reject that; drop the debris.
  // Attachment messages (text+image block arrays) are NOT debris — only
  // tool_use/tool_result carriers are.
  const isDangling = (m: ApiMessage) => Array.isArray(m.content)
    && (m.content as ApiContentBlock[]).some(b => b.type === 'tool_use' || b.type === 'tool_result')
  while (history.length && isDangling(history[history.length - 1])) history.pop()
  history.push({ role: 'user', content: userText })
  const tools = [...builtinTools(skills), ...mcpToolDefs(mcp)]
  for (let i = 0; i < 24; i++) {
    const agent = getAgent()
    if (!agent) return
    const res = await callApiStream(cfg, chatSystem(agent, skills, mcp, persona), history, tools,
      (d, ch) => onEvent({ kind: ch === 'thinking' ? 'thinking' : 'delta', text: d }), signal)
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
          onEvent({ kind: 'tool', text: `${name} — arguments truncated, not executed` })
          return { type: 'tool_result', tool_use_id: b.id, content }
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
        onEvent({ kind: 'tool', text: `${name} ${argPreview} → ${content.split('\n')[0]?.slice(0, 120) ?? ''}` })
        return { type: 'tool_result', tool_use_id: b.id, content: content.slice(0, 50_000) }
      }))
    // thinking blocks never go back over the wire — providers reject or
    // mis-handle replayed reasoning, and it wastes tokens
    history.push({ role: 'assistant', content: res.content.filter(b => b.type !== 'thinking') })
    history.push({ role: 'user', content: results })
  }
  // cap the persistent conversation so long chats stay affordable
  while (history.length > 60) history.shift()
  if (history.length && history[0].role !== 'user') history.shift()
}

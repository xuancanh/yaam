// Chat-mode session harness: a Claude-Desktop-style agent that lives in a
// workspace pane. Unlike terminal sessions (external CLIs over a PTY), a chat
// agent is an in-app LLM loop with first-class tools: navigate and edit
// files, run scripts, load skills from the registry, and call tools on the
// user's configured MCP servers.
import * as native from '../native'
import { mcpCallTool } from '../mcp'
import type { McpSession } from '../mcp'
import type { Agent, Skill } from '../types'
import { callApi } from './client'
import type { ApiContentBlock, ApiMessage, LlmConfig } from './client'

export interface ChatTurnEvent {
  kind: 'tool' | 'text'
  text: string
}

const MCP_PREFIX = 'mcp__'

/** sanitize server/tool names into a valid tool identifier */
const ident = (x: string) => x.replace(/[^a-zA-Z0-9_]/g, '_')

function builtinTools(skills: Skill[]) {
  return [
    {
      name: 'list_dir',
      description: 'List a directory (name + type). Use to navigate the filesystem.',
      input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
    {
      name: 'read_file',
      description: 'Read a UTF-8 text file. Large files are truncated; pass offset/limit (line numbers) to page.',
      input_schema: {
        type: 'object',
        properties: { path: { type: 'string' }, offset: { type: 'number', description: '1-based first line' }, limit: { type: 'number', description: 'max lines' } },
        required: ['path'],
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
      description: `Load a skill (reusable instruction pack) from the registry and follow it. Available: ${skills.map(s => `${s.name} — ${s.description}`).join(' · ') || '(none registered)'}`,
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

async function runBuiltin(name: string, input: Record<string, unknown>, agent: Agent, skills: Skill[]): Promise<string> {
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '')
  switch (name) {
    case 'list_dir': {
      const entries = await native.listDir(str('path'))
      if (!entries.length) return '(empty directory)'
      return entries.map(e => `${e.isDir ? 'd' : '-'} ${e.name}`).join('\n')
    }
    case 'read_file': {
      const text = await native.readTextFile(str('path'))
      const lines = text.split('\n')
      const offset = Math.max(1, Number(input.offset) || 1)
      const limit = Math.max(1, Math.min(2000, Number(input.limit) || 800))
      const slice = lines.slice(offset - 1, offset - 1 + limit)
      const body = slice.map((l, i) => `${offset + i}\t${l}`).join('\n')
      const capped = body.length > 40_000 ? `${body.slice(0, 40_000)}\n… (truncated — page with offset/limit)` : body
      return `${lines.length} lines total\n${capped}`
    }
    case 'write_file':
      await native.writeTextFile(str('path'), str('content'))
      return `wrote ${str('content').length} chars to ${str('path')}`
    case 'edit_file': {
      const path = str('path')
      const text = await native.readTextFile(path)
      const oldStr = str('old_string')
      if (!oldStr) return 'old_string is required'
      const count = text.split(oldStr).length - 1
      if (count === 0) return 'old_string not found — read the file and match exactly (whitespace matters)'
      if (count > 1) return `old_string occurs ${count} times — add surrounding context to make it unique`
      await native.writeTextFile(path, text.replace(oldStr, str('new_string')))
      return `edited ${path}`
    }
    case 'run_command': {
      const res = await native.execCommand(str('command'), str('cwd') || agent.cwd || undefined, 60_000)
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

function chatSystem(agent: Agent, skills: Skill[], mcp: McpSession[], persona?: string): string {
  return `You are a chat agent inside YAAM (an agent-orchestration desktop app) — the user's hands-on assistant in this workspace, like a desktop Claude. You live in a pane named "${agent.name}".

WORKING FOLDER: ${agent.cwd || '(none set — ask before touching files, or use absolute paths)'}

You can navigate and read files (list_dir/read_file), change them (edit_file for surgical replacements, write_file for new/replaced files), run shell scripts and commands (run_command — real execution on the user's machine), load skills from the user's registry (load_skill) and follow them, and call tools on the user's connected MCP servers${mcp.length ? ` (${mcp.map(s => `${s.serverName}: ${s.tools.length} tools`).join(', ')})` : ' (none connected)'}.

SKILLS REGISTRY${skills.length ? skills.map(s => `\n- ${s.name}: ${s.description || '(no description)'}`).join('') : '\n(empty)'}

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
  skills: Skill[],
  mcp: McpSession[],
  userText: string,
  history: ApiMessage[],
  onEvent: (e: ChatTurnEvent) => void,
  persona?: string,
): Promise<void> {
  history.push({ role: 'user', content: userText })
  const tools = [...builtinTools(skills), ...mcpToolDefs(mcp)]
  for (let i = 0; i < 24; i++) {
    const agent = getAgent()
    if (!agent) return
    const res = await callApi(cfg, chatSystem(agent, skills, mcp, persona), history, tools)
    if (res.stop_reason !== 'tool_use') {
      const text = res.content.filter(b => b.type === 'text' && b.text).map(b => b.text).join('\n').trim()
      history.push({ role: 'assistant', content: text || '(ok)' })
      onEvent({ kind: 'text', text: text || '(no reply)' })
      break
    }
    const results = await Promise.all(res.content
      .filter((b): b is ApiContentBlock => b.type === 'tool_use')
      .map(async b => {
        const name = b.name ?? ''
        const input = (b.input ?? {}) as Record<string, unknown>
        let content: string
        try {
          if (name.startsWith(MCP_PREFIX)) {
            const [, server, ...rest] = name.split('__')
            const session = mcp.find(m => ident(m.serverName) === server)
            const toolName = session?.tools.find(t => ident(t.name) === rest.join('__'))?.name
            content = session && toolName ? await mcpCallTool(session, toolName, input) : `unknown MCP tool ${name}`
          } else {
            content = await runBuiltin(name, input, getAgent() ?? ({} as Agent), skills)
          }
        } catch (e) {
          content = `error: ${e instanceof Error ? e.message : String(e)}`
        }
        const argPreview = JSON.stringify(input).slice(0, 120)
        onEvent({ kind: 'tool', text: `${name} ${argPreview} → ${content.split('\n')[0]?.slice(0, 120) ?? ''}` })
        return { type: 'tool_result', tool_use_id: b.id, content: content.slice(0, 50_000) }
      }))
    history.push({ role: 'assistant', content: res.content })
    history.push({ role: 'user', content: results })
  }
  // cap the persistent conversation so long chats stay affordable
  while (history.length > 60) history.shift()
  if (history.length && history[0].role !== 'user') history.shift()
}

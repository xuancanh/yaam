// Master's tool surface: definitions + dispatcher. Implementations (exec)
// live in the store, where app state and the PTY layer are reachable.
export interface MasterExec {
  launchSession: (command: string, cwd: string, name?: string) => string
  sendToSession: (sessionId: string, text: string) => Promise<string>
  pressKeys: (sessionId: string, keys: string[]) => Promise<string>
  stopSession: (sessionId: string) => string
  readSession: (sessionId: string, lines?: number) => string
  flagNeedsInput: (sessionId: string, question: string) => string
  renameSession: (sessionId: string, name: string) => string
  updateAgentStatus: (sessionId: string, task?: string, summary?: string, actionNeeded?: string) => string
  configureSetting: (key: string, value: string) => string
  setToolPermission: (toolId: string, perm: string) => string
  toggleSchedule: (name: string, on: boolean) => string
  deleteSchedule: (name: string) => string
  createAddon: (name: string, icon: string, html: string, desc?: string) => string
  removeAddon: (name: string) => string
  createSchedule: (name: string, cron: string, command?: string, cwd?: string) => string
  addTask: (title: string) => string
}

export const TOOLS = [
  {
    name: 'launch_session',
    description: 'Launch a CLI command as a new live agent session. Returns the new session id.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'full command line, e.g. "claude -p" or "zsh -i"' },
        cwd: { type: 'string', description: 'working directory (optional)' },
        name: { type: 'string', description: 'display name (optional)' },
      },
      required: ['command'],
    },
  },
  {
    name: 'send_to_session',
    description: 'Type a message into a session and press Enter. Returns the session\'s screen ~1.5s later so you can see the effect. For answering TUI dialogs/menus use press_keys instead — text input does not drive menus.',
    input_schema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        text: { type: 'string' },
      },
      required: ['session_id', 'text'],
    },
  },
  {
    name: 'press_keys',
    description: 'Send keystrokes to a session — the way to drive TUI dialogs and selection menus. keys is a sequence of: "enter", "esc", "up", "down", "left", "right", "tab", "space", "backspace", "ctrl+c", or a single literal character (e.g. "1", "y"). Keys are pressed in order with realistic gaps; returns the screen afterwards so you can verify.',
    input_schema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        keys: { type: 'array', items: { type: 'string' } },
      },
      required: ['session_id', 'keys'],
    },
  },
  {
    name: 'read_session',
    description: 'Read the most recent terminal output of a session (ANSI-stripped). Use this to check what an agent is doing or whether it finished.',
    input_schema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        lines: { type: 'number', description: 'how many lines from the end (default 40, max 120)' },
      },
      required: ['session_id'],
    },
  },
  {
    name: 'configure_setting',
    description: 'Change an app setting. Keys: autoRoute, approveDestructive, followMode (true/false), shell (zsh/bash/…), defaultCwd (path), masterModel (model id). API keys and provider cannot be changed from chat.',
    input_schema: {
      type: 'object',
      properties: { key: { type: 'string' }, value: { type: 'string' } },
      required: ['key', 'value'],
    },
  },
  {
    name: 'set_tool_permission',
    description: 'Set the permission of one of your global tools in the Tools registry. perm: Off | Ask first | Auto | Approval.',
    input_schema: {
      type: 'object',
      properties: { tool_id: { type: 'string' }, perm: { type: 'string' } },
      required: ['tool_id', 'perm'],
    },
  },
  {
    name: 'toggle_schedule',
    description: 'Enable or disable a schedule by name.',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string' }, on: { type: 'boolean' } },
      required: ['name', 'on'],
    },
  },
  {
    name: 'delete_schedule',
    description: 'Delete a schedule by name.',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
  },
  {
    name: 'create_addon',
    description: `Create (or replace, by name) an addon: a custom tab in the app's icon rail rendering a self-contained HTML document in a sandboxed iframe. Use this when the user asks for a new panel/view/feature. The document gets live app state over postMessage:
- receive: window.addEventListener('message', e => { if (e.data.type === 'yaam:state') render(e.data.state) }) — pushed on load and every ~3s
- request once: parent.postMessage({ type: 'yaam:getState' }, '*')
state = { sessions: [{ id, name, status, task, summary, actionNeeded, cost, used }], tasks: [{ title, col }], crons: [{ name, schedule, on, last }], events: [{ time, type, text }], totals: { cost, used, running } }
Style to match the app: dark background #0A0B0F, text #E7E9F0, muted #8B93A1, accent #F5C451, mono font 'JetBrains Mono', sans 'IBM Plex Sans', panel #0D0F14, border #23272F. No external network calls.`,
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        icon: { type: 'string', description: 'single character or emoji for the rail tab' },
        html: { type: 'string', description: 'complete HTML document (<!DOCTYPE html>…) with inline CSS/JS' },
        desc: { type: 'string' },
      },
      required: ['name', 'icon', 'html'],
    },
  },
  {
    name: 'remove_addon',
    description: 'Remove an addon tab by name.',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
  },
  {
    name: 'update_agent_status',
    description: 'Update a session\'s card on the Agents overview: what it is working on (task), a 1-2 sentence state summary, and what the user must do if anything (action_needed, empty string to clear). Call this whenever you review a session\'s output so the overview stays current.',
    input_schema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        task: { type: 'string' },
        summary: { type: 'string' },
        action_needed: { type: 'string' },
      },
      required: ['session_id'],
    },
  },
  {
    name: 'rename_session',
    description: 'Rename a session (its display name in tabs, panes, and lists).',
    input_schema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        name: { type: 'string' },
      },
      required: ['session_id', 'name'],
    },
  },
  {
    name: 'flag_needs_input',
    description: 'Mark a session as waiting for the user: shows a Needs-action banner, sends a notification, and puts an approve/deny card in chat. Call this when a session\'s output shows it is blocked on user input or permission.',
    input_schema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        question: { type: 'string', description: 'what the session is asking, quoted or paraphrased' },
      },
      required: ['session_id', 'question'],
    },
  },
  {
    name: 'stop_session',
    description: 'Stop (kill) a running session.',
    input_schema: {
      type: 'object',
      properties: { session_id: { type: 'string' } },
      required: ['session_id'],
    },
  },
  {
    name: 'create_schedule',
    description: 'Create a recurring schedule (5-field cron). If command is set, each run launches it as a live session.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        cron: { type: 'string', description: 'e.g. "0 3 * * *"' },
        command: { type: 'string' },
        cwd: { type: 'string' },
      },
      required: ['name', 'cron'],
    },
  },
  {
    name: 'add_task',
    description: 'Add a task card to the board backlog.',
    input_schema: {
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
    },
  },
]

export async function runTool(name: string, input: Record<string, unknown>, exec: MasterExec): Promise<string> {
  const str = (k: string) => typeof input[k] === 'string' ? input[k] as string : ''
  switch (name) {
    case 'launch_session': return exec.launchSession(str('command'), str('cwd'), str('name') || undefined)
    case 'send_to_session': return exec.sendToSession(str('session_id'), str('text'))
    case 'press_keys': return exec.pressKeys(str('session_id'), Array.isArray(input.keys) ? (input.keys as unknown[]).filter((k): k is string => typeof k === 'string') : [])
    case 'stop_session': return exec.stopSession(str('session_id'))
    case 'read_session': return exec.readSession(str('session_id'), typeof input.lines === 'number' ? input.lines : undefined)
    case 'flag_needs_input': return exec.flagNeedsInput(str('session_id'), str('question'))
    case 'rename_session': return exec.renameSession(str('session_id'), str('name'))
    case 'configure_setting': return exec.configureSetting(str('key'), str('value'))
    case 'set_tool_permission': return exec.setToolPermission(str('tool_id'), str('perm'))
    case 'toggle_schedule': return exec.toggleSchedule(str('name'), input.on === true)
    case 'delete_schedule': return exec.deleteSchedule(str('name'))
    case 'create_addon': return exec.createAddon(str('name'), str('icon'), str('html'), str('desc') || undefined)
    case 'remove_addon': return exec.removeAddon(str('name'))
    case 'update_agent_status': return exec.updateAgentStatus(
      str('session_id'),
      typeof input.task === 'string' ? input.task : undefined,
      typeof input.summary === 'string' ? input.summary : undefined,
      typeof input.action_needed === 'string' ? input.action_needed : undefined,
    )
    case 'create_schedule': return exec.createSchedule(str('name'), str('cron'), str('command') || undefined, str('cwd') || undefined)
    case 'add_task': return exec.addTask(str('title'))
    default: return `unknown tool ${name}`
  }
}


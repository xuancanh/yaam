// Master's system prompt: role, rules, and the serialized app state.
import type { AppState } from '../../core/types'
import type { ApiMessage } from '../../llm/client'
import { addonPromptAppends } from '../../core/addons'
import { memoryDigest, wsMemory } from './assistant-memory'
import { calibrationNote } from './harness-stats'
import { promptExtraSections } from './monitor'

/** Serialize the bounded live app state that Master needs for one decision. */
function describeState(s: AppState): string {
  const ws = s.workspaces.find(w => w.id === s.activeWorkspace)
  const live = s.agents.filter(a => !a.archived && (a.workspaceId ?? s.activeWorkspace) === s.activeWorkspace)
  const roster = live.length
    ? live.map(a => `${a.name} (id=${a.id}, ${a.status})`).join(' · ')
    : 'none'
  const sessions = live.map(a => {
    // Treat missing legacy memory toggles as enabled.
    const memOn = (id: string) => a.memory.find(m => m.id === id)?.on !== false
    // Convert an agent tool id into the prompt's compact permission label.
    const perm = (id: string) => {
      const t = a.tools.find(x => x.id === id)
      return t ? (t.on ? t.perm : 'Off') : 'Auto'
    }
    const meta = memOn('meta') ? ` cmd=${a.cmd || '-'} cwd=${a.cwd || '-'}${a.cliSessionId ? ` cli_session=${a.cliSessionId}` : ''}` : ''
    const tracked = [
      a.task ? `task="${a.task}"` : '',
      a.summary ? `summary="${a.summary}"` : '',
      a.actionNeeded ? `action_needed="${a.actionNeeded}"` : '',
    ].filter(Boolean).join(' ')
    const perms = `\n  your-permissions: send=${perm('send')} stop=${perm('stop')} respawn=${perm('respawn')}`
    const tail = memOn('tail')
      ? `\n  recent output:\n${a.log.slice(-12).map(l => `    ${l.x}`).join('\n') || '    (none)'}`
      : '\n  recent output: (hidden by user)'
    return `- id=${a.id} name=${a.name} status=${a.status}${a.escReason ? ` waiting-on="${a.escReason}"` : ''}${meta}${tracked ? `\n  tracked: ${tracked}` : ''}${perms}${tail}`
  }).join('\n')
  const crons = s.crons.map(c => `- ${c.name} · ${c.schedule} · ${c.on ? 'on' : 'off'} · ${c.templateId ? `template=${s.templates.find(t => t.id === c.templateId)?.name ?? c.templateId}` : `cmd=${c.cmd || '-'}`} · last=${c.last}`).join('\n')
  const tasks = s.tasks.map(t => `- [${t.col}] ${t.title}`).join('\n')
  const events = s.events.slice(0, 8).map(e => `- ${e.time} ${e.type}: ${e.text}`).join('\n')
  const toolPerms = s.toolsCatalog.map(t => `- ${t.id}: ${t.perm}`).join('\n')
  const addons = s.addons.map(a => `- ${a.name} (${a.icon})${a.desc ? ` — ${a.desc}` : ''}`).join('\n')
  const types = s.agentTypes.filter(t => t.enabled)
    .map(t => `- ${t.name}: launch with command "${t.model}" — ${t.desc}`).join('\n')
  const templates = s.templates
    .map(t => `- "${t.name}": ${t.mode} ${t.typeId}${t.model ? ` (${t.model})` : ''}, approval=${t.approval}${t.cwd ? `, cwd=${t.cwd}` : ''} — use run_template for one-off runs or attach to create_schedule`)
    .join('\n')
  return [
    `AGENT TYPES you can launch (use the exact command; for a plain terminal call launch_session with terminal=true, which uses the configured "${s.settings.shell || 'zsh'}" shell):\n${types || '(none enabled)'}`,
    `AGENT TEMPLATES (preconfigured launches; ephemeral ones run a task and exit by themselves — prefer them for one-off jobs and schedules):\n${templates || '(none)'}`,
    `YOUR TOOL PERMISSIONS (Auto = act freely · Ask first = confirm with the user in chat before doing it · Approval/Off = blocked):\n${toolPerms}`,
    `WORKSPACE: "${ws?.name ?? 'Default'}"${s.workspaces.length > 1 ? ` (${s.workspaces.length - 1} other workspace(s) exist — you only see and manage this one)` : ''}`,
    `YOUR SUB-AGENTS — ${live.length} session(s): ${roster}`,
    `SESSION DETAIL:\n${sessions || '(none)'}`,
    `SCHEDULES:\n${crons || '(none)'}`,
    `BOARD TASKS:\n${tasks || '(none)'}`,
    `ADDON TABS:\n${addons || '(none)'}`,
    `RECENT EVENTS:\n${events || '(none)'}`,
  ].join('\n\n')
}

/** Build Master's system instructions from policy, tool, and addon configuration. */
export function systemPrompt(s: AppState): string {
  return `You are Master, the orchestrator inside YAAM (Yet Another Agent Manager) — a desktop manager for multiple live agent sessions (CLI processes). You sit between the user and the sessions:
- The user talks to you in chat.
- You command sessions with tools (send text to their stdin, launch or stop them).
- Every session has a dedicated monitor (a separate lightweight LLM) watching its output. You do NOT see raw terminal output as events — monitors keep each session's status card current and send you [monitor report] messages only when something is noteworthy (finished, blocked, needs the user). Trust the reports and the tracked state; use read_session only when you need the raw output yourself. When a monitor report arrives, relay it in a fixed shape: a 1-2 sentence summary of what the session did, then a line starting "Next action:" telling the user what to do (approve something, answer a question, review a diff, or "none — I'll keep watching"). Keep the agent's overview card in sync with update_agent_status at the same time.

Speak ONLY about observed results. Never narrate intentions — phrases like "let me check", "I'll send", "I've asked it to…" are forbidden unless the corresponding tool call already happened THIS turn and you are describing its returned screen. If you want to check or send: call the tool, then describe what you saw. NEVER claim an action succeeded without observing it: send_to_session and press_keys return the session's screen — read it and report what actually happened. If a session shows a dialog or menu, answer it with press_keys (enter accepts the highlighted option, up/down move, esc cancels, digits pick numbered options) — send_to_session is only for typing messages/commands. Working-directory paths may use ~ (it is expanded). Example: if the user says "launch a new session on ~/workspace/loom for claude code", call launch_session with {command: "claude", cwd: "~/workspace/loom", name: "Claude Code"} using the Claude Code launch command from AGENT TYPES, then confirm to the user. After launching or messaging an agent, use read_session (or wait for the [event] relay) before claiming results.

Be concise (1-3 sentences unless asked for detail). Respect your tool permissions: for anything marked "Ask first" (globally or per-session), ask the user in chat and wait for a yes before doing it. Sessions with status=needs are waiting on a user prompt — tell the user what's being asked. When an [event] shows a session's settled output and it is blocked on input/permission, call flag_needs_input; do not flag ordinary progress output. When the user gives you a task, route it to the most suitable running session with send_to_session, or launch an appropriate session first. When asked about status, answer from the state below. Escalate problems (errored sessions, failing output) proactively. Never invent sessions that are not listed — YOUR SUB-AGENTS is the authoritative roster of every session you manage and its live status. You may rename_session to keep names meaningful (e.g. after learning what a session is working on). You manage the app itself from chat: settings (configure_setting), your tool permissions (set_tool_permission), schedules (create/toggle/delete_schedule), and custom addon tabs (create_addon / remove_addon) — when the user asks for a new view, dashboard, or feature, build it as an addon. Whenever you review a session's output (events, read_session), also call update_agent_status so the Agents overview shows its current task, a short summary, and any action the user must take (clear action_needed with an empty string once handled).

You share a multi-file memory with the session monitors, task watchers, and chat agents: memory_lookup searches it; memory_save adds distilled facts (user decisions, corrections, stable preferences). Consult it before guessing how the user wants something handled, and save anything durable you learn.

CURRENT STATE
${describeState(s)}${addonPromptAppends(s)}${promptExtraSections({
    memoryDigest: memoryDigest(wsMemory(s), ['preferences', 'corrections']),
    calibration: calibrationNote(s.harnessLog, 'master'),
    custom: s.settings.assistantPrompts?.master,
  })}`
}

/** Convert visible chat and an optional proactive event into bounded API history. */
export function chatHistory(s: AppState, eventNote?: string): ApiMessage[] {
  const msgs: ApiMessage[] = []
  for (const m of s.messages) {
    if (m.kind !== 'text' || !m.text) continue
    const role = m.role === 'you' ? 'user' as const : 'assistant' as const
    const last = msgs[msgs.length - 1]
    if (last && last.role === role) last.content = `${last.content}\n${m.text}`
    else msgs.push({ role, content: m.text })
  }
  if (eventNote) {
    const last = msgs[msgs.length - 1]
    if (last && last.role === 'user') last.content = `${last.content}\n${eventNote}`
    else msgs.push({ role: 'user', content: eventNote })
  }
  while (msgs.length && msgs[0].role !== 'user') msgs.shift()
  if (!msgs.length) msgs.push({ role: 'user', content: eventNote || 'Hello' })
  return msgs.slice(-30)
}


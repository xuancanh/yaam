// Per-addon customization chat: a small dedicated LLM conversation that knows
// one addon package and edits it via the update_addon tool.
import type { ApiMessage, LlmConfig } from '../../llm/client'
import { capToolHistory, runToolLoop, sanitizeToolHistory } from '../../llm/tool-loop'

const EDITOR_TOOLS = [
  {
    name: 'update_addon',
    description: 'Replace the addon with an updated package. Pass the COMPLETE package JSON — every field, not a diff.',
    input_schema: {
      type: 'object',
      properties: {
        package_json: { type: 'string', description: 'full manifest-2 package JSON: { name, version, icon, description, html?, tools?, hooks? }' },
      },
      required: ['package_json'],
    },
  },
]

/** Build the scoped addon-editor prompt with the current package as source of truth. */
function editorSystem(addonJson: string): string {
  return `You customize exactly ONE addon package for YAAM (an agent-manager desktop app). The user chats with you to change it; apply changes with the update_addon tool, passing the COMPLETE updated package JSON.

Package rules:
- html (optional): a complete self-contained HTML document rendered in a sandboxed iframe.
The view gets live state AND can call the app over postMessage RPC:
- state push: window.addEventListener('message', e => { if (e.data.type === 'yaam:state') render(e.data.state) }) — pushed on load and every ~3s. state = { workspace, sessions:[{id,name,status,task,summary,actionNeeded,cwd,cost,used}], tasks:[{id,title,col,agentId}], crons, events, totals }
- calls: const pend = {}; function yaam(method, ...args){ return new Promise((res, rej) => { const id = Math.random().toString(36).slice(2); pend[id] = { res, rej }; parent.postMessage({ type: 'yaam:call', callId: id, method, args }, '*') }) }; window.addEventListener('message', e => { const d = e.data; if (d.type === 'yaam:result' && pend[d.callId]) { d.error ? pend[d.callId].rej(new Error(d.error)) : pend[d.callId].res(d.result); delete pend[d.callId] } })
- methods (each needs its permission granted): getState, sessions.readOutput(id, lines), templates.list(), tasks.get(id) [state:read] · sendToSession(id, text), sessions.stop(id) [sessions:send] · launchSession(cmd, cwd, name), templates.run(idOrName, task) [sessions:launch] · focusSession(id), flash(t), notify(title, detail), logEvent(t) [ui] · tasks.add(title, col, {description, criteria[], cwd, typeId, templateId, machineId, isolate, sessionMode, scheduleAt})/tasks.update(id, patch)/tasks.rename/tasks.move(id, col)/tasks.remove(id)/tasks.start(id)/tasks.restart(id)/tasks.chat(id, text)/tasks.approve(id)/tasks.reject(id, feedback) [tasks] (cols: backlog|progress|review|done|failed; started tasks get a watcher-driven one-shot by default; tasks.chat talks to the task's watcher; approve merges isolated worktrees) · schedules.add({name, schedule|at, cmd|task})/schedules.toggle(name, on)/schedules.remove(name) [schedules] · agent.wake(note) → reply [agent] (the addon's own LLM agent, declared via an "agent": {system, on: [hooks], every: cron} field) · storage.get(key)/storage.set(key, value)/storage.list()/storage.remove(key) [storage] · http.request(method, url, {headers, body}) → {status, contentType, text} [http] (host must be in the package's "hosts" allowlist, https only; header/body values may embed {{secret:NAME}} — declared in the package's "secrets", stored in the OS keychain, never readable) · secrets.list() → [{name, label, set}] [secrets]
- hooks available: onSessionExit {sessionId, name, code} · onNeedsInput {sessionId, name, question} · onTaskMoved {taskId, title, col, from} · onCronFired {name, kind} · masterPromptAppend (plain text)
- declare needed scopes in the package: "permissions": ["state:read", "tasks", "ui", ...] — request only what you use. Match the app theme: background #0A0B0F, panel #0D0F14, border #23272F, text #E7E9F0, muted #8B93A1, accent #F5C451, fonts 'IBM Plex Sans' / 'JetBrains Mono'. No external network calls.
- tools (optional): [{ name, description, input_schema, handler }] — handler is a JS function body (input, api) => string, api = { getState(), sendToSession(id, text), launchSession(cmd, cwd, name), flash(t), logEvent(t), notify(title, detail) }.
- hooks (optional): { onSessionExit, onNeedsInput: JS bodies (input = event, api) => void, masterPromptAppend: string }.
- Keep the name unless the user asks to change it; bump the patch version on every change.
- After updating, reply with 1-2 sentences describing what changed. Never claim a change you did not apply with the tool.

CURRENT PACKAGE:
${addonJson}`
}

/** Run one addon-customization turn and return the validated replacement package. */
export async function runAddonEditorTurn(
  cfg: LlmConfig,
  addonJson: string,
  history: ApiMessage[],
  userText: string,
  apply: (packageJson: string) => string,
): Promise<string> {
  // a previous failed/aborted turn can leave dangling tool rounds — providers
  // reject those, which would silence this editor on every later turn
  sanitizeToolHistory(history)
  history.push({ role: 'user', content: userText })
  const { text } = await runToolLoop({
    cfg, system: editorSystem(addonJson), history, tools: EDITOR_TOOLS, maxRounds: 4,
    sequential: true, terminalAssistant: 'text',
    execute: async (_name, input) => apply(typeof input?.package_json === 'string' ? input.package_json : ''),
  })
  // cap through the sanitizing helper — a blind shift() can split a
  // tool_use/tool_result pair or leave an orphaned tool_result at the head
  capToolHistory(history, 20)
  return text
}

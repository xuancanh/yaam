// One-shot addon generation: the user describes what they want, the model
// gets the COMPLETE authoring context (formats, bridge protocol, API surface,
// hooks, agents, theme, security rules), and submits a package that is
// validated before install — validation errors are fed back for self-repair.
import { parseAddonPackage } from '../../core/addons'
import { callApi } from '../../llm/client'
import type { ApiContentBlock, ApiMessage, LlmConfig } from '../../llm/client'

const GEN_TOOL = [{
  name: 'submit_addon',
  description: 'Submit the complete addon package as a JSON string. It is validated immediately; you get errors back to fix.',
  input_schema: {
    type: 'object',
    properties: { package_json: { type: 'string', description: 'the full package: {"manifest":2,"name",…} as one JSON string' } },
    required: ['package_json'],
  },
}]

// The full authoring guide — everything an author (human or model) needs.
const GEN_SYSTEM = `You are an expert addon author for YAAM (an agent-orchestration desktop app). Produce ONE complete addon package and submit it via submit_addon as a JSON string.

PACKAGE SHAPE (single-file, manifest 2)
{
  "manifest": 2,
  "name": "kebab-or-title",           // unique; installs replace by name
  "version": "1.0.0",
  "icon": "🧩",                        // 1-2 chars, shown in the icon rail
  "description": "what it does",
  "author": "generated",
  "permissions": [...],                // ONLY the scopes actually used
  "html": "<!DOCTYPE html>…",          // optional view (tab)
  "tools": [{ "name", "description", "input_schema", "handler" }],   // optional Master tools
  "hooks": { ... },                    // optional lifecycle hooks
  "agent": { "system": "...", "on": ["onSessionExit"], "every": "*/30 * * * *" },  // optional: the addon's own LLM agent; "every" = cron that wakes it periodically
  "hosts": ["api.github.com", "*.example.com"],   // http.request allowlist (https only); omit if no network
  "secrets": [{ "name": "API_TOKEN", "label": "what to paste" }]     // keychain slots the user fills in the Addons view
}
A package must contain at least one of html / tools / hooks / agent.

PERMISSION SCOPES (request only what the code calls)
- state:read     → getState(), sessions.readOutput(id, lines), templates.list(), tasks.get(id) (full detail: spec, watcherNote, chat, sessions)
- sessions:send  → sendToSession(id, text), sessions.stop(id)
- sessions:launch→ launchSession(cmd, cwd?, name?), templates.run(idOrName, task?)
- tasks          → tasks.add(title, col?, {description, criteria[], cwd, typeId, templateId, machineId, isolate, sessionMode: 'oneshot'|'interactive', scheduleAt: epochMs}) → id · tasks.update(id, patch) · tasks.rename(id, title) · tasks.move(id, col) · tasks.remove(id) · tasks.start(id) · tasks.restart(id) · tasks.chat(id, text) · tasks.approve(id) (review → done, merges isolated worktree) · tasks.reject(id, feedback)
                   (cols: backlog|progress|review|done|failed; started tasks get a watcher-driven session — one-shot by default — with the spec+criteria as a goal; isolate=true runs it in a git worktree reviewed via the queue; machineId runs it on a saved remote machine; scheduleAt defers the start)
- schedules      → schedules.add({name, schedule: '5-field cron' | at: epochMs, cmd?, cwd?, task?: {title, description, criteria, cwd, machineId, isolate, sessionMode, startNow}}) · schedules.toggle(name, on?) · schedules.remove(name)
- agent          → agent.wake(note) → Promise<reply string> (the addon's own agent; costs API tokens)
- ui             → flash(text), notify(title, detail), logEvent(text), focusSession(id), focusTask(taskId)
- storage        → storage.get(key), storage.set(key, value), storage.list(), storage.remove(key)   (persistent, namespaced per addon, 256KB/value)
- http           → http.request(method, url, {headers?, body?}) → Promise<{status, contentType, text}> — url host MUST be in the manifest "hosts" (https only); header/body values may embed {{secret:NAME}}
- secrets        → secrets.list() → [{name, label, set}] — no direct value reads; values are substituted from the OS keychain into allowed HTTP headers/bodies, so the destination receives them and its response is visible to addon code

STATE SNAPSHOT (getState() and the view's state push)
{ workspace, sessions: [{id, name, status: running|idle|needs|error, ephemeral, repo, task, summary, actionNeeded, cwd, cost, used, machineId, isolated}],
  tasks: [{id, title, col, agentId, description, criteria, watcherNote, awaitingUser, cwd, templateId, typeId, machineId, isolate, sessionMode, scheduleAt, chatTail}],
  templates: [{id, name, mode, typeId}], machines: [{id, label}],
  crons: [{name, schedule, at, on, last, action, runs: [{at, note, ok, taskId, agentId}]}],
  events: [{time, type, text}], totals: {cost, used, running} }

VIEW (the "html" field)
A complete self-contained document (inline CSS/JS, NO external resources — the iframe sandbox has no network). Bridge:
- state push: window.addEventListener('message', e => { if (e.data.type === 'yaam:state') render(e.data.state) }); request with parent.postMessage({type:'yaam:getState'},'*') (pushed on load + every ~3s).
- RPC: send {type:'yaam:call', callId, method, args} to parent; receive {type:'yaam:result', callId, result|error}. method is the dotted API name above (e.g. 'tasks.add', 'agent.wake').
Theme: background #0A0B0F, panel #12151C, border #1a1e26/#23272F, text #E7E9F0, muted #8B93A1, accent #F5C451, green #3DDC97, amber #FFB020, red #FF5C5C. Fonts 'IBM Plex Sans',system-ui (UI) / 'JetBrains Mono',monospace (numbers) with fallbacks. Always escape user/session text before innerHTML.

API IS ASYNC: handlers/hooks run in a sandboxed iframe and reach the app only via
RPC. api.getState() is synchronous (an immutable snapshot passed in), but EVERY
other api method returns a Promise — you MUST await it (e.g. const id = await
api.launchSession(cmd)). There is no network, DOM, or Tauri access inside a handler.

TOOLS (Master calls these)
handler is an async JS FUNCTION BODY — signature (input, api) => Promise<string>. Validate input yourself; await api calls; return a string the model reads. Tool names: [a-z0-9_].

HOOKS (async JS function bodies, (input, api) => Promise<void>; await api calls)
- onSessionExit  input={sessionId, name, code}
- onNeedsInput   input={sessionId, name, question}
- onTaskMoved    input={taskId, title, col, from}
- onCronFired    input={name, kind: task|command|log}
- masterPromptAppend: plain TEXT appended to Master's system prompt (not JS).

AGENT (optional — the addon's own mini-Master / customizable monitor)
"agent": {"system": persona/duties text, "on": [hook names that wake it], "every": "5-field cron that wakes it periodically"}. Its tools are the addon's permission-scoped API (get_state, read_output, launch_session, add_task, get_task, move_task, restart_task, approve_task, reject_task, task_chat, run_template, add_schedule, storage, http_request, notify_user, send_to_session, stop_session). Views chat with it via the 'agent.wake' RPC. Requires the "agent" permission. The user can refine its "system" instructions later via the addon's Customize chat — write it as a clear default policy.

RULES
- Launching CLI agents: one-shot = claude -p '<prompt>' (silent until done) or codex exec --skip-git-repo-check. Shell-quote prompts with single quotes, escaping embedded ones as '\\''.
- Keep handlers/hooks defensive: optional-chain state lookups, contain your own errors.
- Write real, working code — this package installs and runs immediately with no build step.
- Submit exactly one package via submit_addon. If validation errors come back, fix and resubmit.`

/** Generate a validated addon package JSON from a natural-language request. */
export async function generateAddonPackage(cfg: LlmConfig, request: string): Promise<string> {
  const history: ApiMessage[] = [{ role: 'user', content: `Build this addon:\n\n${request}` }]
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await callApi(cfg, GEN_SYSTEM, history, GEN_TOOL)
    const call = res.content.find((b): b is ApiContentBlock => b.type === 'tool_use' && b.name === 'submit_addon')
    history.push({ role: 'assistant', content: res.content })
    if (!call) {
      history.push({ role: 'user', content: 'Do not reply with prose — call submit_addon with the complete package JSON now.' })
      continue
    }
    const json = String((call.input as Record<string, unknown>)?.package_json ?? '')
    try {
      parseAddonPackage(json)
      return json
    } catch (e) {
      history.push({
        role: 'user',
        content: [{
          type: 'tool_result', tool_use_id: call.id,
          content: `invalid package: ${e instanceof Error ? e.message : String(e)} — fix it and call submit_addon again`,
        }],
      })
    }
  }
  throw new Error('could not produce a valid package after 3 attempts')
}

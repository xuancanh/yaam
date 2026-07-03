// Per-addon customization chat: a small dedicated LLM conversation that knows
// one addon package and edits it via the update_addon tool.
import { callApi } from './client'
import type { ApiContentBlock, ApiMessage, LlmConfig } from './client'

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

function editorSystem(addonJson: string): string {
  return `You customize exactly ONE addon package for YAAM (an agent-manager desktop app). The user chats with you to change it; apply changes with the update_addon tool, passing the COMPLETE updated package JSON.

Package rules:
- html (optional): a complete self-contained HTML document rendered in a sandboxed iframe.
The view gets live state AND can call the app over postMessage RPC:
- state push: window.addEventListener('message', e => { if (e.data.type === 'yaam:state') render(e.data.state) }) — pushed on load and every ~3s. state = { workspace, sessions:[{id,name,status,task,summary,actionNeeded,cwd,cost,used}], tasks:[{id,title,col,agentId}], crons, events, totals }
- calls: const pend = {}; function yaam(method, ...args){ return new Promise((res, rej) => { const id = Math.random().toString(36).slice(2); pend[id] = { res, rej }; parent.postMessage({ type: 'yaam:call', callId: id, method, args }, '*') }) }; window.addEventListener('message', e => { const d = e.data; if (d.type === 'yaam:result' && pend[d.callId]) { d.error ? pend[d.callId].rej(new Error(d.error)) : pend[d.callId].res(d.result); delete pend[d.callId] } })
- methods (each needs its permission granted): getState [state:read] · sendToSession(id, text) [sessions:send] · launchSession(cmd, cwd, name) [sessions:launch] · focusSession(id), flash(t), notify(title, detail), logEvent(t) [ui] · tasks.add(title, col)/tasks.rename(id, title)/tasks.move(id, col)/tasks.remove(id)/tasks.start(id) [tasks] (cols: backlog|routed|progress|review|done; tasks.start spawns a session for the task) · storage.get(key)/storage.set(key, value) [storage]
- declare needed scopes in the package: "permissions": ["state:read", "tasks", "ui", ...] — request only what you use. Match the app theme: background #0A0B0F, panel #0D0F14, border #23272F, text #E7E9F0, muted #8B93A1, accent #F5C451, fonts 'IBM Plex Sans' / 'JetBrains Mono'. No external network calls.
- tools (optional): [{ name, description, input_schema, handler }] — handler is a JS function body (input, api) => string, api = { getState(), sendToSession(id, text), launchSession(cmd, cwd, name), flash(t), logEvent(t), notify(title, detail) }.
- hooks (optional): { onSessionExit, onNeedsInput: JS bodies (input = event, api) => void, masterPromptAppend: string }.
- Keep the name unless the user asks to change it; bump the patch version on every change.
- After updating, reply with 1-2 sentences describing what changed. Never claim a change you did not apply with the tool.

CURRENT PACKAGE:
${addonJson}`
}

export async function runAddonEditorTurn(
  cfg: LlmConfig,
  addonJson: string,
  history: ApiMessage[],
  userText: string,
  apply: (packageJson: string) => string,
): Promise<string> {
  history.push({ role: 'user', content: userText })
  const texts: string[] = []
  for (let i = 0; i < 4; i++) {
    const res = await callApi(cfg, editorSystem(addonJson), history, EDITOR_TOOLS)
    const stepTexts = res.content.filter(b => b.type === 'text' && b.text).map(b => b.text as string)
    if (res.stop_reason !== 'tool_use') {
      history.push({ role: 'assistant', content: stepTexts.join('\n') || '(ok)' })
      texts.push(...stepTexts)
      break
    }
    const results = []
    for (const b of res.content.filter((x): x is ApiContentBlock => x.type === 'tool_use')) {
      const json = typeof b.input?.package_json === 'string' ? b.input.package_json : ''
      results.push({ type: 'tool_result', tool_use_id: b.id, content: apply(json) })
    }
    history.push({ role: 'assistant', content: res.content })
    history.push({ role: 'user', content: results })
  }
  while (history.length > 20) history.shift()
  if (history.length && history[0].role !== 'user') history.shift()
  return texts.join('\n\n').trim()
}

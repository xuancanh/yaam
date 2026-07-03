# YAAM Addon Guide

Addons extend YAAM without touching core code. An addon is a single JSON package
(`*.yaam.json`) that can ship any mix of a **view** (a tab in the icon rail),
**Master tools** (new actions for the orchestrator), and **hooks** (behavior
extensions). Packages are installable from a file, a URL, or the registry, and
exportable for sharing.

Built-in features are implemented against the same surface an addon gets — the
kanban board, for example, is fully reproducible as an addon
([`registry/packages/kanban-lite.yaam.json`](../registry/packages/kanban-lite.yaam.json)).

## Package format (manifest 2)

```jsonc
{
  "manifest": 2,
  "name": "my-addon",            // unique; installs replace by name
  "version": "1.0.0",            // bump on changes
  "icon": "🧩",                  // 1-2 chars, shown in the icon rail
  "description": "what it does",
  "author": "you",
  "permissions": ["state:read", "tasks", "ui"],   // scopes you actually use
  "html": "<!DOCTYPE html>…",    // optional view (sandboxed iframe)
  "tools": [ /* optional Master tools */ ],
  "hooks": { /* optional behavior hooks */ }
}
```

A package must contain at least one of `html`, `tools`, or `hooks`.

## Permissions

Packages declare capability scopes; every API call is checked against the
user's grants. Users see the requested scopes as chips in **Settings → Addons**
and can revoke each one independently. Request only what you use.

| Scope | Grants |
|---|---|
| `state:read` | `getState()` — sessions, tasks, schedules, events, totals |
| `sessions:send` | `sendToSession(id, text)` — type into a session (Enter is a separate keypress) |
| `sessions:launch` | `launchSession(cmd, cwd?, name?)` — spawn a new session |
| `tasks` | `tasks.add/rename/move/remove/start` — board CRUD; `start` spawns a session for the card |
| `ui` | `flash`, `notify`, `logEvent`, `focusSession` |
| `storage` | `storage.get/set` — private, persistent, namespaced per addon |

An ungranted call throws/returns
`permission "<scope>" not granted to this addon (Settings → Addons)`.

## Views

`html` is a complete, self-contained document rendered in a **sandboxed iframe**
(`allow-scripts` only — no network, no parent DOM access). It talks to the app
over `postMessage`:

**Receiving state** (pushed on load and every ~3s):

```js
window.addEventListener('message', e => {
  if (e.data.type === 'yaam:state') render(e.data.state)
})
parent.postMessage({ type: 'yaam:getState' }, '*') // request once at boot
```

`state = { workspace, sessions:[{id, name, status, task, summary, actionNeeded,
cwd, cost, used}], tasks:[{id, title, col, agentId}], crons, events, totals }`

**Calling the app** (RPC — each method needs its permission):

```js
const pend = {}
function yaam(method, ...args) {
  return new Promise((res, rej) => {
    const id = Math.random().toString(36).slice(2)
    pend[id] = { res, rej }
    parent.postMessage({ type: 'yaam:call', callId: id, method, args }, '*')
  })
}
window.addEventListener('message', e => {
  const d = e.data
  if (d.type === 'yaam:result' && pend[d.callId]) {
    d.error ? pend[d.callId].rej(new Error(d.error)) : pend[d.callId].res(d.result)
    delete pend[d.callId]
  }
})

// examples
await yaam('tasks.add', 'Fix the flaky tests', 'backlog')
await yaam('tasks.start', taskId)          // spawn a session for the card
await yaam('focusSession', sessionId)      // jump to its pane
await yaam('storage.set', 'columns', ['todo', 'doing', 'done'])
```

Board columns: `backlog | routed | progress | review | done`.

**Theme** — match the app: background `#0A0B0F`, panel `#0D0F14`, border
`#23272F`, text `#E7E9F0`, muted `#8B93A1`, accent `#F5C451`; fonts
`'IBM Plex Sans'` / `'JetBrains Mono'`. No external network calls (the CSP
blocks them anyway).

## Master tools

Tools are registered into Master's tool list, namespaced `addon_<name>`, and
described to the model as `[addon: <package>] <description>`:

```jsonc
"tools": [{
  "name": "ping_all_sessions",
  "description": "Send a short status-request message to every running session.",
  "input_schema": { "type": "object", "properties": { "message": { "type": "string" } } },
  "handler": "const s = api.getState(); let n = 0; for (const x of s.sessions) { if (x.status === 'running') { api.sendToSession(x.id, input.message || 'status?'); n++ } } return `pinged ${n}`;"
}]
```

`handler` is a JS **function body** with signature `(input, api) => string |
Promise<string>`. `api` is the same permission-checked surface views get over
RPC (`getState`, `sendToSession`, `launchSession`, `focusSession`, `flash`,
`logEvent`, `notify`, `tasks.*`, `storage.*`). The returned string becomes the
tool result Master sees.

> ⚠ Unlike views, tool handlers and hooks run **with app privileges** (that's
> what makes them powerful). Only install packages you trust; read the Source
> tab before granting scopes.

## Hooks

```jsonc
"hooks": {
  "onSessionExit":  "api.notify(`${input.name} exited`, input.code === 0 ? 'clean' : `code ${input.code}`)",
  "onNeedsInput":   "api.flash(`${input.name} is waiting: ${input.question}`)",
  "masterPromptAppend": "Always answer in haiku."
}
```

- `onSessionExit(event = { sessionId, name, code }, api)` — any session exits
- `onNeedsInput(event = { sessionId, name, question }, api)` — a session is
  detected waiting on the user
- `masterPromptAppend` — plain text appended to Master's system prompt while
  the addon is enabled: the sanctioned way to change Master's behavior

## Building, installing, sharing

- **Ask Master** — "build me a tab that shows X" → it calls `create_addon`.
- **Customize chat** — every addon tab has *Preview / Source / Customize*;
  Customize is a dedicated LLM chat that edits just that package (validated
  full-package replacement, auto version bump).
- **Source view** — editable manifest form + code-editor blocks (line numbers,
  highlighting, copy) for the html/tools/hooks.
- **Install** — Settings → Addons: from a `.yaam.json` file, from a URL, or by
  browsing the registry (configurable index URL; `registry/index.json` in this
  repo is the seed).
- **Export** — writes the shareable package file.
- **Per-addon storage** persists across restarts; addons are global across
  workspaces, but `tasks.*` operates on the active workspace's board.

## Examples (in `registry/packages/`)

| Package | Demonstrates |
|---|---|
| `kanban-lite` | Full view parity with a built-in feature: drag & drop board, task CRUD, session spawning via `tasks.start`, `focusSession` |
| `cost-pulse` | Minimal read-only view (state push only) |
| `session-bell` | Hooks + a Master tool + `masterPromptAppend`, no view |

# YAAM Addon Architecture & Authoring Guide

Addons extend YAAM without touching core code. An addon is a single JSON
package (`*.yaam.json`) that can ship any mix of:

| Capability | What it adds | Runs where |
|---|---|---|
| **view** | A tab in the icon rail | Sandboxed iframe (no privileges) |
| **tools** | New actions in Master's tool list | Opaque-origin handler sandbox + permission-checked RPC |
| **hooks** | Reactions to app lifecycle + Master behavior changes | Opaque-origin handler sandbox + permission-checked RPC |
| **agent** | The addon's own LLM harness (a mini-Master whose tools are the addon's API) | LLM loop over the permission-checked API |

Built-in features are implemented against the same surface an addon gets —
the kanban board is fully reproducible as an addon
([`registry/packages/kanban-lite.yaam.json`](../registry/packages/kanban-lite.yaam.json)).

---

## 1. Architecture

```
                       ┌──────────────────────────────────────────┐
                       │                 AppState                 │
                       │  addons: Addon[]   addonStorage: {…}     │
                       └──────┬───────────────────────┬───────────┘
                              │                       │
              persisted to conductor-state.json   swapped per nothing
                              │                   (addons are global)
        ┌─────────────────────┼──────────────────────────────┐
        │                     │                              │
   VIEW (iframe)         TOOLS (Master)                 HOOKS (events)
   sandbox=allow-scripts sandboxed iframe + api RPC     sandboxed iframe + api RPC
        │                     │                              │
   postMessage bridge         │  registered as addon_<name>  │  fired on
   yaam:state  (push)         │  in Master's tool list       │  session exit /
   yaam:call   (RPC) ─────┐   │                              │  needs-input
        │                 ▼   ▼                              ▼
        │            ┌─────────────────────────────────────────┐
        └───────────▶│    AddonApi  (permission-enforced)      │
                     │  getState · sendToSession · launch…     │
                     │  focusSession · flash/notify/logEvent   │
                     │  tasks.* · storage.*                    │
                     └───────────────────┬─────────────────────┘
                                         │
                              store actions / PTY layer
```

Key properties:

- **One API, four entry points.** Views, tool handlers, hooks, and addon agents
  all end up calling the same `AddonApi` object, built per addon by
  `app/src/app/runtime/addon.ts` and wrapped by
  `enforcePermissions()` so every method checks the addon's granted scopes.
- **Package HTML and JavaScript are untrusted.** The
  iframe has `sandbox="allow-scripts"` plus an injected CSP
  (`default-src 'none'`), so no cookies, no parent DOM, and no outbound
  requests of any kind (fetch/XHR/WebSocket/remote images are all blocked);
  postMessage to the host is the only channel out, and the host only pushes
  state snapshots to views whose addon holds `state:read`. Tool handlers and
  hooks run in that same kind of opaque-origin sandboxed iframe (network denied
  by CSP, no DOM/Tauri access) and reach the app only through correlated `api`
  RPC that the host validates and permission-checks — bounded by the permission
  grants and the API surface. Handler execution is also time-bounded and its
  results are size-capped; a runaway handler is terminated.
- **Addons are data.** Installing, exporting, and editing an addon is JSON
  manipulation; there is no build step and no core-code change. Packages are
  validated by `parseAddonPackage()` and persisted with the rest of app state.
- **Global across workspaces.** Addons and their storage are app-wide;
  `tasks.*` operates on the *active* workspace's board.

### Source map (for contributors)

| File | Role |
|---|---|
| `app/src/core/addons.ts` | Package parsing/validation/export, `AddonApi` type, permission tables, RPC dispatch, snapshot builder, tool/hook entry points |
| `app/src/app/runtime/addon.ts` | Per-addon API construction, permission wrapping, agents, hook fan-out, editor/package runtime |
| `app/src/domains/addons/addon-api.ts` | Raw implementations behind the permission wrapper |
| `app/src/domains/addons/sandbox.ts` | Opaque-origin handler/hook sandbox and host RPC bridge |
| `app/src/domains/addons/actions.ts` | Install/export/toggle/grant/remove and view RPC actions |
| `app/src/domains/addons/AddonView.tsx` | Tab shell (Preview / Source / Customize) and view iframe bridge |
| `app/src/domains/addons/AddonSource.tsx` | Source mode: manifest form + code-editor blocks |
| `app/src/domains/master/tools.ts` | `create_addon` / `remove_addon` tool definitions |
| `app/src/domains/addons/addon-editor.ts` | Per-addon Customize chat harness (`update_addon` tool) |
| `app/src/domains/addons/addon-gen.ts` | Addon generator and author-facing API/package instructions |
| `registry/` | Seed registry: `index.json` + example packages |

To **extend the API surface**: add the method to `AddonApi` + implement it in
`domains/addons/addon-api.ts` → add its scope to `METHOD_PERMISSION` and, if new,
to `ALL_PERMISSIONS` → whitelist in `ADDON_RPC_METHODS` if views may call it →
mention it in the `create_addon` description and the addon-editor prompt so
the LLMs generate against it.

---

## 2. Package formats

### 2.1 Folder format (manifest 3 — recommended)

Embedding HTML and JS inside JSON strings is hard to read and debug. The
folder format keeps every part in its natural file type, referenced from a
small manifest (`addon.yaml`, `addon.yml`, or `addon.json` — same shape):

```
my-addon/
  addon.yaml
  view.html            # the view, as a real HTML file
  tools/audit.js       # each tool handler, as a real JS file
  hooks/onTaskMoved.js
  prompts/agent.md     # agent system prompt / masterPromptAppend text
```

```yaml
manifest: 3
name: my-addon
version: 1.0.0
icon: 🧩
description: what it does
permissions:
  - state:read
  - tasks
view: view.html                    # file ref → becomes "html"
tools:
  - name: audit_task
    description: Audit a board task.
    input:                         # shorthand → JSON schema
      task_id: string! · id of the task     # ! = required, text after · = description
      limit: number · optional cap
    handler: tools/audit.js        # .js ref → file content (or inline JS string)
hooks:
  onTaskMoved: hooks/onTaskMoved.js
  masterPromptAppend: prompts/master.md   # .md/.txt refs load as text
agent:
  system: prompts/agent.md
  on:
    - onSessionExit
```

Install via **Settings → Addons → Install folder…**. The manifest YAML is a
strict subset: `key: value` maps, `- item` lists (incl. lists of maps),
2-space indentation, `#` comments, plain or quoted scalars — anything fancier
fails with a line number. Values like `state:read` or URLs are safe (mappings
require a space after the colon). Full `input_schema` is accepted anywhere
the shorthand isn't enough.

For URL/registry distribution, pack a folder into a single file:
`node scripts/pack-addon.mjs registry/packages/my-addon` → `my-addon.yaam.json`.

### 2.2 Single-file format (manifest 2)

```jsonc
{
  "manifest": 2,
  "name": "my-addon",             // required; unique — installs replace by name
  "version": "1.0.0",             // bump on changes (Customize chat does this)
  "icon": "🧩",                   // 1-2 chars, shown in the icon rail
  "description": "what it does",  // shown in Settings and the tab header
  "author": "you",
  "permissions": ["state:read", "tasks", "ui"],   // scopes you actually use
  "html": "<!DOCTYPE html>…",     // optional view
  "tools": [ … ],                 // optional Master tools
  "hooks": { … }                  // optional hooks
}
```

Validation rules (`parseAddonPackage`):

- `name` is required; a package must contain at least one of `html`, `tools`,
  `hooks`.
- Tool names are normalized to `[a-z0-9_]`; tools without a `handler` are
  dropped.
- An absent `permissions` array means *request everything* (legacy
  compatibility) — still individually revocable by the user.
- Invalid packages are rejected at install/update time with a readable reason
  (the Customize chat feeds rejections back to the model so it self-corrects).

---

## 3. Permission model

Packages **declare** scopes; users **grant** them. Grants are stored per addon
(`granted`), shown as clickable chips in **Settings → Addons** (green =
granted, struck-through = revoked), and enforced at the API boundary for all
three entry points.

| Scope | Grants access to |
|---|---|
| `state:read` | `getState()`, `sessions.readOutput`, `templates.list` |
| `sessions:send` | `sendToSession(id, text)`, `sessions.stop(id)` |
| `sessions:launch` | `launchSession(cmd, cwd?, name?)`, `templates.run` |
| `tasks` | `tasks.add/update/rename/move/remove/start/restart/chat` |
| `schedules` | `schedules.add/toggle/remove` |
| `agent` | `agent.wake` (runs the addon's own LLM agent — spends API tokens) |
| `master:prompt` | lets `masterPromptAppend` inject into Master's system prompt |
| `ui` | `flash`, `notify`, `logEvent`, `focusSession` |
| `storage` | `storage.get/set` |

Scopes split into **low-risk** (`state:read`, `ui`, `storage`) and **dangerous**
— those that act on the machine or steer LLMs (`sessions:send`,
`sessions:launch`, `tasks`, `schedules`, `agent`, `master:prompt`).

Grant lifecycle:

- **Fresh install** (file/URL/registry): only the low-risk scopes are
  auto-granted; dangerous scopes start **off** and must be enabled per-addon in
  Settings → Addons. The install toast names what was withheld.
- **Upgrade** (same name): the user's existing grant choices are kept
  (intersected with the new request set) — an update can't silently gain
  scopes the user revoked.
- **Master-built** (`create_addon`): granted as declared — the user asked
  Master to build it (still intersected with the declared scope list on edit).
- **Legacy** (pre-permission packages): treated as requesting every scope, but
  the same fresh-install rule applies — dangerous scopes stay off until granted.

`masterPromptAppend` only takes effect while the addon holds `master:prompt`;
state snapshots are pushed to a view only while its addon holds `state:read`;
and a disabled addon has an empty grant set (no RPC, tools, or hooks run).

An ungranted call throws / RPC-rejects with:
`permission "<scope>" not granted to this addon (Settings → Addons)`.

---

## 4. Views

`html` is a **complete, self-contained document**: inline CSS/JS, no external
resources (the sandbox has no network). It renders in the addon's tab and
communicates over `postMessage`.

### 4.1 State push

```js
window.addEventListener('message', e => {
  if (e.data.type === 'yaam:state') render(e.data.state)
})
parent.postMessage({ type: 'yaam:getState' }, '*')  // request once at boot
```

Pushed on iframe load and every ~3 s. Shape:

```ts
{
  workspace: string,                        // active workspace name
  sessions: { id, name, status, ephemeral,  // running | idle | needs | error
              repo, task, summary, actionNeeded,
              cwd, cost, used }[],
  tasks:    { id, title, col, agentId,      // col: backlog|progress|review|done|failed
              description, criteria, watcherNote, awaitingUser,
              cwd, templateId, typeId,
              chatTail }[],                 // last 5 watcher-chat messages
  templates:{ id, name, mode, typeId }[],
  crons:    { name, schedule, at, on, last, action }[], // action: task|template|command|log
  events:   { time, type, text }[],         // latest 10
  totals:   { cost, used, running }
}
```

### 4.2 RPC (calling the app)

Protocol: send `{ type: 'yaam:call', callId, method, args }` to the parent;
receive `{ type: 'yaam:result', callId, result }` or
`{ …, callId, error }`. Copy-paste helper:

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
```

Method reference (permission in brackets):

| Call | Returns | Notes |
|---|---|---|
| `yaam('getState')` | state snapshot | [state:read] |
| `yaam('sendToSession', id, text)` | — | [sessions:send] types text, presses Enter separately (TUI-safe) |
| `yaam('launchSession', cmd, cwd?, name?)` | session id \| null | [sessions:launch] spawns in the active workspace |
| `yaam('focusSession', id)` | — | [ui] brings the session's pane into view |
| `yaam('flash', text)` | — | [ui] toast |
| `yaam('notify', title, detail)` | — | [ui] bell notification |
| `yaam('logEvent', text)` | — | [ui] Activity-timeline entry, prefixed `[addon]` |
| `yaam('sessions.readOutput', id, lines?)` | string | [state:read] rendered screen for TUIs, log tail otherwise |
| `yaam('sessions.stop', id)` | — | [sessions:send] kills the session's process |
| `yaam('tasks.add', title, col?, spec?)` | new task id | [tasks] spec = `{ description, criteria, cwd, typeId, templateId }` |
| `yaam('tasks.update', id, patch)` | — | [tasks] patch any spec field + title |
| `yaam('tasks.rename', id, title)` | — | [tasks] |
| `yaam('tasks.move', id, col)` | — | [tasks] fires `onTaskMoved` |
| `yaam('tasks.remove', id)` | — | [tasks] |
| `yaam('tasks.start', id)` | — | [tasks] watcher-driven one-shot with the full task spec + goal contract |
| `yaam('tasks.restart', id)` | — | [tasks] detach a dead session, spawn a fresh one-shot |
| `yaam('tasks.chat', id, text)` | — | [tasks] posts into the task's watcher chat; the watcher reacts |
| `yaam('templates.list')` | `{id,name,mode,typeId}[]` | [state:read] |
| `yaam('templates.run', idOrName, task?)` | session id \| null | [sessions:launch] |
| `yaam('schedules.add', spec)` | status string | [schedules] `{ name, schedule?/at?, cmd?, task? }` — task specs land on the board |
| `yaam('schedules.toggle', name, on?)` | — | [schedules] |
| `yaam('schedules.remove', name)` | — | [schedules] |
| `yaam('agent.wake', note)` | agent's reply | [agent] chat with / poke the addon's own agent |
| `yaam('storage.get', key)` | stored value | [storage] |
| `yaam('storage.set', key, value)` | — | [storage] persists across restarts, namespaced per addon |

### 4.3 Theme

Match the app: background `#0A0B0F`, panel `#0D0F14`, panel-2 `#12151C`,
border `#23272F`, text `#E7E9F0`, muted `#8B93A1`, dim `#626B79`, accent
`#F5C451`, green `#3DDC97`, amber `#FFB020`, red `#FF5C5C`. Fonts:
`'IBM Plex Sans'` (UI) and `'JetBrains Mono'` (code/numbers) — both are loaded
in the host but **not** inside the iframe, so declare fallbacks:
`font-family:'IBM Plex Sans',system-ui,sans-serif`.

### 4.4 Minimal complete view

```json
{
  "manifest": 2,
  "name": "hello-sessions",
  "version": "1.0.0",
  "icon": "👋",
  "permissions": ["state:read", "ui"],
  "html": "<!DOCTYPE html><html><body style=\"margin:0;background:#0A0B0F;color:#E7E9F0;font-family:'IBM Plex Sans',system-ui,sans-serif;padding:20px\"><h3>Sessions</h3><ul id=l></ul><script>window.addEventListener('message',e=>{if(e.data.type==='yaam:state')document.getElementById('l').innerHTML=e.data.state.sessions.map(s=>`<li>${s.name} — ${s.status}</li>`).join('')});parent.postMessage({type:'yaam:getState'},'*')</script></body></html>"
}
```

---

## 5. Master tools

Tools are injected into Master's tool list on its next turn, namespaced
`addon_<name>` and described as `[addon: <package>] <description>`.

```jsonc
"tools": [{
  "name": "ping_all_sessions",
  "description": "Send a short status-request message to every running session.",
  "input_schema": {
    "type": "object",
    "properties": { "message": { "type": "string" } }
  },
  "handler": "const s = api.getState(); let n = 0; for (const x of s.sessions) { if (x.status === 'running') { await api.sendToSession(x.id, input.message || 'status?'); n++ } } return `pinged ${n}`;"
}]
```

Handler contract:

- `handler` is an **async function body**, run inside an opaque-origin
  `sandbox="allow-scripts"` iframe under a network-denying CSP — never in the
  main webview. It has no ambient `fetch`, DOM, or Tauri access; the app is
  reachable only through `api`.
- Signature `(input, api) => Promise<string>` — `input` is the model-provided
  arguments object (validate it yourself), `api` is the permission-checked
  `AddonApi` reached over correlated RPC.
- **The api is async.** `api.getState()` is synchronous (an immutable snapshot),
  but every other method returns a `Promise` — `await` it.
- The return value (stringified if not a string) becomes the tool result the
  model reads. Thrown errors are caught and returned as
  `addon tool error: <message>` — Master sees them and can react.
- Gate check: the whole tool errors if a called method's scope isn't granted;
  design handlers so a partial grant degrades gracefully if you can.

## 6. Hooks

```jsonc
"hooks": {
  "onSessionExit":  "await api.notify(`${input.name} exited`, input.code === 0 ? 'clean' : `code ${input.code}`)",
  "onNeedsInput":   "await api.flash(`${input.name} is waiting: ${String(input.question).slice(0, 40)}`)",
  "masterPromptAppend": "The user prefers terse, bullet-point replies."
}
```

- `onSessionExit` — fired when any session's process exits.
  `input = { sessionId, name, code }`.
- `onNeedsInput` — fired when a session is detected waiting on the user
  (dialog/menu/prompt). `input = { sessionId, name, question }`.
- `onTaskMoved` — fired when a board task changes column (drag, watcher, or
  addon). `input = { taskId, title, col, from }`.
- `onCronFired` — fired when a schedule fires.
  `input = { name, kind: 'task' | 'command' | 'log' }`.
- All are async JS function bodies `(input, api) => Promise<void>` run in the
  same sandboxed iframe as tool handlers (`await` api calls); each addon's hook
  runs independently and failures are contained (logged to the Activity feed as
  `addon "<name>" <hook> failed: …`).
- `masterPromptAppend` — plain text appended to Master's system prompt under
  an `ADDON DIRECTIVES` section while the addon is enabled **and holds the
  `master:prompt` scope**. This is the sanctioned way to change Master's
  behavior (tone, policies, extra duties); because it can steer Master into
  invoking session/shell tools, it is gated behind its own dangerous scope.

---

## 6b. Addon agents — your own mini-Master

An addon can declare an `agent`: a persistent LLM conversation (same brain as
Master/monitors, configured in Settings) whose **tools are the addon's
permission-scoped API** — `get_state`, `read_output`, `launch_session`,
`add_task` (full spec, optionally auto-started), `move_task`, `task_chat`
(talks to a task's watcher!), `run_template`, `add_schedule`, `storage`,
`notify_user`, `send_to_session`, `stop_session`. Denied scopes fail loudly
as tool errors, so the agent works within exactly what the user granted.

```jsonc
"agent": {
  "system": "You are the QA officer… (persona + duties)",
  "on": ["onSessionExit"]     // hook events that wake it (optional)
}
```

- **Waking**: hook events listed in `on` wake it with the event JSON; views
  and tool handlers wake it with `agent.wake(note)` — the promise resolves to
  its reply, so a view can render a real chat UI around it (see QA Gate).
- **Memory**: per-addon private history (in-memory, capped), like a watcher's.
- **Cost**: each wake is an LLM turn — that's why `agent` is its own
  permission. One turn runs at a time per addon; concurrent wakes are politely
  refused.
- **Layering**: Master orchestrates the app, each task's watcher owns one
  task, and an addon agent owns its addon's domain — they interact through
  the same surfaces you do (board, chats, sessions).

---

## 7. Writing an addon — three workflows

1. **Ask Master** (fastest): *"build me a tab that shows cost per session as
   bars"* → Master calls `create_addon`; the tab opens immediately. Master
   knows the full bridge/permission docs from its tool description.
2. **Customize chat** (iterate): every addon tab has **Preview / Source /
   Customize**. Customize is a dedicated LLM chat that knows only that
   package and edits it via a validated `update_addon` tool (full-package
   replacement, auto version bump, iframe reload). *"make the bars green"*,
   *"add a tool that restarts idle sessions"*.
3. **By hand** (full control): write a folder-format addon (section 2.1) and
   install via **Settings → Addons → Install folder…**, or write the JSON and
   use **Install from file…**. Iterate by re-installing (same name
   replaces, grants preserved) or by editing in Customize. Use the **Source**
   tab (manifest form + code-editor blocks with copy buttons) to inspect any
   installed addon.

Debugging notes: view JS errors are visible via right-click → Inspect Element
inside the tab (dev builds); RPC failures surface as rejected promises with
the reason string; tool/hook failures land in the Activity feed and in
Master's tool results.

---

## 8. Distribution & the registry

Everything lives in the **Addons view** (icon rail → Addons) — a
marketplace-style manager: search, installed list with grants, per-registry
package browsing, and **✦ Generate** (describe an addon in plain language;
an LLM with the complete authoring context builds, validates, and installs
it — see `app/src/domains/addons/addon-gen.ts`).

- **Export** — the addon's detail pane writes the shareable
  `<name>.yaam.json` (includes permissions).
- **Install** — from a registry, a file, a folder (section 2.1), or a pasted
  URL.
- **Registries** — configure any number in the Addons view sidebar. Each is
  an index of the shape below, served over http(s) **or a local folder /
  index.json path** (package `url`s may then be relative to the index —
  handy for developing addons against a local checkout):

```json
{
  "registry": 1,
  "packages": [
    {
      "name": "kanban-lite",
      "version": "1.0.0",
      "icon": "🗂",
      "description": "The built-in kanban board as a pure addon.",
      "url": "https://…/kanban-lite.yaam.json"
    }
  ]
}
```

Hosting your own registry is just static file hosting — a gist, a GitHub repo
(raw URLs), or any web server. This repo's [`registry/`](../registry) is the
seed.

## 9. Security model

- **Views**: hard-sandboxed (`allow-scripts` plus a `default-src 'none'` CSP
  injected into the srcdoc, blocking fetch/XHR/WebSockets and all remote
  resources). Worst case, a malicious view can call whatever scopes you
  granted it over the postMessage bridge — nothing else; it cannot phone
  home from inside the iframe. State snapshots are only pushed to views
  whose addon has been granted `state:read`.
- **Install-time grants**: fresh installs auto-grant only the low-risk scopes
  (`state:read`, `ui`, `storage`). Scopes that act on the machine or steer
  LLMs (`sessions:send`, `sessions:launch`, `tasks`, `schedules`, `agent`,
  `master:prompt`) start **off** and must be enabled per-addon in
  Settings → Addons. Appending to Master's system prompt requires the
  dedicated `master:prompt` scope.
- **Tools/hooks**: run in the app context. The `api` argument is
  permission-checked, but this is app-privileged JS — treat installing a
  package with tools/hooks like installing a browser extension. Read the
  Source tab; revoke scopes you're not comfortable with; prefer view-only
  packages from unknown sources.
- **Grants are yours**: requested ≠ granted. Chips in Settings are the source
  of truth; upgrades can't re-acquire revoked scopes.

## 10. Examples (in [`registry/packages/`](../registry/packages))

| Package | Demonstrates |
|---|---|
| `kanban-lite` | Full parity with a built-in feature: board rendering from state push, drag & drop, task CRUD over RPC, `tasks.start` spawning sessions, `focusSession` navigation |
| `cost-pulse` | Minimal read-only view (state push only, one permission) |
| `session-bell` | Hooks + a Master tool + `masterPromptAppend`, no view |
| `qa-gate` | **The full platform** (folder format): `onTaskMoved` review gate spawning auditor sessions, `onSessionExit` verdict parsing via `sessions.readOutput`, watcher-chat reporting, auto bounce-back on fail, Master tools, `schedules.add` automation, storage history, a dashboard view, and its own chatable QA-officer agent |

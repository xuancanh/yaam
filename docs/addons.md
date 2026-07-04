# YAAM Addon Architecture & Authoring Guide

Addons extend YAAM without touching core code. An addon is a single JSON
package (`*.yaam.json`) that can ship any mix of:

| Capability | What it adds | Runs where |
|---|---|---|
| **view** | A tab in the icon rail | Sandboxed iframe (no privileges) |
| **tools** | New actions in Master's tool list | App context, permission-checked API |
| **hooks** | Reactions to app lifecycle + Master behavior changes | App context, permission-checked API |

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
   sandbox=allow-scripts new Function(input, api)       new Function(input, api)
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

- **One API, three entry points.** Views (over RPC), tool handlers, and hooks
  all end up calling the same `AddonApi` object, built per addon
  (`makeAddonApi(addonId)` in `store.tsx`) and wrapped by
  `enforcePermissions()` so every method checks the addon's granted scopes.
- **Views are untrusted; code capabilities are trusted-but-scoped.** The
  iframe has `sandbox="allow-scripts"` only: no network, no cookies, no parent
  DOM. Tool handlers and hooks run in the app's JS context via
  `new Function('input', 'api', source)` — powerful by design, bounded by the
  permission grants and by the API surface (they receive no globals beyond
  `input`/`api`, though as app-context code they are ultimately trusted).
- **Addons are data.** Installing, exporting, and editing an addon is JSON
  manipulation; there is no build step and no core-code change. Packages are
  validated by `parseAddonPackage()` and persisted with the rest of app state.
- **Global across workspaces.** Addons and their storage are app-wide;
  `tasks.*` operates on the *active* workspace's board.

### Source map (for contributors)

| File | Role |
|---|---|
| `app/src/addons.ts` | Package parsing/validation/export, `AddonApi` type, permission tables + `enforcePermissions`, RPC dispatch, tool/hook executors, snapshot builder |
| `app/src/store.tsx` | `makeAddonApi` (the real implementations), install/export/toggle/grant actions, hook firing points, addon editor chat |
| `app/src/components/AddonView.tsx` | Tab shell (Preview / Source / Customize), iframe bridge (state push + `yaam:call` handling) |
| `app/src/components/AddonSource.tsx` | Source mode: manifest form + code-editor blocks |
| `app/src/llm/master-tools.ts` | `create_addon` / `remove_addon` tool definitions (author-facing docs live in the descriptions) |
| `app/src/llm/addon-editor.ts` | The per-addon Customize chat harness (`update_addon` tool) |
| `registry/` | Seed registry: `index.json` + example packages |

To **extend the API surface**: add the method to `AddonApi` + implement in
`makeAddonApiRaw` (store) → add its scope to `METHOD_PERMISSION` and, if new,
to `ALL_PERMISSIONS` → whitelist in `ADDON_RPC_METHODS` if views may call it →
mention it in the `create_addon` description and the addon-editor prompt so
the LLMs generate against it.

---

## 2. Package format (manifest 2)

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
| `state:read` | `getState()` |
| `sessions:send` | `sendToSession(id, text)` |
| `sessions:launch` | `launchSession(cmd, cwd?, name?)` |
| `tasks` | `tasks.add/rename/move/remove/start` |
| `ui` | `flash`, `notify`, `logEvent`, `focusSession` |
| `storage` | `storage.get/set` |

Grant lifecycle:

- **Fresh install** (file/URL/registry): requested scopes are granted, visible
  immediately for review/revocation.
- **Upgrade** (same name): the user's existing grant choices are kept
  (intersected with the new request set) — an update can't silently gain
  scopes the user revoked.
- **Master-built** (`create_addon`): granted as declared — the user asked for it.
- **Legacy** (pre-permission packages): grandfathered with full grants,
  revocable.

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
  workspace: string,                       // active workspace name
  sessions: { id, name, status,            // running | idle | needs | error
              task, summary, actionNeeded, // monitor-maintained (or null)
              cwd, cost, used }[],
  tasks:    { id, title, col, agentId }[], // col: backlog|progress|review|done|failed
  crons:    { name, schedule, on, last }[],
  events:   { time, type, text }[],        // latest 10
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
| `yaam('tasks.add', title, col?)` | new task id | [tasks] col defaults to `backlog` |
| `yaam('tasks.rename', id, title)` | — | [tasks] |
| `yaam('tasks.move', id, col)` | — | [tasks] |
| `yaam('tasks.remove', id)` | — | [tasks] |
| `yaam('tasks.start', id)` | — | [tasks] spawns the default agent type with the task title as its prompt and links the card |
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
  "handler": "const s = api.getState(); let n = 0; for (const x of s.sessions) { if (x.status === 'running') { api.sendToSession(x.id, input.message || 'status?'); n++ } } return `pinged ${n}`;"
}]
```

Handler contract:

- `handler` is a **function body**, compiled as
  `new Function('input', 'api', '"use strict";\n' + handler)`.
- Signature `(input, api) => string | Promise<string>` — `input` is the
  model-provided arguments object (validate it yourself), `api` is the
  permission-checked `AddonApi`.
- The return value (stringified if not a string) becomes the tool result the
  model reads. Thrown errors are caught and returned as
  `addon tool error: <message>` — Master sees them and can react.
- Gate check: the whole tool errors if a called method's scope isn't granted;
  design handlers so a partial grant degrades gracefully if you can.

## 6. Hooks

```jsonc
"hooks": {
  "onSessionExit":  "api.notify(`${input.name} exited`, input.code === 0 ? 'clean' : `code ${input.code}`)",
  "onNeedsInput":   "api.flash(`${input.name} is waiting: ${String(input.question).slice(0, 40)}`)",
  "masterPromptAppend": "The user prefers terse, bullet-point replies."
}
```

- `onSessionExit` — fired when any session's process exits.
  `input = { sessionId, name, code }`.
- `onNeedsInput` — fired when a session is detected waiting on the user
  (dialog/menu/prompt). `input = { sessionId, name, question }`.
- Both are JS function bodies `(input, api) => void | Promise<void>`; each
  addon's hook runs independently and failures are contained (logged to the
  Activity feed as `addon "<name>" <hook> failed: …`).
- `masterPromptAppend` — plain text appended to Master's system prompt under
  an `ADDON DIRECTIVES` section while the addon is enabled. This is the
  sanctioned way to change Master's behavior (tone, policies, extra duties).

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
3. **By hand** (full control): write the JSON, install via **Settings →
   Addons → Install from file…**. Iterate by re-installing (same name
   replaces, grants preserved) or by editing in Customize. Use the **Source**
   tab (manifest form + code-editor blocks with copy buttons) to inspect any
   installed addon.

Debugging notes: view JS errors are visible via right-click → Inspect Element
inside the tab (dev builds); RPC failures surface as rejected promises with
the reason string; tool/hook failures land in the Activity feed and in
Master's tool results.

---

## 8. Distribution & the registry

- **Export** — Settings → Addons → Export writes the shareable
  `<name>.yaam.json` (includes permissions).
- **Install** — from a file, from a URL (raw JSON), or via the **registry
  browser**.
- **Registry** — any URL serving an index of this shape (configure it in
  Settings → Addons):

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

- **Views**: hard-sandboxed (`allow-scripts` only). Worst case, a malicious
  view can call whatever scopes you granted it — nothing else. No network
  exfiltration path exists from the iframe.
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

# Building a YAAM addon — the tutorial

This is the hands-on walkthrough: from empty folder to a published registry
entry. The reference companion is [`addons.md`](addons.md) (architecture,
package formats, permission model, full API); this document is the *how*.

Two authoring paths exist. Both produce the exact same installable artifact —
a folder-format addon and/or a single `.yaam.json`:

| Path | What you write | Best for |
|---|---|---|
| **Toolchain** (this tutorial) | A normal Vite + TypeScript (optionally React) project; `yaam-addon build` compiles it into the sandbox format | Anything non-trivial: typed API, npm packages, JSX, hot dev loop, tests |
| **Vanilla** ([`toolkit/`](../toolkit)) | `addon.yaml` + a hand-written `view.html` + plain `.js` handlers, no build step | Tiny addons, quick experiments, environments without node |

---

## 0. Prerequisites

- Node 18+ and npm.
- A YAAM checkout or install. Inside the yaam repo the SDK packages are used
  straight from the workspace (`file:` links); build them once:

  ```bash
  cd sdk && npm install && npm run build
  ```

## 1. Scaffold

```bash
node sdk/create-yaam-addon/index.mjs my-addon --name "My Addon" --icon 🧩
# (published form: npm create yaam-addon my-addon)
cd my-addon && npm install
```

You get a normal Vite project:

```
my-addon/
  addon.config.ts      ← the manifest (typed; replaces addon.yaml)
  index.html           ← view entry — a standard Vite page
  vite.config.ts       ← dedupes react for file:-linked SDKs
  src/main.tsx         ← boots the host stub in dev, renders <App/>
  src/App.tsx          ← your view
  src/app.css          ← your styles (host tokens come from @yaam/addon-sdk/ui.css)
```

## 2. The dev loop

Two tiers, use both:

**Tier 1 — browser + mock host (seconds):**

```bash
npm run dev
```

Opens the view as a plain web page with full HMR and React DevTools. Because
the page is top-level (`window.parent === window`), `src/main.tsx` starts the
SDK's **host stub** — it speaks the real postMessage protocol, enforces the
real permission map, serves fixture state (sessions, tasks, a schedule), and
backs `storage.*` with an in-memory map. Edit the fixtures or grants where the
stub is created:

```ts
const stub = createHostStub({
  state: { workspace: 'Fixtures' },
  granted: ['state:read', 'ui'],          // test the ungranted experience!
  handlers: { 'http.request': async () => ({ status: 200, contentType: 'application/json', text: '[]' }) },
})
```

**Tier 2 — inside YAAM against real state:**

```bash
npm run build        # → dist/ (a folder-format addon)
```

In YAAM: **Addons → Dev install… → pick `dist/`**. The app installs it AND
watches the folder — from then on every `npm run build` hot-reinstalls the
addon in place: grants are kept, storage survives, the view iframe remounts.
The addon shows a DEV badge; stop watching from its Settings tab.

## 3. The manifest: `addon.config.ts`

```ts
import { defineAddon } from 'yaam-addon'

export default defineAddon({
  name: 'My Addon',
  version: '0.1.0',
  icon: '🧩',
  description: 'One line — this is the install-time pitch and registry card.',
  permissions: ['state:read', 'storage', 'ui'],   // ONLY what you call
  view: 'index.html',
  hooks: { onTaskMoved: 'src/hooks/onTaskMoved.ts' },
  tools: [{ name: 'my_tool', description: '…', input: { q: 'string! · query' }, handler: 'src/tools/my-tool.ts' }],
  hosts: ['api.example.com'],                     // https-only allowlist for http.request
  secrets: [{ name: 'API_TOKEN', label: 'what to paste' }],
  agent: { system: 'prompts/agent.md', on: ['onTaskMoved'] },
})
```

`yaam-addon build` validates this against the same rules the host applies
(permission ids, host/secret shapes, cron syntax), lints handler sources for
`api.*` calls whose scope you forgot to declare, and enforces a view size
budget. Fix warnings — they are the exact runtime denials your users will hit.

**Permissions philosophy:** dangerous scopes (`tasks`, `http`, `sessions:*`,
…) start **ungranted** on install. Design every feature to fail visibly and
say which scope to grant — `yaam.guard` / the React `useYaam().guard` routes
denials into the error banner instead of a dead button.

## 4. Views

The view is a normal web app; the build inlines *everything* into one
`view.html` because the sandbox CSP denies all external requests (no
`<script src>`, no fetch, no remote images/fonts).

React bindings from `@yaam/addon-sdk/react`:

```tsx
import { useYaam, useYaamApi, useYaamState, useStorage } from '@yaam/addon-sdk/react'

function Panel() {
  const state = useYaamState()                 // AddonSnapshot | null, pushed ~3s
  const inReview = useYaamState(s => s?.tasks.filter(t => t.col === 'review') ?? [])
  const api = useYaamApi()                     // typed: api.tasks.add(...): Promise<string>
  const note = useStorage('note', '')          // persisted per-addon storage cell
  const { guard } = useYaam()
  // …
  const spawn = () => void guard(api.tasks.add('Triage inbox', 'backlog', { criteria: ['inbox empty'] }))
}
```

Rules the sandbox imposes (the build can't lift these):

- `alert` / `confirm` / `prompt` are silently blocked — use inline confirms.
- No `fetch`: HTTP goes through `api.http.request` (allowlisted hosts,
  `{{secret:NAME}}` templating in headers/body — never URLs).
- Escape host-provided text (task titles, session names) before `innerHTML`;
  in React this is automatic, in vanilla use `esc()` from
  `@yaam/addon-sdk/dom`.
- State pushes arrive ~3s apart — render from pushes, don't poll faster.

Styling: `import '@yaam/addon-sdk/ui.css'` gives you the host's tokens
(`--bg`, `--panel`, `--acc`, …) and base components (`.card`, `.row`, `.pill`,
buttons, inputs) so the tab feels native. `#yaam-banner` is the error strip
`guard` uses — the template styles it.

## 5. Hooks and tools

Handlers are TypeScript modules; the default export receives `(input, api)`:

```ts
// src/hooks/onTaskMoved.ts
import type { HookHandler } from '@yaam/addon-sdk'

const handler: HookHandler<'onTaskMoved'> = async (input, api) => {
  if (input.col !== 'done') return
  const seen = ((api.getState().tasks) ?? []).length   // getState is SYNC in handlers
  await api.storage.set('lastDone', { id: input.taskId, at: Date.now(), seen })
}
export default handler
```

```ts
// src/tools/my-tool.ts — callable by Master
import type { ToolHandler } from '@yaam/addon-sdk'

const handler: ToolHandler<{ q: string }> = async (input, api) => {
  return api.getState().tasks.filter(t => t.title.includes(input.q)).length
}
export default handler
```

The build bundles each handler (imports work at build time — shared helpers,
small npm packages) into the sandbox's function-body form. The sandbox has no
module system, DOM, or network: node builtins and packages with runtime
`require` fail the build on purpose. Every `api.*` method except `getState()`
returns a Promise — **always await**. Thrown handlers are logged and dropped;
contain your own errors.

Hook payloads (`HookEvents` in the SDK): `onSessionExit {sessionId, name,
code}` · `onNeedsInput {sessionId, name, question}` · `onTaskMoved {taskId,
title, col, from}` · `onCronFired {name, kind}`. `masterPromptAppend` is not
JS — it's a prompt fragment for Master (config key `masterPromptAppend`,
inline text or a `.md` path; requires the `master:prompt` scope).

## 6. Testing

The same stub that powers `npm run dev` works under vitest/jsdom:

```ts
import { createHostStub } from '@yaam/addon-sdk/testing'
import { createYaamClient } from '@yaam/addon-sdk'

it('spawns a task for the selected issue', async () => {
  const stub = createHostStub({ granted: ['tasks', 'state:read'] })
  const client = createYaamClient({ target: window })
  await client.api.tasks.add('from test')
  expect(stub.calls[0]).toMatchObject({ method: 'tasks.add' })
  expect(stub.state.tasks.some(t => t.title === 'from test')).toBe(true)
  stub.dispose(); client.dispose()
})
```

Compiled hooks can be executed exactly like the host sandbox does:
`new Function('input','api','"use strict"; return (async () => {\n' + source + '\n})();')`.

## 7. Build → pack → publish

```bash
npm run build     # dist/ — installable folder (addon.json + view.html + hooks/ + tools/)
npm run pack      # dist/ → my-addon.yaam.json — single file for URL/registry install
yaam-addon publish dist --registry ../yaam/registry
```

`publish` packs into `registry/packages/<slug>.yaam.json`, updates
`registry/index.json`, refuses to publish without a version bump, and prints
the **security diff** (new permissions/hosts/secrets vs the published pack).
It never commits — open a PR with the diff in the description; registry CI
(`.github/workflows/registry-validate.yml`) re-validates every PR and calls
out new scopes for review.

## 8. In-repo addons (this repository)

The addons YAAM ships live as toolchain projects under
[`registry/src/`](../registry/src). `registry/packages/` is **generated** —
never edit it by hand. The cycle:

```bash
# edit registry/src/<slug>/…, bump version in its addon.config.ts, then:
cd sdk && npm run build && cd ..
node scripts/build-addons.mjs <slug>      # or no arg = rebuild all
node scripts/validate-registry.mjs --base origin/main
```

## 9. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `permission "…" not granted` rejection | Declare the scope in `addon.config.ts` *and* grant it (Addons → the addon → Settings). The build's permission lint catches the former. |
| View is blank inside YAAM but fine in `npm run dev` | Something touched the network (CDN font, remote image, fetch). Everything must be local/inlined; use `api.http.request`. |
| React hooks crash `Cannot read properties of null (reading 'useRef')` | Two React copies bundled (file:-linked SDK). Keep `resolve.dedupe: ['react','react-dom']` in `vite.config.ts` — the scaffold ships it. |
| Handler build fails with `still calls require()` | A dependency needs node at runtime. Handlers run in a bare sandbox; inline the logic or pick a dependency-free package. |
| `{{secret:NAME}}` errors with `secret "NAME" is not set` | By design — set the value in the addon's Settings tab; the placeholder never silently resolves to empty. |
| Dev install doesn't reload | The watcher polls the *installed* folder — dev-install `dist/` (what `npm run build` writes), not the project root. |
| storage.set fails with a size error | 256 KB per key, 1 MB per addon. Cap your lists (the shipped addons cap at a few hundred records). |

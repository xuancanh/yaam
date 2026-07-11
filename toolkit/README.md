# YAAM addon toolkit

Everything you need to build an addon with a native-feeling UI. The full
authoring reference lives in [`docs/addons.md`](../docs/addons.md); this folder
is the practical kit:

| File | What it is |
|---|---|
| [`sdk.js`](sdk.js) | View SDK — RPC bridge, `yaam.api` proxy, state subscription, error banner, DOM helpers |
| [`ui.css`](ui.css) | Design tokens + component classes matching the host app |
| [`template/`](template) | A working starter addon — copy it and go |
| [`../registry/packages/dev-kitchen-sink/`](../registry/packages/dev-kitchen-sink) | Reference addon exercising **every** exposed capability |

## Quick start

```bash
cp -r toolkit/template my-addon
# edit my-addon/addon.yaml + view.html
# install: YAAM → Addons → Install from folder → my-addon
# share:   node scripts/pack-addon.mjs my-addon
```

## The `@include` mechanism

Views run in a sandboxed iframe whose CSP forbids **all** external resources —
no `<script src>`, no `<link rel=stylesheet>`. Instead, put include markers in
your view; they are replaced with the referenced file's contents when packed:

```html
<style>
/* @include ../../toolkit/ui.css */
</style>
<script>
/* @include ../../toolkit/sdk.js */
</script>
```

`<!-- @include file -->` also works in markup positions. Paths resolve
relative to the addon folder; `../../toolkit/…` reaches this kit from
`registry/packages/<addon>/`. Includes resolve once (they don't nest), and
single-file `.yaam.json` packages ship with everything already inlined.
For direct **Install folder…**, references are canonically confined to the
selected folder; keep included files inside it. Parent toolkit references are
a pack-time developer convenience and must be packed before installation.

## SDK in 30 seconds

```js
yaam.api.tasks.add('title', 'backlog', { criteria: ['done means…'] }) // → Promise<id>
yaam.call('tasks.add', 'title')          // same thing, raw dotted form
yaam.onState(s => render(s))             // live snapshot every ~3s (state:read)
await yaam.guard(yaam.api.http.request('GET', url, { headers }))
                                         // rejections land in the error banner
yaam.banner('custom error')              // the banner directly
yaam.esc(userText)                       // ALWAYS before innerHTML
yaam.ago(ts)                             // "3m ago"
yaam.el('button', { class: 'primary', onclick: fn }, 'Run')
yaam.confirm(btn, () => destroy())       // two-click confirm (modals are blocked)
```

Every `yaam.api` call needs its permission granted in the Addons view; denials
reject with `permission "…" not granted` — `yaam.guard` turns that into a
visible banner instead of a silent failure.

## UX guidelines for views

1. **Design for the ungranted state.** Fresh installs have dangerous scopes
   OFF. Every feature that needs one must fail visibly (`yaam.guard`) and say
   which scope to grant — never a dead button.
2. **Onboard with a checklist, not a wall of settings.** If your addon needs
   setup (repo, token, schedule), render numbered steps that check themselves
   off (see the GitHub Issues addon).
3. **No modals.** `alert`/`confirm`/`prompt` are silently blocked by the
   sandbox. Use `yaam.confirm` (two-click arm) for destructive actions and
   inline forms for input.
4. **Escape everything.** Session names, task titles, issue bodies are
   attacker-controlled text. `yaam.esc` before any `innerHTML`, or build with
   `yaam.el`.
5. **Show liveness.** Busy buttons (`disabled` + `.spin`), `.dot.running` for
   in-flight work, relative timestamps (`yaam.ago`), and countdowns for
   scheduled things. State pushes arrive ~3s apart — re-render from them
   instead of polling faster.
6. **Empty states teach.** An empty list should say how it gets filled
   (“enable the schedule or hit Sync now”), not just sit blank.
7. **Match the host.** Use `ui.css` tokens/components; the tab should feel
   like part of YAAM, not a web page inside it.
8. **Keep destructive reach small.** Request only the scopes you call; prefer
   `backlog` over auto-starting tasks; cap stored lists (storage values are
   limited to 256 KB each).

## Handler contract (tools & hooks)

Handlers run in an isolated sandbox with **no** DOM/network/Tauri access — only
the `api` object (and `input`). Every `api` method except `getState()` returns
a Promise: **always `await`**. Contain your own errors; a thrown handler is
logged and dropped. See `docs/addons.md` §5–6 for shapes and events.

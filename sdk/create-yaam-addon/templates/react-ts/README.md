# __ADDON_NAME__

A YAAM addon built with React + TypeScript.

```bash
npm install
npm run dev     # browser + mock host (HMR); real host data needs a dev install (below)
npm run build   # compile into dist/ — a folder-format addon
npm run pack    # dist/ → __ADDON_SLUG__.yaam.json for sharing
```

**Install for development:** YAAM → Addons → Install from folder → pick `dist/`.
Rebuild (or `yaam-addon build --watch` once available) and reload to iterate
against real host state.

## Layout

| File | Purpose |
|---|---|
| `addon.config.ts` | The manifest: metadata, permissions, hosts/secrets, and where the view/hooks/tools live |
| `index.html` + `src/` | The view — a normal Vite app; built into ONE sandbox-safe `view.html` |
| `src/hooks/*.ts` | Lifecycle hooks (default export `(input, api) => …`), bundled per-hook |
| `src/tools/*.ts` | Tools Master can call, same handler shape |

## Rules of the sandbox

- The view iframe has a CSP that denies **all** network — everything must be
  inlined, which `yaam-addon build` handles. `fetch` is unavailable: call HTTP
  through `api.http.request` (allowlisted hosts, `{{secret:NAME}}` templating).
- `alert`/`confirm`/`prompt` are silently blocked — use inline confirms.
- Every `api.*` call needs its permission granted by the user; dangerous scopes
  start OFF. Design every feature to fail visibly (`yaam.guard`) and say which
  scope to grant.
- Hooks/tools run in a DOM-less sandbox: no imports at runtime (the build
  bundles them), no node builtins, `api` + `input` only.

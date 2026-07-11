# YAAM addon SDK workspace

The developer toolkit for building YAAM addons. Tutorial:
[`docs/addons-tutorial.md`](../docs/addons-tutorial.md) · reference:
[`docs/addons.md`](../docs/addons.md).

| Package | What it is |
|---|---|
| [`addon-sdk/`](addon-sdk) (`@yaam/addon-sdk`) | Typed mirror of the host addon API (`types.ts`/`permissions.ts`), the postMessage bridge client, React bindings (`/react`), classic DOM helpers (`/dom`), a host-stub testing harness (`/testing`), and the host design tokens (`/ui.css`) |
| [`yaam-addon/`](yaam-addon) | Build tool + CLI: `build` (Vite project → sandbox-format addon: single-file view, per-handler bundles, addon.json, validation + permission lint), `pack`, `publish` (registry + security diff), `dev`, `validate` |
| [`create-yaam-addon/`](create-yaam-addon) | Scaffolder: `react-ts` (Vite + typed SDK + host-stub dev server) and `vanilla` templates |

```bash
npm install
npm run build     # required before scripts/build-addons.mjs or the CLI bin
npm run check     # typecheck all packages
npm test          # bridge/react/testing tests + host-compat drift guards
```

Drift protection against the app: `app/src/core/addon-sdk-compat.ts`
type-checks the SDK's API mirror inside the app's own tsc gate, and
`addon-sdk/test/host-compat.test.ts` + `yaam-addon/test/host-loader.test.ts`
compare runtime tables and feed built output through the app's real loader.
If you change the addon API surface in `app/src/core/addons.ts`, update
`addon-sdk/src/types.ts` + `permissions.ts` to match — the gates will hold
the door until you do.

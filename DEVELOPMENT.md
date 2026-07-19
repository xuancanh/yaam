# YAAM development guide

This is the contributor entry point. Product usage is in [README.md](README.md).
Current implementation architecture is documented under [docs/](docs/README.md):

- [System architecture](docs/architecture.md)
- [Frontend domains](docs/frontend-domains.md)
- [Backend domains](docs/backend-domains.md)
- [Security model](docs/security.md)
- [Current implementation design](docs/design-runtime-2026-07.md)
- [Addon authoring](docs/addons.md)

## Prerequisites

YAAM requires Node.js 20+, Rust through `rustup`, and Tauri's platform
prerequisites. On macOS, install Xcode command-line tools. Run application
commands from `app/` and ensure Cargo is on `PATH`.

```sh
cd app
npm install
npm run tauri dev
```

## Verification

Use the explicit application tsconfig. The root TypeScript config is
solution-style; bare `tsc --noEmit` does not check the application.

```sh
cd app
npx tsc --noEmit -p tsconfig.app.json
npm test
npm run lint
(cd src-tauri && cargo check)
(cd src-tauri && cargo test --lib)
```

Additional gates:

```sh
npm run build          # production frontend
npm run tauri build    # desktop bundles
```

The known `only-export-components` warnings in shared UI/component-helper files
are non-fatal.

## Current architecture in one page

`store.tsx` is lifecycle glue, not the application runtime. It constructs the
plain `AppRuntime` from `app/conductor-runtime.ts`, calls `start`/`dispose`, and
provides the stable action object.

The runtime composes four subsystems:

- session/board: PTY attention, monitors, watchers, settle, launch, and exits;
- addon: permission API, sandbox, agents, hooks, and package editor;
- chat/boot: chat runtime, MCP/skills, persistence, hydration, and search;
- Master/scheduler: Master queue/tool loop and scheduled work.

State is data-only in Zustand. UI components use narrow selectors; domain
actions are plain factories composed by the app layer. Rust owns privileged OS
capabilities and exposes Tauri commands through `core/native.ts`.

## Repository map

```text
app/src/
  app/                    runtime composition, actions, global effects
  core/                   shared types/store/ports/native/terminals/MCP/addons
  domains/                activity, session, board, master, chat, schedules,
                          addons, settings, workspace, shell
  infrastructure/         persistence schema, hydration, subscriptions, runtime
  llm/client.ts           providers, credentials, protocol and streaming adapters
  shared/                 ids, zip and file-text helpers
  store.tsx               provider lifecycle glue

app/src-tauri/src/
  lib.rs                  Tauri state and command registration
  domains/                session, fs, git, state, MCP, search, Bedrock, secrets
  setup.rs, util.rs       platform setup and shared helpers
```

## State and side-effect rules

- Keep `dispatch` updaters pure. Start processes, network calls, timers, and
  notifications outside them.
- Put durable data in `AppState`; keep xterm objects, API histories, busy sets,
  queues, abort controllers, live MCP sessions, and timers in their runtime
  owner.
- Every keyed runtime must have deterministic `dispose(key)` behavior and abort
  in-flight work when its entity is removed.
- Domain logic belongs with its commands and tests. The app layer only composes
  domains and coordinates genuine cross-domain outcomes.
- Use `StatePort`, `ClockPort`, and capability-specific ports for testable
  runtime code. Do not pass the entire native module into a domain service.
- Keep contexts in `core/context.ts`; moving context creation into hot-reloaded
  provider code breaks identity during HMR.

## Persistence changes

Main state and sessions have separate selectors and writers. Adding durable
data requires:

1. Update `PersistedState` and `AppState` in `core/types.ts`.
2. Seed a default in `core/data.ts`.
3. Hydrate defensively in `infrastructure/persistence/hydrate.ts`.
4. Add it to `selectMainState` or `selectSession`.
5. Add its reference to the correct change detector in
   `infrastructure/persistence/subscribe.ts`.
6. Add migration/round-trip tests and guard reads from older snapshots.

`bootStatus` and other runtime-only fields must not enter a persistence
selector. Do not rename `dev.yaam.conductor` or `conductor-state.json`; both are
compatibility contracts for installed users.

## Terminal changes

- Test both plain output and an alternate-screen CLI.
- Do not replay saved text into a live PTY. Repaint live TUIs through resize.
- Keep raw-activity settle behavior; TUI redraws often contain no newline.
- Send text and Enter separately. A combined write is treated as a paste by
  some agent TUIs.
- Preserve generation checks when changing Rust session replacement/exit code.

## LLM and orchestration changes

- Preserve provider-neutral message/tool result shapes across Anthropic,
  OpenAI-compatible, and Bedrock paths.
- Keep thinking blocks out of replayed provider history.
- Refuse incomplete/truncated tool arguments.
- Add cancellation for any async operation owned by a deletable session, task,
  addon, or workspace.
- Master action tools must retain catalog/session policy checks and the
  action-claim integrity retry.
- Task sessions remain one-shot and all active/background launches must use the
  canonical task launch path.

## Security changes

Read [docs/security.md](docs/security.md) before adding native commands, chat
tools, MCP capability, addon APIs, remote content, or persisted secrets.

Important invariants:

- addon HTML and JavaScript remain in opaque-origin, network-denied iframes;
- every addon API method is whitelisted and mapped to a permission;
- workspace-scoped writes are checked canonically in Rust, not only lexically
  in TypeScript;
- shell and stdio MCP execution is user-authority code, not sandboxed code;
- Tauri commands validate sizes, paths, names, and timeouts at the privileged
  boundary.

## Documentation changes

When changing ownership or a major flow, update the corresponding implementation
document under `docs/`. Addon API/package changes also require
`docs/addons.md`. Keep historical plans labeled historical rather than rewriting
them as if they were current architecture.

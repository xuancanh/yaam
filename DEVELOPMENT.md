# YAAM development guide

This document is the starting point for changing YAAM. It describes the runtime architecture, the main data flows, and the constraints that are easy to miss when reading individual files. Product usage belongs in [README.md](README.md); addon authoring belongs in [docs/addons.md](docs/addons.md).

## Prerequisites and commands

YAAM requires Node.js 20+, Rust through `rustup`, and the platform prerequisites for Tauri 2. On macOS, install the Xcode command-line tools. Run application commands from `app/` and ensure Cargo is on `PATH`.

```sh
cd app
npm install
npm run tauri dev
```

The normal verification gate is:

```sh
npx tsc --noEmit
npm run lint
(cd src-tauri && cargo check)
```

Use `cargo test --lib` for the Bedrock credential-parser tests and `npm run build` for a production frontend build. `npm run tauri build` creates the desktop bundles.

## Repository map

```text
app/src/
  store.tsx          state owner, actions, effects, persistence, orchestration
  state-lib.ts       pure state/command/cron helpers
  context.ts         stable React context identities; do not move into store.tsx
  terminals.ts       module-level xterm registry and screen inspection
  native.ts          typed frontend wrappers around Tauri commands/events
  llm/               provider adapters and Master/monitor/watcher harnesses
  components/        application views and workspace terminal UI
app/src-tauri/src/
  sessions.rs        PTYs, process events, filesystem/git commands, state file
  bedrock.rs         Bedrock invocation and AWS credential handling
docs/addons.md        addon package, permission, RPC, and lifecycle reference
registry/             built-in addon registry and example packages
design/               historical design prototype; not runtime code
```

## Runtime architecture

The desktop process has three layers:

1. The React frontend owns all durable application state in `ConductorProvider`. Components read `AppState` and call the `ConductorActions` surface; they do not talk directly to PTYs or LLM providers.
2. The Tauri bridge exposes typed commands in `native.ts`. Rust owns real PTYs, process lifecycle, filesystem/git access, persisted state, and Bedrock requests.
3. The LLM layer adapts Anthropic Messages, OpenAI-compatible chat completions, and Bedrock to one internal message/tool shape. Master coordinates sessions; per-session monitors summarize terminal state; per-task watchers own kanban progress.

`store.tsx` is intentionally the integration point. `stateRef.current` mirrors reducer state for asynchronous callbacks. Refs such as `masterEventRef`, `onSettleRef`, and `runWatcherRef` break callback declaration cycles without moving side effects into the reducer.

## Primary data flows

### Session launch and terminal I/O

```text
UI / Master / schedule / board task
  -> ConductorActions launch helper
  -> native.spawnSession(..., terminalShell?)
  -> Rust portable-pty process
  -> session-data Tauri event
  -> xterm registry + output tail + settle timer
  -> screen scan after quiet period
  -> monitor/watcher notification and UI attention state
```

Text and Enter are sent separately with a 250 ms gap. Several full-screen CLIs interpret a single `text + carriage-return` write as pasted input. Live PTYs never receive replayed scrollback because replaying bytes into an alternate-screen TUI corrupts its display; remounts use a resize repaint instead.

Plain terminal sessions carry `Agent.terminalShell` and start that executable directly with login/interactive flags. Arbitrary commands still run through `/bin/sh -lc` because their quoting, operators, environment prefixes, and GUI-process PATH resolution require shell parsing. The backend resolves a named terminal shell using the user's login PATH and returns an error when it is missing; it never falls back silently to another shell.

### Master orchestration

```text
user message or queued event
  -> runMasterTurn(getState, exec)
  -> provider adapter
  -> model tool call
  -> MasterExec implementation in store.tsx
  -> session/state/addon side effect
  -> tool result returned to the model
  -> final visible reply
```

The harness caps tool iterations and applies an integrity retry when a model claims it acted without calling an action tool. Master receives structured state and monitor digests, not an unbounded stream of raw terminal bytes.

### Monitor and task-watcher flow

Raw PTY activity resets a short settle timer. When output becomes quiet, YAAM reads the rendered xterm screen. The session monitor updates task/summary/action fields and escalates only noteworthy changes. If a session is attached to a board task, that task's watcher also receives the stable screen, can update the card, steer the worker, or ask the user one focused question. Watcher histories are private and capped.

### Persistence and workspaces

The active workspace's scoped fields live flat on `AppState`; inactive workspace slices live in `workspaceData`. `switchWorkspaceIn`, `scopedFromState`, and `applyScoped` swap those slices. Agents remain in one global array and carry a `workspaceId`.

State is hydrated from and debounced back to `conductor-state.json`. Adding a persisted top-level field requires all of the following:

1. Add it to `PersistedState` and `AppState` in `types.ts`.
2. Seed it in `seedState()`.
3. Hydrate it defensively for older saved files.
4. Include it in the debounced writer and the `beforeunload` writer.
5. Include its dependencies in the persistence effect and guard reads from legacy state.

Do not rename the Tauri identifier `dev.yaam.conductor` or the state filename; both preserve existing installations.

### Addon flow

Addon views run in sandboxed iframes and exchange `yaam:state`, `yaam:call`, and `yaam:result` messages with the host. Addon tools and hooks run in the app context through a curated `AddonApi`. Every path converges on `enforcePermissions`; extending the API requires updating its type, implementation, permission map, RPC whitelist, and LLM-facing authoring documentation.

## State and side-effect rules

- Reducer updaters must be pure. React StrictMode may invoke them twice.
- Perform process, network, timer, notification, and addon side effects outside dispatch updaters.
- Use a ref when asynchronous callbacks need the latest state or when callbacks reference one another across declaration order.
- Keep terminal instances outside React state in `terminals.ts`.
- Preserve unrelated worktree changes and legacy persisted-state compatibility.
- Scope schedules and queued Master notes correctly: background workspaces continue running.

## Function documentation convention

Every named module-level function and React component in runtime source should have a short doc comment that describes its behavior, important side effects, or boundary role. Substantial named inner functions should have a nearby line comment. Anonymous predicates and one-line `map`/event adapters do not need narration when the expression is self-explanatory. Comments should explain constraints or data movement rather than repeat the function name. The historical `design/` prototype is retained as an upstream artifact and is not maintained to this runtime convention.

## Change checklist

- Run the full verification gate.
- For terminal changes, test both a plain shell and an alternate-screen CLI.
- For state changes, test hydration from an older state file and workspace switching.
- For LLM changes, preserve provider neutrality and tool-result history shape.
- For addon API changes, update [docs/addons.md](docs/addons.md).
- For Rust command changes, register the command in `lib.rs` and add a typed wrapper in `native.ts`.

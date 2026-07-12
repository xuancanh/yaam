# AGENTS.md — YAAM working context

Context for AI agents (Claude Code and others) working in this repo. Read this
first; it captures the non-obvious architecture and conventions that the code
alone won't tell you quickly.

## What YAAM is

**YAAM — Yet Another Agent Manager.** A Tauri 2 + React 19 + TypeScript desktop
app for orchestrating multiple **live coding-agent CLI sessions** (Claude Code,
Codex, Aider, Gemini CLI, or any shell). It spawns real PTYs, renders them with
xterm.js, and puts an LLM "Master" orchestrator between the user and those
sessions. It is a real product, not a demo — there is no simulation layer left.

Three roles communicate: **user ↔ Master (LLM) ↔ agent sessions (CLI processes)**.
Each session also has its own lightweight **monitor LLM** that watches output and
only escalates digests to Master, so Master isn't spammed by raw terminal noise.

## Repo layout

```
app/                     Tauri app (the whole product)
  src/                   React frontend. Root holds only the app hub; everything else is grouped.
    App.tsx main.tsx     composition root + entry
    store.tsx            32-line provider: AppRuntime lifecycle + stable ActionsCtx
    app/                 non-React application runtime, subsystem wiring, action composition
    infrastructure/      persistence schema, hydration, subscriptions, save/close runtime
    master.ts monitor.ts compatibility barrels (llm/client + domains/master/*)
    store/               store internals: hooks (useConductor/useConductorSelector/useActions),
                         state-helpers, secrets (keychain redaction), + tests
    llm/client.ts        shared LLM core: provider defs + protocol adapters + SSE streaming
    components/          shared UI primitives only: ui.tsx, Markdown.tsx, Confirm.tsx (imperative delete-confirmation dialog)
    shared/              dependency-free helpers: zip/filetext (office & PDF extraction), git-repos (multi-repo cwd detection), id
    core/                shared foundation used across domains:
      store.ts           Zustand store (useAppStore) + dispatch
      types.ts data.ts context.ts ports.ts       types, seed/catalogs, ActionsCtx, runtime ports
      native.ts mcp.ts terminals.ts               Tauri bridge, MCP client, xterm registry
      addons.ts highlight.ts skills.ts usage.ts   addon contract, highlighter, skills, usage est.
    domains/             feature domains — each owns its view, components, logic (runner), actions:
      session/           terminal-session UI: Workspace, Pane, TerminalPane, FilesPane, GitPanel
                         (Fork-style git workbench: staging/commit/AI messages, shared by the
                         review drawer + task drawer), NewSessionDialog (worktree isolation toggle)
      chat/              ChatView, ChatPane, runner, agent (in-app chat agents: slash skills,
                         attachments/vision, ask-mode approvals, durable workspace memory)
      board/             Board + TaskSpecForm + ReviewPanel (review queue: diff/approve-merge/
                         request-changes), watcher-runner + watcher, task-state (kanban; delete
                         archives — hard delete only from the Archived viewer)
      master/            Sidebar, runner + monitor-runner, master/tools/prompt/monitor harnesses
      addons/            AddonsView/AddonView/AddonSource, addon-api, addon-agent/editor/gen
      activity/          workspace-aware event/notification service
      settings/          SettingsView, ToolsView, integrations + MCP/plugin import
      schedules/         Schedules, TemplatesView
      shell/             app chrome + top-level views: TitleBar, IconRail, CommandPalette,
                         Overview, Timeline, Drawer, SlideOver, Toast, UsageSummary
    App.tsx              composition root (mounts the shell + the active domain view)
  src-tauri/
    src/                 backend domains — each module keeps its managed state,
                         logic, #[tauri::command] boundary, and tests together
      lib.rs             composition root: modules, managed state, invoke_handler
      setup.rs           one-time startup (dock icon, logging); util.rs shared helpers
      domains/session.rs SessionManager PTY engine + CLI session-id detection
      domains/state.rs   atomic persistence: main partition + per-session files
      domains/git.rs, domains/fs.rs   git status/diff/stage/commit; fs + timeout-bounded exec
      domains/worktree.rs             git-worktree isolation (single- and multi-repo folders):
                                      create/diff/merge/remove under ~/.yaam/worktrees
      domains/search.rs  tantivy full-text index over chat transcripts
      domains/mcp.rs     local stdio MCP child-process transport
      domains/bedrock.rs AWS Bedrock InvokeModel bridge + credential parsing/caching
      domains/secrets.rs OS-keychain credential storage (keyring)
    capabilities/default.json   Tauri ACL permissions
    tauri.conf.json      productName YAAM, identifier dev.yaam.conductor (kept for state compat)
    icons/               app icons, generated from app/app-icon.svg via `tauri icon`
docs/README.md           current architecture/domain/security documentation index
docs/addons.md           canonical addon architecture + authoring reference
registry/                seed addon registry
  src/                   EDITABLE addon sources (toolchain projects: addon.config.ts + view + TS handlers)
  packages/              GENERATED folder-format addons + packed *.yaam.json — never edit by hand
  index.json             registry index (updated by yaam-addon publish / scripts/build-addons.mjs)
sdk/                     addon developer toolkit (npm workspace — build with `cd sdk && npm run build`):
  addon-sdk/             @yaam/addon-sdk: typed API mirror + bridge + React bindings + testing stub + ui.css
  yaam-addon/            build tool + CLI (build/pack/publish/dev/validate)
  create-yaam-addon/     scaffolder (react-ts + vanilla templates)
toolkit/                 vanilla (no-build) addon kit: sdk.js + ui.css + template
scripts/pack-addon.mjs   folder-format addon → single-file .yaam.json (vanilla path)
scripts/build-addons.mjs rebuild + publish every registry/src project into registry/packages
scripts/validate-registry.mjs  registry integrity/version/scope-diff check (also runs in CI)
design/                  original HTML design mockups (historical reference)
```

Note: the identifier is still `dev.yaam.conductor` and the state file is
`conductor-state.json` — kept deliberately so existing installs keep their data.
Don't "fix" these to say yaam; it breaks state compatibility.

## Build / run / verify

Run everything from `app/`. Cargo must be on PATH (`export PATH="$HOME/.cargo/bin:$PATH"`).

- `npm run tauri dev` — run the app with hot reload. Frontend edits HMR instantly;
  Rust edits trigger an automatic recompile + relaunch.
- `npx tsc --noEmit -p tsconfig.app.json` — typecheck the frontend. **Always run
  before committing.** (A bare `npx tsc --noEmit` silently checks NOTHING — the
  root tsconfig is a solution-style config with `files: []`.)
- `npm run lint` — oxlint. Three pre-existing `only-export-components` warnings in
  `ui.tsx` and files that export both a component and helpers are expected/benign.
- `npm test` — run the full frontend Vitest suite once (`vitest run`).
- `npm run build` — production frontend build (`tsc -b && vite build`).
- `(cd src-tauri && cargo check)` — typecheck Rust. `cargo test --lib` runs the
  colocated backend domain tests.
- `npm run tauri build` — release bundle (.app + .dmg). Ad-hoc signed
  (`signingIdentity: "-"`); no notarization.

Whole gate before a commit: `npx tsc --noEmit -p tsconfig.app.json && npm run lint && (cd src-tauri && cargo check)`.

## Architecture notes that will bite you

**One data store, plain domain runtimes.** State lives in one **Zustand** store
(`core/store.ts`); `dispatch(updater)` replaces state with full-object/no-op
semantics. `app/conductor-runtime.ts` builds a non-React `AppRuntime` from four
plain subsystems under `app/runtime/` (session/board, addon, chat/boot,
Master/scheduler), then composes domain-owned action factories. `store.tsx` only
constructs/starts/disposes that runtime and provides its stable actions. Runtime
maps, timers, histories, queues, subscriptions, and abort controllers belong to
their subsystem—not Zustand and not React. Typed refs in `app/runtime/refs.ts`
exist only for genuine construction cycles. Components use
`useConductorSelector`; do not reintroduce full-state subscriptions on hot
surfaces. See `docs/architecture.md` and `docs/frontend-domains.md`.

**StrictMode double-invokes reducers.** Never put side effects (launching,
scheduling, network) inside a dispatch updater — they'll fire twice. Do the
side effect outside `dispatch`, and Master events dedupe on a 10s window.

**Contexts live in `context.ts`, not `store.tsx`.** Moving `createContext` into
the hot-reloaded store recreates context identity on HMR and blanks the app
("useConductor outside provider"). Keep them in the stable module.

**Persistence + migrations.** State is written through one selector per
partition (`infrastructure/persistence/schema.ts`): `selectMainState` → the low-churn main blob
(`conductor-state.json`), and `selectSession` → one file per session
(`sessions/<id>.json`, diff-written so a terminal line rewrites only that
session). Direct Zustand subscriptions in `infrastructure/persistence/runtime.ts`
drive debounced writers. Tauri close is vetoed while an awaited, 3s-bounded
flush completes; `beforeunload` is only a browser fallback. Rust writes are
atomic (temp + fsync + rename + `.bak`) and hydration recovers from the backup.
When you add a new persisted top-level field, you MUST:
1. add it to `PersistedState` and `AppState` in `types.ts`,
2. seed it in `data.ts` `seedState()`,
3. hydrate it defensively: `field: p.field ?? s.field ?? <empty>`,
4. add it to the matching selector — `selectMainState` for a normal durable
   field or `selectSession` if it lives on an agent,
5. add its reference to the matching change detector in
   `infrastructure/persistence/subscribe.ts`,
6. **guard every read with `?? []` / `?? {}`** — existing users have saved states
   that predate your field. (The templates crash was exactly this: a saved state
   without `templates` made `s.templates.find` throw. See commit 7edf98a.)

**Multi-window: one state owner, satellites are runtime-lite.** A workspace can
be spun out into its own OS window (`core/window-role.ts`: `?win=ws&ws=<id>`).
All windows share one Tauri backend (PTYs/`invoke`/`session-*` broadcasts are
global), but only the **main** window runs persistence, Master/scheduler, addon
hooks, and integrations — a `workspace` satellite gates those off
(`role.kind === 'main'` checks in `conductor-runtime.ts`/`chat.ts`) and instead
forwards its slice to main via `ws:sync`/`ws:reattach` events
(`infrastructure/native/windows.ts`), so there is never a second writer of
`conductor-state.json`. Never start persistence or the autonomous loops in a
satellite. `detachedWorkspaces` is runtime-only (NOT in `selectMainState`) and
hides spun-out workspaces from that window's switcher. See
`docs/architecture.md` § Multi-window workspace satellites.

**Terminals are a module-level registry, not React state.** `terminals.ts` owns
xterm instances keyed by session id. Panes attach/detach the DOM element on
mount/unmount; live PTYs get **zero** replayed scrollback (replaying into an
alternate-screen TUI corrupts it) and a `repaintSession` SIGWINCH jiggle instead.

## LLM layer

Provider-agnostic. `PROVIDERS` in `llm/client.ts`: `anthropic`, `openai`,
`deepseek`, `kimi`, `gemini`, `glm`, `bedrock`, `custom` (OpenAI-compatible),
`anthropic-compat`. Two wire protocols: Anthropic Messages and OpenAI
chat-completions, adapted to a common internal shape; `callApiStream` adds SSE
streaming for both (Bedrock falls back to buffered). HTTP goes through the
Tauri http plugin to dodge CORS.

- **Credentials**: `hasCreds(settings)` is the gate — true if provider is bedrock
  (AWS credential chain), or there's an API key, or a **credential command** is
  set. A credential command (e.g. `claude default-credential-export`) is a shell
  command whose stdout yields the key/token; parsed, cached until its stated
  expiry, and re-run on 401/403. Bedrock parses AWS credential JSON
  (`aws configure export-credentials` shape, nested `Credentials`, or `AWS_*`
  env lines) in `src-tauri/src/domains/bedrock.rs`, with an optional refresh command (`aws sso login`).
- **Master harness** (`domains/master/master.ts`): tool loop capped at 10 iters, temperature
  0.2, with an **integrity check** — if the model claims it took an action but
  called no tool, the turn is retried. Master must actually drive terminals via
  the `press_keys` / `send_to_session` tools; the no-narration prompt rules and
  the integrity check exist to stop hallucinated "I did X" replies.
- **Monitors** (`domains/master/monitor.ts`): one per session, private capped history, only
  `report_to_master` surfaces a digest to Master. Sessions bound to a board task
  bypass the generic monitor — their task's **watcher** is the monitor.
- **Task watchers** (`domains/board/watcher.ts`): one per kanban task — a mini-Master that
  owns spawning (always ONE-SHOT sessions; can run several), verifies acceptance
  criteria against `check_session` ground truth, moves the card, and chats with
  the user in the card thread. Invariants live in the memory notes: task sessions
  are always ephemeral; template schedules always create board tasks; templates
  themselves stay purpose-neutral (the spawn path layers `taskWorkText` into
  `{task}` and appends the criteria/goal contract after the composed prompt).
- **Chat agents** (`domains/chat/agent.ts`): Chat-view sessions (`Agent.kind==='chat'`,
  no PTY) with file/exec/skill/MCP tools and streaming; per-type provider config
  (`chatAgentTypes`, `buildChatCfg`), per-session model, optional persona
  (`personas`) and chosen skill sources (`skills.ts` registries + local `skills`).
  File writes are sandboxed to the chat's working folder; truncated tool-call
  args (`incompleteArgs`) are refused, not run with `{}`. Streaming routes a
  thinking channel separate from the answer (rendered as a collapsible block);
  thinking is kept out of replayed API history. Excluded from workspace
  tabs/groups/overview; transcripts feed the Tantivy index (`src-tauri/src/domains/search.rs`) and
  chats auto-title after the first turn unless renamed.
- **Addon agents** (`domains/addons/addon-agent.ts`): optional per-addon harness whose tools
  are the addon's permission-scoped API; woken by subscribed hooks or `agent.wake`.

## Settle / detection pipeline (subtle — don't casually change)

Terminals, especially full-screen TUIs, redraw constantly and emit no newlines.
Detection is driven by a **raw-activity settle timer** (~3s of quiet), then a
screen scan of the xterm buffer (`readScreen`), not by line streaming. Key rules:

- Alternate-screen (TUI) sessions are exempt from the plain prompt heuristic;
  scroll/arrow/mouse CSI sequences don't count as user input (they used to spam
  Master).
- Permission/needs-input detection only runs **after output settles**, using
  `TUI_PROMPT_RE` / option extraction, with dedupe.
- "Finished responding" is deterministic: on settle, if the session isn't the
  one being actively watched, set `attention` + notify — not gated on the LLM.

## Sessions, resume, ephemeral

- CLI session-id capture (for resume) is by **file birthtime**, not mtime: watch
  `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl` (claude) or `~/.codex/sessions`
  (codex) for the newest file created after spawn. mtime is unreliable because a
  concurrent conversation can touch an older file. See `detect_cli_session`.
- **Ephemeral agents** (`Agent.ephemeral`, from templates in `-p`/`exec` mode):
  a clean process exit is task *completion*, not an anomaly — it's logged/notified
  as "completed", the monitor summarizes the final screen, and `autoArchive`
  optionally tidies the pane ~12s later. Non-ephemeral exits are treated as before.

## Agent templates, cron, scheduling

- `AgentTemplate` (types.ts): mode `ephemeral | interactive`, prompt (`{task}`
  placeholder), system prompt, model, approval (`safe|edits|full`), cwd, extra
  args, autoArchive. `buildTemplateCommand()` in `domains/schedules/template-command.ts` maps these to
  real CLI flags — claude: `-p`, `--model`, `--append-system-prompt`,
  `--permission-mode acceptEdits`, `--dangerously-skip-permissions`; codex:
  `exec --skip-git-repo-check`, `-m`, `--sandbox read-only`,
  `--sandbox workspace-write`, `--dangerously-bypass-approvals-and-sandbox`.
  It's shell-quote-safe, and takes an optional `contract` appended after the
  composed prompt (the board's criteria/goal layer).
- Templates launch from the Templates view, NewSessionDialog, board tasks, cron
  schedules, and Master (`run_template` tool; `create_schedule` accepts a template).
- The 15s ticker in `domains/schedules/runtime.ts` fires cron schedules AND scheduled board tasks
  (`BoardTask.scheduleAt`), across all workspaces (active and background pools).

## Workspaces

Agents are global with a `workspaceId` tag. Pane layout is **tab groups**
(`TabGroup[]` + `activeGroup`, Chrome-style: each group owns slots/orientation/
splits; a session lives in at most one group; legacy `focusedIds` migrates via
`groupsFromLegacy`). The **scoped slice**
(messages/crons/tasks/events/notifications/groups) is swapped between flat state
and `workspaceData[id]` on switch (see `switchWorkspaceIn`, `scopedFromState`,
`applyScoped` in `domains/workspace/state.ts`). Templates and agentTypes are global, not scoped.
Background workspaces still fire schedules and queue Master notes.

## Addons

A full platform — see `docs/addons.md` for the canonical reference. In short:
addons are packages (single-file manifest 2 JSON, or the folder format manifest 3:
`addon.yaml` + real html/js/md files, strict YAML-subset parser in `addons.ts`)
with four capability types — a sandboxed iframe **view**, sandboxed Master
**tools**, lifecycle **hooks** (`onSessionExit`,
`onNeedsInput`, `onTaskMoved`, `onCronFired`, `masterPromptAppend`), and an
**agent** (its own LLM harness). All converge on one permission-enforced
`AddonApi` built by `app/runtime/addon.ts` and wrapped by `enforcePermissions()`.
Scopes: `state:read`, `sessions:send`, `sessions:launch`, `tasks`, `schedules`,
`agent`, `master:prompt`, `ui`, `storage`. Views talk to the app over postMessage
(`yaam:state` push + `yaam:call` RPC, incl. `agent.wake`). Management lives in the
Addons marketplace view (multi-registry, local folder registries, ✦ Generate).

Security invariants (don't regress): fresh installs auto-grant only low-risk
scopes (`state:read`, `ui`, `storage`) — the rest (`sessions:*`, `tasks`,
`schedules`, `agent`, `master:prompt`) start off and are enabled per-addon.
`masterPromptAppend` only fires for addons holding `master:prompt`. Views get an
injected `default-src 'none'` CSP (no network) and only receive state snapshots
when the addon holds `state:read`; disabled addons get an empty grant set.
Tool and hook JavaScript also runs in an opaque-origin, network-denied iframe
with whitelisted/permission-checked RPC, a timeout, and result-size cap—never
evaluate package code in the main webview.

When extending the addon API surface: add to `AddonApi` → implement in
`makeAddonApiRaw` → map in `METHOD_PERMISSION`/`ALL_PERMISSIONS` → whitelist in
`ADDON_RPC_METHODS` → update the LLM-facing docs in `master-tools.ts`
(create_addon), `addon-editor.ts`, AND `addon-gen.ts` → mirror it in the SDK
(`sdk/addon-sdk/src/types.ts` + `permissions.ts`). The mirror is gate-enforced:
`app/src/core/addon-sdk-compat.ts` fails the app typecheck and the SDK's
host-compat tests fail until both sides agree.

Shipped addons are built from `registry/src/` (see `docs/addons-tutorial.md`
§8): edit the source project, bump its version in `addon.config.ts`, then
`node scripts/build-addons.mjs <slug>` regenerates `registry/packages/`.
Dev installs (Addons → Dev install…) watch a folder and hot-reinstall on
change — `Addon.devPath` + `domains/addons/dev-watch.ts`.

## Conventions

- Match surrounding style: inline style objects, no CSS framework, CSS vars from
  `index.css` (`--bg`, `--panel`, `--line`, `--accent` gold `#F5C451`, `--green`,
  `--amber`, `--red-soft`, `--mut`, `--dim`, `--faint`). Fonts: Space Grotesk
  (`.grotesk`), IBM Plex Sans (body), JetBrains Mono (`.mono`).
- The YAAM logo is `MasterMark` in `ui.tsx` (gold rounded square + three ascending
  bars). App icons/favicon derive from `app/app-icon.svg` — regenerate with
  `npx tauri icon app-icon.svg` if it changes.
- Comments state constraints the code can't show; don't narrate the obvious.
- Enter into a session is sent as a **separate keypress 250ms after the text**
  (TUIs treat text+`\r` in one chunk as a paste). See `sendLineToSession`.

## Gotchas checklist

- New persisted field → do all 6 persistence steps above AND guard reads with `?? []`.
- New cross-referencing callback → wire through a ref if it forms a cycle.
- Don't put side effects in dispatch updaters (StrictMode double-fire).
- Don't move contexts out of `context.ts`.
- Don't replay scrollback into a live PTY.
- Don't rename the `dev.yaam.conductor` identifier or `conductor-state.json`.
- macOS "app is damaged": `xattr -cr /Applications/YAAM.app` (unsigned/ad-hoc).

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
  src/                   React frontend
    store.tsx            central provider: all actions, effects, persistence, LLM runners (~1900 lines)
    state-lib.ts         pure helpers (cron, command building, workspace scoping, PTY line send)
    types.ts             all TypeScript types (AppState, Agent, AgentTemplate, Cron, …)
    data.ts              seedState() + static catalogs (agent types, tools, colors)
    native.ts            Tauri bridge (invoke wrappers); no-ops in plain browser
    terminals.ts         module-level xterm.js registry + ANSI/screen helpers
    context.ts           StateCtx/ActionsCtx (kept in a stable module — HMR fix, do not move)
    highlight.ts         shared regex syntax highlighter (AddonSource + FilesPane)
    addons.ts            addon runtime: package parse/validate, permission model, RPC
    master.ts            barrel re-exporting src/llm/*
    mcp.ts               streamable-HTTP MCP client (initialize / tools list+call)
    llm/
      client.ts          provider defs + protocol adapters (Anthropic Messages / OpenAI chat / Bedrock) + SSE streaming (callApiStream)
      master.ts          runMasterTurn: tool loop + integrity check
      master-tools.ts    Master tool defs (TOOLS) + MasterExec interface + runTool dispatch
      master-prompt.ts   systemPrompt(state) + chat history builder
      monitor.ts         per-session monitor harness
      watcher.ts         per-task watcher harness (kanban "mini-Master") + task-spec drafting
      chat-agent.ts      chat-mode session harness (files/exec/skills/MCP tools, streaming)
      addon-agent.ts     per-addon agent harness (tools = the addon's scoped API)
      addon-gen.ts       "✦ Generate" addon authoring harness (full context + self-repair)
      addon-editor.ts    per-addon "Customize" chat harness
    components/          views + workspace/ (Pane, TerminalPane, FilesPane, NewSessionDialog, Divider)
  src-tauri/
    src/
      sessions.rs        PTY spawn/io/kill, exec_command, CLI session-id detection, git, fs, state file
      chatsearch.rs      tantivy full-text index over chat transcripts
      bedrock.rs         AWS Bedrock InvokeModel bridge + credential parsing/caching
      lib.rs             command registration (invoke_handler)
    capabilities/default.json   Tauri ACL permissions
    tauri.conf.json      productName YAAM, identifier dev.yaam.conductor (kept for state compat)
    icons/               app icons, generated from app/app-icon.svg via `tauri icon`
docs/addons.md           canonical addon architecture + authoring reference
registry/                seed addon registry (index.json + packages/*.yaam.json + qa-gate/ folder format)
scripts/pack-addon.mjs   folder-format addon → single-file .yaam.json
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
- `npm run lint` — oxlint. Two pre-existing `only-export-components` warnings in
  `ui.tsx` and files that export both a component and helpers are expected/benign.
- `npm run build` — production frontend build (`tsc -b && vite build`).
- `(cd src-tauri && cargo check)` — typecheck Rust. `cargo test --lib` runs the
  bedrock credential-parser unit tests.
- `npm run tauri build` — release bundle (.app + .dmg). Ad-hoc signed
  (`signingIdentity: "-"`); no notarization.

Whole gate before a commit: `npx tsc --noEmit -p tsconfig.app.json && npm run lint && (cd src-tauri && cargo check)`.

## Architecture notes that will bite you

**One giant store.** `store.tsx` holds the entire app in a single `useReducer` +
a `ConductorActions` object. `stateRef.current` mirrors state for use inside
closures/effects. Several callbacks are wired through **refs** (`masterEventRef`,
`bumpSettleRef`, `fireAddonHookRef`, `onSettleRef`, `monitorEventRef`,
`launchFromTemplate`) to break declaration-order/TDZ cycles — respect that
pattern when adding cross-referencing callbacks.

**StrictMode double-invokes reducers.** Never put side effects (launching,
scheduling, network) inside a dispatch updater — they'll fire twice. Do the
side effect outside `dispatch`, and Master events dedupe on a 10s window.

**Contexts live in `context.ts`, not `store.tsx`.** Moving `createContext` into
the hot-reloaded store recreates context identity on HMR and blanks the app
("useConductor outside provider"). Keep them in the stable module.

**Persistence + migrations.** State is saved (debounced 800ms + `beforeunload`
flush) to `conductor-state.json` via the Rust `save_state` command, and hydrated
on launch. When you add a new persisted top-level field, you MUST:
1. add it to `PersistedState` and `AppState` in `types.ts`,
2. seed it in `data.ts` `seedState()`,
3. hydrate it defensively: `field: p.field ?? s.field ?? <empty>` (line ~612),
4. include it in BOTH persistence writers (debounced effect ~679 and the
   `beforeunload` flush ~711) and the effect dep array,
5. **guard every read with `?? []` / `?? {}`** — existing users have saved states
   that predate your field. (The templates crash was exactly this: a saved state
   without `templates` made `s.templates.find` throw. See commit 7edf98a.)

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
  env lines) in `bedrock.rs`, with an optional refresh command (`aws sso login`).
- **Master harness** (`llm/master.ts`): tool loop capped at 10 iters, temperature
  0.2, with an **integrity check** — if the model claims it took an action but
  called no tool, the turn is retried. Master must actually drive terminals via
  the `press_keys` / `send_to_session` tools; the no-narration prompt rules and
  the integrity check exist to stop hallucinated "I did X" replies.
- **Monitors** (`llm/monitor.ts`): one per session, private capped history, only
  `report_to_master` surfaces a digest to Master. Sessions bound to a board task
  bypass the generic monitor — their task's **watcher** is the monitor.
- **Task watchers** (`llm/watcher.ts`): one per kanban task — a mini-Master that
  owns spawning (always ONE-SHOT sessions; can run several), verifies acceptance
  criteria against `check_session` ground truth, moves the card, and chats with
  the user in the card thread. Invariants live in the memory notes: task sessions
  are always ephemeral; template schedules always create board tasks; templates
  themselves stay purpose-neutral (the spawn path layers `taskWorkText` into
  `{task}` and appends the criteria/goal contract after the composed prompt).
- **Chat agents** (`llm/chat-agent.ts`): Chat-view sessions (`Agent.kind==='chat'`,
  no PTY) with file/exec/skill/MCP tools and streaming; per-type provider config
  (`chatAgentTypes`, `buildChatCfg`), per-session model, optional persona
  (`personas`) and chosen skill sources (`skills.ts` registries + local `skills`).
  File writes are sandboxed to the chat's working folder; truncated tool-call
  args (`incompleteArgs`) are refused, not run with `{}`. Streaming routes a
  thinking channel separate from the answer (rendered as a collapsible block);
  thinking is kept out of replayed API history. Excluded from workspace
  tabs/groups/overview; transcripts feed the tantivy index (`chatsearch.rs`) and
  chats auto-title after the first turn unless renamed.
- **Addon agents** (`llm/addon-agent.ts`): optional per-addon harness whose tools
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
  args, autoArchive. `buildTemplateCommand()` in `state-lib.ts` maps these to
  real CLI flags — claude: `-p`, `--model`, `--append-system-prompt`,
  `--permission-mode acceptEdits`, `--dangerously-skip-permissions`; codex:
  `exec --skip-git-repo-check`, `-m`, `--sandbox read-only`,
  `--sandbox workspace-write`, `--dangerously-bypass-approvals-and-sandbox`.
  It's shell-quote-safe, and takes an optional `contract` appended after the
  composed prompt (the board's criteria/goal layer).
- Templates launch from the Templates view, NewSessionDialog, board tasks, cron
  schedules, and Master (`run_template` tool; `create_schedule` accepts a template).
- The 15s ticker in `store.tsx` fires cron schedules AND scheduled board tasks
  (`BoardTask.scheduleAt`), across all workspaces (active and background pools).

## Workspaces

Agents are global with a `workspaceId` tag. Pane layout is **tab groups**
(`TabGroup[]` + `activeGroup`, Chrome-style: each group owns slots/orientation/
splits; a session lives in at most one group; legacy `focusedIds` migrates via
`groupsFromLegacy`). The **scoped slice**
(messages/crons/tasks/events/notifications/groups) is swapped between flat state
and `workspaceData[id]` on switch (see `switchWorkspaceIn`, `scopedFromState`,
`applyScoped` in state-lib.ts). Templates and agentTypes are global, not scoped.
Background workspaces still fire schedules and queue Master notes.

## Addons

A full platform — see `docs/addons.md` for the canonical reference. In short:
addons are packages (single-file manifest 2 JSON, or the folder format manifest 3:
`addon.yaml` + real html/js/md files, strict YAML-subset parser in `addons.ts`)
with four capability types — a sandboxed iframe **view**, Master **tools**
(`new Function('input','api', src)`), lifecycle **hooks** (`onSessionExit`,
`onNeedsInput`, `onTaskMoved`, `onCronFired`, `masterPromptAppend`), and an
**agent** (its own LLM harness). All converge on one permission-enforced
`AddonApi` built by `makeAddonApi(addonId)` and wrapped by `enforcePermissions()`.
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

When extending the addon API surface: add to `AddonApi` → implement in
`makeAddonApiRaw` → map in `METHOD_PERMISSION`/`ALL_PERMISSIONS` → whitelist in
`ADDON_RPC_METHODS` → update the LLM-facing docs in `master-tools.ts`
(create_addon), `addon-editor.ts`, AND `addon-gen.ts`.

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

- New persisted field → do all 5 persistence steps above AND guard reads with `?? []`.
- New cross-referencing callback → wire through a ref if it forms a cycle.
- Don't put side effects in dispatch updaters (StrictMode double-fire).
- Don't move contexts out of `context.ts`.
- Don't replay scrollback into a live PTY.
- Don't rename the `dev.yaam.conductor` identifier or `conductor-state.json`.
- macOS "app is damaged": `xattr -cr /Applications/YAAM.app` (unsigned/ad-hoc).

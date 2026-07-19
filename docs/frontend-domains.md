# Frontend domain implementation

## Frontend design rules

The frontend separates four concerns:

- `AppState` is data in Zustand.
- Domain action factories expose commands to the UI.
- Plain runtime factories own timers, subscriptions, queues, histories, and OS
  or LLM side effects.
- React components render selector-derived state and call stable actions.

Pure transitions stay near their owning domain. Native operations should use a
narrow port where one exists. Runtime lifecycle is explicit through `start`,
`dispose`, and keyed cancellation methods.

## Application composition (`app/`)

### Responsibility

The application layer wires domains together; it does not own feature rules.

### Implementation

- `conductor-runtime.ts` constructs `AppRuntime`, the shared kernel, domain
  subsystems, stable action surface, state mirror, feedback timer, and teardown.
- `runtime/session.ts` assembles the mutually dependent session, monitor,
  watcher, settle, launch, and exit services.
- `runtime/addon.ts` assembles addon API, agent, editor/package, hook, and
  sandbox execution paths.
- `runtime/chat.ts` assembles integrations, chat runtime, persistence,
  hydration, chat search indexing, and session-runtime cleanup.
- `runtime/master.ts` assembles Master, workspace event routing, and scheduler.
- `runtime/refs.ts` supplies typed mutable cells for construction cycles and
  fast task-session/user-stop bindings.
- `conductor-actions.ts` composes every domain action factory.
- `actions.ts` composes domain-owned TypeScript action interfaces.
- `global-effects.ts` owns appearance updates, global error logging, and
  keyboard shortcuts.
- `appearance.ts` projects theme, density, scale, and font settings onto the
  document root.

`store.tsx` constructs `AppRuntime` once with a ref so React StrictMode's render
probe does not create duplicate runtimes. Its mount effect starts the runtime;
cleanup disposes it.

### Command registry status

`app/commands/` contains an actor-aware command registry, capability policy,
audit ring, validation hook, and one-shot approval mechanism. It defines actors
for user, Master, watcher, chat, and addon callers. `createAppRuntime` constructs
the registry and registers the first vertical use case: `send_to_session`.
The UI session action executes that command as the user actor. Addon
`sendToSession` calls execute it as an addon actor carrying the package id,
after the normal addon permission wrapper has allowed `sessions:send`.

Migration is partial. Master, watcher, chat, and other addon operations still
largely use their existing domain adapters and policy gates. Do not assume every
action is centrally audited or authorized by the registry yet.

## Shared foundation (`core/`, `store/`, `shared/`, `llm/`)

### State and selectors

- `core/store.ts` creates the data-only Zustand store and pure `dispatch` helper.
- `store/hooks.ts` exposes full-state access, narrow selectors with equality
  caching, one-level shallow equality, and stable actions from context.
- `core/context.ts` keeps context identity outside hot-reloaded provider code.
- `core/types.ts` defines persisted records, runtime state, domain entities,
  and the combined `AppState`.
- `core/data.ts` seeds default agent types, templates, providers/settings,
  skills, persona, Master tools, colors, and fresh state.

### Runtime ports and cancellation

- `core/ports.ts` defines `StatePort`, `ClockPort`, and `Disposable`. Real ports
  adapt Zustand and browser timers; tests use fakes.
- `core/abort-registry.ts` owns keyed `AbortController`s for chats, monitors,
  watchers, addon agents, and Master work.
- `core/ports.fakes.ts` supplies deterministic test doubles.

### Native and terminal adapters

- `core/native.ts` is the TypeScript/Tauri boundary. It maps camel-case frontend
  types to Rust commands/events and provides browser-preview fallbacks where
  meaningful.
- `core/terminals.ts` owns the module-level xterm registry, the single native
  output listener, per-session streaming UTF-8 decoders, ANSI-stripped line
  extraction, terminal sizing, repaint, and disposal.

### LLM client

`llm/client.ts` contains provider definitions, credential-command caching,
Anthropic/OpenAI request conversion, Bedrock delegation, buffered calls, SSE
stream parsing, thinking/tool-call normalization, and authentication retry.

The domain loops consume the common `ApiMessage`, `ApiContentBlock`,
`ApiResponse`, and `LlmConfig` shapes.

### Shared utilities

- `shared/id.ts` generates client-side entity ids.
- `shared/zip.ts` and `shared/filetext.ts` parse attached zip-based office files
  and extract display/prompt text.
- `core/highlight.ts` provides shared source highlighting.
- `core/usage.ts` estimates output tokens and spend from retained text.

## Activity domain

### Purpose

Route events and notifications to the workspace that owns the affected session.

### Implementation

`domains/activity/service.ts` is a plain factory over `StatePort`. `widOf`
resolves a session's workspace, `logEvent` prepends a bounded 200-item activity
entry, and `notify` prepends a bounded 30-item notification. Background
workspace data is updated inside `workspaceData` without switching the UI.

### Tests

Tests cover active/background routing, invalid session fallback, and bounds.

## Session domain

### Purpose

Own real terminal-session state, process/terminal actions, launch planning,
prompt attention, settle detection, exit classification, pane layout, and the
workspace file viewer.

### Main implementation units

| File | Responsibility |
| --- | --- |
| `controller.ts` | One public lifecycle surface composed from session and prompt actions |
| `app/commands/session-commands.ts` | Registered `send_to_session` use case and capability |
| `ports.ts` | `SessionProcessPort` over native PTY and xterm capabilities |
| `actions.ts` | Archive, restore, delete, resume, launch, send, and stop |
| `prompt-actions.ts` | Approve, deny, or choose a numbered terminal prompt option |
| `config-actions.ts` | Per-session memory/tool toggles and permissions |
| `layout-actions.ts` | Pane/group assignment, split ratios, maximize/minimize, focus |
| `layout-state.ts` | Pure group creation, removal, legacy migration, and focus transitions |
| `launch.ts` | Pure launch-plan construction, Claude session-id injection, initial Agent record |
| `launch-runtime.ts` | PTY spawn, CLI id probing, template launch, canonical task launch |
| `command.ts` | Agent type matching, env prefix, key mapping, delayed Enter send |
| `remote-machine.ts` | Pure SSH/tmux command builders (wrap launch, kill, ssh options, connection test) for machine sessions |
| `remote-native.ts` | `SessionFs` adapter: local native fs/git, or the same operations over SSH for a machine session |
| `attention.ts` | Screen tails, needs-input escalation, monitor status, bounded output/usage |
| `prompt-detection.ts` | Pure prompt/menu heuristics, numbered option extraction, and the no-brain status digest |
| `use-settle.ts` | Plain settle runtime plus legacy React adapter |
| `exit.ts` | Pure stopped/failed/completed/exited classification |
| `exit-handler.ts` | Effectful process-exit coordinator and native subscription |
| `FilesPane.tsx` | File tree, git status/diff gutter, source/document/media preview |
| `GitPanel.tsx` | `GitWorkbench` (staging tree, single/all-files diffs, repo picker, AI-draftable commits) + the pane-header popup shell |
| `Workspace.tsx`, `Pane.tsx`, `TerminalPane.tsx` | Pane layout and terminal/chat mounting |

### Launch and resume

`buildLaunch` creates an optimistic real `Agent`, selects the launch type, and
injects a UUID for new Claude sessions. `createLaunchRuntime` attaches xterm,
spawns through `SessionProcessPort`, probes Codex/OpenCode session files when
needed, and records errors on the agent.

Detached launches (`opts.detached`, New-session dialog checkbox) call the
port's `detachedSpawn` first — the PTY moves into a setsid host process — and
spawn the returned attach command as the session instead. The agent is marked
`detached` and its `cmd` IS the attach command, so resume after an app
restart reattaches to the still-running host (output ring replayed).
`stopSession` is detached-aware: it also `detachedKill`s the host's process
group, ending the session for real.

Templates build CLI-specific shell-safe commands. Task runs are forced to
one-shot mode and use the same path for active and background workspaces.
Resume prefers a captured CLI id and falls back to each agent type's configured
resume command.

### Output and attention

The terminal registry routes raw bytes directly to xterm and calls:

- `appendTail` for complete ANSI-stripped lines;
- `bumpSettle` for every raw chunk, including TUI redraws;
- `clearNeeds` for meaningful user input;
- `armResponseWatch` when the user submits input.

Retained logs are capped at 200 entries. Cost and token usage are estimates from
printable output characters.

### Settle and prompt detection

The runtime waits for three seconds of quiet, then reads the active xterm screen
for alternate-screen apps or the new line tail for plain sessions. It suppresses
prompt detection while known busy markers are visible, extracts menu choices,
and deduplicates repeated questions. A four-second scan catches persistent TUI
dialogs even if ordinary settle timing misses them.

### Exit handling

The pure classifier distinguishes user stop, non-zero failure, successful
ephemeral completion, and ordinary interactive exit. The coordinator then:

- updates the session status and task column;
- captures a missing CLI resume id;
- fires addon hooks;
- reports to the task watcher or generic monitor;
- logs/notifies the correct workspace;
- schedules optional successful one-shot auto-archive.

### File pane

The file pane lists directories, loads text or base64 binary content, provides
image/PDF/office previews (including pptx, odp, and odt), highlights source, and
derives changed-line markers from zero-context git diffs. In Tauri it refreshes
from the native recursive `watch_dir`/`fs-change` stream; browser builds use a
polling fallback. It also offers native open/reveal/VS Code actions and a
custom-scheme rich preview whose network and full-JavaScript modes are explicit
opt-ins. The pane is shared by real sessions and chat sessions with a working
folder. `FolderExplorer` is the standalone variant (tree + rich viewer, nothing
attached) the git workbench uses as its non-git fallback.

### Worktree isolation and the git workbench

Launches (session dialog or task spec) can opt into worktree isolation:
`launch-runtime` calls `createWorktree` before spawning, runs the session in
the mirror's `workdir`, and records `agent.worktree`; a task's follow-up
sessions re-enter the task's existing worktree. `GitWorkbench`
(`GitPanel.tsx`) is the one git surface shared by three hosts — the pane
popup, the agents → Review drawer (plus a feedback input that types into the
session PTY and merge/approve/request-changes actions), and the task drawer's
Review tab. It detects multi-repo folders through `shared/git-repos.ts`,
stages/unstages per file or section, shows per-side diffs (worktree sessions
review against their fork point in all-files mode), and commits with an
optionally AI-drafted message. `mergeSessionWorktree` (actions) and
`approveTaskReview` (board) perform the merge-back + mirror cleanup. When no
git repository exists anywhere under the reviewed folder, the workbench falls
back to `FolderExplorer` (whole-folder browse with the rich viewer) while
keeping the host footer's review actions.

Exit handling restores the terminal modes a dead process left behind (alt
screen, mouse tracking, bracketed paste). `resume` never wipes the scrollback:
it re-normalizes modes and lets the respawned CLI repaint; if the old TUI died
mid-render (still in the alternate screen) it only appends a warning pointing
at the pane header's Clear-terminal button — the explicit user-initiated full
reset. History is never cleared automatically. Closing a pane stops the
process and archives the session behind a confirmation.

### Remote machines

A session can run on a saved remote machine (`settings.machines`, keys/ssh-agent
auth only) over SSH, with no new Rust: the local PTY simply runs an `ssh` client.
By default it behaves like a local session — `wrapLaunch` builds
`ssh -tt … sh -c <cmd>`, so the agent dies when the connection drops and resume
restarts it fresh. Checking **Detached** opts into durability: `wrapLaunch` then
wraps it in `ssh -tt … tmux new-session -A -s <id> …` (attach-or-create, so
resume reattaches and `killRemote` ends the tmux session on stop). The inner
command is base64-encoded to survive both shells; `sshPrefix` shares one
`ControlMaster` connection across the terminal and fs/git calls; `testCommand`
probes tmux/`base64`/git/dir. `buildLaunch` snapshots the resolved connection onto
`agent.machine` (so editing or removing the saved machine never strands a live
session) and records `agent.detached` for the tmux mode; launch/resume/stop and
Files/Git read that snapshot. Machine sessions skip the local-only paths (CLI-id
injection/probing, worktree isolation, the setsid detached host) and use
`agent.cwd` as the remote working dir.

`remote-native.ts` gives Files/Git a per-session `SessionFs`: the native adapter
for local sessions, or ssh-backed `listDir`/`read`/`git status|diff|stage|commit`
(run through `execCommand`, parsed to match `git.rs`, with a size cap on binary
reads) for a machine session. `detectRepos` (cwd itself, else its immediate repo
subfolders) runs over whichever adapter, so remote multi-repo folders are scanned
on the host. `FilesPane`/`GitWorkbench` take the adapter and fall back to a poll
instead of the local fs watch. Templates, board tasks, and schedules all carry a
`machineId` so remote agents can run from those surfaces too.

### Tests

Tests cover launch plans/runtime, controller effects through fake ports, action
cleanup, prompt actions/detection, settle timing, exit classification/fan-out,
layout behavior indirectly through state helpers, and the pure remote-machine
builders + remote-native parsers/adapters.

## Board domain

### Purpose

Own task specifications, workflow columns, task chat, task-session bindings,
per-task watcher agents, diff review, and scheduled task metadata.

### Implementation

- `actions.ts` implements drag/drop, CRUD, watcher-driven start/restart, task
  chat, task drafting, schedules, and review decisions.
- `task-state.ts` locates and updates tasks across active/background workspaces.
- `task-prompt.ts` builds the worker prompt and acceptance contract.
- `watcher.ts` defines task drafting and the task-scoped LLM tool loop.
- `watcher-runner.ts` adapts watcher tools to current state, terminal screens,
  task messages, and session launches; it also streams the watcher's in-flight
  reply into the transient `taskStreams` store map (throttled) so the task
  drawer shows the answer live.
- `watcher-runtime.ts` owns private histories, busy state, queued notes, and
  keyed cancellation.
- `Board.tsx` and `TaskSpecForm.tsx` implement kanban and specification UI;
  `ReviewPanel.tsx` is the review-queue modal (per-repo diffs, approve & merge,
  request changes) and the task drawer embeds the shared `GitWorkbench`.
- deleting a task archives it (`archiveTask`/`restoreTask`); the board header's
  Archived viewer is the only surface offering hard deletion, and every
  destructive action app-wide funnels through `components/Confirm.tsx`
  (an imperative, host-less confirmation dialog).

### Watcher behavior

Each task has a capped private watcher history. The watcher can set the card
column/note, send input, inspect attached sessions, ask the user, and spawn a
one-shot worker. It receives stable terminal output and process-exit evidence.
Before claiming progress it can inspect the latest screen and process status.

The runtime serializes turns per task, drains queued notes, cancels on task
deletion, and prevents more than three simultaneous task workers.

### Tests

Tests cover active/background task lookup and updates plus watcher queue,
cancellation, and disposal.

## Master domain

### Purpose

Provide the user-facing orchestrator, per-session monitor agents, current-state
prompt construction, tool execution, approval handling, and sidebar UI.

### Implementation

- `master.ts` is the capped ten-round Master harness and integrity check.
- `tools.ts` declares Master JSON schemas and dispatches calls to `MasterExec`.
- `prompt.ts` serializes agent/workspace/tool policy state and addon directives.
- `runner.ts` implements tool effects, policy gates, queue draining, and visible
  reply/trace updates.
- `master-runtime.ts` owns busy/queued/dedup state and cancellation.
- `monitor.ts` defines a three-round session-monitor harness.
- `monitor-runner.ts` maps monitor tools to status, prompt, and Master events.
- `monitor-runtime.ts` owns per-session histories, busy set, last-note queue, and
  abort registry.
- `actions.ts` implements composer send and Master tool approval decisions.
- `Sidebar.tsx` renders chat, routes, escalations, build results, collapsed
  traces, and pending Ask-first approvals.

### Policy

Master tools first pass the global catalog gate. Session-targeted tools also
pass the target agent's tool toggle and permission. `Ask first` creates a visible
approval record and consumes a one-shot token on retry. `Approval` and `Off` are
blocked. Addon-contributed tools execute through the addon sandbox and its
permission-scoped API.

### Reliability

The runtime coalesces proactive notes while a turn is busy, deduplicates repeated
events, caps loops/history, supports cancellation, and prevents unsupported
action claims through an integrity retry.

## Chat domain

### Purpose

Provide in-app LLM agents that operate on files and applications without a PTY.

### Implementation

- `actions.ts` creates/selects chats, sends/stops/retries/clears, edits/forks
  turns, promotes outcomes to board tasks, resolves inline approvals, changes
  Ask/Auto mode, and returns available skills.
- `chat-runtime.ts` owns private API histories, busy state, abort controllers,
  and pending approval promises.
- `runner.ts` resolves provider credentials, reconstructs history, attaches MCP
  and skills, handles slash invocation and attachments, streams visible logs,
  compacts long context, reflects durable-agent conversations, and auto-titles
  a first conversation.
- `agent.ts` defines built-in/MCP tools, system prompt, tool execution, and the
  24-round streaming loop.
- `durable-brain.ts` loads, searches, serializes, bounds, reflects, and optionally
  Git-versions each durable agent's transparent file brain.
- `agent-templates.ts`, `HireAgentDialog.tsx`, and `DurableAgentDialog.tsx` own
  role scaffolds, defensive `AGENT.json` sharing, registry install review,
  profiles, stats, and loops. `agent-market.ts` loads portable profiles from the
  configured addon registries.
- `log.ts` appends bounded visible transcript entries and updates streaming
  messages.
- `turns.ts` manages structured replay/rewind records and builds bounded
  extractive context for older turns.
- `search-indexer.ts` subscribes only to transcript-reference changes and
  debounces Tantivy reindexing.
- `ChatView.tsx` provides durable-agent grouping, chat selection, pin/tag
  organization, recoverable archive management, and full-text search.
- `AgentHome.tsx` renders an agent-maintained markdown dashboard, sandboxed mini
  apps, active-workspace conversation history, and the agent's schedules.
- `ChatPane.tsx` renders messages, attachments, files panel, tool traces,
  approval bubbles, slash menu, retry/copy/export, and stop/send controls.

### Tools

Built-ins cover directory/file navigation, multi-file reads, glob/grep, file
creation/edit/move/copy/delete, shell and AppleScript execution, web search,
page fetch, raw HTTP, board/schedule operations, skill save/load, and connected
MCP tools.

Ask mode permits read-only tools and requires inline approval for mutations,
process execution, raw HTTP, and MCP calls. Approvals can be one-shot or
remembered for the exact action in that chat. Write/edit paths are checked
lexically in the frontend and canonically against the chat root by Rust. Tool
arguments marked incomplete by the streaming parser are refused.

### Attachments and history

Text and extracted office/PDF content enter the user prompt; images become
base64 vision blocks. Original paths are included so tools can access the file.
Visible logs are persisted, while private provider history is memory-only and
reconstructed from user/assistant messages after restart. Thinking and tool
traces are excluded from reconstructed history. A compacted conversation
persists its summary and cutoff, then reconstructs from that summary plus only
newer visible messages.

## Schedule domain

### Purpose

Own cron expressions, templates, one-time scheduling, and execution across all
workspaces.

### Implementation

- `cron.ts` validates and matches bounded five-field cron expressions and
  produces human-readable labels.
- `due.ts` purely selects schedules/tasks due at a given clock value.
- `template-command.ts` creates shell-quoted Claude/Codex commands for mode,
  model, prompt, system prompt, approval, and extra arguments.
- `actions.ts` manages template and schedule records.
- `runtime.ts` owns the 15-second clock, boot gate, minute deduplication,
  one-time disarming, task creation, task starts, raw session launch, hooks,
  durable-agent prompting, activity, and notification.
- `Schedules.tsx` and `TemplatesView.tsx` provide management UI.

### Tests

Cron parsing, due selection, active/background execution, boot gating, and
runtime disposal are tested with fake state and clock ports.

## Addon domain

### Purpose

Load third-party packages that can contribute views, Master tools, lifecycle
hooks, and scoped LLM agents without giving package JavaScript ambient main
webview authority.

### Implementation

- `core/addons.ts` owns the package contract, permissions, API whitelist,
  snapshot projection, YAML subset parser, package validation/export, tool
  definitions, and handler/hook dispatch.
- `addon-api.ts` implements the raw API for sessions, tasks, templates,
  schedules, UI, agent wake, and namespaced storage.
- `sandbox.ts` runs handler/hook JavaScript in a hidden opaque-origin iframe.
- `agent-runtime.ts` owns addon-agent histories, busy state, and cancellation.
- `addon-agent.ts` defines the addon's permission-scoped mini-Master loop.
- `runtime.ts` owns package installation and customization chat/editor state.
- `addon-editor.ts` edits a package only through validated full-package
  replacement.
- `addon-gen.ts` generates and retries validation of new packages.
- `actions.ts` covers install/export/remove, grants, RPC, registry URLs, and AI
  generation.
- `AddonView.tsx` hosts sandboxed previews, source view, and customization chat.
- `AddonsView.tsx` provides installed/registry lists and generation UI.

### Isolation

View and handler iframes omit `allow-same-origin`, so their origin is opaque.
Their CSP denies network access. The host verifies message source and method,
passes only the bounded addon snapshot, enforces grants on every API method,
caps API results at 256 KiB, and resets a handler frame after a 10-second
timeout.

Fresh packages auto-grant only non-dangerous requested scopes. Machine-acting
and LLM-steering scopes require explicit user grants.

## Settings and integrations domain

### Purpose

Manage provider settings, agent types, Master controls, appearance, MCP
servers, skill/persona/registry records, addon registries, and Claude plugin
marketplaces.

### Implementation

- `actions.ts` owns settings/entity mutations, live MCP connect/disconnect,
  registry refresh, and Master tool catalog permissions.
- `integrations.ts` owns live MCP session and skill-catalog caches.
- `mcp-market.ts` defines curated servers and imports config from Claude,
  Cursor, Codex, Windsurf, `.mcpb`, and `.dxt` sources.
- `plugin-market.ts` parses GitHub plugin marketplaces and resolves plugin
  sources.
- `SettingsView.tsx` composes settings tabs; `ToolsView.tsx` renders Master tool
  policy; `MachinesSection.tsx` manages the saved remote machines
  (`settings.machines`: label, user/host/port, identity-file path, default dir,
  extra ssh options) with a per-machine SSH **Test connection** action.

### MCP behavior

The shared MCP client supports streamable HTTP and local stdio. It performs
initialize, initialized notification, tools/list, and tools/call. HTTP handles
plain JSON or SSE-framed responses and session ids. Rust owns stdio child
processes; requests serialize per server.

## Workspace domain

### Purpose

Provide isolated product slices while allowing background sessions and
schedules to continue.

### Implementation

`state.ts` contains pure snapshot/apply/switch transitions. `actions.ts`
switches, creates, renames, archives/restores, and permanently deletes archived
workspaces. It also moves sessions between workspaces, assigns workspace accent
colors, opens a workspace in a satellite window, and reclaims or merges
detached workspace state when that window closes. Switching replays queued
Master notes after loading the target slice. Deletion cancels Master, kills and
disposes owned sessions, removes their persisted files, and removes the
workspace data.

Tests cover pure swapping, queued state, and effectful cleanup through fake
session ports.

## Shell domain

### Purpose

Own global navigation and overlays rather than feature data.

### Implementation

- `actions.ts` handles view navigation, palette, notifications, inspector,
  drawer, new-session dialog, and needs-attention navigation.
- `TitleBar.tsx` hosts workspace and appearance controls.
- `IconRail.tsx` selects top-level built-in/addon views.
- `Overview.tsx` is the fleet ops console (stat tiles, Master routing rail,
  watched-task and chat cards); `Timeline.tsx` and `UsageSummary.tsx` present
  aggregate state.
- `Drawer.tsx` hosts agent detail and live git diff review.
- `SlideOver.tsx` hosts memory/tool configuration.
- `CommandPalette.tsx` offers keyboard navigation/actions.
- `Toast.tsx` renders transient feedback.

Global keyboard/error/appearance listeners live in the application layer because
they are process-wide effects, not shell state transitions.

## Remote domain

### Purpose

Drive the mobile companion: publish fleet snapshots to the Rust axum server,
apply commands paired phones queue, and gate pairing behind explicit desktop
approval — without granting the remote any capability the desktop UI lacks.

### Implementation

- `snapshot.ts` is the pure builder: it distills `AppState` into the JSON the
  mobile app renders — sessions with a terminal tail (alt-screen read or log
  tail), but only the phone-focused session's terminal buffer is serialized in
  each snapshot; the raw `/api/term` stream remains available for live focus.
  It also includes the full non-archived board with watcher chats, chat conversations
  (thinking excluded), and approvals from both pending Master tool approvals
  and ask-mode chat approvals. Message counts, screen lines, and text lengths
  are capped so snapshots stay small.
- `snapshot.ts` also publishes the active-workspace **Master conversation**
  (`s.messages`, structured route/escalation/build payloads flattened to text)
  plus its busy/brain state, so the phone's Master tab stays in step with the
  desktop sidebar both ways.
- `RemoteCompanion.tsx` is a headless component mounted in the shell. While
  `settings.remoteEnabled` is on it starts the server (storing
  `{ url, token, urls }` in transient `remoteInfo`), re-hydrates the paired
  device set from `settings.remoteDevices` (so Settings revokes propagate),
  publishes a debounced snapshot on every store change, drains the command
  queue (master/chat send, task chat/start, session input/stop/resume, a
  `session_key` that writes a mapped byte sequence straight to the PTY, prompt
  answer/approve/deny, and approvals) through the normal conductor actions, and
  turns pairing requests into `confirmAction` dialogs — approval mints the device
  token and persists it in settings.
- `src/mobile/` is the phone app itself: a second Vite build target
  (`vite.mobile.config.ts` + vite-plugin-singlefile, `npm run build:mobile`)
  that emits one self-contained HTML file embedded by the Rust server, styled
  in the Conductor Mobile design language (Space Grotesk headers, tinted
  avatar cards with pulsing status pills, inbox-style approvals, assistant
  chat, pill composer). `api.ts` keeps all fetches relative
  (Cloudflare-Tunnel/proxy friendly), persists the device id/token in
  localStorage, and exposes the rpc round trip; `MobileApp.tsx` owns the
  **Master** default tab (orchestrator chat) alongside Tasks/Chat/Agents/Inbox,
  history-backed navigation (native back closes details), Agents filter
  chips, chat search, and file attachments (a slide-in files sheet whose
  preview offers "Add to chat"); a document-locked shell keeps the header and
  bottom tab bar fixed while only the body scrolls; `TerminalView.tsx` renders
  live SSE bytes in its own xterm with manual touch scrolling and bottom-stick
  auto-follow, and a ⌨ keys popover (Esc/Tab/Shift+Tab/arrows/Enter) at the
  left of the composer; `FilesGit.tsx` browses files and reviews git diffs over
  the rpc bridge.
- Terminal focus is exclusive: the device viewing a terminal claims it
  (`session_focus` with its fitted rows/cols → `remoteResize` sizes the real
  PTY and the desktop xterm alike), and leaving — or any desktop pane
  interaction — steals it back (`session_blur` / `fitTerminal`).

### Tests

Tests cover the snapshot builder (session/chat split, screens, task chats,
approval kinds, payload caps) and the mobile api layer (relative URLs, token
parsing, device identity persistence).

## Persistence infrastructure

### Purpose

Own storage schema, backward-compatible hydration, change detection, keychain
mirroring, debounced writes, and close flushing.

### Implementation

- `schema.ts` projects main and per-session partitions and stamps schema v1.
- `loaders.ts` loads main/backup and new/legacy session layouts.
- `hydrate.ts` defensively normalizes legacy records, layouts, usage counters,
  addons, and interrupted chats.
- `hydrate-effect.ts` sequences load, apply, terminal restore, keychain resolve
  (main window only),
  readiness, and integration startup.
- `subscribe.ts` identifies changes relevant to main, session, secret, and chat
  search writers.
- `runtime.ts` owns subscription/timer lifecycle, save errors, immediate
  structural session writes, keychain readiness, Tauri close flush, and browser
  fallback.

Persistence tests cover schema projection, watched slices, hydration migration,
debounce, close flush, and cleanup.

## Frontend test architecture

Tests are colocated with domains. Pure functions use direct fixtures; effectful
runtimes use fake `StatePort`, `ClockPort`, process ports, frames, and abort
signals. The current suite includes 102 files and 623 test cases in this
snapshot. UI behavior is covered selectively with jsdom and Testing Library;
most coverage focuses on domain and runtime invariants.

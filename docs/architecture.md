# YAAM system architecture

## Scope and status

This document describes the implementation on 2026-07-05. YAAM is a Tauri 2
desktop application that coordinates live coding-agent CLI processes, in-app
LLM chat agents, task watchers, schedules, MCP servers, and installable addons.

The former monolithic React provider has been replaced by a plain application
runtime. `store.tsx` is now lifecycle glue: it constructs the runtime once,
starts and disposes it, and exposes a stable action surface to React.

## System overview

YAAM has two cooperating processes:

1. The webview frontend owns product state, UI rendering, orchestration logic,
   LLM protocol adapters, and domain runtimes.
2. The Rust host owns privileged OS capabilities: PTYs and child processes,
   filesystem and git operations, state files, the OS keychain, stdio MCP
   processes, chat search, AWS Bedrock invocation, and the phone-remote LAN
   server.

External systems include agent CLIs, LLM provider APIs, HTTP or stdio MCP
servers, addon registries, skill/plugin registries, the local filesystem, and
the OS credential store.

```mermaid
flowchart LR
  U[User] --> UI[React UI]
  UI --> AR[AppRuntime]
  AR --> Z[Zustand AppState]
  AR --> LLM[LLM client and agent loops]
  AR --> IPC[Typed native.ts adapters]
  IPC --> R[Rust/Tauri host]
  R --> PTY[Agent CLIs and shells]
  R --> FS[Filesystem, git, state files]
  R --> KC[OS keychain]
  R --> MCP[MCP child processes]
  R --> BR[AWS Bedrock]
  R --> RM[Mobile companion server]
  LLM --> API[Anthropic/OpenAI-compatible APIs]
  AR --> HTTP[HTTP MCP and registries]
```

## Repository architecture

```text
app/src/
  app/                    application composition and runtime wiring
    conductor-runtime.ts  createAppRuntime(), lifecycle, shared kernel
    conductor-actions.ts  composes domain action factories
    runtime/               session, addon, chat/boot, master subsystems
    commands/              actor-aware command registry and migrated use cases
  core/                   shared types, store, ports, native bridge, terminals,
                          addon contract, MCP client, skills, static data
  domains/                feature ownership: UI + actions + runtime/domain logic
  infrastructure/
    persistence/          schema, hydration, subscriptions, save runtime
  llm/client.ts           providers, credentials, protocols, SSE streaming
  shared/                 small domain-neutral helpers
  store.tsx               32-line React lifecycle/action provider

app/src-tauri/src/
  lib.rs                  Tauri composition root and command registration
  setup.rs, util.rs       platform setup and shared path helper
  domains/                Rust state + logic + commands + tests by capability
```

Detailed ownership is documented in [Frontend domains](frontend-domains.md) and
[Backend domains](backend-domains.md).

## Frontend runtime composition

`createAppRuntime()` builds a non-React object with `actions`, `start()`, and
`dispose()`. It owns the Zustand mirror, tracked timers, transient toast timer,
activity service, declaration-cycle refs, and four subsystem factories.

```mermaid
flowchart TD
  P[ConductorProvider] -->|construct once| A[createAppRuntime]
  A --> K[Kernel: stateRef, timers, feedback, activity]
  A --> RR[Typed runtime refs]
  K --> S[Session and board runtime]
  K --> AD[Addon subsystem]
  K --> C[Chat and boot subsystem]
  K --> M[Master and scheduler subsystem]
  RR <--> S
  RR <--> AD
  RR <--> C
  RR <--> M
  S --> AC[Action composition]
  AD --> AC
  C --> AC
  M --> AC
  AC --> CTX[Stable ActionsCtx]
```

The four subsystems are grouped around real runtime cycles:

- Session/board: attention, terminal settle detection, monitors, task watchers,
  launch, task execution, and exit coordination.
- Addon: permission-scoped API, sandboxed handlers/hooks, addon agents,
  customization editor, and package installation.
- Chat/boot: chat histories and cancellation, MCP and skill caches, persistence,
  hydration, terminal reattachment, search indexing, and session teardown.
- Master/scheduler: Master queue and tool loop, proactive event routing, cron
  and scheduled-task execution.

The runtime uses typed mutable cells only for genuine construction cycles, such
as settle events calling monitors while monitors can call Master. Domain state
is not stored in React refs merely for rendering.

`createAppRuntime` also constructs the actor-aware command registry and default
capability policy. Migration is incremental: UI and addon `send_to_session`
calls are registered and active in this snapshot. Addon calls carry the addon
id into policy evaluation and the audit ring. Master, watcher, chat, and other
use cases still largely use their existing domain adapters and policy gates.

## React composition

`App.tsx` renders a persistent shell—title bar, icon rail, Master sidebar,
active main view, overlays, drawer, command palette, and toast. Components read
narrow state slices through `useConductorSelector`; actions come from the stable
`ActionsCtx` through `useActions`.

The Zustand store contains data only. Domain action factories and runtimes live
outside the store. This separation prevents terminal bytes or chat deltas from
rerendering the provider and makes runtime logic testable without React.

## State model

`AppState` is the frontend source of truth. Major categories are:

- Global configuration: settings, provider and agent types, templates, MCP
  servers, skills, personas, registries, addons, and Master tool policy.
- Sessions: one global `agents` array containing real PTY sessions and in-app
  chat sessions, distinguished by `kind` and tagged with `workspaceId`.
- Active workspace data: groups/layout, Master messages, tasks, schedules,
  activity events, notifications, and minimized sessions.
- Inactive workspace data: the same scoped fields stored under
  `workspaceData[workspaceId]`.
- UI state: current view, panels, drawers, palette, composer, toast, and active
  addon/chat.
- Transient boot state: `bootStatus`, never persisted.

Workspace switching atomically stashes the active flat slice and loads the
target slice. Sessions remain global so background PTYs stay alive.

Runtime-only data is deliberately outside `AppState`:

- xterm instances and decoders;
- LLM API histories, busy sets, queues, and abort controllers;
- live MCP sessions and fetched skill catalogs;
- task-to-session fast bindings;
- keychain-ready secret identifiers and persistence timers.

## Boot and persistence flow

```mermaid
sequenceDiagram
  participant UI as AppRuntime
  participant PR as PersistenceRuntime
  participant Rust as Rust state domain
  participant Store as Zustand
  participant PTY as Session runtime
  participant Int as MCP/skills

  UI->>PR: start subscriptions (writes gated)
  UI->>Rust: load main + session files
  Rust-->>UI: JSON snapshots / backup recovery
  UI->>Store: apply defensive hydration
  UI->>PTY: rebuild terminals and query live PTYs
  UI->>Rust: resolve redacted secrets from keychain
  UI->>PR: markReady()
  UI->>Store: bootStatus = ready
  UI->>Int: connect enabled MCP and skill registries
```

Persistence is split into a low-churn main file and one file per session:

```text
<Tauri app-data>/conductor-state.json
<Tauri app-data>/conductor-state.json.bak
<Tauri app-data>/sessions/<session-id>.json
<Tauri app-data>/sessions/<session-id>.json.bak
```

Frontend subscriptions debounce main and per-session writes independently.
Session additions/removals are written immediately. Rust writes through a
unique temporary file, `fsync`, backup rotation, and rename; Unix files are
created with mode `0600`.

Tauri vetoes an OS close and emits `close-requested`. The frontend awaits a
bounded persistence flush, then destroys the window. Browser preview uses
localStorage and a best-effort `beforeunload` flush.

## Terminal session data flow

```mermaid
sequenceDiagram
  participant Caller as UI/Master/Board/Scheduler
  participant SR as Session runtime
  participant Rust as Rust SessionManager
  participant CLI as CLI process in PTY
  participant XT as xterm registry
  participant Mon as Monitor/Watcher

  Caller->>SR: launchSession(command, cwd, options)
  SR->>SR: build launch plan and optimistic Agent
  SR->>Rust: spawn_session
  Rust->>CLI: portable-pty spawn
  CLI-->>Rust: raw PTY bytes
  Rust-->>XT: session-data event (base64 payload)
  XT->>XT: render bytes and decode complete plain lines
  XT->>SR: line + raw activity callbacks
  SR->>SR: update bounded log/usage; reset settle timer
  SR->>Mon: stable screen after quiet period
  Mon-->>Caller: status, attention, prompt, or Master digest
```

The xterm registry is module-level so terminals survive pane remounts. Live PTY
scrollback is never replayed into the process; reattached TUIs are repainted with
a two-step resize. Text and Enter are written separately because interactive
agent TUIs can interpret a combined write as a paste.

Rust uses a generation number per session id so an old exit-reaper cannot remove
or emit an exit for a newly resumed process. Reusing a live id kills the old
child before replacing its handle. On Unix, stop/replacement first sends SIGTERM
to the child and process group, then forces SIGKILL after a two-second grace
period so CLIs can flush resume data.

## Detachable sessions

A session started in detached mode splits into two processes so it outlives
the app. A **host process** (the same binary re-invoked with `--yaam-host`,
daemonized via `setsid` into its own session/process group) owns the PTY and
the child command, keeps a 200 KB output ring, and serves one client at a
time on `~/.yaam/detached/<id>.sock` (frames in: DATA · RESIZE · KILL; raw
PTY bytes out, ring replayed on connect). The app runs a tiny **attach
client** (`--yaam-attach`) inside a completely ordinary app PTY session —
stdin becomes data frames, SIGWINCH becomes resize frames, socket bytes go to
stdout — so xterm, remote-companion taps, monitors, resize, and exit events
all operate unchanged on the attach client while lifecycle authority lives
one process further out (the tmux model, per session).

```mermaid
flowchart LR
  subgraph App[YAAM app process]
    XT[xterm / monitors] --- SM[SessionManager PTY]
    SM --- AC[attach client\n--yaam-attach]
  end
  AC -- unix socket --> H
  subgraph H[detached host — setsid]
    RING[200KB ring] --- PTY2[PTY owner]
    PTY2 --- CMD[/bin/sh -lc cmd/]
  end
```

Quitting the app only kills the attach client (= detach). Reconnect is just
resume: the agent's `cmd` IS the attach command, so ▶ after a restart
reattaches with backlog. Stop is detached-aware (`detached_kill` SIGTERMs the
host's process group — the real end); when the command exits by itself the
host cleans up socket/spec and the attach client's EOF fires the normal
session-exit flow. `detached_list` probes sockets for liveness and prunes
stale leftovers.

## Multi-window workspace satellites

A workspace can be **spun out into its own OS window** (switcher → the ⧉ split
button). The satellite is the detachable-session idea applied to a whole
workspace: one Tauri backend process is shared by every window, so PTYs,
managed state, and `invoke` commands are global — the hard part is not creating
the window (a few lines of `WebviewWindow`) but keeping **one owner of durable
state** so two webviews never clobber the single `conductor-state.json`.

The window's **role** is read from its URL on boot (`core/window-role.ts`):
`index.html` is the `main` window; `index.html?win=ws&ws=<id>` is a `workspace`
satellite pinned to one workspace. `store.tsx` passes the role into
`createAppRuntime`, which gates the runtime:

- **Main** runs everything: persistence (the sole writer), Master + scheduler,
  addon hooks, integrations, plus a listener for the satellite protocol.
- **A satellite** hydrates from disk and runs session I/O (terminals render live
  off the global `session-data` broadcast) and its own workspace's watchers, but
  **does not start** persistence, Master/scheduler, addon hooks, or integrations
  (`chat.ts` gates these on `role.kind === 'main'`; `conductor-runtime.ts` skips
  `master.start()`/`addon.start()`). It pins its active workspace once
  `bootStatus === 'ready'`, then debounce-forwards its workspace slice
  (`scopedFromState`) plus that workspace's sessions to main via a `ws:sync`
  event. Main merges the slice into the background `workspaceData[id]` and
  persists it — so a satellite's edits round-trip to disk through the single
  writer, never a second one.

```mermaid
flowchart LR
  subgraph Main[main window — owns state]
    PS[persistence writer] --- WD[workspaceData store]
    MS[Master / scheduler / addons]
  end
  subgraph Sat[workspace satellite ws-<id>]
    UI[renders + drives workspace X] --- SR[session I/O + watchers]
  end
  Sat -- "ws:sync (slice + X's agents)" --> Main
  Sat -- "ws:reattach on close" --> Main
  Main -- "shared backend: PTYs, invoke, session-data broadcast" --- Sat
```

**Exclusivity + restore.** A spun-out workspace is added to the runtime-only
`detachedWorkspaces` set (never persisted, so a restart comes back fully
reattached) and **hidden from the main switcher**; if it was active, main
switches away first, guaranteeing one window per workspace. Closing the
satellite emits `ws:reattach` with its final slice — main merges it, clears the
detached flag, and the workspace reappears in the switcher.

**Why no double autonomous actions.** The task watcher/monitor act on the
*active* workspace's flat `tasks`; main is showing a different workspace than
the satellite, so their autonomous work does not overlap. (Residual: main still
does minor per-session monitor work for a detached workspace's sessions since
`session-*` events broadcast to all windows — harmless, gate by `workspaceId` if
it ever matters.) Capabilities: `capabilities/default.json` allows
`create-webview-window`, `emit`/`emit-to`/`listen`, and the `ws-*` window label.

## Remote machines

A session bound to a saved machine (`settings.machines`, keys/ssh-agent auth)
runs its command mode as an `ssh` client, so the PTY is local while the agent
runs on the host. By default it behaves like a local session (`ssh -tt … sh -c
<cmd>` — dies with the connection, resume restarts it). Checking **Detached**
opts into the "lifecycle one process further out" model on the remote:
`ssh -tt … tmux new-session -A -s <id> …`, so a disconnect or app restart just
re-runs the wrap to reattach and stop kills the tmux session over SSH. No backend
changes — the connection is snapshotted onto the session so a later machine
edit/removal can't strand it, and remote Files/Git run `ls`/`cat`/`git` through
`exec_command` over the shared SSH `ControlMaster` connection.

## Settle, prompt, monitor, and watcher flow

Raw PTY activity resets a three-second quiet timer. On settle, YAAM examines the
rendered alternate screen for TUIs or new plain-output lines otherwise. It
detects prompt/dialog patterns, extracts numbered options, and deduplicates
repeat detections.

An armed response watch compares the stable output with the screen snapshot at
send time. If content changed and the session is not actively viewed, it marks
attention and notifies. A four-second TUI scan is an additional safety net for
full-screen approval dialogs.

Per-session monitor LLMs keep capped private histories. They can update status,
flag input, and send a short digest to Master. Task-bound sessions are instead
owned by per-task watchers, which may inspect output, update the card, ask the
user, send input, or spawn up to three workers.

## Master orchestration flow

Master receives the current structured state and user/queued event history. Its
tool loop is capped at ten rounds. Each tool call is executed through a
`MasterExec` adapter over session, board, schedule, addon, and state operations.

Two policy layers apply:

- Global tool catalog: Auto, Ask first, Approval, or Off.
- Per-session tool settings for session-specific actions.

Ask-first approval is a one-shot token consumed by the retry. The integrity
check retries a final answer that claims an action without any action tool call.
Proactive events for inactive workspaces are queued and summarized after the
user switches to that workspace.

## In-app chat flow

Chat sessions do not use PTYs. A provider-neutral streaming LLM loop combines:

- local file/navigation/edit/exec tools;
- web and raw HTTP tools;
- board, schedule, and skill tools;
- tools discovered from enabled MCP sessions;
- local and registry skills;
- an optional persona and attachments.

The loop supports 24 tool rounds, streams answer and thinking channels
separately, refuses truncated tool arguments, and caps private history. Chat
runtime state is keyed by chat id and cancellable through `AbortRegistry`.
The default Ask mode runs read-only tools automatically and pauses mutations,
process execution, raw HTTP, and MCP calls for inline approval. Users can allow
once or remember the exact tool+preview for that chat; Auto bypasses prompts.
Replies containing substantial HTML or SVG surface an artifact chip that opens
the content in a sandboxed, network-denied side panel (the same iframe
hardening the addon sandbox uses).

Visible transcripts are persisted. Tool and thinking messages are excluded
when reconstructing provider history after restart. Chat transcript changes
debounce a full rebuild of the in-memory Tantivy search index.

New turns also persist a structured work record: original text and attachment
descriptors, model, tool inputs/results, status, provider token usage, and any
board-task handoff. Turns older than the recent provider window feed a bounded
extractive context summary, preserving continuity without another LLM call.
Provider-reported input/output usage accumulates on the turn and session. Each
chat has a token ceiling (200k by default, zero for unlimited); a turn is refused
before its API call when the ceiling has already been reached.

At a configurable provider-input threshold, or on `/compact`, the chat runtime
uses an LLM to replace private provider history with a structured summary. The
agent record persists both that summary and a visible-message cutoff. After a
restart, provider history is rebuilt from the summary plus only messages newer
than the cutoff; transcript display remains unchanged. Compaction and normal
turns share the per-chat busy lock so neither can rewrite history concurrently.

Durable agents add a global persistent identity above workspace-scoped chat
sessions. Each profile owns a charter, provider/model defaults, optional home
folder, scheduled prompts, a markdown home dashboard, and up to 12 self-built
HTML mini apps. The home page shows only conversations from the active workspace
even though the identity/dashboard/apps are global.
The home folder is a transparent file brain: `LESSONS.md`, `JOURNAL.md`, and
user/agent-maintained files under `knowledge/`. Conversations load bounded tails
of the brain into the system prompt, expose ranked home-folder search, and can
distill completed work into serialized, size-bounded brain appends. Git-backed
brains auto-commit only the brain paths. `AGENT.json` exports/imports the profile,
validated loops, dashboard, and size-bounded mini apps. Mini apps execute only
when opened, inside an opaque-origin, network-denied iframe. Registry profiles
receive a capability review before installation because imported loops are
enabled immediately and spend tokens when they fire. Built-in role templates
scaffold casual and professional agents without changing the underlying runtime;
legacy Personas migrate into durable profiles during hydration.

## Board and schedule flow

Board tasks carry a specification, acceptance criteria, column, optional
template/agent/cwd, schedule time, task chat, watcher state, and attached session
ids. Starting a task prefers its watcher when an LLM is configured; the watcher
calls the canonical task-session launch path. A deterministic direct launch is
the fallback.

All task launches—active or background workspace—use the same one-shot path.
The scheduler ticks every 15 seconds after boot and handles:

- recurring five-field cron entries;
- one-time timestamps;
- schedules that add board tasks;
- template schedules that queue immediate board tasks;
- raw command schedules;
- durable-agent prompts that create a chat conversation;
- board tasks with `scheduleAt`.

One-time entries are disarmed and recurring entries deduplicate by minute.

Watcher replies stream into the task chat while they are generated: the
watcher's tool loop runs over the streaming transport, throttled deltas land
in a transient `taskStreams` store map, and the task drawer renders a live
bubble until the turn settles and the final message is posted.

Deleting a task archives it (recoverable); permanent deletion exists only in
the board's Archived viewer, and all destructive actions confirm first.

## Worktree isolation and review flow

Sessions and tasks can opt into git-worktree isolation at launch. The Rust
worktree domain mirrors the working folder — one repo, or a folder of repos —
under `~/.yaam/worktrees/<slug>` (branch `yaam/<slug>` per repo, loose entries
symlinked), and the session runs in the mirror's `workdir`. The agent record
carries `{ root, base, workdir }`; a task's follow-up sessions re-enter the
same mirror so work-in-progress survives relaunches.

Review closes the loop: worktree diffs (against each repo's fork ref, new
files included) render in the review surfaces — the board's ReviewPanel, the
agents → Review drawer, and the shared `GitWorkbench` (staging, per-side
diffs, commits with AI-draftable messages, multi-repo picker). Approve stages
and commits outstanding work, `--no-ff` merges each repo back into the
original checkout (conflicts abort per repo and are reported instead of
leaving the source mid-merge), removes the mirror, and completes the
task/session; request-changes routes reviewer feedback to the watcher (tasks)
or straight into the PTY (sessions).

When the reviewed folder contains no git repository at all, the workbench does
not dead-end: it falls back to a standalone folder explorer — the same tree +
rich file viewer (code, markdown, images, PDF, office) the terminal/chat file
pane uses — while keeping the host-supplied review actions.

## Mobile companion flow

An opt-in companion (Settings → Remote Control) serves a full mobile web app for
tasks, chats, and sessions. The Rust `remote` domain runs an **axum** server
(default port 8712) that embeds the single-file mobile bundle
(`npm run build:mobile` → Vite + `vite-plugin-singlefile` →
`remote-app.html`, `include_str!`-ed into the binary) plus a JSON API.

Access needs two secrets: the per-start URL token (possession of the connect
link) AND a per-device token minted only by an explicit pairing approval on
the desktop. Paired devices persist in `settings.remoteDevices` (revocable in
Settings) and are re-hydrated into the server on every start; the phone keeps
its token in localStorage.

```mermaid
sequenceDiagram
  participant Phone as Mobile app
  participant Rust as axum remote server
  participant RC as RemoteCompanion (frontend)
  participant Act as Conductor actions

  Phone->>Rust: POST /api/pair/request?t {device_id, name}
  RC->>Rust: remote_pending_pairs (poll)
  RC->>RC: confirmAction dialog — explicit approval
  RC->>Rust: remote_approve_pair → device token (persisted in settings)
  Phone->>Rust: GET /api/pair/status?t&device → token (stored locally)
  Phone->>Rust: GET /api/state?t&d (poll)
  Rust-->>Phone: sessions+screens, tasks+chats, chats, approvals
  Phone->>Rust: POST /api/command?t&d {kind, id, text, ok}
  RC->>Rust: remote_take_commands (poll)
  RC->>Act: sendChatMessage / sendTaskChat / startTask / sendInput / stop / resume / approvals
```

The server never executes anything and holds no credentials — it stores the
latest published snapshot string, a command queue, and an rpc response store.
The desktop `RemoteCompanion` builds capped snapshots from `AppState` (scoped
to the active workspace) and applies drained commands through the same
conductor actions the desktop buttons use, so a paired phone can never do
anything the UI cannot.

**Sync model.** Terminals sync at the Rust layer: the session domain's PTY
reader tees raw bytes into a per-session bounded ring + broadcast tap, and
`GET /api/term` streams backlog-then-live bytes over SSE into the companion's
own xterm.js — every device's terminal stays live without a desktop-webview
round trip (the serialized xterm buffer in the snapshot is the fallback).
Terminal focus is exclusive: the viewing device claims the PTY size
(`session_focus` → `remoteResize` resizes the real PTY and the desktop xterm
together, clamped), so TUIs reflow natively for whichever screen is watching;
leaving or any desktop pane interaction steals the size back.
Chats and the board stay frontend-authoritative but stream: `remote_publish`
bumps a watch channel and `GET /api/stream` pushes the snapshot to every
paired device the moment it changes (chat deltas land in the store per
animation frame; the publish debounce is 300ms). File and git browsing rides
a request/response bridge — the phone queues `rpc_*` commands, the desktop
answers via its native adapters (path-scoped to session working folders)
through `remote_respond`, and the phone polls `/api/rpc` for the consumed-on-
read answer.

The URL token persists in settings so connect links survive restarts, with
optional auto-rotation after a user-chosen number of hours; paired-device
tokens are independent, so a rotated link never unpairs a device (the phone
double-checks before ever dropping its pairing).

Network reach: connect URLs are enumerated per interface and classified (LAN,
Tailscale CGNAT, WireGuard, VPN), and the mobile app uses relative API paths
only, so it works unchanged behind a Cloudflare Tunnel or any HTTPS reverse
proxy; Settings offers a public-URL override for tunnel hostnames.

## Addon flow

Addon packages can contribute a view, Master tools, lifecycle hooks, and a
permission-scoped addon agent. Package parsing normalizes JSON or the folder
manifest format and validates the declared surface.

Views run in opaque-origin `sandbox="allow-scripts"` iframes with a restrictive
CSP and postMessage RPC. Tool and hook JavaScript runs in a separate hidden
opaque-origin iframe, not in the privileged main webview. Host RPC validates the
method whitelist, applies the permission-wrapped `AddonApi`, caps returned data,
and terminates timed-out handlers.

See [Addon architecture](addons.md) and [Security model](security.md).

## LLM provider layer

`llm/client.ts` normalizes two wire protocols:

- Anthropic Messages, including Bedrock-compatible bodies.
- OpenAI-compatible chat completions.

Declared providers are Anthropic, OpenAI, DeepSeek, Kimi, Gemini's OpenAI
compatibility endpoint, GLM, AWS Bedrock, and custom OpenAI-/Anthropic-compatible
endpoints. Streaming parsers normalize text, thinking, tool calls, stop reason,
and truncated argument state.

Credentials may come from a static key, an expiring credential command, or the
AWS credential chain. Bedrock calls are delegated to Rust for AWS SDK signing
and refresh.

## Technology stack

| Area | Implementation |
| --- | --- |
| Desktop shell | Tauri 2.11, native dialogs, HTTP and log plugins |
| Frontend | React 19, TypeScript 6, Vite 8 |
| State | Zustand 5 plus `useSyncExternalStore` selector hooks |
| Terminal | xterm.js 6, FitAddon, Rust `portable-pty` 0.9 |
| Backend | Rust 2021, minimum Rust 1.77.2 |
| LLM | Anthropic Messages, OpenAI-compatible APIs, AWS Bedrock SDK |
| Search | Tantivy 0.22 in-memory index |
| Secrets | `keyring` 3.6 using OS-native credential stores |
| Testing | Vitest 4, Testing Library, Rust unit tests |
| Static analysis | TypeScript compiler, oxlint, Cargo check/test |
| Styling | CSS variables and inline style objects; no CSS framework |

## Security and operating assumptions

The main webview and Rust host are trusted application code and run with the
user's OS permissions. Agent CLIs, configured commands, stdio MCP servers, and
Auto-mode chat tools can therefore perform user-level actions. YAAM provides
policy and isolation around selected entry points; it is not an OS sandbox for
the whole application.

The complete trust model, mitigations, and current limitations are in
[Security model](security.md).

## Testing topology

Frontend tests cover pure state transitions, runtime lifecycle and cancellation,
session launch/exit/prompt behavior, scheduler due logic, persistence detection
and close flushing, addon sandbox RPC, search indexing triggers, settings
imports, selectors, and action stability. Rust tests live beside each domain and
cover filesystem scope, process execution, atomic persistence, session launch
and id detection, MCP stdio, search, git parsing, Bedrock credentials, and shared
path expansion.

The verification gate is documented in [DEVELOPMENT.md](../DEVELOPMENT.md).

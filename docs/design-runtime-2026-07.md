# Current implementation design: ownership, remote control, and bounded execution

## Status and scope

This is the implementation design chapter for the July 2026 runtime. It fills
the gap between the historical HTML mockups in [`design/`](../design/) and the
code-level domain references. The source of truth remains `app/src` and
`app/src-tauri/src`; this document records the boundaries and decisions that
are easy to lose when changing either side.

## 1. Runtime ownership

YAAM has one Tauri backend and one Zustand state model, but a workspace can be
rendered by either the main window or a satellite window.

| Role | Owns | Does not own |
| --- | --- | --- |
| Main window | durable persistence, hydration with keychain resolution, Master, scheduler, addon hooks/agents, integrations, and satellite protocol | — |
| Workspace satellite | one workspace's UI, PTY/session rendering, local settle/monitor/watcher work, and `ws:sync`/`ws:reattach` messages | persistence writes, keychain resolution, Master/scheduler, addon hooks, integrations |
| Rust host | PTYs, filesystem/git, state files, keychain, MCP children, search, Bedrock, remote HTTP server | product workflow state and actor policy |

The satellite is pinned to `?win=ws&ws=<id>`. Its scoped slice and matching
agents are debounced into the main window through `ws:sync`; closing it sends a
final `ws:reattach`. `detachedWorkspaces` is runtime-only, hides the workspace
from the main switcher, and is cleared only after the final slice is merged.
There is therefore one writer of `conductor-state.json` even while terminals
and `invoke` calls remain global.

## 2. Workspace data and layout

Workspace-scoped data (messages, tasks, schedules, events, notifications, and
tab groups) is swapped between flat state and `workspaceData[id]`. Agents are
globally indexed and carry a `workspaceId`; templates and agent types are also
global. Background workspaces continue to run schedules and queue Master notes.

Workspace actions distinguish lifecycle states:

- archive/restore keeps a workspace and its sessions recoverable;
- permanent deletion is available only from the Archived viewer and disposes
  owned sessions and persisted session files;
- moving a session changes its workspace tag and tab-group ownership without
  cloning the PTY;
- opening a satellite detaches the workspace window, while reclaim/merge makes
  the main window authoritative again.

Session tab groups persist a row partition and orientation. The picker supports
one through six panes, with single, split, three-up, rows, grid, and six-up
arrangements. Legacy focused-session state migrates through the layout helpers;
each session remains in at most one group.

The Work view's Sidebar mode is a task-aware run triage rail. Each row derives
one shared status tuple—task, current action, next action—from the linked board
task, monitor/watcher state, suggestions, and durable history fallbacks. Normal
tabs and Sidebar session rows use that same tuple in a delayed hover card. The
card reads a bounded live xterm screen snapshot (or the persisted log tail when
no rendered screen exists); it never attaches or moves the registry-owned
terminal DOM, so previewing a session cannot disturb its active pane.

## 3. Terminal, files, and preview pipeline

PTY bytes are emitted by Rust, registered in the module-level xterm registry,
and attached by panes. Settle detection is driven by raw activity quieting for
about three seconds, then scans the rendered screen; alternate-screen TUIs are
not treated as plain prompts. Enter is sent as a separate keypress after text.

The Files pane uses a native recursive `watch_dir` stream and coalesced
`fs-change` events in Tauri, with polling only as a browser fallback. Native
open/reveal/VS Code actions pass through validated Rust commands. Rich HTML and
office previews are stashed behind the `yaampreview` custom scheme so preview
JavaScript and network access can be explicit per-viewer options without
loosening the privileged app CSP. The preview store is bounded and cleared on
viewer close. Terminal find, URL/path ctrl/cmd-click, and full-tab Files/Changes/
Watcher views are presentation features on this same pipeline.

## 4. Remote companion design

Remote Control is an opt-in axum server. Each request needs both the persisted
URL token and a per-device token minted by an explicit desktop pairing approval.
The server stores a capped snapshot, command queue, and RPC response store; it
never executes commands or holds provider credentials. The desktop drains the
queue through normal conductor actions.

The JSON snapshot is scoped to the active workspace and includes bounded
sessions, chats, tasks, approvals, and Master state. Only the phone-focused
session's terminal buffer is serialized in snapshots. Live terminal focus uses
`/api/term`: Rust sends a bounded ring backlog followed by raw PTY tap bytes over
SSE, and the focused device's fitted dimensions resize the real PTY. Desktop
interaction or phone blur takes focus back. Files and Git use an RPC bridge
answered by the desktop's normal, path-scoped adapters.

Satellite workspaces can be reclaimed by the phone flow: the main window closes
or reattaches the selected workspace, then the phone receives the same scoped
snapshot while the main window remains the sole durable owner.

## 5. Sandboxing and privilege boundaries

Session write sandboxing is opt-in. The launch runtime asks Rust for a
platform-specific wrapper: Seatbelt (`sandbox-exec`) on macOS or bubblewrap on
Linux/remote SSH hosts. Reads remain broad, but writes are restricted to the
session/worktree folder, temp, required PTY devices, built-in CLI state, and
explicit extra roots. A template may deny network. Root paths are canonicalized
and validated; wrapper construction fails closed. This is a write/process
containment aid, not a complete sandbox for arbitrary user-authorized shells.

Addon views, tools, and hooks are a separate boundary: opaque-origin,
network-denied iframes with a fixed RPC whitelist, permission checks, timeout,
and result cap. Chat and Master policy gates run before native calls, while Rust
still validates paths, sizes, names, and timeouts because the webview is not an
actor-authenticated security boundary.

## 6. Persistence and keychain lifecycle

Main state and per-session records use separate selectors and debounced writers.
Rust writes atomically with temporary files, fsync, rename, and backup recovery;
close is vetoed until a bounded flush completes. Hydration is defensive for old
snapshots and starts persistence only after the restored state is applied.

Secret mirroring tracks exact account/value pairs for Master, chat, GitHub,
remote URL/device, MCP, and durable-agent credentials. Unchanged keychain
records are not rewritten, removed accounts are deleted, and plaintext is
retained if a keychain write fails so a user does not silently lose credentials.
Satellites hydrate without keychain resolution. The backend caches resolved
values across webview reloads. On macOS a non-interactive ACL probe distinguishes
missing items from rebuilt binaries that need authorization; after one allowed
read, YAAM safely recreates the item under the current binary's ACL using a
temporary recovery entry. Stable release signing remains necessary to avoid the
one-time authorization after each new ad-hoc build.

## 7. Session and task activity model

Each durable `SessionRecord` and `BoardTask` carries a bounded, newest-first
activity timeline. This is not terminal scrollback and it is not the global
workspace event feed. It answers three narrower questions after the work is
over: which tasks a session handled, what evidence exists for the work, and
which decisions/actions came from the user.

An entry has an explicit actor (`user`, `session`, `monitor`, `watcher`, or
`system`), a stable event kind, a concise explanation, and snapshot links to the
session/task names and ids. Task-linked activity is written to both entity
timelines with the same event id, so a session can index its tasks while a task
can index every contributing session. IDs and timestamps are minted before the
Zustand update; reducer functions only prepend/coalesce an immutable entry.

Work evidence comes from three sources:

- monitor or watcher milestones explain the current task and approach;
- process exit records a completed/failed outcome with a bounded final digest;
- a best-effort local, worktree, or SSH Git snapshot stores structured paths,
  change kinds, and line counts, never the complete diff.

Working-tree snapshots are observations at a session milestone, not exclusive
attribution: non-isolated folders can be shared, and follow-up task sessions
reuse one cumulative worktree. The UI labels the snapshot accordingly. Direct
terminal input is reconstructed from xterm's user-only `onData` stream and is
recorded only when Enter submits it. Cursor edits, deletion, and bracketed paste
are handled best-effort; programmatic writes never enter this path. The bounded
submission is copied to the linked task timeline and immediately sent to its
watcher (or the session monitor) as user intent. Password/token prompts are
detected from the visible screen before Enter reaches the PTY, and their input
is replaced by a redacted marker. Legacy 0.6.1 history entries without
actor/link fields remain readable as user events.

Decoded terminal output follows the same causal path without persisting raw
scrollback in activity history. Plain-session lines accumulate in an in-memory
80-line/16 KiB buffer; while output continues, a bounded checkpoint is sent to
the watcher/monitor every eight seconds. Three seconds of quiet cancels the
checkpoint timer and sends a final snapshot. Alternate-screen TUIs use their
current rendered screen instead of decoded lines. Routine progress notes are
latest-wins in the watcher queue, and stable-screen keys suppress duplicate
snapshots.

The timeline is capped at 200 entries per entity. Consecutive identical status
polls coalesce; user actions and intervening milestones do not. Deleting an
entity deletes its own timeline, while snapshot names and task-side copies keep
linked history understandable after a contributing session is removed.

## 8. Design decisions and non-goals

- One persistence owner is preferred over cross-window locking; satellites sync
  their workspace slice instead of writing the file themselves.
- Remote Control is a command relay, not a second application server; all
  execution stays behind desktop actions and approvals.
- The write sandbox limits accidental writes but does not make shell commands,
  MCP binaries, or user-selected CLIs untrusted OS processes.
- Historical `design/` HTML is a visual reference, not a contract for runtime
  behavior or security policy.

When a change crosses one of these boundaries, update the matching domain doc,
the security model, and this chapter together.

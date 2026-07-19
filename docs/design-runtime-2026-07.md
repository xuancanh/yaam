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
Satellites hydrate without keychain resolution. Stable release signing remains
necessary on macOS: ad-hoc rebuilt bundles can have a new code identity and
therefore prompt for Keychain access again.

## 7. Design decisions and non-goals

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

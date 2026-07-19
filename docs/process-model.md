# YAAM process model

## Overview

YAAM is one desktop application with a privileged Rust host and one or more
frontend webviews. It is not a collection of independent worker services. The
main webview owns product orchestration and persistence; Rust owns OS-facing
capabilities; child processes run only when a user-selected feature launches
them.

```text
OS process: YAAM
├─ main Tauri webview
│  ├─ AppRuntime / Zustand / domain runtimes
│  ├─ Master, scheduler, monitors, watchers, chat loops
│  └─ persistence + addon/integration ownership
├─ optional workspace satellite webviews (same Rust host)
├─ Rust managed state
│  ├─ PTY session manager → one agent CLI/shell process tree per session
│  ├─ MCP manager → one stdio child per configured server
│  ├─ search index, Bedrock clients, keychain adapter
│  ├─ native file/git/worktree/watch/preview/sandbox adapters
│  └─ optional axum mobile server and command queue
└─ detached host processes (one per detached session, separate lifetime)
```

The webviews share the same backend process: PTYs, Tauri commands, and
`session-*` broadcasts are global. A satellite is a rendering/runtime peer, not
a second application instance with its own durable store.

## Startup and boot order

1. The binary checks for detached host/attach arguments before Tauri boots.
2. Tauri creates managed Rust state and registers command handlers/plugins.
3. The webview reads its role from the URL (`main` or `ws=<workspace>`).
4. `createAppRuntime()` builds the kernel and four plain subsystems: session/
   board, addon, chat/boot, and Master/scheduler.
5. Hydration loads main/session partitions, applies defensive migrations, and
   restores sessions to idle. Live PTYs are reattached; detached hosts are
   reconnected; dead sessions receive a relaunch marker.
6. The main role resolves keychain values, marks persistence ready, starts
   integrations, then starts Master/addon/scheduler loops. Satellites skip
   keychain resolution, persistence, integrations, Master, and scheduler.
7. Both roles may run local session settle/monitor/watcher machinery for the
   workspace they render. Satellite changes sync back to main through the
   workspace event protocol.

StrictMode-safe construction is important: timers, queues, provider histories,
abort registries, xterm instances, and live maps belong to runtime factories and
are disposed explicitly. React components render selectors; they do not own
process lifetimes.

## Session process trees

### Local interactive/command session

The Rust session manager opens a `portable-pty` pair and starts either the
selected login shell or `/bin/sh -lc <command>`. The reader emits bounded raw
chunks as Tauri events and a separate waiter emits one generation-tagged exit.
Unix stop sends SIGTERM to the process group, waits briefly, then sends SIGKILL.

### Remote-machine session

The PTY is still local to YAAM, but its command is an SSH client. Non-detached
mode runs the agent through `ssh -tt ... sh -c ...`; detached mode uses a remote
tmux session and reconnects to it after disconnect. Remote Files/Git use the
same SSH control connection through bounded `exec_command` calls.

### Detached session

The app launches a separate YAAM host binary with a private spec file and Unix
socket. That host owns the PTY and a bounded output ring after the app exits.
The normal app process later starts an attach client inside its own PTY. Stop
terminates the host process group and removes its socket/spec; stale specs are
pruned by `detached_list`.

## Other child processes and threads

- MCP stdio servers are child processes supervised by `McpManager`; requests
  serialize per server and teardown kills the process.
- Credential, git, filesystem, search, and sandbox helper commands are bounded
  one-shot subprocesses where needed; they do not become long-lived YAAM
  services.
- The remote axum server runs on a dedicated thread/current-thread Tokio runtime
  and stores only a snapshot, queues, pairing state, and capped RPC answers.
- Session PTY readers, exit waiters, watcher callbacks, and detached socket loops
  are native threads/tasks with generation/ownership checks to prevent stale
  exits from clobbering replacement sessions.

## Shutdown and reload

The Rust close handler vetoes the OS close and broadcasts `close-requested` with
the target window label. Main flushes durable state, asks satellites to close,
stops integrations and runtime loops, then destroys the window. A satellite
flushes its final workspace slice to main through `ws:reattach` and then
destroys itself. Browser builds use a best-effort `beforeunload` fallback.

A webview reload does not imply process shutdown: live PTYs remain in Rust and
are discovered via `live_sessions`; terminals repaint rather than replaying
scrollback into an alternate-screen TUI. Detached hosts and remote tmux
sessions outlive both reloads and ordinary app quits by design.

## Ownership and failure rules

- Rust owns native handles; frontend runtimes own orchestration maps and aborts.
- Main owns the only persistence writer and keychain resolver.
- A session id replacement increments a Rust generation so an old exit cannot
  remove the new process.
- A natural ephemeral exit is task completion; non-ephemeral exits are routed to
  monitors/attention handling.
- Unknown remote terminal ids fail before a tap is allocated.
- Bounded queues/rings, timeouts, output caps, and cancellation prevent a noisy
  PTY, MCP server, watcher, or remote phone from growing process memory without
  limit.

## Operational implications

The process model assumes user-authorized OS authority for CLIs, shell commands,
MCP binaries, and provider credential commands. The optional session write
sandbox wraps a whole process tree but is not a general VM. Addon code never
enters the main webview process; it runs in opaque-origin frames and uses host
RPC. See [Security model](security.md) and [Communication protocols](communication-protocol.md)
when changing a boundary.

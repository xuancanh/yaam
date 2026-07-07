# Rust backend domain implementation

## Backend role

The Rust/Tauri process is YAAM's privileged host. It does not own product
workflow state; it owns capabilities that require native access or should not be
implemented in the webview:

- live PTYs and process lifecycle;
- filesystem and git access;
- bounded one-shot command execution;
- durable files and OS credentials;
- stdio MCP child processes;
- embedded chat search;
- AWS Bedrock authentication and invocation;
- the mobile-companion server (axum).

Each module under `src-tauri/src/domains` keeps managed state, domain logic,
Tauri command handlers, and tests together.

## Composition root

`lib.rs` builds the Tauri application, installs dialog and HTTP plugins,
registers managed state, registers every command, and coordinates close
flushing.

Managed process-wide states are:

- `SessionManager` — live PTYs keyed by session id;
- `McpManager` — live stdio MCP processes keyed by server id;
- `ChatSearchState` — optional in-memory Tantivy engine;
- `BedrockState` — cached AWS clients keyed by credential configuration;
- `RemoteManager` — the optional mobile-companion axum server: URL token,
  paired devices, pending pairing requests, latest published snapshot, and
  queued commands.

On `CloseRequested`, Rust prevents the close and emits `close-requested`. The
frontend flushes state and explicitly destroys the window, avoiding an
unawaitable webview teardown write.

`setup.rs` installs the development logger and sets the macOS dock icon when
running the unbundled development binary. `util.rs` contains leading-tilde path
expansion.

## IPC command map

| Rust domain | Commands | Frontend adapter |
| --- | --- | --- |
| Session | `spawn_session`, `write_session`, `resize_session`, `kill_session`, `live_sessions`, `detect_cli_session` | `core/native.ts`, `SessionProcessPort` |
| Git | `git_diff`, `git_status`, `git_file_diff`, `git_file_diff_side`, `git_stage`, `git_unstage`, `git_commit` | `core/native.ts`, FilesPane/Drawer/GitWorkbench |
| Worktree | `worktree_create`, `worktree_diff`, `worktree_merge`, `worktree_remove` | `infrastructure/native/worktree.ts`, launch runtime + review surfaces |
| Filesystem | `list_dir`, `read_text_file`, `read_file_b64`, `write_text_file`, `run_credential_command`, `exec_command` | `core/native.ts`, chat/files/settings |
| State | `save_state`, `load_state`, `load_state_backup`, `save_partition`, `load_partition`, `save_session`, `remove_session`, `load_sessions` | persistence runtime/loaders |
| MCP | `mcp_stdio_start`, `mcp_stdio_request`, `mcp_stdio_notify`, `mcp_stdio_stop` | `core/mcp.ts` through native adapters |
| Search | `chat_search_reindex`, `chat_search` | chat search indexer/view |
| Bedrock | `bedrock_invoke` | `llm/client.ts` through native adapter |
| Secrets | `secret_set`, `secret_get`, `secret_delete` | persistence secret mirror |
| Remote | `remote_start`, `remote_stop`, `remote_publish`, `remote_take_commands`, `remote_pending_pairs`, `remote_approve_pair`, `remote_deny_pair`, `remote_set_devices`, `remote_respond` | `infrastructure/native/remote.ts`, `RemoteCompanion` |
| Detach | `detached_spawn`, `detached_list`, `detached_kill` | `infrastructure/native/detach.ts`, launch runtime + session actions |

Tauri serializes command input/output with serde. `native.ts` performs any
snake-case/camel-case conversion required by the frontend.

## Session domain (`domains/session.rs`)

### Managed state

`SessionManager` wraps a mutex-protected map of session id to:

- PTY master handle;
- PTY writer;
- child killer;
- child pid for graceful process-tree shutdown;
- generation number.

The generation prevents an exit thread from a stopped process from deleting or
reporting the handle of a newly resumed process using the same id.

### Spawn behavior

The domain opens a `portable-pty` pair with the requested/default dimensions.
There are two launch modes:

- Direct terminal mode resolves the selected shell through the login PATH and
  starts it with `-l -i`, setting `SHELL`.
- Command mode runs `/bin/sh -lc <command>` so quoting, operators, environment
  prefixes, and GUI-process PATH behavior work consistently.

Both set `TERM=xterm-256color`; an optional working directory is tilde-expanded
and must exist. Reusing an id shuts down the previous child before inserting the
replacement handle.

Remote-machine sessions need no backend change: the command the frontend hands
command mode is simply an `ssh … tmux new-session -A …` client, so the PTY is
local while the agent runs on the host inside tmux. Their remote Files/Git reuse
`exec_command` (below) to run `ls`/`cat`/`git` over the same SSH connection.

On Unix, stop and id replacement send SIGTERM to the child and its process
group, then send SIGKILL after a two-second grace period on a background thread.
The grace period lets agent CLIs flush resume/session files. Non-Unix platforms
or children without a pid use the immediate portable-pty killer.

### I/O and events

One reader thread per session reads up to 8 KiB chunks, base64-encodes raw PTY
bytes, and emits `session-data`. A second thread waits for process exit, removes
the matching generation, and emits `session-exit` with an optional exit code.

Commands write and flush PTY input, resize the master (generating normal
terminal resize behavior), kill/remove a handle, and list live ids.

### CLI conversation-id detection

The domain scans known CLI stores for files created within 180 seconds of the
launch timestamp:

- Claude: the encoded project directory under `~/.claude/projects`;
- Codex: recursive `~/.codex/sessions` JSONL files;
- OpenCode: recursive storage JSON files with `ses_` stems.

Creation time is preferred over modification time. Already claimed ids are
excluded so concurrent sessions do not resolve to the same conversation.

### Tests

Tests cover direct/wrapped launch specifications, shell resolution and failure,
per-CLI id derivation, chronological selection, and duplicate exclusion.

## Filesystem and execution domain (`domains/fs.rs`)

### Path authorization

When a workspace `root` is supplied, `resolve_in_root` is the privileged scope
check. It canonicalizes the root, finds and canonicalizes the target's nearest
existing ancestor, rebuilds any nonexistent tail, and rejects targets outside
the canonical root. This prevents lexical traversal and symlink escapes for
operations that pass a root.

When no root is supplied, access is treated as trusted user-driven access and
only expands a leading tilde.

### File operations

- Directory listing returns folders first with case-insensitive ordering.
- Text read/write uses UTF-8; write creates parent directories.
- Binary read returns base64 and rejects files over the supplied/default 25 MiB
  limit.

### Credential commands

User-configured credential export commands run through `/bin/sh -lc`. Non-zero
exit returns code and stderr; successful stdout is trimmed. This is an explicit
trusted configuration capability.

### One-shot command execution

`exec_command` runs `/bin/sh -lc` with optional cwd, null stdin, captured stdout
and stderr, and a timeout capped at five minutes. On Unix it creates a separate
process group and kills the group on timeout. Both output pipes drain on their
own threads to avoid pipe-buffer deadlock. Returned output is merged and capped
at 40,000 bytes, preserving the tail.

### Tests

Tests cover text round trips, directory ordering, credential output/error,
merged execution output, timeout enforcement, relative and new scoped paths,
traversal/absolute escape, symlinked file/directory escape, and missing roots.

## Git domain (`domains/git.rs`)

The git domain shells out to the `git` executable in the session cwd:

- full working-tree diff against `HEAD`;
- repository root, current branch, plus porcelain status with the X/Y columns
  split out (staged index state vs worktree state) for the staging UI;
- zero-context diff for a specific path (gutter markers) and full-context
  per-side diffs (`--cached` for staged, plain for unstaged);
- staging operations for the git workbench: `git_stage` (`add`), `git_unstage`
  (`restore --staged`), and `git_commit` (rejects empty messages, returns
  git's summary line).

Porcelain parsing normalizes renamed destinations and quoted paths. Pushes and
history rewrites remain out of scope — the UI never leaves the local repo.

Tests cover modified/staged/untracked parsing, rename destinations, and quoted
paths.

## Worktree domain (`domains/worktree.rs`)

Worktree isolation for sessions and board tasks. A working folder may be one
git repo **or a plain folder whose immediate subfolders are each their own
repo** (multi-repo workspace); both are mirrored under
`~/.yaam/worktrees/<slug>/`:

- `worktree_create` — one `git worktree add` (branch `yaam/<slug>`) per
  detected repo, recording each repo's fork ref; in multi-repo folders,
  non-repo entries (loose config files, docs) are symlinked so the workspace
  shape survives. Metadata lands in `.yaam-worktree.json`; the returned
  `workdir` is what the session uses as its cwd.
- `worktree_diff` — per-repo diff against the fork ref, with `git add -A -N`
  (intent-to-add) first so brand-new files appear.
- `worktree_merge` — per repo: stage + commit outstanding work on the
  isolation branch, skip repos with no commits ahead, verify the source
  checkout is still on the fork branch, then `merge --no-ff`; a conflict
  aborts the merge and reports per-repo results instead of leaving the source
  mid-merge.
- `worktree_remove` — `git worktree remove --force` per repo, optional branch
  deletion, then the mirror folder is removed.

Tests run against real temporary git repositories: single-repo round trip
(isolate → edit → diff shows new files → merge back), multi-repo folders with
symlinked loose entries and per-repo skip/merge results, and the no-repo
error.

## State domain (`domains/state.rs`)

### Layout

All files live under Tauri's application-data directory:

- `conductor-state.json` for the main partition;
- arbitrary validated legacy/named partitions;
- `sessions/<id>.json` for each session.

The legacy `conductor` name and app identifier are intentionally preserved for
installed-state compatibility.

### Atomic writes and recovery

Names must be non-empty ASCII alphanumeric/hyphen/underscore stems, preventing
path traversal. Writes:

1. create a unique sibling temp file;
2. set Unix mode `0600`;
3. write and `sync_all`;
4. rotate the previous primary to `.bak`;
5. rename the temp file into place.

Main and named partition loads can fall back to backup. Session loading reads
primary JSON files and recovers orphaned backups only when a primary is absent.
Unreadable session files are skipped by the frontend loader.

Tests cover safe names, backup rotation/recovery, permissions, primary
preference, orphaned session backups, and missing session directories.

## MCP domain (`domains/mcp.rs`)

The Rust MCP domain implements only the stdio transport. Protocol semantics
remain in the frontend MCP client.

### Managed process

Each `Proc` owns a child, stdin pipe, and channel of complete stdout lines. Drop
kills and waits for the child. `McpManager` maps server ids to individually
mutex-protected processes so a slow request on one server does not lock every
server.

### Start and request behavior

Start executes the configured binary directly with arguments, environment, and
optional cwd. It augments PATH with common macOS CLI locations. stdout is read
line-by-line into a channel; stderr is logged.

A request writes newline-delimited JSON-RPC, extracts the request id, and waits
for the matching response line. Interleaved notifications/requests are skipped.
Timeout is clamped from one to 120 seconds. Requests serialize per server because
the process mutex is held through the response wait.

Notifications write without waiting. Stop drops the process. Starting an
existing id replaces and kills the old process.

Current protocol limitation: reverse/server-initiated requests such as
`roots/list` are not serviced.

Tests round-trip a fake server with an interleaved notification and verify
missing-server errors.

## Search domain (`domains/search.rs`)

The chat search domain holds an optional in-memory Tantivy engine. Reindexing
creates a new schema/index and replaces the previous engine atomically under a
mutex. Fields store chat id, message id, role, and searchable text. Each message
is truncated at a valid UTF-8 boundary to 20,000 bytes.

Search uses Tantivy's lenient query parser and returns scored top documents,
defaulting to 30 and capping at 100. The index is intentionally non-durable;
the frontend rebuilds it from persisted transcripts after changes.

Tests cover search-before-index, metadata/limit behavior, replacement of old
documents, and Unicode-safe truncation.

## Bedrock domain (`domains/bedrock.rs`)

### Credentials

The domain supports:

- the standard AWS SDK chain, optionally with a profile;
- user credential-command JSON in AWS export, nested `Credentials`, camel-case,
  uppercase, epoch, and ISO expiry shapes;
- `AWS_*` environment assignment output.

Credential-command clients cache until five minutes before reported expiry; a
missing expiry defaults to one hour. Standard-chain clients rely on SDK refresh.

### Invocation and refresh

Clients are cached by region/profile/credential-command. InvokeModel receives a
model id and already constructed JSON body. Authentication-like errors may run
the configured refresh command, evict/rebuild the client, and retry once.
Non-authentication failures return immediately.

Tests cover accepted/rejected credential formats, seconds/milliseconds expiry,
and auth-error classification.

## Remote domain (`domains/remote.rs`)

The mobile-companion server, built on **axum** (dedicated thread running a
current-thread tokio runtime; the listener is bound synchronously so port
conflicts surface to the caller, and `remote_stop` shuts down gracefully via a
oneshot; the bind retries briefly so a stop→start token change survives the
old listener's shutdown). `remote_start` accepts the frontend's persisted URL
token (minting one only when absent) and returns one connect URL per reachable
interface, classified via `if-addrs` (LAN private ranges, Tailscale's CGNAT
100.64/10, `wg*`/`utun*` for WireGuard/VPN).

Routes:

- `GET /` and fallback — the embedded single-file mobile app (`include_str!`
  of `remote-app.html`, produced by `npm run build:mobile`);
- `GET /api/ping?t` — URL-token check before the pairing screen;
- `POST /api/pair/request?t` — queue a pairing request (device id validated,
  pending list capped at 5 and deduped);
- `GET /api/pair/status?t&device` — pending / paired (+ minted device token);
- `GET /api/state?t&d` — the last published snapshot, verbatim;
- `GET /api/stream?t&d` — SSE: the snapshot pushed on every publish (watch
  channel bump);
- `GET /api/term?t&d&id` — SSE: one session's RAW terminal bytes, ring backlog
  first then live chunks from the session domain's PTY tap;
- `POST /api/command?t&d` — queue a `{ kind, id, agent_id, text, ok }` command
  (actions and `rpc_*` browsing requests alike);
- `GET /api/rpc?t&d&id` — pick up a desktop rpc answer (consumed on read,
  store capped; answered via the `remote_respond` command).

State and command routes require BOTH the URL token and a paired device token
(403 otherwise). Device tokens are minted only by `remote_approve_pair` —
i.e. an explicit user approval on the desktop — and the paired set is
re-hydrated from frontend settings via `remote_set_devices`, so revoking a
device in Settings locks it out. The server executes nothing and holds no
credentials; the frontend drains commands with `remote_take_commands` and
applies them through normal conductor actions.

Tests cover the token/device auth matrix, the pairing flow end-to-end,
pending-list caps/dedup, interface classification, rpc result gating, and
command serde.

## Detach domain (`domains/detach.rs`)

Detachable sessions. The binary's entry point dispatches on `--yaam-host` /
`--yaam-attach` before Tauri boots (`app_lib::detach_entry`). The host owns a
`portable-pty` pair running `/bin/sh -lc <cmd>`, a 200 KB output ring, and a
unix-socket accept loop serving one client at a time (client frames:
`[type u8][len u32][payload]` — DATA, RESIZE, KILL; server side is raw PTY
bytes with ring replay on connect). The attach client bridges its own
stdio/SIGWINCH to that socket and runs inside a normal app PTY session.

Commands: `detached_spawn` writes the spec (`~/.yaam/detached/<id>.json`),
launches the host with `setsid` + null stdio, waits for the socket, and
returns the attach command line; `detached_list` probes sockets and prunes
stale specs; `detached_kill` SIGTERMs the host's process group and removes
the files. The host records its pid into the spec at startup and deletes
socket + spec on child exit.

Tests cover frame round trips and a real end-to-end host: backlog replay,
stdin echo through the PTY, a second client reconnecting (the app-restart
case), and the kill frame.

## Icons domain (`domains/icons.rs`)

`file_icon(path)` returns the OS's own icon for a path — the macOS Finder
icon via NSWorkspace, converted TIFF→PNG in memory and base64-encoded — so
the file explorer shows real system icons. Other platforms return an error
and the frontend falls back to its colored glyph set. Tests assert real PNG
bytes for real paths.

## Secrets domain (`domains/secrets.rs`)

Secrets are stored with the `keyring` crate under service
`dev.yaam.conductor`, keyed by opaque frontend-generated account names.

- Set creates/replaces a password; an empty value deletes it.
- Get maps missing entries to `None`.
- Delete treats a missing entry as success.

The concrete store is macOS Keychain, Windows Credential Manager, or Linux
Secret Service according to the platform feature.

## Tauri capability configuration

The main window receives core/window/dialog permissions and HTTP plugin access
to HTTPS plus localhost/127.0.0.1 HTTP. The application-wide Tauri CSP is
currently unset; addon frames inject their own restrictive CSP and opaque-origin
sandbox independently.

Custom commands are registered only for the main window, but command-level Rust
handlers generally trust the main frontend as the caller. Actor-level policy is
implemented in frontend orchestration layers, not enforced by Rust.

See [Security model](security.md) for implications.

## Backend test architecture

There are 69 Rust unit tests in this snapshot. Tests are colocated inside each
domain module and call internal implementation functions directly, avoiding a
running Tauri application where possible. Temporary filesystem fixtures use
RAII cleanup. MCP uses a shell-based fake server; Bedrock tests focus on pure
credential/error logic rather than external AWS calls.

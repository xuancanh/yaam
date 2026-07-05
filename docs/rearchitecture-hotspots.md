# Rearchitecture hotspots beyond the store

## Executive assessment

The highest-priority issue is not file size. Installed addon tools and hooks are
executed with `new Function` in the privileged main webview. The permission
wrapper restricts calls through the supplied `AddonApi`, but it does not remove
ambient browser or Tauri authority from the addon program. This is not a secure
sandbox.

The largest structural opportunity is a shared application-command layer. UI
actions, Master tools, task watchers, chat tools, and addon RPC currently
implement overlapping use cases independently. Moving those implementations
into domain folders without first establishing one command and authorization
boundary would preserve duplication and policy drift.

This report complements `docs/store-domain-refactor-plan.md`. The command layer
should be introduced before the later domain-runtime extraction in that plan.

## Priority matrix

| Priority | Hotspot | Main risk | Target |
| --- | --- | --- | --- |
| P0 | Addon tool and hook execution | Untrusted code has ambient main-webview authority | Isolated sandbox with capability RPC |
| P0 | Filesystem authorization | Workspace-scoped writes can follow symlinks outside the workspace | Canonicalized Rust-side path policy |
| P1 | Duplicated application use cases | Behavior, validation, and authorization differ by caller | Domain commands plus a central policy engine |
| P1 | LLM runtimes | Six similar tool loops have inconsistent limits, cancellation, and errors | Reusable tool-loop engine and actor mailbox |
| P1 | PTY session runtime | Process lifecycle and output delivery have weak backpressure | Explicit session supervisor |
| P1 | Native IPC | Stringly typed, monolithic privileged boundary | Typed service adapters and contract validation |
| P2 | State and type model | Optional-field-heavy session model and mixed durable/runtime state | Discriminated domain records and runtime state |
| P2 | Chat history and search | Streaming causes global churn; search repeatedly rebuilds | Buffered streaming and incremental persistence/indexing |
| P2 | Files pane | Whole-file reads, polling, and thousands of rendered lines | File service, watches, ranged reads, virtualization |
| P3 | Large UI composition modules | Settings and board own unrelated domain behavior | Owner-domain panels and selector hooks |

## P0: isolate addon execution

`app/src/core/addons.ts` executes tool and hook source with `new Function`. The
permission proxy only controls the `api` argument. It cannot stop evaluated code
from reaching ambient globals such as network APIs, browser storage, or any
Tauri bridge exposed to the main webview.

The architecture must treat installed addon programs as untrusted:

1. Run tools and hooks in an opaque-origin sandbox iframe or a dedicated
   QuickJS/Boa/WASM runtime. Do not evaluate them in the main webview.
2. Give the sandbox no direct network access and expose only correlated RPC.
3. Validate every request and response in the host, including size limits.
4. Apply CPU/time, memory, and output limits. Terminate timed-out executions.
5. Pass explicit immutable snapshots instead of ambient application objects.
6. Record the addon identity, requested capability, decision, and result.

An iframe is the pragmatic first boundary if it uses `sandbox="allow-scripts"`,
an opaque origin, and a restrictive CSP such as `connect-src 'none'`. A small
embedded JavaScript runtime is a stronger long-term boundary because execution
limits and global capabilities are easier to control.

After isolation, split the current addon core by responsibility:

```text
domains/addons/
  manifest.ts
  permissions.ts
  rpc.ts
  snapshot.ts
  sandbox.ts
  runtime.ts
```

## P0: enforce filesystem scope in Rust

Chat file tools lexically normalize paths in TypeScript before invoking Rust.
The Rust write implementation then follows filesystem symlinks. A symlink under
the workspace can therefore point outside it while the lexical path still looks
workspace-local.

Path scope is an authorization rule and must be checked at the privileged
boundary:

- pass the allowed workspace root and requested path separately;
- canonicalize the existing root and nearest existing target parent in Rust;
- reject paths whose canonical target/parent is outside the root;
- define an explicit policy for symlink reads and writes;
- repeat the check immediately before opening the file;
- add tests for symlinked files, symlinked directories, `..`, nonexistent
  targets, and root replacement races.

Lexical frontend checks can remain for usability, but cannot be the security
boundary.

## P1: introduce domain commands and one policy engine

The same operations are currently implemented separately for the board UI,
Master tools, task watchers, chat tools, and addons. Examples include creating
or moving tasks, starting or stopping sessions, sending input, scheduling work,
and writing files. Each route can evolve different validation, logging, and
permission behavior.

Use one application layer between all actors and domain services:

```text
UI / Master / Watcher / Chat / Addon
                 |
                 v
       Command registry + policy
                 |
                 v
 Session / Task / Schedule / Filesystem services
                 |
                 v
       Tauri / LLM / persistence adapters
```

Each command should own:

- a stable name and input/result schema;
- the required resource and capability;
- domain validation and handler;
- audit metadata and user-visible failure mapping.

The execution context should identify the actor, for example `user`, `master`,
`watcher(taskId)`, `chat(sessionId)`, or `addon(addonId)`. Policy returns
`allow`, `ask`, or `deny`. Master schemas, addon RPC, and chat tools should be
adapters generated from or backed by the same command definitions rather than
independent switch statements.

This command boundary should precede the remaining store extraction. Otherwise
the refactor will relocate duplicate use cases into domain folders without
making one domain authoritative.

## P1: consolidate the LLM runtime

`app/src/llm/client.ts` mixes provider registration, credentials, protocol
conversion, Bedrock behavior, streaming state machines, and SSE parsing. Master,
monitor, watcher, addon editor, addon agent, and chat then implement similar but
different tool loops.

Split protocol and transport concerns:

```text
llm/
  registry.ts
  credentials.ts
  transport.ts
  sse.ts
  protocol/
    anthropic.ts
    openai.ts
    bedrock.ts
  tool-loop.ts
  actor-mailbox.ts
```

`ToolLoopEngine` should accept tools, an executor, round limit, history policy,
integrity policy, streaming callbacks, and cancellation. A keyed
`ActorMailbox<Key, Event>` should serialize work for one session/task/addon and
support coalescing, cancellation, and shutdown.

All provider calls need an `AbortSignal`, deadline, bounded retry policy, and
structured usage/error telemetry. Add deterministic tests for fragmented SSE
chunks, malformed tool arguments, auth refresh, protocol conversion, maximum
rounds, queue ordering, and cancellation.

## P1: make PTY management a session supervisor

The Rust session domain currently combines shell selection, PTY creation,
reader/waiter threads, process events, session-id detection, and Tauri commands.
Spawning a duplicate session id replaces the stored handle without an explicit
old-process shutdown. Output is emitted chunk-by-chunk to the webview with no
bounded queue or batching.

Keep these files together under the session domain, but separate their roles:

```text
src-tauri/src/domains/session/
  mod.rs
  command.rs
  supervisor.rs
  output.rs
  detection.rs
```

The supervisor should own an explicit
`starting -> running -> stopping -> exited` lifecycle, reject duplicate ids,
terminate process groups, and apply graceful-then-forced shutdown. Deliver PTY
output through a bounded per-session channel, coalescing by a small byte or time
threshold before crossing IPC. Track queue depth, bytes, and dropped/coalesced
chunks.

Tests should cover duplicate ids, output bursts, clean and abnormal exit,
descendant termination, shutdown races, and session-id detection.

## P1: split and validate native IPC

`app/src/core/native.ts` is one bridge for PTYs, HTTP, command execution, search,
filesystem, Bedrock, git, persistence, and secrets. Command names and payloads
are duplicated as strings across TypeScript and Rust, and TypeScript casts do
not validate runtime responses.

Introduce a `PlatformServices` interface with explicit `TauriPlatform` and
`BrowserPlatform` implementations, then split adapters by capability:

```text
infrastructure/native/
  session.ts
  filesystem.ts
  git.ts
  search.ts
  persistence.ts
  secrets.ts
  http.ts
  bedrock.ts
```

Validate IPC input and output at runtime. Prefer generated TypeScript contracts
from Rust definitions; a typed command map plus contract tests is an acceptable
intermediate step. Browser fallbacks should be deliberate implementations, not
a mixture of silent no-ops, local storage, and throws.

## P2: separate durable records from runtime state

`app/src/core/types.ts` contains all domains, persisted schema, UI state, and
transient runtime flags. `Agent` represents both PTY and chat sessions with many
optional fields, so callers repeatedly branch on kind and assume field presence.

Move types to their owning domains and introduce discriminated records such as
`PtySession` and `ChatSession`. Keep durable `SessionRecord` data separate from
`SessionRuntimeState` such as busy status, active request, terminal attachment,
and pending approval. Root `AppState` should compose domain slices; retain a
compatibility barrel during migration.

Do this after command and persistence characterization tests. Combining a data
model migration with broad file movement makes compatibility failures difficult
to isolate.

## P2: make chat history and search incremental

Chat text and thinking deltas currently update global agent/chat state while an
LLM is streaming. Transcripts also exist in private API history and a Rust
search index. The index is rebuilt rather than incrementally updated.

Use a runtime streaming buffer and batch visible updates at most once per
animation frame. Commit completed messages to durable storage once. If history
is expected to grow, use SQLite with FTS5 or another incremental index rather
than rebuilding an in-memory index after broad state changes. Index by stable
message id and react only to transcript mutations.

## P2: create a workspace file service

`FilesPane.tsx` combines caching, periodic file and git polling, diff parsing,
whole-file loading, syntax highlighting, and rendering. The Rust filesystem
commands return whole files/directories, while the UI can render thousands of
line elements.

Create a `WorkspaceFileService` that owns metadata, ranged reads, cancellation,
cache invalidation, and filesystem-watch events. Replace polling where native
watch events are available. Virtualize large files and diffs, cap preview bytes
before decoding/highlighting, and extract/test diff parsing independently.

## P3: split UI composition and subscriptions

`SettingsView.tsx` and `Board.tsx` are large because they compose behavior owned
by several domains. Move MCP, skills, chat-agent, provider, and Master settings
panels to their owner domains and compose them in the settings route.

Most production components still consume the full conductor state. Add
domain-owned selector hooks and migrate high-frequency surfaces first: terminal,
chat, board, sidebar, and settings. Settings forms should use local drafts where
typing does not need to update the global runtime immediately.

## Cross-cutting observability and tests

Silent `.catch(() => {})` paths make lifecycle and persistence failures hard to
diagnose. Add a typed error/event service with domain, actor, session/task id,
severity, correlation id, and user-visible handling policy.

Before major moves, add characterization tests for:

- addon sandbox escape attempts and the full permission matrix;
- filesystem symlink escapes;
- command parity across UI, Master, watcher, chat, and addon callers;
- LLM protocol/SSE fixtures, timeouts, and actor cancellation;
- PTY duplicate ids, output bursts, and process-tree shutdown;
- IPC payload and response contracts;
- scheduler behavior with a fake clock;
- persistence and session migration fixtures.

## Recommended sequence

### Phase 0: close authority gaps

1. Sandbox addon tools and hooks.
2. Enforce canonical workspace path policy in Rust.
3. Add escape and permission regression tests.

### Phase 1: establish application boundaries

1. Introduce actor identity, command registry, and policy decisions.
2. Migrate one vertical use case, such as `send_to_session`, through every
   caller.
3. Migrate session, task, schedule, and filesystem commands incrementally.
4. Continue the store plan using these domain-owned command interfaces.

### Phase 2: stabilize runtimes

1. Extract the common LLM tool-loop engine and actor mailbox.
2. Add request cancellation, deadlines, telemetry, and redaction.
3. Introduce the Rust PTY session supervisor and bounded output delivery.

### Phase 3: harden boundaries and data

1. Split typed native service adapters and add IPC contract validation.
2. Separate durable records from runtime state.
3. Normalize workspace storage only as its own tested migration.

### Phase 4: scale reads and rendering

1. Make chat persistence/search incremental and batch streaming updates.
2. Introduce the workspace file service and virtualized viewers.
3. Complete domain selector and settings-panel migration.

## Definition of done

- No addon-authored JavaScript executes in the privileged main webview.
- Workspace-scoped file operations cannot escape through symlinks.
- Every actor reaches domain behavior through the same command and policy path.
- LLM runs are cancellable, bounded, observable, and use a shared loop engine.
- Session lifecycle has one supervisor with bounded output delivery.
- Native IPC contracts are typed and runtime-validated.
- Durable state is separate from high-frequency runtime state.
- Chat search and file viewing scale incrementally rather than by full rebuilds.
- High-frequency components subscribe only to the domain state they render.

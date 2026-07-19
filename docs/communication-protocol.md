# Communication protocols and wire data

## Scope

YAAM has several intentionally narrow transports. Product state stays in the
frontend; native processes and network peers exchange bounded messages through
typed adapters. This document is the wire-level reference for contributors
changing a payload, event name, or framing rule.

## Transport map

| Link | Transport | Direction | Payload/framing |
| --- | --- | --- | --- |
| React/runtime ↔ Rust | Tauri `invoke` | request/response | JSON arguments/results, command names in `lib.rs` |
| Rust PTY → webviews | Tauri events | push | `session-data` base64 bytes; `session-exit` JSON |
| Rust filesystem watcher → webview | Tauri event | push | `fs-change` bounded path batch |
| Main ↔ satellite | Tauri events | push | `ws:sync` / `ws:reattach` workspace slice payload |
| Desktop ↔ phone | HTTP + SSE | bidirectional via queue | JSON REST, snapshot SSE, raw terminal SSE |
| Detached host ↔ attach client | Unix socket frames | bidirectional | one-byte type + little-endian u32 length + payload |
| Rust ↔ stdio MCP child | newline-delimited JSON-RPC | bidirectional | one JSON object per line |
| Frontend ↔ provider | HTTPS | request/stream | Anthropic Messages or OpenAI-compatible SSE |

All transports are adapters, not alternate state stores. A received command is
validated, authorized at the appropriate frontend layer, and applied through
normal actions.

## Tauri invoke and events

The command names and argument shapes are registered in
`app/src-tauri/src/lib.rs`; `core/native.ts` and
`infrastructure/native/*` provide the frontend adapters. Rust serializes with
serde. The frontend uses camelCase TypeScript objects while the Tauri argument
keys match the generated command bindings (for example
`spawn_session({ id, command, cwd, rows, cols })`).

### PTY events

```json
// event: session-data
{ "id": "agent-id", "data": "<base64 raw PTY bytes>" }

// event: session-exit
{ "id": "agent-id", "code": 0 }
```

`session-data` is binary-safe: the frontend decodes base64 to `Uint8Array` and
writes bytes to xterm. No terminal text or scrollback is replayed into a live
PTY after reload; a repaint resize is used instead. Exit `code` may be null.

### Watch and close events

`fs-change` carries a bounded/coalesced envelope for a watched root:

```ts
{ root: string; paths: string[] }
```

`root` is the canonical watcher key and `paths` are sorted/deduplicated visible
paths (`.git` and `node_modules` churn is dropped). The Files pane refreshes the
affected tree; browser builds use polling.
`close-requested` carries the Tauri window label as a string. Rust broadcasts
it after vetoing the OS close; the matching window flushes and then destroys
itself.

### Workspace window events

```ts
interface WsSyncPayload {
  workspaceId: string
  data: WorkspaceData // serialized as JSON/unknown at the bridge
  agents: Agent[]      // only sessions owned by this workspace
}
```

`ws:sync` is satellite → main and may be debounced. `ws:reattach` has the same
shape and is the final handoff before a satellite closes. Main merges the slice
and remains the only durable writer.

## Mobile companion HTTP protocol

The server listens on the configured port (8712 by default). Every route uses
the URL token query `t`. Pairing routes require only `t`; state, command, RPC,
stream, and terminal routes also require the paired-device token query `d`.
Tokens are bearer credentials and must not be placed in referrers or logs.

### Endpoint reference

| Method/path | Auth | Wire behavior |
| --- | --- | --- |
| `GET /api/ping?t=` | URL token | `{ "ok": true }` preflight |
| `POST /api/pair/request?t=` | URL token | body `{device_id,name}`; returns `pending` or `already-paired` |
| `GET /api/pair/status?t=&device=` | URL token | `{status:"pending"\|"unknown"}` or `{status:"paired",token}` |
| `GET /api/state?t=&d=` | both | latest `RemoteSnapshot` JSON, or `{}` before first publish |
| `GET /api/stream?t=&d=` | both | SSE `data:` events containing the full snapshot on each publish |
| `GET /api/term?t=&d=&id=` | both | SSE events containing base64 PTY bytes: ring backlog first, then live chunks |
| `POST /api/command?t=&d=` | both | body `RemoteCommand`; queues it for desktop polling |
| `GET /api/rpc?t=&d=&id=` | both | `{ready:false}` or consumes `{ready:true,json:<answer>}` |

The server returns `403` for failed auth, `400` for malformed/oversized
commands, `429` when pending pairs or the command queue is full, and `404` for
an unknown live terminal tap. Responses carry no-store, no-referrer,
nosniff, anti-framing headers and a restrictive CSP.

### RemoteCommand

```ts
interface RemoteCommand {
  kind: string       // allowlisted command kind
  id: string         // task/chat/session/request id
  agent_id?: string  // target chat/session where applicable
  text?: string      // message, input, or RPC JSON
  ok?: boolean       // approval/answer decision
}
```

Allowlisted kinds include `master_send`, `chat_send`, `chat_new`, `chat_reply`,
`chat_rate`, `task_chat`, `task_start`, `session_input`, `session_key`,
`session_focus`, `session_blur`, `prompt_answer`, `prompt_approve`,
`prompt_deny`, `session_stop`, `session_resume`, `approve_master`,
`approve_chat`, `workspace_switch`, and `rpc_fs_list`, `rpc_fs_read`,
`rpc_fs_b64`, `rpc_git_status`, `rpc_git_diff`. The queue caps at 128 commands;
kind/id/agent fields and text have independent byte limits.

### RemoteSnapshot

The desktop publishes one bounded JSON object scoped to the active workspace:

```ts
interface RemoteSnapshot {
  ts: number
  workspace: string
  workspaceId: string
  workspaces: { id: string; name: string; windowed?: boolean }[]
  sessions: SessionWire[]
  tasks: TaskWire[]
  durables: DurableWire[]
  chats: ChatWire[]
  master: { busy: boolean; brain: boolean; msgs: RemoteMsg[] }
  approvals: RemoteApproval[]
}
```

Session terminal serialization is special: only a phone-focused session gets a
serialized xterm buffer in the snapshot. Live focus uses `/api/term`; ordinary
snapshot publishes keep other `term` values empty. Message text, task count,
screen lines, and response stores are capped. The snapshot is a view model, not
a persistence format, and fields may be added compatibly with defensive mobile
parsing.

## Detached host frame protocol

Detached sessions run a separate `--yaam-host` process. The Unix socket frame is:

```
[type: u8][length: little-endian u32][payload: length bytes]
```

`DATA` frames carry raw PTY bytes in either direction: host → attach streams
output, while attach → host forwards user input. The attach client sends
`RESIZE` frames containing four little-endian `u16` bytes (`rows`, then `cols`)
and `KILL` to stop the host. Payload and frame lengths are bounded before
allocation. A reconnect receives the host's bounded output ring, then live
frames; no application JSON is mixed into the PTY byte stream.

## MCP and provider wire formats

Local stdio MCP uses one newline-delimited JSON-RPC object per line. The client
performs `initialize`, sends `notifications/initialized`, lists tools, and
serializes calls per server. Interleaved notifications are consumed without
stealing a request response; line, record, queue, and result sizes are capped.

The LLM client normalizes two provider protocols: Anthropic Messages and
OpenAI-compatible chat completions. Both may stream SSE deltas; adapters emit a
common internal sequence of text, thinking, tool-call, stop-reason, and
incomplete-argument events. Bedrock uses the same internal shape but may fall
back to a bounded buffered response.

## Compatibility rules

- Treat unknown JSON fields as ignorable and missing optional fields as empty.
- Never change event names, token query names, compatibility state filenames, or
  detached frame ordering without a migration path.
- Add size limits before parsing or allocating untrusted lengths.
- Keep raw terminal bytes binary-safe; do not convert PTY data to JSON text.
- Add a wire fixture/regression test whenever a command kind, event payload, or
  remote snapshot field changes.

# Command authorization architecture

## Purpose and status

The application command layer is the shared use-case boundary for actions that
can be requested by the UI, Master, task watchers, chat agents, or addons. It
is implemented under `app/src/app/commands/` and is deliberately separate from
the Rust IPC boundary. The registry is active, but migration is incomplete:
session send/stop, board, and schedule commands use it, while many older Master,
watcher, chat, and addon paths still use their domain-specific gates.

## Actors and capabilities

Every invocation carries one explicit actor:

| Actor | Identity key | Additional policy |
| --- | --- | --- |
| `user` | `user` | UI confirmation and destructive-action dialogs |
| `master` | `master` | Master tool catalog: Auto, Ask first, Approval, Off |
| `watcher` | `watcher:<taskId>` | task-scoped watcher tools and acceptance workflow |
| `chat` | `chat:<sessionId>` | chat Ask/Auto mode and remembered tool approvals |
| `addon` | `addon:<addonId>` | the addon's granted permission scopes |

Capabilities are the same `AddonPermission` vocabulary used by the addon API:
`sessions:send`, `sessions:launch`, `tasks`, `schedules`, `agent`,
`master:prompt`, `ui`, `storage`, `http`, `secrets`, and `exec` (plus
`state:read`). A command declares exactly one required capability.

The default policy allows trusted orchestration actors at this layer and checks
the addon's live grants for addon actors. This is intentional layering: Master
tool policy, chat Ask mode, task-specific watcher rules, and UI confirmation
remain stricter gates where those workflows are defined.

## Command lifecycle

`createCommandRegistry(policy)` owns a map of named command definitions. A
definition contains:

```ts
{
  name: 'send_to_session',
  capability: 'sessions:send',
  validate(input),
  handler(input, context)
}
```

Execution is ordered and side-effect-safe:

1. Look up the name; unknown names fail as `CommandDenied`.
2. Validate the input. Validation runs before authorization so malformed input
   never reaches a policy or handler.
3. Ask the policy for `allow`, `ask`, or `deny`.
4. For `ask`, consume a matching one-shot approval from the caller's approval
   set. The key is `<actor identity>/<command>`; approvals cannot be reused by
   another actor or command.
5. Record the decision and invoke the handler.

Handlers receive the same actor context and may call domain ports, but command
handlers must not put side effects inside Zustand dispatch updaters. The
registry does not retry handlers and does not turn a denied command into a
partial operation.

## Audit behavior

The registry keeps a bounded in-memory ring of the newest 200 entries. Each
entry records command name, actor, decision (`allow`, `ask-approved`, or
`deny`), timestamp, and an optional denial reason. A caller may provide an
`onAudit` sink for activity/logging; the ring itself is runtime-only and is not
persisted as product history.

Denied and unknown commands are recorded. A missing approval is recorded as a
denial with `awaiting approval`; the handler is never called in either case.

## Current registration map

- `session-commands.ts`: `send_to_session` and `stop_session`, used by UI
  session actions through the user actor.
- `board-commands.ts`: task add/update/move/remove/start/restart/chat/review
  operations under `tasks`.
- `schedule-commands.ts`: schedule add/toggle/remove operations under
  `schedules`.
- App runtime composition registers these definitions and passes the registry
  into domain action factories. Addon calls carry their addon id so the same
  policy and audit path can distinguish package activity.

The registry is not a substitute for native validation. Rust still validates
paths, identifiers, sizes, timeouts, and command-specific limits, and the
frontend's domain gate remains responsible for provider credentials, chat
approval promises, and Master integrity checks.

## Extension checklist

When adding a command:

1. Define a typed input and bounded validator in `app/commands/`.
2. Choose the narrowest existing capability; do not invent a broad “admin”
   capability.
3. Register it in `conductor-runtime.ts` and pass the registry to the domain.
4. Route every caller through `execute(name, input, { actor })`.
5. Add allow/deny/ask, malformed-input, approval-consumption, and audit tests.
6. Keep the native command's independent path/size/timeout checks intact.

The migration is complete only when the command parity tests cover every actor
that can reach the use case. Until then, this document's status section and the
security model must continue to call the registry a partial authorization
boundary.

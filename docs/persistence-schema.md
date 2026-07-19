# Persistence schema and lifecycle

## Storage model

YAAM keeps one logical Zustand `AppState`, but persists it as a low-churn main
partition plus one file per agent/session. The compatibility names are fixed:
the main file is `conductor-state.json` under the app data directory and the
service identifier remains `dev.yaam.conductor`.

| Partition | Native path | Selector | Contents |
| --- | --- | --- | --- |
| Main | `conductor-state.json` (+ `.bak`) | `selectMainState` | settings, workspaces, scoped slices, tasks, schedules, templates, addons, chat memory, durable agents, Master history, activity/notifications |
| Session | `sessions/<id>.json` | `selectSession` | one agent's durable record and a capped log tail |
| Legacy named | `<name>.json` (+ `.bak`) | compatibility loader | older `sessions` partition and pre-split snapshots |

`SCHEMA_VERSION` is currently `1`. Hydration is intentionally field-defensive,
so additive fields usually do not require a version bump; a bump is reserved
for a shape change that the migration code must distinguish explicitly.

## What is persisted

`selectMainState` excludes the `agents` array and includes:

- tasks, cron schedules, templates, tools, agent/chat types, MCP servers,
  skills and registries;
- workspaces, active workspace, `workspaceData`, archived workspaces, tab
  groups, active group, and minimized ids;
- addons and addon storage;
- shared chat memory, durable-agent profiles, assistant memory, harness log;
- bounded Master messages, activity events, and notifications.

`selectSession` removes runtime-only keys such as status and escalation reason,
then writes the durable `SessionRecord` plus the last 200 log entries. Hydration
restores a session as idle; the runtime then reattaches a still-live PTY or
prints a relaunch marker.

Session and task `history` arrays are nested durable fields and are capped at
200 entries by the activity writer. A task-linked event is materialized in both
the per-session partition and the task's main/workspace partition using the same
event id. This preserves task history after a session is deleted and makes both
views cheap to render. The two partitions are independently debounced, so the
copies are convergent audit views rather than a cross-file transaction log; no
security or authorization decision may depend on their presence.

Runtime-only state includes PTY/xterm objects, provider histories, timers,
queues, abort controllers, pending approval promises, `detachedWorkspaces`,
keychain readiness, and search indexes.

## Hydration and migrations

`loadSnapshot()` loads the main file and session directory concurrently. If the
main JSON is invalid, it retries the `.bak`; unreadable individual session
files are skipped. If no split session files exist, it falls back to the legacy
`sessions.json` partition and then agents embedded in the old main snapshot.

`buildHydration()` then:

- seeds missing fields from the current `seedState()`;
- validates workspaces and active workspace;
- migrates removed board columns and legacy Personas;
- drops unknown, duplicate, or chat ids from tab groups;
- preserves the current one-to-six pane cap and clamps active panes;
- restores interrupted chats with a visible marker;
- resets restored process status to idle and returns the sessions requiring
  terminal reattachment.

Satellites run the same defensive state hydration but pass
`resolveSecrets: false`; only the main window reads missing credentials from
the OS keychain.

## Save pipeline

The main persistence runtime subscribes directly to Zustand, not through React.
After hydration calls `markReady()`, changes arm independent writers:

- main partition: debounced by about 800 ms;
- existing session changes: debounced by about 800 ms and identity-diffed;
- added/removed sessions: written immediately for structural durability;
- secrets: debounced by about 900 ms;
- browser fallback: best-effort `beforeunload` flush.

Native writes are serialized per partition. Rust writes a unique temporary file,
flushes/syncs it, rotates the previous primary to `.bak`, and renames the temp
into place. Close is vetoed until the main runtime awaits a bounded flush.
Failed writes leave the affected session dirty or retain a deletion tombstone
so a later sweep retries instead of silently declaring success.

## Secret mirror

Credential fields are represented in memory by normal settings/profile values,
but `secretEntries()` maps them to opaque keychain accounts. The mirror tracks
exact account/value pairs and skips unchanged writes. New values are written to
the keychain before the main JSON is redacted; removed dynamic accounts are
deleted. If a keychain write fails, the value remains in plaintext state so the
user does not lose it silently, and the save error is surfaced.

## Adding a persisted field

Follow all six steps:

1. Add the field to `PersistedState` and `AppState`.
2. Seed it in `core/data.ts`.
3. Hydrate defensively with `p.field ?? s.field ?? <empty>`.
4. Add it to `selectMainState` or `selectSession`.
5. Add the field reference to the matching detector in `subscribe.ts`.
6. Add old-snapshot, round-trip, and deletion/retry tests; guard every read with
   `?? []` or `?? {}`.

Never persist runtime maps or rename the compatibility file/service names.
Changes that affect secret redaction also require keychain mirror and failure
tests, including a satellite boot case.

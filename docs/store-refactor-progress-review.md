# Store refactor progress review and remaining plan

> **Historical review.** Use [architecture.md](architecture.md) and
> [frontend-domains.md](frontend-domains.md) for the current implementation. The
> body is preserved as the migration record.
>
> **Status addendum (2026-07-05).** Much of this review has since been executed.
> `store.tsx` is now a 32-line composition root that does **not** subscribe to the
> whole store; the runtime moved into `app/conductor-runtime.ts`, which composes
> four plain domain subsystems under `app/runtime/`:
> `session`, `addon`, `chat`, `master`, sharing a `RuntimeRefs` bundle. Concretely:
>
> - **#1 provider hot subscription — done.** `stateRef` is mirrored via
>   `useAppStore.subscribe`; no `useConductor()` remains in any production component
>   (AddonView, the last one, now reads its iframe snapshot from `getState()`).
> - **#5 domain action contracts — done.** Each domain exports its own interface;
>   `app/actions.ts` composes them. No domain imports the app-wide contract.
> - **#6 `core/state-lib.ts` barrel — done.** Deleted; zero consumers.
> - **#8 task-launch duplication — done.** The scheduler calls the one canonical
>   `spawnTaskSession`; `collectDueSchedules`/`collectDueTasks` are pure + tested.
> - **#9 runtime ownership — largely done.** Monitor/watcher/chat/master/addon-agent
>   are non-React factories owning their own maps + `dispose(key)`, backed by
>   `AbortRegistry`.
> - **#11 chat indexing — done.** The indexer subscribes directly and re-arms only
>   on `chatTranscriptsChanged`.
> - **#3 explicit boot lifecycle — done.** A transient, never-persisted
>   `bootStatus` ('loading' → 'restoring-runtime' → 'ready' | 'failed') gates the
>   scheduler so a slow hydration can't fire schedules against seed state.
>   `selectMainState` excludes it (tested).
> - **#4 close-lifecycle flush — done.** The Rust side vetoes the OS
>   `CloseRequested` and emits `close-requested`; the persistence runtime flushes
>   (awaiting every write, 3s-bounded) then destroys the window. Replaces the racy
>   fire-and-forget `beforeunload` (kept only as a plain-browser dev fallback).
> - **#7 session controller + exit coordinator — done.** `classifyExit` (pure) and
>   the effectful fan-out (`coordinateSessionExit`, ports-injected + tested) are
>   extracted, and the port-backed lifecycle (launch/resume/stop/archive/unarchive/
>   delete/send/answerPrompt) is unified into one `SessionController`
>   (`domains/session/controller.ts`). One controller, one typed exit result.
> - **#10 capability ports — done for all action modules.** Introduced
>   `domains/session/ports.ts` (`SessionProcessPort`: spawn/kill/remove/write/
>   sendLine/detect/attachTerminal+writeln/disposeTerminal) and
>   `domains/addons/ports.ts` (`PackageIoPort`: file/folder/save pickers, text
>   read/write, http fetch). The launch runtime, session actions, prompt actions,
>   the exit fan-out, and board + workspace session-teardown all drive native/xterm
>   only through `SessionProcessPort`; addon install/export goes through
>   `PackageIoPort`. **No domain action module imports `core/native` or
>   `core/terminals` wholesale.** The only remaining wholesale `native` use in the
>   session domain is the `onSessionExit` subscription (the native boundary by design).
> - **#12 orchestration tests — done** (91 → 129). Added `exit-handler.test.ts`
>   (fan-out), `launch-runtime.test.ts` (incl. launch-failure rollback),
>   `actions.test.ts` (archive/delete/stop/resume/unarchive cleanup + task-unbind),
>   `prompt-actions.test.ts`, `workspace/actions.test.ts` (workspace-delete
>   cascade), `addons/actions.test.ts` (install/export IO), `controller.test.ts`,
>   `runtime-close.test.ts` (close-flush handshake), and `watcher-runtime.test.ts`
>   (cancellation-on-delete: dispose aborts the in-flight LLM turn and the loop
>   unwinds). schema test asserts `bootStatus` is never persisted.
>
> **All numbered findings from this review are now addressed**, **and the target
> "non-React application runtime" (below) is now delivered:** `createAppRuntime()`
> (`app/conductor-runtime.ts`) builds the foundation kernel (store-mirrored
> stateRef, ClockPort-backed timers, activity service), the four domain subsystems
> (session/addon/chat/master) as plain factories cross-wired through plain cycle
> refs, and the composed action surface via `createConductorActions` — returning
> `{ actions, start, dispose }`. `ConductorProvider` is now just
> `createAppRuntime()` + `useEffect(start/dispose)`. State mirroring, timers,
> subscriptions, the scheduler, settle, search indexing, and the hydration boot all
> run outside React with an explicit lifecycle; every runtime + action slice has a
> `createX` factory (the `useX` hooks remain as thin adapters). Domain runtimes
> gained fake-clock/fake-store tests via `core/ports.fakes.ts`.
>
> The doc's `StatePort`/`ClockPort` seam is `core/ports.ts`. Remaining polish (not
> blocking): retire the now-unused `useConductorRuntime`/`useConductorActions` hook
> path once nothing imports it. Broader system rework continues in
> `docs/rearchitecture-hotspots.md`. The original target-architecture text is
> preserved below.

Reviewed on 2026-07-04 against commit `c8f6981` plus the active selector-migration
changes in the working tree.

This is a fresh review of the current implementation. It supersedes the status
assessment in `docs/store-domain-refactor-plan.md`; that document remains useful
for the original target architecture and constraints.

## Executive result

The refactor is moving in the right direction. Pure logic now lives with its
domain, persistence parsing is testable, and action identities are substantially
more stable. `store.tsx` has fallen from approximately 2,184 lines at the first
review to 1,693 lines in this snapshot.

The remaining 1,693 lines are harder than the lines already removed. They are
mostly orchestration, lifecycle ownership, cross-domain coordination, and
mutable runtime registries. Moving those blocks without introducing explicit
controllers and ports would only distribute the same coupling across more
files.

The highest-value next change is to stop `ConductorProvider` from subscribing
to the complete Zustand state. Its only direct reactive uses are persistence,
secret synchronization, and chat reindexing. Those should become isolated store
subscriptions. Once `stateRef` is maintained through `useAppStore.subscribe`,
the composition provider can render once instead of rerendering for terminal
output and chat streaming.

## Validation snapshot

The current working tree passed:

```text
npx tsc --noEmit -p tsconfig.app.json   passed
npm test                               53 tests passed in 9 files
npm run lint                           passed with 3 known Fast Refresh warnings
```

The warnings are the existing `only-export-components` warnings in
`components/ui.tsx` and `domains/board/TaskSpecForm.tsx`.

## What has been completed

### State container migration

Application data now lives in a small Zustand store in `core/store.ts`.
`dispatch` preserves the previous pure-updater behavior, and consumers can use
either full-state or selector subscriptions.

### Action identity stabilization

The action contract moved out of `store.tsx` into `app/actions.ts`. Domain action
context objects are memoized before being passed to the action hooks, so their
results and `ActionsCtx` no longer change merely because the provider rerenders.

The new `useConductorSelector` equality cache and the in-progress
`shallowEqual` helper support narrow multi-field subscriptions. At this snapshot,
seven production components use selectors. Fifteen production component files
still call the full `useConductor()` hook.

### Domain ownership of pure helpers

The old 400-line `core/state-lib.ts` is now a 16-line compatibility barrel. Pure
logic moved to:

- `domains/schedules/cron.ts`;
- `domains/schedules/template-command.ts`;
- `domains/session/command.ts`;
- `domains/session/layout-state.ts`;
- `domains/session/prompt-detection.ts`;
- `domains/board/task-prompt.ts`;
- `domains/workspace/state.ts`;
- `infrastructure/persistence/schema.ts`;
- `shared/id.ts`.

### Persistence parsing and hydration

Snapshot loading, backup recovery, schema projection, and pure hydration are
outside the provider. Hydration has focused regression tests and no longer
performs dispatch, terminal, or native operations internally.

### Session logic extraction

The following session behavior has moved to the session domain:

- pure launch planning and its tests;
- pure prompt detection and option extraction with tests;
- settle timers, prompt deduplication, and response-watch handling in
  `useSessionSettle`.

These are appropriate domain extractions: command/logic and their tests are
co-located, while native side effects remain outside pure functions.

## Remaining findings

## 1. The provider still rerenders for every state update

`ConductorProvider` calls `useAppStore()` without a selector and immediately
copies the result to `stateRef`. Terminal output, chat deltas, toasts, drag
state, and every other update therefore rerender the entire 1,693-line provider
function.

The action objects are now stable, which protects consumers of `ActionsCtx`, but
it does not remove the provider work itself. It also leaves every hook call and
dependency calculation in the provider on the hot path.

Only four places require the reactive `state` value:

- main persistence dependencies;
- per-session persistence dependencies;
- credential synchronization dependencies;
- chat search reindexing.

All other code reads `stateRef.current`. This makes removal of the full provider
subscription a contained, high-impact next step.

### Required change

Maintain the ref without rendering:

```ts
const stateRef = useRef(useAppStore.getState())

useEffect(() => useAppStore.subscribe(next => {
  stateRef.current = next
}), [])
```

Move persistence and chat indexing to runtimes that subscribe directly to the
store and compare only the slices they own. Do not replace the full subscription
with one large object selector inside the provider; that would retain most of
the same render cost.

## 2. The root view still defeats child selector work

`App.tsx` uses the full state in `MainArea` only to read `view`. Consequently,
every state update rerenders the active route subtree from its parent even when
individual children use narrow selectors.

Change `MainArea` to select only `view` before measuring selector improvements.
Then migrate the high-frequency surfaces first:

1. `MainArea`;
2. `Workspace` and `Sidebar`;
3. `ChatView`;
4. `Board`;
5. title bar and overlays;
6. settings, schedules, templates, and addons.

Prefer domain selector hooks over repeating ad hoc object selectors:

```ts
useCurrentView()
useWorkspaceSessions()
useActiveGroup()
useBoardTasks()
useActiveChat()
```

## 3. Hydration is a ref flag, not an application lifecycle

`hydrated.current` controls saving, but other runtimes start independently.
Enabled MCP servers and skill registries are connected by a fixed 1.5-second
timer. If disk or keychain hydration takes longer, that timer observes seed
state and restored integrations are not retried. The scheduler and global
event listeners also start before an explicit ready state exists.

Terminal reattachment is launched asynchronously from hydration but is not
part of the completion boundary. Runtime startup therefore has no single
definition of “restoration is complete.”

### Required change

Introduce an explicit, transient boot lifecycle:

```ts
type BootStatus = 'loading' | 'restoring-runtime' | 'ready' | 'failed'
```

Hydration should complete in this order:

1. load and parse persisted partitions;
2. apply the pure hydrated state;
3. resolve secrets;
4. inspect live native sessions and rebuild terminals;
5. mark the runtime ready;
6. start MCP, skill, scheduler, search, and persistence subscriptions.

The boot status is runtime state and should not be added to the persisted
schema.

## 4. Persistence extraction is only half complete

Pure parsing and projection moved successfully, but approximately 170 lines of
hydration, keychain, debounce, save, teardown-flush, and terminal-restoration
effects remain in the provider.

The current writers also rely on React rerenders to notice changes. The
`beforeunload` handler starts asynchronous native writes that may not complete
before webview teardown.

### Required change

Create `infrastructure/persistence/runtime.ts` with one owner for:

- boot/hydration sequencing;
- main-partition subscription and debounce;
- per-session subscription and identity diff;
- keychain synchronization;
- save error state;
- flush and disposal.

Use direct Zustand subscriptions and return unsubscribe/timeout cleanup from
the runtime. For reliable shutdown, coordinate with the Tauri close lifecycle
or a Rust-side persistence queue instead of depending solely on asynchronous
`beforeunload` calls.

Terminal rebuilding should be injected as a session-runtime port; persistence
must not import xterm directly.

## 5. Domain action contracts still point in the wrong direction

Although `ConductorActions` moved to `app/actions.ts`, every domain action module
still imports that global interface and defines itself as
`Pick<ConductorActions, ...>`.

Current direction:

```text
domain action module -> app/actions.ts
```

Target direction:

```text
app/actions.ts -> domain action interfaces
```

Each domain should export its own public action interface. The application
layer composes them:

```ts
export type AppActions =
  ShellActions & SessionActions & BoardActions & ScheduleActions &
  ChatActions & AddonActions & WorkspaceActions & SettingsActions
```

This change matters before further extraction. It prevents domain modules from
being defined by the composition root and makes missing or duplicate ownership
visible to TypeScript.

## 6. `core/state-lib.ts` is still the practical dependency hub

The source was split, but 15 modules still import the compatibility barrel.
That hides the new ownership boundaries and makes it easy to add another
cross-domain convenience export.

Migrate every consumer to the owning module, then delete the barrel. Examples:

- board actions import `mkId` from `shared/id`;
- workspace actions import `switchWorkspaceIn` from `domains/workspace/state`;
- Master runner imports terminal commands from `domains/session/command`;
- hydration imports layout migration from `domains/session/layout-state`.

Do this mechanically after the current selector work; behavior should not
change.

## 7. Session lifecycle remains the largest root-owned domain

The provider still owns:

- native process-exit subscription and classification;
- CLI resume-id probing;
- terminal creation and restoration;
- launch, resume, stop, archive, unarchive, and delete;
- prompt approval/denial and terminal input;
- runtime disposal;
- pane/group actions;
- task-session bindings and exit fan-out.

The process-exit handler is the clearest coupling hotspot. One callback updates
session state, board state, activity, notifications, addon hooks, task watchers,
monitors, resume ids, and auto-archive timers.

### Required change

Create a session controller and keep its commands with the session domain:

```ts
interface SessionController {
  launch(input: LaunchInput): string | null
  resume(id: string): void
  stop(id: string, actor: StopActor): void
  archive(id: string): void
  unarchive(id: string): void
  remove(id: string): void
  send(id: string, text: string): void
  answerPrompt(id: string, answer: PromptAnswer): void
  dispose(id: string): void
}
```

The session domain should emit a typed `SessionExited` result containing the
session, exit classification, and final output. An application coordinator can
then fan that event to board, activity, addon, monitor, and notification ports.
Do not make the session domain import board or Master implementations.

Separate layout actions from process actions. Pane/group transitions belong in
`domains/session/layout-actions.ts`; PTY lifecycle belongs in
`domains/session/controller.ts`.

## 8. Task launching is duplicated between board and scheduler paths

`spawnTaskSession` builds one-shot sessions for active tasks. The scheduler
contains a second background-workspace implementation that reconstructs agent
type selection, template handling, task/session binding, watcher kickoff, and
task-state updates.

This duplication is already producing different active/background behavior.
Create one board-owned `TaskExecutionService.start(taskLocation, trigger)` that
accepts a located task and target workspace. Scheduler code should only collect
due work and call that service.

The scheduler itself should be split into:

- pure `collectDueSchedules(state, now)`;
- pure `collectDueTasks(state, now)`;
- an executor that performs returned commands;
- a clock/ticker adapter.

This makes minute deduplication and background-workspace behavior testable with
a fixed clock.

## 9. In-memory runtime ownership is still fragmented

The provider owns separate refs for monitor histories/busy/queues, watcher
histories/busy/queues, task-session bindings, addon histories/busy state, chat
histories/busy state, MCP sessions, skill catalogs, Master queue state, and addon
editor histories.

Cleanup is manual and distributed across session deletion, task deletion, addon
deletion, workspace deletion, and runner `finally` blocks. In-flight LLM work is
not cancellable when its session, task, workspace, or addon is removed.

Each runtime should own its keyed state and expose `dispose(key)` and
`disposeAll()`:

```ts
interface KeyedRuntime<K, Event> {
  enqueue(key: K, event: Event): void
  dispose(key: K): void
  disposeAll(): void
}
```

Use `AbortController` for in-flight operations. Domain actions should call one
domain disposal method rather than deleting individual maps passed through a
large context object.

## 10. Extracted action modules still mix UI hooks and domain services

The new action files reduce `store.tsx`, but several directly import native IPC,
LLM configuration, mutable refs, and unrelated runtime callbacks. Their context
interfaces are dependency bags rather than stable domain ports.

For example, board actions receive watcher histories, queues, task bindings,
session spawning, native stop behavior, timers, notifications, and addon hooks.
This makes the hook difficult to test and keeps lifecycle ownership ambiguous.

Split each domain into:

- pure state transitions;
- a controller/service with injected ports;
- a thin React action adapter that exposes the public action interface.

Native calls should be behind capability-specific ports such as
`SessionProcessPort`, not imported by board, workspace, or addon action hooks.

## 11. Chat indexing remains tied to all agent changes

The search effect depends on `state.agents`. Terminal output and session status
updates replace agent objects, so unrelated PTY activity schedules a full chat
index rebuild.

Move indexing to the chat runtime and subscribe only to stable chat transcript
references. Longer term, emit incremental message upsert/delete operations
instead of rebuilding every document.

## 12. Test coverage validates helpers, not orchestration

The new pure-helper tests are valuable, but no test currently covers the
complete provider action identity. `actions-stability.test.tsx` verifies one
action hook with a module-level constant context; it cannot catch instability in
another slice or in final action composition.

Missing characterization tests include:

- actual `ConductorProvider` action-context stability under terminal updates;
- hydration readiness and delayed MCP/skill startup;
- persistence subscription/debounce/disposal;
- process-exit classification and fan-out;
- launch failure rollback/status behavior;
- archive/delete/workspace-delete runtime cleanup;
- scheduled tasks in active and background workspaces;
- cancellation when a chat, task, addon, or workspace is deleted;
- selector render isolation for the root and workspace surfaces.

## Updated target structure

```text
app/src/
  app/
    AppProvider.tsx
    actions.ts
    runtime-ports.ts
    global-effects.ts

  infrastructure/
    persistence/
      schema.ts
      hydrate.ts
      loaders.ts
      runtime.ts

  domains/
    activity/
      actions.ts
      service.ts

    session/
      actions.ts
      controller.ts
      state.ts
      exit.ts
      runtime.ts
      layout-actions.ts
      launch.ts
      use-settle.ts

    board/
      actions.ts
      controller.ts
      execution.ts
      watcher-runtime.ts

    schedules/
      actions.ts
      due.ts
      runtime.ts

    chat/
      actions.ts
      runtime.ts
      search-indexer.ts

    master/
      actions.ts
      runtime.ts

    addons/
      actions.ts
      runtime.ts

  shared/
    id.ts
```

Files remain organized by domain. Commands, state transitions, controllers, and
tests stay together when they implement the same behavior. Infrastructure is
separate only where the concern is genuinely external storage or IPC.

## Concrete strategy for eliminating most of `store.tsx`

The next refactor should change the architectural unit. The current extractions
are React hooks that receive increasingly large context objects. Continuing
that pattern would create a collection of coupled hooks while leaving React as
the application runtime.

Zustand is already an external store. Session processes, timers, persistence,
schedulers, monitors, and LLM queues do not need React rendering semantics.
Move them into a non-React application runtime with explicit `start()` and
`dispose()` lifecycle methods.

### Target application runtime

```ts
export interface StatePort {
  get(): AppState
  update(fn: (state: AppState) => AppState): void
  subscribe(listener: (next: AppState, previous: AppState) => void): () => void
}

export interface ClockPort {
  now(): number
  setTimeout(fn: () => void, ms: number): Disposable
  setInterval(fn: () => void, ms: number): Disposable
}

export interface AppRuntime {
  actions: AppActions
  start(): Promise<void>
  dispose(): void
}

export function createAppRuntime(deps: InfrastructurePorts): AppRuntime {
  const activity = createActivityService(deps.state, deps.notifications)
  const monitors = createMonitorRuntime(deps, activity)
  const sessions = createSessionController(deps, activity, monitors)
  const board = createBoardController(deps, sessions, activity)
  const schedules = createScheduleRuntime(deps, board, sessions, activity)
  const chat = createChatRuntime(deps, activity)
  const addons = createAddonRuntime(deps, sessions, board, activity)
  const master = createMasterRuntime(deps, sessions, board, addons, activity)
  const persistence = createPersistenceRuntime(deps, sessions)
  const coordinator = createAppCoordinator({
    sessions, board, schedules, chat, addons, master, activity,
  })

  return composeRuntime({
    persistence, coordinator, sessions, board, schedules, chat, addons, master,
  })
}
```

The React provider then becomes lifecycle glue:

```tsx
export function AppProvider({ children }: { children: ReactNode }) {
  const runtime = useMemo(() => createAppRuntime(infrastructure), [])

  useEffect(() => {
    void runtime.start()
    return () => runtime.dispose()
  }, [runtime])

  return (
    <ActionsCtx.Provider value={runtime.actions}>
      {children}
    </ActionsCtx.Provider>
  )
}
```

This removes `stateRef`, most `useCallback` declarations, declaration-order
refs, and timer refs from React. Domain controllers read fresh state through
`StatePort.get()` and own their private maps directly.

### Do not create a generic event bus

The runtime factory should wire typed callbacks at construction time. For
example, `SessionController` reports a `SessionExited` event to
`AppCoordinator`; the coordinator explicitly invokes board, addon, activity,
and monitor consequences. This keeps cross-domain flows searchable and typed.

A generic string event bus would hide dependencies and make ordering, failure,
and disposal harder to reason about.

## Exact extraction map from the current provider

Line numbers are approximate for the reviewed 1,693-line snapshot and will move
as the selector work is completed.

| Current block | Approximate lines | Destination | Notes |
| --- | ---: | --- | --- |
| state mirror, tracked timers, toast | 57-103 | `app/runtime.ts`, `domains/shell/feedback.ts` | Replace React refs with `StatePort` and `ClockPort` |
| workspace-aware events and notifications | 103-145 | `domains/activity/service.ts` | One service for active and background workspaces |
| screen tail, needs-input, status application | 145-215 | `domains/session/attention.ts` | Session state commands; notify through a port |
| monitor histories, queue, runner wiring | 215-234 | `domains/master/monitor-runtime.ts` | Private maps and cancellation owned here |
| watcher histories, bindings, runner wiring | 235-269 | `domains/board/watcher-runtime.ts` | Board owns watcher and task-session indexes |
| output tail and prompt clearing | 270-314 | `domains/session/output.ts` | Pure transitions plus terminal activity entry points |
| native exit callback and fan-out | 315-416 | `domains/session/exit.ts` plus `app/coordinator.ts` | Classify in session; coordinate consequences in app |
| hydration, saves, secrets, flush | 419-589 | `infrastructure/persistence/runtime.ts` | Direct store subscriptions and explicit boot lifecycle |
| CLI probing and session launch | 591-651 | `domains/session/controller.ts` | Keep pure `buildLaunch` beside controller |
| template/task session launching | 653-766 | `domains/board/execution.ts` | Template resolution may be a schedules/template service |
| addon API construction and addon agent | 768-821 | `domains/addons/runtime.ts` | Runtime owns API capabilities, histories, and busy state |
| chat registries, MCP, skills, search | 823-936 | `domains/chat/runtime.ts` | Search becomes transcript-only subscription |
| addon lifecycle-hook fan-out | 938-949 | `domains/addons/hooks-runtime.ts` | Explicit subscription/disposal |
| cron and scheduled-task ticker | 951-1094 | `domains/schedules/runtime.ts` | Pure due collectors plus executor |
| Master busy queue and event routing | 1096-1124 | `domains/master/runtime.ts` | Runtime owns queue, dedupe, and workspace routing |
| addon editor and package installation | 1126-1208 | `domains/addons/editor-runtime.ts`, `package-service.ts` | Keep parsing pure; service owns state changes |
| action-hook construction | 1210-1237 | `app/runtime.ts` | Replace hooks with controller action objects |
| composer and Master send | 1248-1275 | `domains/master/actions.ts` | Master owns its chat commands |
| pane/group actions | 1282-1410 | `domains/session/layout-actions.ts` | Pure transitions; no runtime dependencies |
| archive/delete/resume | 1411-1506 | `domains/session/actions.ts` | Delegate side effects to `SessionController` |
| memory/tool/permission actions | 1507-1531 | `domains/session/config-actions.ts` | Pure per-session configuration |
| schedule toggle | 1533-1536 | `domains/schedules/actions.ts` | Existing schedule action surface |
| prompt answer/approve/deny | 1538-1593 | `domains/session/prompt-actions.ts` | Terminal port plus pure resolution transition |
| diff approval/request changes | 1595-1610 | `domains/board/review-actions.ts` | Board owns review workflow |
| new/send/stop session | 1616-1659 | `domains/session/actions.ts` | Thin delegates to controller |
| error and keyboard listeners | 1662-1687 | `app/global-effects.ts` | Runtime/global UI lifecycle, not domain state |

This extraction removes nearly every block from the provider. The remaining
file should instantiate infrastructure ports, construct the runtime, start and
dispose it, and provide actions.

## Controller boundaries

### Session controller

Owns:

- terminal and native process lifecycle;
- CLI id probing;
- output/settle entry points;
- resume, stop, archive, delete, and prompt answers;
- session-keyed runtime disposal.

Does not own:

- board column changes;
- Master messages;
- addon hook execution;
- workspace notification presentation.

It reports typed outcomes to the coordinator instead.

### Board controller

Owns:

- task CRUD and workflow transitions;
- task watcher runtime;
- task-to-session bindings;
- the one canonical task execution path;
- review approval and requested changes.

It asks `SessionController` to launch or stop work; it never invokes native IPC
directly.

### Schedule runtime

Owns time matching, deduplication, one-time disarming, and execution requests.
It asks board to create/start tasks and sessions to launch raw command schedules.
It does not reconstruct task launch commands.

### Chat runtime

Owns chat histories, busy/cancellation state, MCP connections, skill catalogs,
stream batching, and search indexing. Deleting a chat disposes or aborts all
session-keyed work through one method.

### Addon runtime

Owns installation, package replacement, permission-scoped API creation, hook
execution, addon agents, editor histories, and disposal. The previously noted
addon execution sandbox remains a separate security requirement.

### Master runtime

Owns Master history, queue/coalescing, approval continuations, monitor runtimes,
and dispatch through typed application commands. It should not receive the
entire implementation surface as one runner context.

## Refactoring rules for the remaining work

1. Extract ownership, not only code. Every map, timer, and subscription must
   have one creator and one disposer.
2. Domain controllers may depend on narrow ports, never `core/native` wholesale.
3. Domain commands must not accept React refs. Read state through `StatePort`.
4. Pure state transitions remain independent from native and terminal effects.
5. Cross-domain reactions go through `AppCoordinator`, not direct circular
   imports.
6. Every async operation receives an `AbortSignal` when its owner can be
   deleted.
7. Every extraction gets a behavior test before the old block is removed.
8. Keep compatibility re-exports only temporarily and track their import count
   to zero.

## Suggested pull-request sized cuts

### Cut 1: state and clock ports

- Add `StatePort` over Zustand and a browser `ClockPort`.
- Replace `stateRef.current` reads in one small domain with `state.get()`.
- Add fake state/clock implementations for tests.
- No behavior or file deletion yet.

### Cut 2: activity service

- Move `widOf`, `logEvent`, and `notify` into a non-React service.
- Test active/background workspace routing and missing workspace behavior.
- Inject this service into existing runners.

### Cut 3: persistence runtime

- Introduce boot readiness and direct Zustand subscriptions.
- Move all persistence/keychain effects.
- Remove the provider's full state subscription.
- Add debounce, delayed hydration, recovery, and disposal tests.

This is the cut that removes the provider from the streaming hot path.

### Cut 4: session layout and config actions

- Move the large pure section first: pane/group, memory, tool, and permission
  transitions.
- Compose the new `SessionActions` interface into `AppActions`.
- This is low-risk and removes roughly 150 lines.

### Cut 5: session controller

- Move terminal output, launch/probe, resume, send, stop, archive, and delete.
- Introduce native and terminal test doubles.
- Keep the existing exit handler temporarily, calling the new controller.

### Cut 6: exit coordinator

- Extract pure exit classification.
- Emit `SessionExited` and move board/Master/addon/activity reactions to the
  application coordinator.
- Test user stop, clean ephemeral exit, failed ephemeral exit, normal exit, task
  session, and auto-archive.

### Cut 7: board execution and scheduler

- Unify active/background task launch.
- Move watcher registries into board runtime.
- Replace the interval body with pure collectors and an executor.

### Cut 8: chat, addon, and Master runtimes

- Move one runtime at a time, including its histories, busy state, queues,
  subscriptions, cancellation, and disposal.
- Do not extract only runner calls while leaving their registries in the root.

### Cut 9: final composition cleanup

- Move keyboard/error effects.
- Remove remaining declaration-cycle refs.
- Replace `store.tsx` with a temporary compatibility export.
- Verify the final provider is below approximately 200 lines.

## Recommended execution plan

### Checkpoint 0: finish the active selector batch

1. Complete and commit the current `shallowEqual`/selector changes.
2. Change `MainArea` to select only `view`.
3. Add tests for `shallowEqual` and root render isolation.
4. Run TypeScript, tests, and lint before starting another extraction.

Do not mix the active component migration with runtime ownership changes.

### Phase 1: correct contracts and imports

1. Export an action interface from each domain.
2. Compose `AppActions` in `app/actions.ts`.
3. Remove every domain import of the application-wide action contract.
4. Migrate all `core/state-lib` consumers to direct owner imports.
5. Delete the compatibility barrel when its import count reaches zero.

This is low-risk and makes later dependency violations obvious.

### Phase 2: remove the provider hot subscription

1. Mirror Zustand into `stateRef` through `useAppStore.subscribe`.
2. Extract chat indexing into a direct subscription owned by chat.
3. Extract persistence subscriptions and debounce timers.
4. Remove `const state = useAppStore()` from `ConductorProvider`.
5. Add a render-count test proving terminal output does not rerender the
   provider or replace `ActionsCtx`.

Expected outcome: terminal and chat streaming bypass the root composition
function completely.

### Phase 3: establish boot and persistence runtime

1. Introduce the non-persisted boot lifecycle.
2. Move hydration, keychain, terminal restoration, and save ownership into the
   persistence runtime.
3. Gate MCP, skill, scheduler, search, and other startup effects on `ready`.
4. Add delayed-hydration and cleanup tests with fake timers.
5. Replace or strengthen the asynchronous `beforeunload` flush path.

### Phase 4: extract the complete session domain

1. Add pure session state transitions and tests.
2. Create `SessionController` with native and terminal ports.
3. Move launch, probe, resume, send, stop, archive, delete, and disposal.
4. Move pane/group actions to session layout actions.
5. Convert native exits to typed session-exit results.
6. Keep cross-domain exit fan-out in an application coordinator.

Do not move the current exit callback wholesale into the session folder; first
separate session classification from board/Master/addon consequences.

### Phase 5: extract activity, board execution, and scheduler

1. Create a workspace-aware activity/notification service.
2. Give the board one task execution service for active and background work.
3. Move watcher registries into a board runtime with cancellation/disposal.
4. Replace the scheduler block with pure due collectors and an executor.
5. Test all workspace and time variants with fixed state and clock fixtures.

### Phase 6: extract chat, addon, and Master runtimes

1. Move chat histories, busy state, MCP sessions, skill catalogs, and indexing
   behind one chat runtime.
2. Move addon histories, busy state, installation, hooks, and editor execution
   behind one addon runtime.
3. Move Master queueing, approvals, histories, and event routing behind one
   Master runtime.
4. Give every keyed runtime cancellation and deterministic disposal.
5. Replace declaration-order refs with a small typed runtime-port object only
   where a real cycle remains.

### Phase 7: finish consumer isolation and cleanup

1. Replace remaining production `useConductor()` calls with domain selectors.
2. Split oversized views after their state dependencies are narrow.
3. Move `ConductorProvider` to `app/AppProvider.tsx` as a composition root.
4. Keep `store.tsx` temporarily as a compatibility re-export, then remove it.
5. Update `AGENTS.md` and architecture documentation to match the final tree.

## Phase gates

Run after every phase:

```sh
cd app
npx tsc --noEmit -p tsconfig.app.json
npm test
npm run lint
cd src-tauri && cargo check
```

Add a behavior-focused test before moving a lifecycle block. A lower line count
is not sufficient evidence that a phase is complete.

## Revised definition of done

- `ConductorProvider` does not subscribe to complete application state.
- Terminal output and chat streaming do not rerender the composition root.
- No production component uses the full `useConductor()` hook.
- Domains export their own action and controller contracts.
- No domain imports `app/actions.ts` or the `core/state-lib.ts` barrel.
- Hydration has one explicit readiness boundary and gates dependent runtimes.
- Persistence owns its subscriptions, timers, flush, and cleanup.
- Session lifecycle has one controller and one typed exit result.
- Scheduler and board use one task-launch path in every workspace.
- Every mutable runtime registry has one owner and deterministic disposal.
- Cross-domain coordination occurs through typed ports, not dependency bags.
- `AppProvider.tsx` is a composition root under approximately 200 lines.
- Existing persisted data, live PTY reattachment, and Tauri IPC behavior remain
  compatible.

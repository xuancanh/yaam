# Store domain refactor plan

> Historical plan. The runtime extraction described here has largely shipped;
> `store.tsx` is now lifecycle glue around a plain `AppRuntime`. Use
> [architecture.md](architecture.md) and [frontend-domains.md](frontend-domains.md)
> for the current implementation. The body is preserved as design history.

## Current assessment

The application is already partially domain-oriented. The actual Zustand state
container in `app/src/core/store.ts` is small. The 2,184-line
`app/src/store.tsx` is primarily an application runtime and composition root.

It currently owns:

- the global action contract;
- session and PTY lifecycle;
- prompt and settle detection;
- monitor and task-watcher runtimes;
- persistence and hydration;
- session launching and resuming;
- chat, MCP, and skill runtime state;
- addon agents and editor runtime;
- cron and scheduled-task execution;
- Master orchestration;
- remaining session and layout actions;
- global error and keyboard effects.

Splitting this into Zustand slices would only move the complexity. The goal is
to extract domain controllers, pure state transitions, and lifecycle effects,
leaving a small application composition root.

## Current problems

### The provider and action context are globally reactive

`ConductorProvider` subscribes to the entire Zustand state through
`useAppStore()`. Terminal output, chat streaming, and transient UI updates all
rerender the provider.

Domain action hooks also include their complete inline `ctx` objects in their
dependency arrays. Those objects are recreated on each provider render, causing
the domain action objects and `ActionsCtx` value to change as well.

There are currently 21 production components using the full `useConductor()`
subscription and only one using `useConductorSelector()`.

### Domain modules depend on the root store

Domain action modules define their contracts using
`Pick<ConductorActions, ...>` imported from `store.tsx`. This creates the wrong
dependency direction:

```text
store.tsx -> domain actions -> store.tsx types
```

Each domain should own its action interface. The application layer should
compose those interfaces into `AppActions`.

### `core/state-lib.ts` mixes unrelated domains

It currently contains persistence selectors, cron parsing, prompt detection,
board prompt construction, session command utilities, workspace swapping, pane
layout state, and template command generation. These functions should move to
the domain that owns them.

## Target structure

```text
app/src/
  app/
    AppProvider.tsx
    actions.ts
    context.ts
    hooks.ts
    runtime-ports.ts
    store.ts
    global-effects.ts

  infrastructure/
    native/
    persistence/
      schema.ts
      migrations.ts
      hydrate.ts
      repository.ts
      secrets.ts
      use-persistence.ts

  domains/
    activity/
      actions.ts
      service.ts
      state.ts

    session/
      actions.ts
      controller.ts
      runtime.ts
      lifecycle.ts
      settle.ts
      prompt-detection.ts
      layout-state.ts
      command.ts
      selectors.ts

    board/
      actions.ts
      runtime.ts
      task-state.ts
      task-prompt.ts
      watcher.ts
      watcher-runner.ts

    schedules/
      actions.ts
      cron.ts
      scheduler.ts
      template-command.ts

    chat/
      actions.ts
      runtime.ts
      runner.ts
      search-index.ts

    master/
      actions.ts
      runtime.ts
      runner.ts
      monitor-runner.ts

    addons/
      actions.ts
      runtime.ts
      addon-api.ts
      addon-agent.ts
      addon-editor.ts

    settings/
    workspace/
    shell/

  shared/
    id.ts
    types.ts
```

Persistence belongs under `infrastructure`, not a synthetic business domain.
`AppProvider` belongs under `app` because its only responsibility should be
composition.

## Domain ownership

### Session domain

Move the following responsibilities out of `store.tsx`:

- settle and prompt detection;
- terminal output handling;
- CLI session probing;
- launching, resuming, stopping, archiving, and deleting sessions;
- terminal/runtime cleanup;
- pane and session actions;
- native process-exit handling.

Expose a narrow controller:

```ts
interface SessionController {
  launch(input: LaunchSessionInput): string | null
  resume(id: string): void
  stop(id: string): void
  archive(id: string): void
  remove(id: string): void
  send(id: string, text: string): void
  armResponseWatch(id: string): void
  disposeRuntime(id: string): void
}
```

Pure session state transitions should be separate from native and terminal side
effects. Side effects must remain outside store updaters.

### Persistence infrastructure

Separate:

- pure parsing and migrations;
- main-state serialization;
- per-session serialization;
- keychain synchronization;
- Zustand subscription effects;
- terminal reattachment after hydration.

Hydration should return data rather than dispatching and creating terminals
inside the parser:

```ts
interface HydrationResult {
  statePatch: Partial<AppState>
  restoredSessions: Agent[]
  liveSessionIds: Set<string>
}
```

### Activity domain

Move workspace resolution, event logging, and notification routing into one
service:

```ts
interface ActivityService {
  log(type: EventType, agentId: string | null, text: string): void
  notify(
    kind: NotifKind,
    title: string,
    detail: string,
    agentId: string | null,
  ): void
}
```

### Schedules domain

Split scheduler behavior into pure selection and side-effect execution:

- `collectDueSchedules(state, now)`;
- `collectDueTasks(state, now)`;
- `useScheduler(executor)`.

The scheduler should depend on session and board interfaces rather than calling
their implementation details.

### Board domain

The board owns task workflow. The session domain owns process creation.
`BoardRuntime` should call `SessionController` when a watcher or scheduled task
needs a worker.

Move task-session launching and watcher-first start behavior out of the root
provider.

### Chat domain

Move chat histories, busy state, MCP sessions, skill catalogs, chat runner
wiring, and chat-search indexing into the chat domain.

Search indexing should react only to transcript changes, not every agent status
or terminal update.

### Addons and Master

Move addon agent/editor histories, addon installation, and addon runtime wiring
into `domains/addons/runtime.ts`.

Move Master queueing, approvals, message sending, and runner composition into
`domains/master/runtime.ts` and `domains/master/actions.ts`.

## Handling dependency cycles

Master, sessions, task watchers, and addons currently form genuine callback
cycles. Replace the scattered declaration-order refs with one typed runtime port
object:

```ts
interface RuntimePorts {
  masterEvent(note: string, agentId?: string): void
  monitorEvent(sessionId: string, note: string): void
  runWatcher(taskId: string, note: string): void
  fireAddonHook(name: AddonHookName, event: unknown): void
}
```

`AppProvider` creates this object once. Domains register their implementations.
This preserves explicit contracts without adding a generic event bus.

## Migration sequence

### Phase 1: Stabilize contracts and subscriptions

1. Move `ConductorActions` to `app/actions.ts`.
2. Let each domain export its own action interface.
3. Define `AppActions` as the intersection of the domain action interfaces.
4. Remove domain imports from root `store.tsx` types.
5. Stop `AppProvider` from subscribing to the complete state.
6. Use `useAppStore.getState()` for imperative reads.
7. Give effects narrow selector subscriptions.
8. Remove raw `ctx` objects from action-hook dependency arrays.
9. Add a render test proving terminal output does not replace `ActionsCtx`.

This phase should happen first because otherwise moving files preserves the
current app-wide rerender behavior.

### Phase 2: Split `state-lib.ts`

Move functions without changing behavior:

| Current responsibility | Destination |
| --- | --- |
| Persistence selectors and schema version | `infrastructure/persistence/schema.ts` |
| Cron parsing and display | `domains/schedules/cron.ts` |
| Prompt regex and option extraction | `domains/session/prompt-detection.ts` |
| Board task prompt and contract | `domains/board/task-prompt.ts` |
| Pane and tab-group helpers | `domains/session/layout-state.ts` |
| Workspace scoping helpers | `domains/workspace/state.ts` |
| Template command construction | `domains/schedules/template-command.ts` |
| Session command/send helpers | `domains/session/command.ts` |
| ID generation | `shared/id.ts` |

Move the existing tests with their functions.

### Phase 3: Extract persistence

Move hydration, backup recovery, per-session saves, and secret synchronization.
Do not change the persisted schema during this phase.

Add migration fixtures and round-trip tests before changing any data shape.

### Phase 4: Extract the session runtime

Move terminal lifecycle, settle detection, process-exit handling, launch/resume,
and session actions.

Introduce injectable native and terminal adapters so lifecycle tests do not
need real PTYs.

### Phase 5: Extract activity, board, and scheduler

These domains should consume the session controller interface rather than its
implementation.

Do not redesign active/inactive workspace storage in this phase. Establish
ownership and tests first; change the state representation separately.

### Phase 6: Extract chat, addons, and Master

Use `RuntimePorts` for the remaining cyclic callbacks. After this phase,
`AppProvider` should contain only domain creation, lifecycle-hook registration,
and action composition.

An approximate final provider:

```tsx
function AppProvider({ children }: { children: ReactNode }) {
  const runtime = useAppRuntime()
  const session = useSessionDomain(runtime)
  const board = useBoardDomain(runtime, session)
  const schedules = useSchedulesDomain(runtime, session, board)
  const chat = useChatDomain(runtime)
  const addons = useAddonsDomain(runtime, session, board)
  const master = useMasterDomain(runtime, session, board, addons)

  usePersistence(runtime, session)
  useGlobalEffects()

  const actions = useMemo(
    () => composeActions(session, board, schedules, chat, addons, master),
    [session, board, schedules, chat, addons, master],
  )

  return <ActionsCtx.Provider value={actions}>{children}</ActionsCtx.Provider>
}
```

### Phase 7: Migrate component subscriptions

Add selectors owned by each domain:

```ts
useSession(id)
useActiveWorkspace()
useBoardTasks()
useShellState()
useSettings()
```

Keep `useConductor()` temporarily as a compatibility API. Remove it after no
production component subscribes to the complete state.

## Testing requirements

Each extraction should add or relocate tests alongside the owning domain:

- persistence migration, round-trip, and recovery fixtures;
- session settle and prompt detection;
- session cleanup and process-exit classification;
- scheduler behavior with a fixed clock;
- workspace activity routing;
- task-session lifecycle;
- stable action-context rendering;
- selector render isolation;
- runtime port registration and cleanup.

Run after each phase:

```sh
cd app
npx tsc --noEmit -p tsconfig.app.json
npm test
npm run lint
cd src-tauri && cargo check
```

## Definition of done

- `store.tsx` is removed or retained only as a compatibility re-export.
- `AppProvider.tsx` is a small composition root, ideally under 200 lines.
- Domain modules do not import action types from the application composition
  root.
- Terminal and chat streaming do not rerender unrelated action consumers.
- Production components use domain selectors rather than whole-state reads.
- Persistence parsing and migrations are pure and fixture-tested.
- Session, scheduler, Master, watcher, chat, and addon runtimes have explicit
  dependency interfaces.
- Existing persisted state and frontend IPC behavior remain compatible.

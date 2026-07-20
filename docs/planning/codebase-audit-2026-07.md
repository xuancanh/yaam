# YAAM Codebase Audit & Roadmap — July 2026

A full-repo audit covering architecture, performance, usability, security,
correctness, reliability, maintainability, and code quality. Every finding is
evidence-based with `file:line` citations. Method: static deep-read of the
frontend core, LLM/agent domains, Rust backend, addon platform, plus dedicated
performance and UX/code-quality passes. No runtime profiling was performed;
findings marked "confirmed" have a traced mechanism, "suspicion" means the
code path exists but impact needs measurement.

---

## 1. Architecture summary (verified against code)

- **One Zustand store** (`app/src/core/store.ts`) holds all state;
  `dispatch(updater)` full-replaces with no-op-by-reference semantics.
  Non-React `AppRuntime` (`app/src/app/conductor-runtime.ts`) wires four plain
  subsystems (session, addon, chat/boot, master/scheduler) through cycle refs.
  Components read via `useConductorSelector` with an equality cache.
- **Persistence**: two partitions — main blob (`conductor-state.json`) and one
  diff-written file per session — driven by direct store subscriptions with
  800 ms debounced writers, per-partition serialized write chains, keychain
  credential redaction, and atomic Rust writes (temp+fsync+rename+`.bak`).
  Close is vetoed for a 3 s-bounded flush.
- **Multi-window**: main window is the sole persistence writer and runs
  Master/scheduler/addons; workspace satellites (`?win=ws&ws=<id>`) forward
  their slice via `ws:sync` every 1.5 s and `ws:reattach` on close.
- **PTY pipeline (Rust)**: 3 threads per session — reader (8 KB reads →
  bounded `sync_channel(256)`), emitter (coalesces backlog ≤ 64 KB → base64
  `session-data` broadcast), reaper. No app-wide tokio runtime; blocking work
  uses `spawn_blocking`.
- **LLM hierarchy**: one global Master (10-iteration tool loop, integrity
  check, single-slot event queue) ← per-session monitors (capped history,
  only `report_to_master` escalates) ← per-task watchers (mini-Masters that
  own spawning, ≤ 3 concurrent sessions). Chat agents have their own 24-round
  streaming loop with per-chat token budget and auto-compaction.
- **Addon platform**: JSON packages; views in opaque-origin iframes with
  injected CSP + postMessage RPC; tool/hook JS compiled via `new Function` in
  a shared hidden iframe; `enforcePermissions` wraps a per-addon `AddonApi`;
  fresh installs auto-grant only low-risk scopes.

The architecture is genuinely well thought out: output batching (one dispatch
per 100 ms window), write gating, identity-diffed session writes, StrictMode
discipline, abort registries, history sanitization with tests, symlink-safe
path resolution, and a tight Tauri ACL are all correctly implemented. The
problems below are concentrated at the **seams**: satellite/main interplay,
sandbox rule ordering, LLM trust boundaries, and render granularity.

---

## 2. Security findings

### Critical / High

| # | Finding | Evidence | Fix |
|---|---------|----------|-----|
| SEC-1 | **macOS Seatbelt profile: `.git/config`/`.git/hooks` deny is nullified by rule order.** SBPL is last-match-wins; the git deny rules are emitted *before* the writable-root allow, so a sandboxed agent can rewrite `.git/config` (`core.hooksPath`, URL rewrites) → code execution on the user's next unsandboxed git op. The Linux bwrap path does it correctly (ro-binds after writable binds), confirming intent. Existing test only string-matches the profile. | `src-tauri/src/domains/sandbox.rs:146-169` vs `252-258`; test `294-308` | Emit git deny rules **after** the writable-root allows; add a behavioral `sandbox-exec` test |
| SEC-2 | **Master-created addons bypass the dangerous-scope invariant.** `create_addon` grants every requested scope (`sessions:*`, `tasks`, `schedules`, `agent`, `master:prompt`, `http`, `secrets`, `exec`) while every other install path strips dangerous scopes and `create_addon` defaults to `perm: 'Auto'`. A prompt-injected Master can mint a persisted, fully-privileged addon whose `masterPromptAppend` then shapes Master's own prompt — a standing privilege-escalation/persistence primitive. | `app/src/domains/master/runner.ts:205`; `core/addons.ts:126-128,622-627`; contrast `hydrate.ts:179`, `addons/runtime.ts:102-104` | Filter grants through `!DANGEROUS_PERMISSIONS.includes(g)` like the normal path |
| SEC-3 | **View CSP injection is bypassable → addons can phone home.** `withViewCsp` regex-replaces the *first* `<head` match; HTML starting with `<!-- <head> -->` (or a string containing `<head>`) gets the CSP injected into a comment, leaving the document CSP-free with full network via the `https://**` HTTP ACL. Defeats the documented "cannot phone home" invariant; a malicious addon with `state:read` can exfiltrate the full state snapshot. | `app/src/domains/addons/AddonView.tsx:86-93,181-189`; `capabilities/default.json:22-35`; `docs/addons.md:582-588` | Prepend `<meta CSP>` unconditionally; never regex-replace into addon-controlled bytes |
| SEC-4 | **Plugin-hook addons are dead on arrival (and the `exec` scope is unreachable).** Translated Claude plugin hooks call `api.exec(...)`, but `exec` is not in `ADDON_RPC_METHODS`, so the sandbox never creates it and the host would reject it; the generated body also references `event` while the sandbox binds `input`. The `exec` permission, guard, and implementation are all dead code; tests only string-match. An advertised feature cannot work. | `settings/plugin-market.ts:80-87`; `core/addons.ts:249-260`; `addons/sandbox.ts:56-78,127-129`; `hooks-translate.test.ts` | Add `'exec'` to `ADDON_RPC_METHODS`, emit `input` in the translator, add a test that executes a translated hook |
| SEC-5 | **Unmarked untrusted terminal output flows up the entire LLM chain.** Raw screen text (up to 12k chars) enters watcher/monitor notes, monitor digests reach Master, and Master's system prompt embeds 12 raw log lines per session every iteration — with no delimiters and no "this is data, not instructions" rule anywhere. Combined with `launch_session`/`send_to_session` defaulting to `Auto`, terminal output is a live prompt-injection vector. | `use-settle.ts:124-131`; `monitor-runner.ts:93-97`; `master/prompt.ts:33`; `settings/slice.ts:66-67` | Wrap terminal-derived text in delimiters + standing untrusted-data rules in monitor/watcher/Master prompts |

### Medium

| # | Finding | Evidence | Fix |
|---|---------|----------|-----|
| SEC-6 | Remote companion: plaintext HTTP, bearer tokens in URLs, bound to `0.0.0.0` including public interfaces; command set includes `session_input`/`prompt_approve`/`approve_master`. Any on-path party on a hostile LAN gets full remote control. | `remote.rs:445,486-488,68-75` | Warn/refuse public interfaces; document trusted-LAN-only; plan TLS |
| SEC-7 | `pair_status` collapses the two-factor model: anyone with the URL token can retrieve any paired device's token (client-chosen, often guessable device ids). | `remote.rs:300-311,284` | Return device token once at approval time, or require a pairing nonce |
| SEC-8 | Shared handler sandbox for all addons: sequential `callId`s let one addon's handler ride another in-flight call's permissions; the shared JS realm lets a handler leave a `message` listener behind and read other addons' source + state snapshots. | `addons/sandbox.ts:108,124-131,151,169,184-188` | Crypto-random callIds; per-addon (or per-run) frames |
| SEC-9 | Dev-watch hot-reinstall silently swaps privileged addon code: no permission preview, grants preserved, anything that can write the watched folder (including a YAAM session itself) can replace handler code holding `sessions:*`/`tasks` grants. | `addons/actions.ts:220-221`; `dev-watch.ts:64-72` | On dev reinstall with dangerous grants and changed bytes, warn or require re-confirm |
| SEC-10 | Worktree metadata `.yaam-worktree.json` lives in the agent's cwd and its `repo.source` is trusted for merge/remove without verification — a tampered file steers git ops at arbitrary repos. | `worktree.rs:109-138,293-325` | Verify `source` via `git rev-parse --git-common-dir`, or keep metadata in app state |
| SEC-11 | Master can rewrite its own tool gates via `set_tool_permission` (defaults to Ask first, but one "Always" click removes the only check between injection and `--dangerously-skip-permissions` templates). | `master/runner.ts:155-167`; `slice.ts:72` | Hard-require the Settings UI (not chat approval) to raise any tool to Auto |
| SEC-12 | `hosts` allowlist admits TLD wildcards (`*.com` passes and matches every `.com` host); same lax regex duplicated in the registry validator. | `core/addons.ts:559,319-324`; `scripts/validate-registry.mjs:18` | Require ≥2 labels after `*.`; reject bare-TLD wildcards in both places |

### Low (noted)

- `copy_path` source is unscoped — workspace read-scoping is advisory, consistent with the current agent trust model but worth a decision (`fs.rs:289-293`).
- Writable agent state roots (`~/.claude` etc.) let a sandboxed agent plant CLI hooks/settings that run outside the sandbox later — deliberate, needs a doc note (`sandbox.rs:18`).
- Secrets cached in plaintext process memory indefinitely (`secrets.rs:14-34`) — acceptable tradeoff.
- `preview_stash` caps count (32) not bytes (`preview.rs:40-53`).
- `installAddonJson` bypasses the consent preview for plugin imports (`addons/actions.ts:77-79`).
- Registry supply chain: no signature/hash pinning for third-party registries (`AddonsView.tsx:33-45`).
- `send_to_session` text not sanitized for embedded newlines/control chars (`command.ts:37-40`).
- CSP `object-src data: blob:` could be `'none'` (`tauri.conf.json:29`).

---

## 3. Correctness & reliability findings

### High — multi-window data integrity (the worst cluster in the repo)

| # | Finding | Evidence | Fix |
|---|---------|----------|-----|
| REL-1 | **Quitting main destroys satellites and discards their unsynced edits.** `closeAllSatellites` uses `w.destroy()`, which skips the close handshake (no `ws:reattach`), and main flushes *before* destroying — so even a late reattach would never persist. Every edit since the last 1.5 s sync is lost on quit. | `infrastructure/native/windows.ts:91-93,34-37`; `conductor-runtime.ts:181-185` | Use `w.close()`, await each `ws:reattach` merge, then flush, then destroy |
| REL-2 | **Scheduler fights satellite sync: crons in a detached workspace re-fire every ~15 s.** Main fires crons for detached pools and records `lastFiredMinute` into `workspaceData[wid].crons`; the satellite's next `ws:sync` wholesale-replaces the slice, wiping the marker → refire loop. Same mechanism deletes freshly scheduled board tasks and orphans their sessions. | `schedules/runtime.ts:56-71,119-124`; `workspace/actions.ts:291-301` | Exclude `detachedWorkspaces` from scheduler pools, or field-merge instead of slice-replace |
| REL-3 | **Main keeps monitoring satellite-owned sessions** — duplicated LLM monitor spend, repeated spurious needs-input flags, wrong-window notifications. Settle/scan/monitor loops have no workspace guard. Docs call it "harmless"; it costs real tokens. | `hydrate-effect.ts:56-57`; `use-settle.ts:283-315`; `runtime/session.ts:73-78`; `docs/architecture.md:316-321` | Filter settle/scan/monitor/watcher loops by `!detachedWorkspaces.includes(...)`; dispose terminal entries on detach |

### Medium

| # | Finding | Evidence | Fix |
|---|---------|----------|-----|
| REL-4 | Satellite can become a **second writer of `conductor-state.json`**: `markReady()` is unconditional; if the file holds a plaintext credential the satellite's `armSecret` path calls `saveStateFile` directly, racing main's writer. | `hydrate-effect.ts:128`; `persistence/runtime.ts:195,162` | Pass `isMain` into `markReady`; skip secret migration in satellites |
| REL-5 | "Satellites don't run Master" is only accidentally true — the only gate is the scheduler ticker; the escalation path is live and neutralized solely because satellites lack resolved secrets. A credential command makes every satellite run a full Master. | `conductor-runtime.ts:171-172`; `runtime/master.ts:75-90` | Thread `role` into the Master subsystem; no-op `runMaster` in satellites |
| REL-6 | `SessionManager::write` holds the global sessions mutex across a blocking `write_all` to the PTY master — a child that stops draining stdin wedges kill/spawn/resize for **all** sessions. | `session.rs:397-405` | Non-blocking writer or per-session writer lock behind `Arc` |
| REL-7 | PID-reuse race: sleep 2 s then unconditional `kill(pid, SIGKILL)` / `kill(-pid, …)`; a recycled pid kills an unrelated process. Same in `detached_kill` (pid from an on-disk spec, no liveness check). | `session.rs:199-218`; `detach.rs:413-424` | Reap via child handle first; verify liveness/identity before signaling |
| REL-8 | Master event queue is a single slot — a second event overwrites the first while busy; monitor reports are silently dropped. | `master/runner.ts:58-61` | Accumulate queued notes into an array, join into the next turn |
| REL-9 | Auto-compaction triggers on **cumulative billed tokens**, not context size: a 5-round tool turn with 20k context reads as 100k → compaction fires wrongly and keeps re-triggering (an extra LLM call each time). | `chat/agent.ts:737-740`; `chat/runner.ts:576,663` | Trigger on the last round's `inputTokens`; keep the sum for billing only |
| REL-10 | Deterministic scanner overrides LLM monitor decisions: `scanTui`/`onSettle` clear `status: 'needs'` whenever regexes don't match, silently undoing a monitor's context-aware `flag_needs_input` within ~4 s (flag flapping). | `use-settle.ts:305-313,191-200` | Only auto-clear flags the deterministic path itself set (track provenance) |
| REL-11 | Plain-terminal prompt detection false-positives: any last line ending in `:`/`?`, and bare substrings like `permission`/`confirm`, flag needs-input and fire Master events (`permission denied`, `error:`, `Done:`). | `prompt-detection.ts:6,38`; `use-settle.ts:167-179` | Require an interactive signal (no output since input, cursor at EOL) or much stricter patterns |
| REL-12 | Watcher note queue unbounded while busy (monitor's is capped at 8); notes join into one huge user message → memory growth + token spike on drain. | `watcher-runner.ts:89-92` vs `monitor-runner.ts:39` | Cap the queue (`.slice(-12)`) |
| REL-13 | No spawn budget per task: watcher caps concurrency at 3 but can respawn sequentially forever — a misjudging watcher burns money in a respawn loop. | `watcher-runner.ts:214-215`; `exit-handler.ts:166-170` | Cap total spawns per task (~5), then require user approval |
| REL-14 | `removeSession` bypasses the per-session write chain — a queued save can land after the delete and resurrect the session on next boot. | `native/persistence.ts:64-73` | Route removal through the same per-id chain |
| REL-15 | Infinite retry loop on persistent session-save failure (e.g. full disk): failed write re-arms the 800 ms writer forever. | `persistence/runtime.ts:81-89` | Exponential backoff with give-up after N attempts |
| REL-16 | No retry/backoff on transient API errors (429/500/529 fail the turn); watcher posts `Watcher error:` into the task chat on *every* failed turn → flood on persistent failure. | `llm/client.ts:269-272` (only 401/403 retry); `watcher-runner.ts:269-278`; `master/runner.ts:353-365` | One bounded retry with backoff; dedupe consecutive identical error messages |
| REL-17 | Uncapped final addon-handler result is stringified into Master's tool result — a huge/cyclic return blows up Master context or throws. | `addons/sandbox.ts:132,139-145`; `core/addons.ts:647` | Apply `capSize` to the `yaam:result` value |
| REL-18 | Unbounded addon hook queue + possible cross-addon hook loops (`tasks.move` fires `onTaskMoved`; two addons can ping-pong a task forever). | `core/addons.ts:673-689`; `addon-api.ts:159` | Cap chain length (drop+log); per-task move-bounce guard |

### Low (selected)

- Git subprocesses have no timeout and no output cap (unlike `exec_command`) — a wedged git hangs the IPC call forever (`git.rs:56-81`, `worktree.rs:51-61`).
- Mutex-poison `unwrap()`s across all Rust domains; one panicking holder poisons every later command (`session.rs:37`, `mcp.rs:69`, `remote.rs`, …). `secrets.rs:22` already has the right pattern.
- MCP: stdout reader stalls a chatty server on a full queue; `Proc::drop` kills only the direct child, grandchildren survive (`mcp.rs:111-120,20-25`).
- One 300 s sleep thread per exited session (`session.rs:386-389`).
- `atomic_write` leaks its temp file on mid-write error; post-rename dir-fsync failure misreports a landed write as an error (`state.rs:52-77`).
- Watchers/monitors not reconciled after restart — a task whose session died while closed parks in `progress` until poked (`hydrate.ts:93`; `exit-handler.ts:125`).
- Legacy session fallback can resurrect deleted sessions; an unparseable main partition discards parseable session files (`loaders.ts:49-59`).
- OpenAI stream tool-name accumulation (`+=`) corrupts names if a compat provider resends them per delta (`client.ts:625`).
- 401/403 retry abandons the first response body unread (`client.ts:268-272`).
- Monitor queue leak on abort-then-rerun race (`monitor-runner.ts:117-120`).
- `report_to_master` sets `attention` even for `importance: 'info'` (`monitor-runner.ts:87-90`).
- `masterPromptAppend` prompt-source ordering — addon hooks can persist injection into Master's prompt (see SEC-2).

---

## 4. Performance findings

Ranked by likely user impact. Method: static trace of dispatch → subscription → render paths; rates are derived from timer intervals, not profiler readings.

| # | Finding | Evidence | Type | Fix |
|---|---------|----------|------|-----|
| PERF-1 | **The whole shell re-renders at ~10 Hz whenever any terminal streams.** `flushTail` replaces the `agents` array every 100 ms; there is **no `React.memo` anywhere in `app/src/domains`**. Hot subscribers: `Workspace` (every `Pane`→`TerminalPane`), `Sidebar` (every `MessageRow`), `Board` (re-filters all tasks into 5 columns), `TitleBar`, `ChatView`, Timeline, ControlCenter. A busy `npm install` re-renders the tab bar and Master conversation 10×/s. | `attention.ts:50-69`; `use-settle.ts:84-88`; `Workspace.tsx:273`; `Sidebar.tsx:234,377`; `Board.tsx:493` | quick + structural | `React.memo` on `Pane`/`Card`/`MessageRow`/`Bubble` (agent refs are stable for unchanged rows); longer-term move hot fields (`log`/`used`/`responding`/`attention`) into a separate `agentHot` slice |
| PERF-2 | Monitor cost scales with output rate, not significance: a full monitor LLM turn every 8 s per streaming session (dedupe only on byte-identical content). N scrolling builds = N LLM calls per 8 s, indefinitely. **The largest token burn in the system.** No token budget on monitors/watchers. | `use-settle.ts:79,135-142,120-121` | structural | Exponential checkpoint backoff (8 s→30 s→2 m); skip when screen tail unchanged modulo last lines |
| PERF-3 | Master re-serializes the full system prompt + live state (incl. per-session log tails) every iteration, up to 10×/turn, with no `cache_control` breakpoints. | `master/master.ts:35-36`; `master/prompt.ts:10-59` | structural | `cache_control` on the static block (Anthropic); move volatile state to a trailing user message |
| PERF-4 | Master message list is unbounded in state and fully re-rendered on every `agents` change (persistence slices to −60; state never caps). | `master/actions.ts:49,58`; `schema.ts:46`; `Sidebar.tsx:377` | quick | Cap in-state `messages` (`.slice(-400)`) at append sites |
| PERF-5 | Every PTY byte is decoded twice and ANSI-stripped even for alt-screen TUIs (the common case, where the plain-line tail is barely used); TUI `pending` buffer re-splits 4 KB per 8 KB event. Plus base64 (+33%) on the wire both ways. | `terminals.ts:110-118`; `native/session.ts:59-64`; `session.rs:346-362` | quick + structural | Skip decode/ANSI path for alt-screen buffers; consider binary payload instead of base64 |
| PERF-6 | Per-chunk settle-timer churn: `bumpSettle` disposes+recreates a timer and does an `agents.find` per PTY chunk (hundreds/s on a busy session). | `terminals.ts:109`; `use-settle.ts:253-264` | quick | Trailing-edge debounce that skips re-arm while a timer is pending |
| PERF-7 | Remote companion publishes a full state snapshot (~3/s during streaming) while a phone is connected. | `RemoteCompanion.tsx:206-209,173-183` | quick | 1 s debounce or reference-change gating |
| PERF-8 | Chat streaming re-renders up to 200 un-memoized `Bubble`s per animation frame. | `chat/runner.ts:419`; `ChatPane.tsx:674-699` | quick | `memo(Bubble)` |
| PERF-9 | Background git polling: full unified `worktreeDiff` per worktree session every 15 s. | `diff-stats.ts:82-127` | quick | numstat-style summary in the sweep |
| PERF-10 | No list virtualization anywhere (Master messages and accumulated board tasks are the only truly unbounded lists). | `Board.tsx:556`; `Sidebar.tsx:377` | structural | Window the Sidebar/Board lists past ~100 items |
| PERF-11 | PTY hot path emits one base64 IPC event per 8 KB read when the webview keeps up (coalescing only under backpressure); per-chunk `to_vec()` for the tap broadcast even with no remote device. | `session.rs:346-362,44-53` | structural | Short (~4–8 ms) drain window; skip broadcast alloc when `receiver_count() == 0` |

Already done well (don't regress): 100 ms output batching with a runaway
guard, backend coalescing + backpressure, diff-written per-session
persistence, incremental debounced search indexing, edge-only `responding`
dispatches, lazy views/CodeMirror/mammoth, WebGL context management,
snapshot-skipping with no phone connected.

---

## 5. Usability findings

| # | Sev | Finding | Evidence |
|---|-----|---------|----------|
| UX-1 | High | **Persistence failure is a 6-second toast** — the only "you may lose data" signal auto-dismisses; no banner, no retry, no sticky state. | `persistence/runtime.ts:55-58`; `Toast.tsx:14-17` |
| UX-2 | Med | CommandPalette has **no arrow-key navigation** — `Enter` always runs `commands[0]`; mouse is the only way to pick anything else. | `CommandPalette.tsx:91-96` |
| UX-3 | Med | **Inconsistent Escape handling**: 6+ dialogs don't close on Esc; the global Esc handler fires even when a terminal has focus (Esc in vim closes the drawer). | `global-effects.ts:106-108`; `AddonsView.tsx:136`; `ChatView.tsx:48,77,95`; `GitPanel.tsx:673` |
| UX-4 | Med | Interactive rows are non-focusable `<div onClick>` (settings sections, ControlCenter, AgentHome card grid) — keyboard users can't reach them. | `ChatAgentSections.tsx:83`; `ControlCenter.tsx:113,179`; `AgentHome.tsx:237` |
| UX-5 | Med | Icon-only buttons rely on `title` tooltips with no `aria-label` (all pane controls, rail, SlideOver close). | `Pane.tsx:60-325`; `IconRail.tsx:79-86` |
| UX-6 | Low | Toast error detection is a regex on message text — unrecognized error strings get the fast-dismiss. | `Toast.tsx:14` |
| UX-7 | Low | Dialogs lack `role="dialog"`/`aria-modal`/focus management (NewSessionDialog has no autofocus). | `NewSessionDialog.tsx:92-100`; `TaskSpecForm.tsx:144` |
| UX-8 | Low | Master loop ending on the integrity-retry marker shows "(acted without a reply)"; chat loop hitting the 24-round cap ends silently. | `master.ts:34,75-78`; `chat/agent.ts:717-746` |

Positive: inline chat errors with retry, kind-appropriate PTY-exit
notifications, `needs-input` escalation, existing empty states.

---

## 6. Maintainability & code quality

Genuinely clean baseline: **zero** `TODO`/`FIXME`/`HACK`, **zero** `as
any`/`@ts-ignore` across `app/src`, consistent `Result<_, String>` at the
Rust boundary, strong test culture in persistence/watchers/settle (110+ test
files), comments that state constraints.

| # | Sev | Finding | Evidence |
|---|-----|---------|----------|
| MNT-1 | High | **Untested critical paths**: `master/master.ts` (the anti-hallucination integrity harness) and `master/tools.ts` have no tests; `llm/client.ts` protocol adapters and `chat/runner.ts` orchestration untested directly. The exact mechanisms that stop hallucinated actions are unlocked by tests. | `master/master.ts:44-56`; `llm/client.ts` (702 LOC); `chat/runner.ts` (726 LOC) |
| MNT-2 | Med | Modal overlay pattern copy-pasted ~14× (CommandPalette, NewSessionDialog, TaskSpecForm, Board ×3, ChatView ×3, AddonsView, AgentHome, GitPanel, Drawer, SlideOver) — this is also the root of the a11y/Escape inconsistencies. One shared `Modal` primitive fixes both. | `CommandPalette.tsx`, `Board.tsx`, `ChatView.tsx`, … |
| MNT-3 | Med | God-files: `MobileApp.tsx` (1148), `core/entities.ts` (1099, 77 exports), `FilesPane.tsx` (939), `ChatPane.tsx` (872 with a 15-arg prop-drill), `chat/agent.ts` (821), `chat/runner.ts` (726), `llm/client.ts` (702). | `wc -l` sweep |
| MNT-4 | Med | Doc drift: `AGENTS.md` omits `mobile/`, `domains/remote/`, `core/entities.ts`, newer `components/`; `docs/addons.md` §3 permission table omits `exec`/`http`/`secrets`; addon-editor prompt describes a stale 6-method API; `AddonSource` renders 3 of 5 hooks; the SDK-compat check is types-only — nothing asserts `ADDON_RPC_METHODS ≡ METHOD_PERMISSION` keys (which is why SEC-4 compiled cleanly). | `AGENTS.md`; `docs/addons.md:210-222`; `addon-editor.ts:32`; `AddonSource.tsx:148-154`; `addon-sdk-compat.ts` |
| MNT-5 | Low | Dead React adapters from the runtime refactor (`useConductor`, `useHydration`, `useSessionAttention`, `useSessionSettle`, `useWorkspaceActions`) + stale comment; silent no-op `subscribe` in ad-hoc StatePorts; duplicated `ICONS` map in CommandPalette; inconsistent chat history caps (58/60). | `store/hooks.ts:12`; `hydrate-effect.ts:29`; `runtime/session.ts:95`; `CommandPalette.tsx:8-16`; `chat/agent.ts:713,819` |
| MNT-6 | Low | YAML subset parser sharp edges: inline `#` comments not stripped, tabs misindent, flow-style lists silently dropped (fails safe but confusing). | `core/addons.ts:361-424` |
| MNT-7 | Low | `toast` as a single string slot in global state blocks error-kind plumbing (root of UX-6); global keyboard handler is a long if/else chain with no per-modal layer. | `Toast.tsx:14`; `global-effects.ts:80-108` |

---

## 7. Roadmap

Ordered by risk-adjusted value. Phases are independently shippable.

### Phase 0 — Stop the bleeding (days, all small diffs)

Security/correctness fixes that are one-to-few-line changes with high blast
radius. Ship together as a hardening release.

1. **SEC-1**: move Seatbelt git-deny rules after writable-root allows + behavioral test.
2. **SEC-2**: filter Master-created addon grants through `DANGEROUS_PERMISSIONS`.
3. **SEC-3**: prepend CSP meta unconditionally (drop the regex).
4. **SEC-4**: add `exec` to `ADDON_RPC_METHODS`, fix `event`→`input` in the hook translator, add an execution test.
5. **REL-1**: graceful satellite close (`w.close()` → await reattach → flush → destroy).
6. **REL-2**: exclude detached workspaces from scheduler pools.
7. **REL-3**: workspace-guard settle/scan/monitor loops for detached workspaces.
8. **REL-4/REL-5**: thread window role into `markReady` and the Master subsystem.
9. **REL-14/REL-15**: route `removeSession` through the write chain; backoff on save failure.
10. **SEC-12**: reject bare-TLD host wildcards (both validators).

### Phase 1 — LLM trust & cost (1–2 weeks)

11. **SEC-5**: delimiters + untrusted-data rules for all terminal-derived LLM input (monitor, watcher, Master prompts, `read_session`).
12. **SEC-11**: raising any tool to `Auto` requires the Settings UI, not chat approval.
13. **PERF-2**: monitor checkpoint backoff (8 s→30 s→2 m) + unchanged-tail skip; add monitor/watcher token budgets.
14. **PERF-3**: prompt caching for Master's static block; volatile state as trailing user message.
15. **REL-8**: Master queue becomes an array; **REL-9**: compaction on last-round tokens; **REL-12/REL-13**: watcher note cap + per-task spawn budget; **REL-16**: bounded retry on 429/5xx + error dedupe.
16. **REL-10/REL-11**: flag provenance (only auto-clear self-set flags) + stricter plain-prompt detection.
17. **MNT-1 (part 1)**: harness tests for the Master integrity check and tool-loop invariants.

### Phase 2 — Rust backend hardening (1–2 weeks)

18. **REL-6**: non-blocking/per-session PTY writer (removes the global-wedge).
19. **REL-7**: child-handle reaping before SIGKILL; liveness checks in `detached_kill`.
20. **SEC-6/SEC-7**: remote server — public-interface warning, `pair_status` token fix; document trusted-LAN model (TLS as a later decision).
21. **SEC-10**: verify worktree `repo.source` against `git-common-dir`.
22. Git timeout/output caps; uniform mutex-poison recovery; MCP queue + process-group kill; shared exit-timer; `atomic_write` temp cleanup.

### Phase 3 — Frontend render performance (1 week, mostly mechanical)

23. **PERF-1/4/8**: `React.memo` on `Pane`/`Card`/`MessageRow`/`Bubble`; cap in-state Master messages; measure with React Profiler before/after.
24. **PERF-5/6**: skip decode/ANSI for alt-screen buffers; trailing-edge settle debounce.
25. **PERF-7/9**: remote snapshot gating; numstat in the git sweep.
26. **PERF-11**: PTY emit drain window + skip tap alloc without receivers.
27. Structural (schedule by measurement): `agentHot` slice split; Sidebar/Board virtualization; binary PTY payload.

### Phase 4 — Addon platform isolation (1 week)

28. **SEC-8**: crypto-random callIds; per-addon sandbox frames (also fixes the co-tenant timeout kill).
29. **SEC-9**: dev-watch re-confirm on privileged code change; **REL-17/REL-18**: result cap + hook queue cap + move-bounce guard.
30. **MNT-4**: sync `docs/addons.md`, addon-editor prompt, `AddonSource` hooks; add a runtime test asserting `ADDON_RPC_METHODS ≡ METHOD_PERMISSION` keys; consent preview for `installAddonJson`.

### Phase 5 — Usability & structural cleanup (ongoing, parallelizable)

31. **UX-1**: sticky persistence-failure banner until a write succeeds; toasts gain a `{kind}` field.
32. **MNT-2**: one `Modal` primitive (Escape, `role="dialog"`, focus trap/restore) adopted by all ~14 overlays — fixes UX-3/UX-7 wholesale.
33. **UX-2**: palette arrow-key selection; **UX-4/UX-5**: `aria-label`s and button-ify clickable divs.
34. **MNT-3**: split `MobileApp`/`FilesPane`/`ChatPane` along the existing view-vs-runner pattern; **MNT-5**: delete dead adapters; refresh `AGENTS.md`.

### Explicit non-goals / accepted risks (document, don't fix now)

- Plaintext remote transport beyond LAN documentation (revisit if remote use grows).
- Plaintext in-memory secrets cache (OS keychain is the store; process memory is trusted).
- Writable `~/.claude`-style state roots in the sandbox profile (CLIs need them).
- `object-src data: blob:` in CSP (PDF preview).

---

## 8. Top 10 if you do nothing else

1. SEC-1 — Seatbelt git-deny rule order (sandbox escape to code exec).
2. REL-1/REL-2 — satellite data loss on quit + cron refire loop (silent, self-sustaining).
3. SEC-2 — Master-minted fully-privileged addons.
4. SEC-3 — CSP injection bypass (addon exfiltration).
5. SEC-4 — plugin hooks dead + `exec` unreachable (broken advertised feature).
6. SEC-5 — unmarked untrusted terminal output in all LLM prompts.
7. REL-3 — duplicated monitor LLM spend on satellite sessions.
8. REL-6 — blocking PTY write wedges the whole session manager.
9. PERF-2 — per-8 s monitor turns per streaming session (biggest token burn).
10. UX-1 — persistence failure invisible after 6 s.

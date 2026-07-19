# TUI Output Streaming & Watcher Processing

_How a child process's terminal output travels from the PTY to every client and
into the LLM watchers — protocol, data structures, and algorithms — followed by
an improvement plan focused on the watcher._

Status: reference (2026-07). Scope: `app/src-tauri/src/domains/session.rs`,
`remote.rs`, `app/src/core/terminals.ts`, `app/src/domains/session/{use-settle,
prompt-detection,attention}.ts`, `app/src/domains/board/{watcher,watcher-runner}.ts`,
`app/src/domains/master/monitor-runner.ts`.

---

## 0. The one-paragraph version

Rust owns the PTY. A per-session **reader thread** pulls raw bytes and pushes
them through a **bounded channel** to an **emitter thread**, which **coalesces**
bursts and fans each merged chunk out three ways: (1) a **broadcast tap** with a
ring backlog for remote devices, (2) a base64 **Tauri IPC event** to the desktop
webview, and separately (3) the desktop xterm derives signals from it. On the
desktop, a single `session-data` listener writes bytes into a persistent
**xterm.js** instance per session and fires callbacks. Those callbacks feed a
**settle state machine** that decides "streaming", "finished responding", or
"needs input" from *quiet periods* and *rendered-screen heuristics*, and hands
short prose snapshots to two LLM consumers — the global **session monitor**
(follow mode) and the per-task **watcher** (mini-orchestrator). Remote phones
get raw bytes over **SSE** and render them in their own xterm.

```
                          ┌──────────── child process (CLI/TUI) ───────────┐
                          │        writes ANSI/UTF-8 to the PTY slave        │
                          └───────────────────────┬──────────────────────────┘
                                                  │ raw bytes
                        ┌─────────────────────────▼──────────────────────────┐
   RUST (session.rs)    │ reader thread: read(8192) → sync_channel(cap 256)    │  ← backpressure
                        │ emitter thread: coalesce_output(≤64 KiB)             │
                        └───────┬───────────────────────────┬──────────────────┘
                                │ merged chunk              │ merged chunk
                   tap_push ────▼──────────┐        emit ───▼─────────────────┐
                   ring VecDeque 200 KiB    │       "session-data"{id,b64}     │
                   broadcast::Sender(512)   │       (Tauri IPC)                │
                        │                   │                │
        SSE /api/term   │                   │        onSessionData (single listener)
        (mobile xterm)  │                   │                │
                        ▼                   │         term.write(bytes) + callbacks
              phone replays backlog         │           │        │        │
              then live b64 events          │      onActivity onPlainLine onUserSubmit
                                            │           │        │        │
                                            │      bumpSettle appendTail armResponseWatch
                                            │           └────────┴────────┘
                                            │                    │
                                            │         SETTLE STATE MACHINE (use-settle.ts)
                                            │        streaming / settled / needs-input
                                            │                    │ bounded checkpoints + final snapshot
                                            │        ┌───────────┴───────────┐
                                            │   session monitor          task watcher
                                            │   (follow mode, LLM)       (per task, LLM)
                                            └────────────────────────────────────────────
```

---

## 1. Origin: the PTY and the reader/emitter threads (Rust)

File: `app/src-tauri/src/domains/session.rs`.

### 1.1 Spawn
`SessionManager::spawn` opens a PTY via `portable_pty::native_pty_system()` at
`rows×cols` (default 24×80, clamped 1–500 × 2–1000), spawns the child on the
slave, then keeps the master side:

```rust
struct SessionHandle {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,     // keystrokes → child
    killer: Box<dyn ChildKiller + Send + Sync>,
    pid: Option<i32>,                  // for SIGTERM→SIGKILL group shutdown
    generation: u64,                   // distinguishes a re-used session id
}
```

`generation` (a monotonic `AtomicU64`) is the concurrency guard: a stop+relaunch
can reuse the same session id while the previous exit-reaper thread is still in
flight; every tap/exit operation checks the generation so a stale thread never
touches the newer session.

### 1.2 Reader thread → bounded channel → emitter thread (backpressure + coalescing)

Two threads and one bounded queue decouple *reading the PTY* from *crossing the
IPC bridge*:

```rust
const OUTPUT_CHANNEL_CAP: usize = 256;          // sync_channel depth
const OUTPUT_COALESCE_MAX_BYTES: usize = 64 * 1024;

// reader thread
let mut buf = [0u8; 8192];
loop {
    match reader.read(&mut buf) {
        Ok(0) | Err(_) => break,
        Ok(n) => if tx.send(buf[..n].to_vec()).is_err() { break }, // blocks when full
    }
}
```

- **Backpressure**: `mpsc::sync_channel(256)`. When the emitter (ultimately, a
  slow webview) can't keep up, `tx.send` **blocks the reader**, which stops
  draining the PTY, which throttles the child via OS pipe backpressure — output
  can never buffer without bound.
- **Coalescing**: the emitter thread `recv()`s one chunk then greedily drains
  everything already queued into a single buffer up to 64 KiB
  (`coalesce_output`, a pure, unit-tested function). A burst of thousands of tiny
  PTY reads crosses the bridge as a few large events. When the webview keeps up
  this is a no-op (one chunk in → one event out; may overshoot the cap by at
  most one chunk).

### 1.3 Fan-out
For each merged chunk the emitter does, in order:

```rust
tap_push(&id_out, generation, &merged);                       // (1) remote tap
let data = STANDARD.encode(&merged);                          // (2) base64
app_out.emit("session-data", DataEvent { id, data });         //     Tauri IPC
```

### 1.4 Exit
A third thread `child.wait()`s, removes the handle (unless a newer generation
took the id), emits `session-exit { id, code }`, and schedules the tap for
removal **300 s later** so a remote viewer can still read the final screen.

---

## 2. The remote tap: ring backlog + broadcast (Rust)

The tap is the multi-client fan-out primitive. Rust owns it so remote terminals
stay live **even while the desktop webview is busy** (no desktop round-trip).

```rust
const TAP_RING_CAP: usize = 200_000;      // bytes of recent raw output
const TAP_CHANNEL_CAP: usize = 512;       // broadcast backlog depth

struct SessionTap {
    generation: u64,
    ring: VecDeque<u8>,                                  // bounded scrollback
    tx: tokio::sync::broadcast::Sender<Vec<u8>>,         // live fan-out
}
```

- `tap_push`: append bytes to `ring`, `drain` the front if over 200 KiB, then
  `tx.send` to all live subscribers (generation-checked).
- `tap_subscribe(id) -> (Vec<u8> backlog, broadcast::Receiver)`: snapshot the
  ring **plus** a live receiver, atomically under the lock — a connecting device
  gets the recent history then every subsequent chunk with no gap.

Data-structure choice: `VecDeque<u8>` gives O(1) amortized push-back and
front-drain for the ring; `tokio::broadcast` gives lock-free multi-consumer
fan-out with a bounded lag buffer (a subscriber that falls >512 chunks behind
gets a `Lagged` error, which the SSE layer filters out).

---

## 3. Wire protocols

### 3.1 Desktop: Tauri IPC events

| Event | Payload | Meaning |
|---|---|---|
| `session-data` | `{ id: string, data: string }` — `data` is base64 of raw PTY bytes | one coalesced output chunk |
| `session-exit` | `{ id: string, code: Option<i32> }` | child exited |

Base64 is used because the bytes are arbitrary (ANSI escapes, partial UTF-8) and
the Tauri event channel is JSON.

### 3.2 Remote: HTTP + SSE (`remote.rs`)

All endpoints are token-authed (URL token `t` + per-device token `d`), served on
the LAN companion server. Relevant to streaming:

| Route | Method | Body / Stream |
|---|---|---|
| `/api/term?id=&d=` | GET (SSE) | **event 1** = `base64(ring backlog)`, then one event per live chunk = `base64(chunk)` |
| `/api/stream?d=` | GET (SSE) | whole-app **snapshot JSON** re-sent on every publish (a `tokio::watch` → `WatchStream`) |
| `/api/state?d=` | GET | one-shot snapshot JSON |
| `/api/command` | POST | `{ kind, id, agent_id?, text?, ok? }` — `session_input`, `session_key`, `session_focus`, `session_blur`, `session_resume`, … |
| `/api/rpc?id=&d=` | GET | poll for a queued fs/git rpc result (request/response bridge) |

```rust
// stream_term: backlog once, then live — the exact same bytes the desktop sees
let first = tokio_stream::once(Ok(Event::default().data(B64.encode(backlog))));
let live  = BroadcastStream::new(rx).filter_map(|r| r.ok())
             .map(|bytes| Ok(Event::default().data(B64.encode(bytes))));
Sse::new(first.chain(live)).keep_alive(KeepAlive::default())
```

The **snapshot** carried by `/api/stream` and `/api/state` includes a serialized
terminal buffer per session (`serializeScreen`, §4.3) as a *fallback* renderer
for phones that can't hold a live `/api/term` SSE open. Two independent SSE
streams therefore drive a phone: `/api/state` (structured app state, incl. the
serialized buffer) and `/api/term` (raw live bytes).

---

## 4. Client rendering

### 4.1 Desktop (`core/terminals.ts`)

One `xterm.js` `Terminal` per session, kept alive across pane mounts (scrollback
survives tab switches). A **single** `onSessionData` listener routes bytes:

```ts
onSessionData(e => {
  const entry = entries.get(e.id); if (!entry) return
  entry.term.write(e.bytes)          // paint
  entry.onActivity?.()               // every chunk → settle bump
  if (entry.onPlainLine) {           // derive plain lines for the log
    entry.pending += entry.decoder.decode(e.bytes, { stream: true })
    const parts = entry.pending.split(/\r\n|\n|\r/)
    entry.pending = parts.pop() ?? ''
    for (const raw of parts) {
      const line = raw.replace(ANSI_RE, '').trimEnd()  // strip escapes
      if (line) entry.onPlainLine(line)
    }
  }
})
```

Key per-session state (`Entry`): a streaming `TextDecoder` (partial UTF-8 must
not mix across PTYs), a `pending` line buffer, an optional lazily-loaded
`SerializeAddon`, and callbacks. Keystrokes go the other way via
`term.onData → writeSession(id, data)`. A bounded `TerminalInputBuffer`
best-effort reconstructs only user-originated input (including cursor edits and
bracketed paste); Enter triggers `onUserSubmit(text)` before it is written to
the PTY. Programmatic session writes never pass through this tracker.

### 4.2 Signal extraction functions
- `readScreen(id, maxRows=30)`: the currently *rendered* visible rows
  (`buffer.active`, last `term.rows`), each `translateToString(true).trimEnd()`,
  non-empty only. This is the watcher/monitor's window into a TUI. **Scrollback
  is not included.**
- `isAltScreen(id)`: `buffer.active.type === 'alternate'` — is this a
  full-screen TUI?
- `serializeScreen(id, scrollback=80)`: full ANSI serialization (colors +
  layout + bounded scrollback) so the phone's xterm can replay pixel-faithfully.

### 4.3 Mobile (`app/src/mobile/TerminalView.tsx`)
Own xterm. Prefers the **live** `/api/term` SSE (writes raw b64 bytes, first
event replays the ring); on error falls back to replaying the **serialized
buffer** from the state snapshot, wrapped in DEC 2026 synchronized-update marks
to avoid flicker. Manual touch-scroll (drag → `scrollLines`) and a WebGL
renderer for smoothness.

---

## 5. Signal extraction → the settle state machine (`use-settle.ts`)

This is where raw activity becomes semantic events. The wiring
(`hydrate-effect.ts`, `launch-runtime.ts`, `actions.ts`) attaches:

```
onPlainLine  → appendTail(id, line) + bufferOutput(id, line)
onUserInput  → clearNeeds(id)
onActivity   → bumpSettle(id)            // EVERY raw chunk
onUserSubmit → recordTerminalSubmit(id,text) // history + watcher/monitor + arm
```

### 5.1 The log (`attention.ts`)
`appendTail` buffers lines in `pendingTail` and flushes on a **100 ms timer**
(`flushTail`) so PTY-speed output never dictates render frequency. On flush it
appends `{ t:'out', x: line }` to `agent.log` and **caps the log at 200
entries** (`log.splice(0, log.length-200)`); it also updates token/cost
estimates. So the frontend's memory of plain output is **≤200 ANSI-stripped
non-empty lines**.

### 5.2 Timers & state (`createSessionSettle`)
Per-session maps/sets:

| Structure | Purpose |
|---|---|
| `armed: Map<id,{snapshot,at,continuation?}>` | screen/tail captured when a response is expected; relay only once content changes and the TUI isn't busy |
| `settle: Map<id,{since,timer}>` | the pending quiet-period timer |
| `streaming: Set<id>` | drives the `responding` flag; touched only on false→true / true→false edges |
| `lastFlagged: Map<id,string>` | dedup of the last question already surfaced |
| `lastLive: Map<id,number>` | throttle for the live status line |
| `outputBuffers: Map<id,string[]>` | bounded decoded output awaiting checkpoint/final delivery |
| `outputTimers: Map<id,Disposable>` | one eight-second progress timer per streaming session |
| `lastOutputKey` / `lastFinalKey` | suppress unchanged checkpoint/final snapshots |

Constants: `bumpSettle` quiet window **3000 ms**; `onSettle` re-check when
still busy/unchanged **3500 ms**; `armResponseWatch` forced check **4000 ms**;
`scanTui` interval **4000 ms**; `LIVE_STATUS_MS` **1200 ms**; armed **expiry 15
min**. Output checkpoints run every **8000 ms** while the session remains
streaming.

### 5.3 `bumpSettle` (runs at PTY speed, per chunk)
1. Cancel the previous settle timer.
2. If the agent is `running`: `setResponding(true)` and `liveStatus()` — a
   throttled (1.2 s) deterministic read of the current screen/tail that updates
   the card's one-line `summary` mid-stream (never sets `actionNeeded`, so
   transient error text can't raise a false flag).
3. (Re)arm a **3000 ms** timer → `onSettle`.

So a settle "fires" only after **3 s of PTY silence**.

### 5.4 `onSettle` (the core algorithm)
```
setResponding(false)
if status ∉ {running,needs}: return
content = alt ? readScreen(id) : agent.log[since:].tail(14)
{busy, promptDetected, question} = detectPrompt(content, alt)

if promptDetected:
    if not already-flagged(question):
        setNeedsInput(id, question, extractOptions(content))   // status → 'needs'
        if follow-mode LLM: masterEvent(...)                   // tell Master
        if task session:    runWatcher(taskId, "waiting at this prompt: …")
    return

if status == 'needs': clear it → 'running'   // prompt was answered

if armed:
    if (busy or unchanged) and not expired:
        reschedule onSettle in 3500 ms; return                  // wait for real change
    armed.delete(id)
    if not watching:
        update card attention only
        if fresh arm: notify(done)                              // bell/tab flash
    if still running: re-arm as {continuation:true}             // keep tracking

flushOutput(id, final=true, content)  // watcher for task sessions; monitor otherwise
```

Notes:
- **TUIs are judged by the rendered screen** (`readScreen`, stable) because they
  redraw constantly with no newlines; plain sessions use a bounded decoded-line
  buffer. Each watcher/monitor note carries at most the last 40 lines / 12 KiB.
- **Long streams checkpoint every eight seconds.** Settle cancels that timer and
  emits one final snapshot; the in-memory source buffer is capped at 80 lines /
  16 KiB and cleared after delivery.
- The **`busy` marker** (`/esc to interrupt|ctrl\+c to interrupt/`) suppresses
  false completions and false prompts while a known TUI is still generating.
- **Change detection is string equality** of the joined content vs the armed
  snapshot.
- **Re-arm/continuation**: a still-running session is re-armed with the just
  reported screen as the new baseline, so long autonomous runs keep refreshing
  their card — but `continuation` suppresses re-pinging the user at every quiet
  point.

### 5.5 Stable screen identity and `detectPrompt` (`prompt-detection.ts`)
- `stableScreenKey(content)` removes spinner/decorative noise only for redraw
  deduplication. Terminal lines are never promoted directly into the visible
  Task / Now / Next brief; that brief is synthesized by the monitor/watcher.
- `detectPrompt`: `busy` from the interrupt marker; `promptDetected` from
  `TUI_PROMPT_RE` (alt) or `PROMPT_RE`/trailing `?:` (plain); `question` = first
  question-shaped line.
- `extractOptions`: parse numbered menu rows (`OPTION_RE`, `❯` cursor) into
  `EscOption[]` (needs ≥2 to count as a menu).

### 5.6 `scanTui` (safety net, 4 s interval)
Independently scans every running **alt-screen** session for approval dialogs
(`TUI_PROMPT_RE`) regardless of settle timing, deduped by `lastFlagged`. Catches
dialogs that appear without a trailing quiet period.

---

## 6. Watcher & monitor processing

Two LLM consumers receive settle notes. Both are per-key serialized loops
(`busy` set + `queue`), re-reading live state each turn.

### 6.1 Session monitor (`monitor-runner.ts`, follow mode, per session)
- Triggers: submitted user terminal input plus bounded output checkpoints/final
  snapshots for non-task sessions.
- **Queue policy: bounded accumulation** — while a turn runs, up to eight
  submitted-input/output notes are retained and joined for the next turn. This
  prevents a user submission from being overwritten by its output checkpoint.
- Tools: `update_status`, `flag_needs_input`, `report_to_master`, …
- `update_status` writes the complete synthesized `task`, `summary` (Now),
  `next`, and `action_needed` contract. Each incoming input/output checkpoint
  is reassessed; the monitor calls it when the brief changed.

### 6.2 Task watcher (`watcher.ts` + `watcher-runner.ts`, per task — the mini-orchestrator)
- Triggers (all funnel to `runWatcher(taskId, note)`):
  - `onSettle` prompt → "waiting at this prompt: <14 lines>"
  - continuing output → bounded progress checkpoint every eight seconds
  - `onSettle` stable output → final bounded output/screen snapshot
  - submitted user terminal input → bounded user intent (credential values
    are redacted before persistence or LLM delivery)
  - **`session-exit`** (`exit-handler.ts`) → "exited with code N. Final
    output: <12 lines>" — a first-class event carrying the exit code and the
    final tail, with instructions to assess against criteria and move the card
  - `scanTui`/monitor dialog paths
  - user messages / review actions
- **Queue policy: accumulate** —
  `queue.set(taskId, (queue.get(taskId) ?? []).concat([note]))`; next turn joins
  **all** pending notes with `\n\n`.
- Turn: `runWatcherTurn` → `runToolLoop` (`maxRounds 5`, `sequential`), system
  prompt `watcherSystem` (task spec + live worker list + ground-truth rules),
  tools: `move_task`, `update_note`, `spawn_session`, `send_to_session`,
  `ask_user`, `suggest_actions`, `memory_lookup`, `check_session`.
- **Ground-truth rule**: a session is done only when its **process exits**; the
  watcher must call `check_session` before claiming completion. `check_session`
  reads, per attached session, `isAltScreen ? readScreen : log.slice(-20)`, then
  `tail = lines.slice(-12)` — i.e. **≤12 lines**.
- Streaming reply: `makeStreamingCall` streams tokens into
  `taskStreams[taskId]` (throttled ~80–90 ms) so the task chat shows text as it
  generates; the final prose is posted to the task chat.
- History hygiene: `sanitizeToolHistory` before, `capToolHistory(history, 20)`
  after.
- `update_note` writes both `watcherNote` (Now) and `watcherNext` (Next), and
  mirrors them to the current worker. Every submitted user input and buffered or
  settled output wakes the watcher; it refreshes both fields when meaning changes.

### 6.3 What the watcher actually "sees" of the output
The watcher receives bounded decoded-output checkpoints (last 40 lines / 12 KiB)
and a final settle snapshot. Alternate-screen sessions supply the rendered
screen instead. `check_session` remains an independent ground-truth read capped
at 12 lines. The watcher never receives full scrollback, raw bytes, or colors.
It also receives user input only on submission, so it can correlate each
terminal decision with the output that follows.

---

## 7. Data-structure & constant reference

| Layer | Structure | Bound |
|---|---|---|
| PTY read | stack buffer | 8 192 B / read |
| reader→emitter | `sync_channel<Vec<u8>>` | 256 chunks (backpressure) |
| coalesce | merged `Vec<u8>` | ≤64 KiB/event |
| tap ring | `VecDeque<u8>` | 200 000 B |
| tap live | `broadcast::Sender` | 512 chunks lag |
| tap retention post-exit | timer | 300 s |
| desktop term | `xterm.Terminal` | 5 000 lines scrollback |
| plain-line log | `agent.log[]` | 200 entries, flushed every 100 ms |
| readScreen | rendered rows | `term.rows`, ≤30 returned |
| settle quiet window | timer | 3 000 ms (3 500 re-check, 4 000 forced) |
| live status | throttle | 1 200 ms |
| scanTui | interval | 4 000 ms |
| armed snapshot | expiry | 15 min |
| output source buffer | queue | last **80** lines / **16 KiB** |
| output checkpoint | timer | **8 000 ms** while streaming |
| watcher/monitor output note | slice | last **40** lines / **12 KiB** |
| submitted terminal input | buffer | **4 000** codepoints; **2 000** sent to LLM |
| check_session window | slice | last **12** lines |
| watcher tool loop | rounds | 5 |
| watcher history | cap | 20 messages |

---

## 8. Does scrolling corrupt the data? (no)

A recurring worry: for a TUI, does scrolling up/down mess up the captured or
streamed output? The data path is **append-only** (child → tap ring → IPC/SSE →
xterm buffer → `agent.log`); moving the viewport writes nothing back into any of
those. The deciding detail is `readScreen` — the only window the settle engine,
monitor, and watcher have into a live session:

```ts
const start = Math.max(0, buf.length - entry.term.rows)   // absolute tail
for (let y = start; y < buf.length; y++) { … }            // never uses viewportY
```

It reads the buffer's tail **by absolute index**, never the scroll position.
Consequences:

- **Plain (main-buffer) sessions** keep 5 000 lines of scrollback. Scrolling up
  moves `viewportY`, but `buf.length` still grows at the bottom, so the watcher
  always reads the true latest rows. Scrolling cannot feed it stale data.
- **A literal "skip settle while scrolled up" guard would be a placebo** — there
  is no path that reads viewport-relative content, so guarding on `viewportY`
  changes nothing.
- **The one genuine stale case** is *app-internal* history navigation inside an
  **alternate-screen** TUI (the alt buffer has no scrollback; the app redraws to
  show older content). `readScreen` faithfully returns whatever is currently
  drawn — which may be history the user scrolled to. **xterm cannot detect this**
  (it's the application's scroll, not the terminal's), so there is no reliable
  signal to guard on. Mitigation is indirect: settle only fires after 3 s of
  quiet and the busy-marker suppresses mid-generation reads, so this needs the
  user to *park* on a scrolled-back TUI view for 3 s — uncommon for the one-shot
  coding sessions the watcher actually owns.
- **Input side-effect (not data):** desktop mouse-wheel over an alt-screen with
  no mouse-tracking emits arrow keys to the app (xterm alternate-scroll), which
  can move a menu selection. The settle layer correctly ignores these (`\x1b[`
  prefix ⇒ no false `onUserSubmit`), but the app state does change.

## 9. Improvement plan

Ordered by value/effort. The theme: the watcher runs an **expensive LLM turn on
a lossy, overlapping, tail-only view of the output, on almost every quiet
period**, with an accumulating queue that concatenates near-duplicate snapshots.

> **Implemented (2026-07).** P0 queue-collapse, a progress-report dedup
> (P1-lite), and P2 normalized change-detection have landed:
> `board/watcher-notes.ts` (`enqueueWatcherNote` — progress notes are
> latest-wins, events accumulate), `prompt-detection.ts::stableScreenKey`
> (spinner/noise-insensitive screen identity), and `use-settle.ts` (arm
> comparison + stable output/final keys so an unchanged settled screen no longer
> wakes the task watcher). The remaining items below (deltas, on-demand
> `read_output`, adaptive settle, structured payloads, widened exit output) are
> still open.

### P0 — Stop feeding the watcher overlapping duplicates (cheap, high value) — ✅ done
**Problem.** The watcher's queue *accumulates* every "stable output" note and
joins them with `\n\n`. Each note is the last 14 lines of an evolving screen, so
a burst of settles enqueues several **overlapping** tails that are concatenated
into one giant, redundant user message. The session monitor instead keeps a
small bounded event queue so submitted input is not lost behind later output.

**Fix.**
- Collapse consecutive same-kind "stable output" notes in the queue to the
  **latest** per session (keep distinct *events* — prompt, exit, user message —
  but never stack routine progress). Minimal change in `runWatcherLoop`:
  replace `concat` with a dedup/merge that keeps at most one progress note per
  session id plus any event notes.
- Tag notes with a `kind` (`progress|prompt|error|exit|user`) at the call sites
  in `use-settle.ts` so the queue can reason about them instead of parsing
  prose.

### P0 — Send bounded checkpoints, then evolve them into exact deltas (partly done)
**Problem.** `content.slice(-14)` is an arbitrary, overlapping window; the
watcher can't tell what is *new* since it last looked, and long/one-shot output
that prints >14 lines at the end is truncated.

**Current state.** Plain output is now collected between deliveries and sent in
bounded eight-second checkpoints plus a final settle snapshot. This removes the
old 14-line settle bottleneck and gives long-running commands periodic evidence.
Stable keys suppress identical snapshots, but log offsets/typed delta metadata
are not yet persisted across deliveries.

**Fix.** Track a per-(task,session) **reported offset** into `agent.log` (and a
last-serialized-screen hash for alt-screen). On settle, compute the **new lines
since the last report** and send those (bounded, e.g. ≤60 lines with a
"…N earlier lines omitted" marker), plus a one-line rolling summary. Data: add
`lastReportedLogLen: Map<string, number>` alongside `armed`. This both shrinks
tokens and makes "what changed" explicit.

### P1 — Reduce LLM turns without degrading synthesized status
**Problem.** Every stable-output settle can wake the LLM watcher, even for
routine progress whose Task / Now / Next meaning has not changed.

**Constraint.** Do not restore an extractive last-terminal-line status path.
Visible Task / Now / Next text must remain watcher/monitor-authored.

**Possible follow-up.** Add a deterministic wake-up pre-filter that only decides
whether evidence is materially different (prompt, error signature, process
exit, criteria keyword, or a minimum heartbeat). It may skip an LLM turn, but it
must not write visible status text. Add per-task `lastWatcherRunAt` and a
significant-change test before changing the current every-checkpoint delivery.

### P1 — Widen the exit note and protect it from the progress queue
**Current state.** `session-exit` is **already** a first-class watcher trigger
(`exit-handler.ts` → `runWatcher` with the exit code and a `slice(-12)` final
tail). Two weaknesses remain:
1. The final output is still only **12 lines** — for one-shot CLIs that dump
   everything at the end (the common case), the evidence the watcher most needs
   is the part most likely truncated.
2. The exit note lands in the **same accumulating queue** as routine progress
   notes (P0); if a turn is mid-flight it is concatenated behind stale
   snapshots rather than treated as the authoritative terminal event.

**Fix.** Carry the exit's `finalOutput` from the **tap ring** (see P2), not a
12-line slice, and tag it `{kind:'exit', code}` so the queue collapse (P0)
drops superseded progress notes and prioritizes the exit. The ground-truth rule
then fires with full evidence exactly when the truth is known.

### P2 — Give the watcher on-demand access to more than the tail
**Problem.** Both the settle payload and `check_session` are tail-limited
(≤14/≤12 lines); the 200 KiB tap ring already holds far more, but the watcher
can't reach it.

**Fix.** Expose a bounded **`read_output(session, lines?, grep?)`** watcher tool
backed by the tap ring / xterm scrollback (`serializeScreen` or
`buffer` full length). Let the watcher pull a larger or filtered window when it
needs evidence (e.g. grep for "PASS/FAIL", test summaries) instead of guessing
from 12 lines. Keep it read-only and size-capped.

### P2 — Normalize before change detection (robustness) — ✅ done
**Problem.** Settle change detection is raw string equality of joined lines;
spinner frames, cursor moves, and timestamps count as "changed" (re-arming
churn), while a meaningful change hidden by a redraw can be missed.

**Fix.** Normalize the compared content (drop spinner/`NOISE_LINE_RE` lines,
collapse whitespace, strip volatile timestamps) before the `unchanged` compare
and before hashing the alt-screen. Reduces re-arm churn and false "new output".

### P3 — Adaptive settle window & explicit turn boundaries
**Problem.** A fixed 3 s quiet window mislabels a model that pauses >3 s
mid-thought as "finished responding", triggering a watcher turn on incomplete
output. The `busy` marker only covers CLIs that print a known interrupt hint.

**Fix.**
- Learn a per-session/per-CLI quiet threshold, or extend the window when the
  last line looks mid-sentence / lacks a shell prompt.
- Where the CLI supports it, detect an explicit **turn-complete sentinel** (many
  agents print a stable prompt/box) and prefer that over the timer.

### P4 — Structured event payloads instead of prose
**Problem.** Settle hands the watcher English ("The task's session produced
stable output. New output: …"); the LLM re-parses it every turn.

**Fix.** Pass a small structured record (`kind`, `isAltScreen`, `busy`,
`newLineCount`, `errorSignature?`, `promptOptions?`, `exitCode?`) plus the delta
text. The watcher system prompt can then branch cheaply and the model spends its
budget on judgement, not parsing.

### Summary of the target watcher loop
```
settle/exit → typed event {kind, delta, meta}
            → dedup/collapse in queue (P0)
            → deterministic pre-filter (P1): update note w/o LLM for routine progress
            → wake LLM only on transition (prompt/error/exit/criteria/heartbeat)
            → watcher turn sees: rolling summary + NEW lines (P0) + on-demand read_output (P2)
            → exit is authoritative, carries final full output (P1)
```

The net effect: far fewer LLM turns, each with a smaller, non-overlapping,
higher-signal payload, and a completion signal grounded in the actual process
exit rather than a 3-second silence.

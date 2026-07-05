# YAAM roadmap — a hands-on cockpit for live agent sessions

> Active roadmap, revised 2026-07-05 after reviewing the current implementation,
> architecture documents, public user discussions, and competitors. Code remains
> authoritative when older plans disagree. See [architecture.md](../architecture.md),
> [frontend-domains.md](../frontend-domains.md),
> [backend-domains.md](../backend-domains.md), and [security.md](../security.md).

## Direction

YAAM's primary product is not an asynchronous job dispatcher. It is a hands-on
desktop cockpit for actively working with several live coding-agent CLIs at
once.

The user should be able to:

- see what every session is doing without opening every terminal;
- notice immediately when one needs input;
- jump, type, approve, interrupt, compare, and redirect with minimal friction;
- ask Master to understand or coordinate the live sessions;
- preserve terminal and conversation continuity across layout changes/restarts;
- inspect files, Git changes, tests, and output beside the session;
- use Claude Code, Codex, Gemini, Aider, OpenCode, or an ordinary shell without
  YAAM replacing their native interaction model.

The board is a second mode. It supports bounded tasks that can be handed off,
watched, reviewed, and completed. That workflow is valuable, but its lifecycle
must not be imposed on ordinary interactive sessions.

The product promise is:

> Keep every agent terminal under your hands, while Master handles attention,
> context, and coordination overhead.

## Two interaction modes, two domain models

### Interactive sessions are the core

An interactive session:

- may live for minutes, days, or weeks;
- may cover several topics over its lifetime;
- is directly controlled through its terminal or chat composer;
- can be idle without being complete;
- can use the original checkout or an optional worktree;
- may expose incomplete or ambiguous status because the underlying CLI owns its
  internal loop;
- should remain useful even when Master, monitors, the board, and all automation
  are disabled.

The session model therefore needs identity, lifecycle, attention, context, and
control—not a required outcome state.

```text
Session
  id, kind: pty | chat
  workspaceId, groupId?, name, cwd, optional worktree
  processState, activityState, attentionState
  cliType, cliConversationId?, launchedAt, lastActivityAt
  statusSource, statusConfidence
  user notes, queued input, recent summary
  terminal/chat presentation state
```

The three state dimensions should remain separate:

- `processState`: starting, live, exited, disconnected, failed;
- `activityState`: producing output, quiet, unknown;
- `attentionState`: none, unseen output, needs input, permission, error.

Collapsing these into one `running | idle | needs | error` field makes status
easy to render but difficult to trust.

### Board tasks own bounded attempts

A board task may launch one or more bounded attempts. This is where goal,
criteria, worktree, budget, evidence, gates, and completion belong.

```text
Task
  specification, criteria, dependencies, workflow state

TaskAttempt
  taskId, attempt number, sessionIds[]
  worktree?, budget?, startedAt, endedAt?
  evidence[], gate results[], outcome?
```

A task attempt uses sessions as workers; a session does not become a task
attempt merely because it is visible on the board. Users should be able to:

- promote a conversation/session goal into a board task;
- open a task worker as a normal hands-on session and take over;
- detach an interactive session from a task without destroying it;
- keep board automation completely out of unrelated sessions.

### Master's default role is copilot, not manager

Master should:

- answer questions about live sessions;
- summarize and compare their current screens and changes;
- route the user's message to a selected session;
- surface attention in priority order;
- maintain concise cross-session context and handoffs;
- suggest a next action, then let the user decide;
- automate only where the user explicitly enables a board, schedule, template,
  or tool policy.

Master should not silently translate ordinary terminal interaction into hidden
plans, jobs, budgets, or completion workflows.

## What has already shipped

YAAM already has much of the foundation for this direction:

| Capability | Current implementation |
| --- | --- |
| Live heterogeneous terminals | Real PTYs with xterm.js for arbitrary agent CLIs and shells |
| Hands-on layouts | Groups, panes, splits, focus/maximize, minimize, direct input, repaint on remount |
| Attention | Raw-activity settle detection, TUI screen scans, prompt detection, unseen-response attention, OS notifications |
| Session continuity | CLI conversation-id capture and resume commands for supported agents |
| Master and monitors | Cross-session Master plus lightweight per-session monitor summaries |
| Files and Git beside sessions | Native file watching, ranged reads, rich previews, diff markers, Git workbench, staging and commit |
| Optional isolation | Single- and multi-repository worktrees for sessions/tasks |
| Chat sessions | In-app LLM sessions with files, skills, MCP, approvals, attachments, memory, and streaming |
| Board hand-off | Task watchers, scheduled launches, review queue, worktree merge/request-changes loop |
| Runtime architecture | Plain `AppRuntime`, domain runtimes, cancellation, typed native adapters, shared LLM loop, command registry |

The next roadmap should deepen live-session quality instead of wrapping these
capabilities in a universal asynchronous-run abstraction.

## User research: hands-on needs

### Method and limitations

The qualitative sample covers public discussions from early 2026 across
r/ClaudeAI, r/ClaudeCode, terminal/tool communities, indexed X posts, and the
documentation of current session managers. It overrepresents technical power
users and tool builders. It identifies recurring pain; it does not establish
market size.

### 1. “Which session needs me?” is the first problem

Users running multiple terminals consistently describe tab-cycling to discover
which session is working, idle, waiting, or forgotten. Several independent
tools exist mainly to answer this question. See
[How do people run multiple Claude Code sessions?](https://www.reddit.com/r/ClaudeAI/comments/1q6u7xz/how_do_people_run_multiple_claude_code_sessions/),
[claudectl](https://www.reddit.com/r/ClaudeAI/comments/1sjgfus/i_built_a_terminal_dashboard_for_managing/),
and [c9s](https://www.reddit.com/r/ClaudeAI/comments/1s0ppur/terminal_dashboard_for_managing_claude_code/).

Need:

- high-confidence working/waiting/idle/exited state;
- latest meaningful activity, not raw terminal spam;
- attention sorted by urgency and age;
- one-keystroke navigation to the relevant session;
- notifications that clear when the user actually views/responds.

### 2. Users want a better terminal multiplexer, not a hidden agent runtime

Common workflows remain terminal-native: one project/worktree per tab, multiple
panes for agent, shell, server, tests, and Git UI, with keyboard navigation.
Users value the ability to take over directly and dislike losing native CLI
features. See
[the multi-terminal workflow discussion](https://www.reddit.com/r/ClaudeAI/comments/1qf9xms/how_do_you_manage_multiple_claude_code_cli/)
and [the terminal-versus-extension discussion](https://www.reddit.com/r/ClaudeCode/comments/1reelqd/are_you_using_claude_code_in_the_terminal_or/).

Need:

- fast keyboard-first pane/group/session operations;
- reliable terminal rendering, selection, search, links, scrollback, copy/paste,
  and full-screen TUI behavior;
- layouts that combine agents with ordinary shells and dev processes;
- user-defined launch profiles and reusable project layouts;
- no requirement that a process speak YAAM's protocol.

### 3. Status heuristics are useful but must expose uncertainty

Community dashboards infer status from CLI hooks, JSONL logs, process activity,
and terminal output. Users report edge cases where a session appears idle
between tool calls or working while actually waiting. See
[the macOS dashboard discussion](https://www.reddit.com/r/ClaudeCode/comments/1rzd604/i_built_a_macos_dashboard_for_managing_multiple/).

Need:

- structured adapters/hooks when a CLI exposes them;
- terminal/process heuristics as fallback;
- status source and confidence in diagnostics;
- easy manual correction (“mark waiting”, “mute attention”, “watch this”);
- eval fixtures for real prompt, permission, spinner, progress, and TUI screens.

### 4. Session persistence and fast resume are core

Users adopt tmux-backed tools because closing a UI does not destroy their work.
They want to find yesterday's session, understand where it stopped, and resume
without hunting for ids. See
[the k9s-style dashboard discussion](https://www.reddit.com/r/ClaudeCode/comments/1ra54of/claudedashboard_k9sstyle_tui_for_managing_claude/)
and [Agent Deck](https://www.reddit.com/r/ClaudeCode/comments/1pxyn37/i_got_tired_of_managing_15_terminal_tabs_for_my/).

Need:

- separate identity for the YAAM session, native PTY process, and CLI
  conversation;
- explicit reconnect/resume support matrix per CLI;
- persisted layout, metadata, summaries, drafts, and terminal history;
- truthful recovery after crash, app upgrade, missing cwd, or missing CLI
  history;
- never imply a process survived if only its conversation can be resumed.

### 5. Users need to queue and route input while staying hands-on

A recurring pain is being unable to write the next instruction while an agent
is busy, plus finding the correct terminal to send it to. See
[ClaudeQ](https://www.reddit.com/r/ClaudeAI/comments/1roaudt/dashboard_for_claude_code_jump_between_sessions/).

Need:

- per-session drafts that survive navigation;
- optional queued messages with visible order and cancel/edit before send;
- “send when ready” based on explicit readiness or user confirmation when status
  is uncertain;
- intentional relay/broadcast with destination preview;
- input history and reusable snippets without turning every message into a task.

### 6. Worktrees help, but are optional for interactive work

Worktrees are valuable when sessions make independent changes, yet many users
also run several agents/shells in one workspace because they need shared live
state. Conductor explicitly documents both patterns
([parallel-agent guidance](https://www.conductor.build/docs/concepts/parallel-agents)).

Need:

- choose original checkout, new worktree, existing worktree, or read-only session
  at launch;
- make the current branch/cwd/worktree unmistakable in every session header;
- warn before opening conflicting edit sessions on the same checkout;
- do not force worktree review/merge semantics onto research, shell, or shared
  collaboration sessions.

### 7. Remote access is an extension of hands-on control

Users want to answer a prompt or inspect a terminal while away, not necessarily
hand the whole task to a cloud service. Phone approval discussions emphasize
full context and terminal visibility over a blind Approve button. See
[remote prompt approval](https://www.reddit.com/r/ClaudeAI/comments/1to9iju/is_there_a_way_to_accept_the_popup_on_claude_code/)
and [mobile push/remote control](https://www.reddit.com/r/ClaudeCode/comments/1sy9xf4/claude_code_just_added_mobile_push_notifications/).

Need:

- live, bounded terminal view plus short input/approve/interrupt;
- execution and credentials remain on the host machine;
- explicit device pairing, revocation, and local policy evaluation;
- remote is a later surface over the same session controls, not a separate job
  platform.

## Competitor landscape for the hands-on use case

### Direct terminal/session competitors

| Product | Strength | Implication for YAAM |
| --- | --- | --- |
| [cmux](https://cmux.com/docs/getting-started) | Native Ghostty terminal, vertical workspaces, notification rings, socket API, session restore, mobile companion; any CLI works | This is the closest UX benchmark. YAAM must match terminal quality, navigation speed, notifications, and scriptability while differentiating through Master/monitors and richer app domains |
| [Agent of Empires](https://www.agent-of-empires.com/) | tmux persistence, TUI/web/mobile dashboards, status detection, worktrees, Docker sandbox, structured agent view | Persistence, remote pairing, and optional sandboxing are expected even in open-source session managers |
| [Warp Terminal](https://www.warp.dev/terminal) | High-quality terminal, vertical agent tabs, notifications, review, remote control, universal CLI support, cloud/local handoff | YAAM should not compete by becoming a generic terminal; it needs superior cross-session understanding and coordination without degrading PTY fidelity |
| [dmux](https://dmux.ai/) | Lightweight tmux/worktree workflow with file browsing and notifications | Basic multiplexing/worktree automation has a low implementation moat |
| [ccmux](https://ccmux.ai/) | Cross-device tmux dashboard for heterogeneous agents | Remote multi-session visibility is becoming a standalone category |

cmux's positioning is particularly relevant: it leaves the agent unchanged and
adds organization, notification, and programmability around the terminal. YAAM
should preserve that property. The Master layer is an enhancement to direct
control, not a replacement for it.

### Workspace and review competitors

| Product | Strength | Implication for YAAM |
| --- | --- | --- |
| [Conductor](https://www.conductor.build/docs) | Multi-harness isolated workspaces, multiple sessions per workspace, diffs, checks, PR/CI, checkpoints | Strong benchmark for optional worktree/review workflows; its workspace model should inform the board track, not redefine every session |
| [Nimbalyst](https://nimbalyst.com/blog/open-sourcing-nimbalyst/) | Visual workspace with persistent terminals, worktrees, Git and project documents | Shows demand for richer project context around terminals, but YAAM should stay focused on agent supervision rather than general knowledge-work canvas features |
| [Vibe Kanban](https://www.vibekanban.com/docs/supported-coding-agents) | Broad CLI task/worktree/kanban/review workflow | Validates the board use case; also shows that kanban plus worktrees alone is not a durable differentiation |

### Provider-owned session experiences

| Product | Strength | Implication for YAAM |
| --- | --- | --- |
| [Claude Code agent view and teams](https://code.claude.com/docs/en/agents) | Native lifecycle knowledge, background sessions, worktrees, subagents/teams, hooks | YAAM needs adapter-based structured status and visibility into nested agents where possible |
| [OpenAI Codex app](https://openai.com/index/introducing-the-codex-app/) | Parallel threads, worktrees, review, skills, automations, mobile/cloud continuity | Provider apps will always have deeper native state; YAAM wins by giving one coherent surface across providers and shells |
| [GitHub Copilot app](https://docs.github.com/en/copilot/concepts/agents/github-copilot-app) | Interactive/Plan/Autopilot modes, local/cloud sandboxes, multi-model sessions, PR/CI integration | Explicit interaction mode is better than silently turning a live session into autonomy |

### Position to defend

Provider-neutral terminal support is necessary but no longer sufficient. cmux,
Warp, Conductor, and several open-source tools already support many CLIs.

YAAM's differentiated combination should be:

```text
high-fidelity live PTY sessions
  + reliable attention/status
  + Master that understands and coordinates those sessions
  + low-cost monitors that reduce terminal noise
  + files/Git/context beside the terminal
  + optional board automation and addon platform
```

The strategic test for a feature is: **does this let the user understand or
control live sessions faster without taking the sessions out of their hands?**

## Product principles

1. **The terminal remains authoritative.** YAAM never hides or replaces the
   underlying CLI's real state with a model narrative.
2. **Direct control is always one action away.** Any summary, notification, or
   Master message links back to the exact session and screen.
3. **Attention is more valuable than automation.** First reduce missed prompts,
   tab hunting, and repeated context gathering.
4. **Status includes provenance.** Prefer CLI hooks/protocol data; label process,
   terminal, heuristic, and LLM-derived state distinctly.
5. **Interactive and delegated work stay separate.** Task-attempt policy cannot
   leak into ordinary sessions.
6. **Master suggests before acting.** Cross-session action is explicit unless a
   user-enabled policy/template/schedule says otherwise.
7. **Any CLI should still work.** Structured adapters improve supported CLIs,
   while a generic PTY fallback remains first-class.
8. **Keyboard and latency are product features.** Session switching and input
   cannot feel slower than tmux or a native terminal.

## Horizon 0 — make the session cockpit excellent

**Target: 0–8 weeks.** Improve the loop users perform dozens of times per hour.

### 0.1 Build a truthful session-state model

Deliverables:

- Split process, activity, and attention state instead of overloading one status.
- Add `lastActivityAt`, status source, confidence, and reason.
- Create CLI adapters for supported lifecycle sources:
  - Claude/Codex hooks or structured session logs where stable;
  - CLI conversation/resume files;
  - process state and exit code;
  - generic terminal settle/screen heuristics as fallback.
- Keep deterministic prompt/TUI detection ahead of monitor LLM judgment.
- Show “unknown” rather than guessing when evidence conflicts.
- Build recorded-screen fixtures for permissions, questions, progress spinners,
  alternate-screen redraws, shell prompts, crashes, and quiet long-running tools.
- Measure false attention, missed prompts, and time-to-detection per adapter.

Exit criteria:

- Status UI can explain why a session is marked working/waiting/idle.
- Supported approval/input prompts have a measured detection suite.
- A monitor cannot overwrite contradictory process or prompt evidence.

### 0.2 Make switching and input frictionless

Deliverables:

- Keyboard-first session switcher with MRU ordering, fuzzy search, workspace,
  status, cwd, branch, and attention.
- Stable shortcuts for next-attention, previous session, focus/maximize, move to
  group, and return to prior layout.
- Persist a draft per terminal/chat session.
- Add editable/cancellable queued input with explicit “send when ready.”
- Add intentional send-to-many and relay actions with destination preview;
  never broadcast by accidental multi-selection.
- Add session input history, reusable snippets, and “send this Master response
  to session…” actions.
- Improve xterm search, hyperlinks, selection/copy, theme-aware palette,
  accessibility, and large scrollback behavior.
- Keep text and Enter as separate writes for TUI compatibility.

Exit criteria:

- The user can reach and answer the oldest attention item without touching the
  mouse.
- Navigating away never loses an unsent instruction.
- Queued input is never sent based solely on low-confidence idle detection.

### 0.3 Make session continuity dependable

Deliverables:

- Model YAAM session id, native process generation, and CLI conversation id as
  distinct identities.
- Publish a reconnect/resume capability matrix for each agent type.
- Persist layouts, drafts, summaries, notes, cwd/branch/worktree, launch profile,
  and bounded display history.
- On boot, classify each prior session as live/reattached, resumable, historical,
  missing-cwd, missing-cli, or unrecoverable.
- Add one-click resume that previews the exact command and target cwd.
- Preserve WIP/worktree metadata if YAAM or the CLI crashes.
- Make session replacement and graceful process-tree shutdown observable rather
  than silent.
- Add end-to-end tests for launch → interact → close/crash → restore/resume.

Exit criteria:

- YAAM never labels a recreated shell as the original live process.
- Supported agent conversations resume without users locating native ids.
- Missing files/processes produce recovery actions, not dead panes.

### 0.4 Turn Overview into an attention cockpit

The current card grid should optimize hands-on decisions rather than “fleet
runs.”

Deliverables:

- Compact rows/cards showing session name, workspace/group, cwd/branch,
  process/activity/attention, last meaningful output, summary age, and cost
  confidence.
- Attention inbox ordered by needs-input, permission, error, unseen completion,
  then age.
- Pin/watch/mute controls and user-defined session groups.
- Recent-session and archived-session search across names, cwd, summaries, and
  conversation ids.
- One-click actions: open, send, stop/interrupt, resume, diff, note, archive.
- Global indicator for sessions hidden in other workspaces/groups.
- No task progress, budget stop, or completion language unless the session is
  attached to a board attempt.

Exit criteria:

- A user with ten sessions can identify the next required action at a glance.
- Every attention item navigates to the exact live interaction surface.

### 0.5 Make Master a reliable cross-session copilot

Deliverables:

- Add explicit session commands in Master:
  - summarize selected/current/all-attention sessions;
  - compare two sessions' approaches or Git changes;
  - draft a message for a session, then preview/send;
  - relay a result or constraint between sessions;
  - open/focus the relevant terminal, file, or diff;
  - create a durable session note or handoff.
- Let users scope Master to current session, selected group, workspace, or all.
- Show which screens/summaries and timestamps informed each Master answer.
- Keep proactive messages short, deduplicated, and configurable per session.
- Make monitor escalation rules visible and allow monitor off/cheap/detailed
  profiles.
- Move all Master/addon cross-session actions through the shared command policy
  and audit path; direct user typing remains direct PTY input.
- Add golden interaction tests for routing, stale summaries, conflicting
  evidence, and accidental cross-session sends.

Exit criteria:

- Master can answer “what needs me?” with links and current evidence.
- No cross-session input is sent without an explicit destination visible to the
  user or a previously configured policy.
- Master remains optional; disabling it does not impair terminal management.

### 0.6 Complete the live development sidecar

Build on the existing Files pane and Git workbench:

- Associate dev servers/test processes with a session group without pretending
  they are agents.
- Saved commands for test, lint, dev server, and Git actions, runnable beside the
  terminal.
- Stream structured command exit/duration/output back into the session context.
- Inline diff comments that can be sent to the same live session.
- Optional PR/CI status for the session branch/worktree.
- Clear multi-repository navigation and branch/worktree badges.
- Warn about multiple editing sessions sharing the same checkout; allow it after
  confirmation because shared-state collaboration is valid.

Exit criteria:

- Users can inspect a change, run its relevant check, and send feedback without
  losing the terminal context.
- Ordinary shells/dev servers fit the same workspace layout without agent-only
  assumptions.

### 0.7 Instrument the hands-on loop

Deliverables:

- Persist redacted lifecycle telemetry for process/activity/attention
  transitions, navigation, notifications, and adapter confidence.
- Diagnostics export excludes terminal content and prompts by default.
- Track status accuracy against user corrections and structured CLI events.
- Fix native tests so worktree/watch fixtures use injectable temporary roots and
  run deterministically in CI.
- Add a desktop smoke suite for PTY rendering, input, TUI resize, attention,
  layout switching, and restore/resume.

Primary measures:

- missed prompt rate;
- false attention rate;
- median prompt-to-detection time;
- median attention-to-user-response time;
- session switch latency and keyboard steps;
- successful live reattach/resume rate;
- accidental/wrong-destination send count.

## Horizon 1 — richer hands-on coordination

**Target: 2–4 months after the cockpit is reliable.** Add leverage without
turning sessions into background jobs.

### 1.1 Working sets and session handoffs

- A working set groups agents, shells, dev servers, files, notes, and diffs for
  one live effort without requiring a board task.
- Shared constraints/decisions can be pinned once and selectively sent to
  sessions.
- Handoffs capture source session, destination, user-selected context, and
  timestamp; never dump whole transcripts by default.
- Master can identify conflicting assumptions across summaries/notes and ask the
  user which should win.
- Project layouts launch the usual set of panes and commands together.

### 1.2 Structured agent adapters

- Define an adapter contract for lifecycle, conversation id, status, tool calls,
  permission requests, usage, and resume.
- Implement supported adapters without coupling core session behavior to one
  private format.
- Explore Agent Client Protocol or stable vendor hooks where available.
- Detect nested subagents/agent teams and show them under the parent session when
  reliable; otherwise show an opaque activity indicator.
- Let addons contribute adapters only through bounded parsing/event APIs, never
  arbitrary privileged process inspection.

### 1.3 Usage awareness without fake precision

- Show exact provider/CLI usage when a structured adapter supplies it.
- Keep terminal-output estimates visibly labeled as estimates.
- Per-session burn alerts and soft limits; stopping an interactive session at a
  hard limit is opt-in.
- Compare model/session costs without implying equivalent work quality.
- Master/monitor token spend is reported separately from the underlying CLI.

### 1.4 Secure remote hands

- Pair a device explicitly and keep execution/credentials on the host.
- Show live bounded terminal output, attention, cwd/branch, and pending prompt.
- Allow short input, approve/deny, interrupt, and focus requests.
- Evaluate remote actions through the same host policy; direct remote shell
  creation and settings mutation remain out of v1.
- Support private-network/self-hosted transport first; do not expose an
  unauthenticated local server.

### 1.5 Session history and forks

- Search session notes, summaries, user messages, CLI ids, branches, and
  timestamps across workspaces.
- Resume from a historical conversation into the original checkout, a new
  worktree, or read-only inspection.
- Fork a conversation/approach while keeping lineage visible.
- Compare two forks' prompts, summaries, and Git changes.

## Separate board and automation track

The board can pursue a more autonomous workflow in parallel, but it consumes
sessions rather than redefining them.

### B1. First-class task attempts

- Add `TaskAttempt` with attempt number, session ids, optional worktree, budget,
  timestamps, evidence, gate results, and outcome.
- Reconcile incomplete attempts/worktrees after restart.
- Keep task status and attempt status out of unattached sessions.

### B2. Deterministic gates and review

- Task/template criteria may declare commands, expected exit, required files,
  CI status, and reviewer checks.
- Attach bounded evidence to the attempt and map it to criteria.
- Prevent automated merge after failed required gates unless the user records an
  override.
- PR/CI/review-thread integration belongs here and in optional session sidecars,
  not as a prerequisite for every terminal.

### B3. Bounded task autopilot

- Master may propose task decomposition, dependencies, worktree strategy,
  templates, budgets, and checkpoints.
- The user approves the plan before workers launch unless a board automation
  policy explicitly permits it.
- Concurrency and delegation depth are bounded.
- Board schedules and overnight work produce an attempt report and stop at
  decisions; they do not take control of unrelated sessions.

### B4. Task economics and evaluation

- Exact/estimated/unknown cost stays distinct.
- Track accepted outcome, retries, review changes, intervention count, elapsed
  time, model/template/skill versions.
- Use the data to recommend configurations with sample size/confidence, not to
  silently rewrite skills or auto-route all interactive sessions.

The board track should not block Horizon 0 session work except where both share
process lifecycle, command policy, Git, or testing infrastructure.

## Later opportunities

These are useful only after the hands-on loop is excellent:

- multi-machine session inventory and attach, starting with user-owned hosts;
- collaborative terminal viewing with explicit control ownership;
- richer artifact previews beside chat/terminal sessions;
- workspace memory with provenance and selective session injection;
- MCP OAuth and richer protocol capabilities for in-app chat;
- plugin-hook translation into YAAM adapters or board gates;
- team policy and shared review for board attempts;
- platform-specific app control behind explicit command policy.

## Explicit non-goals

- **No universal `Run` wrapper for sessions.** Only board attempts require a
  bounded outcome lifecycle.
- **No mandatory worktree.** Shared-checkout and non-editing sessions remain
  legitimate hands-on workflows.
- **No terminal replacement by summaries.** Summaries navigate to evidence; the
  terminal remains available and authoritative.
- **No default autonomous Master.** Acting across sessions requires an explicit
  request or configured automation.
- **No generic IDE expansion.** File/Git/test surfaces exist to understand and
  steer sessions, not replace the user's editor.
- **No cloud job platform as the main direction.** Remote access extends local
  sessions; it does not require hosted execution.
- **No exact universal CLI billing claim.** Unknown is more trustworthy than
  fabricated precision.
- **No unbounded agent hierarchy.** Nested agents are visualized first; YAAM does
  not recursively create managers by default.
- **No pixel-level computer use until terminal, browser/MCP, and platform APIs
  are exhausted and policy-complete.**

## Priority summary

```text
NOW
  truthful status + attention
  fast switching/input/terminal quality
  restore/resume
  hands-on Overview
  session-aware Master
  files/Git/tests beside sessions

NEXT
  working sets + handoffs
  structured CLI adapters
  usage awareness
  secure remote hands
  session history + forks

OPTIONAL BOARD TRACK
  TaskAttempt
  deterministic gates/review
  bounded autopilot
  task economics/evals
```

The ordering is deliberate: YAAM earns the right to coordinate more by first
making direct work across many live sessions faster, clearer, and harder to
lose.

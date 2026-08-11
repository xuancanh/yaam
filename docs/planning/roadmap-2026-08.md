# YAAM Roadmap, August 2026

Synthesis of four research passes: Claude Code integration surfaces, OpenCode and Codex
integration surfaces, the competitive landscape, and a map of YAAM's own integration
architecture. Sources and full detail live in the research notes; this doc is the plan.

## 1. Where YAAM stands

**The good news.** No competitor covers YAAM's combination: local desktop + real PTY
terminals + worktree isolation + diff review and merge + kanban board + SSH remote
machines + mobile remote + an LLM orchestrator, all in one app. The nearest composites
are Conductor (no kanban, no bring-your-own SSH boxes) and Nimbalyst (no PTY, no SSH,
no orchestrator).

**The bad news.** YAAM's sensing layer is the weakest in the field. Every agent CLI is
an opaque PTY; status is inferred by regexes over the rendered xterm screen
(`prompt-detection.ts` literally string-matches "Do you want to proceed" and
"esc to interrupt"). Any copy change in a Claude Code or Codex release silently breaks
needs-input detection. Meanwhile every serious agent now exposes a structured surface:

- **Claude Code**: lifecycle hooks (HTTP hooks POST tool-use / permission / stop events
  to any listener), `--permission-prompt-tool`, `stream-json` headless mode, session
  transcripts at a path knowable *before launch* (YAAM already mints `--session-id`),
  MCP injection per session, Remote Control server, Agent Teams.
- **OpenCode**: the TUI is a client of a local HTTP server. SSE event bus
  (`session.status`, `session.idle`, `permission.asked`, `file.edited`, `session.diff`),
  a permissions-answer endpoint, a typed SDK, endpoints that type into the user's TUI.
  Note: session storage moved to SQLite; the JSON layout YAAM's `detect_cli_session`
  scans for OpenCode is legacy.
- **Codex**: `codex app-server` (bidirectional JSON-RPC used by OpenAI's own IDE
  extension: thread lifecycle, `turn/steer`, `turn/interrupt`, and server-to-client
  approval requests YAAM can answer), `codex exec --json` event stream, tailable rollout
  JSONLs under `~/.codex/sessions/`, a TS SDK.

**The market.** Consolidation is brutal: Terragon dead (Feb), Vibe Kanban orphaned
(Apr), Crystal deprecated. Big entrants validate the category: Spotify Xirp
(cross-harness context portability), Databricks Omnigent (policies, spend caps,
multiplayer), AWS Kiro Crew (24/7 scheduling, persistent memory, approvals), Herdr
(YC-backed "tmux for coding agents" with a plugin marketplace and a socket API).
The 2026 trends: structured interop protocols (MCP, ACP) as plumbing, execution moving
off-laptop with control moving to the phone, isolation commoditized, and **the human
attention layer (review, approvals, needs-you queues) as the real battleground**.

**Thesis.** Keep the unique full-stack combo. Replace the sensing layer with per-agent
structured adapters, then spend the reliability dividend on the attention layer
(approvals inbox, review flow) and orchestration, which is where the category is being
won.

## 2. Phase 1: Structured sensing (the adapter layer)

Goal: deterministic status, needs-input, and activity for Claude Code, Codex, and
OpenCode. Regex detection stays as the fallback for aider/gemini/shells.

1. **Widen `AgentType` into an adapter registry.** `probe?: 'claude'|'codex'` is
   already a one-off discriminator and `buildTemplateCommand` already switches on it.
   Add capability fields (transcript path scheme, JSON stream flag, hooks installer,
   MCP config flag, permission model, `statusSource: 'terminal'|'transcript'|'events'`)
   and move per-CLI knowledge out of `template-command.ts` into adapters. Fix
   `typeForCommand()` exact-basename matching while there.
2. **Claude adapter: hooks + transcript.** Install per-session HTTP hooks (PreToolUse,
   PermissionRequest, Notification, Stop, SessionEnd) pointing at a local YAAM listener;
   YAAM already knows the session UUID at launch, so the transcript path
   `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl` is known before spawn. Add
   `readTranscript`/`watchTranscript` to `SessionProcessPort` backed by a Rust watcher
   next to `detect_cli_session_impl`. Hooks are authoritative; transcript tail is the
   backfill.
3. **Codex adapter: rollout tailing.** Tail
   `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` for sessions YAAM spawned (and, later,
   any session on the machine). Structured turn/item events replace screen scraping.
4. **OpenCode adapter: own the server.** Re-enable the OpenCode agent type (currently
   dead code on the TS side), spawn the TUI with a known `--port`, subscribe to the SSE
   event bus via `@opencode-ai/sdk`. This is the cleanest integration of the three.
5. **`SessionSignalSource` interface at the settle boundary.** `use-settle.ts` and
   `needs-provenance.ts` already model signal ownership; introduce
   terminal-regex vs structured-events sources so everything downstream
   (`setNeedsInput`, checkpoints, watcher notes) stays untouched.

Payoff: the flaky core becomes reliable, LLM watcher spend drops (fewer wake-ups on
false "finished" signals), and every later phase builds on real events.

## 3. Phase 2: Two-way control (approvals + orchestration)

1. **Unified approvals inbox.** The "Needs you" group becomes a real permission queue:
   Claude via `--permission-prompt-tool` (an MCP tool YAAM serves) or PermissionRequest
   hooks; OpenCode via `POST /session/:id/permissions/:id`; Codex via app-server
   `execCommandApproval`/`applyPatchApproval`. One-click approve/deny from desktop
   and the mobile remote, with per-folder or per-task policies ("auto-approve reads,
   ask on git push"). This is the attention-layer battleground and no desktop
   competitor has all three agents wired.
2. **YAAM as MCP server for its own sessions.** Inject via `--mcp-config` (Claude),
   `opencode.json` (OpenCode), `config.toml` (Codex): tools like `report_status`,
   `fetch_task`, `update_kanban`, `request_approval`. The board becomes an API agents
   can drive (the one Vibe Kanban idea worth stealing). The MCP plumbing already exists
   in `core/mcp.ts`/`mcp.rs` for chat agents; extend it to spawned CLI sessions.
3. **Route new operations through the command registry.** `answer_permission_prompt`,
   `interrupt_turn`, `send_structured_message`, `install_agent_hooks` as `CommandDef`s
   so Master, watchers, addons, and the UI inherit gating and audit for free.
4. **Master reads events, not screens.** Replace `sendToSession` + wait + screen-tail
   with structured event digests. Cheaper, reliable, and enables real per-session
   cost/token tracking (from `stream-json` usage and `turn.completed` events), which
   feeds Phase 4 spend caps.

## 4. Phase 3: Headless tasks and session adoption

1. **Headless kanban runs.** Board tasks execute without a PTY when the adapter allows:
   `claude -p --output-format stream-json` (with `--max-budget-usd`, `--json-schema`
   for structured results), `codex exec --json --output-schema`, `opencode serve` +
   `session.prompt` with JSON-schema output. Live PTY stays for interactive sessions;
   the watcher gets typed progress instead of prose.
2. **Adopt external sessions.** Watch transcript/rollout stores and offer "adopt into
   YAAM" for sessions started in a plain terminal (resume by id, attach status
   tracking). Herdr proves people want the manager to meet them where they already are.
3. **Always-on positioning.** YAAM already has schedules, templates, and detached
   sessions surviving app restarts. Frame and harden this as the local-first answer to
   Kiro Crew: recurring workflows + approval gates + persistent assistant memory,
   without a proprietary metered CLI.

## 5. Phase 4: Differentiation

1. **Cross-harness handoff (the Xirp feature nobody else has).** Export context from one
   agent and seed another: `claude /export` or transcript read, `opencode export`,
   Codex rollout replay, distilled through the existing chat-compaction machinery into
   a new session's system prompt. Start with "continue this task with a different
   agent" on a board card.
2. **Adapters as addons.** Extend the addon manifest so a package can contribute an
   agent type/adapter, richer hooks (`onToolUse`, `onPermissionRequest`,
   `onTranscriptEvent`), and status detectors. The plugin importer already wants this
   (`translateHooksToAddon` skips most Claude hook events today). This is the path to a
   community integration ecosystem without core patches per CLI.
3. **Policies and spend.** Per-workspace/per-task budgets enforced via adapter flags
   (`--max-budget-usd`, turn limits) and surfaced in the rail; audit log already exists
   in the command registry. Omnigent validated demand; YAAM can do it local-first.
4. **Optional, evaluate later:** Claude Remote Control / Agent Teams bridges (both
   still gated or experimental), Codex cloud handoff (`codex cloud apply` into the diff
   viewer once the lifecycle API stabilizes).

## 5b. Kiro and ACP (added after Kiro research, Aug 11)

Kiro's CLI is proprietary and credit-metered, its headless mode prints plain text
(no JSON output or session-id echo yet; upstream issues #5423/#9066 are open), and
Kiro Crew exposes no connector API for external managers. The real surfaces:

1. **ACP client (the strategic one).** `kiro-cli acp` speaks the Agent Client
   Protocol (JSON-RPC over stdio, published by Zed, v1): session lifecycle,
   streaming chunks, ToolCall/ToolCallUpdate/TurnEnd, and a client-implemented
   `session/request_permission` that plugs straight into the Phase 2 approvals
   inbox. One ACP client gives YAAM three agents at once: Kiro, Gemini CLI
   (native), and Claude Code via the official `@agentclientprotocol/claude-agent-acp`
   adapter. This becomes a fourth adapter kind: `statusSource: 'acp'` sessions run
   over stdio instead of a bare PTY. Verify empirically whether Kiro emits
   permission requests over ACP or auto-resolves from agent config.
2. **Kiro hooks tap for PTY sessions.** `.kiro/hooks/*.json` (project) and
   `~/.kiro/hooks/` (global) fire PreToolUse / PostToolUse / UserPromptSubmit /
   SessionStart / Stop with session context as JSON on stdin — the same shape as
   YAAM's Claude hook listener, so a small command action forwarding stdin to the
   loopback listener reuses the whole 1.2 pipeline.
3. **Steering as the memory channel.** `.kiro/steering/*.md` loads
   unconditionally in the CLI; the folder-scoped memory design (`memory-design.md`)
   delivers to Kiro by writing a managed steering file, alongside AGENTS.md and
   CLAUDE.md.

Sequencing: the hooks tap is a small follow-up to Phase 1; the ACP client is a
Phase 2-sized item that lands best together with the approvals inbox since the
protocol hands the permission flow to the client by design.

## 6. Product track (interleaves with the phases)

Session control is the plumbing; these are the product bets that ride on it. Rough
pairing: item 1 lands well alongside Phase 2, item 2 alongside Phase 1's events,
items 3 and 4 alongside Phase 3.

1. **The "after the agent finishes" pipeline.** Review is more than a diff viewer:
   auto-run checks (build, tests, lint) when a session settles so the review card is
   green or red before anyone looks; per-worktree browser preview of the running app
   (Vibe Kanban had device emulation); inline diff comments that become a follow-up
   prompt; and a PR layer with CI status, since YAAM stops at local merge today while
   Conductor's flow ends in a PR. Reviewing N parallel diffs is the bottleneck the
   whole category shares; this is the highest-leverage non-plumbing work.
2. **Cost and usage analytics.** Structured events carry tokens and dollars per
   session for free. Surface them: spend per task/workspace/model, budget alerts,
   "this task cost $4.20 across 3 sessions". agent-deck ships cost tracking as a
   headline feature and Omnigent's spend caps validated demand; the dashboard is cheap
   once Phase 1 exists, and it feeds the Phase 4 policy work.
3. **Project memory as a feature, not internals.** Memory keyed by working folder,
   not session or harness: project facts, episode summaries, harvested corrections,
   and preferences, injected via each adapter's native mechanism (AGENTS.md /
   CLAUDE.md managed blocks, system-prompt flags, later MCP pull). Local-first and
   cross-harness is the differentiator against Kiro Crew's cloud-locked memory.
   Full design: `memory-design.md`.
4. **Notifications and attention routing.** The approvals inbox needs delivery: push
   to the mobile companion, optional Telegram/Discord bridges (Claude Code channels
   and herdr-remote both point here), and a daily digest of what fleet sessions did.
   Control is moving to the phone; YAAM has the mobile view but no push story.
5. **Distribution and ecosystem strategy.** Not code, but the research is blunt:
   closed-and-quiet independents died (Terragon, Bloop); the growers are open source
   with marketplaces (Herdr: 500+ plugins in month one) or market loudly (Nimbalyst).
   YAAM already has an addon SDK and a registry. Decide deliberately on open-sourcing,
   seed the registry with a handful of first-party addons, and court the Terragon and
   Vibe Kanban refugees looking for a home.

## 7. Explicitly deferred (revisit, don't drift into)

- **Container isolation as a worktree alternative** (Sculptor's Docker angle): catches
  env-contamination cases worktrees can't, but meaningful effort for niche demand so
  far. Revisit if users hit it.
- **Cloud runner provisioning**: SSH machines already work; a "provision me a box"
  flow (Hetzner/EC2/Modal template) would close the Conductor Cloud gap without
  running infra. Evaluate after Phase 3.
- **Team multiplayer** (shared session viewing, comments): Omnigent and Conductor
  Team are betting on it, but it fights the desktop-local architecture. Deferred on
  purpose, not forgotten.
- **Reliability housekeeping**: full transcript retention (200 lines today),
  crash-safe event storage, and the items in `rearchitecture-hotspots.md`. Schedule
  alongside Phase 1, which will stress exactly these paths.

## 8. Sequencing rationale

Phase 1 is prerequisite infrastructure and pays for itself in reliability. Phase 2 is
the visible differentiator (three-agent approvals inbox) and makes the orchestrator
trustworthy. Phase 3 turns the board into a fleet surface. Phase 4 items are
independent bets; cross-harness handoff is the most defensible, adapters-as-addons is
the ecosystem play. The product track interleaves rather than queues: the review
pipeline and analytics are what users see while the plumbing lands. Throughout: stay
local-first and multi-harness; that is the corner of the map the platform vendors
(Anthropic, OpenAI, Cursor) structurally cannot occupy and where the dead independents
were weakest.

## 9. Known constraints

- Claude transcript JSONL is an internal format; prefer hooks as the authoritative
  signal and treat transcript parsing as best-effort with version guards.
- OpenCode storage is now SQLite; do not build on the legacy JSON session layout that
  `detect_cli_session_impl` currently scans.
- Codex app-server schemas drift per release; generate types per version.
- Claude Remote Control requires claude.ai subscription and direct Anthropic API
  (no Bedrock/Vertex); Agent Teams is experimental.
- Session log retention is 200 lines today; structured event storage needs its own
  retention design (persistence caps: 64 MB main state, 16 MB per session).

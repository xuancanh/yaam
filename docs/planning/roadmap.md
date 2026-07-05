# YAAM roadmap — where this goes next

*Working document, July 2026. Grounded in the shipped feature set and a scan of
the agent-orchestration landscape (Conductor, Nimbalyst/Crystal, Vibe Kanban,
Claude Cowork, Cursor background agents). Opinionated on purpose.*

## Where YAAM stands today

YAAM's bet is different from the worktree-launcher crowd: not just *run N
agents in parallel*, but put an **LLM Master between the user and the fleet**,
give every session a cheap monitor that escalates instead of streaming noise,
and let kanban watchers own tasks end-to-end. Around that core it now has: a
Claude-Desktop-class chat agent (20+ local tools, slash skills, file import
with PDF/office extraction, vision, ask-mode approvals), terminal PTY sessions
with a git-aware explorer/rich viewer, MCP over HTTP *and* stdio with a
marketplace + config import + `.mcpb` bundles, Claude plugin marketplaces,
skills/personas/templates/schedules, its own sandboxed addon system, full-text
chat search (tantivy), themes/density/typography, and OS-keychain secrets.

The one-liner: **Conductor manages worktrees; Cowork manages one agent's
autonomy; YAAM manages a *staff*.** The roadmap should compound that.

## Honest limitations (as of now)

- **No workspace isolation between sessions.** Two agents in the same folder
  can stomp each other's edits; competitors made worktrees table stakes.
- **Single machine, single user.** No remote access, no team sharing, no way
  to check the fleet from a phone when a watcher pings at dinner.
- **Cost is estimated, not measured.** Usage numbers come from output-volume
  heuristics, not provider token counts; there are no budgets that *enforce*.
- **Chat memory is a sliding window.** History caps at 60 API messages / 200
  bubbles; the agent has no durable memory of you or the project. Attached
  images ride the window and re-bill every turn.
- **Review is manual.** Watchers verify criteria, but there is no diff-review
  queue; "done" moves on trust plus a git pane.
- **Trust boundaries are honor-system beyond writes.** Filesystem writes are
  Rust-enforced, but `run_command` is an unrestricted shell behind one Allow
  click, MCP servers run unsandboxed, and web tools ingest pages without
  prompt-injection screening.
- **Assorted sharp edges**: scanned PDFs yield nothing (no OCR); stdio MCP
  serializes requests per server; GitHub registries are unauthenticated
  (60 req/h); terminals stay dark in light theme (xterm canvas); plugin
  `agents/` and `hooks/` are imported as "skipped"; monitors/watchers have no
  quality evals; Windows/Linux app-control has no `run_applescript` peer.

## Horizon 1 — Trust the fleet (next quarter)

The theme: make parallel agents *safe* enough that you stop babysitting.

1. **Worktree-per-task isolation.** Board tasks and sessions opt into a
   `git worktree` under `.yaam/worktrees/<task>`; teardown reaps clean ones.
   This is the biggest gap vs. Conductor/Nimbalyst and it unlocks everything
   below.
2. **Review queue.** A "Review" column that means something: per-task diff
   viewer (the FilesPane gutter already parses hunks), watcher-written change
   summary, approve → merge/commit, reject → bounce back to the agent with
   your comment as the task note.
3. **Real metering + hard budgets.** Read provider usage fields off every
   response; per-chat/per-task/per-day budgets that pause the agent and ping
   Master instead of silently spending.
4. **Command policy for ask-mode.** Allowlist patterns ("npm test", "git
   status" auto-run; `rm`, `push`, `curl | sh` always ask), remembered
   per-chat "always allow this exact command," and a visible audit trail.
5. **Paper cuts with outsized payoff**: OS notifications for escalations;
   GitHub PAT setting for registries/marketplaces; PDF OCR via the macOS
   Vision framework; light-theme terminal palette; message edit-and-resend.

## Horizon 2 — The control tower (3–6 months)

The theme: YAAM stops being a window you watch and becomes a place work lands.

1. **Fleet view.** One screen: every session/watcher/chat as a live card —
   status, current step, spend, attention flags — with Master's routing
   visible as connections. The Overview grown into an actual ops console.
2. **Remote hands.** A read-mostly web companion (VibeTunnel-style tunnel or
   Tailscale-friendly local server): see the fleet, answer escalations,
   approve ask-mode prompts from a phone. Approval-from-anywhere changes how
   long agents can safely run.
3. **Durable memory.** Per-workspace memory files chat agents read on start
   and append distilled facts to (the tantivy index already gives recall);
   "remember this" as a first-class tool. Cowork-class continuity without
   vector-DB ceremony.
4. **Artifacts pane.** Chat outputs that are *products* (HTML, SVG, charts,
   slides) render live in a sandboxed iframe next to the conversation — the
   addon sandbox already proved the pattern.
5. **Plugin parity.** Translate Claude Code plugin `agents/` into chat
   personas and `hooks/` into addon hooks at install time, so marketplace
   plugins arrive whole instead of "skipped."
6. **Voice + push-to-talk for Master.** The orchestrator is the one agent you
   should be able to talk to while your hands are on something else.

## Horizon 3 — The staffing agency (6–12 months)

The theme: stop configuring agents; start *hiring* them.

1. **Outcome-driven autopilot.** Describe an outcome; Master decomposes it
   into board tasks, picks templates, sets budgets, schedules checkpoints,
   and only surfaces decisions — the full loop that schedules + watchers +
   budgets already gesture at, made default.
2. **Multi-machine fleets.** A headless `yaam-agent` daemon adopts remote
   boxes (build server, beefy GPU box); sessions declare placement; the PTY
   stream already travels as events, so the UI barely changes.
3. **Skill economics.** Track which skills/templates actually finish tasks
   (watcher verdicts are labeled outcomes); auto-suggest "this skill fails
   40% of the time — let the agent rewrite it" via the existing `save_skill`
   loop. Skills that improve themselves, with humans approving diffs.
4. **Eval harness for the meta-agents.** Golden transcripts for monitors,
   watchers, and Master routing, run in CI — today their prompts change on
   vibes; regressions in "when to escalate" should fail a test, not a demo.
5. **Team workspaces.** Share a workspace (state sync via git or CRDT), so a
   team reviews one fleet: my agent, your approval, shared memory.

## Moonshots (earn their keep or die)

- **Time-machine forking.** Persist every task's turn-by-turn trace; rewind a
  failed run to step 7, edit the instruction, fork reality, and compare
  branches. Post-mortems become experiments.
- **Agents hiring agents.** Master spawns scoped sub-masters (a "frontend
  lead" owning three sessions) with delegated budgets — org charts for
  software labor, depth-capped and fully audited.
- **The overnight report.** You close the laptop; schedules run the fleet on
  the night's backlog; at 8am one artifact: what shipped, what's blocked on
  you, what it cost, sorted by decision value. YAAM's endgame is not a
  faster cockpit — it's mornings that start with reading, not driving.

## What we deliberately won't do

- **Not an IDE.** Editors are solved; YAAM opens files to *understand agents*,
  not to type into. Deep-link out instead.
- **Not a cloud service.** Local-first, your keys, your machine(s). A tunnel
  for remote access ≠ hosting your fleet.
- **Not pixel-level computer use** until the AppleScript + browser-MCP pair
  demonstrably runs out of road — driving APIs beats guessing at pixels.
- **Not another framework.** No YAML DAGs, no graph DSL. The orchestrator is
  an LLM with tools; the product is the *supervision*, not the plumbing.

## Sequencing rationale

Isolation → review → budgets is one dependency chain: you can't trust more
autonomy (H3) before parallel work is collision-free and reviewable (H1), and
remote approvals (H2) only matter once approvals are cheap and safe. Memory
and artifacts ride on surfaces that already exist (search index, addon
sandbox), which is why they're mid-roadmap despite outsized demo value.

*Landscape references:* [Conductor](https://conductor.build) ·
[Nimbalyst (ex-Crystal)](https://nimbalyst.com/blog/best-multi-agent-coding-tools-2026/) ·
[the multi-agent orchestration wave](https://addyosmani.com/blog/code-agent-orchestra/) ·
[Claude Cowork](https://www.anthropic.com/product/claude-cowork).

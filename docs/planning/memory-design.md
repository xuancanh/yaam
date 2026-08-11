# Cross-Session Memory Design, August 2026

Expansion of roadmap product-track item 3 (`roadmap-2026-08.md`). Brainstorm-level;
nothing here is committed scope until it graduates into the roadmap phases.

## Starting point

YAAM already has memory for its own LLM assistants: `assistant-memory.ts` is a shared
multi-file store (approvals, preferences, patterns, corrections, notes) with
`memory_lookup`/`memory_save` tools wired into Master, monitors, and watchers, and
`harness-stats.ts` records implicit feedback from user approve/deny decisions.

What is missing: memory that reaches the coding agents themselves, and memory scoped
the way work actually happens.

## The reframe: memory belongs to the folder

Sessions are ephemeral and harnesses are interchangeable (that is the multi-harness
pitch); the repo is the durable thing. Memory should be keyed by working folder, which
is also becoming YAAM's organizing unit (the Runs rail groups by folder). Four layers
with different lifetimes:

1. **Project facts** (long-lived): build/test commands, gotchas, conventions,
   architecture pointers. Example: "bare `tsc --noEmit` is a no-op here, use
   `-p tsconfig.app.json`."
2. **Episode summaries** (medium-lived): distilled outcomes of past sessions and tasks
   in this folder: what was tried, what failed, what merged. Powers "this task was
   attempted twice before, both hit the same flaky test."
3. **Corrections** (long-lived, highest value): every rejected diff, every "no, do X
   instead" re-prompt, every user edit of agent work before merge is a memory
   candidate. Highest-signal source; nobody harvests it well today.
4. **Preferences** (global plus per-folder overrides): style, tooling, hard rules
   ("never force-push"). Partially exists in assistant-memory already.

## Sources, in three tiers of automation

- **Explicit**: a "remember this" action on a session, diff, or chat message, plus a
  directly editable memory panel. Ship first.
- **Harvested with review**: on session exit or task merge, a cheap LLM pass distills
  transcript + diff + outcome into candidate memories that land in a review queue
  (approve / edit / discard). Silent auto-harvest poisons the store when the model
  over-generalizes; keep the human gate until precision is proven.
- **Implicit**: promote `harness-stats` patterns ("always approves git status",
  "rejected rm -rf twice") into suggested approval policies and preferences.

## Delivery into agents (rides on the adapter layer)

- **File injection**: `AGENTS.md` is the de-facto cross-agent standard (Codex and
  OpenCode read it; Claude reads CLAUDE.md). YAAM maintains a clearly fenced managed
  block, or a separate `yaam-memory.md` referenced from it. Caveat: repo files are
  shared via git; personal memory must travel through user-level paths or launch
  flags, never committed files.
- **Flag injection**: `--append-system-prompt` (Claude), system-prompt concatenation
  (Codex exec), agent config (OpenCode) for the small always-relevant core.
- **Pull via MCP** (the scalable one): the Phase 2 YAAM MCP server exposes
  `memory_lookup` to the coding agents. Inject only a two-line index ("this folder has
  14 memories; query the yaam memory tool") and let agents fetch what is relevant
  mid-task. Avoids the prompt-bloat wall and works identically across harnesses.

## Guardrails

- **Provenance** on every memory: which session/date created it, one click to source.
- **Staleness decay**: a memory referencing a deleted file or command gets flagged for
  review rather than silently injected forever.
- **Secrets filtering** before anything is written to the store.
- **Hard size cap** on the always-injected core; memories compete with the actual task
  for context.
- **Per-folder off switch** and full user visibility: every injected line is readable
  and editable.

## Competitive angle

Kiro Crew's persistent memory is cloud-side and locked to their CLI. "Your memory
lives in your folders, follows you across Claude/Codex/OpenCode, and you can read
every line of it" is a defensible local-first story. It also quietly sets up
cross-harness handoff (roadmap Phase 4): a handoff is episode memory plus working
state handed to a different agent.

## MVP sequencing

1. Per-folder memory file + editable panel in the sidebar folder view + explicit
   "remember this" + injection via each adapter's native mechanism.
2. Exit-time harvest queue (candidate memories with approve/edit/discard).
3. MCP pull and implicit promotion, after roadmap Phase 2 lands.

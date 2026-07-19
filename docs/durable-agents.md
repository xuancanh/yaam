# Durable agents architecture

## Identity versus conversation

A durable agent is a persistent identity above ordinary chat sessions. The
`DurableAgent` record stores the name, role, charter, color, provider/model
defaults, selected skill sources, optional home folder, dashboard, mini apps,
archive state, and creation time. A chat session stores only a
`durableAgentId`; many conversations can belong to one identity and remain
workspace-scoped.

The built-in generic assistant is a non-deletable durable identity. It may have
no home folder, in which case lessons fall back to workspace chat memory. A
custom agent normally receives a home folder that becomes both its working
directory and its file brain.

## File brain

The home folder is transparent, portable user data rather than a hidden vector
store:

```text
<homeDir>/
├─ LESSONS.md       corrections, preferences, durable working rules
├─ JOURNAL.md       distilled episodic history
└─ knowledge/       agent/user files and domain notes
```

`loadBrain()` reads the two markdown files lazily. Each turn injects the
charter, a bounded tail of lessons (2,400 characters), and a bounded tail of
journal (1,600 characters) into the system prompt. The agent can use normal
file tools for `knowledge/` and a bounded grep-based `knowledge_search` that
returns ranked, trimmed hits. Missing files and missing home folders are safe
empty states.

`learn_lesson` appends through a per-file queue, creates a header on first use,
and caps each brain file at 60,000 characters while preserving the header and
newest entries. This prevents concurrent turns from losing appends and keeps
prompt/retrieval costs bounded.

## Reflection and feedback

Reflection is an explicit post-conversation action. It sends a bounded recent
transcript, user ratings, and failed-turn signals to the configured provider
with a single `submit_reflection` tool. The result is a short journal entry and
up to three durable lessons. The runner appends them to the file brain and
updates the agent's reflection timestamp. Agents without a home folder write
lessons to workspace chat memory instead.

When the home folder is a Git repository, `commitBrain()` stages only
`LESSONS.md`, `JOURNAL.md`, and `knowledge/`, then creates a scoped commit. It
never stages the user's unrelated project changes and never initializes a new
repository automatically.

## Profile tools and home page

The durable-agent tool surface includes:

- `update_my_profile` for charter/settings evolution;
- `learn_lesson` and `knowledge_search` for continuity;
- `update_dashboard` for the markdown home page;
- `save_app` for self-contained HTML mini apps;
- normal chat file/exec/skill/MCP tools, subject to chat policy.

Mini apps run only when opened in opaque-origin, network-denied iframes with no
YAAM RPC bridge. Dashboard and app sizes are bounded during hydration and
import. The home view exposes conversations from the active workspace while
the identity, brain, dashboard, and apps remain global.

## Loops and scheduling

Each recurring loop is a normal five-field cron record associated with a
`durableAgentId`. Hiring a template seeds a charter and optional loops; loop
execution creates a chat conversation and sends the configured prompt through
the ordinary chat runner. The scheduler is the single owner of due collection,
deduplication, and firing, so loops use the same 15-second scheduler tick as
other schedules. Archiving an agent stops its loops while preserving its
conversations and files.

Loops spend provider tokens and can edit the brain/project, so imported profiles
show their enabled loops and mini apps in an explicit capability review before
installation. Invalid cron expressions, oversized prompts, and excess loop
counts are discarded during `AGENT.json` parsing.

## Import, export, and marketplace

`<homeDir>/AGENT.json` is a portable profile envelope:

```json
{
  "yaamAgent": 1,
  "name": "Researcher",
  "role": "verifies claims",
  "color": "#3DDC97",
  "charter": "…",
  "loops": [{ "name": "weekly", "schedule": "0 9 * * 1", "prompt": "…" }],
  "dashboard": "…",
  "apps": [{ "name": "Tracker", "html": "<!doctype html>…" }]
}
```

Parsing validates the version marker, trims names/charter/prompts, accepts only
valid cron loops, caps loop count and fields, validates colors, and caps
dashboard/app content. Import creates or updates the durable identity while
the selected home folder remains the source of brain files.

Configured registries may expose an `agents` array alongside addons. The
market loader resolves local or HTTPS profile URLs, parses the same envelope,
and shows the charter, token-spending loops, and mini apps before hire. A failed
registry is skipped without preventing other registries from loading.

## Persistence and security boundaries

Durable-agent records are global main-partition state; chat logs remain in
per-session files and workspace scoping. Home-folder reads/writes are still
user-authority operations and use the chat Ask/Auto policy. The Rust filesystem
root check is the security boundary for chat writes. Reflections, loops, and
brain commits are bounded/cancellable runtime actions, not trusted model
claims.

When changing this feature, update `core/entities.ts`, `durable-brain.ts`,
`agent-templates.ts`, `agent-market.ts`, chat runner/actions, persistence
selectors, and the chat requirements document together.

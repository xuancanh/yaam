# yaam — Conductor

A desktop app for orchestrating multiple coding agents, built with [Tauri 2](https://tauri.app) + React + TypeScript from the design in `design/Conductor.dc.html`.

**Conductor** puts a "Master" orchestrator agent in charge of a fleet of coding-agent sessions (Claude Code, Codex, Gemini CLI, Aider, …). You talk to Master; it routes tasks, escalates decisions, and builds tools/schedules on demand.

## Features

- **Master chat** — a composer that classifies your message and either routes it to an agent, answers a question, builds a tool/cron schedule, or self-builds a live UI panel ("build a latency dashboard")
- **Command palette** (`⌘K`) — route tasks, resume agents, review diffs, jump to any view
- **Workspace** — tabbed agent sessions with an optional split view, live-streaming session logs, and per-pane status
- **Escalations & notifications** — agents blocked on risky actions surface Approve/Deny cards in chat and in the pane; the bell popover tracks unread events
- **Agents overview** — session-flow orchestration graph plus a card grid with status, spend, and quick actions
- **Diff review drawer** — per-agent file diffs with Approve & merge / Request changes; agent detail drawer shows spend, tokens, resume points, and session history
- **Task board** — kanban with drag & drop across Backlog → Routed → In progress → Needs review → Done; cards link to their agent
- **Activity timeline** — every agent action and Master decision, newest first
- **Cost & usage** — spend/budget bars and token totals per agent
- **Schedules** — recurring agent runs (cron), some built by Master itself
- **Tools & permissions** — shared capability registry; per-agent tool toggles with Off / Ask first / Auto / Approval permission levels
- **Settings** — orchestration policy toggles, agent-type enablement, and integrations
- **Memory panel** — per-agent context sources with token budgets you can toggle

## Real sessions

Beyond the simulated demo agents, Conductor manages **real OS-process sessions** through its Rust backend:

- **＋ New agent session** → enter any CLI command (`claude -p`, `python3 -i`, `zsh -i`, …) and an optional working directory
- stdout/stderr stream live into the workspace pane; a `❯` input row sends lines to the process's stdin
- Stop (kills the process), Resume (respawns the same command), and exit codes surface as session status (Paused / Error)
- Board tasks, schedules, settings, tool registry, agent types, and integrations persist to disk (`~/Library/Application Support/dev.yaam.conductor/conductor-state.json`) and restore on launch

The four seeded agents (Claude Code, Codex, Gemini CLI, Aider) remain simulated so the orchestration UX is explorable without spawning anything.

## Structure

```
design/   Original design prototype (Conductor.dc.html)
app/      Tauri app
  src/          React frontend (store.tsx holds all state + actions)
  src-tauri/    Rust backend + window config
```

## Development

Requires Node 20+, Rust (rustup), and Xcode command-line tools on macOS.

```sh
cd app
npm install
npm run tauri dev      # run the desktop app with hot reload
npm run tauri build    # produce a distributable bundle
```

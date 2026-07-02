# yaam — Conductor

A desktop manager for multiple live coding-agent sessions, built with [Tauri 2](https://tauri.app) + React + TypeScript from the design in `design/Conductor.dc.html`.

**Conductor** puts a "Master" orchestrator between you and a fleet of real CLI sessions (Claude Code, Codex, Gemini CLI, Aider, shells, REPLs — anything). You talk to Master; it routes tasks to sessions, watches them, escalates, and builds schedules and tools.

## Sessions — real terminals

Every session is a real OS process in a **PTY**, rendered with **xterm.js** — an iTerm-style terminal in each workspace pane:

- **＋ New agent session** → pick an agent type (commands configurable in Settings), a plain terminal (zsh/bash/sh/fish/nu), or a custom command; pick the working directory with a native folder chooser
- Full terminal emulation: prompts, colors, TUIs, keystrokes straight to the PTY, resize handled
- Spawned through a login shell, so your PATH (nvm, homebrew, cargo) works
- Stop / resume / exit-code status per pane; tabbed with optional split view

## Master — three-way orchestration

Master is a **Claude model with tools** (enable in Settings → Master Brain with an Anthropic API key; model selectable):

- **You → Master**: chat composer (⌘K palette for quick actions)
- **Master → sessions**: tools — `launch_session`, `send_to_session` (writes to a session's PTY), `stop_session`, `create_schedule`, `add_task`
- **Sessions → Master**: each terminal's ANSI-stripped output tail and status feed Master's context; session exits/failures trigger proactive Master turns (follow mode)

Without an API key, Master falls back to a heuristic router (status answers, routing to the focused live session, schedule/tool building).

## The rest

- **Schedules** — a real cron scheduler (5-field expressions); schedules with a command launch live sessions on fire; create/delete in the UI or ask Master
- **Notifications & activity** — session exits, failures, cron runs, and Master decisions land in the bell popover and the Activity timeline
- **Diff review** — the drawer runs `git diff` in a session's working directory with Approve / Request changes
- **Task board** — kanban with drag & drop, inline rename (double-click), delete; cards link to sessions
- **Cost & usage** — per-session usage estimates from output volume
- **Tools & permissions, memory panels, integrations, orchestration policy** — configurable registries, persisted
- **Persistence** — board, schedules, settings, tools, agent types, and integrations survive restarts (`~/Library/Application Support/dev.yaam.conductor/conductor-state.json`)

## Structure

```
design/   Original design prototype (Conductor.dc.html)
app/      Tauri app
  src/            React frontend (store.tsx = state + orchestration, master.ts = LLM Master, terminals.ts = xterm registry)
  src-tauri/      Rust backend (sessions.rs = PTY sessions, git diff, persistence)
```

## Development

Requires Node 20+, Rust (rustup), and Xcode command-line tools on macOS.

```sh
cd app
npm install
npm run tauri dev      # run the desktop app with hot reload
npm run tauri build    # produce a distributable bundle
```

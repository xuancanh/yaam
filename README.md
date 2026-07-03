# YAAM — Yet Another Agent Manager

A desktop manager for multiple live coding-agent sessions, built with [Tauri 2](https://tauri.app) + React + TypeScript from the design in `design/Conductor.dc.html`.

![YAAM — Master chat orchestrating live Claude Code sessions](docs/workspace.png)

**What you're looking at** ↑ — a real working session:

- **Left — Master chat**: the orchestrator (here running on `deepseek-chat`) answering "how many agents are active?" from live state, and reporting what each sub-agent is doing — a `claude` session investigating this repo and a "PM for engineer" session cutting a presentation script down to 30 minutes.
- **Right — a live terminal**: the actual Claude Code TUI in an xterm.js pane (PTY-backed, scrollable, clickable). It has just hit a permission dialog — *"Do you want to create script_v10_30min.md?"* — which YAAM's monitor detected from the rendered screen: the session flips to **Needs action**, a notification fires, and the dialog's numbered options become clickable buttons in Master chat.
- **Top — session tabs** with status lights (steady green = working, flashing = finished/needs you), split/maximize/minimize controls per pane, and the ⌘K palette.
- **Rail** — Workspace, Agents overview (per-session task/summary/action cards maintained by monitor LLMs), kanban Board (cards spawn sessions), Activity, Usage, Schedules (real cron that launches sessions), Tools (permission gates for Master), plus any custom addon tabs Master has built.

### Agents overview

![Agents overview — monitor-maintained status cards](docs/agents.png)

Each session's card is kept current by its **dedicated monitor LLM** — no manual bookkeeping:

- **TASK** — what the agent is working on ("Reducing full script to 30-minute version")
- **Summary** — a timestamped 1-2 sentence state digest written after each settled response
- **ACTION** — the amber strip appears when something needs you, and clears when handled
- Plus per-session spend, Review (live `git diff` of the session's working directory), archive/restore, and the **Archived** shelf at the bottom.

**YAAM** puts a "Master" orchestrator between you and a fleet of real CLI sessions (Claude Code, Codex, Gemini CLI, Aider, shells, REPLs — anything). You talk to Master; it routes tasks to sessions, watches them, escalates, and builds schedules and tools.

## Sessions — real terminals

Every session is a real OS process in a **PTY**, rendered with **xterm.js** — an iTerm-style terminal in each workspace pane:

- **＋ New agent session** → pick an agent type (commands configurable in Settings), a plain terminal (zsh/bash/sh/fish/nu), or a custom command; pick the working directory with a native folder chooser
- Full terminal emulation: prompts, colors, TUIs, keystrokes straight to the PTY, resize handled
- Spawned through a login shell, so your PATH (nvm, homebrew, cargo) works
- Stop / resume / exit-code status per pane; double-click the pane title to rename a session
- **Window organization**: a dynamic terminal grid — new sessions open their own pane (up to a 2×2 grid, 6 panes max), add split panes from the tab bar or ⌘K, maximize/restore any pane, close panes independently; tabs jump to the pane already showing that session

## Master — three-way orchestration

Master is a **Claude model with tools** (enable in Settings → Master Brain with an Anthropic API key; model selectable):

- **You → Master**: chat composer (⌘K palette for quick actions)
- **Per-session monitors**: every session gets its own lightweight monitor LLM (model configurable, e.g. Haiku) with a private conversation — it watches that session's settled output, keeps the status card current, flags needed input, and escalates short digests to Master only when noteworthy. Master never sees raw terminal dumps from the watchers.
- **Master → sessions**: tools — `launch_session`, `send_to_session` (writes to a session's PTY), `stop_session`, `create_schedule`, `add_task`
- **Sessions → Master**: each terminal's ANSI-stripped output tail and status feed Master's context; session exits/failures trigger proactive Master turns (follow mode)

Without an API key, Master falls back to a heuristic router (status answers, routing to the focused live session, schedule/tool building).

## Chat-managed app + addons

Following the kernel-plugin pattern of modern agent harnesses (OpenClaw, OpenCode), the app itself is managed through Master's tools — and extended without touching core code:

- **Settings, permissions, schedules from chat**: `configure_setting`, `set_tool_permission`, `create/toggle/delete_schedule` — "turn off follow mode", "set stop_session to Ask first", "delete the nightly job" all work as chat messages
- **Addons — new tabs built by Master**: ask for a new view ("add a tab showing cost per session as a bar chart") and Master calls `create_addon` with a self-contained HTML document. It appears instantly as a tab in the icon rail, rendered in a **sandboxed iframe** (scripts only, no network/parent access) fed live app state over a postMessage bridge (sessions, tasks, schedules, events, totals — pushed every 3s). Addons persist across restarts and can be replaced by name or removed from chat or the tab header.

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
  src/
    store.tsx       state + provider (actions, effects, persistence)
    state-lib.ts    pure helpers (cron, dialog detection, pane focus, env)
    llm/            LLM layer: client (providers/protocols), master harness,
                    master tools + prompt, per-session monitors
    terminals.ts    xterm registry + PTY bridge
    components/     views; components/workspace/ = pane grid internals
  src-tauri/        Rust backend (sessions.rs = PTY sessions, git diff, persistence)
```

## Development

Requires Node 20+, Rust (rustup), and Xcode command-line tools on macOS.

```sh
cd app
npm install
npm run tauri dev      # run the desktop app with hot reload
npm run tauri build    # produce a distributable bundle
```

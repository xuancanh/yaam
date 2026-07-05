# YAAM — Yet Another Agent Manager

A desktop app for running and orchestrating many live coding-agent sessions at once. YAAM puts a **Master** orchestrator between you and a fleet of real CLI agents (Claude Code, Codex, Gemini CLI, Aider, shells, REPLs) — you talk to Master, and it routes work to sessions, watches them, escalates when they need you, and builds schedules and tools on request.

Built with [Tauri 2](https://tauri.app) + React + TypeScript.

![YAAM — Master chat orchestrating live Claude Code sessions](docs/workspace.png)

## Highlights

- **Real terminals, not fakes** — every session is an OS process in a PTY, rendered with xterm.js.
- **Master orchestrator** — a Claude-with-tools that routes tasks, monitors sessions, and acts on your chat instructions.
- **Chat agents** — in-app Claude-Desktop-style assistants that edit files, run commands, load skills, and call MCP servers.
- **Worktree isolation + review queue** — sessions and tasks can run in mirrored git worktrees (multi-repo folders supported); review the diff, stage, commit, and merge back from a Fork-style git workbench.
- **Watcher-driven task board** — a kanban where each card is run by its own mini-Master.
- **Extensible via addons** — a real plugin system with a marketplace, sandboxed views, Master tools, hooks, and per-addon agents.
- **Workspaces** — isolated sets of sessions, chats, boards, and schedules that keep running in the background.
- **Multi-provider** — Anthropic, OpenAI, DeepSeek, Kimi, Gemini, GLM, AWS Bedrock, and OpenAI-/Anthropic-compatible custom endpoints.

## Sessions — real terminals

![Persistent split panes — the Master orchestrator beside stacked live sessions](docs/split-panes.png)

- Each session runs a configurable agent CLI, a plain shell (zsh/bash/sh/fish/nu), or a custom command in the working directory you choose.
- Full terminal emulation: prompts, colors, TUIs, keystrokes to the PTY, resize handling. Commands run through a login-shell wrapper so PATH from nvm/Homebrew/Cargo resolves.
- **Persistent split-pane layouts** — a Chrome-style menu arranges 1–4 panes (single, split, three-up, or 2×2); the layout and orientation are saved and restored on restart.
- Per-pane stop/resume/exit-code status, maximize/restore, and rename.

## Master — orchestration with monitors

Master is a Claude model with tools (enable in Settings → Master Brain; model selectable). It coordinates the whole fleet without ever seeing raw terminal dumps:

- **Per-session monitors** — every session gets its own lightweight monitor LLM that watches settled output, keeps the status card current, flags when input is needed, and escalates short digests to Master only when noteworthy.
- **Acts on your behalf** — tools to launch, message, and stop sessions; create/toggle/delete schedules; add board tasks; and change app settings and tool permissions straight from chat.
- **Proactive** — session exits and failures trigger Master turns (follow mode).
- Without an API key, Master falls back to a heuristic router.

### Agents overview

![Agents overview — monitor-maintained status cards](docs/agents.png)

Each session's card is kept current by its monitor — the current **task**, a timestamped **summary**, an **action** strip when something needs you, plus per-session spend, a live `git diff` review, and archive/restore.

## Chat — a desktop Claude in your workspace

![Chat view — a chat agent navigating a project and answering with a rendered table](docs/chat.png)

The **Chat** rail is a home for **chat agents**: in-app LLM assistants (no PTY) that act on your machine.

- **Hands-on tools** — browse/search folders (glob + grep), read/write/surgically-edit files, manage files, run shell commands and scripts, research the web (search + fetch + raw HTTP), control macOS apps via AppleScript, drive the kanban board and schedules, save new skills, and call tools on your **MCP servers**. Built-in write/edit operations are canonically scoped to the chat's working folder; risky shell, AppleScript, and delete tools ask first by default (per-chat ASK/AUTO toggle) with inline Allow/Deny prompts. Tool calls render as live ⚙ traces.
- **Slash commands** — `/` opens a fuzzy menu of every skill from the chat's sources (plus `/clear`, `/export`); picking one injects the skill deterministically.
- **File import** — drag & drop or attach files: text inlines, PDFs and office documents (docx/xlsx/pptx) are text-extracted, images go to vision-capable models; a Files toggle mounts the same explorer/rich viewer terminal sessions use (images, PDFs, office previews).
- **Durable workspace memory** — agents read shared memory each turn and append facts via a `remember` tool; a Memory editor lets you prune what they've learned.
- **Streaming replies** — token-by-token, with reasoning models' thinking shown in a collapsible block; stop, retry, copy, and a send queue while the agent is busy.
- **Configurable agent types** — each with its own provider, credentials, and a per-chat model list; an optional persona and chosen skill sources.
- **Full-text search** across every conversation via an embedded tantivy index, rebuilt automatically.
- Conversations persist and auto-title themselves; transcripts render markdown.

## Task board — watcher-driven kanban

![Task board — watcher-driven cards with criteria, chat counts, and Done/Failed columns](docs/board.png)

Drag-and-drop kanban where **each task is driven by its own watcher LLM** (a per-task mini-Master): it drafts the card and acceptance criteria from a rough idea (or asks questions if it's too vague), spawns and steers one-shot sessions, verifies live state before claiming progress, moves the card across columns (backlog → progress → review → done/failed), and chats with you in the card's own thread. Deleting a card **archives** it (recoverable from the Archived viewer, the only place offering permanent deletion); every destructive action across the app asks for confirmation first.

## Worktrees & the review queue

Sessions and board tasks can opt into **git worktree isolation**: the working folder — a single repo *or* a plain folder whose subfolders are each their own repo — is mirrored under `~/.yaam/worktrees/<id>` with one worktree and a `yaam/<id>` branch per repo, so agents never touch your checkout until you approve.

- **Review queue** — cards in "Needs review" open a diff of everything the task changed; **Approve & merge** commits outstanding work and `--no-ff` merges each repo back (conflicts abort safely), **Request changes** bounces the task with your feedback as the watcher's next instruction.
- **Git workbench** — one Fork-style component on three surfaces (session pane popup, the agents → Review drawer, the task drawer's Review tab): a staged/unstaged file tree with per-file staging, single-file or continuous all-files diff views, a repo picker for multi-repo folders, and a commit box with AI-drafted messages. The review drawer adds a feedback chatbox that types straight into the session's terminal.
- A task's follow-up sessions re-enter the same worktree, so work-in-progress carries across relaunches.

## Addons — a real plugin system

![Addons marketplace — installed addons, registry packages, and the AI generator](docs/addons-view.png)

Addons extend the app without touching core code. A package (`*.yaam.json` or a readable folder format) can carry any mix of:

- **A view** — a tab in the rail, rendered in a sandboxed iframe that receives live app state and can call back over a whitelisted RPC bridge (read state, message/launch sessions, full board-task CRUD, notifications, private storage) — enough to rebuild built-in views entirely.
- **Master tools** — JS handlers registered into Master's tool list.
- **Hooks** — behavior extensions on session exit, needed-input, and Master's prompt.
- **An agent** — the addon's own mini-Master, scoped to its permissions.
- **Permissions** — every package declares capability scopes; each API call is checked against grants you can revoke per-permission. Dangerous scopes stay off until you enable them.

Addons live in a **marketplace** (rail → Addons): search, an installed list with grant chips, packages from any number of registries (http(s) or local folders), and **✦ Generate** — describe an addon and an LLM builds, validates, and installs it. Every addon tab has **Preview**, **Source**, and **Customize** (a scoped chat that edits the addon through a validated tool).

> Addon views, tool handlers, and hooks run in opaque-origin, network-denied
> sandbox frames. Their only app access is the permission-scoped addon API.

## Workspaces

Work is organized into **workspaces** (switcher in the title bar): each has its own sessions, Master chat, schedules, board, activity feed, and notifications. Background workspaces stay alive — sessions keep running and monitors keep reporting; Master events queue and are summarized when you switch in. Settings, agent types, addons, and the tool registry are global.

## More

- **Schedules** — a 5-field cron scheduler plus one-time runs; can launch sessions or seed board tasks, from the UI or Master.
- **Templates** — preconfigured launches, one-shot (run a task and exit) or interactive, that feed quick launches, schedules, and tasks.
- **MCP everywhere** — streamable-HTTP *and* local stdio servers, a curated one-click marketplace, import from Claude Desktop / Claude Code / Cursor / Codex / Windsurf configs, and `.mcpb`/`.dxt` Claude Desktop extension bundles.
- **Claude plugin marketplaces** — browse repos like `anthropics/claude-plugins-official` and install plugins for chat: skills and commands become slash-invocable skill registries, agents become personas, `.mcp.json` servers register directly.
- **Skills** — local instruction packs plus GitHub/local registries (a keychain-backed GitHub token lifts API rate limits).
- **Appearance** — Dark / Midnight / Light / System themes, interface scale, layout density, UI + mono font choices, and markdown-table typography.
- **Notifications & activity** — session exits, failures, cron runs, and Master decisions in the bell popover and Activity timeline, mirrored to the OS notification center when the app is in the background.
- **Persistence** — sessions, board, schedules, templates, layouts, settings, memory, and more survive restarts.

## Development

See [DEVELOPMENT.md](DEVELOPMENT.md) for the contributor workflow and
[docs/architecture.md](docs/architecture.md) for architecture, data flows,
domains, technologies, persistence, and security boundaries. Requires Node 20+,
Rust (rustup), and Xcode command-line tools on macOS.

```sh
cd app
npm install
npm run tauri dev      # run the desktop app with hot reload
npm run tauri build    # produce a distributable bundle
```

## Contributing

Issues and pull requests are welcome. Before opening a PR, run the checks in [DEVELOPMENT.md](DEVELOPMENT.md) (typecheck, lint, and `cargo check`) and keep changes focused.

## License

Released under the [MIT License](LICENSE) — © 2026 xuancanh.

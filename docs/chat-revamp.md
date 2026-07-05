# Chat experience revamp — brainstorm & plan

Working design doc for the chat-experience revamp. Grounded in the current code
(chat = in-app agent loop in `domains/chat/`, explorer/viewer = `session/FilesPane.tsx`,
HTTP-only MCP client in `core/mcp.ts`, text-only LLM pipe in `llm/client.ts`).

## Personas and what they actually need

**1. Non-technical working user** (analyst, ops, legal, finance, writer — Cowork's
audience). They think in *documents and deliverables*, not tools.

- Drop files onto the chat ("here are 5 invoices, make me a summary sheet") —
  drag & drop and a paperclip picker, with PDFs / Word / Excel / images actually
  *readable* by the agent, not just UTF-8 text.
- See what the agent produced without a terminal: a file panel next to the chat
  that previews PDFs, office docs, and images — not just source code.
- Trust & control: a visible stop button, a permission prompt before the agent
  runs shell commands or deletes things, and a readable activity trail ("what
  did it just do to my files?").
- Zero-jargon onboarding: they will never write an MCP config by hand. They need
  a marketplace with one-click connect and "import what my other AI apps already
  have configured".

**2. Non-casual power user** (the daily driver). Efficiency features:

- Slash commands (`/skill-name`, `/clear`, `/export`, `/model`) with a fuzzy
  autocomplete menu — invoking a skill must not require typing "please load the
  X skill".
- @-mention files from the working folder to pull them into context precisely.
- Message-level actions: copy, retry last turn, edit-and-resend.
- Queue a message while the agent is busy instead of being told "one at a time".
- Per-chat cost/usage awareness; export a conversation as markdown.

**3. Technical user** (developer orchestrating coding agents — YAAM's original
audience). Mostly served by terminal sessions, but in chat they want:

- The same explorer/viewer they have in terminal sessions (git-aware tree,
  diff gutter) attached to any chat — one component, both session kinds.
- A `fetch_url` tool so the agent can read docs/APIs (today the chat agent is
  blind to the web).
- stdio MCP servers — nearly every real-world MCP server (filesystem, github,
  puppeteer…) is stdio; YAAM only speaks streamable HTTP today. This is the
  single biggest capability gap for technical users and it's also what makes
  config-import and .mcpb compatibility real rather than cosmetic.

## Feature inventory (gap → design)

| Area | Today | Revamp |
|---|---|---|
| Skill invocation | agent may call `load_skill` if it feels like it | `/` opens a slash menu listing all skills from the chat's sources; picking one injects the skill body into the turn deterministically |
| File import | none | drag & drop overlay + paperclip; text inlined, PDF/docx/xlsx/pptx text-extracted, images sent as vision blocks; copies land in the chat cwd so tools can touch them |
| Explorer/viewer in chat | only when a chat is opened as a workspace pane | Files toggle in the chat header mounts the same `FilesPane` used by terminal sessions |
| Viewer file types | UTF-8 text + rendered markdown | + images (png/jpg/gif/webp/svg), PDF (native webview render via base64), docx/xlsx/pptx (extracted text/sheet preview), binary fallback (size + hex head) |
| MCP | HTTP-only, hand-typed URL | marketplace catalog (curated one-click servers) + import from Claude Desktop / Claude Code / Cursor / Codex / Windsurf configs + stdio transport in Rust |
| Claude add-ons | own `.yaam.json` addon system | additionally install `.mcpb` (Claude Desktop extension) bundles: unzip, read `manifest.json`, register as a stdio MCP server with user-config prompts |
| Web access | none | `fetch_url` built-in tool (readability-trimmed text) |
| Safety | honor-system prompt rules | per-chat permission mode: `ask` (default for command execution) / `auto`; approval bubble inline in the chat |
| Long-turn visibility | "working…" spinner | live tool-trace group (collapsible), stop button, optional plan/progress line the agent maintains via a `set_status` tool |

## Built-in tool set for local interaction

Today's set (`list_dir`, `read_file`, `write_file`, `edit_file`, `run_command`,
`load_skill`) forces the agent to shell out for everything else, which is slow,
error-prone, and unreadable in the tool trail. Expanded set:

**Find & search** (the biggest gap — agents currently `run_command: grep`):
- `glob_files(pattern, path?)` — find files by name pattern, recursive.
- `grep_files(pattern, path?, glob?)` — regex content search with file:line hits.

**File management** (sandboxed to the working folder like writes; today the
model falls back to `rm`/`mv` in run_command which bypasses the write sandbox):
- `create_dir(path)`, `move_path(from, to)`, `copy_path(from, to)`,
  `delete_path(path)` — delete asks for approval in `ask` mode.

**Documents & media** (working-user essentials):
- `read_file` learns to extract text from PDF / docx / xlsx / pptx instead of
  failing with "not UTF-8"; images become vision blocks (with cut 2's plumbing).

**Research & information**:
- `web_search(query)` — current-facts search (DuckDuckGo HTML endpoint via the
  CORS-free Tauri HTTP plugin; no API key required).
- `fetch_url(url)` — trimmed page text; `http_request(method, url, headers, body)`
  for APIs (advanced; body size capped).
- a built-in **deep-research skill** (multi-source fact-checking: search → fetch
  several sources → cross-check → cite) seeded into the local skill list so it
  shows up in the slash menu out of the box.

**Application control** (Cowork-style, staged by cost):
- `run_applescript(script)` — native app control on macOS (Finder, Mail, Safari,
  Terminal…) via `osascript`; approval-gated in `ask` mode. Windows/Linux
  equivalents (PowerShell / xdotool) can follow the same tool shape later.
- Chrome / web apps: ship a **Chrome DevTools MCP** entry in the curated
  marketplace (works once stdio MCP transport lands) — driving the DOM beats
  clicking pixels.
- Full screenshot-based computer use: deferred — needs screen-capture plumbing,
  a vision loop, and OS permissions; revisit after the above two prove demand.

**Progress**:
- `set_status(text)` — one-line "what I'm doing now" surfaced in the chat header
  during long turns (Cowork-style visibility, cut 7).

**Task management** (bridges chat → YAAM's existing kanban board + schedules —
the agent becomes a way to *drive* the orchestrator, not just the filesystem):
- `list_board_tasks()`, `add_board_task(title, description?, criteria?, startNow?)`,
  `move_board_task(id, column)` — the watcher runner takes over from there.
- `add_schedule(name, cron | at, prompt/template)` — recurring or one-time;
  `list_schedules()`. Reuses the schedules domain actions.

**Skill creation & optimization** (self-improving workflows):
- `save_skill(name, description, body)` — create or update a local skill; the
  agent can capture a workflow it just did well ("save this as a skill") or
  rewrite an existing one to fix its weak spots. Saved skills appear in the
  slash menu immediately.

Deliberately *not* tools: git (run_command is fine and terminal sessions own git
UX), browser automation (out of scope), sub-agents (Master already orchestrates).

## What Claude Cowork offers vs what YAAM needs

Cowork = autonomous multi-step knowledge work on local files with human
oversight ([anthropic.com/product/claude-cowork](https://www.anthropic.com/product/claude-cowork)).
Feature-by-feature assessment:

- **Autonomous file deliverables** — *adopt*: file import + office/PDF handling +
  a working-folder-first UX is exactly this. YAAM already sandboxes writes.
- **Permission-before-acting** — *adopt*: inline approval for `run_command`
  (and future destructive tools) in `ask` mode.
- **Progress visibility / steerability** — *adopt (light)*: stop button, live
  tool trail, message queueing. A full plan UI is overkill for v1.
- **Projects (grouped context)** — *defer*: YAAM workspaces already group chats;
  revisit if users pile 50 chats into one workspace.
- **Connectors gallery** — *adopt*: the MCP marketplace + config import is our
  equivalent.
- **Scheduled/background agents** — *already have*: schedules + kanban board +
  watcher runner cover this; not part of the chat revamp.
- **Application control** — *adopt in stages*: `run_applescript` for native macOS
  apps now; Chrome DevTools MCP via the marketplace for web apps; pixel-level
  computer use deferred.

## Implementation cuts (each independently shippable)

1. **Chat UX core** — stop button (abort registry already exists), slash-command
   menu (skills + `/clear` `/export`), message copy/retry, queued sends.
2. **File import** — drag & drop + paperclip; attachment chips on the composer;
   text/PDF/office extraction (TS-side zip/xml, no new deps); image vision
   blocks (extend `llm/client.ts` content blocks); `read_file_b64` Rust command.
3. **Files panel in chat** — header toggle mounting `FilesPane`; viewer support
   for images/PDF/office/binary (shared by terminal sessions for free).
4. **MCP marketplace + import** — curated catalog view; parse
   `claude_desktop_config.json`, `~/.claude.json`, `~/.cursor/mcp.json`,
   `~/.codex/config.toml`; HTTP servers connect now, stdio servers register and
   light up when (5) lands.
5. **stdio MCP transport** — new Rust `domains/mcp.rs` (spawn, JSON-RPC over
   stdin/stdout, lifecycle); `core/mcp.ts` grows a transport switch.
6. **.mcpb compatibility** — unzip + `manifest.json` → stdio server entry with
   `user_config` prompts.
7. **Cowork-style safety** — per-chat `ask`/`auto` permission mode with inline
   approval bubbles; `fetch_url` tool.

Risks / constraints: other sessions are active in `domains/addons/*` and Rust
security hotspots — keep Rust additions to new modules + minimal `lib.rs`
registration; commit per cut with explicit paths.

# YAAM Chat — Functional Requirements

Scope: the in-app **Chat** feature — provider-neutral LLM conversations that run
*without* a PTY (distinct from terminal agent sessions). This is a
requirements document (what the system must do), derived from the shipped
behavior in `app/src/domains/chat/*`, `app/src/app/runtime/chat.ts`, and the
chat entities in `core/entities.ts`. Companion design docs:
[`architecture.md` § In-app chat flow](architecture.md),
[`frontend-domains.md`](frontend-domains.md).

Terminology: a **chat session** is one conversation (an agent record with
`kind: 'chat'`). A **chat agent type** is a reusable provider/model/persona
preset. A **durable agent** is a persistent identity that owns many chat
sessions plus a file "brain".

---

## 1. Conversations & sessions

- **FR-1.1** Users can create a new chat session, optionally choosing a name,
  working directory (`cwd`), chat agent type, model, skill sources, and owning
  durable agent.
- **FR-1.2** Each chat session is **scoped to the active workspace**; switching
  workspace shows only that workspace's conversations.
- **FR-1.3** Users can open, rename, and delete a chat session. A session with
  no user-chosen name is auto-titled from its conversation.
- **FR-1.4** Users can **archive** a chat session (hidden from the active list,
  retained) and **restore** it later.
- **FR-1.5** Users can **pin** a chat and assign **tags** for organization and
  filtering.
- **FR-1.6** Chat sessions persist across restarts; on hydration a chat is
  restored ready to continue (no live provider request in flight).

## 2. Composer & input

- **FR-2.1** Users compose a message with free text and send it; Enter sends,
  and unsent text (draft) is **preserved** across navigation and restarts.
- **FR-2.2** Users can **attach files** by drag-and-drop or picker; text files
  are attached as text, images as image attachments (vision). Attachment
  descriptors persist with the turn.
- **FR-2.3** `@`-mentions: typing `@` lists files in the working folder ranked
  (basename-prefix, then basename-substring, then path-substring); picking one
  attaches it like a dropped file.
- **FR-2.4** **Slash commands** with autocomplete are available in the composer:
  built-ins **`/clear`** (clear transcript + context), **`/compact`** (distill
  context, transcript kept), and **`/export`** (export the conversation as
  markdown), plus the chat's **skills** invoked as slash commands. A single line
  starting with `/` opens the filtered menu; other text is sent normally.
- **FR-2.5** Users can **queue** additional messages while a turn is streaming;
  queued messages are sent in order once the turn completes.
- **FR-2.6** A message cannot be sent when the chat's token ceiling is already
  reached (see §7); the turn is refused before any API call.

## 3. The turn loop & tools

- **FR-3.1** A turn runs a **provider-neutral streaming LLM loop** supporting up
  to **24 tool rounds** per turn.
- **FR-3.2** The loop streams the **answer** and **thinking** channels
  separately; thinking is shown distinctly and excluded from provider history
  reconstruction.
- **FR-3.3** The loop exposes these tool families to the model:
  - local **file / navigation / edit / exec** tools;
  - **web** and raw **HTTP** tools;
  - **board, schedule, and skill** tools;
  - tools discovered from **enabled MCP** sessions;
  - **local and registry skills**.
- **FR-3.4** Tool calls with **truncated / malformed arguments are refused**
  rather than executed.
- **FR-3.5** A live activity line shows what the current tool call is doing while
  it runs.
- **FR-3.6** Only tools whose capability is enabled for the chat are offered;
  the persona/system prompt and attachments are included in the request.

## 4. Tool safety & approvals

- **FR-4.1** Each chat runs in one of two permission modes: **Ask** (default) or
  **Auto**; users can flip between them per chat.
- **FR-4.2** In **Ask** mode, read-only tools run automatically, but
  **mutations, process execution, raw HTTP, and MCP calls pause for inline
  approval**.
- **FR-4.3** For a paused tool the user can: **allow once**, **allow always**
  (remember the exact tool+preview for this chat), **allow the whole tool**
  ("always allow tool"), or **deny**.
- **FR-4.4** In **Auto** mode, tools run without prompting.
- **FR-4.5** Remembered approvals are scoped to the chat and persisted;
  self-modification tools are never eligible for blanket "always allow tool".

## 5. Rendering & interaction

- **FR-5.1** The transcript renders user, assistant, tool, and thinking messages
  distinctly; markdown is rendered.
- **FR-5.2** **Artifacts**: a reply containing substantial HTML or SVG surfaces
  an artifact chip that opens the content in a **sandboxed, network-denied side
  panel** (opaque-origin iframe, same hardening as the addon sandbox).
- **FR-5.3** The assistant may present **quick-reply** options the user can click
  to answer in one tap.
- **FR-5.4** Users can **stop** an in-flight turn at any time; cancellation is
  immediate and the partial turn is retained.
- **FR-5.5** Provider token usage (input/output) is displayed and accumulates on
  the turn and on the session.

## 6. Turn management

- **FR-6.1** **Retry** re-runs the last turn.
- **FR-6.2** **Edit & resend** replaces a prior turn's input and re-runs from
  that point.
- **FR-6.3** **Fork** creates a new chat session branched from a chosen turn
  with alternate input, leaving the original intact.
- **FR-6.4** **Promote to task**: a turn can be handed off to a board task; the
  handoff is recorded on the turn.
- **FR-6.5** **Ratings**: users rate an assistant reply 👍/👎 with an optional
  note; for durable agents the rating (and note) is recorded for the agent.
  Pending feedback since the agent's last turn is surfaced to the model on its
  next reply, then cleared.
- **FR-6.6** Every completed turn persists a **structured work record**: original
  text + attachment descriptors, model, tool inputs/results, status, provider
  token usage, and any board-task handoff.
- **FR-6.7** Users can **export a conversation as markdown** (`/export`).

## 7. Context, compaction & token budgets

- **FR-7.1** Each chat has a **token ceiling** (default **200k**, `0` =
  unlimited), configurable per chat.
- **FR-7.2** Turns older than the recent provider window feed a **bounded
  extractive context summary** (no extra LLM call) to preserve continuity.
- **FR-7.3** **Compaction**: at a configurable provider-input threshold or on
  `/compact`, an LLM replaces private provider history with a structured
  summary; the session persists the summary and a **visible-message cutoff**.
- **FR-7.4** After restart, provider history is rebuilt from the summary plus
  only messages newer than the cutoff; the **visible transcript is unchanged**.
- **FR-7.5** Compaction and normal turns share a **per-chat busy lock** so
  history is never rewritten concurrently.

## 8. Persistence & search

- **FR-8.1** Visible transcripts are persisted; **tool and thinking messages are
  excluded** when reconstructing provider history after restart.
- **FR-8.2** Chat transcript changes debounce a **full rebuild of the in-memory
  search index**, making conversations searchable.
- **FR-8.3** Chat runtime state is keyed by chat id and **cancellable** via the
  abort registry; disposing a chat tears down its runtime cleanly.

## 9. Providers, models & agent types

- **FR-9.1** **Chat agent types** define a reusable preset: provider, default
  model, a pickable model list, optional API key / base URL, and an optional
  persona system prompt; types can be enabled/disabled.
- **FR-9.2** Supported providers include Anthropic, OpenAI, DeepSeek, Kimi,
  Gemini, GLM, Bedrock, a custom endpoint, and Anthropic-compatible endpoints.
- **FR-9.3** A type with no API key **shares the Master Brain credentials** when
  the provider matches.
- **FR-9.4** Per session, users can change the **agent type, model, and
  extended-thinking effort** (off / low / medium / high; only sent to models
  that support it).

## 10. Skills & MCP

- **FR-10.1** A chat resolves the **skills** visible to it from local skills and
  enabled skill registries, chosen via its `skillSourceIds`.
- **FR-10.2** Skills are offered to the model as tools within the turn loop.
- **FR-10.3** Tools discovered from **enabled MCP servers** are offered to the
  chat; MCP calls are gated by the Ask/Auto policy (§4).

## 11. Durable agents

- **FR-11.1** A **durable agent** is a **global persistent identity** above
  workspace-scoped chat sessions, with a user-written **charter**,
  provider/model defaults, and an optional **home folder**.
- **FR-11.2** The agent home page shows only conversations from the **active
  workspace**, even though the identity, dashboard, and apps are global.
- **FR-11.3** The home folder is a **transparent file brain**: `LESSONS.md`,
  `JOURNAL.md`, and user/agent-maintained files under `knowledge/`.
  Conversations load **bounded tails** of the brain into the system prompt and
  expose **ranked home-folder search**.
- **FR-11.4** Completed work can be **distilled** into serialized, size-bounded
  appends to the brain. A git-backed brain **auto-commits only the brain paths**.
- **FR-11.5** A durable agent owns a **markdown home dashboard** and up to **12
  self-built HTML mini apps**; mini apps execute **only when opened**, inside an
  **opaque-origin, network-denied iframe**.
- **FR-11.6** A durable agent supports **scheduled prompts** (loops) that fire on
  a schedule and spend tokens when they run.
- **FR-11.7** **Export/import** via `AGENT.json`: the profile, validated loops,
  dashboard, and size-bounded mini apps. Registry profiles get a **capability
  review before installation** because imported loops are enabled immediately.
- **FR-11.8** **Role templates** scaffold casual/professional agents without
  changing the runtime; legacy Personas migrate into durable profiles on
  hydration.

## 12. Workspace chat memory

- **FR-12.1** Each workspace has editable **durable chat memory** (a Memory
  editor); its text is injected as shared context for that workspace's chats.

## 13. Security & sandboxing (constraints)

- **FR-13.1** Chat-rendered artifacts and durable-agent mini apps run in
  **opaque-origin, network-denied iframes** — no external requests, matching the
  addon sandbox hardening.
- **FR-13.2** Risky tools (mutations, exec, raw HTTP, MCP) are **gated behind
  explicit approval** in Ask mode (§4); self-modification tools cannot be blanket
  auto-approved.
- **FR-13.3** Secrets/credentials for a provider are resolved at request time and
  are **not** embedded in persisted transcripts.
- **FR-13.4** A turn is **refused before its API call** when the token ceiling is
  already reached, bounding spend.

## 14. Non-functional expectations

- **NFR-1** **Provider-neutral**: the same conversation UX and tool loop work
  across all supported providers.
- **NFR-2** **Cancellable & isolated**: every chat's runtime is independently
  cancellable and keyed by chat id; one chat never blocks another.
- **NFR-3** **Durable**: drafts, transcripts, structured turn records, ratings,
  approvals, compaction summaries, and token usage survive restart.
- **NFR-4** **Bounded**: private history, context summaries, brain appends, and
  mini-app sizes are all size-capped to keep state and cost bounded.

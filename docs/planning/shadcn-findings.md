 ## Audit result

  YAAM’s architecture and documentation are generally strong, but I found 11 actionable
  gaps. The most urgent involve credential persistence, terminal-input redaction, stalled
  LLM watchers, and absent application CI.

  No files were modified. I did not inspect the remote skill’s planning subfolder or this
  repository’s docs/planning/ contents.

  ### Baseline

  - Branch: main, one commit ahead of origin/main.
  - Preserved three pre-existing modified files related to satellite-window shutdown.
  - Frontend: 112 test files / 657 tests passed.
  - Backend: 112 Rust tests passed; cargo check passed.
  - Lint passed with warnings.
  - Both npm production dependency audits reported zero vulnerabilities.
  - Rust advisory scanning was not available because cargo-audit is not installed.
  - TypeScript currently fails only because labels is unused in the pre-existing edit at
    app/src/infrastructure/native/windows.test.ts:140.

  ## Ranked findings

   #      Impact    Finding                                Effort    Fix risk    Confidence
  ━━━━━  ━━━━━━━━  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  ━━━━━━━━  ━━━━━━━━━━  ━━━━━━━━━━━━
   1      High      Credential-bearing environment         M         Medium      High
                    variables bypass the keychain
  ─────  ────────  ─────────────────────────────────────  ────────  ──────────  ────────────
   2      High      Mobile terminal input bypasses         S–M       Medium      High
                    sensitive-input redaction
  ─────  ────────  ─────────────────────────────────────  ────────  ──────────  ────────────
   3      High      LLM streams can stall watchers         M         Medium      High
                    indefinitely and grow their queues
  ─────  ────────  ─────────────────────────────────────  ────────  ──────────  ────────────
   4      High      Application compilation and tests      S–M       Low         High
                    do not run in CI
  ─────  ────────  ─────────────────────────────────────  ────────  ──────────  ────────────
   5      High      User-action provenance cannot          L         High        High
                    distinguish remote devices or cover
                    all actions
  ─────  ────────  ─────────────────────────────────────  ────────  ──────────  ────────────
   6      Medium    Git commands have no execution-time    M         Medium      High
                    or output bounds
  ─────  ────────  ─────────────────────────────────────  ────────  ──────────  ────────────
   7      Medium    Native filesystem-watch failures       S–M       Low         High
                    silently disable refresh
  ─────  ────────  ─────────────────────────────────────  ────────  ──────────  ────────────
   8      Medium    Ranged text reads scan the entire      M         Medium      High
                    file and accept an unbounded line
                    limit
  ─────  ────────  ─────────────────────────────────────  ────────  ──────────  ────────────
   9      Medium    Rich-preview storage is byte-          M         Medium      Mixed
                    unbounded and trusted previews need
                    stronger isolation
  ─────  ────────  ─────────────────────────────────────  ────────  ──────────  ────────────
   10     Low       Release versions disagree between      S         Low         High
                    frontend/Tauri and Cargo
  ─────  ────────  ─────────────────────────────────────  ────────  ──────────  ────────────
   11     Low       Remote-token validation differs        S         Low         High
                    between settings UI and backend

  ### 1. Environment credentials bypass the keychain

  MCP environment fields explicitly accept tokens in app/src/domains/settings/
  McpSection.tsx:63, while McpServer.env and terminal-agent environment fields are persisted
  through app/src/infrastructure/persistence/schema.ts:20. However, app/src/store/
  secrets.ts:16 only mirrors MCP headers—not MCP or agent environment values—to the
  keychain.

  This means tokens such as GITHUB_PERSONAL_ACCESS_TOKEN are normally written into
  conductor-state.json. The documentation’s credential inventory at docs/security.md:328
  omits these fields.

  Recommended scope: keychain mirroring, field redaction/restoration, migration of existing
  plaintext values, deletion handling, tests, and documentation.

  ### 2. Sensitive terminal input is only protected on the direct xterm path

  The direct terminal tracker detects credential prompts and redacts submissions in app/src/
  domains/session/terminal-tracking.ts:9. But sendInput stores the raw text in both history
  and the session log at app/src/domains/session/actions.ts:357.

  The mobile composer reaches that unprotected path through app/src/mobile/MobileApp.tsx:433
  and app/src/domains/remote/RemoteCompanion.tsx:229. Its current test explicitly expects
  raw persistence at app/src/domains/session/actions.test.ts:269.

  All user terminal submissions should share one tracking/redaction pipeline.

  ### 3. Stalled LLM streams can freeze watchers

  The SSE reader can wait indefinitely on reader.read() at app/src/llm/client.ts:475. Calls
  accept an external abort signal but have no connection, total-turn, or idle-stream timeout
  at app/src/llm/client.ts:496.

  While a task watcher remains busy, discrete events accumulate in app/src/domains/board/
  watcher-runner.ts:89. Progress is collapsed, but discrete events are appended without a
  count or byte ceiling in app/src/domains/board/watcher-notes.ts:23. Session monitors
  already demonstrate a bounded queue at app/src/domains/master/monitor-runner.ts:34.

  Add explicit deadlines/idle cancellation first, then bounded event-preserving watcher
  queues and stall tests.

  ### 4. CI does not verify the application

  The only workflow is registry-specific and only triggers for registry/** in .github/
  workflows/registry-validate.yml:1. None of the documented gates in DEVELOPMENT.md:25 run
  for application changes.

  At minimum, CI should cover:

  - Frontend typecheck, lint, tests, and production build.
  - cargo check and Rust tests.
  - App/SDK npm audits and Rust advisory/license scanning.
  - Registry validation.
  - Version-consistency and generated-mobile-artifact checks.

  ### 5. Action provenance remains incomplete

  Only session, board, and schedule commands are registered at app/src/app/conductor-
  runtime.ts:124; many action slices still bypass the registry in app/src/app/conductor-
  actions.ts:81. The documentation acknowledges this incomplete migration at docs/command-
  authorization.md:3.

  Additionally:

  - Remote authentication identifies a device, but its identity is discarded before queuing
    the command at app/src-tauri/src/domains/remote.rs:333.

  - Remote actions are applied through ordinary user actions at app/src/domains/remote/
    RemoteCompanion.tsx:211.

  - The command audit is a runtime-only 200-entry ring at app/src/app/commands/
    registry.ts:29.

  Consequently, session history cannot reliably say whether an action came from desktop, a
  particular paired phone, Master, watcher, chat agent, or another surface. This should be
  addressed before expanding the activity dashboard or audit-history export.

  ### 6–9. Native reliability and resource bounds

  - Git uses blocking Command::output() without time or output limits throughout app/src-
    tauri/src/domains/git.rs:55. Large diffs, hooks, signing, or credential helpers can hang
    an IPC call or allocate excessive output.

  - watchDir converts setup failure into apparent success at app/src/infrastructure/native/
    filesystem.ts:141, while the Tauri file pane disables polling at app/src/domains/
    session/FilesPane.tsx:751. Watch failure therefore leaves a silently stale UI.

  - A small ranged read still scans to EOF to calculate total, and the native limit is not
    capped in app/src-tauri/src/domains/fs.rs:143.

  - The preview store caps document count but not aggregate or per-document bytes at app/
    src-tauri/src/domains/preview.rs:24. Trusted previews use allow-same-origin at app/src/
    domains/session/FilesPane.tsx:590, while IDs are sequential. Cross-preview accessibility
    under packaged WKWebView/custom-scheme behavior needs an integration test before making
    a stronger security claim.

  ### 10–11. Release and validation inconsistencies

  - Frontend and Tauri report 0.6.1 in app/package.json:4 and app/src-tauri/
    tauri.conf.json:5, while Cargo remains 0.6.0 in app/src-tauri/Cargo.toml:3.

  - The settings UI accepts remote tokens as short as eight characters at app/src/domains/
    settings/SettingsView.tsx:458, but Rust accepts only 24–128 characters at app/src-tauri/
    src/domains/remote.rs:419. An 8–23 character edit can therefore appear saved but be
    replaced on restart.

  ## Documentation discrepancies

  The documentation is unusually comprehensive and broadly matches the implementation.
  Required corrections are concentrated:

  - Add MCP/agent environment variables to the secret-handling model.
  - Clarify that ranged reads are memory-bounded but still scan to EOF.
  - Document filesystem-watch degraded mode once failure reporting exists.
  - Enforce one canonical version across manifests.
  - Update the process model after the current satellite-close handoff work lands.
  - Expand command authorization around device identity, durable provenance, and the
    remaining migration.

  ## Product-direction opportunities

  These are strategic options rather than confirmed defects:

  1. Make watcher communication a typed event protocol instead of tagged strings, with event
     IDs, source actor/device, task/session relationships, and evidence references.

  2. Build a first-class session audit view: task transitions, terminal submissions, watcher
     interpretations, file/git actions, user decisions, and provenance in one exportable
     timeline.

  3. Establish a stable signed/notarized release pipeline. The current ad-hoc macOS identity
     remains a root cause of one-time keychain authorization after rebuilt binaries, as
     documented at docs/security.md:377.

  4. Add browser/handset E2E coverage for the mobile companion, especially terminal input,
     approval, reconnect, focus ownership, and device revocation.

  Recommended execution order: restore the typecheck baseline → add CI/version invariants →
  fix findings 1 and 2 → add LLM deadlines and queue bounds → address native resource limits
  → complete actor/device provenance → build the audit-history product.

  Tell me which finding numbers you want turned into detailed implementation plans.
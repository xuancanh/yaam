# YAAM engineering audit and improvement plan (2026-07)

This is the working ledger for the repository-wide quality goal. Assessments cover
correctness, reliability, performance, security, and usability. “Verified” means
the relevant focused tests plus the repository gates pass; it does not mean a
surface is permanently finished.

## Baseline and priorities

- Frontend: 90 files / 489 tests passed at baseline; TypeScript and oxlint pass.
- Backend: 76 tests and `cargo check` passed at baseline.
- Production build passed, but its initial JS was 1.42 MB minified / 392 KB gzip.
- `npm audit --omit=dev` initially reported two high-severity advisories in the
  unpatched `xlsx` package.
- Strict `cargo clippy --all-targets --all-features -- -D warnings` initially
  failed because a Rust API exceeded the declared 1.77.2 MSRV.

Priority meanings: P0 is an exposed credential/code-execution or data-loss risk;
P1 is material correctness/reliability/performance; P2 is maintainability,
defense-in-depth, or user-experience work.

## Frontend and shared modules

| Module | Current assessment | Improvement plan and execution |
|---|---|---|
| Composition (`App.tsx`, provider) | Architecture is clean and selector-based. All mutually exclusive views were eagerly loaded. | **P1 verified:** lazy-load secondary views. Main application chunk fell from 1.42 MB to 370 KB; continue profiling the 791 KB workspace/xterm shared chunk before delaying the primary workflow. |
| App runtime/actions/commands | Strong plain-runtime boundaries, stable actions, policy/parity tests. High fan-in makes regressions costly. | Audit lifecycle disposal, ref cycles, action authorization, and StrictMode behavior; extend parity tests whenever commands are added. |
| Core store/entities/data/ports | Central types and fakes are well tested; `entities.ts` is very large and mixes many domain contracts. | Split domain-owned entity types without creating cycles; verify every persisted optional field is guarded for old states. |
| Terminal registry | Correctly avoids live alternate-screen replay; resize/tap ownership is subtle. | Stress test disposal/reconnect, WebGL fallback, tap backpressure, and multi-client resize ownership. |
| LLM client/tool loop | Protocol normalization, history guards, usage accounting, and loop caps have focused tests. Buffered/SSE response bodies were unbounded. | **P1 verified:** 4 MB response ceiling with stream cancellation and bounded error bodies, plus declared-size regression test. Next: fuzz malformed SSE/tool arguments, verify credential retry idempotency, and add cancellation/stall-timeout integration tests. |
| Store secrets | API, GitHub, MCP, chat, and brain credentials use conditional keychain redaction. Remote bearer credentials were omitted, and settings-owned secret changes did not arm persistence. | **P0 verified:** remote URL/device tokens now participate in keychain save/redaction/restore; all settings credential classes trigger mirroring; removed dynamic device accounts are deleted. Covered by detector/runtime/redaction tests. |
| Persistence infrastructure | Partitioning, atomic backend writes, backup recovery, and close flushing are strong. Failed async session operations were marked complete; repeated `start()` duplicated subscriptions. | **P1 verified:** dirty/tombstone retries, idempotent lifecycle, and complete timer/subscription cleanup with fault-injection/lifecycle tests. Next: combined keychain/partition failure tests, real old-snapshot fixtures, and richer degraded-persistence UX. |
| Native adapters | Helpful IPC response validation exists but is not uniform across adapters. | Add bounded shape/value validation to every command result, especially remote, git, worktree, and search payloads. |
| Shared file/ZIP/office handling | Dependency-free extraction is compact. ZIP parsing trusted declared sizes; rich workbook parsing used vulnerable `xlsx`. | **P0/P1 verified:** removed `xlsx`, added bounded ZIP entry/total/inflation checks, relationship-aware `.xlsx` table rendering, HTML escaping, and malicious-archive tests. Legacy `.xls`/`.ods` now use the existing fallback; consider a maintained sandboxed parser if rich support is required. |
| Shared rendering/Markdown/highlight | React-element Markdown avoids HTML injection; highlighter escapes before markup. | Add URL length/normalization tests, keyboard focus styles, and pathological-input performance tests. |
| Shared UI/components | Consistent primitives and imperative confirmation guard destructive actions. Shared configuration/confirm modals lacked keyboard focus ownership and ARIA semantics. | **P1 verified:** modal roles, Escape, initial/trapped/restored focus with interaction tests. Next: move helper exports causing Fast Refresh warnings and standardize loading/error states. |
| Activity | Workspace-aware service has focused behavior tests. | Audit retention, event dedupe, notification rate limiting, and background workspace attribution. |
| Addons | Permission model, opaque-origin views, RPC whitelist, timeout/result cap, and tests are strong. Handler sandbox CSP blocked its own `new Function`. | **P0 verified:** allow `unsafe-eval` only inside the opaque, network-denied handler frame; the privileged WebView does not receive it. Add a real-browser CSP integration test and per-addon CPU/rate budgets. |
| Board/watchers/review | Extensive task-state, watcher history/stream/runtime, run-state, and action tests. | Audit duplicate launch recovery, acceptance-check grounding, merge conflict UX, cancellation races, and scheduled-task idempotency. |
| Chat/durable agents | Broad tests cover turns, compaction, memory, policy, artifacts, search indexing, and markets. Large runner/agent/UI files raise change risk. | Split tool definitions/execution from orchestration, cap all attachment/decompression paths, test abort during every tool phase, and profile transcript rendering. |
| Master/monitors | Tool integrity check, capped histories, statistics, and monitor tests are good. | Verify approval identity across workspace switches, tool replay idempotency, monitor teardown, prompt-injection boundaries, and retry cost ceilings. |
| Remote desktop driver | Commands pass through normal actions and scope authorization; snapshot publication is activity-gated. Tokens were plaintext and backend tokens predictable. | **P0 verified:** OS-CSPRNG tokens and keychain redaction. Continue with per-device command attribution, revocation race tests, and visible connection/audit history. |
| Mobile companion | Functional tests cover API tokens; embedded build was single-file JS/CSS but still fetched Google Fonts. | **P0/P1 verified:** removed external fonts and regenerated the embedded app; backend now sends CSP, no-referrer, no-store, nosniff, and anti-framing headers. Add handset/browser E2E tests and offline installability checks. |
| Schedules/templates | Cron parsing, due collection, runtime, and command generation are well tested. Runtime start was not idempotent and old workspace slices were assumed complete. | **P1 verified:** idempotent scheduler lifecycle and defensive background-workspace collection reads. Next: property-test DST/timezone behavior and improve missed-run visibility. |
| Sessions/files/git UI | Rich, central workflow with many focused controller, launch, prompt, diff, worktree, and fallback tests. Several components exceed 600 lines. | Split stateful controllers from views, virtualize trees/diffs consistently, add large-repo cancellation, and test file-watch rename/delete behavior. |
| Settings/markets/integrations | Feature-rich and test coverage exists for translation/market helpers; settings UI is large. | Validate all URLs/commands at save time, expose secret-storage status, make risky approval levels explicit, and split sections into independently testable controllers. |
| Shell/navigation | Selector-based shell is compact; secondary views now split. | Add keyboard-navigation/focus tests, reduced-motion support, command-palette collision tests, and recoverable lazy-chunk error boundaries. |
| Workspace switching | Scoped-state swap logic and actions have good regression tests. | Stress concurrent background events during switch, verify runtime queues retain workspace ownership, and property-test group/session uniqueness. |

## Tauri backend modules

| Module | Current assessment | Improvement plan and execution |
|---|---|---|
| Composition/config/capabilities | Command registration is clear and HTTP allowlist is constrained. Main WebView had no CSP. | **P0 verified:** restrictive CSP for the privileged WebView, including Tauri IPC and required data/blob preview sources. Validate packaged macOS/Windows/Linux behavior. |
| `bedrock` | Flexible AWS credential parsing/caching and auth classification tests. Credential helpers and AWS request/response sizes were unbounded. | **P1 verified:** shared 30-second/1 MB credential runner plus config, 32 MB request, and 4 MB response limits. Next: poison-safe lock handling and retry/idempotency tests. |
| `detach` | Useful daemon/attach protocol with frame cap and E2E tests. IDs reached filesystem paths unchecked; files/sockets used umask defaults; code exceeded MSRV. | **P0/P1 verified:** validate IDs at IPC/host/list boundaries, owner-only directory/spec/socket permissions, protected spec writes, and MSRV-compatible expression. Audit stale-host/PID reuse and atomic spec replacement. |
| `fs` | Symlink-aware workspace containment and destructive-root guards are strong. Ranged reads, command output, credential helpers, directory listings, and full-text transfers were not all resource-bounded. | **P1 verified:** streaming ranged reads, bounded-tail pipe draining, a shared 30-second/1 MB credential runner, 10,000-entry directory limit, and 16 MB full-text read/write limit with regression tests. Next: reduce remaining TOCTOU windows. |
| `git` | Uses argument arrays (not shell strings). Line/quote-based porcelain parsing misread escaped, newline, arrow-text, and rename paths. | **P1 verified:** NUL-delimited porcelain collection/parser with hostile-filename tests. Next: time/output bounds, explicit repo-root path validation, and structured conflict errors. |
| `icons` | Small native adapter with platform tests. | Add file-size/cache bounds, non-mac fallback tests, and avoid repeated expensive native lookups. |
| `mcp` | Stdio lifecycle and interleaved notification handling are tested. Stdout queue/records were unbounded and request waits blocked an async worker. | **P1 verified:** bounded payloads/records/queue, oversized-record draining, and blocking-pool waits. Next: child startup health checks, poison-safe locks, process-group teardown, and malformed JSON/error attribution tests. |
| `remote` | Two-token pairing, queue/result caps, command allowlist, and auth tests are good. Unknown terminal IDs previously allocated backend tap state. | **P0 verified:** CSPRNG tokens and response security headers; unknown terminal streams now return 404 without allocation. Next: constant-time comparisons, request/body concurrency rate limits, response ownership by device, and TLS/public-tunnel guidance. |
| `search` | Tantivy replace/upsert/remove and Unicode truncation are tested. Per-message bodies were bounded but batches, aggregate text, ids, and queries were not. | **P1 verified:** reindex/upsert/remove/query count and byte ceilings with rejection tests. Next: concurrent search/reindex tests and index repair diagnostics. |
| `secrets` | OS keyring boundary is minimal. | **P1 verified:** account/control-character/512-byte and 1 MB value validation. Next: distinguish locked/denied/not-found errors and test migrations across platforms. |
| `session` | PTY launch, shell resolution, bounded output coalescing, ID capture, and duplicate exclusion have strong tests. Natural exits retained final-screen rings forever; unknown remote IDs allocated taps. | **P1 verified:** generation-owned taps, unknown-stream rejection, five-minute final-screen expiry, and bounded IDs/input/dimensions. Next: replace recoverable PTY panics, poison-safe locks, and load-test redraw storms. |
| `state` | Atomic temp/fsync/rename, backup recovery, safe stems, and 0600 files are strong. Backup rotation/deletion errors were hidden and writes were not serialized. | **P1 verified:** serialized collision-proof temp writes, explicit replace-safe rotation, parent-directory fsync, 64 MB/16 MB caps, and observable delete failures with tests. Next: stale-temp collection and disk-full/permission fault injection. |
| `watch` | Debounced dedupe and noisy-directory filtering are tested. Root count, event queue, and quiet-window batch were unbounded. | **P1 verified:** 64-root, 1,024-event, and 10,000-path ceilings with storm-event dropping semantics. Next: surface watcher failure, handle root recreation, and test shutdown during callback delivery. |
| `worktree` | Single/multi-repo integration tests are valuable. Metadata previously controlled destructive paths, and a later-repo create failure leaked earlier worktrees/branches. | **P0/P1 verified:** canonical managed-root/metadata provenance, branch-collision preflight, protected metadata, and transactional multi-repo rollback with integration coverage. Next: git timeouts/output caps and atomic metadata replacement for future updates. |

## Packaging, registry, and engineering system

| Surface | Current assessment | Improvement plan and execution |
|---|---|---|
| npm/Rust dependencies | Frontend production audit initially failed; Rust has a declared MSRV. | **P0 verified:** `npm audit --omit=dev` is clean after removing `xlsx`; strict clippy/MSRV now passes. Add automated dependency and license scanning in CI. |
| Build/bundling | Desktop and mobile builds pass; desktop now code-splits views. | Add bundle budgets for initial gzip and mobile single-file size, inspect xterm/font cost, and test lazy chunk failure/offline loading. |
| Registry/addon packing | Folder and single-file formats are documented with a packing script. | Validate manifests/packages in CI, reject traversal/symlinks/oversized assets, sign or checksum registry artifacts, and add reproducibility tests. |
| Documentation/release | Architecture docs are unusually detailed; release remains ad-hoc signed and unnotarized. | Keep this ledger current, document threat model/recovery paths, and add notarized signed release provenance when distribution warrants it. |

## Verification record

Focused verification completed so far:

- TypeScript typecheck and production desktop build.
- Frontend tests for ZIP/file extraction/workbook rendering, remote secrets,
  addon sandbox, and mobile API.
- `npm audit --omit=dev`: zero vulnerabilities.
- Rust tests for remote, filesystem/process execution, and detached sessions.
- `cargo check` and strict all-target/all-feature clippy.
- Mobile single-file rebuild; confirmed no `fonts.googleapis.com` reference.

The full frontend/backend gates are rerun after each remediation batch and once
more before this audit is marked complete.

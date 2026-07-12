# Session sandbox implementation audit (2026-07)

Scope: the opt-in OS write sandbox introduced in `6a36bb3`, including local,
remote, detached, resume, template, scheduled-task, and worktree launch paths.
The review assessed security, correctness, reliability, performance, and
usability against the implementation in `domains/sandbox.rs`, the frontend
session wrappers/runtimes, persistence, and the launch UI.

## Intended boundary

The feature is a write-confinement guardrail for user-selected coding-agent
process trees:

- reads remain unrestricted;
- writes are allowed only in a specific working folder, temporary storage,
  narrow built-in agent state directories, and explicit extra roots;
- network remains available unless `denyNetwork` is enabled;
- a requested sandbox must fail closed on invalid policy/tooling;
- the same policy must survive worktree launch, detach, and resume.

It is not a confidentiality sandbox while reads and network are both enabled,
nor a VM boundary. Host services reachable through TCP or an unrecognized Unix
socket can carry authority beyond filesystem permissions. The implementation
therefore blocks known privilege-equivalent services, but callers needing a
hostile-code boundary should use a dedicated VM/container/account as well.

## Findings and executed plan

| Priority | Finding | Resolution and evidence |
|---|---|---|
| P0 | macOS profiles were written under `~/.yaam`, which the sandbox could modify. A planted symlink let the unsandboxed backend overwrite an arbitrary user file while rebuilding a wrapper. | Profiles are passed inline with `sandbox-exec -p`; the backend no longer writes a policy file. |
| P0 | Linux shared the host PID namespace. `/proc/<host-pid>/root` could expose a same-user process's host mount namespace and bypass the read-only root. | Local and remote bwrap wrappers use a private PID namespace and fresh `/proc`; IPC is unshared too. |
| P0 | macOS `open`/LaunchServices launched an agent-created app outside Seatbelt, allowing outside writes. Apple Event denial alone was insufficient. | `appleevent-send` and `lsopen` are denied. A macOS end-to-end test first proves the test app writes outside without Seatbelt, then proves the generated policy blocks it. |
| P0 | Docker/Podman control sockets are equivalent to host write/exec authority and remained reachable through a read-only mount. Local YAAM detached-control sockets could similarly drive another process. | Seatbelt denies the socket paths; bwrap masks known engine sockets, and local detached sockets are masked. The masks are applied after writable binds. |
| P1 | Generic `~/.config`, `~/.cache`, `~/.local`, and `~/.yaam` were writable. These contain shell/tool startup configuration, PATH executables, caches consumed by later processes, and YAAM state. | Default home writes are limited to `.claude`, `.codex`, `.gemini`, and `.aider`; advanced roots remain explicit. Built-in state roots must not be symlinks. |
| P1 | A writable `/dev` exposed host devices. | Linux receives a fresh minimal `/dev`; macOS permits only null/PTY/standard-I/O nodes needed by terminal sessions. |
| P1 | Writable project Git config/hooks could persist code execution into later Git commands outside the sandbox. | `.git/config` and `.git/hooks` are read-only for the working repo and direct child repos (the supported multi-repo layout); Seatbelt covers nested matches. |
| P1 | `~` was single-quoted on remote hosts and never expanded. Remote template launches also preferred the local default folder over the selected machine's default. | Home-relative shell expressions are preserved safely; remote machine defaults take precedence and have regression tests. |
| P1 | Remote resume policy validation could throw through the UI, and SSH spawn failures were swallowed while the session remained `running`. | Validation/spawn failures now flow to session `error` state with the actual message. |
| P1 | An empty cwd silently became home locally; `~` or `/` made the sandbox effectively broad-write while retaining a reassuring badge. | Empty, home, filesystem root, and local ancestors of home are rejected. UI/runtime validation requires a specific folder before session creation. Remote preflight checks existence, directory type, canonical root, and home/root breadth. |
| P1 | Missing explicit extra roots were silently skipped locally and failed obscurely remotely. | Explicit roots must exist and be directories; remote preflight emits a clear fail-closed error before bwrap. |
| P2 | Path arrays/strings were unbounded and control characters/non-absolute roots reached policy rendering. | Policies allow at most 32 extra roots, 4 KiB per path, and 64 KiB total; inputs reject control characters and relative paths. Canonical non-UTF-8 local paths fail closed. |
| P2 | Machine diagnostics only checked whether `bwrap` existed, not whether kernel/AppArmor user-namespace policy allowed it to run. | The connection test executes a minimal representative bwrap sandbox and reports unavailable/unusable tooling. |
| P2 | Tests asserted wrapper strings but did not prove Seatbelt behavior. | macOS integration tests now prove allowed/outside writes, network allow/deny, inline profile acceptance, and LaunchServices escape prevention. Frontend tests cover quoting, bounds, preflight, masks, launch, worktree, detach, and resume paths. |

## Path and lifecycle coverage

- Local foreground: backend-generated Seatbelt/bwrap prefix, then inner `/bin/sh`.
- Local detached: the protected command is stored by the detached host; a dead
  host rebuilds the current policy before relaunch, while a live host reattaches.
- Local resume: wrapper generation is awaited and failures set `error` without
  spawning an unprotected command.
- Worktree isolation: wrapper construction uses the resulting worktree workdir.
- Remote foreground/detached/resume: bwrap runs inside the SSH/tmux command on
  the remote Linux host; paths are shell-safe and preflighted there.
- Templates, schedules, board watchers, Master, and addons converge on the same
  launch runtime, so persisted template policy is inherited unless the launch
  dialog explicitly disables it.
- `SandboxConfig` persists through full durable session/template projection;
  it is optional and therefore compatible with older saved states.

## Residual limitations

- Reads are intentionally unrestricted. With network enabled, source code and
  local secrets readable by the user process can be exfiltrated.
- Network-enabled sessions can contact ordinary localhost/TCP services. Known
  container and YAAM detached sockets are blocked, but an unknown privileged
  service can still extend authority.
- Built-in agent state roots remain writable for transcript/runtime function;
  those CLIs may define additional executable configuration there. The broad
  generic home roots and symlink escalation are blocked, but this is still a
  guardrail rather than hostile-code isolation.
- A writable project can change its own scripts and source. Git config/hooks are
  protected, but executing changed project content outside the sandbox later is
  a user trust decision.
- Remote support assumes Linux, POSIX `sh`, GNU-compatible `readlink -f`, and a
  bubblewrap build with the `*-try` bind options. The machine probe exercises the
  core namespace configuration before users opt in.
- `sandbox-exec` is deprecated by Apple. It remains available on current macOS;
  unsupported/missing platforms fail closed. Windows has no implementation.
- Plain terminal sessions are not wrapped because they launch a shell executable
  directly rather than a bounded command string.

## Verification record

- `npx tsc --noEmit -p tsconfig.app.json`
- `npm run lint` (only the repository's documented Fast Refresh warnings)
- `npm test`: 99 files / 588 tests passed
- `npm run build`: production build passed
- `npm audit --omit=dev`: zero vulnerabilities
- `cargo test --lib`: 105 tests passed, including 15 sandbox tests
- `cargo check`
- `cargo clippy --all-targets --all-features -- -D warnings`
- macOS enforcement tests exercise real `sandbox-exec`, allowed/blocked writes,
  network allow/deny, and a baseline-proven LaunchServices escape app

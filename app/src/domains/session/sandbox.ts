// Pure helpers for the session OS write-sandbox. Local sessions get their
// wrapper prefix (sandbox-exec on macOS, bwrap on Linux) from the backend
// (port.sandboxWrapper) and wrap here; remote machine sessions build the whole
// bwrap prefix here since it runs on the remote Linux host. Both produce a
// single shell string, so the existing spawn/detach/resume/ssh paths carry the
// sandbox unchanged. Everything fails closed: no wrapper, no session.
import type { SandboxConfig } from '../../core/types'
import { remotePathExpr, shq } from './remote-machine'

/** Built-in coding-agent state roots — mirrors HOME_WRITE_DIRS in the backend.
 * Generic config/cache/local-data roots would expose startup files and PATH. */
const REMOTE_HOME_WRITE_DIRS = ['.claude', '.codex', '.gemini', '.aider']
const MAX_EXTRA_PATHS = 32
const MAX_PATH_BYTES = 4096

function remotePath(path: string, label: string): string {
  const value = path.trim()
  if (!value) throw new Error(`sandbox: ${label} is empty`)
  if (new TextEncoder().encode(value).length > MAX_PATH_BYTES) throw new Error(`sandbox: ${label} exceeds ${MAX_PATH_BYTES} bytes`)
  if (/\p{Cc}/u.test(value)) throw new Error(`sandbox: ${label} contains control characters`)
  if (value === '~' || value.startsWith('~/')) return remotePathExpr(value)
  if (!value.startsWith('/')) throw new Error(`sandbox: ${label} must be an absolute path (or start with ~/): ${value}`)
  return shq(value)
}

/** Wrap a fully-built local spawn command (env prefix applied) in the backend's
 *  sandbox wrapper. The result is still one shell string for `/bin/sh -lc` /
 *  `<shell> -l -i -c`, so login PATH/toolchain setup still loads outside the
 *  inner sh and spawn/detached/resume all carry the sandbox. */
export function sandboxLocalWrap(wrapper: string, command: string): string {
  return `${wrapper} /bin/sh -c ${shq(command)}`
}

/** Wrap a remote agent command in a bwrap sandbox, applied BEFORE wrapLaunch
 *  (which adds `cd <cwd> &&` and the base64 transport): reads everywhere,
 *  writes only in the cwd + temp + agent config dirs + extras. `"$HOME"` is
 *  left for the REMOTE shell to expand; `--bind-try` skips missing dot-dirs.
 *  Fails closed with a clear message when the host has no bwrap. */
export function sandboxRemoteWrap(command: string, cwd: string | undefined, cfg: SandboxConfig): string {
  const extras = (cfg.extraPaths ?? []).filter(p => p.trim())
  if (extras.length > MAX_EXTRA_PATHS) throw new Error(`sandbox: at most ${MAX_EXTRA_PATHS} extra writable paths are allowed`)
  const dirs = [...(cwd?.trim() ? [cwd] : []), '/tmp', ...extras]
  const binds = dirs.map((path, index) => {
    const arg = remotePath(path, index === 0 && cwd?.trim() ? 'working directory' : 'extra writable path')
    return `--bind ${arg} ${arg}`
  })
  const homeBinds = REMOTE_HOME_WRITE_DIRS.map(d => `--bind-try "$HOME/${d}" "$HOME/${d}"`)
  return (
    'command -v bwrap >/dev/null 2>&1 || { echo "yaam: sandbox requested but bwrap is not installed on this machine (apt install bubblewrap)" >&2; exit 97; }; '
    + 'exec bwrap --ro-bind / / --dev-bind /dev /dev --unshare-pid --unshare-ipc --proc /proc --die-with-parent '
    + [...binds, ...homeBinds].join(' ')
    + (cfg.denyNetwork ? ' --unshare-net' : '')
    + ` sh -c ${shq(command)}`
  )
}

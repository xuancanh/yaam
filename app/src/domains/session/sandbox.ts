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
const MAX_POLICY_PATH_BYTES = 64 * 1024

function remotePath(path: string, label: string): string {
  const value = path.trim()
  if (!value) throw new Error(`sandbox: ${label} is empty`)
  if (new TextEncoder().encode(value).length > MAX_PATH_BYTES) throw new Error(`sandbox: ${label} exceeds ${MAX_PATH_BYTES} bytes`)
  if (/\p{Cc}/u.test(value)) throw new Error(`sandbox: ${label} contains control characters`)
  if (value === '/' || value === '~') throw new Error(`sandbox: ${label} must be a specific folder, not ${value}`)
  if (value.startsWith('~/')) return remotePathExpr(value)
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
 *  writes only in the cwd + temp + built-in agent state dirs + extras. `"$HOME"` is
 *  left for the REMOTE shell to expand; `--bind-try` skips missing dot-dirs.
 *  Fails closed with a clear message when the host has no bwrap. */
export function sandboxRemoteWrap(command: string, cwd: string | undefined, cfg: SandboxConfig): string {
  const extras = (cfg.extraPaths ?? []).filter(p => p.trim())
  if (extras.length > MAX_EXTRA_PATHS) throw new Error(`sandbox: at most ${MAX_EXTRA_PATHS} extra writable paths are allowed`)
  const dirs = [...(cwd?.trim() ? [cwd] : []), '/tmp', ...extras]
  if (dirs.reduce((bytes, path) => bytes + new TextEncoder().encode(path).length, 0) > MAX_POLICY_PATH_BYTES) {
    throw new Error(`sandbox: writable path policy exceeds ${MAX_POLICY_PATH_BYTES} bytes`)
  }
  const pathArgs = dirs.map((path, index) => {
    const arg = remotePath(path, index === 0 && cwd?.trim() ? 'working directory' : 'extra writable path')
    return arg
  })
  const binds = pathArgs.map(arg => `--bind ${arg} ${arg}`)
  const pathGuards = pathArgs.map(arg => (
    `p=${arg}; [ -d "$p" ] || { echo "yaam: sandbox writable path is not a directory: $p" >&2; exit 99; }; `
    + 'real=$(readlink -f -- "$p") || exit 99; '
    + '[ "$real" != / ] && [ "$real" != "$HOME" ] || { echo "yaam: sandbox writable path is too broad: $p" >&2; exit 99; };'
  )).join(' ')
  const homeBinds = REMOTE_HOME_WRITE_DIRS.map(d => `--bind-try "$HOME/${d}" "$HOME/${d}"`)
  const stateGuards = REMOTE_HOME_WRITE_DIRS
    .map(d => `if [ -L "$HOME/${d}" ]; then echo "yaam: sandbox agent state path is a symlink: ~/${d}" >&2; exit 98; fi;`)
    .join(' ')
  // Container-engine sockets are equivalent to host write/exec access. These
  // masks come last so a broad cwd/extra bind cannot expose them again.
  const socketMasks = [
    '/run/docker.sock', '/var/run/docker.sock',
    '"$HOME/.docker/run/docker.sock"', '"$HOME/.docker/desktop/docker.sock"',
    '"${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/docker.sock"',
    '"${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/podman/podman.sock"',
  ].map(path => `--ro-bind-try /dev/null ${path}`)
  const cwdArg = cwd?.trim() ? pathArgs[0] : undefined
  const bwrapArgs = [
    '--ro-bind / /', '--dev /dev', '--unshare-pid', '--unshare-ipc', '--proc /proc', '--die-with-parent',
    ...binds, ...homeBinds, ...socketMasks,
    ...(cfg.denyNetwork ? ['--unshare-net'] : []),
  ].join(' ')
  const gitGuards = cwdArg
    ? `root=${cwdArg}; for git in "$root/.git" "$root"/*/.git; do [ -d "$git" ] || continue; for target in "$git/config" "$git/hooks"; do [ -e "$target" ] && set -- "$@" --ro-bind "$target" "$target"; done; done; `
    : ''
  return (
    'command -v bwrap >/dev/null 2>&1 || { echo "yaam: sandbox requested but bwrap is not installed on this machine (apt install bubblewrap)" >&2; exit 97; }; '
    + stateGuards + ' ' + pathGuards + ' '
    + `set -- bwrap ${bwrapArgs}; `
    + gitGuards
    + `exec "$@" sh -c ${shq(command)}`
  )
}

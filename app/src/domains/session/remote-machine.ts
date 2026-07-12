// Pure helpers for running a session on a saved remote machine over SSH, inside
// tmux for durability. The local PTY just runs an `ssh` client; the agent runs
// in a tmux session on the host, so a disconnect or app restart reattaches
// (resume = re-run the same wrap) instead of losing the process. Auth is
// keys/ssh-agent only — never a password. All functions are pure and build shell
// command strings; the caller hands them to the normal PTY / execCommand paths.
import type { Machine } from '../../core/types'

/** POSIX single-quote: wrap in '…' and escape embedded quotes as '\'' . */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** tmux session name for a YAAM session id (tmux names can't contain . or :). */
export function tmuxName(id: string): string {
  return `yaam-${id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'session'}`
}

interface SshOpts {
  /** interactive terminal (`-tt`, opens a ControlMaster); false = batch one-shot */
  interactive?: boolean
  /** share one SSH connection across the terminal + fs/git/kill calls */
  controlId?: string
}

/** `ssh <options> user@host` prefix, shell-safe. Callers append the remote
 *  command. Batch calls fail fast (BatchMode) instead of hanging on a prompt;
 *  the interactive terminal opens the shared master connection. */
export function sshPrefix(m: Machine, o: SshOpts = {}): string {
  const parts = ['ssh']
  if (o.interactive) parts.push('-tt')
  else parts.push('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8')
  if (m.port && m.port !== 22) parts.push('-p', String(m.port))
  if (m.identityFile?.trim()) parts.push('-i', shq(m.identityFile.trim()))
  if (o.controlId) {
    parts.push(
      '-o', 'ControlMaster=auto',
      '-o', shq(`ControlPath=~/.ssh/yaam-${o.controlId.replace(/[^A-Za-z0-9_-]/g, '')}`),
      '-o', 'ControlPersist=60',
    )
  }
  // advanced raw ssh options (user-trusted config, like defaultCwd/credCmd)
  if (m.options?.trim()) parts.push(m.options.trim())
  parts.push(shq(`${m.user}@${m.host}`))
  return parts.join(' ')
}

/** base64 (UTF-8 safe) so the inner command survives two shells without a
 *  nested-quoting minefield. */
function toB64(s: string): string {
  let bin = ''
  for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b)
  return btoa(bin)
}

/** Local PTY command that runs `innerCommand` on the machine over SSH.
 *
 *  By default the agent runs directly (like a local session): it dies when the
 *  SSH connection drops (app quit, network), and resume re-runs it fresh.
 *  `detached` opts into durability by running it inside tmux (`new-session -A`
 *  attaches-or-creates, so resume reattaches and stop kills the tmux session).
 *
 *  `innerCommand` is the fully-built agent command (env prefix already applied).
 *  `cwd` is the session's working dir (launch dialog / persisted `agent.cwd`),
 *  falling back to the machine default — it MUST match the dir Files/Git browse,
 *  or the terminal and panels diverge. The inner command is base64-encoded so it
 *  survives both shells without a nested-quoting minefield. */
export function wrapLaunch(m: Machine, innerCommand: string, id: string, cwd?: string, detached?: boolean): string {
  const dir = (cwd || m.remoteDir || '').trim()
  const inner = dir ? `cd ${shq(dir)} && ${innerCommand}` : innerCommand
  const decode = `"$(printf %s ${toB64(inner)} | base64 -d)"`
  const remote = detached
    ? `tmux new-session -A -s ${tmuxName(id)} ${decode}`
    : `sh -c ${decode}`
  return `${sshPrefix(m, { interactive: true, controlId: id })} ${shq(remote)}`
}

/** One-shot command that ends the remote agent by killing its tmux session. */
export function killRemote(m: Machine, id: string): string {
  return `${sshPrefix(m, { controlId: id })} ${shq(`tmux kill-session -t ${tmuxName(id)}`)}`
}

/** Resolve a saved machine by id. */
export function findMachine(machines: Machine[] | undefined, id: string | undefined): Machine | undefined {
  return id ? machines?.find(m => m.id === id) : undefined
}

/** One-shot command that lists the codex rollout files on the host written since
 *  `sinceSec` (epoch seconds), newest first — the SSH analogue of the local
 *  session-file probe (session.rs). codex has no launch-time id flag, so a remote
 *  codex session's id can only be recovered by finding the rollout it just wrote.
 *  `-newermt @<sec>` (works on GNU + BSD find) bounds it to this run so we don't
 *  grab a stale session; `-exec ls -t {} +` sorts newest-first portably. */
export function remoteSessionProbe(m: Machine, id: string, sinceSec: number): string {
  const find = `find "$HOME/.codex/sessions" -type f -name 'rollout-*.jsonl' -newermt @${Math.floor(sinceSec)} -exec ls -t {} + 2>/dev/null | head -20`
  return `${sshPrefix(m, { controlId: id })} ${shq(find)}`
}

/** Derive codex's resume id from a rollout path `…/rollout-<ts>-<uuid>.jsonl`:
 *  the trailing 36-char UUID of the file stem (mirrors derive_session_id in
 *  session.rs). Returns undefined for anything too short to carry a UUID. */
export function codexIdFromRolloutPath(path: string): string | undefined {
  const file = path.split('/').pop() || ''
  const stem = file.replace(/\.jsonl$/, '')
  return stem.length >= 36 ? stem.slice(-36) : undefined
}

/** Local command that probes a machine's requirements over batch SSH: reachable,
 *  tmux present, a working `base64 -d` (macOS/BSD differ), git, and the default
 *  dir. Prints one `NAME_OK` / `NO_NAME` marker per check for the caller to read. */
export function testCommand(m: Machine): string {
  const dir = m.remoteDir?.trim()
  const checks = [
    'echo SSH_OK',
    'tmux -V >/dev/null 2>&1 && echo TMUX_OK || echo NO_TMUX',
    'printf x | base64 | base64 -d >/dev/null 2>&1 && echo B64_OK || echo NO_B64',
    'command -v git >/dev/null 2>&1 && echo GIT_OK || echo NO_GIT',
    'command -v bwrap >/dev/null 2>&1 && echo BWRAP_OK || echo NO_BWRAP',
    dir ? `[ -d ${shq(dir)} ] && echo DIR_OK || echo NO_DIR` : 'echo DIR_SKIP',
  ].join('; ')
  return `${sshPrefix(m, {})} ${shq(checks)}`
}

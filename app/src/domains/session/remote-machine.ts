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

/** Local PTY command that runs `innerCommand` on the machine inside a tmux
 *  session. `new-session -A` attaches if the session already exists (durability),
 *  so resume just re-runs this. `innerCommand` is the fully-built agent command
 *  (env prefix already applied). */
export function wrapLaunch(m: Machine, innerCommand: string, id: string): string {
  const dir = m.remoteDir?.trim()
  const inner = dir ? `cd ${shq(dir)} && ${innerCommand}` : innerCommand
  const b64 = toB64(inner)
  // the remote shell decodes the inner command and hands it to tmux as one arg
  const remote = `tmux new-session -A -s ${tmuxName(id)} "$(printf %s ${b64} | base64 -d)"`
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

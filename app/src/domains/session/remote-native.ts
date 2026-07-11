// Remote filesystem/git for machine sessions: the same operations the local
// `native` adapters expose, but executed on the session's host over SSH (reusing
// `execCommand` as the transport — no new Rust) and parsed here. Selected per
// session by `sessionFs`: local sessions get the native implementations
// unchanged; machine sessions get these. Batch SSH shares the terminal session's
// ControlMaster connection (via the session id) so each call is cheap.
import type { Machine } from '../../core/types'
import {
  execCommand, gitCommit, gitFileDiff, gitFileDiffSide, gitStage, gitStatus, gitUnstage,
  listDir, readFileB64, readTextFile, writeTextFile,
} from '../../core/native'
import type { DirEntryInfo, GitStatusResult } from '../../core/native'
import { detectRepoDirs, detectRepoDirsVia } from '../../shared/git-repos'
import { shq, sshPrefix } from './remote-machine'

// execCommand caps output at ~40 KB; keep binary reads under that (base64 ~4/3)
const REMOTE_B64_CAP = 24_000
const REMOTE_TEXT_CAP = 30_000

export interface SessionFs {
  listDir(path: string): Promise<DirEntryInfo[]>
  readTextFile(path: string): Promise<string>
  writeTextFile(path: string, contents: string): Promise<void>
  readFileB64(path: string): Promise<string>
  gitStatus(cwd: string): Promise<GitStatusResult>
  gitFileDiff(cwd: string, path: string): Promise<string>
  gitFileDiffSide(cwd: string, path: string, staged: boolean): Promise<string>
  gitStage(cwd: string, paths: string[]): Promise<void>
  gitUnstage(cwd: string, paths: string[]): Promise<void>
  gitCommit(cwd: string, message: string): Promise<string>
  /** the repos reachable from cwd: itself, or repo subfolders up to
   *  REPO_SCAN_DEPTH levels down (multi-repo working folders) */
  detectRepos(cwd: string): Promise<string[]>
  /** remote hosts can't push fs-change events — callers use manual refresh */
  readonly remote: boolean
}

/** The local (in-process native) adapter — the existing behavior verbatim. */
const localFs: SessionFs = {
  listDir, readTextFile, readFileB64, gitStatus, gitFileDiff, gitFileDiffSide, gitStage, gitUnstage, gitCommit,
  writeTextFile: (path, contents) => writeTextFile(path, contents),
  detectRepos: detectRepoDirs,
  remote: false,
}

/** Parse `git status --porcelain` exactly like the Rust parser (git.rs):
 *  require a space at column 2; status = trimmed XY, index = X, work = Y; take a
 *  rename's destination (after " -> "); strip surrounding quotes git adds to
 *  paths with special characters — so paths match what stage/diff expect. */
export function parsePorcelain(root: string, branch: string, lines: string[]): GitStatusResult {
  const files: GitStatusResult['files'] = []
  for (const line of lines) {
    if (line.length < 4 || line[2] !== ' ') continue
    let path = line.slice(3)
    const arrow = path.indexOf(' -> ')
    if (arrow !== -1) path = path.slice(arrow + 4)
    path = path.replace(/^"+/, '').replace(/"+$/, '')
    files.push({ path, status: line.slice(0, 2).trim(), index: line.slice(0, 1), work: line.slice(1, 2) })
  }
  return { root, branch, files }
}

/** Build the remote adapter for one machine + session (the id shares the SSH
 *  ControlMaster the terminal opened). */
export function remoteFs(machine: Machine, id: string): SessionFs {
  const prefix = sshPrefix(machine, { controlId: id })
  // run one remote shell command; the inner command keeps its own quoting and is
  // single-quoted again for the local shell (shq is composable)
  const run = async (remoteCmd: string, timeoutMs = 20_000) => {
    const { code, output } = await execCommand(`${prefix} ${shq(remoteCmd)}`, undefined, timeoutMs)
    return { code, output }
  }
  const ok = (r: { code: number; output: string }) => {
    if (r.code !== 0) throw new Error(r.output.trim() || `remote command failed (${r.code})`)
    return r.output
  }
  const adapter: SessionFs = {
    remote: true,
    async listDir(path) {
      // -1 one per line · -A skip . and .. · -p append / to directories
      const out = ok(await run(`ls -1Ap -- ${shq(path)}`))
      const base = path.replace(/\/+$/, '')
      return out.split('\n')
        .filter(Boolean)
        .map(line => {
          const isDir = line.endsWith('/')
          const name = isDir ? line.slice(0, -1) : line
          return { name, path: `${base}/${name}`, isDir }
        })
        // folders first, then case-insensitive — matches the local listing
        .sort((a, b) => (a.isDir === b.isDir ? a.name.toLowerCase().localeCompare(b.name.toLowerCase()) : a.isDir ? -1 : 1))
    },
    async readTextFile(path) {
      const target = shq(path)
      return ok(await run(
        `size=$(wc -c < ${target}) || exit $?; `
        + `if [ "$size" -gt ${REMOTE_TEXT_CAP} ]; then echo "file too large to edit over SSH ($size bytes; limit ${REMOTE_TEXT_CAP})" >&2; exit 1; fi; `
        + `cat -- ${target}`,
      ))
    },
    async writeTextFile(path, contents) {
      // the content travels base64 inside the command line (like wrapLaunch's
      // inner command) — keep it well under ARG_MAX
      const bytes = new TextEncoder().encode(contents)
      if (bytes.length > 200_000) throw new Error('file too large to save over SSH (200 KB limit)')
      let bin = ''
      for (const b of bytes) bin += String.fromCharCode(b)
      const target = shq(path)
      // Decode beside the destination, then rename. A failed transfer/decode
      // leaves the original intact; copying first preserves an existing mode.
      ok(await run(
        `tmp=${target}.yaam-tmp-$$; trap 'rm -f -- "$tmp"' EXIT HUP INT TERM; `
        + `if [ -e ${target} ]; then cp -p -- ${target} "$tmp"; else : > "$tmp"; fi; `
        + `printf %s ${btoa(bin)} | base64 -d > "$tmp" && mv -- "$tmp" ${target}`,
      ))
    },
    async readFileB64(path) {
      // execCommand caps its output (~40 KB) and base64 inflates ~4/3, so a big
      // file would come back truncated — i.e. a corrupt preview. Refuse it up
      // front with the real size instead (local reads have a size limit too).
      const size = Number(ok(await run(`wc -c < ${shq(path)}`)).trim()) || 0
      if (size > REMOTE_B64_CAP) throw new Error(`file too large to preview over SSH (${size} bytes; limit ${REMOTE_B64_CAP})`)
      // redirection avoids base64's differing file-arg flags across platforms
      return ok(await run(`base64 < ${shq(path)}`)).replace(/\s+/g, '')
    },
    async gitStatus(cwd) {
      const d = shq(cwd)
      const out = ok(await run(
        `printf '%s\\n' "$(git -C ${d} rev-parse --show-toplevel 2>/dev/null)" "$(git -C ${d} branch --show-current 2>/dev/null)"; git -C ${d} status --porcelain`,
      ))
      const lines = out.split('\n')
      const root = (lines[0] ?? '').trim()
      if (!root) throw new Error('not a git repository')
      return parsePorcelain(root, (lines[1] ?? '').trim(), lines.slice(2).filter(Boolean))
    },
    async gitFileDiff(cwd, path) {
      return ok(await run(`git -C ${shq(cwd)} diff --no-color -U0 HEAD -- ${shq(path)}`))
    },
    async gitFileDiffSide(cwd, path, staged) {
      return ok(await run(`git -C ${shq(cwd)} diff --no-color ${staged ? '--cached ' : ''}-- ${shq(path)}`))
    },
    async gitStage(cwd, paths) {
      ok(await run(`git -C ${shq(cwd)} add -- ${paths.map(shq).join(' ')}`))
    },
    async gitUnstage(cwd, paths) {
      ok(await run(`git -C ${shq(cwd)} restore --staged -- ${paths.map(shq).join(' ')}`))
    },
    async gitCommit(cwd, message) {
      if (!message.trim()) throw new Error('commit message is empty')
      return ok(await run(`git -C ${shq(cwd)} commit -m ${shq(message)}`))
    },
    // reuses this adapter's own gitStatus/listDir, so the multi-repo probe runs
    // on the remote host (cheap: shared ControlMaster connection)
    detectRepos: cwd => detectRepoDirsVia(adapter, cwd),
  }
  return adapter
}

/** Pick the fs/git adapter for a session: its machine's remote adapter, or the
 *  local native one. */
export function sessionFs(machine: Machine | undefined, id: string): SessionFs {
  return machine ? remoteFs(machine, id) : localFs
}

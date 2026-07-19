// Turn a stable git diff into compact, durable evidence for session/task
// history. We store file paths, change kinds, and line counts—not full diffs.
import type { MutableRefObject } from 'react'
import type { Agent, AppState, HistoryFileChange } from '../../core/types'
import { gitDiff, gitStatus, worktreeDiff } from '../../core/native'
import { detectRepoDirs, repoLabel } from '../../shared/git-repos'
import type { LocatedTask } from '../board/task-state'
import { createSessionActivity, withActivityTargets } from '../activity/history'
import { sessionFs } from './remote-native'

interface RepoDiff { name: string; diff: string; error?: string | null }

const unquote = (path: string) => path.replace(/^"|"$/g, '').replace(/^[ab]\//, '')

/** Parse one or more unified diffs into per-file evidence. */
export function parseHistoryChanges(repos: RepoDiff[]): HistoryFileChange[] {
  const out: HistoryFileChange[] = []
  for (const repo of repos) {
    if (repo.error || repo.diff.startsWith('error:')) continue
    let current: HistoryFileChange | undefined
    const push = () => { if (current) out.push(current); current = undefined }
    for (const line of repo.diff.split('\n')) {
      if (line.startsWith('diff --git ')) {
        push()
        const body = line.slice('diff --git '.length)
        const split = body.indexOf(' b/')
        const raw = split >= 0 ? body.slice(split + 1) : body.split(' ').at(-1) ?? ''
        const path = unquote(raw)
        current = { path: repo.name ? `${repo.name}/${path}` : path, change: 'modified', additions: 0, deletions: 0 }
      } else if (!current) {
        continue
      } else if (line.startsWith('new file mode ')) {
        current.change = 'added'
      } else if (line.startsWith('deleted file mode ')) {
        current.change = 'deleted'
      } else if (line.startsWith('rename from ')) {
        current.change = 'renamed'
        const from = unquote(line.slice('rename from '.length))
        current.from = repo.name ? `${repo.name}/${from}` : from
      } else if (line.startsWith('rename to ')) {
        const to = unquote(line.slice('rename to '.length))
        current.path = repo.name ? `${repo.name}/${to}` : to
      } else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
        current.change = 'binary'
        delete current.additions
        delete current.deletions
      } else if (line.startsWith('+') && !line.startsWith('+++')) {
        current.additions = (current.additions ?? 0) + 1
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        current.deletions = (current.deletions ?? 0) + 1
      }
    }
    push()
  }
  return out.slice(0, 120)
}

export function historyChangeLabel(changes: HistoryFileChange[]): string {
  const add = changes.reduce((n, f) => n + (f.additions ?? 0), 0)
  const del = changes.reduce((n, f) => n + (f.deletions ?? 0), 0)
  return `Working tree snapshot · ${changes.length} file${changes.length === 1 ? '' : 's'} · +${add} −${del}`
}

interface CapturePorts {
  stateRef: MutableRefObject<AppState>
  dispatch: (fn: (s: AppState) => AppState) => void
  taskForSession: (id: string) => LocatedTask | undefined
  load?: (agent: Agent) => Promise<RepoDiff[]>
}

async function loadChanges(agent: Agent): Promise<RepoDiff[]> {
  if (agent.machine) {
    const fs = sessionFs(agent.machine, agent.id)
    const repos = await fs.detectRepos(agent.cwd || agent.machine.remoteDir || '')
    const out: RepoDiff[] = []
    for (const repo of repos.slice(0, 24)) {
      const status = await fs.gitStatus(repo)
      const chunks = [await fs.gitDiff(repo)]
      for (const file of status.files.filter(f => f.status === '??').slice(0, 120)) {
        chunks.push(`diff --git a/${file.path} b/${file.path}\nnew file mode 100644`)
      }
      out.push({
        name: repos.length === 1 && repo === agent.cwd ? '' : repoLabel(agent.cwd || '', repo),
        diff: chunks.join('\n'),
      })
    }
    return out
  }
  if (agent.machineId) return []
  if (agent.worktree) return await worktreeDiff(agent.worktree.root)
  if (!agent.cwd) return []
  const repos = await detectRepoDirs(agent.cwd)
  return await Promise.all(repos.map(async repo => ({
    name: repos.length === 1 && repo === agent.cwd ? '' : repoLabel(agent.cwd!, repo),
    diff: await gitDiff(repo),
  })))
}

async function addUntrackedEvidence(agent: Agent, changes: HistoryFileChange[]): Promise<HistoryFileChange[]> {
  if (agent.machineId || agent.worktree || !agent.cwd) return changes
  const repos = await detectRepoDirs(agent.cwd)
  const known = new Set(changes.map(f => f.path))
  for (const repo of repos) {
    const prefix = repos.length === 1 && repo === agent.cwd ? '' : `${repoLabel(agent.cwd, repo)}/`
    const status = await gitStatus(repo).catch(() => null)
    for (const file of status?.files ?? []) {
      const path = `${prefix}${file.path}`
      if (known.has(path)) continue
      const code = `${file.index}${file.work}`
      changes.push({
        path,
        change: code.includes('?') || code.includes('A') ? 'added'
          : code.includes('D') ? 'deleted'
          : code.includes('R') ? 'renamed'
          : 'modified',
      })
      known.add(path)
    }
  }
  return changes.slice(0, 120)
}

/** Best-effort snapshot at a process milestone. Failures never affect exit. */
export async function captureSessionChanges(ports: CapturePorts, sessionId: string): Promise<void> {
  const before = ports.stateRef.current
  const agent = before.agents.find(a => a.id === sessionId)
  if (!agent) return
  try {
    const parsed = parseHistoryChanges(await (ports.load ?? loadChanges)(agent))
    const changes = ports.load ? parsed : await addUntrackedEvidence(agent, parsed)
    if (!changes.length) return
    const taskFor = ports.taskForSession(sessionId)
    const entry = createSessionActivity(before, sessionId, {
      category: 'work', actor: 'system', kind: 'changes',
      text: historyChangeLabel(changes), changes,
    }, taskFor?.task.id)
    ports.dispatch(s => withActivityTargets(s, entry, {
      sessionId,
      taskId: taskFor?.task.id,
      workspaceId: taskFor?.workspaceId,
      coalesce: true,
    }))
  } catch { /* non-git folder, removed worktree, or host unavailable */ }
}

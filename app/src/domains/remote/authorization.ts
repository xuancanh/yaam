import type { AppState } from '../../core/types'

/** Canonical authorization roots represented in the active phone snapshot. */
export function remoteFileRoots(s: AppState): string[] {
  const roots = s.agents
    .filter(a => !a.archived && (a.workspaceId ?? s.activeWorkspace) === s.activeWorkspace)
    .map(a => a.worktree?.workdir ?? a.cwd)
    .filter((p): p is string => !!p?.startsWith('/'))
    .map(p => p.replace(/\/+$/, ''))
  return [...new Set(roots)].sort((a, b) => b.length - a.length)
}

/** Return the active root that lexically contains `path`; native reads still
 *  receive this root so Rust performs the canonical/symlink-safe check. */
export function authorizedRemoteRoot(s: AppState, path: string): string | undefined {
  if (!path.startsWith('/')) return undefined
  return remoteFileRoots(s).find(root => path === root || path.startsWith(`${root}/`))
}

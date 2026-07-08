// Best-effort recovery of a remote CLI's session id over SSH. Unlike claude
// (which honors `--session-id <uuid>`, so we mint the id up front and inject it),
// codex has no launch-time id flag — its id is only discoverable AFTER start,
// from the rollout file it writes under ~/.codex/sessions on the host. This finds
// that file and captures the id so resume can `codex resume <id>` instead of
// starting a fresh session. It is strictly best-effort: any failure (unreachable
// host, no rollout yet, not the desktop app) is swallowed and the session simply
// resumes clean — never throws, never blocks launch/resume.
import { dispatch } from '../../core/store'
import { execCommand } from '../../core/native'
import type { Machine } from '../../core/types'
import { codexIdFromRolloutPath, remoteSessionProbe } from './remote-machine'

/** codex writes its rollout at process start, but not instantly — retry a few
 *  times (like the local probe) so a slow first write is still caught. */
const PROBE_DELAYS_MS = [7000, 25000, 60000]

/** Kick off a best-effort remote session-id probe for a machine session. Only
 *  codex is handled here (claude mints its id at launch; other CLIs fall back to
 *  a clean resume). `isResume` trims the retry schedule — on resume the id is
 *  already claimed if it was captured, so a couple of quick attempts suffice. */
export function probeRemoteCliSession(
  id: string,
  machine: Machine,
  kind: string | undefined,
  isResume = false,
): void {
  if (kind !== 'codex') return
  // window it to just before this launch so we can't pick up an older session
  const sinceSec = Math.floor(Date.now() / 1000) - 5
  const cmd = remoteSessionProbe(machine, id, sinceSec)

  const attempt = () => {
    // execCommand throws outside the desktop app; catch everything and no-op
    void execCommand(cmd)
      .then(({ code, output }) => {
        if (code !== 0) return
        const ids = output.split('\n').map(codexIdFromRolloutPath).filter((x): x is string => !!x)
        if (!ids.length) return
        dispatch(s => {
          const cur = s.agents.find(a => a.id === id)
          if (!cur) return s
          // don't steal an id another live session already owns (concurrent
          // codex runs on the same host aren't cwd-scoped in the store here)
          const claimed = new Set(s.agents.filter(a => a.id !== id && a.cliSessionId).map(a => a.cliSessionId))
          const pick = ids.find(x => !claimed.has(x))
          if (!pick || pick === cur.cliSessionId) return s
          return {
            ...s,
            agents: s.agents.map(a => a.id === id
              ? { ...a, cliSessionId: pick, log: a.log.concat([{ t: 'sys' as const, x: `${isResume ? 'session id changed on resume' : 'captured codex session'} · ${pick}` }]) }
              : a),
          }
        })
      })
      .catch(() => {})
  }

  const delays = isResume ? PROBE_DELAYS_MS.slice(0, 2) : PROBE_DELAYS_MS
  for (const d of delays) setTimeout(attempt, d)
}

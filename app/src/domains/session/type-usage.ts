// Launch counts per agent type, so the new-session dialog can lead with the
// types this user actually runs. 'shell' counts plain terminals.
import type { OrchestrationSettings, SessionRecord } from '../../core/entities'

export type TypeUsage = Record<string, { n: number; at: number }>

/** Count one launch of `typeId`. */
export function recordTypeUse(usage: TypeUsage | undefined, typeId: string, at = Date.now()): TypeUsage {
  const prev = usage?.[typeId]
  return { ...(usage ?? {}), [typeId]: { n: (prev?.n ?? 0) + 1, at } }
}

/** Order type ids by launches (remembered + existing sessions), then by most
 *  recent use, then by their configured order. */
export function sortByUsage(
  ids: string[],
  settings: Pick<OrchestrationSettings, 'agentTypeUsage'>,
  agents: Pick<SessionRecord, 'typeId' | 'kind'>[],
): string[] {
  const live: Record<string, number> = {}
  for (const a of agents) if (a.kind !== 'chat' && a.typeId) live[a.typeId] = (live[a.typeId] ?? 0) + 1
  const usage = settings.agentTypeUsage ?? {}
  const score = (id: string) => (usage[id]?.n ?? 0) + (live[id] ?? 0)
  return ids
    .map((id, i) => ({ id, i }))
    .sort((a, b) => score(b.id) - score(a.id) || (usage[b.id]?.at ?? 0) - (usage[a.id]?.at ?? 0) || a.i - b.i)
    .map(x => x.id)
}

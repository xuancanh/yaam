// Integration runtime: live MCP server sessions and skill-registry catalogs.
// Owns the two caches (keyed by server / registry id) and the connect/refresh
// calls that populate them and mirror status onto the store. Shared by the
// settings actions (connect/refresh buttons) and the chat runner (tools/skills).
import { useMemo } from 'react'
import type { MutableRefObject } from 'react'
import type { AppState } from '../../core/types'
import type { McpSession } from '../../core/mcp'
import type { CatalogSkill } from '../../core/skills'
import { mcpConnect } from '../../core/mcp'
import { fetchSkillRegistry } from '../../core/skills'
import { dispatch } from '../../core/store'
import type { StatePort } from '../../core/ports'

export interface IntegrationRuntime {
  /** live MCP sessions by server id (chat agents call their tools) */
  mcpSessions: MutableRefObject<Map<string, McpSession>>
  /** fetched skill catalogs by registry id */
  skillCatalogs: MutableRefObject<Map<string, CatalogSkill[]>>
  /** (re)connect one MCP server; resolves to '' or an error message */
  connectMcp: (id: string) => Promise<string>
  /** (re)fetch one registry's catalog; resolves to '' or an error message */
  refreshSkillCatalog: (id: string) => Promise<string>
}

/** Plain (non-React) factory: owns the two live caches and the connect/refresh
 *  calls that populate them + mirror status onto the store via the StatePort. */
export function createIntegrationRuntime(state: StatePort): IntegrationRuntime {
  const mcpSessions: MutableRefObject<Map<string, McpSession>> = { current: new Map() }
  const skillCatalogs: MutableRefObject<Map<string, CatalogSkill[]>> = { current: new Map() }

  const connectMcp = async (id: string): Promise<string> => {
    const server = state.get().mcpServers.find(x => x.id === id)
    if (!server) return 'server not found'
    try {
      const session = await mcpConnect(server.name, server.url, server.headers)
      mcpSessions.current.set(id, session)
      state.update(s => ({
        ...s,
        mcpServers: s.mcpServers.map(x => x.id === id ? { ...x, toolCount: session.tools.length, lastError: undefined } : x),
      }))
      return ''
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      mcpSessions.current.delete(id)
      state.update(s => ({
        ...s,
        mcpServers: s.mcpServers.map(x => x.id === id ? { ...x, toolCount: undefined, lastError: msg } : x),
      }))
      return msg
    }
  }

  const refreshSkillCatalog = async (id: string): Promise<string> => {
    const reg = state.get().skillRegistries.find(r => r.id === id)
    if (!reg) return 'registry not found'
    try {
      const catalog = await fetchSkillRegistry(reg.name, reg.url)
      skillCatalogs.current.set(id, catalog)
      state.update(s2 => ({
        ...s2,
        skillRegistries: s2.skillRegistries.map(r => (r.id === id ? { ...r, skillCount: catalog.length, lastError: undefined } : r)),
      }))
      return ''
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      state.update(s2 => ({
        ...s2,
        skillRegistries: s2.skillRegistries.map(r => (r.id === id ? { ...r, skillCount: undefined, lastError: msg } : r)),
      }))
      return msg
    }
  }

  return { mcpSessions, skillCatalogs, connectMcp, refreshSkillCatalog }
}

/** React adapter over the real store. */
export function useIntegrationRuntime(stateRef: MutableRefObject<AppState>): IntegrationRuntime {
  return useMemo(() => createIntegrationRuntime({ get: () => stateRef.current, update: dispatch, subscribe: () => () => {} }), [stateRef])
}

// Integration runtime: live MCP server sessions and skill-registry catalogs.
// Owns the two caches (keyed by server / registry id) and the connect/refresh
// calls that populate them and mirror status onto the store. Shared by the
// settings actions (connect/refresh buttons) and the chat runner (tools/skills).
import { useCallback, useRef } from 'react'
import type { MutableRefObject } from 'react'
import type { AppState } from '../../core/types'
import type { McpSession } from '../../core/mcp'
import type { CatalogSkill } from '../../core/skills'
import { mcpConnect } from '../../core/mcp'
import { fetchSkillRegistry } from '../../core/skills'
import { dispatch } from '../../core/store'

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

export function useIntegrationRuntime(stateRef: MutableRefObject<AppState>): IntegrationRuntime {
  const mcpSessions = useRef<Map<string, McpSession>>(new Map())
  const skillCatalogs = useRef<Map<string, CatalogSkill[]>>(new Map())

  const connectMcp = useCallback(async (id: string): Promise<string> => {
    const server = stateRef.current.mcpServers.find(x => x.id === id)
    if (!server) return 'server not found'
    try {
      const session = await mcpConnect(server.name, server.url, server.headers)
      mcpSessions.current.set(id, session)
      dispatch(s => ({
        ...s,
        mcpServers: s.mcpServers.map(x => x.id === id ? { ...x, toolCount: session.tools.length, lastError: undefined } : x),
      }))
      return ''
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      mcpSessions.current.delete(id)
      dispatch(s => ({
        ...s,
        mcpServers: s.mcpServers.map(x => x.id === id ? { ...x, toolCount: undefined, lastError: msg } : x),
      }))
      return msg
    }
  }, [stateRef])

  const refreshSkillCatalog = useCallback(async (id: string): Promise<string> => {
    const reg = stateRef.current.skillRegistries.find(r => r.id === id)
    if (!reg) return 'registry not found'
    try {
      const catalog = await fetchSkillRegistry(reg.name, reg.url)
      skillCatalogs.current.set(id, catalog)
      dispatch(s2 => ({
        ...s2,
        skillRegistries: s2.skillRegistries.map(r => (r.id === id ? { ...r, skillCount: catalog.length, lastError: undefined } : r)),
      }))
      return ''
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      dispatch(s2 => ({
        ...s2,
        skillRegistries: s2.skillRegistries.map(r => (r.id === id ? { ...r, skillCount: undefined, lastError: msg } : r)),
      }))
      return msg
    }
  }, [stateRef])

  return { mcpSessions, skillCatalogs, connectMcp, refreshSkillCatalog }
}

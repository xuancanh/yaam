// Settings-domain actions: CRUD for agent types, MCP servers, skills, personas,
// skill registries, chat-agent types, the tools registry, and the settings
// object. Pure-ish reducers over the shared store, plus MCP/skill reconnect
// side effects. Composed into the provider's action surface.
import { useMemo } from 'react'
import type { MutableRefObject } from 'react'
import type { AppState } from '../../core/types'
import type { McpSession } from '../../core/mcp'
import type { CatalogSkill } from '../../core/skills'
import { mkId } from '../../core/state-lib'
import { PERM_ORDER } from '../../core/data'
import type { ConductorActions } from '../../store'

export interface SettingsActionsCtx {
  dispatch: (f: (s: AppState) => AppState) => void
  later: (ms: number, fn: () => void) => void
  connectMcp: (id: string) => Promise<string>
  refreshSkillCatalog: (id: string) => Promise<string>
  mcpSessions: MutableRefObject<Map<string, McpSession>>
  skillCatalogs: MutableRefObject<Map<string, CatalogSkill[]>>
}

type SettingsActions = Pick<ConductorActions,
  | 'toggleAgentType' | 'addMcpServer' | 'updateMcpServer' | 'removeMcpServer' | 'connectMcpServer'
  | 'addSkill' | 'updateSkill' | 'removeSkill' | 'addPersona' | 'updatePersona' | 'removePersona'
  | 'addSkillRegistry' | 'updateSkillRegistry' | 'removeSkillRegistry' | 'refreshSkillRegistry'
  | 'addChatAgentType' | 'updateChatAgentType' | 'deleteChatAgentType'
  | 'toggleSetting' | 'updateSettings' | 'setAgentTypeCmd' | 'updateAgentType' | 'addAgentType'
  | 'deleteAgentType' | 'cycleCatalogPerm'>

export function useSettingsActions(ctx: SettingsActionsCtx): SettingsActions {
  const { dispatch, later } = ctx
  return useMemo(() => ({
    toggleAgentType: id => dispatch(s => ({
      ...s,
      agentTypes: s.agentTypes.map(x => (x.id === id ? { ...x, enabled: !x.enabled } : x)),
    })),

    addMcpServer: (name, url, headers) => {
      const id = mkId('mcp')
      dispatch(s => ({
        ...s,
        mcpServers: s.mcpServers.concat([{
          id, name: name.trim() || url.trim(), url: url.trim(), headers: headers?.trim() || undefined, enabled: true,
        }]),
      }))
      later(50, () => { void ctx.connectMcp(id) })
    },

    updateMcpServer: (id, patch) => {
      dispatch(s => ({
        ...s,
        mcpServers: s.mcpServers.map(x => (x.id === id ? { ...x, ...patch } : x)),
      }))
      if (patch.url !== undefined || patch.headers !== undefined || patch.enabled === true) later(50, () => { void ctx.connectMcp(id) })
      if (patch.enabled === false) ctx.mcpSessions.current.delete(id)
    },

    removeMcpServer: id => {
      ctx.mcpSessions.current.delete(id)
      dispatch(s => ({ ...s, mcpServers: s.mcpServers.filter(x => x.id !== id) }))
    },

    connectMcpServer: id => ctx.connectMcp(id),

    addSkill: () => {
      const id = mkId('sk')
      dispatch(s => ({
        ...s,
        skills: s.skills.concat([{ id, name: `skill-${s.skills.length + 1}`, description: '', body: '' }]),
      }))
      return id
    },

    updateSkill: (id, patch) => dispatch(s => ({
      ...s,
      skills: s.skills.map(x => (x.id === id ? { ...x, ...patch } : x)),
    })),

    removeSkill: id => dispatch(s => ({ ...s, skills: s.skills.filter(x => x.id !== id) })),

    addPersona: () => {
      const id = mkId('pe')
      dispatch(s => ({
        ...s,
        personas: s.personas.concat([{ id, name: `persona-${s.personas.length + 1}`, description: '', body: '' }]),
      }))
      return id
    },

    updatePersona: (id, patch) => dispatch(s => ({
      ...s,
      personas: s.personas.map(x => (x.id === id ? { ...x, ...patch } : x)),
    })),

    removePersona: id => dispatch(s => ({ ...s, personas: s.personas.filter(x => x.id !== id) })),

    addSkillRegistry: (name, url) => {
      const id = mkId('sr')
      dispatch(s => ({
        ...s,
        skillRegistries: s.skillRegistries.concat([{
          id, name: name.trim() || (/^https?:/.test(url) ? url.split('/')[4] ?? 'registry' : 'local'), url: url.trim(), enabled: true,
        }]),
      }))
      later(50, () => { void ctx.refreshSkillCatalog(id) })
    },

    updateSkillRegistry: (id, patch) => {
      dispatch(s => ({
        ...s,
        skillRegistries: s.skillRegistries.map(x => (x.id === id ? { ...x, ...patch } : x)),
      }))
      if (patch.url !== undefined || patch.enabled === true) later(50, () => { void ctx.refreshSkillCatalog(id) })
      if (patch.enabled === false) ctx.skillCatalogs.current.delete(id)
    },

    removeSkillRegistry: id => {
      ctx.skillCatalogs.current.delete(id)
      dispatch(s => ({ ...s, skillRegistries: s.skillRegistries.filter(x => x.id !== id) }))
    },

    refreshSkillRegistry: id => ctx.refreshSkillCatalog(id),

    addChatAgentType: () => dispatch(s => ({
      ...s,
      chatAgentTypes: s.chatAgentTypes.concat([{
        id: mkId('ct'), name: `chat-${s.chatAgentTypes.length + 1}`, provider: 'anthropic',
        model: 'claude-sonnet-5', enabled: true,
      }]),
    })),

    updateChatAgentType: (id, patch) => dispatch(s => ({
      ...s,
      chatAgentTypes: s.chatAgentTypes.map(t => (t.id === id ? { ...t, ...patch } : t)),
    })),

    deleteChatAgentType: id => dispatch(s => ({
      ...s,
      chatAgentTypes: s.chatAgentTypes.filter(t => t.id !== id),
    })),

    toggleSetting: k => dispatch(s => ({ ...s, settings: { ...s.settings, [k]: !s.settings[k] } })),
    updateSettings: patch => dispatch(s => ({ ...s, settings: { ...s.settings, ...patch } })),
    setAgentTypeCmd: (id, cmd) => dispatch(s => ({
      ...s,
      agentTypes: s.agentTypes.map(t => (t.id === id ? { ...t, model: cmd } : t)),
    })),
    updateAgentType: (id, patch) => dispatch(s => ({
      ...s,
      agentTypes: s.agentTypes.map(t => (t.id === id ? { ...t, ...patch } : t)),
    })),
    addAgentType: () => dispatch(s => ({
      ...s,
      agentTypes: s.agentTypes.concat([{
        id: mkId('custom'),
        name: 'New agent', color: '#7FD1FF', model: '', tools: 0,
        desc: 'Custom agent type.', enabled: true, custom: true, env: '',
      }]),
    })),
    deleteAgentType: id => dispatch(s => ({
      ...s,
      agentTypes: s.agentTypes.filter(t => t.id !== id),
    })),

    cycleCatalogPerm: id => dispatch(s => ({
      ...s,
      toolsCatalog: s.toolsCatalog.map(t => t.id === id
        ? { ...t, perm: PERM_ORDER[(PERM_ORDER.indexOf(t.perm) + 1) % PERM_ORDER.length] }
        : t),
    })),
  }), [dispatch, later, ctx])
}

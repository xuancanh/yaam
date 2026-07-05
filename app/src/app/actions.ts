// The application-wide action contract. Lives in the app composition layer (not
// the store) so domain modules can reference it without depending on the
// provider/composition root. Domain action slices are `Pick<ConductorActions, …>`.
import type {
  Addon, AddonPermission, AgentTemplate, AppState, BoardCol, BoardTask, ChatAgentType, Cron,
  McpServer, Notification, Panel, Persona, Skill, SkillRegistry, View,
} from '../core/types'
import type { TaskSpecDraft } from '../domains/board/watcher'

export interface ConductorActions {
  setView: (v: View) => void
  setComposer: (v: string) => void
  send: () => void
  focusComposer: () => void
  setActivePane: (i: number) => void
  focusTab: (id: string) => void
  setPaneLayout: (n: number, stacked?: boolean) => void
  assignPane: (i: number, id: string) => void
  closePane: (i: number) => void
  toggleMaximize: (i: number) => void
  minimizePane: (i: number) => void
  restoreSession: (id: string) => void
  setRowSplit: (v: number) => void
  setColSplit: (row: number, v: number) => void
  /** display an existing tab group in the workspace grid */
  activateGroup: (id: string) => void
  /** dissolve a tab group; its sessions return to loose tabs */
  closeGroup: (id: string) => void
  renameSession: (id: string, name: string) => void
  archiveSession: (id: string) => void
  unarchiveSession: (id: string) => void
  deleteSession: (id: string) => void
  startTask: (taskId: string) => void
  /** detach a dead session from a task and spawn a fresh one-shot for it */
  restartTask: (taskId: string) => void
  resume: (id: string) => void
  openPanel: (id: string, tab?: Panel['tab']) => void
  setPanelTab: (tab: Panel['tab']) => void
  closePanel: () => void
  toggleMem: (aid: string, mid: string) => void
  toggleTool: (aid: string, tid: string) => void
  cyclePerm: (aid: string, tid: string) => void
  toggleCron: (id: string) => void
  cycleCatalogPerm: (id: string) => void
  approve: (aid: string) => void
  answerPrompt: (aid: string, num: number) => void
  deny: (aid: string) => void
  gotoNeeds: () => void
  openPalette: () => void
  closePalette: () => void
  setPaletteQuery: (q: string) => void
  toggleNotif: () => void
  readAllNotif: () => void
  clickNotif: (n: Notification) => void
  openAgent: (id: string) => void
  openDiff: (id: string) => void
  closeDrawer: () => void
  approveDiff: (id: string) => void
  requestChanges: (id: string) => void
  /** MCP servers (chat agents call their tools) */
  addMcpServer: (name: string, url: string, headers?: string) => void
  updateMcpServer: (id: string, patch: Partial<Pick<McpServer, 'name' | 'url' | 'headers' | 'enabled'>>) => void
  removeMcpServer: (id: string) => void
  /** (re)connect and cache the server's tool list; resolves to error or '' */
  connectMcpServer: (id: string) => Promise<string>
  /** skills registry (local) */
  addSkill: () => string
  updateSkill: (id: string, patch: Partial<Pick<Skill, 'name' | 'description' | 'body'>>) => void
  removeSkill: (id: string) => void
  /** personas (picked per chat) */
  addPersona: () => string
  updatePersona: (id: string, patch: Partial<Pick<Persona, 'name' | 'description' | 'body'>>) => void
  removePersona: (id: string) => void
  /** skill registries (github tree URLs or local folders of SKILL.md dirs) */
  addSkillRegistry: (name: string, url: string) => void
  updateSkillRegistry: (id: string, patch: Partial<Pick<SkillRegistry, 'name' | 'url' | 'enabled'>>) => void
  removeSkillRegistry: (id: string) => void
  /** (re)fetch a registry's catalog; resolves to '' or an error message */
  refreshSkillRegistry: (id: string) => Promise<string>
  /** chat-agent types (provider + model + credentials presets) */
  addChatAgentType: () => void
  updateChatAgentType: (id: string, patch: Partial<Omit<ChatAgentType, 'id'>>) => void
  deleteChatAgentType: (id: string) => void
  /** chat-mode sessions */
  newChatSession: (name?: string, cwd?: string, chatTypeId?: string, model?: string, personaId?: string, skillSourceIds?: string[]) => string
  /** open a chat in the Chat view */
  openChat: (id: string | null) => void
  sendChatMessage: (agentId: string, text: string) => void
  toggleAgentType: (id: string) => void
  toggleSetting: (k: 'autoRoute' | 'approveDestructive' | 'followMode') => void
  /** approve (once) or deny a Master tool blocked on the Ask-first policy */
  resolveToolApproval: (id: string, approve: boolean) => void
  updateSettings: (patch: Partial<AppState['settings']>) => void
  setAgentTypeCmd: (id: string, cmd: string) => void
  updateAgentType: (id: string, patch: Partial<AppState['agentTypes'][number]>) => void
  addAgentType: () => void
  deleteAgentType: (id: string) => void
  startCardDrag: (id: string) => void
  enterCol: (col: BoardCol) => void
  dropTo: (col: BoardCol) => void
  createTask: (input: { title: string; description: string; criteria: string[]; templateId?: string; typeId?: string; cwd?: string }) => void
  updateTask: (id: string, patch: Partial<Pick<BoardTask, 'title' | 'description' | 'criteria' | 'templateId' | 'typeId' | 'cwd'>>) => void
  sendTaskChat: (taskId: string, text: string) => void
  /** LLM assist for task creation; null when no brain is configured */
  draftTask: (input: { title: string; description: string; criteria: string[] }) => Promise<TaskSpecDraft | null>
  renameTask: (id: string, title: string) => void
  deleteTask: (id: string) => void
  addCron: (cron: Omit<Cron, 'id' | 'on' | 'built' | 'last'>) => void
  addTemplate: () => string
  updateTemplate: (id: string, patch: Partial<AgentTemplate>) => void
  deleteTemplate: (id: string) => void
  runTemplate: (id: string, task?: string) => void
  scheduleTask: (taskId: string, at: number | null, templateId?: string | null) => void
  deleteCron: (id: string) => void
  openAddon: (id: string) => void
  removeAddon: (id: string) => void
  toggleAddon: (id: string) => void
  toggleAddonGrant: (id: string, perm: AddonPermission) => void
  installAddonFromFile: () => void
  /** install a multi-file addon folder (addon.yaml/json + referenced files) */
  installAddonFromFolder: () => void
  /** LLM-generate an addon from a description; resolves to '' or an error message */
  generateAddon: (prompt: string) => Promise<string>
  installAddonFromUrl: (url: string) => void
  exportAddon: (id: string) => void
  sendAddonChat: (id: string, text: string) => void
  addonRpc: (addonId: string, method: string, args: unknown[]) => Promise<unknown>
  updateAddonMeta: (id: string, patch: Partial<Pick<Addon, 'name' | 'version' | 'icon' | 'desc' | 'author'>>) => void
  switchWorkspace: (id: string) => void
  createWorkspace: (name: string) => void
  renameWorkspace: (id: string, name: string) => void
  deleteWorkspace: (id: string) => void
  openNewSession: () => void
  closeNewSession: () => void
  newRealSession: (command: string, cwd: string, terminalShell?: string) => void
  sendInput: (id: string, text: string) => void
  stopSession: (id: string) => void
}

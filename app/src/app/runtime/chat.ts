// Chat + boot: MCP/skill integrations, the chat runtime, chat log + search
// indexer, the persistence save-side runtime with hydration/boot, and the
// per-session teardown that fans out to terminal/settle/monitor/chat. Sets
// startIntegrationsRef. A plain factory with a start/dispose lifecycle (persistence
// subscriptions, search indexing, and the one-shot hydration boot);
// Plain factory — composed by createAppRuntime.
import { dispatch, useAppStore } from '../../core/store'
import { type StatePort } from '../../core/ports'
import { disposeTerminal } from '../../core/terminals'
import { createChatRuntime } from '../../domains/chat/chat-runtime'
import type { ChatRuntime } from '../../domains/chat/chat-runtime'
import { createIntegrationRuntime } from '../../domains/settings/integrations'
import type { IntegrationRuntime } from '../../domains/settings/integrations'
import { createChatLog } from '../../domains/chat/log'
import { createChatSearchIndexer } from '../../domains/chat/search-indexer'
import { runHydration } from '../../infrastructure/persistence/hydrate-effect'
import { createPersistenceRuntime } from '../../infrastructure/persistence/runtime'
import type { ConductorKernel } from '../conductor-runtime'
import type { RuntimeRefs } from './refs'
import type { SessionRuntime } from './session'
import type { WindowRole } from '../../core/window-role'

export interface ChatBoot {
  connectMcp: IntegrationRuntime['connectMcp']
  refreshSkillCatalog: IntegrationRuntime['refreshSkillCatalog']
  mcpSessions: IntegrationRuntime['mcpSessions']
  skillCatalogs: IntegrationRuntime['skillCatalogs']
  runChatMessage: ChatRuntime['run']
  stopChatMessage: ChatRuntime['stop']
  retryChatMessage: ChatRuntime['retry']
  replayChatMessage: ChatRuntime['replay']
  resetChatRuntime: ChatRuntime['dispose']
  resolveChatApproval: ChatRuntime['resolveApproval']
  compactChatContext: ChatRuntime['compact']
  disposeSessionRuntime: (id: string) => void
  /** start persistence + search indexing + the one-shot hydration boot */
  start: () => void
  /** stop persistence + search indexing */
  dispose: () => void
}

export function createChatBoot(k: ConductorKernel, refs: RuntimeRefs, session: SessionRuntime, role: WindowRole = { kind: 'main' }): ChatBoot {
  const isMain = role.kind === 'main'
  const { stateRef, flash, notify } = k
  const { startIntegrationsRef, taskSessionsRef } = refs
  const state: StatePort = { get: () => stateRef.current, update: dispatch, subscribe: l => useAppStore.subscribe(l) }

  const persistence = createPersistenceRuntime(
    { getState: useAppStore.getState, subscribe: useAppStore.subscribe },
    { onToast: msg => dispatch(s => ({ ...s, toast: msg })) },
  )
  const { mcpSessions, skillCatalogs, connectMcp, refreshSkillCatalog } = createIntegrationRuntime(state)
  const { updateChatLog, pushChatLog } = createChatLog()
  const searchIndexer = createChatSearchIndexer(state)

  const chat = createChatRuntime({
    stateRef, dispatch, mcpSessions, skillCatalogs, pushChatLog, updateChatLog, flash, notify, refreshSkillCatalog,
  })

  const disposeSessionRuntime = (id: string) => {
    disposeTerminal(id)
    session.disposeSettle(id)
    session.disposeMonitor(id)
    chat.dispose(id)
    taskSessionsRef.current.delete(id)
  }

  startIntegrationsRef.current = () => {
    for (const srv of stateRef.current.mcpServers) if (srv.enabled) void connectMcp(srv.id)
    for (const reg of stateRef.current.skillRegistries) if (reg.enabled) void refreshSkillCatalog(reg.id)
  }

  let booted = false
  return {
    connectMcp, refreshSkillCatalog, mcpSessions, skillCatalogs,
    runChatMessage: chat.run, stopChatMessage: chat.stop,
    retryChatMessage: chat.retry, resetChatRuntime: chat.dispose,
    replayChatMessage: chat.replay,
    resolveChatApproval: chat.resolveApproval,
    compactChatContext: chat.compact,
    disposeSessionRuntime,
    start() {
      // Satellite windows never own persistence, the search index, or the
      // integration (MCP/skill) starts — the main window is the single owner.
      // They still hydrate so the pinned workspace renders from disk.
      if (isMain) { persistence.start(); searchIndexer.start() }
      if (!booted) {
        booted = true
        runHydration({
          stateRef, persistence, startIntegrations: isMain ? () => startIntegrationsRef.current() : () => {},
          appendTail: session.appendTail, clearNeeds: session.clearNeeds,
          bumpSettle: session.bumpSettle, armResponseWatch: session.armResponseWatch,
        })
      }
    },
    dispose() { if (isMain) { persistence.dispose(); searchIndexer.dispose() } },
  }
}

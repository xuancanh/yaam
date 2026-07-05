// Chat + boot: MCP/skill integrations, the chat runtime, chat log + search
// indexer, the persistence save-side runtime with hydration/boot, and the
// per-session teardown that fans out to terminal/settle/monitor/chat. Sets
// startIntegrationsRef. Depends on the session runtime for the attention/settle
// helpers hydration replays and the monitor/settle disposers teardown calls.
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { dispatch, useAppStore } from '../../core/store'
import { disposeTerminal } from '../../core/terminals'
import { createChatRuntime } from '../../domains/chat/chat-runtime'
import type { ChatRuntime } from '../../domains/chat/chat-runtime'
import { useIntegrationRuntime } from '../../domains/settings/integrations'
import type { IntegrationRuntime } from '../../domains/settings/integrations'
import { useChatLog } from '../../domains/chat/log'
import { useChatSearchIndexer } from '../../domains/chat/search-indexer'
import { useHydration } from '../../infrastructure/persistence/hydrate-effect'
import { createPersistenceRuntime } from '../../infrastructure/persistence/runtime'
import type { PersistenceRuntime } from '../../infrastructure/persistence/runtime'
import type { ConductorKernel } from '../conductor-runtime'
import type { RuntimeRefs } from './refs'
import type { SessionRuntime } from './session'

export interface ChatBoot {
  connectMcp: IntegrationRuntime['connectMcp']
  refreshSkillCatalog: IntegrationRuntime['refreshSkillCatalog']
  mcpSessions: IntegrationRuntime['mcpSessions']
  skillCatalogs: IntegrationRuntime['skillCatalogs']
  runChatMessage: ChatRuntime['run']
  disposeSessionRuntime: (id: string) => void
}

export function useChatBoot(k: ConductorKernel, refs: RuntimeRefs, session: SessionRuntime): ChatBoot {
  const { stateRef, flash } = k
  const { startIntegrationsRef, taskSessionsRef } = refs

  // persistence save-side runtime + boot/hydration
  const persistenceRef = useRef<PersistenceRuntime | undefined>(undefined)
  if (!persistenceRef.current) {
    persistenceRef.current = createPersistenceRuntime(
      { getState: useAppStore.getState, subscribe: useAppStore.subscribe },
      { onToast: msg => dispatch(s => ({ ...s, toast: msg })) },
    )
  }
  const persistence = persistenceRef.current
  useHydration(useMemo(() => ({
    stateRef, persistence, startIntegrations: () => startIntegrationsRef.current(),
    appendTail: session.appendTail, clearNeeds: session.clearNeeds, bumpSettle: session.bumpSettle, armResponseWatch: session.armResponseWatch,
  }), [stateRef, persistence, startIntegrationsRef, session.appendTail, session.clearNeeds, session.bumpSettle, session.armResponseWatch]))
  useEffect(() => {
    persistence.start()
    return () => persistence.dispose()
  }, [persistence])

  const chatRef = useRef<ChatRuntime>(undefined)
  const { mcpSessions, skillCatalogs, connectMcp, refreshSkillCatalog } = useIntegrationRuntime(stateRef)
  const disposeSessionRuntime = useCallback((id: string) => {
    disposeTerminal(id)
    session.disposeSettle(id)
    session.disposeMonitor(id)
    chatRef.current!.dispose(id)
    taskSessionsRef.current.delete(id)
  }, [session, taskSessionsRef])
  const { updateChatLog, pushChatLog } = useChatLog()
  useChatSearchIndexer(stateRef)
  startIntegrationsRef.current = () => {
    for (const srv of stateRef.current.mcpServers) if (srv.enabled) void connectMcp(srv.id)
    for (const reg of stateRef.current.skillRegistries) if (reg.enabled) void refreshSkillCatalog(reg.id)
  }
  if (!chatRef.current) {
    chatRef.current = createChatRuntime({
      stateRef, dispatch, mcpSessions, skillCatalogs, pushChatLog, updateChatLog, flash, refreshSkillCatalog,
    })
  }

  return { connectMcp, refreshSkillCatalog, mcpSessions, skillCatalogs, runChatMessage: chatRef.current.run, disposeSessionRuntime }
}

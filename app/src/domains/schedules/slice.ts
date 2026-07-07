// Schedule domain AppState slice. Imports only entity types (never core/types).
import type { Cron, AgentTemplate } from '../../core/entities'

/** Cron schedules and the agent templates they launch. */
export interface ScheduleSlice {
  crons: Cron[]
  templates: AgentTemplate[]
}

/** Initial schedule slice: no crons, two starter one-shot templates. */
export function freshScheduleSlice(): ScheduleSlice {
  return {
    crons: [],
    templates: [
      {
        id: 'tpl-claude-oneshot', name: 'claude-one-shot', typeId: 'claude', mode: 'ephemeral' as const,
        prompt: '{task}', systemPrompt: '', model: '', approval: 'edits' as const,
        cwd: '', extraArgs: '', autoArchive: false,
      },
      {
        id: 'tpl-codex-oneshot', name: 'codex-one-shot', typeId: 'codex', mode: 'ephemeral' as const,
        prompt: '{task}', systemPrompt: '', model: '', approval: 'edits' as const,
        cwd: '', extraArgs: '', autoArchive: false,
      },
    ],
  }
}

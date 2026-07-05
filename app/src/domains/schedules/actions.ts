// Schedules-domain actions: agent-template CRUD + launch, and cron schedule
// create/delete. Composed into the provider's action surface.
import { useMemo } from 'react'
import type { AppState, EventType } from '../../core/types'
import { mkId } from '../../core/state-lib'
import type { ConductorActions } from '../../store'

export interface SchedulesActionsCtx {
  dispatch: (f: (s: AppState) => AppState) => void
  flash: (t: string) => void
  logEvent: (type: EventType, agentId: string | null, text: string) => void
  launchFromTemplate: (templateId: string, task?: string) => string | null
}

type SchedulesActions = Pick<ConductorActions,
  'addTemplate' | 'updateTemplate' | 'deleteTemplate' | 'runTemplate' | 'addCron' | 'deleteCron'>

export function useSchedulesActions(ctx: SchedulesActionsCtx): SchedulesActions {
  const { dispatch } = ctx
  return useMemo(() => ({
    addTemplate: () => {
      const id = mkId('tpl')
      dispatch(s => ({
        ...s,
        templates: (s.templates ?? []).concat([{
          id, name: `template-${(s.templates ?? []).length + 1}`,
          typeId: s.agentTypes.find(t => t.enabled)?.id ?? 'claude',
          mode: 'ephemeral', prompt: '{task}', systemPrompt: '', model: '',
          approval: 'edits', cwd: '', extraArgs: '', autoArchive: false,
        }]),
      }))
      return id
    },
    updateTemplate: (id, patch) => dispatch(s => ({
      ...s,
      templates: (s.templates ?? []).map(t => t.id === id ? { ...t, ...patch } : t),
    })),
    deleteTemplate: id => dispatch(s => ({
      ...s,
      templates: (s.templates ?? []).filter(t => t.id !== id),
      tasks: s.tasks.map(t => t.templateId === id ? { ...t, templateId: undefined } : t),
      crons: s.crons.map(c => c.templateId === id ? { ...c, templateId: undefined } : c),
    })),
    runTemplate: (id, task) => {
      const lid = ctx.launchFromTemplate(id, task)
      if (lid) ctx.flash('Session launched from template')
    },

    addCron: cron => {
      dispatch(s => ({
        ...s,
        crons: s.crons.concat([{ ...cron, id: mkId('c'), on: true, built: false, last: '—' }]),
      }))
      ctx.flash('Schedule created')
      ctx.logEvent('cron', null, `Created schedule ${cron.name}`)
    },
    deleteCron: id => dispatch(s => ({ ...s, crons: s.crons.filter(c => c.id !== id) })),
  }), [dispatch, ctx])
}

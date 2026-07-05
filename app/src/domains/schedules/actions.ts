// Schedules-domain actions: agent-template CRUD + launch, and cron schedule
// create/delete. Composed into the provider's action surface.
import { useMemo } from 'react'
import type { AgentTemplate, AppState, Cron, EventType } from '../../core/types'
import { mkId } from '../../shared/id'

export interface SchedulesActionsCtx {
  dispatch: (f: (s: AppState) => AppState) => void
  flash: (t: string) => void
  logEvent: (type: EventType, agentId: string | null, text: string) => void
  launchFromTemplate: (templateId: string, task?: string) => string | null
  /** application command registry entry point (routes schedule toggle/remove) */
  execCommand?: <R = unknown>(name: string, input: unknown, ctx: { actor: { kind: 'user' } }) => Promise<R>
}

export interface SchedulesActions {
  addTemplate: () => string
  updateTemplate: (id: string, patch: Partial<AgentTemplate>) => void
  deleteTemplate: (id: string) => void
  runTemplate: (id: string, task?: string) => void
  addCron: (cron: Omit<Cron, 'id' | 'on' | 'built' | 'last'>) => void
  deleteCron: (id: string) => void
  toggleCron: (id: string) => void
}

export function useSchedulesActions(ctx: SchedulesActionsCtx): SchedulesActions {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => createSchedulesActions(ctx), [ctx.dispatch, ctx.flash, ctx.logEvent, ctx.launchFromTemplate, ctx.execCommand])
}

/** Plain (non-React) factory for the schedules/template actions. */
export function createSchedulesActions(ctx: SchedulesActionsCtx): SchedulesActions {
  const { dispatch } = ctx
  return {
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
    deleteCron: id => {
      if (ctx.execCommand) void ctx.execCommand('remove_schedule', { id }, { actor: { kind: 'user' } })
      else dispatch(s => ({ ...s, crons: s.crons.filter(c => c.id !== id) }))
    },
    toggleCron: id => {
      if (ctx.execCommand) void ctx.execCommand('toggle_schedule', { id }, { actor: { kind: 'user' } })
      else dispatch(s => ({ ...s, crons: s.crons.map(c => (c.id === id ? { ...c, on: !c.on } : c)) }))
    },
  }
}

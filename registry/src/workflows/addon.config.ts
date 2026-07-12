import { defineAddon } from 'yaam-addon'

export default defineAddon({
  name: 'Workflows',
  version: '3.1.0',
  icon: '⛓',
  description: 'Task workflows as state machines — every step is a board-task spec with on-done / on-fail transitions, so runs branch into remediation steps, loop back for visit-capped retries, and halt where you choose. Workflow list with pass rates and pause toggles, drag-and-drop canvas editor with labeled transitions, cron triggers, and a run history you can replay on the canvas.',
  author: 'yaam',
  permissions: ['state:read', 'tasks', 'schedules', 'storage', 'ui'],
  view: 'index.html',
  hooks: {
    onTaskMoved: 'src/hooks/onTaskMoved.ts',
    onCronFired: 'src/hooks/onCronFired.ts',
  },
})

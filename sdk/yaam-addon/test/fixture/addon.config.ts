import { defineAddon } from 'yaam-addon'

export default defineAddon({
  name: 'Fixture Addon',
  version: '1.0.0',
  icon: '🧪',
  description: 'End-to-end build fixture for the yaam-addon toolchain tests.',
  permissions: ['state:read', 'storage', 'ui', 'tasks'],
  view: 'index.html',
  hooks: {
    onCronFired: 'src/hooks/onCronFired.ts',
  },
  tools: [
    {
      name: 'count_tasks',
      description: 'Count board tasks per column.',
      input: { col: 'string · optional column filter' },
      handler: 'src/tools/count-tasks.ts',
    },
  ],
  agent: {
    system: 'agent.md',
    on: ['onCronFired'],
  },
})

import { defineAddon } from 'yaam-addon'

export default defineAddon({
  name: 'Usage-Limit Rescheduler',
  version: '1.0.1',
  icon: '⏳',
  description: "When a board task fails because the CLI hit an API usage or rate limit, this addon's monitor agent reads the failure, figures out when the limit resets (from the session output, or the Anthropic usage API if you store an admin key), and automatically reschedules the task for right after the reset.",
  author: 'yaam',
  hosts: ['api.anthropic.com'],
  secrets: [
    { name: 'ANTHROPIC_ADMIN_KEY', label: 'Anthropic admin API key (optional — lets the agent query the usage API for exact reset times)' },
  ],
  permissions: ['state:read', 'tasks', 'schedules', 'storage', 'ui', 'http', 'secrets', 'agent'],
  view: 'index.html',
  hooks: {
    onCronFired: 'src/hooks/onCronFired.ts',
  },
  agent: {
    system: 'prompts/agent.md',
    on: ['onTaskMoved'],
  },
})

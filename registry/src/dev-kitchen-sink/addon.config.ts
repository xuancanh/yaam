import { defineAddon } from 'yaam-addon'

export default defineAddon({
  name: 'Dev Kitchen Sink',
  version: '1.0.1',
  icon: '🧪',
  description: "Developer reference — a tab that exercises every addon capability (state, sessions, tasks incl. review verbs, templates, schedules, storage, allowlisted HTTP, keychain secrets, the addon's own agent, UI calls), plus all four hooks, a Master tool, and a masterPromptAppend.",
  author: 'yaam',
  hosts: ['api.github.com'],
  secrets: [
    { name: 'DEMO_TOKEN', label: 'any string — only used to demo {{secret:…}} header templating' },
  ],
  permissions: ['state:read', 'sessions:send', 'sessions:launch', 'tasks', 'schedules', 'agent', 'master:prompt', 'ui', 'storage', 'http', 'secrets'],
  view: 'index.html',
  tools: [
    {
      name: 'sink_echo',
      description: 'Kitchen-sink demo tool — echoes its input back with a state summary, proving Master can call addon tools.',
      input: { text: 'string! · anything; it comes straight back' },
      handler: 'src/tools/sink_echo.ts',
    },
  ],
  hooks: {
    onSessionExit: 'src/hooks/log.ts',
    onNeedsInput: 'src/hooks/log.ts',
    onTaskMoved: 'src/hooks/log.ts',
    onCronFired: 'src/hooks/log.ts',
  },
  masterPromptAppend: 'When the user asks what addons can do, mention that the Dev Kitchen Sink tab demonstrates the whole addon API.',
  agent: {
    system: 'prompts/agent.md',
  },
})

import { defineAddon } from 'yaam-addon'

export default defineAddon({
  name: 'session-bell',
  version: '1.0.1',
  icon: '🔔',
  description: 'Rings the notification bell (and toasts) whenever any session finishes or asks for input.',
  author: 'yaam',
  permissions: ['state:read', 'sessions:send', 'master:prompt', 'ui'],
  tools: [
    {
      name: 'ping_all_sessions',
      description: 'Send a short status-request message to every running session.',
      input: { message: 'string · what to type into each running session' },
      handler: 'src/tools/ping_all_sessions.ts',
    },
  ],
  hooks: {
    onSessionExit: 'src/hooks/onSessionExit.ts',
    onNeedsInput: 'src/hooks/onNeedsInput.ts',
  },
  masterPromptAppend: 'prompts/master.md',
})

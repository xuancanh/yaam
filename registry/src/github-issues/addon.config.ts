import { defineAddon } from 'yaam-addon'

export default defineAddon({
  name: 'GitHub Issues',
  version: '2.2.0',
  icon: '🐙',
  description: 'A GitHub issue triage inbox — sync open issues from any number of repos on a schedule, spawn linked board tasks (or let the addon\'s customizable triage agent decide), track their progress, and optionally close the issue on GitHub when the task is done. Token stays in the OS keychain.',
  author: 'yaam',
  hosts: ['api.github.com'],
  secrets: [
    { name: 'GITHUB_TOKEN', label: 'GitHub personal access token (repo scope; optional for public repos, required to close issues)' },
  ],
  permissions: ['state:read', 'tasks', 'schedules', 'storage', 'ui', 'http', 'secrets', 'agent'],
  view: 'index.html',
  hooks: {
    onCronFired: 'src/hooks/onCronFired.ts',
    onTaskMoved: 'src/hooks/onTaskMoved.ts',
  },
  // the triage agent — auto mode hands new issues to it; refine its policy in
  // the addon's Customize chat (e.g. "only bugs", "skip anything labelled docs")
  agent: {
    system: 'prompts/agent.md',
  },
})

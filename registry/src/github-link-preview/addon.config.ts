import { defineAddon } from 'yaam-addon'

// herdr-style link preview: ⌘/Ctrl-click a GitHub pull request or issue link in
// any terminal and it opens in a panel docked beside that session.
export default defineAddon({
  name: 'github-link-preview',
  version: '1.0.0',
  minAppVersion: '0.11.0',
  icon: '🔗',
  description: 'Cmd/Ctrl-click a GitHub pull request or issue link in a terminal to preview it in a panel beside the session: status, checks, diff size, description and latest comments. Hold Alt to open the browser instead.',
  author: 'yaam',
  hosts: ['api.github.com'],
  secrets: [
    { name: 'GITHUB_TOKEN', label: 'GitHub token (optional for public repos; needed for private ones and higher rate limits)' },
  ],
  permissions: ['ui', 'http', 'secrets', 'storage'],
  view: 'index.html',
  contributes: {
    panel: { title: 'GitHub' },
    links: [
      { pattern: '^https://github\\.com/[^/]+/[^/]+/(pull|issues)/\\d+', open: 'panel' },
    ],
    commands: [
      { id: 'open', title: 'GitHub: open link preview panel', open: 'panel', context: 'session' },
    ],
  },
})

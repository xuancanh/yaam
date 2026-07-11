import { defineAddon } from 'yaam-addon'

export default defineAddon({
  name: 'cost-pulse',
  version: '1.0.1',
  icon: '💠',
  description: 'Live per-session spend as a bar chart tab.',
  author: 'yaam',
  permissions: ['state:read'],
  view: 'index.html',
})

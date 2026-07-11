import { defineAddon } from 'yaam-addon'

export default defineAddon({
  name: 'kanban-lite',
  version: '1.0.1',
  icon: '🗂',
  description: 'The built-in kanban board rebuilt entirely as an addon: drag & drop, add/rename/delete tasks, spawn sessions for cards.',
  author: 'yaam',
  permissions: ['state:read', 'tasks', 'ui'],
  view: 'index.html',
})

// Runtime mirrors of the host's permission tables (app/src/core/addons.ts).
// test/api-compat.test.ts deep-compares them against the app at test time.
import type { AddonPermission } from './types.js'

/** Every grantable scope, with the label the host shows next to it. */
export const ALL_PERMISSIONS: { id: AddonPermission; label: string }[] = [
  { id: 'state:read', label: 'read app state (sessions + their output, tasks, templates, schedules)' },
  { id: 'sessions:send', label: 'type into / stop sessions' },
  { id: 'sessions:launch', label: 'launch new sessions (incl. templates)' },
  { id: 'tasks', label: 'manage board tasks (spec, spawning, watcher chat)' },
  { id: 'schedules', label: 'create / toggle / remove schedules' },
  { id: 'agent', label: "wake the addon's own LLM agent (spends API tokens)" },
  { id: 'master:prompt', label: "append directives to Master's system prompt" },
  { id: 'ui', label: 'notifications, toasts, focus, activity log' },
  { id: 'storage', label: 'private key-value storage' },
  { id: 'http', label: 'call HTTP APIs on the hosts the package declares' },
  { id: 'secrets', label: 'use its keychain secrets in those HTTP calls' },
  { id: 'exec', label: 'run shell commands on this machine (plugin hooks)' },
]

/** Scopes that can act on the machine or steer LLMs — never auto-granted on
 *  install; the user turns them on per-addon. */
export const DANGEROUS_PERMISSIONS: AddonPermission[] = [
  'sessions:send', 'sessions:launch', 'tasks', 'schedules', 'agent', 'master:prompt', 'http', 'secrets', 'exec',
]

/** Which permission each dotted API method requires. */
export const METHOD_PERMISSION: Record<string, AddonPermission> = {
  getState: 'state:read',
  sendToSession: 'sessions:send',
  launchSession: 'sessions:launch',
  focusSession: 'ui',
  focusTask: 'ui',
  flash: 'ui',
  logEvent: 'ui',
  notify: 'ui',
  'sessions.readOutput': 'state:read', 'sessions.stop': 'sessions:send',
  'tasks.add': 'tasks', 'tasks.update': 'tasks', 'tasks.rename': 'tasks', 'tasks.move': 'tasks',
  'tasks.remove': 'tasks', 'tasks.start': 'tasks', 'tasks.restart': 'tasks', 'tasks.chat': 'tasks',
  'tasks.get': 'state:read', 'tasks.approve': 'tasks', 'tasks.reject': 'tasks',
  'templates.list': 'state:read', 'templates.run': 'sessions:launch',
  'schedules.add': 'schedules', 'schedules.toggle': 'schedules', 'schedules.remove': 'schedules',
  'agent.wake': 'agent',
  'storage.get': 'storage', 'storage.set': 'storage', 'storage.list': 'storage', 'storage.remove': 'storage',
  'http.request': 'http',
  'secrets.list': 'secrets',
  exec: 'exec',
}

/** Every RPC-callable dotted method name — exactly the keys of METHOD_PERMISSION
 *  (the host-compat test fails if either table drifts). */
export const ADDON_RPC_METHODS: string[] = Object.keys(METHOD_PERMISSION)

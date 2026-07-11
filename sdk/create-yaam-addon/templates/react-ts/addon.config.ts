import { defineAddon } from 'yaam-addon'

export default defineAddon({
  name: '__ADDON_NAME__',
  version: '0.1.0',
  icon: '__ICON__',
  description: 'One line on what this addon does — it is the install-time pitch.',
  author: 'you',

  // request ONLY the scopes your code calls — extra scopes scare users away.
  // dangerous scopes (tasks, http, …) start ungranted: design for denial.
  permissions: ['state:read', 'storage', 'ui'],

  view: 'index.html',

  // outbound HTTP (https only, exact hosts or *.suffix wildcards) + keychain
  // secret slots usable as {{secret:NAME}} in http.request headers/body:
  // hosts: ['api.example.com'],
  // secrets: [{ name: 'EXAMPLE_TOKEN', label: 'what the user should paste here' }],

  // lifecycle hooks — TypeScript modules whose default export is the handler:
  // hooks: {
  //   onTaskMoved: 'src/hooks/onTaskMoved.ts',
  //   onCronFired: 'src/hooks/onCronFired.ts',
  // },

  // tools Master can call:
  // tools: [{
  //   name: 'my_tool',
  //   description: 'what it does, for the model',
  //   input: { query: 'string! · what to look for' },
  //   handler: 'src/tools/my-tool.ts',
  // }],

  // the addon's own LLM agent:
  // agent: { system: 'prompts/agent.md', on: ['onTaskMoved'], every: '*/30 * * * *' },
})

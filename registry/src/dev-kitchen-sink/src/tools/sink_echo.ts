import type { ToolHandler } from '@yaam/addon-sdk'

const handler: ToolHandler = async (input, api) => {
// A Master tool handler: (input, api) => string. Master sees the returned
// string as the tool result. Prove we can both read input and touch the api.
const state = api.getState()
const summary = state
  ? `${state.sessions.length} session(s), ${state.tasks.length} task(s), $${state.totals.cost} spent`
  : 'state:read not granted'
return `echo: ${String(input.text)} — app right now: ${summary}`
}

export default handler

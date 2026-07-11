import type { ToolHandler } from '@yaam/addon-sdk'

const handler: ToolHandler<{ col?: string }> = (input, api) => {
  const tasks = api.getState().tasks
  return input.col ? tasks.filter(t => t.col === input.col).length : tasks.length
}

export default handler

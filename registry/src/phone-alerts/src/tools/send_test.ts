import type { ToolHandler } from '@yaam/addon-sdk'
import { loadConfig, sendAlert } from '../send'

const handler: ToolHandler = async (_input, api) => {
  const cfg = await loadConfig(api)
  return sendAlert(api, cfg, 'YAAM test alert', 'If you can read this on your phone, alerts work.')
}

export default handler

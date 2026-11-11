import type { HookHandler } from '@yaam/addon-sdk'
import { loadConfig, muted, sendAlert } from '../send'

const handler: HookHandler<'onNeedsInput'> = async (input, api) => {
  const cfg = await loadConfig(api)
  if (!cfg.needsInput || muted(cfg)) return
  await sendAlert(api, cfg, `${input.name} needs you`, String(input.question || 'waiting for input'), true)
}

export default handler

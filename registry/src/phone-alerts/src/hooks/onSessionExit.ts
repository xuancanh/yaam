import type { HookHandler } from '@yaam/addon-sdk'
import { loadConfig, muted, sendAlert } from '../send'

const handler: HookHandler<'onSessionExit'> = async (input, api) => {
  const cfg = await loadConfig(api)
  if (muted(cfg)) return
  const failed = input.code !== 0
  if (failed ? !cfg.failed : !cfg.finished) return
  await sendAlert(api, cfg,
    failed ? `${input.name} failed` : `${input.name} finished`,
    failed ? `exited with code ${input.code}` : 'the session finished its run', failed)
}

export default handler

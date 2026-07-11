import type { HookHandler } from '@yaam/addon-sdk'
import { slug } from '../shared/ids'

const handler: HookHandler<'onCronFired'> = async (input, api) => {
  const tag = slug(input.name)
  await api.storage.set(`last-${tag}`, Date.now())
  await api.flash(`fired: ${tag}`)
  return tag
}

export default handler

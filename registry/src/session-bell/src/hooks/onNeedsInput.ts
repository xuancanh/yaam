import type { HookHandler } from '@yaam/addon-sdk'

const handler: HookHandler<'onNeedsInput'> = async (input, api) => {
api.flash(`${input.name} is waiting: ${String(input.question).slice(0, 40)}`);
}

export default handler

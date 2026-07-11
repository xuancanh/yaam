import type { HookHandler } from '@yaam/addon-sdk'

const handler: HookHandler<'onSessionExit'> = async (input, api) => {
api.notify(`${input.name} exited`, input.code === 0 ? 'finished cleanly' : `exit code ${input.code}`); api.flash(`${input.name} done`);
}

export default handler

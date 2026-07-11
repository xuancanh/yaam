import type { ToolHandler } from '@yaam/addon-sdk'

const handler: ToolHandler = async (input, api) => {
const state = api.getState(); const msg = input.message || 'status?'; let n = 0; for (const s of state.sessions) { if (s.status === 'running') { api.sendToSession(s.id, msg); n++; } } return `pinged ${n} running session(s)`;
}

export default handler

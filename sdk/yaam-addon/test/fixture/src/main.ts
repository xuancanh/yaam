import { yaam } from '@yaam/addon-sdk'
import { esc } from '@yaam/addon-sdk/dom'

const root = document.getElementById('root')!
yaam().onState(state => {
  root.innerHTML = state
    ? `<b>${esc(state.workspace)}</b>: ${state.tasks.length} task(s)`
    : 'state:read not granted'
})

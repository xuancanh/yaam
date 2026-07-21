// SEC-2: Master's create_addon must not auto-grant dangerous scopes on a fresh
// install — Master reads untrusted terminal output, so a prompt-injected
// create_addon call must not mint a fully-privileged addon. Mirrors the
// installPackage/hydrate rule; upgrades keep the user's existing grants
// (intersected with what the new package requests).
import { describe, expect, it, vi, beforeEach } from 'vitest'

const captured = vi.hoisted(() => ({ exec: null as null | import('../../master').MasterExec }))

vi.mock('../../master', () => ({
  hasCreds: () => true,
  runMasterTurn: vi.fn(async (_getState: unknown, exec: import('../../master').MasterExec) => {
    captured.exec = exec
    return { text: '', thinking: '' }
  }),
}))
vi.mock('../../core/native', () => ({ isTauri: false, writeSession: vi.fn(), killSession: vi.fn() }))

import { runMasterLoop, type MasterCtx } from './runner'
import { seedState } from '../../core/data'
import type { Addon, AppState } from '../../core/types'

function makeCtx(state: AppState): MasterCtx & { stateRef: { current: AppState } } {
  const stateRef = { current: state }
  return {
    stateRef,
    dispatch: f => { stateRef.current = f(stateRef.current) },
    masterBusyRef: { current: false },
    masterQueued: { current: null },
    lastEventRef: { current: null },
    toolApprovalsRef: { current: new Set() },
    userStoppedRef: { current: new Set() },
    disposeAddon: () => {},
    launchSession: () => null,
    launchFromTemplate: () => null,
    armResponseWatch: () => {},
    sessionScreenTail: () => '',
    logEvent: () => {},
    flash: () => {},
    applyAgentStatus: () => {},
    setNeedsInput: () => {},
    makeAddonApi: (() => ({})) as unknown as MasterCtx['makeAddonApi'],
  }
}

const TOOLS = JSON.stringify([{ name: 'ping', description: 'p', handler: 'return 1' }])

async function execOf(ctx: MasterCtx) {
  await runMasterLoop(ctx)
  if (!captured.exec) throw new Error('runMasterTurn was not called')
  return captured.exec
}

describe('Master create_addon permission grants (SEC-2)', () => {
  beforeEach(() => { captured.exec = null })

  it('fresh addon: dangerous requested scopes are withheld, only safe ones granted', async () => {
    const ctx = makeCtx(seedState())
    const exec = await execOf(ctx)
    const result = exec.createAddon('Evil', '◆', '', undefined, TOOLS, undefined,
      JSON.stringify(['state:read', 'sessions:send', 'master:prompt', 'tasks']))

    const addon = ctx.stateRef.current.addons.find(a => a.name === 'Evil')
    expect(addon?.permissions).toEqual(['state:read', 'sessions:send', 'master:prompt', 'tasks'])
    expect(addon?.granted).toEqual(['state:read'])
    // the tool result must tell Master the dangerous scopes were withheld
    expect(result).toContain('withheld')
    expect(result).toContain('sessions:send')
    expect(result).toContain('master:prompt')
    expect(result).toContain('tasks')
  })

  it('fresh addon without an explicit permissions list gets only the non-dangerous defaults', async () => {
    const ctx = makeCtx(seedState())
    const exec = await execOf(ctx)
    exec.createAddon('Legacy', '◆', '', undefined, TOOLS)

    const addon = ctx.stateRef.current.addons.find(a => a.name === 'Legacy')
    expect(addon?.granted).toEqual(['state:read', 'ui', 'storage'])
  })

  it('upgrade: previously granted scopes survive, newly requested dangerous scopes stay ungranted', async () => {
    const state = seedState()
    const existing: Addon = {
      id: 'ad-1', name: 'Evil', version: '1.0.0', icon: '◆',
      permissions: ['state:read', 'tasks'],
      granted: ['state:read', 'tasks'], // the user manually granted `tasks`
      enabled: true, source: 'master', createdAt: 'x',
    }
    state.addons = [existing]
    const ctx = makeCtx(state)
    const exec = await execOf(ctx)
    const result = exec.createAddon('Evil', '◆', '', undefined, TOOLS, undefined,
      JSON.stringify(['state:read', 'tasks', 'sessions:send']))

    const addon = ctx.stateRef.current.addons.find(a => a.name === 'Evil')
    expect(addon?.id).toBe('ad-1')
    expect(addon?.granted).toEqual(['state:read', 'tasks'])
    expect(result).toContain('withheld')
    expect(result).toContain('sessions:send')
  })

  it('upgrade: grants dropped from the new request are revoked', async () => {
    const state = seedState()
    const existing: Addon = {
      id: 'ad-1', name: 'Evil', version: '1.0.0', icon: '◆',
      permissions: ['state:read', 'tasks'],
      granted: ['state:read', 'tasks'],
      enabled: true, source: 'master', createdAt: 'x',
    }
    state.addons = [existing]
    const ctx = makeCtx(state)
    const exec = await execOf(ctx)
    exec.createAddon('Evil', '◆', '', undefined, TOOLS, undefined,
      JSON.stringify(['state:read']))

    const addon = ctx.stateRef.current.addons.find(a => a.name === 'Evil')
    expect(addon?.granted).toEqual(['state:read'])
  })
})

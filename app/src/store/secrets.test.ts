import { describe, expect, it } from 'vitest'
import { secretEntries, redactSecrets, applyResolvedSecrets } from './secrets'
import type { AppState, MainPartition } from '../core/types'

function mkState(over: Partial<AppState> = {}): AppState {
  return {
    settings: { apiKey: 'sk-master' },
    chatAgentTypes: [{ id: 'ct1', apiKey: 'sk-chat' }, { id: 'ct2', apiKey: '' }],
    mcpServers: [{ id: 'm1', headers: 'Authorization: Bearer tok' }],
    ...over,
  } as unknown as AppState
}

describe('secretEntries', () => {
  it('lists master, per-chat-type, and per-mcp secrets', () => {
    expect(secretEntries(mkState())).toEqual([
      { account: 'master.apiKey', value: 'sk-master' },
      { account: 'github.token', value: '' },
      { account: 'chat.ct1.apiKey', value: 'sk-chat' },
      { account: 'chat.ct2.apiKey', value: '' },
      { account: 'mcp.m1.headers', value: 'Authorization: Bearer tok' },
    ])
  })
})

describe('redactSecrets', () => {
  const main = () => ({
    settings: { apiKey: 'sk-master' },
    chatAgentTypes: [{ id: 'ct1', apiKey: 'sk-chat' }],
    mcpServers: [{ id: 'm1', headers: 'Authorization: Bearer tok' }],
  } as unknown as MainPartition)

  it('blanks only the fields confirmed in the keychain', () => {
    const red = redactSecrets(main(), new Set(['master.apiKey', 'mcp.m1.headers']))
    expect(red.settings!.apiKey).toBe('')
    expect(red.mcpServers![0].headers).toBe('')
    expect(red.chatAgentTypes![0].apiKey).toBe('sk-chat') // not ready → kept
  })
  it('keeps everything plaintext when nothing is keychain-ready', () => {
    const red = redactSecrets(main(), new Set())
    expect(red.settings!.apiKey).toBe('sk-master')
    expect(red.mcpServers![0].headers).toBe('Authorization: Bearer tok')
  })
})

describe('applyResolvedSecrets', () => {
  it('fills empty fields from the keychain without overwriting present ones', () => {
    const s = mkState({ settings: { apiKey: '' } as AppState['settings'] })
    const next = applyResolvedSecrets(s, { 'master.apiKey': 'sk-restored', 'chat.ct1.apiKey': 'ignored' })
    expect(next.settings.apiKey).toBe('sk-restored')
    expect(next.chatAgentTypes[0].apiKey).toBe('sk-chat') // already present → untouched
  })
})

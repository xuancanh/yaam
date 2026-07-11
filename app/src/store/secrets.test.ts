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
      { account: 'remote.urlToken', value: '' },
      { account: 'chat.ct1.apiKey', value: 'sk-chat' },
      { account: 'chat.ct2.apiKey', value: '' },
      { account: 'mcp.m1.headers', value: 'Authorization: Bearer tok' },
    ])
  })
  it('includes per-brain-profile API keys', () => {
    const s = mkState({ settings: { apiKey: 'sk-master', brainProfiles: [{ id: 'bp1', apiKey: 'sk-profile' }] } as AppState['settings'] })
    expect(secretEntries(s)).toContainEqual({ account: 'brain.bp1.apiKey', value: 'sk-profile' })
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
  it('blanks brain-profile keys only when their account is ready', () => {
    const m = {
      settings: { apiKey: '', brainProfiles: [{ id: 'bp1', apiKey: 'sk-a' }, { id: 'bp2', apiKey: 'sk-b' }] },
    } as unknown as MainPartition
    const red = redactSecrets(m, new Set(['brain.bp1.apiKey']))
    expect(red.settings!.brainProfiles![0].apiKey).toBe('')
    expect(red.settings!.brainProfiles![1].apiKey).toBe('sk-b')
  })
})

describe('applyResolvedSecrets', () => {
  it('fills empty fields from the keychain without overwriting present ones', () => {
    const s = mkState({ settings: { apiKey: '' } as AppState['settings'] })
    const next = applyResolvedSecrets(s, { 'master.apiKey': 'sk-restored', 'chat.ct1.apiKey': 'ignored' })
    expect(next.settings.apiKey).toBe('sk-restored')
    expect(next.chatAgentTypes[0].apiKey).toBe('sk-chat') // already present → untouched
  })
  it('restores brain-profile keys into empty profiles only', () => {
    const s = mkState({ settings: { apiKey: 'sk-master', brainProfiles: [{ id: 'bp1', apiKey: '' }, { id: 'bp2', apiKey: 'sk-kept' }] } as AppState['settings'] })
    const next = applyResolvedSecrets(s, { 'brain.bp1.apiKey': 'sk-restored', 'brain.bp2.apiKey': 'ignored' })
    expect(next.settings.brainProfiles![0].apiKey).toBe('sk-restored')
    expect(next.settings.brainProfiles![1].apiKey).toBe('sk-kept')
  })

  it('redacts and restores remote bearer credentials', () => {
    const state = mkState({
      settings: {
        apiKey: 'sk-master', remoteToken: 'remote-url-token',
        remoteDevices: [{ id: 'phone-1', name: 'Phone', token: 'device-token', at: 1 }],
      } as AppState['settings'],
    })
    expect(secretEntries(state)).toEqual(expect.arrayContaining([
      { account: 'remote.urlToken', value: 'remote-url-token' },
      { account: 'remote.device.phone-1.token', value: 'device-token' },
    ]))

    const redacted = redactSecrets(state as unknown as MainPartition, new Set([
      'remote.urlToken', 'remote.device.phone-1.token',
    ]))
    expect(redacted.settings?.remoteToken).toBe('')
    expect(redacted.settings?.remoteDevices?.[0].token).toBe('')

    const restored = applyResolvedSecrets(redacted as AppState, {
      'remote.urlToken': 'restored-url-token',
      'remote.device.phone-1.token': 'restored-device-token',
    })
    expect(restored.settings.remoteToken).toBe('restored-url-token')
    expect(restored.settings.remoteDevices?.[0].token).toBe('restored-device-token')
  })
})

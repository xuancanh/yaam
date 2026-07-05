import { describe, expect, it } from 'vitest'
import { translateHooksToAddon } from './plugin-market'
import { parseAddonPackage } from '../../core/addons'

const cfg = {
  hooks: {
    Stop: [{ hooks: [{ type: 'command', command: './scripts/on-stop.sh' }] }],
    SessionEnd: [{ hooks: [{ type: 'command', command: 'notify-send done' }] }],
    Notification: [{ matcher: '*', hooks: [{ type: 'command', command: './scripts/ping.sh' }] }],
    PreToolUse: [{ hooks: [{ type: 'command', command: './scripts/guard.sh' }] }],
  },
}

describe('translateHooksToAddon', () => {
  it('maps Stop/SessionEnd → onSessionExit and Notification → onNeedsInput; reports the rest', () => {
    const { addonJson, unmapped } = translateHooksToAddon('my-plugin', cfg)
    expect(unmapped).toEqual(['PreToolUse'])
    const addon = JSON.parse(addonJson!) as { name: string; permissions: string[]; hooks: Record<string, string> }
    expect(addon.name).toBe('my-plugin hooks')
    expect(addon.permissions).toEqual(['exec', 'ui'])
    expect(Object.keys(addon.hooks).sort()).toEqual(['onNeedsInput', 'onSessionExit'])
    // both exit-family commands land in the same hook body, run via api.exec
    expect(addon.hooks.onSessionExit).toContain('./scripts/on-stop.sh')
    expect(addon.hooks.onSessionExit).toContain('notify-send done')
    expect(addon.hooks.onSessionExit).toContain('api.exec')
    expect(addon.hooks.onSessionExit).toContain('YAAM_HOOK_EVENT')
  })

  it('produces a package the addon validator accepts, with exec requested (never auto-granted)', () => {
    const { addonJson } = translateHooksToAddon('qa-gate', cfg)
    const parsed = parseAddonPackage(addonJson!)
    expect(parsed.permissions).toContain('exec')
    expect(parsed.hooks?.onSessionExit).toBeTruthy()
  })

  it('returns null when nothing maps (no fake addon for empty configs)', () => {
    expect(translateHooksToAddon('x', { hooks: {} }).addonJson).toBeNull()
    expect(translateHooksToAddon('x', {}).addonJson).toBeNull()
    const only = translateHooksToAddon('x', { hooks: { PreToolUse: cfg.hooks.PreToolUse } })
    expect(only.addonJson).toBeNull()
    expect(only.unmapped).toEqual(['PreToolUse'])
  })
})

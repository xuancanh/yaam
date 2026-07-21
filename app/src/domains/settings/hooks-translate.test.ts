import { describe, expect, it, vi } from 'vitest'
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

  it('binds the hook event as `input` (the sandbox handler argument), not `event`', () => {
    const { addonJson } = translateHooksToAddon('my-plugin', cfg)
    const addon = JSON.parse(addonJson!) as { hooks: Record<string, string> }
    for (const body of Object.values(addon.hooks)) {
      expect(body).toContain('JSON.stringify(input)')
      expect(body).not.toMatch(/\bevent\b/)
    }
  })

  it('generates a body that actually runs against the sandbox (input, api) binding', async () => {
    const { addonJson } = translateHooksToAddon('my-plugin', cfg)
    const addon = JSON.parse(addonJson!) as { hooks: Record<string, string> }
    const exec = vi.fn(async (_cmd: string) => ({ code: 0, output: '' }))
    const logEvent = vi.fn()
    const api = { exec, logEvent }
    // compile the handler exactly the way the addon sandbox does
    // (addons/sandbox.ts): new Function('input', 'api', ...)
    const run = (source: string, input: unknown) =>
      (new Function('input', 'api', '"use strict"; return (async () => {\n' + source + '\n})();') as
        (i: unknown, a: unknown) => Promise<unknown>)(input, api)

    await run(addon.hooks.onSessionExit, { hook: 'Stop' })
    expect(exec).toHaveBeenCalledTimes(2)
    expect(exec.mock.calls[0][0]).toBe(`YAAM_HOOK_EVENT='${JSON.stringify({ hook: 'Stop' })}' ./scripts/on-stop.sh`)
    expect(exec.mock.calls[1][0]).toContain('notify-send done')
    expect(logEvent).not.toHaveBeenCalled()

    exec.mockClear()
    await run(addon.hooks.onNeedsInput, { message: 'hi' })
    expect(exec).toHaveBeenCalledTimes(1)
    expect(exec.mock.calls[0][0]).toContain('./scripts/ping.sh')

    // a failing command surfaces via logEvent instead of throwing
    exec.mockClear()
    exec.mockResolvedValueOnce({ code: 3, output: 'nope' })
    await run(addon.hooks.onNeedsInput, {})
    expect(logEvent).toHaveBeenCalledWith(expect.stringContaining('exited 3'))
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

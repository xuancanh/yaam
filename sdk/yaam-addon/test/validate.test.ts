import { describe, expect, it } from 'vitest'
import { checkViewSize, scanHandlerPermissions, validateConfig } from '../src/validate'

const base = {
  name: 'X',
  version: '1.0.0',
  description: 'd',
  permissions: ['state:read'] as const,
  view: 'index.html',
}

describe('validateConfig', () => {
  it('accepts a minimal valid config', () => {
    const issues = validateConfig({ ...base, permissions: ['state:read'] })
    expect(issues.filter(i => i.level === 'error')).toEqual([])
  })

  it('accepts a dotted minAppVersion and rejects a malformed one', () => {
    expect(validateConfig({ ...base, minAppVersion: '0.7.0' }).filter(i => i.level === 'error')).toEqual([])
    const bad = validateConfig({ ...base, minAppVersion: 'next' }).filter(i => i.level === 'error')
    expect(bad.some(i => i.message.includes('minAppVersion'))).toBe(true)
  })

  it('requires name, version, and some capability', () => {
    const issues = validateConfig({ name: '', version: '' })
    const msgs = issues.filter(i => i.level === 'error').map(i => i.message)
    expect(msgs.some(m => m.includes('"name"'))).toBe(true)
    expect(msgs.some(m => m.includes('"version"'))).toBe(true)
    expect(msgs.some(m => m.includes('no view, tools, hooks, or agent'))).toBe(true)
  })

  it('rejects unknown permissions, bad hosts, bad secret names, bad cron', () => {
    const issues = validateConfig({
      ...base,
      permissions: ['nope' as never],
      hosts: ['https://api.github.com'],
      secrets: ['BAD NAME'],
      agent: { system: 'x', every: 'not cron' },
    })
    const errs = issues.filter(i => i.level === 'error').map(i => i.message)
    expect(errs.some(m => m.includes('unknown permission "nope"'))).toBe(true)
    expect(errs.some(m => m.includes('host "https://api.github.com"'))).toBe(true)
    expect(errs.some(m => m.includes('secret name "BAD NAME"'))).toBe(true)
    expect(errs.some(m => m.includes('5-field cron'))).toBe(true)
  })

  it('warns on hosts/secrets/agent without their permissions', () => {
    const issues = validateConfig({
      ...base,
      permissions: ['state:read'],
      hosts: ['api.github.com'],
      secrets: ['TOKEN'],
      agent: { system: 'agent.md' },
    })
    const warns = issues.filter(i => i.level === 'warning').map(i => i.message)
    expect(warns.some(m => m.includes('"http" permission'))).toBe(true)
    expect(warns.some(m => m.includes('"secrets" permission'))).toBe(true)
    expect(warns.some(m => m.includes('"agent" permission'))).toBe(true)
  })
})

describe('scanHandlerPermissions', () => {
  it('flags api calls whose permission is undeclared', () => {
    const src = 'await api.tasks.add("x"); await api.flash("y"); api.getState()'
    const issues = scanHandlerPermissions(src, ['state:read'])
    const msgs = issues.map(i => i.message)
    expect(msgs.some(m => m.includes('api.tasks.add') && m.includes('"tasks"'))).toBe(true)
    expect(msgs.some(m => m.includes('api.flash') && m.includes('"ui"'))).toBe(true)
    expect(msgs.some(m => m.includes('getState'))).toBe(false)
  })

  it('is quiet when everything is declared', () => {
    expect(scanHandlerPermissions('await api.storage.set("k", 1)', ['storage'])).toEqual([])
  })
})

describe('checkViewSize', () => {
  it('passes small, warns big, errors huge', () => {
    expect(checkViewSize('x'.repeat(10_000))).toEqual([])
    expect(checkViewSize('x'.repeat(800 * 1024))[0]?.level).toBe('warning')
    expect(checkViewSize('x'.repeat(1600 * 1024))[0]?.level).toBe('error')
  })
})

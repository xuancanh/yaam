import { describe, expect, it } from 'vitest'
import { eventKey, matchLink, normalizeKey, parseContributes } from './addon-contributes'
import { parseAddonPackage, parseSimpleYaml } from './addons'

const opts = { toolNames: ['summarize'], hasView: true }

describe('normalizeKey', () => {
  it('normalizes modifier names and order', () => {
    expect(normalizeKey('Shift+Cmd+G')).toBe('mod+shift+g')
    expect(normalizeKey('mod+option+y')).toBe('mod+alt+y')
  })
  it('rejects bare mod combos, missing mod, and app-reserved keys', () => {
    expect(normalizeKey('mod+g')).toBeNull()
    expect(normalizeKey('alt+g')).toBeNull()
    expect(normalizeKey('mod+shift+a')).toBeNull()
    expect(normalizeKey('mod+alt+enter')).toBeNull()
  })
})

describe('eventKey', () => {
  it('reads the physical key so ⌥ symbols still match', () => {
    expect(eventKey({ metaKey: true, ctrlKey: false, altKey: true, shiftKey: false, key: '©', code: 'KeyG' }, true)).toBe('mod+alt+g')
    expect(eventKey({ metaKey: false, ctrlKey: true, altKey: true, shiftKey: false, key: 'g', code: 'KeyG' }, true)).toBeNull()
  })
})

describe('parseContributes', () => {
  it('accepts a panel, commands and links', () => {
    const c = parseContributes({
      panel: { title: 'PR' },
      commands: [{ id: 'sum', title: 'Summarize', run: 'summarize', key: 'mod+alt+s', context: 'session' }],
      links: [{ pattern: 'github\\.com/.+/pull/\\d+', open: 'panel' }],
    }, opts)
    expect(c?.panel?.title).toBe('PR')
    expect(c?.commands?.[0]).toEqual({ id: 'sum', title: 'Summarize', run: 'summarize', key: 'mod+alt+s', context: 'session' })
    expect(c?.links?.[0].open).toBe('panel')
  })
  it('rejects unknown tools, views it does not have, bad regexes and bad keys', () => {
    expect(() => parseContributes({ commands: [{ id: 'x', title: 'X', run: 'nope' }] }, opts)).toThrow(/not one of this addon's tools/)
    expect(() => parseContributes({ panel: { title: 'P' } }, { toolNames: [], hasView: false })).toThrow(/needs the addon to have a view/)
    expect(() => parseContributes({ links: [{ pattern: '(', run: 'summarize' }] }, opts)).toThrow(/bad pattern/)
    expect(() => parseContributes({ commands: [{ id: 'x', title: 'X', open: 'popup', key: 'mod+k' }] }, opts)).toThrow(/key/)
    expect(() => parseContributes({ commands: [{ id: 'x', title: 'X' }] }, opts)).toThrow(/needs run/)
  })
})

describe('matchLink', () => {
  const addons = [
    { id: 'a', contributes: { links: [{ pattern: '^https://github\\.com/[^/]+/[^/]+/pull/\\d+', open: 'panel' as const }] } },
    { id: 'b', contributes: { links: [{ pattern: 'github\\.com', run: 't' }] } },
  ]
  it('returns the first addon whose pattern matches', () => {
    expect(matchLink(addons, 'https://github.com/o/r/pull/4')?.addon.id).toBe('a')
    expect(matchLink(addons, 'https://github.com/o/r')?.addon.id).toBe('b')
    expect(matchLink(addons, 'https://example.com')).toBeNull()
  })
})

it('folder manifests carry contributes through the YAML subset', () => {
  const raw = parseSimpleYaml([
    'name: PR panel',
    'contributes:',
    '  panel:',
    '    title: Pull request',
    '  links:',
    '    - pattern: "github\\.com/.+/pull/\\d+"',
    '      open: panel',
  ].join('\n'))
  const pkg = parseAddonPackage(JSON.stringify({ ...raw, html: '<p>hi</p>' }))
  expect(pkg.contributes?.panel?.title).toBe('Pull request')
  expect(pkg.contributes?.links?.[0].pattern).toBe('github\\.com/.+/pull/\\d+')
})

describe('shipped registry addons', () => {
  const files = import.meta.glob('../../../registry/packages/{github-link-preview,phone-alerts}.yaam.json', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
  it.each(['github-link-preview', 'phone-alerts'])('%s parses with valid contributions', name => {
    const json = Object.entries(files).find(([k]) => k.endsWith(`/${name}.yaam.json`))?.[1]
    expect(json).toBeTruthy()
    const pkg = parseAddonPackage(json!)
    expect(pkg.contributes).toBeDefined()
    if (name === 'github-link-preview') {
      expect(matchLink([{ id: 'g', contributes: pkg.contributes }], 'https://github.com/o/r/pull/12')).not.toBeNull()
      expect(matchLink([{ id: 'g', contributes: pkg.contributes }], 'https://github.com/o/r/blob/main/x')).toBeNull()
    }
  })
})

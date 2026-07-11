import { describe, expect, it } from 'vitest'
import { hostAllowed, inlineIncludes, parseAddonPackage, resolveSecretRefs } from './addons'

describe('hostAllowed', () => {
  const hosts = ['api.github.com', '*.example.com']

  it('allows an exact https host on the list', () => {
    expect(hostAllowed(hosts, 'https://api.github.com/repos/a/b/issues')).toBe(true)
  })

  it('rejects hosts not on the list', () => {
    expect(hostAllowed(hosts, 'https://evil.com/x')).toBe(false)
    expect(hostAllowed(hosts, 'https://api.github.com.evil.com/x')).toBe(false)
  })

  it('matches *.suffix wildcards including the bare domain', () => {
    expect(hostAllowed(hosts, 'https://a.example.com/')).toBe(true)
    expect(hostAllowed(hosts, 'https://deep.a.example.com/')).toBe(true)
    expect(hostAllowed(hosts, 'https://example.com/')).toBe(true)
    expect(hostAllowed(hosts, 'https://notexample.com/')).toBe(false)
  })

  it('requires https except for localhost', () => {
    expect(hostAllowed(['api.github.com'], 'http://api.github.com/')).toBe(false)
    expect(hostAllowed(['localhost'], 'http://localhost:3000/api')).toBe(true)
    expect(hostAllowed(['127.0.0.1'], 'http://127.0.0.1:8080/')).toBe(true)
  })

  it('rejects invalid URLs and empty allowlists', () => {
    expect(hostAllowed(hosts, 'not a url')).toBe(false)
    expect(hostAllowed(undefined, 'https://api.github.com/')).toBe(false)
    expect(hostAllowed([], 'https://api.github.com/')).toBe(false)
  })
})

describe('resolveSecretRefs', () => {
  const get = async (name: string) => (name === 'TOKEN' ? 'tok-123' : null)

  it('substitutes {{secret:NAME}} and leaves other text alone', async () => {
    expect(await resolveSecretRefs('Bearer {{secret:TOKEN}}', get)).toBe('Bearer tok-123')
    expect(await resolveSecretRefs('plain text', get)).toBe('plain text')
  })

  it('substitutes repeated references and tolerates inner spaces', async () => {
    expect(await resolveSecretRefs('{{secret:TOKEN}}/{{ secret:TOKEN }}', get)).toBe('tok-123/tok-123')
  })

  it('throws for an unset secret', async () => {
    await expect(resolveSecretRefs('x {{secret:MISSING}}', get)).rejects.toThrow(/MISSING/)
  })
})

describe('inlineIncludes', () => {
  const files: Record<string, string> = { 'lib/sdk.js': 'const yaam = 1', '../toolkit/ui.css': '.card{color:red}' }
  const read = async (p: string) => {
    if (!(p in files)) throw new Error('missing ' + p)
    return files[p]
  }

  it('inlines HTML-comment and CSS/JS-comment markers', async () => {
    const html = '<style>/* @include ../toolkit/ui.css */</style><script><!-- @include lib/sdk.js --></script>'
    expect(await inlineIncludes(html, read)).toBe('<style>.card{color:red}</style><script>const yaam = 1</script>')
  })

  it('leaves plain documents untouched and surfaces missing refs', async () => {
    expect(await inlineIncludes('<b>no includes</b>', read)).toBe('<b>no includes</b>')
    await expect(inlineIncludes('<!-- @include nope.js -->', read)).rejects.toThrow(/missing/)
  })
})

describe('parseAddonPackage — hosts / secrets / agent.every', () => {
  const base = { name: 'x', tools: [{ name: 't', handler: 'return "ok"' }] }

  it('parses hosts and secret declarations (string or object form)', () => {
    const p = parseAddonPackage(JSON.stringify({
      ...base,
      hosts: ['api.github.com', '*.example.com', 'bad host!'],
      secrets: ['TOKEN', { name: 'KEY', label: 'the key' }, { name: 'bad name' }],
    }))
    expect(p.hosts).toEqual(['api.github.com', '*.example.com'])
    expect(p.secrets).toEqual([{ name: 'TOKEN', label: undefined }, { name: 'KEY', label: 'the key' }])
  })

  it('omits hosts/secrets when absent', () => {
    const p = parseAddonPackage(JSON.stringify(base))
    expect(p.hosts).toBeUndefined()
    expect(p.secrets).toBeUndefined()
  })

  it('accepts a 5-field agent.every cron and rejects malformed ones', () => {
    const ok = parseAddonPackage(JSON.stringify({ ...base, agent: { system: 'watch things', every: '*/30 * * * *' } }))
    expect(ok.agent?.every).toBe('*/30 * * * *')
    expect(() => parseAddonPackage(JSON.stringify({ ...base, agent: { system: 'watch', every: 'hourly' } })))
      .toThrow(/agent\.every/)
    expect(() => parseAddonPackage(JSON.stringify({ ...base, agent: { system: 'watch', every: '99 25 * * *' } })))
      .toThrow(/agent\.every/)
  })
})

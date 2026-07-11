import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildAddon } from '../src/build.js'
import { compareVersions, publishAddon, securityDiff } from '../src/publish.js'

const FIXTURE = join(import.meta.dirname, 'fixture')
let built: string
let registry: string

beforeAll(async () => {
  built = await mkdtemp(join(tmpdir(), 'yaam-pub-built-'))
  registry = await mkdtemp(join(tmpdir(), 'yaam-pub-reg-'))
  await mkdir(join(registry, 'packages'), { recursive: true })
  await writeFile(join(registry, 'index.json'), JSON.stringify({
    registry: 1,
    packages: [
      { name: 'other', version: '1.0.0', url: 'https://raw.example.com/reg/packages/other.yaam.json' },
    ],
  }, null, 2))
  const res = await buildAddon(FIXTURE, { outDir: built })
  expect(res.issues.filter(i => i.level === 'error')).toEqual([])
}, 60_000)

afterAll(async () => {
  await rm(built, { recursive: true, force: true })
  await rm(registry, { recursive: true, force: true })
})

describe('publishAddon', () => {
  it('packs into the registry and indexes with the sibling url base', async () => {
    const s = await publishAddon(built, registry)
    expect(s.slug).toBe('fixture-addon')
    expect(s.prevVersion).toBeNull()
    expect(s.securityDiff[0]).toBe('(new package)')
    const index = JSON.parse(await readFile(join(registry, 'index.json'), 'utf8'))
    const entry = index.packages.find((p: { name: string }) => p.name === 'fixture-addon')
    expect(entry.version).toBe('1.0.0')
    expect(entry.url).toBe('https://raw.example.com/reg/packages/fixture-addon.yaam.json')
    const pack = JSON.parse(await readFile(join(registry, 'packages', 'fixture-addon.yaam.json'), 'utf8'))
    expect(pack.html).toContain('<script')
  })

  it('refuses to republish without a version bump', async () => {
    await expect(publishAddon(built, registry)).rejects.toThrow('must be greater than')
  })

  it('surfaces new scopes in the security diff on a bump', async () => {
    const manifest = JSON.parse(await readFile(join(built, 'addon.json'), 'utf8'))
    manifest.version = '1.1.0'
    manifest.permissions = [...manifest.permissions, 'http']
    manifest.hosts = ['api.github.com']
    await writeFile(join(built, 'addon.json'), JSON.stringify(manifest, null, 2))
    const s = await publishAddon(built, registry)
    expect(s.prevVersion).toBe('1.0.0')
    expect(s.securityDiff.join('\n')).toContain('+ permissions: http')
    expect(s.securityDiff.join('\n')).toContain('+ hosts: api.github.com')
  })
})

describe('compareVersions', () => {
  it('orders dotted versions numerically', () => {
    expect(compareVersions('2.0.0', '1.9.9')).toBeGreaterThan(0)
    expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('1.0', '1.0.1')).toBeLessThan(0)
  })
})

describe('securityDiff', () => {
  it('reports added and removed scopes', () => {
    const lines = securityDiff(
      { permissions: ['ui', 'exec'], secrets: [{ name: 'A' }] },
      { permissions: ['ui', 'http'], secrets: ['A', 'B'] },
    )
    expect(lines).toContain('+ permissions: http')
    expect(lines).toContain('- permissions: exec')
    expect(lines).toContain('+ secrets: B')
  })
})

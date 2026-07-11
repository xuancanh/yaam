// The real compatibility gate: feed the built fixture through the app's OWN
// folder loader + package parser. If the host changes its package format,
// this fails here instead of at install time.
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadAddonFolder, parseAddonPackage } from '../../../app/src/core/addons'
import { buildAddon } from '../src/build.js'
import { packAddon } from '../src/pack.js'

const FIXTURE = join(import.meta.dirname, 'fixture')
let out: string

beforeAll(async () => {
  out = await mkdtemp(join(tmpdir(), 'yaam-hostload-'))
  const res = await buildAddon(FIXTURE, { outDir: out })
  expect(res.issues.filter(i => i.level === 'error')).toEqual([])
}, 60_000)

afterAll(async () => {
  await rm(out, { recursive: true, force: true })
})

describe('app loader accepts the built output', () => {
  it('loadAddonFolder + parseAddonPackage round-trip the built folder', async () => {
    const manifestText = await readFile(join(out, 'addon.json'), 'utf8')
    const json = await loadAddonFolder(manifestText, rel => readFile(join(out, rel), 'utf8'))
    const parsed = parseAddonPackage(json)
    expect(parsed.name).toBe('Fixture Addon')
    expect(parsed.html).toContain('<script type="module">')
    expect(parsed.permissions).toEqual(['state:read', 'storage', 'ui', 'tasks'])
    expect(parsed.tools?.[0].name).toBe('count_tasks')
    expect(parsed.tools?.[0].input_schema).toMatchObject({ type: 'object' })
    expect(parsed.hooks?.onCronFired).toContain('__handler')
    expect(parsed.agent?.system).toContain('fixture addon')
    expect(parsed.agent?.on).toEqual(['onCronFired'])
  })

  it('parseAddonPackage accepts the packed .yaam.json directly', async () => {
    const target = join(out, '..', `hostload-${Date.now()}.yaam.json`)
    await packAddon(out, target)
    const parsed = parseAddonPackage(await readFile(target, 'utf8'))
    await rm(target, { force: true })
    expect(parsed.name).toBe('Fixture Addon')
    expect(parsed.hooks?.onCronFired).toContain('__handler')
  })
})

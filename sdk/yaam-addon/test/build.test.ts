// End-to-end: build the fixture project, run its compiled handlers the way
// the host sandbox does, and pack the result.
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildAddon } from '../src/build'
import { packAddon } from '../src/pack'
import { compileHandler } from '../src/handlers'
import type { BuildResult } from '../src/build'

const FIXTURE = join(import.meta.dirname, 'fixture')
let out: string
let res: BuildResult

beforeAll(async () => {
  out = await mkdtemp(join(tmpdir(), 'yaam-build-'))
  res = await buildAddon(FIXTURE, { outDir: out })
}, 60_000)

afterAll(async () => {
  await rm(out, { recursive: true, force: true })
})

/** Run compiled handler source exactly like the host sandbox bootstrap does. */
async function runHandler(source: string, input: unknown, api: unknown): Promise<unknown> {
  const fn = new Function('input', 'api', '"use strict"; return (async () => {\n' + source + '\n})();')
  return await fn(input, api)
}

describe('buildAddon (fixture project)', () => {
  it('builds without errors', () => {
    expect(res.issues.filter(i => i.level === 'error')).toEqual([])
    expect(res.files).toContain('addon.json')
    expect(res.files).toContain('view.html')
    expect(res.files).toContain('hooks/onCronFired.js')
    expect(res.files).toContain('tools/count_tasks.js')
    expect(res.files).toContain('prompts/agent.md')
  })

  it('emits a manifest the host folder-loader accepts', async () => {
    const manifest = JSON.parse(await readFile(join(out, 'addon.json'), 'utf8'))
    expect(manifest.name).toBe('Fixture Addon')
    expect(manifest.view).toBe('view.html')
    expect(manifest.hooks.onCronFired).toBe('hooks/onCronFired.js')
    expect(manifest.agent.system).toBe('prompts/agent.md')
    expect(manifest.permissions).toEqual(['state:read', 'storage', 'ui', 'tasks'])
    expect(manifest.tools[0]).toMatchObject({ name: 'count_tasks', handler: 'tools/count_tasks.js' })
    // shorthand expanded at build time — the single-file parser only reads input_schema
    expect(manifest.tools[0].input_schema).toEqual({
      type: 'object',
      properties: { col: { type: 'string', description: 'optional column filter' } },
    })
  })

  it('produces a self-contained single-file view', async () => {
    const html = await readFile(join(out, 'view.html'), 'utf8')
    expect(html).toContain('<script type="module">')
    expect(html).not.toMatch(/<script[^>]*\ssrc=/)
    expect(html).not.toMatch(/<link[^>]*stylesheet/)
    expect(html).toContain('yaam:call') // the bundled SDK bridge is inlined
  })

  it('compiled hook runs as a sandbox function body (imports bundled away)', async () => {
    const source = await readFile(join(out, 'hooks/onCronFired.js'), 'utf8')
    const stored: Record<string, unknown> = {}
    const flashes: string[] = []
    const api = {
      storage: { set: async (k: string, v: unknown) => { stored[k] = v } },
      flash: async (t: string) => { flashes.push(t) },
    }
    const outVal = await runHandler(source, { name: 'Nightly Sync', kind: 'task' }, api)
    expect(outVal).toBe('nightly-sync')
    expect(Object.keys(stored)).toEqual(['last-nightly-sync'])
    expect(flashes).toEqual(['fired: nightly-sync'])
  })

  it('compiled tool sees the sync getState snapshot', async () => {
    const source = await readFile(join(out, 'tools/count_tasks.js'), 'utf8')
    const api = { getState: () => ({ tasks: [{ col: 'done' }, { col: 'backlog' }, { col: 'done' }] }) }
    expect(await runHandler(source, { col: 'done' }, api)).toBe(2)
    expect(await runHandler(source, {}, api)).toBe(3)
  })

  it('packs into a single .yaam.json with everything inlined', async () => {
    const target = join(out, '..', `pack-test-${Date.now()}.yaam.json`)
    await packAddon(out, target)
    const packed = JSON.parse(await readFile(target, 'utf8'))
    await rm(target, { force: true })
    expect(packed.html).toContain('<script type="module">')
    expect(packed.view).toBeUndefined()
    expect(packed.hooks.onCronFired).toContain('__handler')
    expect(packed.tools[0].handler).toContain('__handler')
    expect(packed.agent.system).toContain('fixture addon')
  })
})

describe('compileHandler guard rails', () => {
  it('rejects node builtin imports', async () => {
    const bad = join(out, '..', `bad-${Date.now()}.ts`)
    const { writeFile } = await import('node:fs/promises')
    await writeFile(bad, 'import { readFile } from "node:fs/promises"\nexport default async () => readFile("x")\n')
    await expect(compileHandler(bad)).rejects.toThrow()
    await rm(bad, { force: true })
  })
})

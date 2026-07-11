// Every pack shipped in the repo registry must parse with the app's own
// package parser — guards the built artifacts, whatever produced them.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseAddonPackage } from '../../../app/src/core/addons'

const PKGS = join(import.meta.dirname, '..', '..', '..', 'registry', 'packages')
const packs = readdirSync(PKGS).filter(f => f.endsWith('.yaam.json'))

describe('registry packs parse with the host loader', () => {
  it('found the shipped packs', () => {
    expect(packs.length).toBeGreaterThanOrEqual(8)
  })

  for (const f of packs) {
    it(f, () => {
      const parsed = parseAddonPackage(readFileSync(join(PKGS, f), 'utf8'))
      expect(parsed.name.length).toBeGreaterThan(0)
      expect(parsed.permissions.length).toBeGreaterThan(0)
      expect(parsed.html || parsed.tools?.length || parsed.hooks || parsed.agent).toBeTruthy()
    })
  }
})

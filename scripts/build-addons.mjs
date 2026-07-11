#!/usr/bin/env node
// Rebuild every addon source project (registry/src/*) into its distributable
// forms: the folder-format addon in registry/packages/<slug>/ and the packed
// registry/packages/<slug>.yaam.json + index.json entry. Requires the SDK
// workspace to be built first:  (cd sdk && npm install && npm run build)
//   node scripts/build-addons.mjs [slug ...]
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import process from 'node:process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'registry', 'src')
const PKGS = join(ROOT, 'registry', 'packages')
const SDK = join(ROOT, 'sdk', 'yaam-addon', 'dist', 'index.js')

if (!existsSync(SDK)) {
  console.error('sdk not built — run: cd sdk && npm install && npm run build')
  process.exit(1)
}
const { buildAddon, publishAddon } = await import(pathToFileURL(SDK).href)

const wanted = process.argv.slice(2)
const slugs = readdirSync(SRC).filter(d => existsSync(join(SRC, d, 'addon.config.ts')))
  .filter(d => !wanted.length || wanted.includes(d))
if (!slugs.length) {
  console.error(`nothing to build under ${SRC}`)
  process.exit(1)
}

let failed = false
for (const slug of slugs) {
  const outDir = join(PKGS, slug)
  // built output is regenerated wholesale — keep no stale files behind
  rmSync(outDir, { recursive: true, force: true })
  const res = await buildAddon(join(SRC, slug), { outDir, minify: false })
  const errors = res.issues.filter(i => i.level === 'error')
  for (const i of res.issues) console.log(`  ${i.level === 'error' ? '✖' : '⚠'} ${slug}: ${i.message}`)
  if (errors.length) { failed = true; continue }
  const summary = await publishAddon(outDir, join(ROOT, 'registry'))
  console.log(`${slug} ${summary.prevVersion ? `${summary.prevVersion} → ` : ''}${summary.version} (${res.files.length} files)`)
  for (const l of summary.securityDiff) console.log(`    ${l}`)
}
process.exit(failed ? 1 : 0)

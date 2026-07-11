#!/usr/bin/env node
// Validate the addon registry: index.json ↔ packages/*.yaam.json integrity,
// manifest sanity, and (in CI, against a base ref) version monotonicity plus
// a loud security diff for review. No dependencies.
//   node scripts/validate-registry.mjs [--base <git-ref>]
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const REG = join(ROOT, 'registry')
const baseIdx = process.argv.indexOf('--base')
const BASE = baseIdx >= 0 ? process.argv[baseIdx + 1] : null

const PERMISSIONS = ['state:read', 'sessions:send', 'sessions:launch', 'tasks', 'schedules', 'agent', 'master:prompt', 'ui', 'storage', 'http', 'secrets', 'exec']
const HOST_RE = /^(\*\.)?[a-z0-9.-]+$/i
const SECRET_RE = /^[A-Za-z0-9_]+$/
const HOOKS = ['onSessionExit', 'onNeedsInput', 'onTaskMoved', 'onCronFired', 'masterPromptAppend']

let failed = false
const err = m => { failed = true; console.error(`✖ ${m}`) }
const info = m => console.log(`  ${m}`)

const cmpVer = (a, b) => {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0)
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return d
  }
  return 0
}
const names = list => new Set((list ?? []).map(x => (typeof x === 'string' ? x : x?.name)).filter(Boolean))

const index = JSON.parse(readFileSync(join(REG, 'index.json'), 'utf8'))
if (!Array.isArray(index.packages)) { err('index.json: no "packages" array'); process.exit(1) }

const seen = new Set()
for (const entry of index.packages) {
  const label = `index entry "${entry.name}"`
  if (!entry.name || seen.has(entry.name)) err(`${label}: missing or duplicate name`)
  seen.add(entry.name)
  if (!entry.version) err(`${label}: missing version`)
  if (typeof entry.url !== 'string' || !entry.url.endsWith(`${entry.name}.yaam.json`)) {
    err(`${label}: url must end with ${entry.name}.yaam.json`)
  }

  let pack
  try {
    pack = JSON.parse(readFileSync(join(REG, 'packages', `${entry.name}.yaam.json`), 'utf8'))
  } catch (e) {
    err(`${label}: packages/${entry.name}.yaam.json unreadable (${e.message})`)
    continue
  }
  if (pack.version !== entry.version) err(`${label}: version ${entry.version} ≠ package version ${pack.version}`)
  if (!pack.name) err(`${label}: package has no name`)
  if (!pack.html && !pack.tools?.length && !Object.values(pack.hooks ?? {}).some(Boolean) && !pack.agent) {
    err(`${label}: package ships no view, tools, hooks, or agent`)
  }
  for (const p of pack.permissions ?? []) if (!PERMISSIONS.includes(p)) err(`${label}: unknown permission "${p}"`)
  if (!Array.isArray(pack.permissions)) err(`${label}: no permissions array — legacy packages request EVERY scope`)
  for (const h of pack.hosts ?? []) if (!HOST_RE.test(String(h).trim())) err(`${label}: bad host "${h}"`)
  for (const s of names(pack.secrets)) if (!SECRET_RE.test(s)) err(`${label}: bad secret name "${s}"`)
  for (const k of Object.keys(pack.hooks ?? {})) if (!HOOKS.includes(k)) err(`${label}: unknown hook "${k}"`)

  // vs base ref: version must increase; surface the security diff for review
  if (BASE) {
    let prev = null
    try {
      prev = JSON.parse(execFileSync('git', ['show', `${BASE}:registry/packages/${entry.name}.yaam.json`], { cwd: ROOT, encoding: 'utf8' }))
    } catch { /* new package */ }
    if (prev) {
      const changed = JSON.stringify(prev) !== JSON.stringify(pack)
      if (changed && cmpVer(pack.version, prev.version) <= 0) {
        err(`${label}: changed but version ${pack.version} does not exceed ${prev.version} on ${BASE}`)
      }
      for (const key of ['permissions', 'hosts', 'secrets']) {
        const before = names(prev[key])
        const after = names(pack[key])
        const added = [...after].filter(x => !before.has(x))
        if (added.length) info(`⚠ ${entry.name}: NEW ${key}: ${added.join(', ')} — review carefully`)
      }
    } else {
      info(`new package: ${entry.name} ${pack.version} (permissions: ${(pack.permissions ?? ['ALL (legacy)']).join(', ')})`)
    }
  }
}

// orphan packs (packed but not indexed)
for (const f of readdirSync(join(REG, 'packages'))) {
  if (f.endsWith('.yaam.json') && !seen.has(f.replace(/\.yaam\.json$/, ''))) {
    err(`packages/${f} is not listed in index.json`)
  }
}

console.log(failed ? 'registry INVALID' : `registry ok — ${index.packages.length} package(s)`)
process.exit(failed ? 1 : 0)

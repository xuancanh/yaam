// The yaam-addon CLI: build / pack / dev / validate.
import { resolve } from 'node:path'
import { buildAddon } from './build.js'
import { packAddon } from './pack.js'
import { loadConfig } from './config.js'
import { validateConfig } from './validate.js'
import type { ValidationIssue } from './validate.js'

const HELP = `yaam-addon — build tool for YAAM addons

usage:
  yaam-addon build [dir] [--out <dir>] [--no-minify]   compile addon.config.ts + src into a folder-format addon (default dir: ., out: dist/)
  yaam-addon pack [builtDir] [--out <file>]            inline a built folder into a single .yaam.json
  yaam-addon dev [dir]                                 vite dev server for the view (browser + host stub, HMR)
  yaam-addon validate [dir]                            check addon.config.ts without building
`

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  if (i === -1) return undefined
  const v = args[i + 1]
  args.splice(i, 2)
  return v
}

function printIssues(issues: ValidationIssue[]): boolean {
  for (const i of issues) console.log(`  ${i.level === 'error' ? '✖' : '⚠'} ${i.message}`)
  return issues.some(i => i.level === 'error')
}

export async function main(argv: string[]): Promise<number> {
  const args = [...argv]
  const cmd = args.shift()

  if (cmd === 'build') {
    const noMinify = args.includes('--no-minify')
    if (noMinify) args.splice(args.indexOf('--no-minify'), 1)
    const out = flag(args, '--out')
    const dir = resolve(args[0] ?? '.')
    const res = await buildAddon(dir, { outDir: out, minify: !noMinify })
    const failed = printIssues(res.issues)
    if (failed) { console.error('build failed'); return 1 }
    console.log(`built ${res.files.length} file(s) → ${res.outDir}`)
    console.log('install: YAAM → Addons → Install from folder → ' + res.outDir)
    return 0
  }

  if (cmd === 'pack') {
    const out = flag(args, '--out')
    const dir = resolve(args[0] ?? 'dist')
    const target = await packAddon(dir, out)
    console.log(`packed → ${target}`)
    return 0
  }

  if (cmd === 'validate') {
    const dir = resolve(args[0] ?? '.')
    const cfg = await loadConfig(resolve(dir, 'addon.config.ts'))
    const failed = printIssues(validateConfig(cfg))
    console.log(failed ? 'invalid' : 'ok')
    return failed ? 1 : 0
  }

  if (cmd === 'publish') {
    const registry = flag(args, '--registry')
    const urlBase = flag(args, '--url-base')
    const dir = resolve(args[0] ?? 'dist')
    if (!registry) {
      console.error('usage: yaam-addon publish [builtDir] --registry <registry-checkout-dir> [--url-base <raw-url-prefix>]')
      return 1
    }
    const { publishAddon } = await import('./publish.js')
    const s = await publishAddon(dir, resolve(registry), { urlBase })
    console.log(`${s.name} ${s.prevVersion ? `${s.prevVersion} → ` : ''}${s.version}`)
    console.log(`  packed  ${s.packedFile}`)
    console.log(`  indexed ${resolve(registry, 'index.json')}`)
    if (s.securityDiff.length) {
      console.log('\nsecurity-relevant changes (put these in the PR description):')
      for (const l of s.securityDiff) console.log(`  ${l}`)
    }
    console.log('\nnow commit the registry changes and open a PR for review.')
    return 0
  }

  if (cmd === 'dev') {
    const dir = resolve(args[0] ?? '.')
    const cfg = await loadConfig(resolve(dir, 'addon.config.ts'))
    if (!cfg.view) { console.error('this addon has no view — nothing to dev-serve'); return 1 }
    const { createServer } = await import('vite')
    const server = await createServer({
      root: resolve(dir, cfg.view, '..'),
      server: { open: true },
    })
    await server.listen()
    server.printUrls()
    console.log('\nrunning against the @yaam/addon-sdk host stub (mock state).')
    console.log('for live data, dev-install the folder in YAAM instead: Addons → Install from folder.')
    await new Promise(() => {}) // stay up until Ctrl-C
  }

  console.log(HELP)
  return cmd && cmd !== 'help' && cmd !== '--help' ? 1 : 0
}

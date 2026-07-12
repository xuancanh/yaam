// addon.config.ts — the typed manifest a toolchain project authors instead of
// addon.yaml. Paths point at TypeScript sources; `yaam-addon build` compiles
// them into the plain folder-format addon the app installs.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build as esbuild } from 'esbuild'
import type { AddonHookName, AddonPermission } from '@yaam/addon-sdk'

export interface AddonConfigTool {
  name: string
  description?: string
  /** shorthand: `field: "string! · what it is"` */
  input?: Record<string, string>
  /** full JSON schema; wins over `input` */
  input_schema?: Record<string, unknown>
  /** path to the tool's TS/JS module (default export = handler) */
  handler: string
}

export interface AddonConfig {
  name: string
  version: string
  /** minimum YAAM app version this addon needs (semver); the host blocks
   *  installing it on older builds. Omit for no lower bound. */
  minAppVersion?: string
  icon?: string
  description?: string
  author?: string
  hosts?: string[]
  secrets?: (string | { name: string; label?: string })[]
  permissions?: AddonPermission[]
  /** path to the view's index.html (a normal Vite entry); omit for headless addons */
  view?: string
  tools?: AddonConfigTool[]
  /** hook name → path to its TS/JS module (default export = handler) */
  hooks?: Partial<Record<AddonHookName, string>>
  /** prompt fragment appended to Master's system prompt (text, or a .md/.txt path) */
  masterPromptAppend?: string
  agent?: {
    /** path to the system prompt (.md/.txt), or the prompt text itself */
    system: string
    on?: AddonHookName[]
    every?: string
  }
}

/** Identity helper that gives addon.config.ts its typing. */
export function defineAddon(config: AddonConfig): AddonConfig {
  return config
}

/** Bundle + import an addon.config.ts (or .js/.mjs) and return its default export. */
export async function loadConfig(configPath: string): Promise<AddonConfig> {
  const dir = await mkdtemp(join(tmpdir(), 'yaam-addon-'))
  try {
    // the config imports defineAddon (and maybe SDK types, which erase); alias
    // both packages to a tiny shim so loading a config never drags the real
    // build tool — or an unbuilt SDK — into the bundle
    const shim = join(dir, 'shim.mjs')
    await writeFile(shim, 'export const defineAddon = c => c\n')
    const out = join(dir, 'config.mjs')
    await esbuild({
      entryPoints: [configPath],
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node18',
      outfile: out,
      alias: { 'yaam-addon': shim, '@yaam/addon-sdk': shim },
      logLevel: 'silent',
    })
    await writeFile(join(dir, 'package.json'), '{"type":"module"}')
    const mod = await import(pathToFileURL(out).href) as { default?: AddonConfig }
    if (!mod.default || typeof mod.default !== 'object') {
      throw new Error(`${configPath} must default-export defineAddon({ ... })`)
    }
    return mod.default
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

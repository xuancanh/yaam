// `yaam-addon build`: addon.config.ts + src → a plain folder-format addon
// (addon.json manifest + self-contained view.html + compiled handler .js
// files) that the app's Install-from-folder loads directly and `pack` turns
// into a single .yaam.json.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { AddonConfig } from './config.js'
import { loadConfig } from './config.js'
import { compileHandler } from './handlers.js'
import { buildView } from './view.js'
import { checkViewSize, scanHandlerPermissions, validateConfig } from './validate.js'
import type { ValidationIssue } from './validate.js'

export interface BuildResult {
  outDir: string
  issues: ValidationIssue[]
  /** files written, project-relative */
  files: string[]
}

const PROMPT_FILE = /\.(md|txt)$/i
const SHORTHAND_TYPES = ['string', 'number', 'boolean', 'array', 'object']

/** Expand the `input` shorthand (`name: "string! · what it is"`) into a JSON
 *  schema at build time — the host's single-file package parser only reads
 *  input_schema, so the built manifest must carry the expanded form. */
export function expandInputShorthand(input: Record<string, string>): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const [key, spec] of Object.entries(input)) {
    const [head, ...rest] = String(spec).split(/\s*[·–-]\s+/)
    let type = head.trim()
    if (type.endsWith('!')) { required.push(key); type = type.slice(0, -1) }
    if (!SHORTHAND_TYPES.includes(type)) throw new Error(`tool input "${key}": unknown type "${type}" (use ${SHORTHAND_TYPES.join('|')}, append ! if required)`)
    properties[key] = {
      type,
      ...(type === 'array' ? { items: { type: 'string' } } : {}),
      ...(rest.length ? { description: rest.join(' ') } : {}),
    }
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}) }
}

/** Read `value` as a file when it looks like a path to a prompt file. */
async function promptText(projectDir: string, value: string): Promise<string> {
  if (!PROMPT_FILE.test(value.trim())) return value
  return await readFile(resolve(projectDir, value.trim()), 'utf8')
}

export async function buildAddon(projectDir: string, opts: { outDir?: string; minify?: boolean } = {}): Promise<BuildResult> {
  const configPath = join(projectDir, 'addon.config.ts')
  const cfg: AddonConfig = await loadConfig(configPath)
  const issues = validateConfig(cfg)
  if (issues.some(i => i.level === 'error')) return { outDir: '', issues, files: [] }

  const outDir = resolve(projectDir, opts.outDir ?? 'dist')
  await rm(outDir, { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })
  const files: string[] = []
  const emit = async (rel: string, content: string) => {
    const abs = join(outDir, rel)
    await mkdir(join(abs, '..'), { recursive: true })
    await writeFile(abs, content)
    files.push(rel)
  }

  // manifest skeleton — file references filled in as parts are compiled
  const manifest: Record<string, unknown> = {
    manifest: 3,
    name: cfg.name,
    version: cfg.version,
    ...(cfg.minAppVersion ? { minAppVersion: cfg.minAppVersion } : {}),
    ...(cfg.icon ? { icon: cfg.icon } : {}),
    ...(cfg.description ? { description: cfg.description } : {}),
    ...(cfg.author ? { author: cfg.author } : {}),
    ...(cfg.hosts?.length ? { hosts: cfg.hosts } : {}),
    ...(cfg.secrets?.length ? { secrets: cfg.secrets } : {}),
    ...(cfg.permissions ? { permissions: cfg.permissions } : {}),
  }

  if (cfg.view) {
    const html = await buildView(projectDir, cfg.view, { minify: opts.minify })
    issues.push(...checkViewSize(html))
    await emit('view.html', html)
    manifest.view = 'view.html'
  }

  const declared = cfg.permissions ?? []
  if (cfg.tools?.length) {
    const tools: Record<string, unknown>[] = []
    for (const t of cfg.tools) {
      const source = await readFile(resolve(projectDir, t.handler), 'utf8')
      issues.push(...prefix(`tool ${t.name}`, scanHandlerPermissions(source, declared)))
      const compiled = await compileHandler(resolve(projectDir, t.handler), { minify: opts.minify })
      const rel = `tools/${t.name.replace(/[^a-z0-9_]/gi, '_')}.js`
      await emit(rel, compiled)
      tools.push({
        name: t.name,
        ...(t.description ? { description: t.description } : {}),
        ...(t.input_schema ? { input_schema: t.input_schema } : t.input ? { input_schema: expandInputShorthand(t.input) } : {}),
        handler: rel,
      })
    }
    manifest.tools = tools
  }

  const hooks: Record<string, string> = {}
  for (const [hook, entry] of Object.entries(cfg.hooks ?? {})) {
    if (!entry) continue
    const source = await readFile(resolve(projectDir, entry), 'utf8')
    issues.push(...prefix(`hook ${hook}`, scanHandlerPermissions(source, declared)))
    const rel = `hooks/${hook}.js`
    await emit(rel, await compileHandler(resolve(projectDir, entry), { minify: opts.minify }))
    hooks[hook] = rel
  }
  if (cfg.masterPromptAppend) {
    // always a file reference — inline text that happens to end in ".md"
    // would trip the folder loader's file-ref detection
    const rel = 'hooks/masterPromptAppend.txt'
    await emit(rel, await promptText(projectDir, cfg.masterPromptAppend))
    hooks.masterPromptAppend = rel
  }
  if (Object.keys(hooks).length) manifest.hooks = hooks

  if (cfg.agent) {
    const rel = 'prompts/agent.md'
    await emit(rel, await promptText(projectDir, cfg.agent.system))
    manifest.agent = {
      system: rel,
      ...(cfg.agent.on?.length ? { on: cfg.agent.on } : {}),
      ...(cfg.agent.every ? { every: cfg.agent.every } : {}),
    }
  }

  await emit('addon.json', JSON.stringify(manifest, null, 2) + '\n')
  return { outDir, issues, files }
}

function prefix(label: string, issues: ValidationIssue[]): ValidationIssue[] {
  return issues.map(i => ({ ...i, message: `${label}: ${i.message}` }))
}

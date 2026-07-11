// `yaam-addon pack`: built folder (addon.json + files) → single-file
// *.yaam.json for URL/registry distribution. The build already produced a
// self-contained view and compiled handlers, so packing is just inlining the
// file references — the JSON-manifest subset of scripts/pack-addon.mjs.
import { readFile, writeFile } from 'node:fs/promises'
import { basename, join, normalize, resolve } from 'node:path'

const FILE_REF = /\.(js|html|txt|md)$/i

export async function packAddon(builtDir: string, outFile?: string): Promise<string> {
  const manifestText = await readFile(join(builtDir, 'addon.json'), 'utf8')
  const raw = JSON.parse(manifestText) as Record<string, unknown>

  const readRef = async (rel: string): Promise<string> => {
    const p = normalize(join(builtDir, rel))
    if (!p.startsWith(normalize(builtDir))) throw new Error(`file reference escapes the addon folder: ${rel}`)
    return await readFile(p, 'utf8')
  }
  const ref = async (v: unknown): Promise<unknown> =>
    typeof v === 'string' && v.trim() && FILE_REF.test(v.trim()) ? await readRef(v.trim()) : v

  const out: Record<string, unknown> = { ...raw }
  if (typeof raw.view === 'string') {
    out.html = await readRef(raw.view)
    delete out.view
  }
  if (Array.isArray(raw.tools)) {
    out.tools = await Promise.all((raw.tools as Record<string, unknown>[]).map(async t => ({
      ...t,
      handler: await ref(t.handler),
    })))
  }
  if (raw.hooks && typeof raw.hooks === 'object') {
    const hooks: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(raw.hooks as Record<string, unknown>)) hooks[k] = await ref(v)
    out.hooks = hooks
  }
  if (raw.agent && typeof raw.agent === 'object') {
    const a = raw.agent as Record<string, unknown>
    out.agent = { ...a, system: await ref(a.system) }
  }

  const slug = String(raw.name ?? basename(builtDir)).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const target = outFile ?? resolve(builtDir, '..', `${slug}.yaam.json`)
  await writeFile(target, JSON.stringify(out, null, 2) + '\n')
  return target
}

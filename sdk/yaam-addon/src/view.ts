// Build the view with Vite and collapse the output into ONE self-contained
// HTML file. The host renders views in a sandboxed iframe whose CSP denies
// every external request, so all JS/CSS/assets must be inline (small assets
// are already data:-inlined by assetsInlineLimit).
import { readFile, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { build as viteBuild } from 'vite'

/** Vite-build `indexHtml` (project-relative) and return the single-file HTML. */
export async function buildView(projectDir: string, indexHtml: string, opts: { minify?: boolean } = {}): Promise<string> {
  const entryAbs = resolve(projectDir, indexHtml)
  const outDir = join(projectDir, 'node_modules', '.yaam-addon', 'view')
  await rm(outDir, { recursive: true, force: true })

  await viteBuild({
    root: dirname(entryAbs),
    logLevel: 'warn',
    configFile: await findViteConfig(projectDir),
    // one React only — file:-linked SDKs otherwise drag in a second copy,
    // which crashes hooks at runtime ("Cannot read properties of null")
    resolve: { dedupe: ['react', 'react-dom'] },
    build: {
      outDir,
      emptyOutDir: true,
      minify: opts.minify ?? true,
      cssCodeSplit: false,
      assetsInlineLimit: 1024 * 1024 * 100, // data:-inline every referenced asset
      modulePreload: { polyfill: false },
      rollupOptions: {
        input: entryAbs,
        // one chunk, so the inliner produces one <script> (rolldown option)
        output: { codeSplitting: false } as Record<string, unknown>,
      },
    },
  })

  const html = await readFile(join(outDir, 'index.html'), 'utf8')
  return await inlineBuiltHtml(html, outDir)
}

async function findViteConfig(projectDir: string): Promise<string | false> {
  for (const name of ['vite.config.ts', 'vite.config.js', 'vite.config.mjs']) {
    try {
      await readFile(join(projectDir, name))
      return join(projectDir, name)
    } catch { /* try next */ }
  }
  return false
}

/** Replace every `<script src>` / stylesheet `<link>` in built HTML with the
 *  file's contents; strip modulepreload hints. Exported for tests. */
export async function inlineBuiltHtml(html: string, outDir: string): Promise<string> {
  const read = (href: string) => readFile(join(outDir, href.replace(/^\.?\//, '')), 'utf8')

  const scripts = [...html.matchAll(/<script([^>]*?)\ssrc="([^"]+)"([^>]*)><\/script>/g)]
  for (const m of scripts) {
    const body = await read(m[2])
    const attrs = `${m[1]} ${m[3]}`.includes('type="module"') ? ' type="module"' : ''
    html = html.replace(m[0], () => `<script${attrs}>\n${sanitizeInlineScript(body)}\n</script>`)
  }

  const links = [...html.matchAll(/<link[^>]*?rel="stylesheet"[^>]*?href="([^"]+)"[^>]*?>/g)]
  for (const m of links) {
    const body = await read(m[1])
    html = html.replace(m[0], () => `<style>\n${body}\n</style>`)
  }

  html = html.replace(/<link[^>]*?rel="modulepreload"[^>]*?>/g, '')
  return html
}

/** `</script>` inside a JS string literal would terminate the inline tag. */
function sanitizeInlineScript(js: string): string {
  return js.replace(/<\/script>/gi, '<\\/script>')
}

// Compile one tool/hook module into the sandbox's handler form. The host runs
// handler source as the body of `new Function('input', 'api', ...)` wrapped in
// an async IIFE — so the build target is a *function body*: statements that may
// use `await`, see `input` and `api`, and `return` the result. We bundle the
// module (imports disappear at build time; the sandbox has none) to CommonJS
// and invoke its default export.
import { build as esbuild } from 'esbuild'

/** Bundle `entry` and wrap it so its default export runs as the handler. */
export async function compileHandler(entry: string, opts: { minify?: boolean } = {}): Promise<string> {
  const result = await esbuild({
    entryPoints: [entry],
    bundle: true,
    format: 'cjs',
    platform: 'neutral',
    // neutral platform + no externals: anything unresolvable (node builtins,
    // random npm packages with node deps) fails the build here instead of
    // exploding inside the sandbox at runtime
    mainFields: ['module', 'main'],
    target: 'es2022',
    minify: opts.minify ?? false,
    write: false,
    logLevel: 'silent',
  })
  const bundled = result.outputFiles[0].text
  if (/\brequire\s*\(/.test(bundled)) {
    throw new Error(`${entry}: bundled output still calls require() — addon handlers run in a sandbox with no module system. Avoid node builtins and packages with runtime requires.`)
  }
  return [
    'const module = { exports: {} };',
    'const exports = module.exports;',
    bundled.trimEnd(),
    'const __handler = typeof module.exports === "function" ? module.exports : module.exports.default;',
    'if (typeof __handler !== "function") throw new Error("handler module needs a default export function (input, api) => ...");',
    'return await __handler(input, api);',
  ].join('\n')
}

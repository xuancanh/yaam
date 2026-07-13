// Chat artifacts: assistant outputs that are PRODUCTS — an HTML page, an SVG
// chart, a slide — detected in fenced code blocks and rendered live in a
// sandboxed iframe beside the conversation (same trust model as addon views:
// opaque origin, inline-script-only CSP, postMessage-free, network denied).

export interface ChatArtifact {
  kind: 'html' | 'svg'
  source: string
}

/** The LAST renderable fenced block (```html / ```svg) in a message, or an
 *  inline top-level <svg> document. Small snippets are ignored — an artifact
 *  is a product, not a two-line example. */
export function extractArtifact(text: string): ChatArtifact | null {
  let found: ChatArtifact | null = null
  for (const m of text.matchAll(/```(html|svg)[^\n]*\n([\s\S]*?)```/gi)) {
    const source = m[2].trim()
    if (source.length >= 120) found = { kind: m[1].toLowerCase() as ChatArtifact['kind'], source }
  }
  if (!found) {
    // an unfenced standalone SVG (models sometimes emit it bare)
    const svg = text.match(/<svg[\s>][\s\S]*<\/svg>/i)
    if (svg && svg[0].length >= 120) found = { kind: 'svg', source: svg[0] }
  }
  return found
}

/** Wrap an artifact as a self-contained srcDoc. By default it runs under a
 *  no-network CSP (inline scripts only) — the right stance for untrusted LLM
 *  output. `trusted` drops the CSP entirely so the page renders exactly as a
 *  browser would (external scripts, eval, network all work); the caller must
 *  still keep the iframe on an opaque origin (sandbox="allow-scripts", no
 *  allow-same-origin) so it can't reach back into the app. */
export function artifactSrcDoc(a: ChatArtifact, opts?: { trusted?: boolean }): string {
  const csp = opts?.trusted
    ? ''
    : `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:">`
  if (a.kind === 'svg') {
    return `<!doctype html><html><head>${csp}<style>html,body{margin:0;height:100%;display:grid;place-items:center;background:#fff}svg{max-width:100%;max-height:100%}</style></head><body>${a.source}</body></html>`
  }
  // full documents pass through with the CSP injected; fragments get a shell
  if (/<html[\s>]/i.test(a.source)) {
    if (/<head[\s>]/i.test(a.source)) return a.source.replace(/<head([^>]*)>/i, `<head$1>${csp}`)
    return a.source.replace(/<html([^>]*)>/i, `<html$1><head>${csp}</head>`)
  }
  return `<!doctype html><html><head>${csp}<style>body{font-family:system-ui,sans-serif;margin:16px}</style></head><body>${a.source}</body></html>`
}

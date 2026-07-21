// Lock the iframe down with a CSP that blocks every outbound request (no
// fetch/XHR/WebSocket, no remote images/fonts/styles) — combined with
// sandbox="allow-scripts" this leaves postMessage as the only channel out.
export const VIEW_CSP = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; img-src data: blob:; font-src data:">'

/**
 * Build the addon-view srcdoc: the CSP meta PREPENDED to the addon HTML,
 * unconditionally. Never regex-replace into addon-controlled bytes — an early
 * `<!-- <head> -->` comment or a `<head>` inside a script string would absorb
 * the meta and leave the real document with no CSP. Prepending is always safe:
 * multiple CSP metas intersect, so this one is enforced even when the addon
 * ships its own, and bytes outside <head> are still parsed by the HTML
 * tokenizer (a leading meta before <!DOCTYPE>/<html> is hoisted into head).
 */
export function withViewCsp(html: string): string {
  return VIEW_CSP + html
}

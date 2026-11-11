// Markdown files render as a full HTML document inside the file viewer's
// sandboxed preview frame (the same one HTML files use). The frame is the
// isolation boundary, so raw HTML and <script> in the markdown are kept: a
// README with an embedded widget renders like it would on a docs site.
import { Marked } from 'marked'
import { escapeHtml, highlight } from '../core/highlight'
import type { HighlightLang } from '../core/highlight'

/** Colors and fonts copied from the app so the document matches the theme. */
export type DocTheme = Record<'bg' | 'text' | 'text2' | 'mut' | 'dim' | 'line' | 'line2' | 'accent' | 'codeBg' | 'bg3' | 'sans' | 'mono', string>
  & { hl: Record<string, string> }

const VARS: Record<Exclude<keyof DocTheme, 'hl'>, [string, string]> = {
  bg: ['--bg', '#0d0f13'], text: ['--text', '#e8eaef'], text2: ['--text2', '#c9ced8'],
  mut: ['--mut', '#9aa3b2'], dim: ['--dim', '#6b7383'], line: ['--line', '#232833'],
  line2: ['--line2', '#2e3442'], accent: ['--accent', '#F5C451'], codeBg: ['--code-bg', '#161a22'],
  bg3: ['--bg3', '#141820'], sans: ['--font-sans', 'system-ui, sans-serif'], mono: ['--font-mono', 'ui-monospace, monospace'],
}
const HL = ['comment', 'string', 'keyword', 'number', 'tag', 'attr']

/** Snapshot the app's current theme tokens (the frame can't read our CSS vars). */
export function readDocTheme(el: Element = document.documentElement): DocTheme {
  const cs = getComputedStyle(el)
  const get = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback
  const out = { hl: {} } as DocTheme
  for (const [k, [name, fallback]] of Object.entries(VARS)) (out as unknown as Record<string, string>)[k] = get(name, fallback)
  for (const h of HL) {
    const v = cs.getPropertyValue(`--hl-${h}`).trim()
    if (v) out.hl[h] = v
  }
  return out
}

const CODE_LANG: Record<string, HighlightLang> = {
  js: 'js', jsx: 'js', ts: 'js', tsx: 'js', javascript: 'js', typescript: 'js', json: 'json', jsonc: 'json',
  rust: 'js', rs: 'js', go: 'js', java: 'js', c: 'js', cpp: 'js', swift: 'js', kotlin: 'js', css: 'js',
  html: 'html', xml: 'html', svg: 'html', vue: 'html',
}

/** GitHub-style heading anchor: lowercase, punctuation dropped, spaces to dashes. */
export function slugify(text: string): string {
  return text.toLowerCase().replace(/<[^>]*>/g, '').replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s+/g, '-')
}

function parser(): Marked {
  const seen = new Map<string, number>()
  return new Marked({
    gfm: true,
    renderer: {
      heading({ tokens, depth }) {
        const inner = this.parser.parseInline(tokens)
        const base = slugify(inner) || 'section'
        const n = seen.get(base) ?? 0
        seen.set(base, n + 1)
        const id = n ? `${base}-${n}` : base
        return `<h${depth} id="${id}"><a class="anchor" href="#${id}" aria-hidden="true">#</a>${inner}</h${depth}>\n`
      },
      code({ text, lang }) {
        const l = (lang ?? '').trim().split(/\s+/)[0].toLowerCase()
        const hl = CODE_LANG[l]
        const body = hl ? highlight(text, hl) : escapeHtml(text)
        return `<pre><code${l ? ` data-lang="${escapeHtml(l)}"` : ''}>${body}</code></pre>\n`
      },
    },
  })
}

/** Render markdown to HTML (body only). */
export function renderMarkdown(md: string): string {
  // front matter is metadata, not prose
  const src = md.replace(/^---\n[\s\S]*?\n---\n/, '')
  return parser().parse(src, { async: false })
}

/** Click bridge injected into previews: http(s) links go to the parent (which
 *  opens them in the default browser) instead of navigating the frame. Pages
 *  that handle their own clicks (preventDefault) are left alone. */
export const LINK_BRIDGE = `<script>addEventListener('click',function(e){if(e.defaultPrevented)return;var a=e.target&&e.target.closest&&e.target.closest('a[href]');if(!a)return;var h=a.getAttribute('href')||'';if(h.charAt(0)==='#'){e.preventDefault();var t=document.getElementById(decodeURIComponent(h.slice(1)));if(t)t.scrollIntoView({behavior:'smooth',block:'start'});return}if(/^https?:/i.test(a.href)){e.preventDefault();parent.postMessage({type:'yaam-preview:open',href:a.href},'*')}})</script>`

/** A standalone themed document for the preview frame. */
export function markdownDoc(md: string, t: DocTheme): string {
  const hl = Object.entries(t.hl).map(([k, v]) => `--hl-${k}:${v};`).join('')
  const css = `
:root{color-scheme:dark light;${hl}}
html{background:${t.bg}}
body{margin:0;padding:28px 32px 64px;color:${t.text2};background:${t.bg};font:14.5px/1.7 ${t.sans};-webkit-font-smoothing:antialiased}
main{max-width:820px;margin:0 auto}
h1,h2,h3,h4,h5,h6{color:${t.text};line-height:1.3;margin:1.6em 0 .6em;font-weight:650;position:relative}
h1{font-size:1.9em;padding-bottom:.3em;border-bottom:1px solid ${t.line}}
h2{font-size:1.45em;padding-bottom:.25em;border-bottom:1px solid ${t.line}}
h3{font-size:1.2em}h4{font-size:1.05em}h5,h6{font-size:.95em;color:${t.mut}}
main>:first-child{margin-top:0}
.anchor{position:absolute;left:-1em;width:1em;color:${t.dim};text-decoration:none;opacity:0}
h1:hover .anchor,h2:hover .anchor,h3:hover .anchor,h4:hover .anchor{opacity:1}
p,ul,ol,blockquote,table,pre,details{margin:0 0 1em}
a{color:${t.accent};text-decoration:underline;text-underline-offset:2px}
strong{color:${t.text}}
ul,ol{padding-left:1.7em}li+li{margin-top:.25em}li>ul,li>ol{margin:.25em 0 0}
li:has(>input[type=checkbox]){list-style:none;margin-left:-1.4em}
input[type=checkbox]{margin:0 .5em 0 0;vertical-align:-1px;accent-color:${t.accent}}
blockquote{margin-left:0;padding:.1em 1em;border-left:3px solid ${t.line2};color:${t.mut}}
code{font:.88em/1.5 ${t.mono};background:${t.codeBg};border:1px solid ${t.line2};border-radius:4px;padding:.1em .35em}
pre{background:${t.bg3};border:1px solid ${t.line};border-radius:8px;padding:12px 14px;overflow:auto}
pre code{background:none;border:0;padding:0;font-size:12.5px;white-space:pre}
table{border-collapse:collapse;display:block;overflow:auto;max-width:100%}
th,td{border:1px solid ${t.line2};padding:6px 12px;text-align:left;vertical-align:top}
th{color:${t.text};background:${t.bg3};font-weight:600}
tr:nth-child(2n) td{background:color-mix(in srgb, ${t.bg3} 55%, transparent)}
img{max-width:100%}
hr{border:0;border-top:1px solid ${t.line2};margin:2em 0}
kbd{font:.85em ${t.mono};border:1px solid ${t.line2};border-bottom-width:2px;border-radius:4px;padding:.05em .4em}
::selection{background:color-mix(in srgb, ${t.accent} 35%, transparent)}
`
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>${css}</style></head><body><main>${renderMarkdown(md)}</main>${LINK_BRIDGE}</body></html>`
}
